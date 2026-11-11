// =============================================================================
// J10.1 CLIA follow-up (11.11.2026) — DPA elektronický model, server-side DPA
// parita (invoices / business_partners / einvoice_organizations / Storage),
// dôkaz prijatia dokumentov (archív 5 r.), jazyk potvrdenia, rozšírená
// retencia. PGlite, čistý replay všetkých migrácií. Nikdy staging/produkcia.
//
//   npm run test:clia-j10-1-db
// =============================================================================
// (pôvodná hlavička J10 nižšie platí pre zdieľané pomocné funkcie)
// J10 CLIA GDPR reconciliation — SKUTOČNÝ PostgreSQL (PGlite), čistý replay
// VŠETKÝCH migrácií (vrátane 20261110100000 a 20261110110000).
//
//   - esblu_purge_gdpr_technical_retention: maže IBA záznamy nad maximom CLIA
//     (revoked push > 30 d, doručenia > 90 d, neprijaté pozvánky > 30 d po
//     expirácii/zrušení, dokončené deletion joby > 90 d, expirované asistent
//     záznamy > 1 d, dokončená media fronta > 90 d); čerstvé / aktívne /
//     prijaté / nedokončené záznamy ostávajú.
//   - esblu_list_stale_unconfirmed_auth_users: iba nepotvrdené účty bez
//     členstva a firmy staršie ako 30 dní; minimum 30 dní nejde obísť.
//   - esblu_account_deletion_commit (owner): zber ciest zahŕňa chat-attachments.
//   - privacy_policy 1.4 (required) a cookie_policy 1.1 (nie required) sú
//     publikované; pending required acceptance pre používateľa s 1.3 = 1.4.
//   - klient (authenticated / anon) nevie spustiť žiadnu z nových funkcií.
// Nikdy Supabase / staging / produkcia.
//
//   npm run test:clia-gdpr-db
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MIGRATIONS = "supabase/migrations";
const REPLAY_ORDER_OVERRIDES: Array<[string, string]> = [
  ["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],
  ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"],
];
function replayOrder(files: string[]): string[] {
  let out = [...files].sort();
  for (const [file, before] of REPLAY_ORDER_OVERRIDES) {
    out = out.filter((f) => f !== file);
    out.splice(out.indexOf(before), 0, file);
  }
  return out;
}

type Row = Record<string, unknown>;
const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}

await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
const files = replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")));
assert.ok(files.includes("20261110100000_clia_gdpr_retention_alignment.sql"));
assert.ok(files.includes("20261110110000_clia_privacy_1_4_cookies_1_1.sql"));
for (const f of files) await db.exec(read(`${MIGRATIONS}/${f}`));

type Who = { role: "authenticated" | "service_role" | "anon"; uid?: string; session?: string };
type Outcome = { layer: "ok" | "privilege" | "error"; message: string; data: Row[] };
async function run(who: Who, sql: string, params: unknown[] = [], commit = false): Promise<Outcome> {
  await db.exec("begin");
  let ok = false;
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<Row>(sql, params);
    ok = true;
    return { layer: "ok", message: "", data: r.rows };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? String(error);
    if (e.code === "42501") return { layer: "privilege", message, data: [] };
    return { layer: "error", message: `${e.code ?? "?"} ${message}`, data: [] };
  } finally {
    await db.exec(commit && ok ? "commit" : "rollback");
  }
}
const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;


const U = {
  owner: "e2000000-0000-4000-8000-0000000000a1",
  admin: "e2000000-0000-4000-8000-0000000000a2",
  employee: "e2000000-0000-4000-8000-0000000000a4",
  ownerB: "e2000000-0000-4000-8000-0000000000b1",
};
const C = { a: "e3000000-0000-4000-8000-00000000000a", b: "e3000000-0000-4000-8000-00000000000b" };
const S = { owner: "e4000000-0000-4000-8000-0000000000a1", admin: "e4000000-0000-4000-8000-0000000000a2", employee: "e4000000-0000-4000-8000-0000000000a4", ownerB: "e4000000-0000-4000-8000-0000000000b1" };
const who = (k: keyof typeof U & keyof typeof S): Who => ({ role: "authenticated", uid: U[k], session: S[k] });
const owner = who("owner"), admin = who("admin"), employee = who("employee"), ownerB = who("ownerB");

await db.exec(`
  insert into auth.users (id, email, email_confirmed_at) values
    ('${U.owner}', 'owner@example.invalid', now()), ('${U.admin}', 'admin@example.invalid', now()),
    ('${U.employee}', 'emp@example.invalid', now()), ('${U.ownerB}', 'ownerb@example.invalid', now());
  insert into auth.sessions (id, user_id) values ('${S.owner}', '${U.owner}'), ('${S.admin}', '${U.admin}'), ('${S.employee}', '${U.employee}'), ('${S.ownerB}', '${U.ownerB}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.owner}', 'Firma A s.r.o.'), ('${C.b}', '${U.ownerB}', 'Firma B s.r.o.');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.owner}', 'owner', 'active', '{}'), ('${C.a}', '${U.admin}', 'admin', 'active', '{}'),
    ('${C.a}', '${U.employee}', 'employee', 'active', '{}'), ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}');
  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key) values ('${C.a}', 'SK', '12345678', 'SK:12345678');
  set session_replication_role = origin;
`);

const currentDpa = (await su<{ v: string }>("select version v from public.legal_documents where type = 'dpa' order by effective_at desc, created_at desc, version desc limit 1"))[0].v;

await check("DPA 1.3 je aktuálna účinná verzia a hash = legal/dpa/1.3.md", async () => {
  assert.equal(currentDpa, "1.3");
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(readFileSync(path.join(ROOT, "legal/dpa/1.3.md"))).digest("hex");
  assert.equal((await su<{ h: string }>("select content_hash h from public.legal_documents where type = 'dpa' and version = '1.3'"))[0].h, h);
});

await check("DPA: bez prijatia sa nedá vložiť business_partner (server-side guard, aj service_role)", async () => {
  for (const w of [owner, { role: "service_role" } as Who]) {
    const o = await run(w, `insert into public.business_partners (company_id, kind, legal_name) values ('${C.a}', 'customer', 'Partner')`);
    assert.equal(o.layer, "error", `${w.role}: ${o.message}`);
    assert.match(o.message, /ESBLU_COMPANY_DPA_NOT_ACCEPTED/);
  }
});

await check("DPA guard trigger existuje na invoices, business_partners, einvoice_organizations", async () => {
  const rows = await su<{ t: string }>(`select c.relname t from pg_trigger g join pg_class c on c.oid = g.tgrelid
    where g.tgname = 'esblu_require_company_dpa_before_insert' and c.relname in ('invoices','business_partners','einvoice_organizations') order by 1`);
  assert.deepEqual(rows.map((r) => r.t), ["business_partners", "einvoice_organizations", "invoices"]);
});

await check("Storage: nový zákaznícky súbor bez DPA zamietnutý, logo firmy povolené", async () => {
  const deny = await run(owner, "select public.esblu_storage_dpa_allowed('ai-inbox-documents') a");
  assert.equal(deny.data[0].a, false);
  const logo = await run(owner, "select public.esblu_storage_dpa_allowed('company-logos') a");
  assert.equal(logo.data[0].a, true);
  const pol = await su("select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'esblu_storage_company_dpa' and permissive = 'RESTRICTIVE'");
  assert.equal(pol.length, 1);
});

await check("DPA prijatie: iba owner, iba s vyhlásením o oprávnení, iba aktuálna verzia", async () => {
  for (const w of [admin, employee]) {
    const o = await run(w, "select public.esblu_accept_company_dpa($1, true, 'sk')", [currentDpa]);
    assert.match(o.message, /ESBLU_NOT_ACTIVE_OWNER/);
  }
  const noAuth = await run(owner, "select public.esblu_accept_company_dpa($1)", [currentDpa]);
  assert.match(noAuth.message, /ESBLU_DPA_AUTHORITY_NOT_CONFIRMED/);
  const old = await run(owner, "select public.esblu_accept_company_dpa('1.2', true, 'sk')");
  assert.match(old.message, /ESBLU_NOT_CURRENT_DPA_VERSION/);
  const ok = await run(owner, "select (public.esblu_accept_company_dpa($1, true, 'de')).*", [currentDpa], true);
  assert.equal(ok.layer, "ok", ok.message);
  const r = ok.data[0];
  assert.equal(r.accepted_by, U.owner);
  assert.equal(r.accepted_role, "owner");
  assert.equal(r.authority_confirmed, true);
  assert.equal(r.version, "1.3");
  assert.match(String(r.document_content_hash), /^[0-9a-f]{64}$/);
  assert.equal(r.display_locale, "de");
  assert.equal(r.company_name_snapshot, "Firma A s.r.o.");
  assert.equal(r.company_registration_id_snapshot, "12345678");
  assert.equal(r.processor_acceptance, "esblu_electronic_offer_dpa_10_1");
  assert.ok(r.accepted_at);
});

await check("po prijatí DPA: business_partner aj Storage povolené; cudzia firma B stále blokovaná", async () => {
  const ins = await run({ role: "service_role" }, `insert into public.business_partners (company_id, kind, legal_name) values ('${C.a}', 'customer', 'Partner A')`);
  assert.equal(ins.layer, "ok", ins.message);
  const st = await run(owner, "select public.esblu_storage_dpa_allowed('chat-attachments') a");
  assert.equal(st.data[0].a, true);
  const b = await run({ role: "service_role" }, `insert into public.business_partners (company_id, kind, legal_name) values ('${C.b}', 'customer', 'Partner B')`);
  assert.match(b.message, /ESBLU_COMPANY_DPA_NOT_ACCEPTED/);
  const stB = await run(ownerB, "select public.esblu_storage_dpa_allowed('chat-attachments') a");
  assert.equal(stB.data[0].a, false);
});

await check("legal acceptance: jazyk zobrazenia + source_version v metadata; preklad nie je nová verzia", async () => {
  const o = await run(employee, "select (public.esblu_accept_legal_document_at_gate('privacy_policy', '1.4', 'en')).metadata m", [], true);
  assert.equal(o.layer, "ok", o.message);
  assert.deepEqual(o.data[0].m, { display_locale: "en", source_version: "1.4" });
  const legacy = await run(employee, "select (public.esblu_accept_legal_document_registration('terms', '1.1')).metadata m", [], true);
  assert.deepEqual(legacy.data[0].m, {});
  const rows = await su("select 1 from public.legal_documents where type = 'privacy_policy' and version = '1.4'");
  assert.equal(rows.length, 1, "EN/DE nemajú vlastný legal_documents riadok");
  for (const fn of ["esblu_accept_legal_document_at_gate", "esblu_accept_legal_document_registration", "esblu_accept_company_dpa"]) {
    const a = await run({ role: "anon" }, `select 1 from pg_proc where proname = '${fn}' and has_function_privilege('anon', oid, 'execute')`);
    assert.equal(a.data.length, 0, `${fn} anon`);
  }
});

await check("dôkaz prijatia sa pri výmaze archivuje (user aj firma), service-only, purge po 5 r.", async () => {
  await su(`delete from public.user_legal_acceptances where user_id = '${U.employee}'`);
  const ev = await su<{ scope: string; user_email: string; document_type: string; version: string }>(
    `select scope, user_email, document_type, version from public.legal_acceptance_evidence where user_id = '${U.employee}' order by document_type`);
  assert.deepEqual(ev.map((e) => `${e.scope}:${e.user_email}:${e.document_type}:${e.version}`),
    ["user:emp@example.invalid:privacy_policy:1.4", "user:emp@example.invalid:terms:1.1"]);
  await su("alter table public.legal_documents disable trigger esblu_legal_documents_no_delete");
  await su(`set session_replication_role = origin`);
  await su(`delete from public.company_dpa_acceptances where company_id = '${C.a}'`);
  await su("alter table public.legal_documents enable trigger esblu_legal_documents_no_delete");
  const dpa = await su<{ details: Record<string, unknown>; company_name: string; company_registration_id: string; accepted_role: string }>(
    `select details, company_name, company_registration_id, accepted_role from public.legal_acceptance_evidence where scope = 'company_dpa'`);
  assert.equal(dpa.length, 1);
  assert.equal(dpa[0].company_name, "Firma A s.r.o.");
  assert.equal(dpa[0].company_registration_id, "12345678");
  assert.equal(dpa[0].accepted_role, "owner");
  assert.equal(dpa[0].details.authority_confirmed, true);
  for (const w of [owner, employee, { role: "anon" } as Who]) {
    const o = await run(w, "select * from public.legal_acceptance_evidence");
    assert.equal(o.layer, "privilege", `${w.role}`);
  }
  await su("update public.legal_acceptance_evidence set archived_at = now() - interval '5 years 1 day' where scope = 'company_dpa'");
  const p = await run({ role: "service_role" }, "select public.esblu_purge_gdpr_technical_retention(1000) r", [], true);
  assert.equal((p.data[0].r as Record<string, number>).legal_acceptance_evidence, 1);
  assert.equal((await su("select 1 from public.legal_acceptance_evidence")).length, 2, "čerstvé dôkazy ostávajú");
});

await check("retencia J10.1: trial_claims > 5 r., ai_scan_usage > 90 d, pseudonymizácia ai_processing_usage > 90 d", async () => {
  await db.exec(`
    set session_replication_role = replica;
    insert into public.trial_claims (claim_key, claim_kind, source, trial_ends_at, created_at) values
      ('entity:${"a".repeat(64)}', 'legal_entity', 'trial', now() - interval '6 years', now() - interval '6 years'),
      ('entity:${"b".repeat(64)}', 'legal_entity', 'trial', now() - interval '1 year', now() - interval '1 year');
    insert into public.ai_scan_usage (company_id, user_id, endpoint, created_at) values
      ('${C.a}', '${U.owner}', 'scan-document', now() - interval '91 days'), ('${C.a}', '${U.owner}', 'scan-document', now());
    insert into public.ai_processing_usage (company_id, user_id, endpoint, idempotency_key, content_sha256, entitlement_source, status, reserved_at, finalized_at) values
      ('${C.a}', '${U.owner}', 'scan-document', 'k${"1".repeat(20)}', '${"c".repeat(64)}', 'trial', 'succeeded', now() - interval '100 days', now() - interval '100 days'),
      ('${C.a}', '${U.owner}', 'scan-document', 'k${"2".repeat(20)}', '${"d".repeat(64)}', 'trial', 'succeeded', now(), now()),
      ('${C.a}', '${U.owner}', 'scan-document', 'k${"3".repeat(20)}', '${"e".repeat(64)}', 'trial', 'reserved', now() - interval '100 days', null);
    set session_replication_role = origin;
  `);
  const p = await run({ role: "service_role" }, "select public.esblu_purge_gdpr_technical_retention(1000) r", [], true);
  const r = p.data[0].r as Record<string, number>;
  assert.equal(r.trial_claims, 1);
  assert.equal(r.ai_scan_usage, 1);
  assert.equal(r.ai_processing_usage_pseudonymized, 1);
  const users = (await su<{ u: string; s: string }>("select user_id u, status s from public.ai_processing_usage order by reserved_at, status")).map((x) => `${x.s}:${x.u === U.owner ? "owner" : x.u}`);
  assert.deepEqual(users.sort(), ["reserved:owner", "succeeded:00000000-0000-0000-0000-000000000000", "succeeded:owner"].sort());
  assert.equal((await su("select 1 from public.ai_processing_usage")).length, 3, "kvótové záznamy sa nemažú");
});

await check("rollback J10.1 (oba súbory) je fail closed pri existujúcich dôkazoch / prijatiach", async () => {
  await assert.rejects(db.exec(read("supabase/rollback/20261111100000_clia_j10_1_dpa_electronic_evidence_rollback.sql")), /ROLLBACK_BLOCKED/);
});

await check("rollback + re-apply na čistej DB (bez dôkazov) prejde", async () => {
  await su("alter table public.legal_acceptance_evidence disable trigger all");
  await su("delete from public.legal_acceptance_evidence");
  await su("delete from public.company_dpa_acceptances where version = '1.3'");
  await su("delete from public.legal_acceptance_evidence");
  await db.exec(read("supabase/rollback/20261111110000_clia_j10_1_dpa_1_3_rollback.sql"));
  await db.exec(read("supabase/rollback/20261111100000_clia_j10_1_dpa_electronic_evidence_rollback.sql"));
  assert.equal((await su("select 1 from pg_proc where proname = 'esblu_accept_company_dpa' and pronargs = 1")).length, 1);
  assert.equal((await su("select to_regclass('public.legal_acceptance_evidence') r"))[0].r, null);
  for (const f of ["20261111100000_clia_j10_1_dpa_electronic_evidence.sql", "20261111110000_clia_j10_1_dpa_1_3.sql"]) {
    await db.exec(read(`supabase/migrations/${f}`));
    await db.exec(read(`supabase/migrations/${f}`));
  }
  assert.equal((await su("select 1 from pg_proc where proname = 'esblu_accept_company_dpa'")).length, 1);
  assert.equal((await su("select 1 from public.legal_documents where type = 'dpa' and version = '1.3'")).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
