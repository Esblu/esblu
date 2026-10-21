// =============================================================================
// ČISTÝ REPLAY VŠETKÝCH MIGRÁCIÍ BEZ LEGACY AUTO-GRANTOV — SKUTOČNÝ PostgreSQL (PGlite)
//
// Simuluje nový / preview / resetovaný Supabase projekt po zmene 2026-10-30:
// schéma public NEMÁ žiadne default privileges pre anon / authenticated /
// service_role. Na prázdnu databázu (iba kostra Supabase platformy) sa
// aplikujú VŠETKY repo migrácie od nuly a overí sa:
//   replay    — všetky migrácie prejdú; baseline + reconciliation sú idempotentné
//   acl       — granty každej public tabuľky == supabase/grants/public-data-api-grants.json
//   functions — service_role allowlist, anon iba invite preview, definer search_path
//   defaults  — žiadne default privileges pre klientske roly
//   data-api  — rolová matica (anon / owner / admin / accountant / employee /
//               service_role) s rozlíšením vrstvy: object privilege (42501
//               „permission denied“) vs RLS (0 riadkov / „row-level security“)
//   tenant    — izolácia firiem A/B pre SELECT/INSERT/UPDATE/DELETE + 2 sessions
//   billing   — owner-only autorita, billing tabuľky nedostupné klientovi
//   einvoice  — finance roly vidia, employee/iná firma nie, interné tabuľky service-only
//   trial     — trial_claims a legal identity hash nie sú klientsky čitateľné
//   deletion  — cleanup fronty nedostupné klientom
//   media     — metadata tabuľky vs storage.objects politiky oddelene
//   push      — zariadenia iba cez RPC
// Nikdy Supabase / staging / produkcia.
//   npm run test:grants-replay-db            (SUITE=acl … pre jednu suite)
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const SUITE = (process.argv[2] ?? process.env.SUITE ?? "").replace(/^--suite=/, "").trim() || null;
const MIGRATIONS = "supabase/migrations";
const BASELINE = "20260720000000_legacy_pre_migration_baseline.sql";
const RECONCILE = "20261021100000_explicit_data_api_grants.sql";
const ROLLBACK = "supabase/rollback/20261021100000_explicit_data_api_grants_rollback.sql";

// Poradie replayu = poradie súborov, OKREM dvoch historických závislostí, kde
// produkcia migrácie aplikovala v inom poradí, než je prefix súboru
// (supabase_migrations.schema_migrations: 20260916082812 / 20260916090827 pred
// 20260916101241). Súbory sa nepremenúvajú (supabase/MIGRATIONS.md §5).
export const REPLAY_ORDER_OVERRIDES: Array<[string, string]> = [
  ["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],
  ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"],
];
export function replayOrder(files: string[]): string[] {
  let out = [...files].sort();
  for (const [file, before] of REPLAY_ORDER_OVERRIDES) {
    assert.ok(out.includes(file) && out.includes(before), `replay override ${file} → ${before} odkazuje na neexistujúci súbor`);
    out = out.filter((f) => f !== file);
    out.splice(out.indexOf(before), 0, file);
  }
  return out;
}

type Row = Record<string, unknown>;
type Db = { exec: (sql: string) => Promise<unknown>; query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
type Manifest = {
  tables: Record<string, { domain: string; access: string; anon: string; authenticated: string; service_role: string; note: string;
    column_grants?: Record<string, Record<string, string[]>> }>;
  service_role_functions: string[];
};
const manifest: Manifest = JSON.parse(read("supabase/grants/public-data-api-grants.json"));

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
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}

// ----------------------------------------------------------------------------- replay od nuly
await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
const files = replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")));
const applied: string[] = [];
let replayError: string | null = null;
for (const f of files) {
  try {
    await db.exec(read(`${MIGRATIONS}/${f}`));
    applied.push(f);
  } catch (error) {
    replayError = `${f}: ${error instanceof Error ? error.message : String(error)}`;
    break;
  }
}

await check("replay: všetky migrácie sa aplikujú od nuly bez auto-grantov", async () => {
  assert.equal(replayError, null, replayError ?? "");
  assert.equal(applied.length, files.length);
  assert.equal(applied[0], BASELINE, "baseline musí byť prvá");
  assert.ok(applied.includes(RECONCILE), "reconciliation migrácia chýba v replayi");
});
if (replayError) {
  console.log(`\n${passed} passed, ${failed + 1} failed (replay zastavený)`);
  process.exit(1);
}

// ----------------------------------------------------------------------------- snapshot helpers
type AclRow = { k: string; obj: string; g: string; privs: string };
async function aclSnapshot(): Promise<AclRow[]> {
  return (await db.query<AclRow>(`
    with rels as (
      select 't' k, c.relname::text obj, coalesce(c.relacl, acldefault('r', c.relowner)) acl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p','v','m')),
    cols as (
      select 'c' k, c.relname::text || '.' || a.attname::text obj, a.attacl acl
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped and a.attacl is not null),
    fns as (
      select 'f' k, p.oid::regprocedure::text obj, coalesce(p.proacl, acldefault('f', p.proowner)) acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
    ex as (
      select o.k, o.obj, case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee)::text end g, e.privilege_type::text p
      from (select * from rels union all select * from cols union all select * from fns) o, aclexplode(o.acl) e)
    select k, obj, g, string_agg(p, ',' order by p) privs
    from ex where g in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    group by k, obj, g order by k, obj, g`)).rows;
}
const norm = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
const tablePrivs = (snap: AclRow[], table: string, role: string) =>
  norm(snap.find((r) => r.k === "t" && r.obj === table && r.g === role)?.privs ?? "");

const snapshot = await aclSnapshot();

// ----------------------------------------------------------------------------- replay idempotencia
await check("replay: baseline a reconciliation sú idempotentné (2. beh = rovnaký stav)", async () => {
  await db.exec(read(`${MIGRATIONS}/${BASELINE}`));
  await db.exec(read(`${MIGRATIONS}/${RECONCILE}`));
  assert.deepEqual(await aclSnapshot(), snapshot);
});

await check("replay: rollback sa aplikuje čisto a opätovná migrácia vráti presne manifest", async () => {
  await db.exec(read(ROLLBACK));
  const rolled = await aclSnapshot();
  assert.equal(tablePrivs(rolled, "invoice_parties", "authenticated"), "DELETE,INSERT,SELECT,UPDATE");
  assert.ok(tablePrivs(rolled, "vehicles", "service_role").includes("TRUNCATE"));
  await db.exec(read(`${MIGRATIONS}/${RECONCILE}`));
  assert.deepEqual(await aclSnapshot(), snapshot);
});

await check("replay: reconciliation precondition zlyhá na tabuľke bez rozhodnutia o grantoch", async () => {
  await db.exec("create table public.zz_grants_probe (id int primary key)");
  try {
    await assert.rejects(db.exec(read(`${MIGRATIONS}/${RECONCILE}`)), /ESBLU_GRANTS_PRECONDITION/);
  } finally {
    await db.exec("drop table public.zz_grants_probe");
  }
});

// ----------------------------------------------------------------------------- acl
const tables = (await db.query<{ t: string; rls: boolean }>(
  `select c.relname::text t, c.relrowsecurity rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p') order by 1`)).rows;

await check("acl: množina public tabuliek == manifest (každá má explicitné rozhodnutie)", async () => {
  assert.deepEqual(tables.map((t) => t.t).sort(), Object.keys(manifest.tables).sort());
});

await check("acl: RLS zapnutá na každej public tabuľke", async () => {
  assert.deepEqual(tables.filter((t) => !t.rls).map((t) => t.t), []);
});

await check("acl: granty každej tabuľky presne podľa manifestu (anon / authenticated / service_role / PUBLIC)", async () => {
  const diffs: string[] = [];
  for (const [t, m] of Object.entries(manifest.tables)) {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const have = tablePrivs(snapshot, t, role);
      const want = norm(m[role]);
      if (have !== want) diffs.push(`${t}/${role}: má [${have}] chce [${want}]`);
    }
    const pub = tablePrivs(snapshot, t, "PUBLIC");
    if (pub) diffs.push(`${t}/PUBLIC: [${pub}]`);
  }
  assert.deepEqual(diffs, []);
});

await check("acl: stĺpcové granty iba podľa manifestu (settings)", async () => {
  const want: string[] = [];
  for (const [t, m] of Object.entries(manifest.tables))
    for (const [role, privs] of Object.entries(m.column_grants ?? {}))
      for (const [priv, cols] of Object.entries(privs)) for (const c of cols) want.push(`${t}.${c}/${role}/${priv}`);
  const have = snapshot.filter((r) => r.k === "c").flatMap((r) => r.privs.split(",").map((p) => `${r.obj}/${r.g}/${p}`));
  assert.deepEqual(have.sort(), want.sort());
});

await check("acl: žiadna klientska rola nemá TRUNCATE / REFERENCES / TRIGGER / MAINTAIN", async () => {
  const bad = snapshot.filter((r) => r.k === "t" && /TRUNCATE|REFERENCES|TRIGGER|MAINTAIN/.test(r.privs));
  assert.deepEqual(bad, []);
});

await check("acl: anon má iba SELECT na legal_documents", async () => {
  assert.deepEqual(snapshot.filter((r) => r.k !== "f" && r.g === "anon").map((r) => `${r.obj}:${r.privs}`), ["legal_documents:SELECT"]);
});

await check("acl: service-only tabuľky (D) nemajú žiadny klientsky grant", async () => {
  const leaks = Object.entries(manifest.tables)
    .filter(([, m]) => m.access === "D" || m.access === "C")
    .flatMap(([t]) => ["anon", "authenticated"].map((g) => [t, g, tablePrivs(snapshot, t, g)] as const))
    .filter(([, , p]) => p !== "");
  assert.deepEqual(leaks, []);
  for (const t of ["billing_events", "billing_provider_links", "trial_claims", "account_deletion_cleanup_jobs", "media_deletion_queue",
    "einvoice_webhook_rejections", "einvoice_event_cursors", "einvoice_ops_audit", "einvoice_rollout", "subscription_accounts"])
    assert.ok(["C", "D"].includes(manifest.tables[t].access), `${t} musí byť service/RPC-only`);
});

// ----------------------------------------------------------------------------- functions
await check("functions: service_role EXECUTE == allowlist z manifestu", async () => {
  const have = snapshot.filter((r) => r.k === "f" && r.g === "service_role").map((r) => r.obj).sort();
  assert.deepEqual(have, [...manifest.service_role_functions].sort());
});

await check("functions: anon EXECUTE iba esblu_get_invite_preview(text)", async () => {
  assert.deepEqual(snapshot.filter((r) => r.k === "f" && r.g === "anon").map((r) => r.obj), ["esblu_get_invite_preview(text)"]);
});

await check("functions: každá SECURITY DEFINER funkcia má pevný search_path a nie je PUBLIC/anon (okrem allowlistu)", async () => {
  const bad = (await db.query<{ sig: string; why: string }>(`
    select p.oid::regprocedure::text sig,
      case when not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') then 'no search_path'
           when has_function_privilege('anon', p.oid, 'EXECUTE') and p.proname <> 'esblu_get_invite_preview' then 'anon execute'
      end why
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef`)).rows.filter((r) => r.why);
  assert.deepEqual(bad, []);
});

await check("functions: každé serverové RPC volané service klientom je spustiteľné service_role", async () => {
  const serverRpcs = ["esblu_account_deletion_commit", "esblu_member_delete_self", "esblu_owner_delete_company", "esblu_active_membership_for_user",
    "esblu_billing_apply_event", "esblu_billing_record_event", "esblu_billing_reconcile_candidates", "esblu_billing_claim_store_reports",
    "esblu_einvoice_claim_outbound", "esblu_einvoice_webhook_record", "esblu_einvoice_inbound_register", "esblu_einvoice_org_upsert_provisioned",
    "esblu_fx_import_ecb_batch", "esblu_push_delivery_targets", "esblu_push_record_outcome", "esblu_record_company_legal_identity"];
  const rows = (await db.query<{ proname: string; ok: boolean }>(
    `select p.proname::text, bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) ok
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1) group by 1`, [serverRpcs])).rows;
  assert.equal(rows.length, serverRpcs.length, "niektoré serverové RPC neexistuje");
  assert.deepEqual(rows.filter((r) => !r.ok).map((r) => r.proname), []);
});

// ----------------------------------------------------------------------------- defaults
await check("defaults: žiadne default privileges pre anon / authenticated / service_role v public", async () => {
  const rows = (await db.query<{ acl: string }>(
    `select coalesce(defaclacl::text, '') acl from pg_default_acl where defaclnamespace = 'public'::regnamespace`)).rows;
  assert.deepEqual(rows.filter((r) => /(anon|authenticated|service_role)=/.test(r.acl)), []);
  // nová tabuľka po reconciliation nedostane nič (rovnako ako na Supabase po 2026-10-30)
  await db.exec("create table public.zz_new_table (id int primary key)");
  try {
    const t = await aclSnapshot();
    assert.equal(t.filter((r) => r.obj === "zz_new_table").length, 0);
  } finally {
    await db.exec("drop table public.zz_new_table");
  }
});

// ----------------------------------------------------------------------------- fixtures pre rolovú maticu
const U = {
  ownerA: "b0000000-0000-4000-8000-0000000000a1",
  adminA: "b0000000-0000-4000-8000-0000000000a2",
  accountantA: "b0000000-0000-4000-8000-0000000000a3",
  employeeA: "b0000000-0000-4000-8000-0000000000a4",
  ownerB: "b0000000-0000-4000-8000-0000000000b1",
  multi: "b0000000-0000-4000-8000-0000000000c1", // employee v A aj v B
};
const C = { a: "d0000000-0000-4000-8000-00000000000a", b: "d0000000-0000-4000-8000-00000000000b" };
const SESS = { ownerA: "e0000000-0000-4000-8000-0000000000a1", adminA: "e0000000-0000-4000-8000-0000000000a2",
  accountantA: "e0000000-0000-4000-8000-0000000000a3", employeeA: "e0000000-0000-4000-8000-0000000000a4",
  ownerB: "e0000000-0000-4000-8000-0000000000b1", multiA: "e0000000-0000-4000-8000-0000000000c1", multiB: "e0000000-0000-4000-8000-0000000000c2" };
const ROW = { vehA: "f0000000-0000-4000-8000-0000000000a1", vehB: "f0000000-0000-4000-8000-0000000000b1",
  invA: "f0000000-0000-4000-8000-0000000000a2", invB: "f0000000-0000-4000-8000-0000000000b2" };

await db.exec(`
  insert into auth.users (id, email) values
    ('${U.ownerA}', 'oa@example.invalid'), ('${U.adminA}', 'ada@example.invalid'), ('${U.accountantA}', 'aca@example.invalid'),
    ('${U.employeeA}', 'ea@example.invalid'), ('${U.ownerB}', 'ob@example.invalid'), ('${U.multi}', 'm@example.invalid');
  insert into auth.sessions (id, user_id) values
    ('${SESS.ownerA}', '${U.ownerA}'), ('${SESS.adminA}', '${U.adminA}'), ('${SESS.accountantA}', '${U.accountantA}'),
    ('${SESS.employeeA}', '${U.employeeA}'), ('${SESS.ownerB}', '${U.ownerB}'), ('${SESS.multiA}', '${U.multi}'), ('${SESS.multiB}', '${U.multi}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.ownerA}', 'Firma A'), ('${C.b}', '${U.ownerB}', 'Firma B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.ownerA}', 'owner', 'active', '{}'),
    ('${C.a}', '${U.adminA}', 'admin', 'active', '{"billing":{"manage":true},"finance":{"view":true,"manage":true}}'),
    ('${C.a}', '${U.accountantA}', 'accountant', 'active', '{}'),
    ('${C.a}', '${U.employeeA}', 'employee', 'active', '{"finance":{"view":true,"manage":true}}'),
    ('${C.a}', '${U.multi}', 'employee', 'active', '{}'),
    ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${C.b}', '${U.multi}', 'employee', 'active', '{}');
  insert into public.session_active_company (session_id, user_id, company_id) values
    ('${SESS.multiA}', '${U.multi}', '${C.a}'), ('${SESS.multiB}', '${U.multi}', '${C.b}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select co, d.version, own, 'company_dpa_gate'
    from (values ('${C.a}'::uuid, '${U.ownerA}'::uuid), ('${C.b}'::uuid, '${U.ownerB}'::uuid)) v(co, own),
         (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values
    ('${C.a}', 'vehicles', 'manual', 'active', 100, 'total'), ('${C.b}', 'vehicles', 'manual', 'active', 100, 'total');
  insert into public.vehicles (id, spz, user_id, company_id) values ('${ROW.vehA}', 'A-1', '${U.ownerA}', '${C.a}'), ('${ROW.vehB}', 'B-1', '${U.ownerB}', '${C.b}');
  insert into public.invoices (id, company_id, direction, kind) values ('${ROW.invA}', '${C.a}', 'issued', 'regular_invoice'), ('${ROW.invB}', '${C.b}', 'issued', 'regular_invoice');
  insert into public.einvoice_organizations (company_id, provider, environment) values ('${C.a}', 'efaktura', 'sandbox'), ('${C.b}', 'efaktura', 'sandbox');
  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key) values
    ('${C.a}', 'SK', '12345678', 'SK:12345678'), ('${C.b}', 'SK', '87654321', 'SK:87654321');
  insert into public.trial_claims (claim_key, claim_kind, source) values (public.esblu_claim_key('entity', 'SK:12345678'), 'legal_entity', 'trial');
  set session_replication_role = origin;
`);

// ----------------------------------------------------------------------------- Data API simulácia
// Rovnako ako PostgREST: SET LOCAL ROLE <rola> + request.jwt.claims v transakcii, ktorá sa vždy zahodí.
type Who = { role: "anon" | "authenticated" | "service_role"; uid?: string; session?: string };
const anon: Who = { role: "anon" };
const svc: Who = { role: "service_role" };
const as = (uid: string, session: string): Who => ({ role: "authenticated", uid, session });
const ownerA = as(U.ownerA, SESS.ownerA), adminA = as(U.adminA, SESS.adminA), accountantA = as(U.accountantA, SESS.accountantA),
  employeeA = as(U.employeeA, SESS.employeeA), ownerB = as(U.ownerB, SESS.ownerB);

type Outcome = { layer: "ok" | "privilege" | "rls" | "error"; rows: number; message: string };
async function attempt(who: Who, sql: string, params: unknown[] = []): Promise<Outcome> {
  await db.exec("begin");
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query(sql, params);
    const affected = (r as { affectedRows?: number }).affectedRows;
    return { layer: "ok", rows: r.rows.length || affected || 0, message: "" };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? String(error);
    if (e.code === "42501" && /permission denied/.test(message)) return { layer: "privilege", rows: 0, message };
    if (e.code === "42501" && /row-level security/.test(message)) return { layer: "rls", rows: 0, message };
    return { layer: "error", rows: 0, message: `${e.code ?? "?"} ${message}` };
  } finally {
    await db.exec("rollback");
  }
}
async function expectLayer(who: Who, sql: string, layer: Outcome["layer"], rows?: number, params: unknown[] = []) {
  const o = await attempt(who, sql, params);
  assert.equal(o.layer, layer, `${who.role}${who.uid ? "/" + who.uid.slice(-2) : ""}: ${sql} → ${o.layer} ${o.message}`);
  if (rows !== undefined) assert.equal(o.rows, rows, `${sql} → ${o.rows} riadkov, čakalo sa ${rows}`);
}

await check("data-api: anon — object privilege deny na business, billing aj service tabuľkách", async () => {
  for (const t of ["invoices", "documents", "vehicles", "companies", "company_members", "billing_events", "trial_claims", "account_deletion_cleanup_jobs", "push_devices"])
    await expectLayer(anon, `select * from public.${t}`, "privilege");
  await expectLayer(anon, `insert into public.vehicles (spz, company_id) values ('X', '${C.a}')`, "privilege");
  await expectLayer(anon, "select type from public.legal_documents", "ok");
  await expectLayer(anon, "select public.esblu_get_invite_preview('nope')", "ok");
  await expectLayer(anon, "select public.esblu_my_active_company_id()", "privilege");
});

await check("data-api: authenticated — object privilege deny na service/RPC-only tabuľkách (aj owner)", async () => {
  for (const [t, m] of Object.entries(manifest.tables)) {
    if (m.access !== "C" && m.access !== "D") continue;
    await expectLayer(ownerA, `select 1 from public.${t} limit 1`, "privilege");
  }
});

await check("data-api: authenticated — zápis do SELECT-only tabuliek je object privilege deny (nie RLS)", async () => {
  await expectLayer(ownerA, `insert into public.invoice_parties (invoice_id) values ('${ROW.invA}')`, "privilege");
  await expectLayer(ownerA, `update public.invoice_payments set paid_amount = 0`, "privilege");
  await expectLayer(ownerA, `delete from public.invoice_events`, "privilege");
  await expectLayer(ownerA, `delete from public.company_billing_profile`, "privilege");
  await expectLayer(ownerA, `delete from public.settings`, "privilege");
  await expectLayer(ownerA, `update public.settings set plan = 'admin'`, "privilege");
  await expectLayer(ownerA, `update public.companies set name = 'x'`, "privilege");
  await expectLayer(ownerA, `truncate public.vehicles`, "privilege");
});

await check("data-api: service_role — DML na všetkých tabuľkách podľa manifestu, TRUNCATE nie", async () => {
  for (const t of Object.keys(manifest.tables)) await expectLayer(svc, `select 1 from public.${t} limit 1`, "ok");
  await expectLayer(svc, "select count(*) from public.vehicles", "ok");
  await expectLayer(svc, "truncate public.billing_events", "privilege");
  await expectLayer(svc, "delete from public.einvoice_events", "privilege"); // append-only feed
  await expectLayer(svc, "delete from public.trial_claims", "privilege"); // trvalá história
});

// ----------------------------------------------------------------------------- tenant
await check("tenant: SELECT — owner A vidí iba firmu A, owner B iba B (RLS, nie privilege)", async () => {
  const a = await attempt(ownerA, "select spz from public.vehicles");
  assert.equal(a.layer, "ok");
  assert.deepEqual((await svcRows<{ spz: string }>(ownerA, "select spz from public.vehicles")).map((r) => r.spz), ["A-1"]);
  assert.deepEqual((await svcRows<{ spz: string }>(ownerB, "select spz from public.vehicles")).map((r) => r.spz), ["B-1"]);
  assert.deepEqual((await svcRows<{ id: string }>(ownerA, "select id from public.invoices")).map((r) => r.id), [ROW.invA]);
  await expectLayer(ownerA, `select 1 from public.invoices where id = '${ROW.invB}'`, "ok", 0);
});

await check("tenant: INSERT do cudzej firmy → RLS deny; do vlastnej → ok", async () => {
  await expectLayer(ownerA, `insert into public.vehicles (spz, user_id, company_id) values ('A-2', '${U.ownerA}', '${C.a}') returning id`, "ok", 1);
  const cross = await attempt(ownerA, `insert into public.vehicles (spz, user_id, company_id) values ('X-9', '${U.ownerA}', '${C.b}') returning id`);
  assert.notEqual(cross.layer, "ok", "insert do cudzej firmy prešiel");
  assert.notEqual(cross.layer, "privilege", "cudzia firma musí byť blokovaná RLS/triggerom, nie chýbajúcim grantom");
});

await check("tenant: UPDATE/DELETE cudzích riadkov = 0 riadkov (RLS), vlastných = 1", async () => {
  await expectLayer(ownerA, `update public.vehicles set model = 'x' where id = '${ROW.vehB}'`, "ok", 0);
  await expectLayer(ownerA, `delete from public.vehicles where id = '${ROW.vehB}'`, "ok", 0);
  await expectLayer(ownerA, `update public.vehicles set model = 'x' where id = '${ROW.vehA}'`, "ok", 1);
  await expectLayer(ownerA, `delete from public.vehicles where id = '${ROW.vehA}'`, "ok", 1);
});

await check("tenant: rovnaký používateľ v 2 sessions s rôznou aktívnou firmou → izolované výsledky", async () => {
  const inA = await svcRows<{ spz: string }>(as(U.multi, SESS.multiA), "select spz from public.vehicles");
  const inB = await svcRows<{ spz: string }>(as(U.multi, SESS.multiB), "select spz from public.vehicles");
  assert.deepEqual(inA.map((r) => r.spz), ["A-1"]);
  assert.deepEqual(inB.map((r) => r.spz), ["B-1"]);
  assert.equal((await svcRows<{ c: string }>(as(U.multi, SESS.multiA), "select public.esblu_my_active_company_id()::text c"))[0].c, C.a);
  assert.equal((await svcRows<{ c: string }>(as(U.multi, SESS.multiB), "select public.esblu_my_active_company_id()::text c"))[0].c, C.b);
});

// ----------------------------------------------------------------------------- billing
await check("billing: owner-only autorita — iba owner prejde esblu_billing_authorize_manage", async () => {
  await expectLayer(ownerA, "select public.esblu_billing_authorize_manage()", "ok");
  for (const who of [adminA, accountantA, employeeA]) {
    const o = await attempt(who, "select public.esblu_billing_authorize_manage()");
    assert.ok(/ESBLU_BILLING_FORBIDDEN/.test(o.message), `${who.uid} nesmie spravovať billing: ${o.layer} ${o.message}`);
  }
});

await check("billing: žiadna billing/subscription tabuľka nie je klientsky čitateľná ani pre ownera", async () => {
  for (const t of Object.keys(manifest.tables).filter((t) => /^(billing_|subscription_)/.test(t)))
    for (const who of [ownerA, adminA]) await expectLayer(who, `select 1 from public.${t}`, "privilege");
});

// ----------------------------------------------------------------------------- einvoice
await check("einvoice: owner/accountant vidia org vlastnej firmy; employee bez finance a iná firma nie (RLS)", async () => {
  await expectLayer(ownerA, "select company_id from public.einvoice_organizations", "ok", 1);
  await expectLayer(accountantA, "select company_id from public.einvoice_organizations", "ok", 1);
  await expectLayer(employeeA, "select company_id from public.einvoice_organizations", "ok", 0); // forged permissions.finance
  await expectLayer(ownerB, `select 1 from public.einvoice_organizations where company_id = '${C.a}'`, "ok", 0);
});

await check("einvoice: klient nemôže zapisovať do eInvoice tabuliek ani čítať interné (privilege)", async () => {
  await expectLayer(ownerA, `update public.einvoice_organizations set provider = 'x'`, "privilege");
  await expectLayer(ownerA, `insert into public.einvoice_events (company_id) values ('${C.a}')`, "privilege");
  for (const t of ["einvoice_rollout", "einvoice_event_cursors", "einvoice_enroll_attempts", "einvoice_ops_audit", "einvoice_webhook_rejections"])
    await expectLayer(accountantA, `select 1 from public.${t}`, "privilege");
});

// ----------------------------------------------------------------------------- trial
await check("trial: trial_claims (hash právneho subjektu) nie je čitateľná pre žiadneho klienta", async () => {
  for (const who of [anon, ownerA, adminA, accountantA, employeeA]) await expectLayer(who, "select claim_key from public.trial_claims", "privilege");
  await expectLayer(svc, "select claim_key from public.trial_claims", "ok", 1);
});

await check("trial: legal identity — iba owner aktívnej firmy, iba vlastná firma", async () => {
  await expectLayer(ownerA, "select legal_entity_key from public.company_legal_identities", "ok", 1);
  for (const who of [adminA, accountantA, employeeA]) await expectLayer(who, "select 1 from public.company_legal_identities", "ok", 0);
  await expectLayer(ownerB, `select 1 from public.company_legal_identities where company_id = '${C.a}'`, "ok", 0);
  await expectLayer(ownerA, "update public.company_legal_identities set verification_status = 'verified'", "privilege");
});

// ----------------------------------------------------------------------------- deletion
await check("deletion: cleanup fronty (account deletion, media) nedostupné klientom, service OK", async () => {
  for (const t of ["account_deletion_cleanup_jobs", "media_deletion_queue"]) {
    for (const who of [anon, ownerA, employeeA]) {
      await expectLayer(who, `select 1 from public.${t}`, "privilege");
      await expectLayer(who, `delete from public.${t}`, "privilege");
    }
    await expectLayer(svc, `select 1 from public.${t}`, "ok");
  }
  await expectLayer(svc, "delete from public.account_deletion_cleanup_jobs", "privilege"); // zámer repa: bez DELETE
});

// ----------------------------------------------------------------------------- media
await check("media: metadata tabuľky — vlastná firma zapisuje, cudzia nie; storage.objects politiky oddelene", async () => {
  await expectLayer(ownerA, `insert into public.vehicle_photos (vehicle_id, user_id, storage_bucket, storage_path, company_id) values ('${ROW.vehA}', '${U.ownerA}', 'vehicle-photos', '${C.a}/${ROW.vehA}/1.jpg', '${C.a}') returning id`, "ok", 1);
  const cross = await attempt(ownerA, `insert into public.vehicle_photos (vehicle_id, user_id, storage_bucket, storage_path, company_id) values ('${ROW.vehB}', '${U.ownerA}', 'vehicle-photos', '${C.b}/${ROW.vehB}/1.jpg', '${C.b}') returning id`);
  assert.ok(cross.layer === "rls" || cross.layer === "error", `cross-tenant media metadata: ${cross.layer} ${cross.message}`);
  const pol = (await db.query<{ n: number }>("select count(*)::int n from pg_policies where schemaname = 'storage' and tablename = 'objects'")).rows[0].n;
  assert.ok(pol > 0, "storage.objects politiky chýbajú");
  // storage.objects nie je predmetom Data API grant manifestu (iná schéma, spravuje Supabase Storage)
  assert.ok(!Object.keys(manifest.tables).some((t) => t.startsWith("storage")));
});

// ----------------------------------------------------------------------------- push
await check("push: push_devices / push_subscriptions iba cez RPC", async () => {
  for (const t of ["push_devices", "push_subscriptions", "notification_preferences", "notification_deliveries"])
    await expectLayer(ownerA, `select 1 from public.${t}`, "privilege");
  await expectLayer(ownerA, "select * from public.esblu_push_my_devices()", "ok");
  await expectLayer(anon, "select * from public.esblu_push_my_devices()", "privilege");
});

async function svcRows<T = Row>(who: Who, sql: string): Promise<T[]> {
  await db.exec("begin");
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`set local role ${who.role}`);
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec("rollback");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
