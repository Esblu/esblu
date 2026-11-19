// =============================================================================
// Retenčný archív dokladov pri ukončení firmy (20261121100000) — PGlite, čistý
// replay všetkých migrácií. Nikdy staging/produkcia. Iba syntetické dáta.
//   - bežné ukončenie (waived aj exported) doklady NEMAŽE, presunie ich do
//     esblu_retention (bez odkazov na používateľov), XML/sken ostáva v Storage
//   - izolácia: owner/admin/employee/iný tenant/anon archív nevidia, service_role
//     iba cez operátorské funkcie, nikto nečíta tabuľky priamo
//   - každý prístup v append-only access_log
//   - purge: retention_until, iba APPROVED lehoty, legal hold, dry-run, audit
//   - výnimka syntetických dát iba s príznakom + referenciou + odôvodnením (postgres)
//   - idempotencia, rollback celku pri chybe, rollback migrácie bez straty archívu
//
//   npm run test:retention-archive-db
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
const MIGRATION = `${MIGRATIONS}/20261121100000_retention_archive_company_termination.sql`;
const ROLLBACK = "supabase/rollback/20261121100000_retention_archive_company_termination_rollback.sql";
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
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 5).join("\n       ") : String(error)}`);
  }
}

await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
const files = replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")));
assert.ok(files.includes(path.basename(MIGRATION)));
// Storage politiky / buckety: snapshot tesne pred a po retenčnej migrácii (nesmie ich meniť).
const storagePolicySnapshot = async () =>
  JSON.stringify((await db.query<Row>(`
    select 'policy' k, policyname n, cmd c, coalesce(qual, '') q, coalesce(with_check, '') w, roles::text r
      from pg_policies where schemaname = 'storage'
    union all
    select 'bucket', id, coalesce(public::text, ''), coalesce(file_size_limit::text, ''), coalesce(allowed_mime_types::text, ''), ''
      from storage.buckets
    order by 1, 2`)).rows);
let storageBefore = "";
let storageAfter = "";
for (const f of files) {
  if (f === path.basename(MIGRATION)) storageBefore = await storagePolicySnapshot();
  await db.exec(read(`${MIGRATIONS}/${f}`));
  if (f === path.basename(MIGRATION)) storageAfter = await storagePolicySnapshot();
}

type Who = { role: "authenticated" | "service_role" | "anon" | "postgres"; uid?: string; session?: string; jwt?: boolean };
type Outcome = { layer: "ok" | "privilege" | "error"; message: string; data: Row[] };
// postgres = SQL editor / priama DB rola (bez JWT); ostatné ako PostgREST (JWT claims + set role).
async function run(who: Who, sql: string, params: unknown[] = [], commit = false): Promise<Outcome> {
  await db.exec("begin");
  let ok = false;
  try {
    if (who.role !== "postgres") {
      const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.exec(`set local role ${who.role}`);
    } else if (who.jwt) {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    }
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
const count = async (sql: string, params: unknown[] = []) => Number((await su<{ n: number }>(sql, params))[0].n);

const U = {
  owner: "e5000000-0000-4000-8000-0000000000a1",
  admin: "e5000000-0000-4000-8000-0000000000a2",
  employee: "e5000000-0000-4000-8000-0000000000a4",
  ownerB: "e5000000-0000-4000-8000-0000000000b1",
  ownerS: "e5000000-0000-4000-8000-0000000000c1",
  ownerO: "e5000000-0000-4000-8000-0000000000d1",
  ownerH: "e5000000-0000-4000-8000-0000000000e1",
};
const C = {
  a: "e6000000-0000-4000-8000-00000000000a",
  b: "e6000000-0000-4000-8000-00000000000b",
  s: "e6000000-0000-4000-8000-00000000000c",
  o: "e6000000-0000-4000-8000-00000000000d",
  h: "e6000000-0000-4000-8000-00000000000e",
};
const S = {
  owner: "e7000000-0000-4000-8000-0000000000a1", admin: "e7000000-0000-4000-8000-0000000000a2",
  employee: "e7000000-0000-4000-8000-0000000000a4", ownerB: "e7000000-0000-4000-8000-0000000000b1",
};
const owner: Who = { role: "authenticated", uid: U.owner, session: S.owner };
const admin: Who = { role: "authenticated", uid: U.admin, session: S.admin };
const employee: Who = { role: "authenticated", uid: U.employee, session: S.employee };
const ownerB: Who = { role: "authenticated", uid: U.ownerB, session: S.ownerB };
const anon: Who = { role: "anon" };
const svc: Who = { role: "service_role" };
const pg: Who = { role: "postgres" };

await db.exec(`
  insert into auth.users (id, email, email_confirmed_at) values
    ('${U.owner}', 'owner@example.invalid', now()), ('${U.admin}', 'admin@example.invalid', now()),
    ('${U.employee}', 'emp@example.invalid', now()), ('${U.ownerB}', 'ownerb@example.invalid', now()),
    ('${U.ownerS}', 'owners@example.invalid', now()), ('${U.ownerO}', 'ownero@example.invalid', now()),
    ('${U.ownerH}', 'ownerh@example.invalid', now());
  insert into auth.sessions (id, user_id) values ('${S.owner}', '${U.owner}'), ('${S.admin}', '${U.admin}'),
    ('${S.employee}', '${U.employee}'), ('${S.ownerB}', '${U.ownerB}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values
    ('${C.a}', '${U.owner}', 'Firma A s.r.o.'), ('${C.b}', '${U.ownerB}', 'Firma B s.r.o.'),
    ('${C.s}', '${U.ownerS}', 'Syntetická test s.r.o.'), ('${C.o}', '${U.ownerO}', 'Stará firma s.r.o.'),
    ('${C.h}', '${U.ownerH}', 'Historicky ukončená s.r.o.');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.owner}', 'owner', 'active', '{}'), ('${C.a}', '${U.admin}', 'admin', 'active', '{}'),
    ('${C.a}', '${U.employee}', 'employee', 'active', '{}'), ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${C.s}', '${U.ownerS}', 'owner', 'active', '{}'), ('${C.o}', '${U.ownerO}', 'owner', 'active', '{}'),
    ('${C.h}', '${U.ownerH}', 'owner', 'active', '{}');
  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key)
    values ('${C.a}', 'SK', '12345678', 'SK:12345678');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, city, country_code, contact_email, iban, updated_by)
    values ('${C.a}', 'Firma A s.r.o.', '12345678', '2020202020', 'Bratislava', 'SK', 'fakturacia@example.invalid', 'SK0000000000000000000000', '${U.owner}');
  set session_replication_role = origin;
`);

// Syntetický účtovný seed: 2 finalizované doklady (+ draft), položky, strany, DPH, platba, udalosť,
// zdrojový sken prijatej faktúry, e-faktúry s XML, dôkaz doručenia, odovzdanie účtovníkovi.
const id = (tag: string, n: number) => `${tag}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function seedFinance(c: string, tag: string, issue: string, owner: string) {
  await db.exec(`
    set session_replication_role = replica;
    insert into public.documents (id, company_id, user_id, storage_bucket, storage_path, document_type, ai_raw_output, extracted_fields)
      values ('${id(tag, 21)}', '${c}', '${owner}', 'ai-inbox-documents', '${c}/scan-${tag}.pdf', 'invoice', '{"raw":"x"}', '{"total":123}'),
             ('${id(tag, 22)}', '${c}', '${owner}', 'ai-inbox-documents', '${c}/photo-${tag}.jpg', 'other', null, null);
    insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, created_by, finalized_by)
      values ('${id(tag, 1)}', '${c}', 'issued', 'regular_invoice', 'finalized', now(), 'FA-${tag}-1', '${issue}', '${owner}', '${owner}');
    insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, source_document_id, supplier_invoice_number, supplier_business_partner_id, created_by)
      values ('${id(tag, 2)}', '${c}', 'received', 'regular_invoice', 'finalized', now(), null, '${issue}', '${id(tag, 21)}', 'DOD-${tag}', '${id(tag, 41)}', '${owner}');
    insert into public.invoices (id, company_id, direction, kind, document_status, invoice_number)
      values ('${id(tag, 3)}', '${c}', 'issued', 'regular_invoice', 'draft', null);
    insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code)
      values ('${id(tag, 1)}', 1, 'Služba', 1, 100, 'S'), ('${id(tag, 3)}', 1, 'Koncept', 1, 1, 'S');
    insert into public.invoice_parties (invoice_id, role, legal_name, ico)
      values ('${id(tag, 1)}', 'buyer', 'Odberateľ s.r.o.', '87654321'), ('${id(tag, 1)}', 'seller', 'Firma ${tag}', '12345678');
    insert into public.invoice_tax_breakdowns (invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount)
      values ('${id(tag, 1)}', 'S', 23, 100, 23);
    insert into public.invoice_events (invoice_id, event_type, actor_user_id) values ('${id(tag, 1)}', 'finalized', '${owner}');
    insert into public.invoice_payments (invoice_id, paid_amount, recorded_by) values ('${id(tag, 1)}', 50, '${owner}');
    insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_storage_path, ubl_sha256, requested_by)
      values ('${id(tag, 11)}', '${c}', '${id(tag, 1)}', 'efaktura_sk', 'sandbox', 1, 'idem-key-${tag}-0000000000', '${c}/out-${tag}.xml', '${"a".repeat(64)}', '${owner}');
    insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, issue_date)
      values ('${id(tag, 12)}', '${c}', 'efaktura_sk', 'sandbox', 'r-${tag}', '${c}/in-${tag}.xml', '${"b".repeat(64)}', '${issue}');
    insert into public.einvoice_events (company_id, outbound_id, to_state, source) values ('${c}', '${id(tag, 11)}', 'delivered', 'provider');
    insert into public.accounting_handoff_exports (id, company_id, created_by, invoice_count, manifest_sha256, note)
      values ('${id(tag, 31)}', '${c}', '${owner}', 1, '${"c".repeat(64)}', 'pre účtovníčku');
    insert into public.accounting_handoff_export_items (export_id, invoice_id, company_id)
      values ('${id(tag, 31)}', '${id(tag, 1)}', '${c}');
    set session_replication_role = origin;
  `);
}
await seedFinance(C.a, "a", "2026-03-15", U.owner);
await seedFinance(C.b, "b", "2026-03-15", U.ownerB);
await seedFinance(C.s, "c", "2026-09-16", U.ownerS);
// Stará firma: iba doklady z roku 2014 (lehota 10 r. po roku → 2024-12-31 uplynula), bez e-faktúr.
await db.exec(`
  set session_replication_role = replica;
  insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date)
    values ('${id("d", 1)}', '${C.o}', 'issued', 'regular_invoice', 'finalized', '2014-03-01', 'FA-2014-1', '2014-03-01');
  insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code)
    values ('${id("d", 1)}', 1, 'Stará služba', 1, 10, 'S');
  set session_replication_role = origin;
`);
// Historicky ukončená firma: dokončený riadok company_terminations zo starého workflow (bez termination_mode,
// ako 5 syntetických firiem vyčistených v produkcii 2026-11-19), firma + doklad v DB stále existujú.
await db.exec(`
  set session_replication_role = replica;
  insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date)
    values ('${id("e", 1)}', '${C.h}', 'issued', 'regular_invoice', 'finalized', '2026-10-01', 'FA-H-1', '2026-10-01');
  insert into public.company_terminations (id, company_id, requested_by, status, export_mode, completed_at)
    values ('${id("e", 9)}', '${C.h}', '${U.ownerH}', 'completed', 'waived', '2026-11-19T10:00:00Z');
  set session_replication_role = origin;
`);

const commitSql = "select public.esblu_company_termination_commit($1, $2, false, $3) r";
const syntheticSql = "select public.esblu_company_termination_synthetic_purge($1, $2, false, 'waived', $3, $4, $5) r";
const REF = "OPS-2026-11-19-synthetic-cleanup";
const JUST = "Syntetické testovacie dáta z vývoja (nie účtovné doklady) — schválené prevádzkovateľom 2026-11-19.";
const archiveOf = async (c: string) =>
  (await su<{ id: string }>(`select id from esblu_retention.archived_companies where source_company_id = $1`, [c]))[0]?.id;

await check("schéma: esblu_retention nie je pre anon/authenticated (USAGE), tabuľky nemajú grant ani pre service_role", async () => {
  const r = await su<Row>(`select has_schema_privilege('anon', 'esblu_retention', 'USAGE') a, has_schema_privilege('authenticated', 'esblu_retention', 'USAGE') u,
    has_schema_privilege('service_role', 'esblu_retention', 'USAGE') s`);
  assert.deepEqual(r[0], { a: false, u: false, s: true });
  const t = await su<{ t: string; g: string }>(`
    select c.relname t, r.rolname g from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    where n.nspname = 'esblu_retention' and c.relkind = 'r'
      and (has_table_privilege(r.rolname, c.oid, 'SELECT') or has_table_privilege(r.rolname, c.oid, 'INSERT')
        or has_table_privilege(r.rolname, c.oid, 'UPDATE') or has_table_privilege(r.rolname, c.oid, 'DELETE'))`);
  assert.deepEqual(t, []);
  const f = await su<{ f: string; g: string }>(`
    select p.proname f, r.rolname g from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    where n.nspname = 'esblu_retention' and has_function_privilege(r.rolname, p.oid, 'EXECUTE') order by 1, 2`);
  assert.deepEqual(f.map((x) => `${x.f}:${x.g}`), [
    "export_archive:service_role", "operator_list_archives:service_role", "purge_expired:service_role", "set_legal_hold:service_role",
  ]);
  const seeded = await su<{ s: string }>(`select distinct approval_status s from esblu_retention.retention_periods`);
  assert.deepEqual(seeded.map((x) => x.s), ["PROPOSED"], "lehoty sú iba návrh");
});

let archiveA = "";
let terminationA = "";
await check("bežné ukončenie (waived): doklady NEZMAZANÉ — presunuté do archívu, osobné údaje mimo dokladu zmazané", async () => {
  const o = await run(svc, commitSql, [U.owner, C.a, "waived"], true);
  assert.equal(o.layer, "ok", o.message);
  const r = o.data[0].r as Record<string, unknown>;
  archiveA = String(r.archive_id);
  terminationA = String(r.termination_id);
  assert.equal(r.termination_mode, "archive");
  assert.equal(await count(`select count(*)::int n from public.companies where id = $1`, [C.a]), 0, "firma zrušená");
  assert.equal(await count(`select count(*)::int n from public.invoices where company_id = $1`, [C.a]), 0);
  assert.equal(await count(`select count(*)::int n from public.documents where company_id = $1`, [C.a]), 0);
  const rows = await su<{ k: string; n: number }>(
    `select category || ':' || source_table k, count(*)::int n from esblu_retention.archived_records where archive_id = $1 group by 1 order by 1`, [archiveA]);
  assert.deepEqual(Object.fromEntries(rows.map((x) => [x.k, x.n])), {
    "accounting_document:invoices": 2, "accounting_document:invoice_items": 1, "accounting_document:invoice_parties": 2,
    "accounting_document:invoice_tax_breakdowns": 1, "accounting_document:invoice_events": 1, "accounting_document:invoice_payments": 1,
    "accounting_document_source:documents": 1, "einvoice_document:einvoice_outbound": 1, "einvoice_document:einvoice_inbound": 1,
    "einvoice_delivery_evidence:einvoice_events": 1, "accounting_handoff:accounting_handoff_exports": 1,
    "accounting_handoff:accounting_handoff_export_items": 1,
  });
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records where payload->>'id' = $1`, [id("a", 3)]), 0, "koncept sa nearchivuje");
  // Storage: XML a sken prijatej faktúry ostávajú, maže sa iba neúčtovná fotka.
  const targets = (r.storage_targets as Array<{ bucket: string; path: string }>).map((t) => `${t.bucket}:${t.path}`);
  assert.deepEqual(targets, [`ai-inbox-documents:${C.a}/photo-a.jpg`]);
  const kept = await su<{ o: string }>(`select distinct (x->>'bucket') || ':' || (x->>'path') o from esblu_retention.archived_records r,
    jsonb_array_elements(r.storage_objects) x where r.archive_id = $1 order by 1`, [archiveA]);
  assert.deepEqual(kept.map((x) => x.o), [`ai-inbox-documents:${C.a}/scan-a.pdf`, `einvoice-documents:${C.a}/in-a.xml`, `einvoice-documents:${C.a}/out-a.xml`]);
  const job = await su<{ c: number; s: string }>(`select storage_target_count c, storage_status s from public.account_deletion_cleanup_jobs where id = $1`, [r.job_id]);
  assert.deepEqual(job[0], { c: 1, s: "pending" });
  const t = await su<Row>(`select termination_mode, archive_id, archived_counts, export_mode from public.company_terminations where id = $1`, [terminationA]);
  assert.equal(t[0].termination_mode, "archive");
  assert.equal(t[0].archive_id, archiveA);
  assert.equal((t[0].archived_counts as Record<string, number>).accounting_document, 8);
});

await check("minimalizácia: archív bez väzby na používateľov (žiadne user ID, AI výstup, e-mail, IBAN firmy), SHA-256 sedí", async () => {
  const all = await su<{ p: string; sha: string; calc: string }>(`select payload::text p, payload_sha256 sha,
    encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') calc from esblu_retention.archived_records where archive_id = $1`, [archiveA]);
  for (const row of all) {
    assert.equal(row.sha, row.calc);
    for (const u of Object.values(U)) assert.ok(!row.p.includes(u), "user id v payloade");
    for (const bad of ['"created_by"', '"finalized_by"', '"recorded_by"', '"actor_user_id"', '"requested_by"', '"user_id"', '"ai_raw_output"', '"extracted_fields"'])
      assert.ok(!row.p.includes(bad), bad);
  }
  const snap = (await su<{ s: string }>(`select company_snapshot::text s from esblu_retention.archived_companies where id = $1`, [archiveA]))[0].s;
  for (const bad of [U.owner, "fakturacia@example.invalid", "SK0000000000000000000000", "owner_id"]) assert.ok(!snap.includes(bad), bad);
  assert.ok(snap.includes("12345678") && snap.includes("Firma A s.r.o."), "identita firmy na dokladoch ostáva");
  // FK na auth.users ani companies archív nemá → výmaz používateľa ho nezablokuje ani nezmaže
  const fk = await count(`select count(*)::int n from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'esblu_retention' and k.contype = 'f' and k.confrelid in ('auth.users'::regclass, 'public.companies'::regclass)`);
  assert.equal(fk, 0);
});

await check("izolácia: owner/admin/employee firmy A, owner firmy B, anon archív nečítajú (tabuľky ani funkcie)", async () => {
  for (const w of [owner, admin, employee, ownerB, anon]) {
    for (const sql of [
      "select * from esblu_retention.archived_records",
      "select * from esblu_retention.archived_companies",
      "select * from esblu_retention.access_log",
      `select esblu_retention.export_archive('${archiveA}', 'TICKET-123456', 'žiadosť daňového úradu')`,
      "select * from esblu_retention.operator_list_archives('TICKET-123456', 'žiadosť daňového úradu')",
      "select esblu_retention.purge_expired('TICKET-123456', false)",
      `select public.esblu_company_termination_synthetic_purge('${U.ownerB}', '${C.b}', false, 'waived', true, '${REF}', '${JUST}')`,
    ]) {
      const o = await run(w, sql);
      assert.equal(o.layer, "privilege", `${w.role}/${w.uid ?? ""}: ${sql.slice(0, 50)} → ${o.message}`);
    }
  }
  // ani service_role nečíta tabuľky priamo (iba cez logované funkcie)
  for (const sql of ["select * from esblu_retention.archived_records", "delete from esblu_retention.access_log", "insert into esblu_retention.access_log (action) values ('list')"]) {
    assert.equal((await run(svc, sql)).layer, "privilege", sql);
  }
  // firma B nedotknutá
  assert.equal(await count(`select count(*)::int n from public.invoices where company_id = $1`, [C.b]), 3);
  assert.equal(await archiveOf(C.b), undefined);
});

await check("prístup operátora (service_role) cez funkcie → každé čítanie/export v access_log; bez referencie/účelu odmietnuté", async () => {
  const before = await count("select count(*)::int n from esblu_retention.access_log");
  const l = await run(svc, "select * from esblu_retention.operator_list_archives('TICKET-2026-0001', 'kontrola archívu operátorom')", [], true);
  assert.equal(l.layer, "ok", l.message);
  assert.equal(l.data.length, 1);
  const e = await run(svc, "select esblu_retention.export_archive($1, 'TICKET-2026-0002', 'žiadosť účtovníčky bývalého zákazníka') x", [archiveA], true);
  assert.equal(e.layer, "ok", e.message);
  const x = e.data[0].x as { company: Record<string, unknown>; records: Record<string, unknown[]>; schema: string };
  assert.equal(x.schema, "esblu.retention_archive_export.v1");
  assert.equal(x.records.accounting_document.length, 8);
  assert.equal(x.records.einvoice_document.length, 2);
  const log = await su<{ action: string; operator_ref: string; invoker_role: string; archive_id: string | null }>(
    `select action, operator_ref, invoker_role, archive_id from esblu_retention.access_log order by id desc limit 2`);
  assert.deepEqual(log.map((r) => `${r.action}|${r.operator_ref}|${r.invoker_role}`), ["export|TICKET-2026-0002|service_role", "list|TICKET-2026-0001|service_role"]);
  assert.equal(log[0].archive_id, archiveA);
  assert.equal(await count("select count(*)::int n from esblu_retention.access_log"), before + 2);
  for (const sql of [
    "select esblu_retention.export_archive($1, null, 'žiadosť účtovníčky')",
    "select esblu_retention.export_archive($1, 'x', 'žiadosť účtovníčky')",
    "select esblu_retention.export_archive($1, 'TICKET-2026-0003', 'krátko')",
  ]) {
    const o = await run(svc, sql, [archiveA]);
    assert.match(o.message, /ESBLU_RETENTION_(OPERATOR_REF|PURPOSE)_REQUIRED/, sql);
  }
  const created = await count(`select count(*)::int n from esblu_retention.access_log where action = 'archive_created' and archive_id = $1`, [archiveA]);
  assert.equal(created, 1);
});

await check("append-only: access_log / purge_runs a archív nemeniteľné ani pre postgres; podvrhnuté GUC purge nič neodomkne", async () => {
  for (const sql of [
    "update esblu_retention.access_log set operator_ref = 'X'",
    "delete from esblu_retention.access_log",
    "truncate esblu_retention.access_log",
    "truncate esblu_retention.archived_records",
    `delete from esblu_retention.archived_records where archive_id = '${archiveA}'`,
    `update esblu_retention.archived_records set payload = '{}'::jsonb where archive_id = '${archiveA}'`,
    `delete from esblu_retention.archived_companies where id = '${archiveA}'`,
    `update esblu_retention.archived_companies set company_snapshot = '{}'::jsonb where id = '${archiveA}'`,
  ]) {
    const o = await run(pg, sql);
    assert.match(o.message, /ESBLU_RETENTION_(LOG_APPEND_ONLY|ARCHIVE_IMMUTABLE)/, sql);
  }
  await db.exec("begin");
  try {
    await db.query("select set_config('esblu.retention_purge_run', 'f0000000-0000-4000-8000-000000000000', true)");
    await assert.rejects(db.query(`delete from esblu_retention.archived_records where archive_id = '${archiveA}'`), /ESBLU_RETENTION_ARCHIVE_IMMUTABLE/);
  } finally {
    await db.exec("rollback");
  }
});

await check("idempotencia: opakované ukončenie → already_completed + rovnaký archív; opakovaná archivácia bez duplicít", async () => {
  const n = await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveA]);
  const o = await run(svc, commitSql, [U.owner, C.a, "waived"], true);
  const r = o.data[0].r as Record<string, unknown>;
  assert.equal(r.already_completed, true);
  assert.equal(r.archive_id, archiveA);
  assert.equal(r.termination_mode, "archive");
  const again = await run(pg, "select esblu_retention.archive_company_documents($1, $2) x", [C.a, terminationA]);
  assert.equal(again.layer, "ok", again.message);
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_companies where source_company_id = $1`, [C.a]), 1);
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveA]), n);
});

await check("zlyhanie uprostred → rollback celku vrátane archívu (žiadny archív bez výmazu ani výmaz bez archívu)", async () => {
  await db.exec(`
    create function public.test_fail_company_delete() returns trigger language plpgsql as $f$ begin raise exception 'TEST_INJECTED_FAILURE'; end $f$;
    create trigger test_fail_company_delete before delete on public.companies for each row execute function public.test_fail_company_delete();`);
  const o = await run(svc, commitSql, [U.ownerB, C.b, "waived"], true);
  await db.exec("drop trigger test_fail_company_delete on public.companies; drop function public.test_fail_company_delete();");
  assert.match(o.message, /TEST_INJECTED_FAILURE/);
  assert.equal(await archiveOf(C.b), undefined);
  assert.equal(await count(`select count(*)::int n from public.invoices where company_id = $1`, [C.b]), 3);
  assert.equal(await count(`select count(*)::int n from esblu_retention.access_log where source_company_id = $1`, [C.b]), 0);
});

await check("bežné zrušenie firmy s dokladmi (esblu_account_deletion_commit) ostáva blokované", async () => {
  const o = await run(svc, `select public.esblu_account_deletion_commit('owner', $1, $2, false)`, [U.ownerB, C.b]);
  assert.match(o.message, /ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION/);
});

await check("výnimka syntetických dát: bez príznaku / referencie / odôvodnenia / z Data API (JWT) / service_role → odmietnuté, nič sa nezmaže", async () => {
  const cases: Array<[Who, unknown[], RegExp]> = [
    [pg, [U.ownerS, C.s, false, REF, JUST], /ESBLU_SYNTHETIC_PURGE_FLAG_REQUIRED/],
    [pg, [U.ownerS, C.s, null, REF, JUST], /ESBLU_SYNTHETIC_PURGE_FLAG_REQUIRED/],
    [pg, [U.ownerS, C.s, true, null, JUST], /ESBLU_SYNTHETIC_PURGE_REFERENCE_REQUIRED/],
    [pg, [U.ownerS, C.s, true, "x", JUST], /ESBLU_SYNTHETIC_PURGE_REFERENCE_REQUIRED/],
    [pg, [U.ownerS, C.s, true, REF, "test"], /ESBLU_SYNTHETIC_PURGE_JUSTIFICATION_REQUIRED/],
    [{ role: "postgres", jwt: true }, [U.ownerS, C.s, true, REF, JUST], /ESBLU_OPERATOR_ONLY/],
    [svc, [U.ownerS, C.s, true, REF, JUST], /permission denied/],
    [pg, [U.owner, C.s, true, REF, JUST], /ESBLU_NOT_ACTIVE_OWNER/],
  ];
  for (const [w, params, re] of cases) {
    const o = await run(w, syntheticSql, params);
    assert.match(o.message, re, JSON.stringify(params));
  }
  assert.equal(await count(`select count(*)::int n from public.invoices where company_id = $1`, [C.s]), 3);
  assert.equal(await count(`select count(*)::int n from public.company_terminations where company_id = $1`, [C.s]), 0);
});

await check("výnimka syntetických dát: s príznakom + referenciou + odôvodnením (postgres) → výmaz bez archívu, auditované", async () => {
  const o = await run(pg, syntheticSql, [U.ownerS, C.s, true, REF, JUST], true);
  assert.equal(o.layer, "ok", o.message);
  const r = o.data[0].r as Record<string, unknown>;
  assert.equal(r.termination_mode, "synthetic_test_data_purge");
  assert.equal(r.archive_id, null);
  assert.equal(await archiveOf(C.s), undefined);
  assert.equal(await count(`select count(*)::int n from public.companies where id = $1`, [C.s]), 0);
  const targets = (r.storage_targets as Array<{ bucket: string; path: string }>).map((t) => `${t.bucket}:${t.path}`).sort();
  assert.deepEqual(targets, [`ai-inbox-documents:${C.s}/photo-c.jpg`, `ai-inbox-documents:${C.s}/scan-c.pdf`,
    `einvoice-documents:${C.s}/in-c.xml`, `einvoice-documents:${C.s}/out-c.xml`]);
  const t = await su<Row>(`select termination_mode, operator_reference, justification, export_mode, status from public.company_terminations where company_id = $1`, [C.s]);
  assert.deepEqual(t[0], { termination_mode: "synthetic_test_data_purge", operator_reference: REF, justification: JUST, export_mode: "waived", status: "completed" });
  const log = await su<Row>(`select action, operator_ref, db_session_user from esblu_retention.access_log where source_company_id = $1`, [C.s]);
  assert.deepEqual(log, [{ action: "synthetic_test_data_purge", operator_ref: REF, db_session_user: "postgres" }]);
  // bežná cesta (4-arg, service_role) výnimku nepozná — vždy archive (overené vyššie pre firmu A)
});

await check("guard: opakovaný synthetic purge tej istej firmy → already_completed, žiadny druhý výmaz, pokus v access_log", async () => {
  const termsBefore = await count(`select count(*)::int n from public.company_terminations where company_id = $1`, [C.s]);
  const jobsBefore = await count("select count(*)::int n from public.account_deletion_cleanup_jobs");
  for (const user of [U.ownerS, U.owner]) {
    const o = await run(pg, syntheticSql, [user, C.s, true, "OPS-2026-11-20-rerun", JUST], true);
    assert.equal(o.layer, "ok", o.message);
    const r = o.data[0].r as Record<string, unknown>;
    assert.equal(r.already_completed, true, `žiadateľ ${user}`);
    assert.equal(r.skipped, true);
    assert.equal(r.termination_mode, "synthetic_test_data_purge");
    assert.deepEqual(r.storage_targets, [], "žiadne nové Storage ciele");
  }
  assert.equal(await count(`select count(*)::int n from public.company_terminations where company_id = $1`, [C.s]), termsBefore);
  assert.equal(await count("select count(*)::int n from public.account_deletion_cleanup_jobs"), jobsBefore, "žiadny nový cleanup job");
  const log = await su<Row>(`select action, operator_ref from esblu_retention.access_log where source_company_id = $1 order by id`, [C.s]);
  assert.deepEqual(log.map((x) => `${x.action}|${x.operator_ref}`), [
    `synthetic_test_data_purge|${REF}`, "synthetic_test_data_purge_skipped|OPS-2026-11-20-rerun", "synthetic_test_data_purge_skipped|OPS-2026-11-20-rerun",
  ]);
  // validácia (príznak / referencia / odôvodnenie) a JWT zákaz platia aj pre už ukončenú firmu
  assert.match((await run(pg, syntheticSql, [U.ownerS, C.s, false, REF, JUST])).message, /ESBLU_SYNTHETIC_PURGE_FLAG_REQUIRED/);
  assert.match((await run({ role: "postgres", jwt: true }, syntheticSql, [U.ownerS, C.s, true, REF, JUST])).message, /ESBLU_OPERATOR_ONLY/);
});

await check("guard: historický dokončený riadok (bez termination_mode) aj archivovaná firma → synthetic purge nič nezmaže", async () => {
  const h = await run(pg, syntheticSql, [U.ownerH, C.h, true, REF, JUST], true);
  assert.equal(h.layer, "ok", h.message);
  const hr = h.data[0].r as Record<string, unknown>;
  assert.equal(hr.already_completed, true);
  assert.equal(hr.termination_id, id("e", 9));
  assert.equal(hr.termination_mode, null);
  assert.equal(await count(`select count(*)::int n from public.companies where id = $1`, [C.h]), 1, "firma nedotknutá");
  assert.equal(await count(`select count(*)::int n from public.invoices where company_id = $1`, [C.h]), 1, "doklad nedotknutý");
  assert.equal(await count(`select count(*)::int n from public.company_terminations where company_id = $1`, [C.h]), 1);
  // firma A bola ukončená režimom archive → výnimka ju nepurguje a archív ostáva celý
  const nA = await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveA]);
  const a = await run(pg, syntheticSql, [U.owner, C.a, true, REF, JUST], true);
  assert.equal(a.layer, "ok", a.message);
  const ar = a.data[0].r as Record<string, unknown>;
  assert.equal(ar.already_completed, true);
  assert.equal(ar.archive_id, archiveA);
  assert.equal(ar.termination_mode, "archive");
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveA]), nA);
  const skipped = await su<Row>(`select source_company_id c, archive_id a, details->>'reason' r from esblu_retention.access_log
    where action = 'synthetic_test_data_purge_skipped' and source_company_id in ($1, $2) order by id`, [C.h, C.a]);
  assert.deepEqual(skipped, [{ c: C.h, a: null, r: "already_completed" }, { c: C.a, a: archiveA, r: "already_completed" }]);
});

await check("Storage: retenčná migrácia nemení storage politiky ani buckety; ponechané XML/sken firmy A nečíta nikto z tenantov", async () => {
  assert.ok(storageBefore.length > 2, "snapshot existuje");
  assert.equal(storageAfter, storageBefore, "storage.objects politiky / buckety pred = po migrácii");
  const mig = read(MIGRATION);
  assert.doesNotMatch(mig, /(create|alter|drop)\s+policy[^;]*on\s+storage\./i);
  assert.doesNotMatch(mig, /(insert\s+into|update|delete\s+from)\s+storage\.(buckets|objects)/i);
  await db.exec(`
    insert into storage.buckets (id, name, public) values ('einvoice-documents', 'einvoice-documents', false), ('ai-inbox-documents', 'ai-inbox-documents', false)
      on conflict (id) do nothing;
    insert into storage.objects (bucket_id, name, owner) values
      ('einvoice-documents', '${C.a}/out-a.xml', null), ('einvoice-documents', '${C.a}/in-a.xml', null),
      ('ai-inbox-documents', '${C.a}/scan-a.pdf', '${U.owner}');`);
  for (const w of [owner, admin, employee, ownerB, anon]) {
    const o = await run(w, `select bucket_id, name from storage.objects where name like $1`, [`${C.a}/%`]);
    assert.ok(o.layer === "privilege" || (o.layer === "ok" && o.data.length === 0), `${w.role}/${w.uid ?? ""}: ${JSON.stringify(o.data)} ${o.message}`);
  }
});

let archiveO = "";
await check("purge dry-run: PROPOSED lehoty sa nemažú (skipped_unapproved), nič sa nezmaže, beh je auditovaný", async () => {
  const o = await run(svc, commitSql, [U.ownerO, C.o, "waived"], true);
  assert.equal(o.layer, "ok", o.message);
  archiveO = String((o.data[0].r as Record<string, unknown>).archive_id);
  const ru = await su<{ d: string }>(`select distinct retention_until::text d from esblu_retention.archived_records where archive_id = $1`, [archiveO]);
  assert.deepEqual(ru.map((x) => x.d), ["2024-12-31"], "10 r. po roku 2014");
  const total = await count("select count(*)::int n from esblu_retention.archived_records");
  const d = await run(svc, "select esblu_retention.purge_expired('PURGE-2026-0001') x", [], true);
  assert.equal(d.layer, "ok", d.message);
  const x = d.data[0].x as Record<string, number | boolean>;
  assert.equal(x.dry_run, true);
  assert.equal(x.eligible, 0);
  assert.equal(x.skipped_unapproved_period, 2);
  assert.equal(await count("select count(*)::int n from esblu_retention.archived_records"), total);
  const live = await run(svc, "select esblu_retention.purge_expired('PURGE-2026-0002', false) x", [], true);
  assert.equal((live.data[0].x as Record<string, number>).purged, 0, "neschválená lehota = nič");
  assert.equal(await count("select count(*)::int n from esblu_retention.purge_runs where status = 'completed'"), 2);
  assert.equal(await count("select count(*)::int n from esblu_retention.purge_runs where status = 'executing'"), 0);
});

await check("schválenie lehoty: iba postgres (nie service_role / JWT), logované, prepočíta retention_until", async () => {
  const s = await run(svc, "select esblu_retention.approve_retention_period('accounting_document', 10, 'OPERATOR-2026-11', 'schválené po porade s CLIA')");
  assert.equal(s.layer, "privilege");
  const j = await run({ role: "postgres", jwt: true }, "select esblu_retention.approve_retention_period('accounting_document', 10, 'OPERATOR-2026-11', 'schválené po porade s CLIA')");
  assert.match(j.message, /ESBLU_OPERATOR_ONLY/);
  const o = await run(pg, "select esblu_retention.approve_retention_period('accounting_document', 10, 'OPERATOR-2026-11', 'TEST — schválené v teste, nie právne rozhodnutie') x", [], true);
  assert.equal(o.layer, "ok", o.message);
  assert.equal(await count("select count(*)::int n from esblu_retention.retention_periods where approval_status = 'APPROVED'"), 1);
  assert.equal(await count("select count(*)::int n from esblu_retention.access_log where action = 'retention_period_approved'"), 1);
});

await check("legal hold blokuje purge; dry-run k budúcemu dátumu áno, ostrý beh k budúcemu dátumu nie", async () => {
  const h = await run(svc, "select esblu_retention.set_legal_hold($1, true, 'kontrola daňového úradu 2026', 'HOLD-2026-0001') x", [archiveO], true);
  assert.equal(h.layer, "ok", h.message);
  const p = await run(svc, "select esblu_retention.purge_expired('PURGE-2026-0003', false) x", [], true);
  const x = p.data[0].x as Record<string, number>;
  assert.equal(x.purged, 0);
  assert.equal(x.skipped_legal_hold, 2);
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveO]), 2);
  const fut = await run(svc, "select esblu_retention.purge_expired('PURGE-2026-0004', false, '2040-01-01') x");
  assert.match(fut.message, /ESBLU_RETENTION_PURGE_FUTURE_DATE/);
  const dry = await run(svc, "select esblu_retention.purge_expired('PURGE-2026-0005', true, '2040-01-01') x", [], true);
  const dx = dry.data[0].x as Record<string, number>;
  assert.equal(dx.eligible, 8, "2037-12-31 (firma A, 2026) < 2040 → 8 záznamov accounting_document firmy A");
  assert.equal(await count("select count(*)::int n from esblu_retention.access_log where action in ('legal_hold_set', 'purge', 'purge_dry_run')"), 5);
});

await check("purge: po zrušení legal hold maže IBA záznamy po retention_until; firma s 0 záznamami → minimalizovaný snapshot", async () => {
  const nA = await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveA]);
  await run(svc, "select esblu_retention.set_legal_hold($1, false, 'kontrola ukončená bez nálezu', 'HOLD-2026-0001') x", [archiveO], true);
  const p = await run(svc, "select esblu_retention.purge_expired('PURGE-2026-0006', false) x", [], true);
  assert.equal(p.layer, "ok", p.message);
  const x = p.data[0].x as Record<string, unknown>;
  assert.equal(x.purged, 2);
  assert.deepEqual(x.by_category, { accounting_document: 2 });
  assert.equal(x.archives_closed, 1);
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveO]), 0);
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records where archive_id = $1`, [archiveA]), nA, "firma A (2026) nedotknutá");
  const a = await su<{ status: string; s: Record<string, unknown> }>(`select status, company_snapshot s from esblu_retention.archived_companies where id = $1`, [archiveO]);
  assert.equal(a[0].status, "purged");
  assert.deepEqual(Object.keys(a[0].s).sort(), ["country_code", "purged"]);
  const run6 = await su<{ result: Record<string, unknown>; dry_run: boolean }>(`select result, dry_run from esblu_retention.purge_runs where operator_ref = 'PURGE-2026-0006'`);
  assert.equal(run6[0].dry_run, false);
  assert.equal(run6[0].result.purged, 2);
  const again = await run(svc, "select esblu_retention.purge_expired('PURGE-2026-0007', false) x", [], true);
  assert.equal((again.data[0].x as Record<string, number>).purged, 0, "idempotentné");
});

await check("rollback migrácie: archív, logy a audit ostávajú; purge a výnimka zaniknú; čítanie archívu funguje; re-apply idempotentný", async () => {
  const snap = async () => ({
    rec: await count("select count(*)::int n from esblu_retention.archived_records"),
    comp: await count("select count(*)::int n from esblu_retention.archived_companies"),
    log: await count("select count(*)::int n from esblu_retention.access_log"),
    runs: await count("select count(*)::int n from esblu_retention.purge_runs"),
    term: await count("select count(*)::int n from public.company_terminations where termination_mode is not null"),
  });
  const before = await snap();
  await db.exec(read(ROLLBACK));
  assert.deepEqual(await snap(), before, "rollback nič nezmazal");
  for (const f of ["esblu_company_termination_synthetic_purge", "purge_expired", "termination_execute", "archive_company_documents"])
    assert.equal(await count("select count(*)::int n from pg_proc where proname = $1", [f]), 0, f);
  assert.equal(await count("select count(*)::int n from pg_proc where proname = 'esblu_company_termination_commit'"), 1);
  const e = await run(svc, "select esblu_retention.export_archive($1, 'TICKET-2026-0009', 'overenie po rollbacku') x", [archiveA]);
  assert.equal(e.layer, "ok", e.message);
  assert.match(String((await run(pg, `delete from esblu_retention.archived_records where archive_id = '${archiveA}'`)).message), /ESBLU_RETENTION_ARCHIVE_IMMUTABLE/);
  await db.exec(read(MIGRATION));
  await db.exec(read(MIGRATION));
  const after = await snap();
  assert.equal(after.rec, before.rec);
  assert.equal(after.comp, before.comp);
  assert.equal(await count("select count(*)::int n from esblu_retention.retention_periods where approval_status = 'APPROVED'"), 1, "schválenie prežije re-apply");
  // po re-apply bežné ukončenie znova archivuje (firma B)
  const o = await run(svc, commitSql, [U.ownerB, C.b, "waived"], true);
  assert.equal(o.layer, "ok", o.message);
  assert.ok((o.data[0].r as Record<string, unknown>).archive_id);
  assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records r join esblu_retention.archived_companies a on a.id = r.archive_id where a.source_company_id = $1`, [C.b]), 14, "rovnaký rozsah ako firma A");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
