// =============================================================================
// Company termination workflow (VOP 1.2 čl. 20.6 / DPA) — PGlite, čistý replay
// všetkých migrácií. Nikdy staging/produkcia.
//   - mimo workflow sú finalizované doklady chránené (aj service_role, aj
//     podvrhnuté GUC nastavenie)
//   - owner-only, potvrdenie exportu, registrácia u providera = stop
//   - zlyhanie uprostred → rollback celku (žiadny partial delete)
//   - úspech → firma A celá preč, firma B nedotknutá, cleanup job so Storage
//     cieľmi (vrátane XML e-faktúr), auditný záznam bez obsahu
//   - opakované / dvojité spustenie → already_completed
//   - rollback migrácie + re-apply
//
//   npm run test:company-termination-db
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
assert.ok(files.includes("20261112110000_company_termination_workflow.sql"));
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


const svc: Who = { role: "service_role" };
// Viac príkazov v jednej transakcii ako service_role (napr. set_config + DELETE); vždy rollback.
async function svcExec(sql: string): Promise<string> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await db.exec("set local role service_role");
    await db.exec(sql);
    return "ok";
  } catch (error) {
    return (error as { message?: string }).message ?? String(error);
  } finally {
    await db.exec("rollback");
  }
}
const commitSql = "select public.esblu_company_termination_commit($1, $2, false, $3) r";
const count = async (sql: string) => Number((await su<{ n: number }>(sql))[0].n);
const companyRows = async (c: string) => ({
  invoices: await count(`select count(*)::int n from public.invoices where company_id = '${c}'`),
  items: await count(`select count(*)::int n from public.invoice_items i join public.invoices v on v.id = i.invoice_id where v.company_id = '${c}'`),
  einvoice: await count(`select (select count(*) from public.einvoice_inbound where company_id = '${c}') + (select count(*) from public.einvoice_outbound where company_id = '${c}') + (select count(*) from public.einvoice_events where company_id = '${c}') n`),
  documents: await count(`select count(*)::int n from public.documents where company_id = '${c}'`),
  vehicles: await count(`select count(*)::int n from public.vehicles where company_id = '${c}'`),
  company: await count(`select count(*)::int n from public.companies where id = '${c}'`),
});

async function seedFinance(c: string, tag: string) {
  await db.exec(`
    set session_replication_role = replica;
    insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number)
      values ('${tag}0000000-0000-4000-8000-000000000001', '${c}', 'issued', 'regular_invoice', 'finalized', now(), '2026-${tag}-1');
    insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, corrects_invoice_id)
      values ('${tag}0000000-0000-4000-8000-000000000002', '${c}', 'issued', 'credit_note', 'finalized', now(), '2026-${tag}-2', '${tag}0000000-0000-4000-8000-000000000001');
    insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code)
      values ('${tag}0000000-0000-4000-8000-000000000001', 1, 'Služba', 1, 100, 'S');
    insert into public.invoice_parties (invoice_id, role, legal_name)
      values ('${tag}0000000-0000-4000-8000-000000000001', 'buyer', 'Odberateľ');
    insert into public.invoice_tax_breakdowns (invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount)
      values ('${tag}0000000-0000-4000-8000-000000000001', 'S', 23, 100, 23);
    insert into public.invoice_events (invoice_id, event_type) values ('${tag}0000000-0000-4000-8000-000000000001', 'finalized');
    insert into public.invoice_payments (invoice_id, paid_amount) values ('${tag}0000000-0000-4000-8000-000000000001', 50);
    insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_storage_path)
      values ('${tag}0000000-0000-4000-8000-000000000011', '${c}', '${tag}0000000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 1, 'idem-key-${tag}-0000000000', '${c}/out-${tag}.xml');
    insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path)
      values ('${tag}0000000-0000-4000-8000-000000000012', '${c}', 'efaktura_sk', 'sandbox', 'r-${tag}', '${c}/in-${tag}.xml');
    insert into public.einvoice_events (company_id, outbound_id, to_state, source)
      values ('${c}', '${tag}0000000-0000-4000-8000-000000000011', 'sent', 'system');
    insert into public.documents (company_id, storage_bucket, storage_path, document_type)
      values ('${c}', 'ai-inbox-documents', '${c}/doc-${tag}.pdf', 'invoice');
    set session_replication_role = origin;
  `);
}

await seedFinance(C.a, "a");
await seedFinance(C.b, "b");
await db.exec(`set session_replication_role = replica;
  insert into public.vehicles (company_id) values ('${C.a}');
  set session_replication_role = origin;`).catch(async () => {
  await db.exec(`set session_replication_role = origin;`);
});
const before = { a: await companyRows(C.a), b: await companyRows(C.b) };

await check("seed: obe firmy majú finalizované doklady, e-faktúry, finančný dokument", async () => {
  for (const r of [before.a, before.b]) {
    assert.equal(r.invoices, 2);
    assert.equal(r.items, 1);
    assert.equal(r.einvoice, 3);
    assert.equal(r.documents, 1);
    assert.equal(r.company, 1);
  }
});

await check("mimo workflow: finalizovaná faktúra / udalosti / riadky sa nedajú zmazať ani service_role", async () => {
  for (const sql of [
    `delete from public.invoices where company_id = '${C.a}'`,
    `delete from public.invoice_events where invoice_id = 'a0000000-0000-4000-8000-000000000001'`,
    `delete from public.invoice_items where invoice_id = 'a0000000-0000-4000-8000-000000000001'`,
    `delete from public.invoice_parties where invoice_id = 'a0000000-0000-4000-8000-000000000001'`,
    `delete from public.einvoice_events where company_id = '${C.a}'`,
  ]) {
    const o = await run(svc, sql);
    assert.notEqual(o.layer, "ok", sql);
    assert.match(o.message, /ESBLU_(INVOICE_FINALIZED_NO_DELETE|INVOICE_EVENTS_APPEND_ONLY|INVOICE_ITEMS_FINALIZED_IMMUTABLE|INVOICE_SNAPSHOT_IMMUTABLE|EINVOICE_EVENTS_APPEND_ONLY)|permission denied for table/);
  }
});

await check("podvrhnuté GUC bez executing záznamu nič neodomkne (žiadny globálny bypass)", async () => {
  const fake = "f0000000-0000-4000-8000-000000000000";
  const o = await svcExec(`select set_config('esblu.company_termination_id', '${fake}', true); delete from public.invoices where company_id = '${C.a}'`);
  assert.match(o, /ESBLU_INVOICE_FINALIZED_NO_DELETE/);
  await su(`insert into public.company_terminations (id, company_id, requested_by, status) values ('${fake}', '${C.a}', '${U.owner}', 'completed')`);
  const o2 = await svcExec(`select set_config('esblu.company_termination_id', '${fake}', true); delete from public.invoices where company_id = '${C.a}'`);
  assert.match(o2, /ESBLU_INVOICE_FINALIZED_NO_DELETE/, "completed záznam neodomyká");
  await su(`delete from public.company_terminations where id = '${fake}'`);
  assert.deepEqual(await companyRows(C.a), before.a);
});

await check("bežné zrušenie firmy je naďalej blokované (ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION)", async () => {
  const o = await run(svc, `select public.esblu_account_deletion_commit('owner', '${U.owner}', '${C.a}', false)`);
  assert.match(o.message, /ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION/);
});

await check("owner-only + klient nemá EXECUTE; bez potvrdenia exportu stop", async () => {
  for (const u of [U.admin, U.employee, U.ownerB]) {
    const o = await run(svc, commitSql, [u, C.a, "exported"]);
    assert.match(o.message, /ESBLU_NOT_ACTIVE_OWNER/, u);
  }
  for (const w of [owner, admin, employee, { role: "anon" } as Who]) {
    const o = await run(w, commitSql, [U.owner, C.a, "exported"]);
    assert.equal(o.layer, "privilege", w.role);
  }
  for (const mode of [null, "", "maybe"]) {
    const o = await run(svc, commitSql, [U.owner, C.a, mode]);
    assert.match(o.message, /ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED/);
  }
  assert.deepEqual(await companyRows(C.a), before.a);
});

await check("registrácia u eFaktúra providera → stop pred výmazom", async () => {
  await su(`set session_replication_role = replica`);
  await su(`insert into public.einvoice_organizations (company_id, provider_org_id) values ('${C.a}', 'org-1')`).catch(() => undefined);
  await su(`set session_replication_role = origin`);
  const enrolled = await count(`select count(*)::int n from public.einvoice_organizations where company_id = '${C.a}' and provider_org_id is not null`);
  if (enrolled > 0) {
    const o = await run(svc, commitSql, [U.owner, C.a, "exported"]);
    assert.match(o.message, /ESBLU_EINVOICE_PROVIDER_ENROLLED/);
    await su(`delete from public.einvoice_organizations where company_id = '${C.a}'`);
  }
  assert.deepEqual(await companyRows(C.a), before.a);
});

await check("zlyhanie uprostred procesu → rollback celku, žiadny partial delete ani auditný executing záznam", async () => {
  await db.exec(`
    create function public.test_fail_company_delete() returns trigger language plpgsql as $f$
    begin raise exception 'TEST_INJECTED_FAILURE'; end $f$;
    create trigger test_fail_company_delete before delete on public.companies for each row execute function public.test_fail_company_delete();
  `);
  const o = await run(svc, commitSql, [U.owner, C.a, "exported"]);
  assert.match(o.message, /TEST_INJECTED_FAILURE/);
  await db.exec(`drop trigger test_fail_company_delete on public.companies; drop function public.test_fail_company_delete();`);
  assert.deepEqual(await companyRows(C.a), before.a, "nič sa nezmazalo");
  assert.equal(await count(`select count(*)::int n from public.company_terminations`), 0);
  assert.equal(await count(`select count(*)::int n from public.account_deletion_cleanup_jobs where company_id = '${C.a}'`), 0);
  const f = await run(svc, "select public.esblu_company_termination_record_failure($1, $2, 'exported', 'TEST_INJECTED_FAILURE')", [U.owner, C.a], true);
  assert.equal(f.layer, "ok", f.message);
  assert.equal(await count(`select count(*)::int n from public.company_terminations where status = 'failed' and error_code = 'TEST_INJECTED_FAILURE'`), 1);
});

let terminationId = "";
await check("retry po zlyhaní → úspech: firma A celá preč, Storage ciele v cleanup jobe, auditný záznam bez obsahu", async () => {
  const o = await run(svc, commitSql, [U.owner, C.a, "exported"], true);
  assert.equal(o.layer, "ok", o.message);
  const r = o.data[0].r as Record<string, unknown>;
  terminationId = String(r.termination_id);
  assert.ok(r.job_id);
  const targets = (r.storage_targets as Array<{ bucket: string; path: string }>).map((t) => `${t.bucket}:${t.path}`).sort();
  assert.deepEqual(targets, [`ai-inbox-documents:${C.a}/doc-a.pdf`, `einvoice-documents:${C.a}/in-a.xml`, `einvoice-documents:${C.a}/out-a.xml`].sort());
  assert.deepEqual(await companyRows(C.a), { invoices: 0, items: 0, einvoice: 0, documents: 0, vehicles: 0, company: 0 });
  const job = await su<{ storage_status: string; storage_target_count: number }>(`select storage_status, storage_target_count from public.account_deletion_cleanup_jobs where id = '${r.job_id}'`);
  assert.equal(job[0].storage_status, "pending");
  assert.equal(job[0].storage_target_count, 3);
  const t = await su<{ status: string; export_mode: string; deleted_counts: Record<string, number>; storage_target_count: number }>(
    `select status, export_mode, deleted_counts, storage_target_count from public.company_terminations where id = '${terminationId}'`);
  assert.equal(t[0].status, "completed");
  assert.equal(t[0].export_mode, "exported");
  assert.equal(t[0].deleted_counts.invoices, 2);
  assert.equal(t[0].deleted_counts.einvoice_events, 1);
  assert.equal(t[0].storage_target_count, 3);
  const cols = (await su<{ c: string }>(`select column_name c from information_schema.columns where table_schema = 'public' and table_name = 'company_terminations'`)).map((x) => x.c);
  for (const bad of ["email", "name", "legal_name", "path", "storage_targets"]) assert.ok(!cols.includes(bad), bad);
  assert.equal(await count(`select count(*)::int n from public.company_terminations where status = 'executing'`), 0);
});

await check("izolácia: firma B nedotknutá a jej finalizované doklady ostávajú chránené", async () => {
  assert.deepEqual(await companyRows(C.b), before.b);
  const o = await svcExec(`select set_config('esblu.company_termination_id', '${terminationId}', true); delete from public.invoices where company_id = '${C.b}'`);
  assert.match(o, /ESBLU_INVOICE_FINALIZED_NO_DELETE/, "GUC dokončeného ukončenia nič neodomkne");
});

await check("dvojité / opakované spustenie → already_completed, nič ďalšie sa nezmaže", async () => {
  const o = await run(svc, commitSql, [U.owner, C.a, "exported"], true);
  assert.equal(o.layer, "ok", o.message);
  const r = o.data[0].r as Record<string, unknown>;
  assert.equal(r.already_completed, true);
  assert.equal(r.termination_id, terminationId);
  assert.deepEqual(await companyRows(C.b), before.b);
  assert.equal(await count(`select count(*)::int n from public.company_terminations where status = 'completed'`), 1);
  const other = await run(svc, commitSql, [U.ownerB, C.a, "exported"]);
  assert.match(other.message, /ESBLU_NOT_ACTIVE_OWNER/, "cudzí používateľ nedostane výsledok");
});

await check("auditný záznam: klient nečíta ani nezapisuje", async () => {
  for (const w of [owner, ownerB, { role: "anon" } as Who]) {
    const o = await run(w, "select * from public.company_terminations");
    assert.equal(o.layer, "privilege", w.role);
  }
});

await check("rollback migrácie (audit ostáva) + re-apply je idempotentné", async () => {
  await db.exec(read("supabase/rollback/20261112110000_company_termination_workflow_rollback.sql"));
  assert.equal((await su("select 1 from pg_proc where proname = 'esblu_company_termination_commit'")).length, 0);
  assert.equal((await su("select to_regclass('public.company_terminations') r"))[0].r !== null, true, "auditné záznamy sa nemažú");
  const o = await run(svc, `delete from public.invoices where company_id = '${C.b}'`);
  assert.match(o.message, /ESBLU_INVOICE_FINALIZED_NO_DELETE/);
  const f = "supabase/migrations/20261112110000_company_termination_workflow.sql";
  await db.exec(read(f));
  await db.exec(read(f));
  assert.equal((await su("select 1 from pg_proc where proname = 'esblu_company_termination_commit'")).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
