// =============================================================================
// Company lookup PHASE 1 — DB-level authz matica (PGlite = PostgreSQL vo WASM).
//
// Overuje, že brána /api/company-lookup/* (guardCompanyLookup) pustí PRESNE
// tých používateľov, ktorým RLS dovolí založiť obchodného partnera — t. j.
// lookup nedáva nikomu novú schopnosť. Funkcie esblu_my_active_company_id(),
// esblu_my_finance_manage() a politiky business_partners_*_finance sa berú
// DOSLOVNE z migrácií v repe. NIKDY sa nepripája na Supabase.
//
// SPUSTENIE (PGlite nie je závislosť projektu — nainštaluje sa bez uloženia):
//   npm i --no-save @electric-sql/pglite@0.5.8
//   npm run test:company-lookup-db
// Inde nainštalovaný PGlite: PGLITE_DIR=/cesta/k/node_modules/@electric-sql/pglite
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardCompanyLookup } from "../lib/company-lookup/guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

async function loadPglite(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  try {
    const { PGlite } = await import(main);
    return new PGlite() as Db;
  } catch (error) {
    console.error("PGlite nie je nainštalovaný: npm i --no-save @electric-sql/pglite@0.5.8  (alebo PGLITE_DIR=…)");
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

/** Vyberie z migrácie presne jeden príkaz (funkciu/politiku) — doslovne. */
function extract(file: string, pattern: RegExp, label: string): string {
  const matches = [...read(file).matchAll(pattern)];
  assert.ok(matches.length >= 1, `${label} sa v ${file} nenašlo`);
  return matches[matches.length - 1][0];
}

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Kostra (Supabase stuby) + doslovné definície z migrácií
// -----------------------------------------------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
  $$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;

  create table public.companies (id uuid primary key, name text not null);
  create table public.company_members (
    company_id uuid not null references public.companies(id),
    user_id uuid not null,
    role text not null,
    status text not null default 'active',
    permissions jsonb not null default '{}'
  );
  -- Iba stĺpce, ktoré politiky čítajú (+ povinné). Tvar zhodný s 20260916120000.
  create table public.business_partners (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    kind text not null default 'customer',
    legal_name text not null,
    ico text,
    created_by uuid,
    updated_by uuid
  );
  alter table public.business_partners enable row level security;
  grant select, insert, update, delete on public.business_partners to authenticated;
`);

await db.exec(
  extract(
    "supabase/migrations/20260814160000_add_company_based_rls.sql",
    /create or replace function public\.esblu_my_active_company_id\(\)[\s\S]*?\$function\$;/g,
    "esblu_my_active_company_id"
  )
);
await db.exec(
  extract(
    "supabase/migrations/20260922100000_add_accountant_role_and_scope_gates.sql",
    /create or replace function public\.esblu_my_finance_manage\(\)[\s\S]*?\n\$\$;/g,
    "esblu_my_finance_manage"
  )
);
await db.exec(
  extract(
    "supabase/migrations/20260922100000_add_accountant_role_and_scope_gates.sql",
    /create or replace function public\.esblu_my_finance_view\(\)[\s\S]*?\n\$\$;/g,
    "esblu_my_finance_view"
  )
);
await db.exec(
  "grant execute on function public.esblu_my_active_company_id(), public.esblu_my_finance_manage(), public.esblu_my_finance_view() to authenticated;"
);
for (const policy of ["select", "insert", "update", "delete"]) {
  await db.exec(
    extract(
      "supabase/migrations/20260916140000_finance_access_hardening.sql",
      new RegExp(`create policy business_partners_${policy}_finance[\\s\\S]*?\\n  \\);\\n`, "g"),
      `business_partners_${policy}_finance`
    )
  );
}

const CA = "a0000000-0000-4000-8000-00000000000a";
const CB = "b0000000-0000-4000-8000-00000000000b";
const U = {
  owner: "10000000-0000-4000-8000-000000000001",
  accountant: "10000000-0000-4000-8000-000000000002",
  adminFinance: "10000000-0000-4000-8000-000000000003",
  admin: "10000000-0000-4000-8000-000000000004",
  adminFinanceViewOnly: "10000000-0000-4000-8000-000000000005",
  employee: "10000000-0000-4000-8000-000000000006",
  employeeWithFinanceJson: "10000000-0000-4000-8000-000000000007",
  inactiveOwner: "10000000-0000-4000-8000-000000000008",
  otherTenantOwner: "20000000-0000-4000-8000-000000000001",
  noMembership: "30000000-0000-4000-8000-000000000001",
};
await db.exec(`
  insert into public.companies values ('${CA}', 'Firma A'), ('${CB}', 'Firma B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${CA}', '${U.owner}', 'owner', 'active', '{}'),
    ('${CA}', '${U.accountant}', 'accountant', 'active', '{}'),
    ('${CA}', '${U.adminFinance}', 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.admin}', 'admin', 'active', '{}'),
    ('${CA}', '${U.adminFinanceViewOnly}', 'admin', 'active', '{"finance":{"view":true}}'),
    ('${CA}', '${U.employee}', 'employee', 'active', '{}'),
    ('${CA}', '${U.employeeWithFinanceJson}', 'employee', 'active', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.inactiveOwner}', 'owner', 'revoked', '{}'),
    ('${CB}', '${U.otherTenantOwner}', 'owner', 'active', '{}');
`);

/** Spustí fn ako `authenticated` s JWT daného používateľa; vždy rollback (žiadne vedľajšie efekty). */
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.exec("set local role authenticated");
    return await fn();
  } finally {
    await db.exec("rollback");
  }
}

/** Skutočná guard funkcia z API, so závislosťami nad PGlite (ako user-scoped klient). */
async function guardAs(uid: string) {
  return as(uid, () =>
    guardCompanyLookup({
      getUser: async () => ({ id: uid }),
      canManageFinance: async () => (await db.query<{ v: boolean }>("select public.esblu_my_finance_manage() as v")).rows[0]?.v === true,
      getActiveCompanyId: async () => (await db.query<{ v: string | null }>("select public.esblu_my_active_company_id() as v")).rows[0]?.v ?? null,
    })
  );
}

async function canInsertPartner(uid: string, companyId: string): Promise<boolean> {
  return as(uid, async () => {
    try {
      await db.query("savepoint s");
      await db.query("insert into public.business_partners (company_id, legal_name, ico, created_by, updated_by) values ($1, 'Test', '31322832', $2, $2)", [companyId, uid]);
      return true;
    } catch {
      await db.query("rollback to savepoint s");
      return false;
    }
  });
}

// -----------------------------------------------------------------------------
// Matica
// -----------------------------------------------------------------------------
const EXPECTED: [keyof typeof U, boolean, string | null][] = [
  ["owner", true, CA],
  ["accountant", true, CA],
  ["adminFinance", true, CA],
  ["admin", false, null],
  ["adminFinanceViewOnly", false, null],
  ["employee", false, null],
  ["employeeWithFinanceJson", false, null],
  ["inactiveOwner", false, null],
  ["noMembership", false, null],
  ["otherTenantOwner", true, CB],
];

for (const [who, allowed, company] of EXPECTED) {
  await check(`MATRIX: ${who} → lookup ${allowed ? "povolený" : "403"}`, async () => {
    const guard = await guardAs(U[who]);
    if (allowed) {
      assert.deepEqual(guard, { ok: true, userId: U[who], companyId: company });
    } else {
      assert.deepEqual(guard, { ok: false, status: 403, code: "FORBIDDEN" });
    }
  });
}

await check("MATRIX: lookup povolený ⇔ RLS dovolí založiť partnera vo vlastnej firme (žiadna nová schopnosť)", async () => {
  for (const [who] of EXPECTED) {
    const guard = await guardAs(U[who]);
    const ownCompany = guard.ok ? guard.companyId : CA;
    assert.equal(await canInsertPartner(U[who], ownCompany), guard.ok, who);
  }
});

await check("CROSS-TENANT: owner firmy B nesmie zapisovať do firmy A; lookup mu dá iba firmu B", async () => {
  assert.equal(await canInsertPartner(U.otherTenantOwner, CA), false);
  const guard = await guardAs(U.otherTenantOwner);
  assert.ok(guard.ok && guard.companyId === CB);
  // A naopak: owner A nevidí ani nezapíše do B.
  assert.equal(await canInsertPartner(U.owner, CB), false);
  const visible = await as(U.otherTenantOwner, async () => (await db.query("select count(*)::int as n from public.business_partners where company_id = $1", [CA])).rows[0]);
  assert.deepEqual(visible, { n: 0 });
});

await check("ANON: bez JWT nič (finance_manage false, firma null)", async () => {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.exec("set local role authenticated");
    const row = (await db.query<{ m: boolean; c: string | null }>("select public.esblu_my_finance_manage() as m, public.esblu_my_active_company_id() as c")).rows[0];
    assert.deepEqual(row, { m: false, c: null });
  } finally {
    await db.exec("rollback");
  }
});

console.log(`\ncompany-lookup authz (PGlite): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
