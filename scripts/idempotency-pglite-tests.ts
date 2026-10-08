// =============================================================================
// Idempotentné vytváranie (client_mutation_id) — SKUTOČNÝ PostgreSQL (PGlite)
// + skutočný klientsky helper lib/idempotent-insert.ts cez PostgREST-like
// adaptér, ktorý beží AKO PRIHLÁSENÝ POUŽÍVATEĽ (role authenticated + RLS).
// NIKDY sa nepripája na Supabase. Súbeh na skutočnom Postgrese: esblu-test
// (docs/mobile-security-audit-2026-10-08.md).
//
//   npm i --no-save @electric-sql/pglite@0.5.8   (alebo PGLITE_DIR=…)
//   npm run test:idempotency-db
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { insertIdempotent, mutationKeyFor, resetMutationKey, type InsertDb, type MutationKeyRef } from "@/lib/idempotent-insert";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261008130000_client_mutation_idempotency.sql";
const ROLLBACK = "supabase/rollback/20261008130000_client_mutation_idempotency_rollback.sql";

type Db = { exec: (sql: string) => Promise<unknown>; query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
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

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : JSON.stringify(error)}`);
  }
}

const TABLES = ["invoices", "business_partners", "vehicles", "machines", "inventory_items", "document_folders", "chat_messages"] as const;
const CA = "a0000000-0000-4000-8000-00000000000a";
const CB = "b0000000-0000-4000-8000-00000000000b";
const UA = "10000000-0000-4000-8000-000000000001";
const UB = "20000000-0000-4000-8000-000000000001";

// Prod-verná kostra: firma z členstva (trigger ako esblu_assign_company_id), RLS tenant izolácia.
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid $$;
  grant usage on schema auth, public to authenticated; grant execute on function auth.uid() to authenticated;
  create table public.companies (id uuid primary key, name text);
  create table public.company_members (company_id uuid, user_id uuid, status text default 'active');
  insert into public.companies values ('${CA}', 'A'), ('${CB}', 'B');
  insert into public.company_members values ('${CA}', '${UA}', 'active'), ('${CB}', '${UB}', 'active');
  create function public.my_company() returns uuid language sql stable security definer as $$
    select company_id from public.company_members where user_id = auth.uid() and status = 'active' limit 1 $$;
  grant execute on function public.my_company() to authenticated;
  create function public.assign_company() returns trigger language plpgsql security definer as $$
  begin new.company_id := public.my_company(); return new; end $$;
`);
for (const t of TABLES) {
  await db.exec(`
    create table public.${t} (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), name text not null, created_at timestamptz default now());
    create trigger assign_company before insert on public.${t} for each row execute function public.assign_company();
    alter table public.${t} enable row level security;
    create policy ${t}_select on public.${t} for select to authenticated using (company_id = public.my_company());
    create policy ${t}_insert on public.${t} for insert to authenticated with check (company_id = public.my_company());
    grant select, insert, update on public.${t} to authenticated;
  `);
}
await db.exec(`create unique index document_folders_company_name_unique on public.document_folders (company_id, lower(name));`);

await check("migrácia: aditívna + idempotentná (2×)", async () => {
  await db.exec(read(MIGRATION));
  await db.exec(read(MIGRATION));
  for (const t of TABLES) {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int n from pg_indexes where tablename = $1 and indexname = $2`, [t, `${t}_client_mutation_uidx`]);
    assert.equal(rows[0].n, 1, t);
  }
});

/** PostgREST-like adaptér nad PGlite — každý dotaz ako prihlásený používateľ (RLS). */
function clientFor(uid: string, opts: { loseResponseOnce?: boolean } = {}): InsertDb {
  let lose = opts.loseResponseOnce ?? false;
  async function asUser<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await db.exec("set local role authenticated");
      const r = await fn();
      await db.exec("commit");
      return r;
    } catch (e) {
      await db.exec("rollback");
      throw e;
    }
  }
  const toPgError = (e: unknown) => ({ code: (e as { code?: string }).code, message: (e as Error).message });
  return {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          return {
            select(columns: string) {
              return {
                async single() {
                  const keys = Object.keys(row);
                  try {
                    const { rows } = await asUser(() =>
                      db.query(`insert into public.${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning ${columns === "*" ? "*" : columns}`, keys.map((k) => row[k])),
                    );
                    if (lose) {
                      lose = false;
                      throw Object.assign(new Error("NETWORK_LOST_AFTER_COMMIT"), { network: true });
                    }
                    return { data: rows[0] ?? null, error: null };
                  } catch (e) {
                    if ((e as { network?: boolean }).network) throw e;
                    return { data: null, error: toPgError(e) };
                  }
                },
              };
            },
          };
        },
        select(columns: string) {
          return {
            eq(column: string, value: string) {
              return {
                async maybeSingle() {
                  try {
                    const { rows } = await asUser(() => db.query(`select ${columns} from public.${table} where ${column} = $1`, [value]));
                    return { data: rows[0] ?? null, error: null };
                  } catch (e) {
                    return { data: null, error: toPgError(e) };
                  }
                },
              };
            },
          };
        },
      };
    },
  };
}
const count = async (t: string, company: string) => (await db.query<{ n: number }>(`select count(*)::int n from public.${t} where company_id = $1`, [company])).rows[0].n;

for (const t of TABLES) {
  await check(`${t}: retry po strate odpovede (commit prebehol) → ten istý záznam, nie druhý`, async () => {
    const ref: MutationKeyRef = { current: null };
    const row = { name: `retry-${t}` };
    const key = mutationKeyFor(ref, row);
    const before = await count(t, CA);
    await assert.rejects(() => insertIdempotent(clientFor(UA, { loseResponseOnce: true }), t, row, key), /NETWORK_LOST_AFTER_COMMIT/);
    const retry = await insertIdempotent<{ id: string; name: string }>(clientFor(UA), t, row, mutationKeyFor(ref, row));
    assert.equal(retry.replayed, true);
    assert.equal(retry.data.name, row.name);
    assert.equal(await count(t, CA), before + 1);
    // tretí pokus (napr. dvojité ťuknutie) — stále jeden záznam
    const again = await insertIdempotent<{ id: string }>(clientFor(UA), t, row, mutationKeyFor(ref, row));
    assert.equal(again.data.id, retry.data.id);
    assert.equal(await count(t, CA), before + 1);
    resetMutationKey(ref);
  });
  await check(`${t}: odlišný obsah / nové vytvorenie po úspechu NIE JE falošne zablokované`, async () => {
    const ref: MutationKeyRef = { current: null };
    const before = await count(t, CA);
    const k1 = mutationKeyFor(ref, { name: `a-${t}` });
    await insertIdempotent(clientFor(UA), t, { name: `a-${t}` }, k1);
    const k2 = mutationKeyFor(ref, { name: `b-${t}` });
    assert.notEqual(k1, k2, "iný obsah = iný kľúč");
    await insertIdempotent(clientFor(UA), t, { name: `b-${t}` }, k2);
    resetMutationKey(ref);
    const k3 = mutationKeyFor(ref, { name: `b2-${t}` });
    await insertIdempotent(clientFor(UA), t, { name: `b2-${t}` }, k3);
    assert.equal(await count(t, CA), before + 3);
  });
  await check(`${t}: tenant scope — rovnaký kľúč v inej firme nekoliduje a nič neprezradí`, async () => {
    const key = "c1000000-0000-4000-8000-0000000000c1";
    const a = await insertIdempotent<{ id: string; company_id: string }>(clientFor(UA), t, { name: `ta-${t}` }, key);
    const b = await insertIdempotent<{ id: string; company_id: string }>(clientFor(UB), t, { name: `tb-${t}` }, key);
    assert.equal(b.replayed, false, "firma B nedostane záznam firmy A");
    assert.notEqual(a.data.id, b.data.id);
    assert.equal(b.data.company_id, CB);
  });
}

await check("bez kľúča (staré klienty / server cesty) → pôvodné správanie", async () => {
  const before = await count("vehicles", CA);
  await insertIdempotent(clientFor(UA), "vehicles", { name: "legacy" }, null);
  await insertIdempotent(clientFor(UA), "vehicles", { name: "legacy" }, null);
  assert.equal(await count("vehicles", CA), before + 2);
});
await check("priečinok: skutočná duplicita názvu ostáva chybou (23505 iného indexu), nie replay", async () => {
  const ref: MutationKeyRef = { current: null };
  await insertIdempotent(clientFor(UA), "document_folders", { name: "Zmluvy" }, mutationKeyFor(ref, { name: "Zmluvy", attempt: 1 }));
  resetMutationKey(ref);
  await assert.rejects(
    () => insertIdempotent(clientFor(UA), "document_folders", { name: "zmluvy" }, mutationKeyFor(ref, { name: "zmluvy" })),
    (e: { code?: string; message?: string }) => e.code === "23505" && /document_folders_company_name_unique/.test(e.message ?? ""),
  );
});
await check("klient nemôže kľúčom obísť RLS (insert do cudzej firmy stále zakázaný)", async () => {
  await db.exec(`drop trigger assign_company on public.vehicles`);
  try {
    await assert.rejects(() => insertIdempotent(clientFor(UA), "vehicles", { name: "x", company_id: CB }, "c2000000-0000-4000-8000-0000000000c2"), (e: { message?: string }) => /row-level security/.test(e.message ?? ""));
  } finally {
    await db.exec(`create trigger assign_company before insert on public.vehicles for each row execute function public.assign_company()`);
  }
});
await check("rollback: zhodí index + stĺpec, dáta ostanú; opätovné nasadenie OK", async () => {
  const before = await count("invoices", CA);
  await db.exec(read(ROLLBACK));
  const { rows } = await db.query<{ n: number }>(`select count(*)::int n from information_schema.columns where column_name = 'client_mutation_id'`);
  assert.equal(rows[0].n, 0);
  assert.equal(await count("invoices", CA), before);
  // klient po rollbacku DB: PGRST204/42703 → insert bez kľúča (žiadna chyba)
  const r = await insertIdempotent(clientFor(UA), "invoices", { name: "po-rollbacku" }, "c3000000-0000-4000-8000-0000000000c3");
  assert.equal(r.replayed, false);
  await db.exec(read(MIGRATION));
});

console.log(`\nidempotency-pglite: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
