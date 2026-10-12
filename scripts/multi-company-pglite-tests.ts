// =============================================================================
// Multi-company / workspace model — SKUTOČNÝ PostgreSQL (PGlite) pre
//   20261012140000_multi_company_workspaces.sql
// nad prod-vernou entitlement / RLS vrstvou + billing + zrušenie účtu.
// Nikdy Supabase / staging / produkcia.
//   npm run test:multi-company-db            (SUITE=cross-company-rls … pre jednu suite)
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MULTI = "supabase/migrations/20261012140000_multi_company_workspaces.sql";
const MULTI_ROLLBACK = "supabase/rollback/20261012140000_multi_company_workspaces_rollback.sql";
const SUITE = (process.argv[2] ?? process.env.SUITE ?? "").replace(/^--suite=/, "").trim() || null;

type Row = Record<string, unknown>;
type Db = { exec: (sql: string) => Promise<unknown>; query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

async function loadPglite(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  const crypto = dir ? pathToFileURL(path.join(dir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto";
  try {
    const { PGlite } = await import(main);
    const { pgcrypto } = await import(crypto);
    return new PGlite({ extensions: { pgcrypto } }) as Db;
  } catch (error) {
    console.error("PGlite nie je nainštalovaný: npm i --no-save @electric-sql/pglite@0.5.8");
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  if (SUITE && label.split(":")[0] !== SUITE) return;
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 3).join("\n       ") : String(error)}`);
  }
}

let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}
async function inTx<T>(claims: Row, role: string, fn: () => Promise<T>): Promise<T> {
  return serialized(async () => {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.exec(`set local role ${role}`);
      const r = await fn();
      await db.exec("commit");
      return r;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  });
}
const as = <T>(uid: string, fn: () => Promise<T>) => inTx({ sub: uid, role: "authenticated" }, "authenticated", fn);
const svc = <T>(fn: () => Promise<T>) => inTx({ role: "service_role" }, "service_role", fn);
const su = <T = Row>(sql: string, params: unknown[] = []) => serialized(() => db.query<T>(sql, params));
const one = async <T = Row>(sql: string, params: unknown[] = []) => (await su<T>(sql, params)).rows[0];
const q = <T = Row>(uid: string, sql: string, params: unknown[] = []) => as(uid, async () => (await db.query<T>(sql, params)).rows);
const rpc = async <T = unknown>(uid: string, fn: string, args: unknown[] = []) =>
  (await q<{ r: T }>(uid, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) r`, args))[0].r;
const rows = <T = Row>(uid: string, fn: string, args: unknown[] = []) =>
  q<T>(uid, `select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
async function fails(fn: () => Promise<unknown>, pattern?: RegExp): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern) assert.match(message, pattern);
    return message;
  }
  throw new Error("očakávaná chyba, prešlo");
}
const activeOf = async (uid: string) => (await rpc<string | null>(uid, "esblu_my_active_company_id"));
const switchTo = (uid: string, companyId: string) => rows(uid, "esblu_set_my_active_company", [companyId]);
const count = async (uid: string, table: string) => Number((await q<{ n: number }>(uid, `select count(*)::int n from public.${table}`))[0].n);

// ----------------------------------------------------------------------------- schéma (staršia, single-company)
await db.exec(read("scripts/sql/entitlements-local-baseline.sql"));
await db.exec(`
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
await db.exec(read("supabase/migrations/20260928100000_company_entitlements_trial.sql"));
await db.exec(read("supabase/migrations/20261008120000_subscriptions_platform.sql"));
await db.exec(read("supabase/migrations/20261011120000_subscriptions_lifecycle_hardening.sql"));
await db.exec(read("supabase/migrations/20261012090000_subscriptions_event_token_redaction.sql"));
await db.exec(read("supabase/migrations/20261012091000_subscriptions_purchase_options_owned_methods.sql"));
await db.exec(read("supabase/migrations/20261012120000_account_deletion_subscription_guard.sql"));
await db.exec(read("scripts/sql/multi-company-local-stubs.sql"));
await db.exec(`alter table public.invoices add column if not exists finalized_by uuid;
  grant all on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(read("supabase/migrations/20261012130000_account_deletion_post_commit_cleanup.sql"));
// prod helper (20260930150000) — chat RLS autorita, na overenie prepnutia firmy
await db.exec(`
  create or replace function public.esblu_chat_can_access_conversation(p_conversation_id uuid) returns boolean
  language sql stable security definer set search_path to '' as $f$
    select exists (
      select 1 from public.chat_conversations c
      where c.id = p_conversation_id and auth.uid() is not null
        and c.company_id = public.esblu_my_active_company_id()
        and (c.type = 'company' or (c.type = 'direct' and auth.uid() in (c.direct_user_low, c.direct_user_high)
          and exists (select 1 from public.chat_conversation_members m where m.conversation_id = c.id and m.user_id = auth.uid() and m.company_id = c.company_id))));
  $f$;
  -- eInvoice readiness: tabuľky + RLS podľa referencie einvoice-port (20261002100000), iba stĺpce pre test
  create table public.einvoice_organizations (id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade, provider text not null, environment text not null,
    participant_id text, unique (company_id, environment));
  create table public.einvoice_inbound (id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade, sender text);
  alter table public.einvoice_organizations enable row level security;
  alter table public.einvoice_inbound enable row level security;
  create policy einvoice_organizations_select_finance on public.einvoice_organizations for select to authenticated
    using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());
  create policy einvoice_inbound_select_finance on public.einvoice_inbound for select to authenticated
    using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());
  grant select on public.einvoice_organizations, public.einvoice_inbound to authenticated;
`);

// ----------------------------------------------------------------------------- fixtures (pred migráciou = existujúce dáta)
const U = {
  x: "a0000000-0000-4000-8000-00000000000a", // owner A
  y: "a0000000-0000-4000-8000-00000000000b", // employee A, neskôr owner B (SZČO)
  z: "a0000000-0000-4000-8000-00000000000c", // cudzí owner C
  w: "a0000000-0000-4000-8000-00000000000d", // employee C (bez vlastnej firmy)
  admin: "a0000000-0000-4000-8000-00000000000e", // admin A s billing.manage
};
const C = { a: "c0000000-0000-4000-8000-00000000000a", c: "c0000000-0000-4000-8000-00000000000c" };
await db.exec(`
  insert into auth.users (id, email) values
    ('${U.x}', 'x@example.invalid'), ('${U.y}', 'y@example.invalid'), ('${U.z}', 'z@example.invalid'),
    ('${U.w}', 'w@example.invalid'), ('${U.admin}', 'adm@example.invalid');
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.x}', 'ABC s.r.o.'), ('${C.c}', '${U.z}', 'Cudzia a.s.');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.x}', 'owner', 'active', '{}'), ('${C.a}', '${U.y}', 'employee', 'active', '{}'),
    ('${C.a}', '${U.admin}', 'admin', 'active', '{"billing":{"manage":true},"finance":{"view":true,"manage":true}}'),
    ('${C.c}', '${U.z}', 'owner', 'active', '{}'), ('${C.c}', '${U.w}', 'employee', 'active', '{}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select co, d.version, own, 'company_dpa_gate'
    from (values ('${C.a}'::uuid, '${U.x}'::uuid), ('${C.c}'::uuid, '${U.z}'::uuid)) v(co, own),
         (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  -- A: trial skončil, žiadne predplatné → hlas zamknutý
  alter table public.companies disable trigger esblu_companies_trial_guard;
  update public.companies set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '16 days' where id = '${C.a}';
  alter table public.companies enable trigger esblu_companies_trial_guard;
  -- A: vozidlá a tím povolené (manuálny grant), aby RBAC/RLS testy merali roly, nie nárok
  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values
    ('${C.a}', 'vehicles', 'manual', 'active', 10, 'total'), ('${C.a}', 'team_members', 'manual', 'active', 50, 'total'),
    ('${C.c}', 'team_members', 'manual', 'active', 50, 'total');
  set session_replication_role = replica;
  insert into public.vehicles (spz, user_id, company_id) values ('A-1', '${U.y}', '${C.a}');
  insert into public.documents (company_id, user_id, storage_bucket, storage_path) values ('${C.a}', '${U.y}', 'documents', '${C.a}/y-doc.pdf');
  insert into public.vehicles (spz, user_id, company_id) values ('C-1', '${U.z}', '${C.c}');
  set session_replication_role = origin;
`);
const legacyActive = await rpc<string>(U.y, "esblu_my_active_company_id");

// ----------------------------------------------------------------------------- migrácia
await db.exec(read(MULTI));

await check("existing-data-backfill: existujúci používatelia → aktívna firma = ich jediná firma, nič sa nezmenilo", async () => {
  assert.equal(legacyActive, C.a);
  for (const [u, c] of [[U.x, C.a], [U.y, C.a], [U.z, C.c], [U.w, C.c]]) {
    assert.equal(await activeOf(u), c, u);
    assert.equal((await one<{ company_id: string }>(`select company_id from public.user_active_company where user_id = $1`, [u]))?.company_id, c);
  }
  assert.equal(await count(U.y, "vehicles"), 1);
  assert.equal(await count(U.z, "vehicles"), 1);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from pg_indexes where indexname = 'company_members_one_active_per_user_idx'`)).n), 0);
  // migrácia je idempotentná
  await serialized(() => db.exec(read(MULTI)));
  assert.equal(await activeOf(U.y), C.a);
});

// ----------------------------------------------------------------------------- SZČO scenár: Y si založí vlastnú firmu
let B = "";
await check("create-second-company: existujúci používateľ (employee A) založí vlastnú firmu bez novej registrácie → owner + aktívna", async () => {
  const [created] = await rows<{ company_id: string; role: string }>(U.y, "esblu_create_my_company", ["Ján Novák – SZČO"]);
  B = created.company_id;
  assert.equal(created.role, "owner");
  assert.equal(await activeOf(U.y), B, "nová firma je aktívna");
  assert.equal((await one<Row>(`select owner_id from public.companies where id = $1`, [B])).owner_id, U.y);
  assert.ok((await one<Row>(`select trial_ends_at from public.companies where id = $1`, [B])).trial_ends_at, "existujúca trial logika (per firma)");
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from auth.users where id = $1`, [U.y])).n), 1, "žiadny nový auth user");
  await fails(() => rows(U.y, "esblu_create_my_company", ["ján novák – szčo "]), /ESBLU_DUPLICATE_COMPANY_NAME/);
  await fails(() => rows(U.y, "esblu_create_my_company", ["x"]), /ESBLU_INVALID_COMPANY_NAME/);
  // používateľ bez akéhokoľvek členstva ide cez onboarding (beta / pozvánky)
  await su(`insert into auth.users (id, email) values ('a0000000-0000-4000-8000-0000000000ff', 'lonely@example.invalid')`);
  await fails(() => rows("a0000000-0000-4000-8000-0000000000ff", "esblu_create_my_company", ["Nová"]), /ESBLU_USE_ONBOARDING/);
  // B: hlas aktívny (manuálny grant), 10 vozidiel
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status) values ($1, 'voice', 'manual', 'active')`, [B]);
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values ($1, 'vehicles', 'manual', 'active', 50, 'total')`, [B]);
  await serialized(() => db.exec(`set session_replication_role = replica;
    insert into public.vehicles (spz, user_id, company_id) select 'B-' || g, '${U.y}', '${B}' from generate_series(1, 10) g;
    insert into public.invoices (company_id, direction, kind, created_by) values ('${B}', 'issued', 'invoice', '${U.y}');
    set session_replication_role = origin;`));
});

await check("multi-company-memberships: jeden login, dve firmy, rôzne roly; presne jeden owner na firmu", async () => {
  const list = await rows<{ company_id: string; company_name: string; role: string; is_active: boolean }>(U.y, "esblu_list_my_companies");
  assert.deepEqual(list.map((r) => [r.company_name, r.role]), [["ABC s.r.o.", "employee"], ["Ján Novák – SZČO", "owner"]]);
  assert.deepEqual(list.filter((r) => r.is_active).map((r) => r.company_id), [B]);
  await fails(() => su(`insert into public.company_members (company_id, user_id, role, status) values ($1, $2, 'owner', 'active')`, [C.a, U.z]), /company_members_one_owner_per_company_idx|duplicate key/);
  await fails(() => su(`update public.company_members set role = 'admin' where company_id = $1 and user_id = $2`, [C.a, U.x]), /ESBLU_COMPANY_MUST_KEEP_OWNER/);
});

await check("active-company-selection: prepnutie iba do vlastnej firmy; cudzie company_id = deny; deterministické bez LIMIT 1", async () => {
  await switchTo(U.y, C.a);
  assert.equal(await activeOf(U.y), C.a);
  assert.equal(await rpc(U.y, "esblu_my_active_role"), "employee");
  await fails(() => switchTo(U.y, C.c), /ESBLU_NOT_A_MEMBER/);
  await fails(() => switchTo(U.z, C.a), /ESBLU_NOT_A_MEMBER/);
  assert.equal(await activeOf(U.y), C.a, "neúspešný pokus nič nezmenil");
  // klient nemôže zapisovať voľbu priamo
  await fails(() => q(U.y, `update public.user_active_company set company_id = $1 where user_id = $2`, [C.c, U.y]), /permission denied/);
  await fails(() => q(U.y, `insert into public.user_active_company (user_id, company_id) values ($1, $2)`, [U.z, C.c]), /permission denied/);
  const m = (await rows<{ company_id: string; role: string }>(U.y, "esblu_my_active_membership"))[0];
  assert.deepEqual([m.company_id, m.role], [C.a, "employee"]);
  const forUser = (await svc(async () => (await db.query<Row>(`select * from public.esblu_active_membership_for_user($1)`, [U.y])).rows))[0];
  assert.equal(forUser.company_id, C.a);
  assert.equal(forUser.active_membership_count, 2);
});

await check("cross-company-rls: člen A aj B — request v A vidí iba A, v B iba B; firma bez členstva = DENY (SELECT/INSERT/UPDATE/DELETE)", async () => {
  await switchTo(U.y, C.a);
  assert.equal(await count(U.y, "vehicles"), 1);
  assert.deepEqual((await q<{ company_id: string }>(U.y, `select distinct company_id from public.vehicles`)).map((r) => r.company_id), [C.a]);
  await switchTo(U.y, B);
  assert.equal(await count(U.y, "vehicles"), 10);
  assert.deepEqual((await q<{ company_id: string }>(U.y, `select distinct company_id from public.vehicles`)).map((r) => r.company_id), [B]);
  assert.equal(await count(U.y, "invoices"), 1, "owner B vidí faktúry B");
  // zápis do neaktívnej firmy (A) z kontextu B → RLS
  await fails(() => q(U.y, `insert into public.vehicles (spz, user_id, company_id) values ('X', $1, $2)`, [U.y, C.a]), /row-level security|violates|ENTITLEMENT_DENIED/);
  assert.equal((await q(U.y, `update public.vehicles set spz = 'HACK' where company_id = $1 returning id`, [C.a])).length, 0);
  assert.equal((await q(U.y, `delete from public.vehicles where company_id = $1 returning id`, [C.a])).length, 0);
  // firma C (bez členstva) — nič
  assert.equal((await q(U.y, `select id from public.vehicles where company_id = $1`, [C.c])).length, 0);
  assert.equal((await q(U.y, `delete from public.vehicles where company_id = $1 returning id`, [C.c])).length, 0);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = $1`, [C.a])).n), 1, "A nedotknuté");
  // documents: insert v B dostane company_id aktívnej firmy (trigger), nie A
  const [doc] = await q<{ company_id: string }>(U.y, `insert into public.documents (user_id, storage_bucket, storage_path, company_id) values ($1, 'documents', 'b/new.pdf', $2) returning company_id`, [U.y, B]);
  assert.equal(doc.company_id, B);
});

await check("active-company-rbac: rovnaký používateľ = employee v A (bez správy vozidiel), owner v B (plné práva)", async () => {
  await switchTo(U.y, C.a);
  assert.equal(await rpc(U.y, "esblu_my_finance_view"), false);
  await fails(() => q(U.y, `insert into public.vehicles (spz, user_id, company_id) values ('A-2', $1, $2)`, [U.y, C.a]), /row-level security|violates|ENTITLEMENT_DENIED/);
  assert.equal(await count(U.y, "invoices"), 0, "employee nevidí faktúry");
  await switchTo(U.y, B);
  assert.equal(await rpc(U.y, "esblu_my_finance_view"), true);
  assert.equal(await rpc(U.y, "esblu_my_active_role"), "owner");
});

await check("company-switch-entitlements: A = hlas zamknutý, B = hlas aktívny; prepnutie mení výsledok hneď", async () => {
  type Ent = { key: string; active: boolean };
  const voice = async () => ((await rpc<{ entitlements: Ent[] }>(U.y, "esblu_get_my_company_entitlements")).entitlements.find((e) => e.key === "voice")!).active;
  await switchTo(U.y, C.a);
  assert.equal(await voice(), false);
  await fails(() => rpc(U.y, "esblu_require_my_entitlement", ["voice"]));
  await switchTo(U.y, B);
  assert.equal(await voice(), true);
  await switchTo(U.y, C.a);
  assert.equal(await voice(), false, "žiadny globálny nárok používateľa");
});

await check("owner-only-billing: billing authority = owner aktívnej firmy; admin s billing.manage ani employee nesmú kupovať", async () => {
  await switchTo(U.y, C.a);
  assert.equal(((await rpc<Row>(U.y, "esblu_billing_my_access")).can_manage), false);
  await fails(() => rpc(U.y, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /FORBIDDEN/);
  const adm = await rpc<Row>(U.admin, "esblu_billing_my_access");
  assert.equal(adm.can_manage, false, "staršia politika admin+billing.manage odstránená");
  await fails(() => rpc(U.admin, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /FORBIDDEN/);
  assert.equal((await rpc<Row>(U.x, "esblu_billing_my_access")).can_manage, true);
  await switchTo(U.y, B);
  const mine = await rpc<Row>(U.y, "esblu_billing_my_access");
  assert.equal(mine.can_manage, true, "Y je owner B");
  assert.equal(mine.company_id, B);
});

await check("company-switch-chat: konverzácia A nie je dostupná po prepnutí do B; priama správa iba v rámci aktívnej firmy", async () => {
  const [conv] = (await su<{ id: string }>(`insert into public.chat_conversations (company_id, type, created_by) values ($1, 'company', $2) returning id`, [C.a, U.x])).rows;
  await switchTo(U.y, C.a);
  assert.equal(await rpc(U.y, "esblu_chat_can_access_conversation", [conv.id]), true);
  const direct = await rpc<string>(U.y, "esblu_get_or_create_direct_conversation", [U.x]);
  assert.ok(direct);
  await switchTo(U.y, B);
  assert.equal(await rpc(U.y, "esblu_chat_can_access_conversation", [conv.id]), false);
  assert.equal(await rpc(U.y, "esblu_chat_can_access_conversation", [direct]), false);
  await fails(() => rpc(U.y, "esblu_get_or_create_direct_conversation", [U.x]), /ESBLU_NOT_SAME_COMPANY/);
});

await check("company-switch-files: prístup k dokumentu / súboru A iba v kontexte A; po odchode žiadny nový prístup", async () => {
  const doc = await one<{ id: string }>(`select id from public.documents where company_id = $1 and storage_path like '%y-doc.pdf'`, [C.a]);
  await switchTo(U.y, C.a);
  assert.equal(await rpc(U.y, "esblu_can_read_document", [doc.id]), true);
  await switchTo(U.y, B);
  assert.equal(await rpc(U.y, "esblu_can_read_document", [doc.id]), false, "člen A v kontexte B → bez prístupu");
  assert.equal(await rpc(U.z, "esblu_can_read_document", [doc.id]), false);
});

await check("company-switch-voice: hlasom vytvorený záznam ide do AKTÍVNEJ firmy (nie staršej); AI kvóta tiež", async () => {
  await switchTo(U.y, B);
  const [row] = await q<{ company_id: string }>(U.y, `insert into public.documents (user_id, storage_bucket, storage_path) values ($1, 'documents', 'voice/note.pdf') returning company_id`, [U.y]);
  assert.equal(row.company_id, B);
  await su(`insert into public.ai_scan_limits (endpoint, max_per_hour, max_per_day) values ('voice-test', 5, 5) on conflict do nothing`);
  assert.equal((await rpc<Row>(U.y, "esblu_consume_ai_scan_quota", ["voice-test"])).company_id, B);
  await switchTo(U.y, C.a);
  assert.equal((await rpc<Row>(U.y, "esblu_consume_ai_scan_quota", ["voice-test"])).company_id, C.a);
});

await check("einvoice-readiness: identita / inbox firmy A ≠ B; členstvo v oboch neobchádza scoping", async () => {
  await su(`insert into public.einvoice_organizations (company_id, provider, environment, participant_id) values ($1, 'mock', 'sandbox', '9915:A'), ($2, 'mock', 'sandbox', '9915:B')`, [C.a, B]);
  await su(`insert into public.einvoice_inbound (company_id, sender) values ($1, 'dodavatel-A'), ($2, 'dodavatel-B')`, [C.a, B]);
  await switchTo(U.y, B);
  assert.deepEqual((await q<{ participant_id: string }>(U.y, `select participant_id from public.einvoice_organizations`)).map((r) => r.participant_id), ["9915:B"]);
  assert.deepEqual((await q<{ sender: string }>(U.y, `select sender from public.einvoice_inbound`)).map((r) => r.sender), ["dodavatel-B"]);
  await switchTo(U.y, C.a);
  assert.equal((await q(U.y, `select * from public.einvoice_organizations`)).length, 0, "employee A: bez finance.view");
  assert.deepEqual((await q<{ participant_id: string }>(U.x, `select participant_id from public.einvoice_organizations`)).map((r) => r.participant_id), ["9915:A"]);
});

await check("invite-existing-user / invite-user-who-is-owner-elsewhere: owner B prijme pozvánku do C ako admin → obe firmy oddelené, aktívna sa nemení", async () => {
  await switchTo(U.y, B);
  const inv = (await rows<{ token: string }>(U.z, "esblu_create_company_invite", ["y@example.invalid", "admin"]))[0];
  const [acc] = await rows<{ company_id: string; role: string }>(U.y, "esblu_accept_company_invite", [inv.token]);
  assert.deepEqual([acc.company_id, acc.role], [C.c, "admin"]);
  assert.equal(await activeOf(U.y), B, "aktívna firma ostala B (appka ponúkne prepnutie)");
  const list = await rows<{ company_id: string; role: string }>(U.y, "esblu_list_my_companies");
  assert.deepEqual(Object.fromEntries(list.map((r) => [r.company_id, r.role])), { [C.a]: "employee", [B]: "owner", [C.c]: "admin" });
  // pozvánka do firmy, kde už je členom → odmietnutá, rola sa neprepíše
  const again = (await rows<{ token: string }>(U.x, "esblu_create_company_invite", ["w@example.invalid", "employee"]))[0];
  await fails(() => rows(U.y, "esblu_accept_company_invite", [again.token]), /EMAIL_MISMATCH/);
  await fails(() => rows(U.x, "esblu_create_company_invite", ["y@example.invalid", "admin"]), /ESBLU_INVITE_ALREADY_MEMBER/);
  // nový používateľ: prvé členstvo → hneď aktívna firma
  await su(`insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000011', 'new@example.invalid')`);
  const fresh = (await rows<{ token: string }>(U.x, "esblu_create_company_invite", ["new@example.invalid", "employee"]))[0];
  await rows("a0000000-0000-4000-8000-000000000011", "esblu_accept_company_invite", [fresh.token]);
  assert.equal(await activeOf("a0000000-0000-4000-8000-000000000011"), C.a);
});

await check("stale-active-company / membership-revoked-during-session: revoke → ďalší request deny; bezpečný fallback / výber firmy", async () => {
  await switchTo(U.y, C.c);
  assert.equal(await activeOf(U.y), C.c);
  await su(`update public.company_members set status = 'disabled' where company_id = $1 and user_id = $2`, [C.c, U.y]);
  assert.equal(await activeOf(U.y), null, "2 zostávajúce členstvá + neplatná voľba → NULL (výber firmy), nie náhodná firma");
  assert.equal(await count(U.y, "vehicles"), 0, "bez aktívnej firmy žiadne dáta");
  await switchTo(U.y, B);
  assert.equal(await count(U.y, "vehicles"), 10);
  // zmazaná aktívna firma → fallback
  await su(`insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000012', 'solo@example.invalid')`);
  await su(`insert into public.companies (id, owner_id, name) values ('c0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000012', 'Solo')`);
  await su(`insert into public.company_members (company_id, user_id, role, status) values ('c0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000012', 'owner', 'active')`);
  assert.equal(await activeOf("a0000000-0000-4000-8000-000000000012"), "c0000000-0000-4000-8000-000000000012", "jediné členstvo bez voľby = deterministicky tá firma");
});

await check("leave-company-preserves-data: Y opustí A → dáta, ktoré vytvoril, ostávajú A; Y stratí prístup; B nedotknutá", async () => {
  const before = Number((await one<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = $1 and user_id = $2`, [C.a, U.y])).n);
  const docs = Number((await one<{ n: number }>(`select count(*)::int n from public.documents where company_id = $1 and user_id = $2`, [C.a, U.y])).n);
  const r = await svc(async () => (await db.query<{ r: Row }>(`select public.esblu_account_deletion_commit('member', $1, $2, false) r`, [U.y, C.a])).rows[0].r);
  assert.equal(r.delete_account, false);
  assert.equal(r.remaining_memberships, 1);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = $1 and user_id = $2`, [C.a, U.y])).n), before);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.documents where company_id = $1 and user_id = $2`, [C.a, U.y])).n), docs);
  await fails(() => switchTo(U.y, C.a), /ESBLU_NOT_A_MEMBER/);
  assert.equal(await activeOf(U.y), B);
  assert.equal(await count(U.y, "vehicles"), 10, "B nedotknutá");
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from auth.users where id = $1`, [U.y])).n), 1, "login ostáva (má ďalšiu firmu)");
  const job = await one<Row>(`select auth_status, storage_status from public.account_deletion_cleanup_jobs where user_id = $1 order by created_at desc limit 1`, [U.y]);
  assert.deepEqual([job.auth_status, job.storage_status], ["done", "done"], "žiadne mazanie súborov ani loginu");
});

await check("owner-only-company-delete: employee / admin firmu nezruší; owner nemôže „odísť“; member delete neblokuje predplatné firmy", async () => {
  await fails(() => svc(() => db.query(`select public.esblu_account_deletion_commit('owner', $1, $2, false)`, [U.admin, C.a])), /ESBLU_NOT_ACTIVE_OWNER/);
  await fails(() => svc(() => db.query(`select public.esblu_account_deletion_commit('member', $1, $2, false)`, [U.x, C.a])), /ESBLU_OWNER_CANNOT_LEAVE/);
  // predplatné firmy A (obnovuje sa) — člen W2 môže odísť, firmu zrušiť nemožno
  await su(`insert into public.subscription_accounts (company_id, status, billing_provider, provider_environment, plan_code) values ($1, 'active', 'stripe', 'test', 'test_pro')`, [C.a]);
  await su(`insert into public.company_members (company_id, user_id, role, status) values ($1, 'a0000000-0000-4000-8000-000000000012', 'employee', 'active')`, [C.a]);
  await svc(() => db.query(`select public.esblu_account_deletion_commit('member', 'a0000000-0000-4000-8000-000000000012', $1, false)`, [C.a]));
  await fails(() => svc(() => db.query(`select public.esblu_account_deletion_commit('owner', $1, $2, false)`, [U.x, C.a])), /ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION/);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.companies where id = $1`, [C.a])).n), 1);
});

await check("global-user-delete-owned-company-block: login nemožno zrušiť, kým vlastní firmu; autor uchovávaných faktúr = fail closed", async () => {
  await fails(() => svc(() => db.query(`select public.esblu_account_deletion_commit('global', $1, null, true)`, [U.y])), /ESBLU_USER_OWNS_COMPANY/);
  assert.equal(await activeOf(U.y), B, "nič sa nezmenilo");
  // W: iba employee v C → globálne zrušenie OK (členstvo preč, dáta C ostávajú)
  const r = await svc(async () => (await db.query<{ r: Row }>(`select public.esblu_account_deletion_commit('global', $1, null, true) r`, [U.w])).rows[0].r);
  assert.equal(r.delete_account, true);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.company_members where user_id = $1`, [U.w])).n), 0);
  const job = await one<Row>(`select auth_status from public.account_deletion_cleanup_jobs where user_id = $1`, [U.w]);
  assert.equal(job.auth_status, "pending", "login sa zmaže až po commite (orchestrácia)");
  // autor faktúry v inej firme → blokované (CLIA: pseudonymizácia autora)
  await su(`insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000013', 'acc@example.invalid')`);
  await su(`insert into public.company_members (company_id, user_id, role, status) values ($1, 'a0000000-0000-4000-8000-000000000013', 'accountant', 'active')`, [C.c]);
  await su(`insert into public.invoices (company_id, direction, kind, created_by) values ($1, 'issued', 'invoice', 'a0000000-0000-4000-8000-000000000013')`, [C.c]);
  await fails(() => svc(() => db.query(`select public.esblu_account_deletion_commit('global', 'a0000000-0000-4000-8000-000000000013', null, true)`)), /ESBLU_RETAINED_RECORDS_AUTHOR/);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.company_members where user_id = 'a0000000-0000-4000-8000-000000000013'`)).n), 1, "rollback");
});

await check("account-deletion-regression: owner A + employee B — zrušenie firmy A zmaže iba A, členstvo v B ostáva; login ostáva", async () => {
  // Y vlastní B; pridáme ho ako employee do C2 (vlastník Z), potom Y zruší B
  const [c2] = await rows<{ company_id: string }>(U.z, "esblu_create_my_company", ["Z druhá s.r.o."]);
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values ($1, 'team_members', 'manual', 'active', 50, 'total')`, [c2.company_id]);
  const inv = (await rows<{ token: string }>(U.z, "esblu_create_company_invite", ["y@example.invalid", "employee"]))[0];
  await rows(U.y, "esblu_accept_company_invite", [inv.token]);
  await su(`delete from public.invoices where company_id = $1`, [B]);
  const r = await svc(async () => (await db.query<{ r: Row }>(`select public.esblu_account_deletion_commit('owner', $1, $2, false) r`, [U.y, B])).rows[0].r);
  assert.equal(r.remaining_memberships, 1);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.companies where id = $1`, [B])).n), 0);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = $1`, [B])).n), 0);
  assert.equal(await activeOf(U.y), c2.company_id, "zostávajúca firma (jediná) je aktívna");
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.settings where user_id = $1`, [U.y])).n) >= 0, true);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from auth.users where id = $1`, [U.y])).n), 1);
  // keby chcel zrušiť aj login pri ďalšej firme → odmietnuté
  await fails(() => svc(() => db.query(`select public.esblu_account_deletion_commit('member', $1, $2, true)`, [U.x, C.a])), /ESBLU_OWNER_CANNOT_LEAVE/);
});

await check("must-pass-e2e: Y = employee A + owner B; prepnutie A/B mení dáta, práva, billing, nároky; odchod z A nechá B a dáta A", async () => {
  // čistý model (nové firmy, aby nebol ovplyvnený predchádzajúcimi testami)
  const X2 = "a0000000-0000-4000-8000-000000000021";
  const Y2 = "a0000000-0000-4000-8000-000000000022";
  await su(`insert into auth.users (id, email) values ($1, 'x2@example.invalid'), ($2, 'y2@example.invalid')`, [X2, Y2]);
  await su(`insert into public.companies (id, owner_id, name) values ('c0000000-0000-4000-8000-000000000021', $1, 'A2 s.r.o.')`, [X2]);
  const A2 = "c0000000-0000-4000-8000-000000000021";
  await su(`insert into public.company_members (company_id, user_id, role, status) values ($1, $2, 'owner', 'active'), ($1, $3, 'employee', 'active')`, [A2, X2, Y2]);
  await su(`insert into public.subscription_accounts (company_id, status, billing_provider, provider_environment, plan_code) values ($1, 'active', 'stripe', 'test', 'test_pro')`, [A2]);
  await serialized(() => db.exec(`alter table public.companies disable trigger esblu_companies_trial_guard;
    update public.companies set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '16 days' where id = '${A2}';
    alter table public.companies enable trigger esblu_companies_trial_guard;
    set session_replication_role = replica; insert into public.vehicles (spz, user_id, company_id) values ('A2-1', '${Y2}', '${A2}'); set session_replication_role = origin;`));
  await su(`insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) select $1, version, $2, 'company_dpa_gate' from public.legal_documents where type = 'dpa' order by effective_at desc limit 1`, [A2, X2]);
  const [b2] = await rows<{ company_id: string }>(Y2, "esblu_create_my_company", ["Y2 SZČO"]);
  const B2 = b2.company_id;
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status) values ($1, 'voice', 'manual', 'active')`, [B2]);
  await serialized(() => db.exec(`set session_replication_role = replica;
    insert into public.vehicles (spz, user_id, company_id) select 'B2-' || g, '${Y2}', '${B2}' from generate_series(1, 10) g;
    insert into public.einvoice_organizations (company_id, provider, environment, participant_id) values ('${B2}', 'mock', 'sandbox', '9915:B2');
    set session_replication_role = origin;`));
  const voice = async () => ((await rpc<{ entitlements: { key: string; active: boolean }[] }>(Y2, "esblu_get_my_company_entitlements")).entitlements.find((e) => e.key === "voice")!).active;

  await switchTo(Y2, A2);
  assert.equal(await count(Y2, "vehicles"), 1);
  assert.equal(await rpc(Y2, "esblu_my_active_role"), "employee");
  assert.equal((await rpc<Row>(Y2, "esblu_billing_my_access")).can_manage, false);
  assert.equal(await voice(), false);
  assert.equal((await q(Y2, `select * from public.einvoice_organizations`)).length, 0);

  await switchTo(Y2, B2);
  assert.equal(await count(Y2, "vehicles"), 10);
  assert.equal(await rpc(Y2, "esblu_my_active_role"), "owner");
  assert.equal((await rpc<Row>(Y2, "esblu_billing_my_access")).can_manage, true);
  assert.equal(await voice(), true);
  assert.deepEqual((await q<{ participant_id: string }>(Y2, `select participant_id from public.einvoice_organizations`)).map((r) => r.participant_id), ["9915:B2"]);

  // Leave A (predplatné A platí owner X2 — odchod člena nie je blokovaný)
  await svc(() => db.query(`select public.esblu_account_deletion_commit('member', $1, $2, false)`, [Y2, A2]));
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = $1 and user_id = $2`, [A2, Y2])).n), 1, "vozidlo vytvorené Y2 ostáva firme A2");
  await fails(() => switchTo(Y2, A2), /ESBLU_NOT_A_MEMBER/);
  assert.equal(await activeOf(Y2), B2);
  assert.equal(await count(Y2, "vehicles"), 10, "B2 úplne nedotknutá");
  assert.equal(await voice(), true);
});

await check("rollback: migráciu nemožno vrátiť, kým má niekto 2+ aktívne členstvá (ochrana dát)", async () => {
  await fails(() => serialized(() => db.exec(read(MULTI_ROLLBACK))), /ESBLU_MULTI_COMPANY_ROLLBACK_BLOCKED/);
});

console.log(`\nmulti-company-db: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
