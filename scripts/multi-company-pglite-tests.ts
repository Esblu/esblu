// =============================================================================
// Multi-company / workspace model — SKUTOČNÝ PostgreSQL (PGlite) pre
//   20261012140000_multi_company_workspaces.sql
//   20261012150000_session_company_context_and_legal_entity_trial.sql
//     (aktívna firma per session/zariadenie, trial per právny subjekt)
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
const SESSION = "supabase/migrations/20261012150000_session_company_context_and_legal_entity_trial.sql";
const SESSION_ROLLBACK = "supabase/rollback/20261012150000_session_company_context_and_legal_entity_trial_rollback.sql";
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
// Zariadenie = auth session (JWT claim session_id). Predvolené zariadenie "A";
// deterministické session_id odvodené z používateľa a zariadenia.
type Device = "A" | "B" | "C" | "none";
let device: Device = "A";
const sessionOf = (uid: string, dev: Exclude<Device, "none">) => `5${{ A: "1", B: "2", C: "3" }[dev]}${uid.slice(2)}`;
async function ensureSession(uid: string, dev: Exclude<Device, "none">) {
  await serialized(() => db.query(
    `insert into auth.sessions (id, user_id) select $1, $2 where exists (select 1 from auth.users where id = $2) on conflict (id) do nothing`,
    [sessionOf(uid, dev), uid]));
}
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const dev = device;
  if (dev === "none") return inTx({ sub: uid, role: "authenticated" }, "authenticated", fn);
  await ensureSession(uid, dev);
  return inTx({ sub: uid, role: "authenticated", session_id: sessionOf(uid, dev) }, "authenticated", fn);
}
async function on<T>(dev: Device, fn: () => Promise<T>): Promise<T> {
  const prev = device;
  device = dev;
  try {
    return await fn();
  } finally {
    device = prev;
  }
}
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
  -- C má v profile IČO (neoverené, používateľom zadané) → backfill trial claimu subjektu
  insert into public.company_billing_profile (company_id, legal_name, ico, country_code) values ('${C.c}', 'Cudzia a.s.', '87654321', 'SK');
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

// ----------------------------------------------------------------------------- 20261012150000 (session kontext + trial subjektu)
const trialBefore = (await su<Row>(`select id, trial_started_at, trial_ends_at from public.companies order by id`)).rows;
await db.exec(read(SESSION));

await check("session-migration-backfill: existujúce firmy = legacy, trial nezmenený; jediné členstvo = aktívna firma bez session voľby; claimy backfill", async () => {
  const after = (await su<Row>(`select id, trial_started_at, trial_ends_at, trial_policy from public.companies order by id`)).rows;
  assert.deepEqual(after.map((r) => [r.id, r.trial_started_at, r.trial_ends_at]), trialBefore.map((r) => [r.id, r.trial_started_at, r.trial_ends_at]), "žiadny reset / predĺženie");
  assert.ok(after.every((r) => r.trial_policy === "legacy"));
  for (const [u, c] of [[U.x, C.a], [U.y, C.a], [U.z, C.c], [U.w, C.c]]) assert.equal(await activeOf(u), c, u);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.session_active_company`)).n), 0, "žiadna globálna voľba sa neprenáša");
  const claims = (await su<Row>(`select claim_kind, source, first_company_id from public.trial_claims order by first_company_id`)).rows;
  assert.deepEqual(claims.map((r) => [r.first_company_id, r.claim_kind, r.source]), [[C.a, "provisional_user", "backfill"], [C.c, "legal_entity", "backfill"]]);
  assert.equal((await one<{ n: number }>(`select count(*)::int n from public.trial_claims where claim_key like '%87654321%'`)).n, 0, "IČO sa neukladá v čitateľnej podobe");
  // idempotentná
  await serialized(() => db.exec(read(SESSION)));
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.trial_claims`)).n), 2);
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
  assert.equal((await one<Row>(`select trial_ends_at from public.companies where id = $1`, [B])).trial_ends_at, null, "nový workspace nedostane trial automaticky (čaká na právny subjekt)");
  assert.equal((await rpc<Row>(U.y, "esblu_my_company_trial_eligibility")).status, "pending_legal_identity");
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
  await fails(() => q(U.y, `update public.session_active_company set company_id = $1`, [C.c]), /permission denied/);
  await fails(() => q(U.y, `insert into public.session_active_company (session_id, user_id, company_id) values ($1, $2, $3)`, [sessionOf(U.y, "A"), U.y, C.c]), /permission denied/);
  const m = (await rows<{ company_id: string; role: string }>(U.y, "esblu_my_active_membership"))[0];
  assert.deepEqual([m.company_id, m.role], [C.a, "employee"]);
  const forUser = (await svc(async () => (await db.query<Row>(`select * from public.esblu_active_membership_for_user($1, $2)`, [U.y, sessionOf(U.y, "A")])).rows))[0];
  assert.equal(forUser.company_id, C.a);
  assert.equal(forUser.active_membership_count, 2);
  assert.equal((await svc(async () => (await db.query<Row>(`select * from public.esblu_active_membership_for_user($1)`, [U.y])).rows)).length, 0, "bez session a 2+ firiem → žiadna (výber)");
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

// ============================================================================= 20261012150000 — per-device kontext
const P = "a0000000-0000-4000-8000-000000000031"; // owner PA
const Q = "a0000000-0000-4000-8000-000000000032"; // employee PA + owner QB (2 zariadenia)
const R = "a0000000-0000-4000-8000-000000000033"; // admin PA s billing.manage
const S = "a0000000-0000-4000-8000-000000000034"; // accountant PA
const PA = "c0000000-0000-4000-8000-000000000031";
let QB = "";
let convPA = "";
let docPA = "";
await serialized(() => db.exec(`
  insert into auth.users (id, email) values ('${P}', 'p@example.invalid'), ('${Q}', 'q@example.invalid'), ('${R}', 'r@example.invalid'), ('${S}', 's@example.invalid');
  insert into public.companies (id, owner_id, name) values ('${PA}', '${P}', 'PA s.r.o.');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${PA}', '${P}', 'owner', 'active', '{}'), ('${PA}', '${Q}', 'employee', 'active', '{}'),
    ('${PA}', '${R}', 'admin', 'active', '{"billing":{"manage":true},"finance":{"view":true,"manage":true}}'),
    ('${PA}', '${S}', 'accountant', 'active', '{}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select '${PA}', version, '${P}', 'company_dpa_gate' from public.legal_documents where type = 'dpa' order by effective_at desc limit 1;
  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values
    ('${PA}', 'vehicles', 'manual', 'active', 10, 'total'), ('${PA}', 'team_members', 'manual', 'active', 50, 'total');
`));
await check("cross-device-isolation: Q na zariadení A v PA, na zariadení B v QB — prepnutie na jednom nemení druhé", async () => {
  const [qb] = await on("A", () => rows<{ company_id: string }>(Q, "esblu_create_my_company", ["Q SZČO"]));
  QB = qb.company_id;
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values ($1, 'vehicles', 'manual', 'active', 50, 'total')`, [QB]);
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status) values ($1, 'voice', 'manual', 'active')`, [QB]);
  await serialized(() => db.exec(`set session_replication_role = replica;
    insert into public.vehicles (spz, user_id, company_id) values ('PA-1', '${Q}', '${PA}');
    insert into public.vehicles (spz, user_id, company_id) select 'QB-' || g, '${Q}', '${QB}' from generate_series(1, 3) g;
    insert into public.einvoice_organizations (company_id, provider, environment, participant_id) values ('${PA}', 'mock', 'sandbox', '9915:PA'), ('${QB}', 'mock', 'sandbox', '9915:QB');
    set session_replication_role = origin;`));
  assert.equal(await on("A", () => activeOf(Q)), QB, "nová firma aktívna iba na zariadení, kde vznikla");
  assert.equal(await on("B", () => activeOf(Q)), null, "druhé zariadenie: 2 firmy bez voľby → výber");
  await on("B", () => switchTo(Q, PA));
  assert.equal(await on("A", () => activeOf(Q)), QB, "prepnutie na B nezmenilo A");
  assert.equal(await on("B", () => activeOf(Q)), PA);
  assert.equal(await on("A", () => count(Q, "vehicles")), 3);
  assert.equal(await on("B", () => count(Q, "vehicles")), 1);
  // výmena (súbežné prepínanie v opačných smeroch)
  await Promise.all([on("A", () => switchTo(Q, PA)), on("B", () => switchTo(Q, QB))]);
  assert.equal(await on("A", () => activeOf(Q)), PA);
  assert.equal(await on("B", () => activeOf(Q)), QB);
  assert.equal(await on("A", () => rpc(Q, "esblu_my_active_role")), "employee");
  assert.equal(await on("B", () => rpc(Q, "esblu_my_active_role")), "owner");
  const forSession = async (dev: "A" | "B") => (await svc(async () => (await db.query<Row>(`select * from public.esblu_active_membership_for_user($1, $2)`, [Q, sessionOf(Q, dev)])).rows))[0].company_id;
  assert.equal(await forSession("A"), PA, "server (service role) rozlišuje session");
  assert.equal(await forSession("B"), QB);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.session_active_company where user_id = $1`, [Q])).n), 2);
  assert.deepEqual((await on("A", () => q<{ company_id: string }>(Q, `select company_id from public.session_active_company`))).map((r) => r.company_id).sort(), [PA, QB].sort(), "RLS: vidí iba vlastné riadky");
  assert.equal((await on("A", () => q(P, `select * from public.session_active_company`))).length, 0);
});

await check("cross-device-owner-billing: billing = owner aktívnej firmy TEJTO session; owner B na inom zariadení nič neprenáša; admin/accountant/employee deny", async () => {
  // A = PA (employee), B = QB (owner)
  assert.equal((await on("A", () => rpc<Row>(Q, "esblu_billing_my_access"))).can_manage, false);
  await on("A", () => fails(() => rpc(Q, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /FORBIDDEN/));
  await on("A", () => fails(() => rpc(Q, "esblu_billing_issue_account_token", ["apple"]), /FORBIDDEN/));
  const mine = await on("B", () => rpc<Row>(Q, "esblu_billing_my_access"));
  assert.deepEqual([mine.can_manage, mine.company_id], [true, QB]);
  assert.equal((await on("A", () => rpc<Row>(Q, "esblu_billing_my_access"))).can_manage, false, "po billing volaní z B ostáva A bez práv");
  for (const uid of [R, S]) {
    assert.equal((await rpc<Row>(uid, "esblu_billing_my_access")).can_manage, false, uid);
    await fails(() => rpc(uid, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /FORBIDDEN/);
    await fails(() => rpc(uid, "esblu_billing_issue_account_token", ["apple"]), /FORBIDDEN/);
  }
  await fails(() => rpc(R, "esblu_billing_authorize_manage"), /FORBIDDEN/);
  assert.equal((await rpc<Row>(P, "esblu_billing_my_access")).can_manage, true, "owner PA");
  // prepnutie zariadenia A do QB → owner práva iba pre QB
  await on("A", () => switchTo(Q, QB));
  const a = await on("A", () => rpc<Row>(Q, "esblu_billing_my_access"));
  assert.deepEqual([a.can_manage, a.company_id], [true, QB]);
  await on("A", () => switchTo(Q, PA));
});

await check("cross-device-voice-chat-files-einvoice: nároky, AI kvóta, chat, dokumenty a eInvoice podľa session", async () => {
  type Ent = { key: string; active: boolean };
  const voice = async (dev: Device) => ((await on(dev, () => rpc<{ entitlements: Ent[] }>(Q, "esblu_get_my_company_entitlements"))).entitlements.find((e) => e.key === "voice")!).active;
  assert.equal(await voice("A"), false);
  assert.equal(await voice("B"), true);
  await on("A", () => fails(() => rpc(Q, "esblu_require_my_entitlement", ["voice"])));
  await on("B", () => rpc(Q, "esblu_require_my_entitlement", ["voice"]));
  await su(`insert into public.ai_scan_limits (endpoint, max_per_hour, max_per_day) values ('voice-dev', 50, 50) on conflict do nothing`);
  assert.equal((await on("A", () => rpc<Row>(Q, "esblu_consume_ai_scan_quota", ["voice-dev"]))).company_id, PA);
  assert.equal((await on("B", () => rpc<Row>(Q, "esblu_consume_ai_scan_quota", ["voice-dev"]))).company_id, QB);
  const [doc] = await on("B", () => q<{ company_id: string }>(Q, `insert into public.documents (user_id, storage_bucket, storage_path) values ($1, 'documents', 'voice/b.pdf') returning company_id`, [Q]));
  assert.equal(doc.company_id, QB, "hlasový záznam na B ide do QB");
  convPA = (await svc(() => db.query<{ id: string }>(`insert into public.chat_conversations (company_id, type, created_by) values ($1, 'company', $2) returning id`, [PA, P]))).rows[0].id;
  assert.equal(await on("A", () => rpc(Q, "esblu_chat_can_access_conversation", [convPA])), true);
  assert.equal(await on("B", () => rpc(Q, "esblu_chat_can_access_conversation", [convPA])), false);
  docPA = await serialized(async () => {
    await db.exec("set session_replication_role = replica");
    try {
      return (await db.query<{ id: string }>(`insert into public.documents (company_id, user_id, storage_bucket, storage_path) values ($1, $2, 'documents', $3) returning id`, [PA, Q, `${PA}/q.pdf`])).rows[0].id;
    } finally {
      await db.exec("set session_replication_role = origin");
    }
  });
  assert.equal(await on("A", () => rpc(Q, "esblu_can_read_document", [docPA])), true);
  assert.equal(await on("B", () => rpc(Q, "esblu_can_read_document", [docPA])), false);
  assert.deepEqual((await on("B", () => q<{ participant_id: string }>(Q, `select participant_id from public.einvoice_organizations`))).map((r) => r.participant_id), ["9915:QB"]);
  assert.equal((await on("A", () => q(Q, `select * from public.einvoice_organizations`))).length, 0, "employee PA bez finance.view");
});

await check("session-stale-revoked-logout-deleted: revoke / odhlásenie / zrušená firma → bezpečný fallback (1 = auto, 2+ = výber, 0 = onboarding)", async () => {
  // revoke PA → zariadenie A: ostáva 1 členstvo → auto QB; B nedotknuté
  await su(`update public.company_members set status = 'disabled' where company_id = $1 and user_id = $2`, [PA, Q]);
  assert.equal(await on("A", () => activeOf(Q)), QB);
  assert.equal(await on("A", () => rpc(Q, "esblu_chat_can_access_conversation", [convPA])), false, "revoke platí okamžite");
  assert.equal(await on("B", () => activeOf(Q)), QB);
  await su(`update public.company_members set status = 'active' where company_id = $1 and user_id = $2`, [PA, Q]);
  assert.equal(await on("A", () => activeOf(Q)), PA, "obnovené členstvo → pôvodná voľba zariadenia");
  // odhlásenie zariadenia A (auth session zmazaná) → kontext zaniká
  await su(`delete from auth.sessions where id = $1`, [sessionOf(Q, "A")]);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.session_active_company where session_id = $1`, [sessionOf(Q, "A")])).n), 0);
  assert.equal(await on("C", () => activeOf(Q)), null, "nové prihlásenie s 2 firmami → výber firmy");
  await on("C", () => switchTo(Q, PA));
  assert.equal(await on("B", () => activeOf(Q)), QB);
  // starý token bez session_id: voľba sa nedá uložiť; rozlíšenie iba pri 1 firme
  await on("none", () => fails(() => switchTo(Q, PA), /ESBLU_SESSION_REQUIRED/));
  assert.equal(await on("none", () => activeOf(Q)), null);
  assert.equal(await on("none", () => activeOf(P)), PA);
  // cudzia session (podvrhnutý session_id) → odmietnuté, nič sa nezapíše
  await ensureSession(P, "A");
  await fails(() => inTx({ sub: Q, role: "authenticated", session_id: sessionOf(P, "A") }, "authenticated",
    () => db.query(`select * from public.esblu_set_my_active_company($1)`, [PA])), /ESBLU_SESSION_MISMATCH/);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.session_active_company where session_id = $1`, [sessionOf(P, "A")])).n), 0);
  // zrušená firma QB (owner) → kontext zariadenia B zaniká, ostáva 1 firma → auto PA
  await su(`delete from public.documents where company_id = $1`, [QB]);
  await svc(() => db.query(`select public.esblu_account_deletion_commit('owner', $1, $2, false)`, [Q, QB]));
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.session_active_company where company_id = $1`, [QB])).n), 0);
  assert.equal(await on("B", () => activeOf(Q)), PA);
  // 0 členstiev → NULL (onboarding)
  await su(`insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000035', 'zero@example.invalid')`);
  assert.equal(await activeOf("a0000000-0000-4000-8000-000000000035"), null);
});

// ============================================================================= 20261012150000 — trial per právny subjekt
const O1 = "a0000000-0000-4000-8000-000000000041";
const O2 = "a0000000-0000-4000-8000-000000000042";
const companyTrial = async (id: string) => one<{ trial_started_at: string | null; trial_ends_at: string | null }>(`select trial_started_at, trial_ends_at from public.companies where id = $1`, [id]);
const recordIdentity = (companyId: string, reg: string, verified = true, country = "SK") =>
  svc(async () => (await db.query<{ r: Row }>(`select public.esblu_record_company_legal_identity($1, $2, $3, $4, 'registry:rpo') r`, [companyId, country, reg, verified])).rows[0].r);
const createCompany = async (uid: string, name: string) => (await rows<{ company_id: string }>(uid, "esblu_create_my_company", [name]))[0].company_id;
const trialStatus = async (uid: string, companyId: string) => {
  await switchTo(uid, companyId);
  return (await rpc<Row>(uid, "esblu_my_company_trial_eligibility")).status;
};
let O1first = "";
let O1two = "";
let O2two = "";

await check("trial-provisional-first-company: prvá firma po registrácii má trial (1× na používateľa); overené IČO ju priradí subjektu", async () => {
  await su(`insert into auth.users (id, email) values ($1, 'o1@example.invalid'), ($2, 'o2@example.invalid')`, [O1, O2]);
  await su(`insert into public.beta_allowlist (email) values ('o1@example.invalid'), ('o2@example.invalid')`);
  const [first] = await rows<{ company_id: string; created: boolean }>(O1, "esblu_ensure_my_owner_company");
  O1first = first.company_id;
  assert.equal(first.created, true);
  const t = await companyTrial(O1first);
  assert.ok(t.trial_ends_at);
  assert.equal(new Date(t.trial_ends_at!).getTime() - new Date(t.trial_started_at!).getTime(), 14 * 864e5);
  assert.equal(await activeOf(O1), O1first);
  assert.equal(await trialStatus(O1, O1first), "trial_active");
  const r = await recordIdentity(O1first, " 111 111 11");
  assert.deepEqual([r.verification_status, r.trial], ["verified", "already_has_trial"]);
  assert.deepEqual(await companyTrial(O1first), t, "trial sa nemení");
  const claim = await one<Row>(`select claim_kind, source from public.trial_claims where claim_key = public.esblu_claim_key('entity', 'SK:11111111')`);
  assert.deepEqual([claim.claim_kind, claim.source], ["legal_entity", "provisional_upgrade"]);
  const [again] = await rows<{ created: boolean }>(O1, "esblu_ensure_my_owner_company");
  assert.equal(again.created, false);
});

await check("trial-same-owner-two-entities: ďalší workspace = pending, kým nie je overený subjekt; iný subjekt rovnakého ownera dostane vlastný trial", async () => {
  O1two = await createCompany(O1, "O1 Druhá s.r.o.");
  assert.equal((await companyTrial(O1two)).trial_ends_at, null);
  assert.equal(await trialStatus(O1, O1two), "pending_legal_identity");
  const unverified = await recordIdentity(O1two, "22222222", false);
  assert.deepEqual([unverified.verification_status, unverified.trial], ["unverified", "pending_legal_identity"], "neoverená identita trial neudelí");
  assert.equal((await companyTrial(O1two)).trial_ends_at, null);
  assert.equal((await recordIdentity(O1two, "22222222", true)).trial, "granted");
  assert.ok((await companyTrial(O1two)).trial_ends_at);
  assert.equal(await trialStatus(O1, O1two), "trial_active");
});

await check("trial-same-entity-second-workspace + delete/recreate: rovnaké IČO v novom workspace / po zrušení firmy = bez trialu", async () => {
  const third = await createCompany(O1, "O1 Tretia");
  assert.equal((await recordIdentity(third, "222 222 22")).trial, "not_eligible_previous_trial");
  assert.equal(await trialStatus(O1, third), "not_eligible_previous_trial");
  assert.equal((await companyTrial(third)).trial_ends_at, null);
  // zruší firmu so subjektom 22222222 a založí ju znova
  await svc(() => db.query(`select public.esblu_account_deletion_commit('owner', $1, $2, false)`, [O1, O1two]));
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.companies where id = $1`, [O1two])).n), 0);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.trial_claims where claim_key = public.esblu_claim_key('entity', 'SK:22222222')`)).n), 1, "claim prežil zrušenie firmy");
  const recreated = await createCompany(O1, "O1 Druhá s.r.o.");
  assert.equal((await recordIdentity(recreated, "22222222")).trial, "not_eligible_previous_trial");
  assert.equal((await companyTrial(recreated)).trial_ends_at, null);
});

await check("trial-different-owner-same-entity / same-name-different-ico / renamed-same-ico / legacy backfill", async () => {
  // O2 dostane prvú firmu (provizórny trial)
  await rows(O2, "esblu_ensure_my_owner_company");
  const o2a = await createCompany(O2, "Iná firma");
  assert.equal((await recordIdentity(o2a, "22222222")).trial, "not_eligible_previous_trial", "iný owner, rovnaký subjekt");
  const o2b = await createCompany(O2, "O1 Druhá s.r.o.");
  O2two = o2b;
  assert.equal((await recordIdentity(o2b, "33333333")).trial, "granted", "rovnaký názov, iné IČO = iný subjekt");
  await su(`update public.companies set name = 'Premenovaná s.r.o.' where id = $1`, [o2b]);
  const o2c = await createCompany(O2, "Úplne iný názov");
  assert.equal((await recordIdentity(o2c, "33333333")).trial, "not_eligible_previous_trial", "premenovanie nemení subjekt");
  await fails(() => recordIdentity(o2b, "44444444"), /ESBLU_LEGAL_IDENTITY_LOCKED/);
  const o2d = await createCompany(O2, "Kópia Cudzej");
  assert.equal((await recordIdentity(o2d, "87654321")).trial, "not_eligible_previous_trial", "legacy firma s IČO (backfill) blokuje nový trial");
  const o2e = await createCompany(O2, "CZ pobočka");
  assert.equal((await recordIdentity(o2e, "87654321", true, "CZ")).trial, "granted", "rovnaké číslo, iná krajina = iný subjekt");
});

await check("trial-manual-grant-and-override: manuálny grant funguje bez trialu; operátorská výnimka; aktívny trial sa neresetuje", async () => {
  const pending = await createCompany(O2, "Pending s.r.o.");
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status) values ($1, 'voice', 'manual', 'active')`, [pending]);
  await switchTo(O2, pending);
  type Ent = { key: string; active: boolean };
  assert.equal((await rpc<{ entitlements: Ent[] }>(O2, "esblu_get_my_company_entitlements")).entitlements.find((e) => e.key === "voice")!.active, true, "manuálny grant nezávisí od trialu");
  assert.equal(await svc(async () => (await db.query<{ r: string }>(`select public.esblu_operator_override_company_trial($1) r`, [pending])).rows[0].r), "manual_override");
  assert.ok((await companyTrial(pending)).trial_ends_at);
  assert.equal(await trialStatus(O2, pending), "manual_override");
  // aktívny trial: opakovaný claim / override nič nemení
  const before = await companyTrial(O2two);
  assert.equal(await svc(async () => (await db.query<{ r: string }>(`select public.esblu_try_claim_company_trial($1) r`, [O2two])).rows[0].r), "already_has_trial");
  assert.equal(await svc(async () => (await db.query<{ r: string }>(`select public.esblu_operator_override_company_trial($1) r`, [O2two])).rows[0].r), "already_has_trial");
  assert.deepEqual(await companyTrial(O2two), before);
  await fails(() => su(`update public.companies set trial_ends_at = trial_ends_at + interval '14 days', trial_started_at = trial_started_at + interval '14 days' where id = $1`, [O2two]), /ESBLU_TRIAL_IMMUTABLE/);
  await fails(() => su(`update public.companies set trial_started_at = null, trial_ends_at = null where id = $1`, [O2two]), /ESBLU_TRIAL_IMMUTABLE/);
  await fails(() => su(`update public.companies set trial_policy = 'legacy' where id = $1`, [O2two]), /ESBLU_TRIAL_POLICY_IMMUTABLE/);
  const inserted = await one<Row>(`insert into public.companies (owner_id, name, trial_started_at, trial_ends_at, trial_policy) values ($1, 'Podvrh', now(), now() + interval '14 days', 'legacy') returning trial_started_at, trial_policy`, [O2]);
  assert.deepEqual([inserted.trial_started_at, inserted.trial_policy], [null, "legal_entity"], "INSERT nesmie nastaviť trial ani policy");
});

await check("trial-server-authority: klient nemôže udeliť trial, zapísať identitu ani čítať históriu", async () => {
  await switchTo(O2, O2two);
  for (const [fn, args] of [
    ["esblu_record_company_legal_identity", [O2two, "SK", "55555555", true, "client"]],
    ["esblu_try_claim_company_trial", [O2two]],
    ["esblu_operator_override_company_trial", [O2two]],
    ["esblu_grant_company_trial_internal", [O2two]],
    ["esblu_set_session_company_internal", [O2, O2two]],
  ] as const) await fails(() => rpc(O2, fn, [...args]), /permission denied/);
  await fails(() => q(O2, `select * from public.trial_claims`), /permission denied/);
  await fails(() => q(O2, `insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key) values ($1, 'SK', '55555555', 'SK:55555555')`, [O2two]), /permission denied/);
  assert.deepEqual((await q<{ registration_id: string }>(O2, `select registration_id from public.company_legal_identities`)).map((r) => r.registration_id), ["33333333"], "owner vidí iba identitu aktívnej firmy");
  // employee nevidí identitu
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values ($1, 'team_members', 'manual', 'active', 50, 'total')`, [O2two]);
  await su(`insert into public.company_members (company_id, user_id, role, status) values ($1, $2, 'employee', 'active')`, [O2two, O1]);
  await switchTo(O1, O2two);
  assert.equal((await q(O1, `select * from public.company_legal_identities`)).length, 0);
});

await check("trial-race-and-normalization: dva workspace-y rovnakého nového subjektu → max 1 claim; neplatné IČO odmietnuté", async () => {
  const r1 = await createCompany(O2, "Race 1");
  const r2 = await createCompany(O2, "Race 2");
  // PGlite = 1 spojenie → volania sa serializujú; v Postgres ich serializuje advisory lock + PK trial_claims.
  const results = await Promise.all([recordIdentity(r1, "55555555"), recordIdentity(r2, "5555 5555")]);
  assert.deepEqual(results.map((r) => r.trial).sort(), ["granted", "not_eligible_previous_trial"]);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.trial_claims where claim_key = public.esblu_claim_key('entity', 'SK:55555555')`)).n), 1);
  const granted = [(await companyTrial(r1)).trial_ends_at, (await companyTrial(r2)).trial_ends_at].filter(Boolean);
  assert.equal(granted.length, 1, "trial má iba jedna firma");
  for (const bad of ["abc", "", "000000", "123", "123456789"]) await fails(() => recordIdentity(r1, bad), /ESBLU_INVALID_REGISTRATION_ID/);
  const norm = await one<{ a: string; b: string; c: string | null }>(`select public.esblu_normalize_registration_id('sk', ' 1234 56') a, public.esblu_legal_entity_key('cz', '00012345') b, public.esblu_normalize_registration_id('XX1', '1') c`);
  assert.deepEqual([norm.a, norm.b, norm.c], ["00123456", "CZ:00012345", null]);
  // provizórny trial je 1× na používateľa — opätovné vytvorenie prvej firmy po zrušení všetkých firiem trial nedá
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.trial_claims where claim_kind = 'provisional_user'`)).n), 3, "A (backfill), O1, O2");
});

await check("session-rollback: rollback 20261012150000 prenesie poslednú voľbu do user_active_company, história trialov ostáva (v transakcii, vrátené)", async () => {
  await serialized(async () => {
    await db.exec("begin");
    try {
      await db.exec(read(SESSION_ROLLBACK));
      const claims = await db.query<{ n: number }>(`select count(*)::int n from public.trial_claims`);
      assert.ok(Number(claims.rows[0].n) > 0);
      assert.equal((await db.query<{ r: string | null }>(`select to_regclass('public.session_active_company')::text r`)).rows[0].r, null);
      const uac = await db.query<{ company_id: string }>(`select company_id from public.user_active_company where user_id = $1`, [Q]);
      assert.equal(uac.rows[0]?.company_id, PA);
    } finally {
      await db.exec("rollback");
    }
  });
  assert.equal(await on("B", () => activeOf(Q)), PA, "po vrátení transakcie platí session model");
});

await check("rollback: migráciu nemožno vrátiť, kým má niekto 2+ aktívne členstvá (ochrana dát)", async () => {
  await fails(() => serialized(() => db.exec(read(MULTI_ROLLBACK))), /ESBLU_MULTI_COMPANY_ROLLBACK_BLOCKED/);
});

console.log(`\nmulti-company-db: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
