// =============================================================================
// eInvoice × multi-company (RC) — SKUTOČNÝ PostgreSQL (PGlite).
//
// Overuje integráciu einvoice-port → preprod-release-candidate
// (docs/einvoice-rc-integration-audit-2026-10-13.md §4, §5, §11.6):
//   - eInvoice RLS politiky (presný text z 20261002100000) + rollout UI RPC
//     (20261002150000) nad RC helpermi 20261012140000–160000 → per-session
//     aktívna firma, SZČO, cross-device, roly, izolácia enrollmentu,
//   - 20261013100000 eInvoice ↔ zrušenie firmy: fail closed pre e-faktúry,
//     registráciu u providera a finalizované doklady; inak bez zmeny; rollback.
// eInvoice tabuľky sú minimálne stuby (iba stĺpce, ktoré politiky / guard čítajú);
// politiky a funkcie sa čítajú zo skutočných migrácií. Nikdy Supabase / staging / produkcia.
//   npm run test:multi-company-einvoice-db      (SUITE=einvoice-deletion … pre jednu suite)
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MULTI = "supabase/migrations/20261012140000_multi_company_workspaces.sql";
const SESSION = "supabase/migrations/20261012150000_session_company_context_and_legal_entity_trial.sql";
const TRIAL_FINAL = "supabase/migrations/20261012160000_legal_entity_trial_final.sql";
const GUARD = "supabase/migrations/20261013100000_einvoice_company_deletion_guard.sql";
const GUARD_ROLLBACK = "supabase/rollback/20261013100000_einvoice_company_deletion_guard_rollback.sql";
const EINVOICE_FOUNDATION = "supabase/migrations/20261002100000_einvoice_foundation.sql";
const EINVOICE_ROLLOUT = "supabase/migrations/20261002150000_einvoice_rollout_gate.sql";
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
type Device = "A" | "B";
let device: Device = "A";
const sessionOf = (uid: string, dev: Device) => `5${{ A: "1", B: "2" }[dev]}${uid.slice(2)}`;
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const dev = device;
  await serialized(() => db.query(
    `insert into auth.sessions (id, user_id) select $1, $2 where exists (select 1 from auth.users where id = $2) on conflict (id) do nothing`,
    [sessionOf(uid, dev), uid]));
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
const switchTo = (uid: string, companyId: string) => rows(uid, "esblu_set_my_active_company", [companyId]);
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n);
const commit = (kind: string, uid: string, company: string | null, deleteAccount = false) =>
  svc(async () => (await db.query<{ r: Row }>(`select public.esblu_account_deletion_commit($1, $2, $3, $4) r`, [kind, uid, company, deleteAccount])).rows[0].r);

/** Iba `drop policy … / create policy …` bloky pre dané tabuľky zo skutočnej migrácie. */
function policiesFrom(file: string, tables: string[]): string {
  const sql = read(file);
  const out: string[] = [];
  for (const t of tables) {
    const drop = new RegExp(`drop policy if exists \\w+ on public\\.${t};`, "g");
    const create = new RegExp(`create policy \\w+ on public\\.${t}\\s+for select to authenticated\\s+using \\([\\s\\S]*?\\);`, "g");
    const d = sql.match(drop) ?? [];
    const c = sql.match(create) ?? [];
    assert.ok(c.length >= 1, `politika pre ${t} v ${file}`);
    out.push(...d, ...c);
  }
  return out.join("\n");
}
/** Jedna `create or replace function …` definícia (po `$function$;`) + jej revoke/grant riadky. */
function functionFrom(file: string, name: string): string {
  const sql = read(file);
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} v ${file}`);
  const end = sql.indexOf("$function$;", sql.indexOf("$function$", start) + 10) + "$function$;".length;
  const tail = sql.slice(end).split("\n").filter((l) => l.startsWith(`revoke all on function public.${name}(`) || l.startsWith(`grant execute on function public.${name}(`));
  return `${sql.slice(start, end)}\n${tail.slice(0, 2).join("\n")}`;
}

// ----------------------------------------------------------------------------- schéma (RC stack)
await db.exec(read("scripts/sql/entitlements-local-baseline.sql"));
await db.exec(`
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
for (const m of [
  "20260928100000_company_entitlements_trial.sql",
  "20261008120000_subscriptions_platform.sql",
  "20261011120000_subscriptions_lifecycle_hardening.sql",
  "20261012090000_subscriptions_event_token_redaction.sql",
  "20261012091000_subscriptions_purchase_options_owned_methods.sql",
  "20261012120000_account_deletion_subscription_guard.sql",
]) await db.exec(read(`supabase/migrations/${m}`));
await db.exec(read("scripts/sql/multi-company-local-stubs.sql"));
await db.exec(`alter table public.invoices add column if not exists finalized_by uuid;
  grant all on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(read("supabase/migrations/20261012130000_account_deletion_post_commit_cleanup.sql"));
// eInvoice tabuľky — stĺpce podľa 20261002100000 / 20261002150000, FK → companies CASCADE ako v produkcii.
await db.exec(`
  create table public.einvoice_organizations (id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade, provider text not null, environment text not null,
    provider_org_id text, participant_id text,
    constraint einvoice_organizations_company_env_key unique (company_id, environment),
    constraint einvoice_organizations_provider_org_key unique (provider, environment, provider_org_id));
  create table public.einvoice_outbound (id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade, environment text not null default 'sandbox', note text);
  create table public.einvoice_inbound (id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade, sender text);
  create table public.einvoice_webhook_events (id uuid primary key default gen_random_uuid(),
    company_id uuid references public.companies(id) on delete cascade, kind text);
  create table public.einvoice_events (id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade, kind text);
  create table public.einvoice_rollout (company_id uuid not null references public.companies(id) on delete cascade,
    environment text not null, stage text not null, primary key (company_id, environment));
  alter table public.einvoice_organizations enable row level security;
  alter table public.einvoice_outbound enable row level security;
  alter table public.einvoice_inbound enable row level security;
  alter table public.einvoice_webhook_events enable row level security;
  alter table public.einvoice_events enable row level security;
  alter table public.einvoice_rollout enable row level security;
  revoke all on public.einvoice_organizations, public.einvoice_outbound, public.einvoice_inbound,
    public.einvoice_webhook_events, public.einvoice_events, public.einvoice_rollout from anon, authenticated;
  grant select on public.einvoice_organizations, public.einvoice_outbound, public.einvoice_inbound,
    public.einvoice_webhook_events, public.einvoice_events to authenticated;
`);

for (const m of [MULTI, SESSION, TRIAL_FINAL]) await db.exec(read(m));
// eInvoice politiky / funkcie zo skutočných migrácií (po RC helperoch — tie istú signatúru prepisujú iba telom).
await db.exec(policiesFrom(EINVOICE_FOUNDATION, ["einvoice_organizations", "einvoice_outbound", "einvoice_inbound", "einvoice_webhook_events", "einvoice_events"]));
await db.exec(functionFrom(EINVOICE_ROLLOUT, "esblu_einvoice_rollout_allowed"));
await db.exec(functionFrom(EINVOICE_ROLLOUT, "esblu_einvoice_my_rollout"));
await db.exec(read(GUARD));

// ----------------------------------------------------------------------------- fixtures
const U = {
  owner: "a1000000-0000-4000-8000-000000000001", // owner ABC
  y: "a1000000-0000-4000-8000-000000000002", // employee ABC + owner „Ján Novák SZČO“
  acc: "a1000000-0000-4000-8000-000000000003", // accountant ABC
  fin: "a1000000-0000-4000-8000-000000000004", // admin ABC s finance.view/manage (bez billingu)
  foreign: "a1000000-0000-4000-8000-000000000005", // cudzí owner
};
const C = { abc: "c1000000-0000-4000-8000-000000000001", foreign: "c1000000-0000-4000-8000-000000000005" };
await db.exec(`
  insert into auth.users (id, email) values ${Object.entries(U).map(([k, id]) => `('${id}', '${k}@example.invalid')`).join(", ")};
  insert into public.companies (id, owner_id, name) values ('${C.abc}', '${U.owner}', 'ABC s.r.o.'), ('${C.foreign}', '${U.foreign}', 'Cudzia a.s.');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.abc}', '${U.owner}', 'owner', 'active', '{}'),
    ('${C.abc}', '${U.y}', 'employee', 'active', '{}'),
    ('${C.abc}', '${U.acc}', 'accountant', 'active', '{}'),
    ('${C.abc}', '${U.fin}', 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    ('${C.foreign}', '${U.foreign}', 'owner', 'active', '{}');
  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values
    ('${C.abc}', 'team_members', 'manual', 'active', 50, 'total');
`);
const [szco] = await on("B", () => rows<{ company_id: string }>(U.y, "esblu_create_my_company", ["Ján Novák – SZČO"]));
const SZCO = szco.company_id;
await on("A", () => switchTo(U.y, C.abc));
for (const [company, tag] of [[C.abc, "ABC"], [SZCO, "SZCO"], [C.foreign, "FOREIGN"]] as const) {
  await su(`insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id) values ($1, 'mock', 'sandbox', $2, $3)`,
    [company, `org-${tag}`, `9915:${tag}`]);
  await su(`insert into public.einvoice_inbound (company_id, sender) values ($1, $2)`, [company, `in-${tag}`]);
  await su(`insert into public.einvoice_outbound (company_id, note) values ($1, $2)`, [company, `out-${tag}`]);
  await su(`insert into public.einvoice_webhook_events (company_id, kind) values ($1, $2)`, [company, `wh-${tag}`]);
  await su(`insert into public.einvoice_events (company_id, kind) values ($1, $2)`, [company, `ev-${tag}`]);
}
await su(`insert into public.einvoice_rollout (company_id, environment, stage) values ($1, 'sandbox', 'internal')`, [SZCO]);
const tags = async (uid: string, table: string, col: string) =>
  (await q<{ v: string }>(uid, `select ${col} v from public.${table} order by 1`)).map((r) => r.v);
const VISIBLE = async (uid: string) => ({
  org: await tags(uid, "einvoice_organizations", "participant_id"),
  inbound: await tags(uid, "einvoice_inbound", "sender"),
  outbound: await tags(uid, "einvoice_outbound", "note"),
  webhooks: await tags(uid, "einvoice_webhook_events", "kind"),
  events: await tags(uid, "einvoice_events", "kind"),
});
const NONE = { org: [], inbound: [], outbound: [], webhooks: [], events: [] };
const ONLY = (tag: string) => ({ org: [`9915:${tag}`], inbound: [`in-${tag}`], outbound: [`out-${tag}`], webhooks: [`wh-${tag}`], events: [`ev-${tag}`] });

// ----------------------------------------------------------------------------- scoping
await check("einvoice-szco-cross-device: Y = employee ABC na PC, owner SZČO na mobile — súčasne, bez úniku", async () => {
  assert.deepEqual(await on("A", () => VISIBLE(U.y)), NONE, "PC: employee ABC bez finance.view");
  assert.deepEqual(await on("B", () => VISIBLE(U.y)), ONLY("SZCO"), "mobil: owner SZČO");
  assert.equal(await on("A", () => rpc(U.y, "esblu_einvoice_my_rollout", ["sandbox"])), false);
  assert.equal(await on("B", () => rpc(U.y, "esblu_einvoice_my_rollout", ["sandbox"])), true);
  // prepnutie na mobile nemení PC
  await on("B", () => switchTo(U.y, C.abc));
  assert.deepEqual(await on("B", () => VISIBLE(U.y)), NONE);
  assert.deepEqual(await on("A", () => VISIBLE(U.y)), NONE);
  await on("B", () => switchTo(U.y, SZCO));
  assert.deepEqual(await on("B", () => VISIBLE(U.y)), ONLY("SZCO"));
});

await check("einvoice-roles: owner / účtovník / finance admin ABC vidia iba ABC; cudzí owner iba svoje; rollout ABC = false", async () => {
  for (const uid of [U.owner, U.acc, U.fin]) {
    assert.deepEqual(await VISIBLE(uid), ONLY("ABC"), uid);
    assert.equal(await rpc(uid, "esblu_einvoice_my_rollout", ["sandbox"]), false, "ABC nemá rollout");
  }
  assert.deepEqual(await VISIBLE(U.foreign), ONLY("FOREIGN"));
  assert.equal(await rpc(U.foreign, "esblu_einvoice_my_rollout", ["live"]), false);
});

await check("einvoice-billing-vs-finance: finance admin (eInvoice prístup) NEMÁ billing; billing = iba owner", async () => {
  assert.equal((await rpc<Row>(U.fin, "esblu_billing_my_access")).can_manage, false);
  assert.equal((await rpc<Row>(U.acc, "esblu_billing_my_access")).can_manage, false);
  assert.equal((await rpc<Row>(U.owner, "esblu_billing_my_access")).can_manage, true);
  assert.equal((await on("B", () => rpc<Row>(U.y, "esblu_billing_my_access"))).can_manage, true, "Y = owner SZČO");
});

await check("einvoice-client-writes-denied: klient nezapisuje eInvoice tabuľky ani rollout (iba SECURITY DEFINER / service role)", async () => {
  await fails(() => q(U.owner, `insert into public.einvoice_organizations (company_id, provider, environment) values ($1, 'mock', 'live')`, [C.abc]), /permission denied|row-level security/);
  await fails(() => q(U.owner, `update public.einvoice_inbound set sender = 'x'`), /permission denied|row-level security/);
  await fails(() => q(U.owner, `delete from public.einvoice_outbound`), /permission denied|row-level security/);
  await fails(() => q(U.owner, `insert into public.einvoice_rollout (company_id, environment, stage) values ($1, 'sandbox', 'ga')`, [C.abc]), /permission denied|row-level security/);
  await fails(() => q(U.owner, `select public.esblu_einvoice_rollout_allowed($1, 'sandbox')`, [SZCO]), /permission denied/);
});

await check("einvoice-enrollment-isolation: provider org je per firma/prostredie; tá istá provider identita nemôže patriť 2 firmám", async () => {
  await fails(() => su(`insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id) values ($1, 'mock', 'sandbox', 'org-SZCO')`, [C.abc]), /duplicate key|einvoice_organizations_(company_env|provider_org)_key/);
  // SZČO live enrollment neovplyvní ABC
  await su(`insert into public.einvoice_organizations (company_id, provider, environment, participant_id) values ($1, 'mock', 'live', '0245:SZCO')`, [SZCO]);
  assert.deepEqual(await VISIBLE(U.owner), ONLY("ABC"));
  assert.deepEqual((await on("B", () => tags(U.y, "einvoice_organizations", "participant_id"))), ["0245:SZCO", "9915:SZCO"]);
  await su(`delete from public.einvoice_organizations where company_id = $1 and environment = 'live'`, [SZCO]);
});

// ----------------------------------------------------------------------------- 20261013100000
await check("einvoice-guard-migration: idempotentná, helper iba service_role, RC funkcia ostáva SECURITY DEFINER + service_role", async () => {
  await serialized(() => db.exec(read(GUARD)));
  await fails(() => q(U.owner, `select public.esblu_company_deletion_retention_blocker($1)`, [C.abc]), /permission denied/);
  await fails(() => q(U.owner, `select public.esblu_account_deletion_commit('owner', $1, $2, false)`, [U.owner, C.abc]), /permission denied/);
  assert.equal(await svc(async () => (await db.query<{ r: string }>(`select public.esblu_company_deletion_retention_blocker($1) r`, [C.abc])).rows[0].r), "EINVOICE_RECORDS");
  const sec = await one<{ d: boolean }>(`select prosecdef d from pg_proc where proname = 'esblu_account_deletion_commit'`);
  assert.equal(sec.d, true);
});

/** Vytvorí čistú firmu ownera `uid` (nová session → aktívna) a vráti jej id. */
async function freshCompany(uid: string, name: string): Promise<string> {
  const [c] = await on("A", () => rows<{ company_id: string }>(uid, "esblu_create_my_company", [name]));
  return c.company_id;
}
/** Faktúra bez entitlement triggrov (ako fixtures v multi-company-pglite-tests). */
const seedInvoice = (company: string, finalized: boolean) => serialized(() => db.exec(`set session_replication_role = replica;
  insert into public.invoices (company_id, direction, kind, document_status, finalized_at)
    values ('${company}', 'issued', 'invoice', '${finalized ? "finalized" : "draft"}', ${finalized ? "now()" : "null"});
  set session_replication_role = origin;`));
const exists = async (company: string) => (await n(`select count(*)::int n from public.companies where id = $1`, [company])) === 1;
const jobs = async (uid: string) => n(`select count(*)::int n from public.account_deletion_cleanup_jobs where user_id = $1`, [uid]);

await check("einvoice-deletion-blocked: e-faktúry (prijaté / odoslané), registrácia u providera, finalizovaná faktúra → ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION, nič sa nezmaže", async () => {
  const cases: Array<[string, (c: string) => Promise<unknown>, string]> = [
    ["Prijatá", (c) => su(`insert into public.einvoice_inbound (company_id, sender) values ($1, 'x')`, [c]), "EINVOICE_RECORDS"],
    ["Odoslaná", (c) => su(`insert into public.einvoice_outbound (company_id, note) values ($1, 'x')`, [c]), "EINVOICE_RECORDS"],
    ["Enrolled", (c) => su(`insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id) values ($1, 'mock', 'sandbox', $2)`, [c, `org-${c}`]), "EINVOICE_PROVIDER_ENROLLED"],
    ["Finalizovaná", (c) => seedInvoice(c, true), "FINALIZED_ACCOUNTING_DOCUMENTS"],
  ];
  for (const [label, seed, blocker] of cases) {
    const c = await freshCompany(U.foreign, `Blok ${label} s.r.o.`);
    await seed(c);
    const jobsBefore = await jobs(U.foreign);
    const message = await fails(() => commit("owner", U.foreign, c), /ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION/);
    assert.ok(message.length > 0);
    assert.equal(await svc(async () => (await db.query<{ r: string }>(`select public.esblu_company_deletion_retention_blocker($1) r`, [c])).rows[0].r), blocker, label);
    assert.ok(await exists(c), `${label}: firma ostáva`);
    assert.equal(await jobs(U.foreign), jobsBefore, `${label}: žiadny cleanup job (Storage sa nedotkne)`);
    assert.equal(await n(`select count(*)::int n from public.company_members where company_id = $1 and role = 'owner' and status = 'active'`, [c]), 1);
  }
  // SZČO (enrolled + doklady) — owner Y ju nezruší; ABC tiež nie
  await fails(() => commit("owner", U.y, SZCO), /ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION/);
  await fails(() => commit("owner", U.owner, C.abc), /ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION/);
  assert.ok((await exists(SZCO)) && (await exists(C.abc)));
  assert.deepEqual(await on("B", () => VISIBLE(U.y)), ONLY("SZCO"), "provider identita SZČO neosirotela");
});

await check("einvoice-deletion-allowed: firma bez dokladov / iba rozpracovaný onboarding (bez provider_org_id) / koncept → zrušenie prejde (RC flow bez zmeny)", async () => {
  const draft = await freshCompany(U.foreign, "Onboarding s.r.o.");
  await su(`insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id) values ($1, 'mock', 'sandbox', null)`, [draft]);
  await seedInvoice(draft, false);
  assert.equal(await svc(async () => (await db.query<{ r: string | null }>(`select public.esblu_company_deletion_retention_blocker($1) r`, [draft])).rows[0].r), null,
    "koncept ani neregistrovaná org neblokujú");
  // lokálny baseline: invoices FK bez kaskády (ako v multi-company-pglite-tests „account-deletion-regression")
  await su(`delete from public.invoices where company_id = $1`, [draft]);
  const r = await commit("owner", U.foreign, draft);
  assert.ok(r.job_id);
  assert.equal(await exists(draft), false);
  assert.equal(await n(`select count(*)::int n from public.einvoice_organizations where company_id = $1`, [draft]), 0, "neregistrovaná org sa zmaže kaskádou");
  assert.ok(await exists(C.foreign), "iná firma toho istého ownera ostáva");
});

await check("einvoice-member-and-global-unaffected: odchod člena z firmy s e-faktúrami je povolený; dáta ostávajú firme", async () => {
  const before = await n(`select count(*)::int n from public.einvoice_inbound where company_id = $1`, [C.abc]);
  const r = await commit("member", U.acc, C.abc, true);
  assert.equal(r.delete_account, true);
  assert.equal(await n(`select count(*)::int n from public.einvoice_inbound where company_id = $1`, [C.abc]), before);
  assert.equal(await n(`select count(*)::int n from public.company_members where user_id = $1`, [U.acc]), 0);
  // employee Y opustí ABC (Y ostáva owner SZČO) — eInvoice SZČO nedotknutá
  await commit("member", U.y, C.abc);
  assert.deepEqual(await on("B", () => VISIBLE(U.y)), ONLY("SZCO"));
  await fails(() => commit("global", U.y, null, true), /ESBLU_USER_OWNS_COMPANY/);
});

await check("einvoice-guard-rollback: rollback obnoví RC správanie (kaskáda), opätovná migrácia znova blokuje — v transakcii, vrátené", async () => {
  await serialized(async () => {
    await db.exec("begin");
    try {
      await db.exec(read(GUARD_ROLLBACK));
      const helper = await db.query<{ n: number }>(`select count(*)::int n from pg_proc where proname = 'esblu_company_deletion_retention_blocker'`);
      assert.equal(Number(helper.rows[0].n), 0);
      await db.exec(`set local role service_role`);
      await db.query(`select public.esblu_account_deletion_commit('owner', $1, $2, false)`, [U.y, SZCO]);
      await db.exec(`reset role`);
      const gone = await db.query<{ n: number }>(`select count(*)::int n from public.einvoice_organizations where company_id = $1`, [SZCO]);
      assert.equal(Number(gone.rows[0].n), 0, "bez guardu by kaskáda osirotila provider identitu (dôvod migrácie)");
    } finally {
      await db.exec("rollback");
    }
  });
  assert.ok(await exists(SZCO), "transakcia vrátená");
  await serialized(() => db.exec(read(GUARD_ROLLBACK)));
  await serialized(() => db.exec(read(GUARD)));
  await fails(() => commit("owner", U.y, SZCO), /ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION/);
});

console.log(`\nmulti-company-einvoice-db: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
