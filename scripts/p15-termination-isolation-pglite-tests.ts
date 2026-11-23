// =============================================================================
// P1-5 / GDPR 2.0 — ukončenie firmy bez zákazníckeho archívu (20261127100000) a izolácia dokladov
// RECIPIENT_MISMATCH. PGlite, syntetické údaje, dva replaye migrácií:
//   prod-like    — bez 20261121100000 (produkcia nemá esblu_retention),
//   staging-like — všetky migrácie (staging má esblu_retention; objekty sa nemenia).
// Nikdy staging/produkcia.
//
//   npm run test:p15-termination-db
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
const ARCHIVE_MIGRATION = "20261121100000_retention_archive_company_termination.sql";
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
let passed = 0;
let failed = 0;

const U = { owner: "e5000000-0000-4000-8000-0000000000a1", admin: "e5000000-0000-4000-8000-0000000000a2", ownerB: "e5000000-0000-4000-8000-0000000000b1" };
const S = { owner: "e6000000-0000-4000-8000-0000000000a1", admin: "e6000000-0000-4000-8000-0000000000a2", ownerB: "e6000000-0000-4000-8000-0000000000b1" };
const C = { a: "e7000000-0000-4000-8000-00000000000a", b: "e7000000-0000-4000-8000-00000000000b" };
const HEX = (c: string) => c.repeat(64);

async function suite(label: string, withArchiveMigration: boolean) {
  console.log(`\n== ${label}`);
  const db = new PGlite({ extensions: { pgcrypto } });
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL ${name}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
    }
  };
  type Who = { role: "authenticated" | "service_role" | "anon"; uid?: string; session?: string };
  type Outcome = { layer: "ok" | "privilege" | "error"; message: string; data: Row[] };
  const run = async (who: Who, sql: string, params: unknown[] = [], commit = false): Promise<Outcome> => {
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
      if (e.code === "42501") return { layer: "privilege", message: e.message ?? "", data: [] };
      return { layer: "error", message: `${e.code ?? "?"} ${e.message ?? String(error)}`, data: [] };
    } finally {
      await db.exec(commit && ok ? "commit" : "rollback");
    }
  };
  const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const count = async (sql: string) => Number((await su<{ n: number }>(sql))[0].n);
  const svc: Who = { role: "service_role" };
  const owner: Who = { role: "authenticated", uid: U.owner, session: S.owner };
  const ownerB: Who = { role: "authenticated", uid: U.ownerB, session: S.ownerB };

  await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
  const files = replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")))
    .filter((f) => withArchiveMigration || f !== ARCHIVE_MIGRATION);
  assert.ok(files.includes("20261127100000_company_termination_customer_delete.sql"));
  for (const f of files) await db.exec(read(`${MIGRATIONS}/${f}`));

  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) values
      ('${U.owner}', 'owner@example.invalid', now(), now()), ('${U.admin}', 'admin@example.invalid', now(), now()),
      ('${U.ownerB}', 'ownerb@example.invalid', now(), now());
    insert into auth.sessions (id, user_id) values ('${S.owner}', '${U.owner}'), ('${S.admin}', '${U.admin}'), ('${S.ownerB}', '${U.ownerB}');
    set session_replication_role = replica;
    insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.owner}', 'Syntetická A s.r.o.'), ('${C.b}', '${U.ownerB}', 'Syntetická B s.r.o.');
    insert into public.company_members (company_id, user_id, role, status, permissions) values
      ('${C.a}', '${U.owner}', 'owner', 'active', '{}'), ('${C.a}', '${U.admin}', 'admin', 'active', '{}'),
      ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}');
    set session_replication_role = origin;
  `);
  const seed = async (c: string, t: string) => db.exec(`
    set session_replication_role = replica;
    insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number)
      values ('${t}1000000-0000-4000-8000-000000000001', '${c}', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-${t}-1');
    insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status)
      values ('${t}1000000-0000-4000-8000-000000000001', '${c}', 'accounted');
    insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_storage_path)
      values ('${t}1000000-0000-4000-8000-000000000011', '${c}', '${t}1000000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 1, 'idem-p15-${t}-000000000000', '${c}/out-${t}.xml');
    insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, pdf_storage_path)
      values ('${t}1000000-0000-4000-8000-000000000012', '${c}', 'efaktura_sk', 'sandbox', 'p15-ok-${t}', '${c}/in-ok-${t}.xml', '${c}/in-ok-${t}.pdf');
    insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, processing_status, last_error_code)
      values ('${t}1000000-0000-4000-8000-000000000013', '${c}', 'efaktura_sk', 'sandbox', 'p15-mm-${t}', '${c}/in-mm-${t}.xml', 'failed', 'RECIPIENT_MISMATCH');
    insert into public.einvoice_events (company_id, inbound_id, to_state, source) values
      ('${c}', '${t}1000000-0000-4000-8000-000000000012', 'stored', 'system'),
      ('${c}', '${t}1000000-0000-4000-8000-000000000013', 'failed', 'system');
    insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_role,
        statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel)
      values ('${c}', 'efaktura_sk', 'sandbox', '{send,receive}', '${c === C.a ? U.owner : U.ownerB}', 'owner',
        'mandate-sk-1', '${HEX("2")}', 'sk', true, 'enroll');
    set session_replication_role = origin;
  `);
  await seed(C.a, "a");
  await seed(C.b, "b");
  await db.exec(`
    insert into storage.objects (bucket_id, name) values
      ('einvoice-documents', '${C.a}/in-ok-a.xml'), ('einvoice-documents', '${C.a}/in-mm-a.xml'), ('einvoice-documents', '${C.a}/in-ok-a.pdf');
  `);

  const ack = (over: Record<string, unknown> = {}) => JSON.stringify({
    authority_confirmed: true, text_version: "sk-2026-11-23", text_sha256: HEX("1"), confirmed_at: new Date().toISOString(),
    ip_sha256: HEX("3"), user_agent_sha256: HEX("4"), ...over,
  });
  const exec = (u: string, c: string, mode: string, a: string, commit = false) =>
    run(svc, "select public.esblu_company_termination_execute($1, $2, false, $3, $4::jsonb) r", [u, c, mode, a], commit);
  const begin = async (u: string, c: string) => {
    const expected = (await fp(c)).fingerprint;
    const o = await run(svc, "select public.esblu_company_export_begin($1, $2, 'test.v1', 0, 0, $3, $4, $5) id", [u, c, HEX("a"), HEX("b"), expected], true);
    assert.equal(o.layer, "ok", o.message);
    return String(o.data[0].id);
  };
  const fp = async (c: string) => (await su<{ f: { fingerprint: string; counts: Record<string, number> } }>(`select public.esblu_company_export_fingerprint('${c}') f`))[0].f;
  const snapshot = async () => ({
    a: await count(`select (select count(*) from public.invoices where company_id='${C.a}') + (select count(*) from public.einvoice_inbound where company_id='${C.a}') + (select count(*) from public.companies where id='${C.a}') n`),
    b: await count(`select (select count(*) from public.invoices where company_id='${C.b}') + (select count(*) from public.einvoice_inbound where company_id='${C.b}') + (select count(*) from public.einvoice_events where company_id='${C.b}') n`),
    terminations: await count(`select count(*)::int n from public.company_terminations`),
    jobs: await count(`select count(*)::int n from public.account_deletion_cleanup_jobs`),
  });
  const base = await snapshot();
  const nothingChanged = async (why: string) => assert.deepEqual(await snapshot(), base, `${why}: nič sa nezmenilo`);

  await check("prostredie: esblu_retention " + (withArchiveMigration ? "existuje a ostáva nedotknutá" : "neexistuje (ako produkcia)"), async () => {
    const ns = (await su<{ r: string | null }>(`select to_regnamespace('esblu_retention')::text r`))[0].r;
    assert.equal(ns !== null, withArchiveMigration);
    if (withArchiveMigration) {
      assert.equal((await su("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'esblu_retention' and p.proname = 'termination_execute'")).length, 1);
    }
  });

  // ------------------------------------------------------------------ R3 izolácia v DB
  await check("R3 RLS: owner A vidí iba vlastný doklad (nie RECIPIENT_MISMATCH) a iba jeho udalosti; owner B nič z A", async () => {
    const a = await run(owner, "select id from public.einvoice_inbound");
    assert.equal(a.layer, "ok", a.message);
    assert.deepEqual(a.data.map((r) => r.id), ["a1000000-0000-4000-8000-000000000012"]);
    const ev = await run(owner, "select inbound_id from public.einvoice_events");
    assert.deepEqual(ev.data.map((r) => r.inbound_id), ["a1000000-0000-4000-8000-000000000012"]);
    const b = await run(ownerB, `select count(*)::int n from public.einvoice_inbound where company_id = '${C.a}'`);
    assert.equal(b.data[0].n, 0);
    const bev = await run(ownerB, `select count(*)::int n from public.einvoice_events where company_id = '${C.a}'`);
    assert.equal(bev.data[0].n, 0);
  });

  await check("R3 Storage: klient nečíta objekty einvoice-documents (ani vlastnej firmy, ani mismatch) — iba server", async () => {
    assert.equal(await count(`select count(*)::int n from storage.objects where bucket_id = 'einvoice-documents'`), 3, "seed");
    for (const w of [owner, ownerB, { role: "anon" } as Who]) {
      const o = await run(w, "select count(*)::int n from storage.objects where bucket_id = 'einvoice-documents'");
      assert.ok(o.layer === "privilege" || o.data[0].n === 0, `${w.role}: ${o.message}`);
    }
  });

  // ------------------------------------------------------------------ odtlačok dát
  await check("odtlačok: deterministický, odlišný pre firmy, bez R3 dokladov, klient nemá EXECUTE", async () => {
    const f1 = await fp(C.a);
    assert.match(f1.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal((await fp(C.a)).fingerprint, f1.fingerprint);
    assert.notEqual((await fp(C.b)).fingerprint, f1.fingerprint);
    assert.equal(f1.counts.einvoice_inbound, 1, "mismatch sa nezapočíta");
    assert.equal(f1.counts.einvoice_events, 1, "udalosť mismatch sa nezapočíta");
    assert.equal(f1.counts.invoice_accounting_state_log, 1);
    assert.equal(f1.counts.einvoice_mandates, 1);
    for (const w of [owner, { role: "anon" } as Who]) {
      assert.equal((await run(w, `select public.esblu_company_export_fingerprint('${C.a}')`)).layer, "privilege", w.role);
    }
  });

  await check("odtlačok: zmena údajov firmy ho zmení; zmena dokladu RECIPIENT_MISMATCH nie", async () => {
    const f0 = (await fp(C.a)).fingerprint;
    let fMm = "";
    let fLog = "";
    await db.exec("begin");
    try {
      await db.exec(`update public.einvoice_inbound set updated_at = updated_at + interval '1 minute' where id = 'a1000000-0000-4000-8000-000000000013'`);
      fMm = (await fp(C.a)).fingerprint;
      await db.exec(`insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status) values ('a1000000-0000-4000-8000-000000000001', '${C.a}', 'unprocessed')`);
      fLog = (await fp(C.a)).fingerprint;
    } finally {
      await db.exec("rollback");
    }
    assert.equal(fMm, f0, "mismatch neovplyvní");
    assert.notEqual(fLog, f0, "denník účtovného stavu ovplyvní");
  });

  // ------------------------------------------------------------------ brána
  await check("export run uloží odtlačok, počty a SHA-256 manifestu; zmena údajov počas exportu → ESBLU_EXPORT_DATA_CHANGED", async () => {
    const id = await begin(U.owner, C.a);
    const r = await su<{ data_fingerprint: string; manifest_sha256: string; counts: Row }>(`select data_fingerprint, manifest_sha256, counts from public.company_export_runs where id = '${id}'`);
    assert.equal(r[0].data_fingerprint, (await fp(C.a)).fingerprint);
    assert.equal(r[0].manifest_sha256, HEX("b"));
    assert.equal((r[0].counts as Record<string, number>).einvoice_inbound, 1, "počty z DB, bez R3");
    const stale = await run(svc, "select public.esblu_company_export_begin($1, $2, 'test.v1', 0, 0, $3, $4, $5) id", [U.owner, C.a, HEX("a"), HEX("b"), HEX("9")]);
    assert.match(stale.message, /ESBLU_EXPORT_DATA_CHANGED/, "údaje sa zmenili počas exportu");
  });

  await check("BLOCK: potvrdenie oprávnenej osoby chýba / je neplatné / staré → ESBLU_TERMINATION_ACK_REQUIRED", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const [why, a] of [
      ["prázdne", "{}"],
      ["bez oprávnenia", ack({ authority_confirmed: false })],
      ["oprávnenie ako text", ack({ authority_confirmed: "true" })],
      ["bez verzie textu", ack({ text_version: null })],
      ["bez SHA textu", ack({ text_sha256: null })],
      ["staré potvrdenie", ack({ confirmed_at: old })],
      ["potvrdenie v budúcnosti", ack({ confirmed_at: future })],
      ["bez času", ack({ confirmed_at: null })],
    ] as Array<[string, string]>) {
      const o = await exec(U.owner, C.a, "exported", a);
      assert.match(o.message, /ESBLU_TERMINATION_ACK_REQUIRED/, why);
    }
    for (const [why, a] of [["zlé SHA", ack({ text_sha256: "xyz" })], ["zlá verzia", ack({ text_version: "a b" })]] as Array<[string, string]>) {
      const o = await exec(U.owner, C.a, "exported", a);
      assert.equal(o.layer, "error", why);
      assert.match(o.message, /company_terminations_ack_check|ESBLU_TERMINATION_ACK_REQUIRED/, why);
    }
    assert.match((await run(svc, "select public.esblu_company_termination_execute($1, $2, false, 'exported', null)", [U.owner, C.a])).message, /ESBLU_TERMINATION_ACK_REQUIRED/);
    await nothingChanged("ack");
  });

  await check("BLOCK: staré prihlásenie (> 30 min) → ESBLU_TERMINATION_REAUTH_REQUIRED", async () => {
    await su(`update auth.users set last_sign_in_at = now() - interval '2 hours' where id = '${U.owner}'`);
    const o = await exec(U.owner, C.a, "exported", ack());
    await su(`update auth.users set last_sign_in_at = now() where id = '${U.owner}'`);
    assert.match(o.message, /ESBLU_TERMINATION_REAUTH_REQUIRED/);
    await nothingChanged("reauth");
  });

  await check("BLOCK: waived pri finalizovaných dokladoch → ESBLU_TERMINATION_EXPORT_REQUIRED", async () => {
    assert.match((await exec(U.owner, C.a, "waived", ack())).message, /ESBLU_TERMINATION_EXPORT_REQUIRED/);
    await nothingChanged("waived");
  });

  await check("BLOCK: údaje zmenené po exporte → ESBLU_TERMINATION_EXPORT_STALE (nový export nutný)", async () => {
    await begin(U.owner, C.a);
    await su(`insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status) values ('a1000000-0000-4000-8000-000000000001', '${C.a}', 'unprocessed')`);
    assert.match((await exec(U.owner, C.a, "exported", ack())).message, /ESBLU_TERMINATION_EXPORT_STALE/);
    await nothingChanged("stale");
  });

  await check("BLOCK: beh bez odtlačku (starší kód exportu) sa nepočíta", async () => {
    const id = await begin(U.owner, C.a);
    await su(`update public.company_export_runs set data_fingerprint = null where id = '${id}'`);
    assert.match((await exec(U.owner, C.a, "exported", ack())).message, /ESBLU_TERMINATION_EXPORT_STALE/);
    await nothingChanged("bez odtlačku");
  });

  await check("BLOCK cross-company: owner B nevymaže A; admin A nie je oprávnený; export B nepomôže A; klient nemá EXECUTE", async () => {
    await begin(U.ownerB, C.b);
    assert.match((await exec(U.ownerB, C.a, "exported", ack())).message, /ESBLU_NOT_ACTIVE_OWNER/);
    assert.match((await exec(U.admin, C.a, "exported", ack())).message, /ESBLU_NOT_ACTIVE_OWNER/);
    await su(`update public.company_export_runs set status = 'failed', error_code = 'TEST', completed_at = null where company_id = '${C.a}'`);
    assert.match((await exec(U.owner, C.a, "exported", ack())).message, /ESBLU_TERMINATION_EXPORT_NOT_VERIFIED/);
    for (const w of [owner, ownerB, { role: "anon" } as Who]) {
      const o = await run(w, "select public.esblu_company_termination_execute($1, $2, false, 'exported', $3::jsonb)", [U.owner, C.a, ack()]);
      assert.equal(o.layer, "privilege", w.role);
    }
    await nothingChanged("cross-company");
  });

  await check("preflight: rovnaké kódy ako brána, bez akejkoľvek zmeny údajov; klient nemá EXECUTE", async () => {
    const pf = async (u: string, mode: string, a: string | null) => {
      const o = await run(svc, "select public.esblu_company_termination_preflight($1, $2, $3, $4::jsonb) c", [u, C.a, mode, a]);
      assert.equal(o.layer, "ok", o.message);
      return o.data[0].c as string | null;
    };
    assert.equal(await pf(U.owner, "exported", ack()), "ESBLU_TERMINATION_EXPORT_NOT_VERIFIED");
    assert.equal(await pf(U.owner, "waived", ack()), "ESBLU_TERMINATION_EXPORT_REQUIRED");
    assert.equal(await pf(U.owner, "exported", ack({ authority_confirmed: false })), "ESBLU_TERMINATION_EXPORT_NOT_VERIFIED", "export sa kontroluje prvý");
    assert.equal(await pf(U.owner, "maybe", ack()), "ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED");
    assert.equal(await pf(U.owner, "exported", null), "ESBLU_TERMINATION_ACK_REQUIRED");
    assert.equal(await pf(U.ownerB, "exported", ack()), "ESBLU_NOT_ACTIVE_OWNER");
    assert.equal(await pf(U.admin, "exported", ack()), "ESBLU_NOT_ACTIVE_OWNER");
    await begin(U.owner, C.a);
    assert.equal(await pf(U.owner, "exported", ack()), null, "všetko platné");
    assert.equal(await pf(U.owner, "exported", ack({ authority_confirmed: false })), "ESBLU_TERMINATION_ACK_REQUIRED");
    assert.equal(await pf(U.owner, "exported", ack({ text_sha256: "bad" })), "ESBLU_TERMINATION_ACK_REQUIRED");
    await su(`update auth.users set last_sign_in_at = now() - interval '2 hours' where id = '${U.owner}'`);
    assert.equal(await pf(U.owner, "exported", ack()), "ESBLU_TERMINATION_REAUTH_REQUIRED");
    await su(`update auth.users set last_sign_in_at = now() where id = '${U.owner}'`);
    assert.equal((await run(owner, "select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb)", [U.owner, C.a, ack()])).layer, "privilege");
    await su(`update public.company_export_runs set status = 'failed', error_code = 'TEST', completed_at = null where company_id = '${C.a}' and status = 'completed'`);
    await nothingChanged("preflight");
  });

  await check("ochrana billing-documents: cleanup job nikdy nezmaže účtovnú kópiu Esblu", async () => {
    const r = await su<{ storage_targets: Row[]; storage_target_count: number }>(`
      insert into public.account_deletion_cleanup_jobs (kind, user_id, company_id, storage_targets, storage_target_count)
      values ('owner', '${U.ownerB}', null, '[{"bucket":"billing-documents","path":"x/inv.pdf"},{"bucket":"einvoice-documents","path":"y.xml"}]', 2)
      returning storage_targets, storage_target_count`);
    assert.deepEqual(r[0].storage_targets, [{ bucket: "einvoice-documents", path: "y.xml" }]);
    assert.equal(r[0].storage_target_count, 1);
    const r2 = await su<{ storage_target_count: number; storage_status: string }>(`
      insert into public.account_deletion_cleanup_jobs (kind, user_id, storage_targets, storage_target_count)
      values ('owner', '${U.ownerB}', '[{"bucket":"billing-documents","path":"x/inv2.pdf"}]', 1) returning storage_target_count, storage_status`);
    assert.equal(r2[0].storage_target_count, 0);
    assert.equal(r2[0].storage_status, "done");
    await su(`delete from public.account_deletion_cleanup_jobs where company_id is null`);
  });

  // ------------------------------------------------------------------ úspech
  let tid = "";
  let job = "";
  await check("PASS: platné potvrdenie + aktuálny export → výmaz bez archívu, súbory (XML, PDF, UBL, kópia mismatch) v cieľoch", async () => {
    const run1 = await begin(U.owner, C.a);
    const fpBefore = (await fp(C.a)).fingerprint;
    const o = await exec(U.owner, C.a, "exported", ack(), true);
    assert.equal(o.layer, "ok", o.message);
    const r = o.data[0].r as Row;
    tid = String(r.termination_id);
    job = String(r.job_id);
    assert.equal(r.termination_mode, "customer_delete");
    assert.equal(r.archive_id, undefined);
    const targets = (r.storage_targets as Array<{ bucket: string; path: string }>).map((t) => `${t.bucket}:${t.path}`).sort();
    assert.deepEqual(targets, [
      `einvoice-documents:${C.a}/in-mm-a.xml`, `einvoice-documents:${C.a}/in-ok-a.pdf`,
      `einvoice-documents:${C.a}/in-ok-a.xml`, `einvoice-documents:${C.a}/out-a.xml`,
    ]);
    const t = await su<Row>(`select * from public.company_terminations where id = '${tid}'`);
    assert.equal(t[0].status, "completed");
    assert.equal(t[0].termination_mode, "customer_delete");
    assert.equal(t[0].authority_confirmed, true);
    assert.equal(t[0].ack_text_version, "sk-2026-11-23");
    assert.equal(t[0].ack_text_sha256, HEX("1"));
    assert.equal(t[0].request_ip_sha256, HEX("3"));
    assert.equal(t[0].export_run_id, run1);
    assert.equal(t[0].export_fingerprint, fpBefore);
    assert.equal(t[0].storage_purged_at, null);
    assert.equal(await count(`select count(*)::int n from public.companies where id = '${C.a}'`), 0);
    assert.equal(await count(`select count(*)::int n from public.invoices where company_id = '${C.a}'`), 0);
    assert.equal(await count(`select count(*)::int n from public.einvoice_inbound where company_id = '${C.a}'`), 0);
    assert.equal(await count(`select count(*)::int n from public.invoice_accounting_state_log where company_id = '${C.a}'`), 0);
    if (withArchiveMigration) {
      assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records`), 0, "nič sa nearchivuje");
    }
  });

  await check("izolácia: firma B úplne nedotknutá (doklady, e-faktúry, udalosti, mandát)", async () => {
    assert.equal((await snapshot()).b, base.b);
    assert.equal(await count(`select count(*)::int n from public.einvoice_mandates where company_id = '${C.b}'`), 1);
  });

  await check("mandát A (dôkaz oprávnenia, append-only) ostáva; owner B ho nevidí", async () => {
    assert.equal(await count(`select count(*)::int n from public.einvoice_mandates where company_id = '${C.a}'`), 1);
    const o = await run(ownerB, `select count(*)::int n from public.einvoice_mandates where company_id = '${C.a}'`);
    assert.ok(o.layer === "privilege" || o.data[0].n === 0);
  });

  await check("preukázateľný výmaz: storage_purged_at po dokončení cleanup jobu; opakovanie = already_completed", async () => {
    await su(`update public.account_deletion_cleanup_jobs set storage_status = 'done' where id = '${job}'`);
    const t = await su<{ storage_purged_at: string | null }>(`select storage_purged_at from public.company_terminations where id = '${tid}'`);
    assert.ok(t[0].storage_purged_at);
    const again = await exec(U.owner, C.a, "exported", ack(), true);
    assert.equal(again.layer, "ok", again.message);
    assert.equal((again.data[0].r as Row).already_completed, true);
    assert.equal(await count(`select count(*)::int n from public.company_terminations where status = 'completed'`), 1);
  });

  await db.close();
}

await suite("prod-like (bez 20261121100000)", false);
await suite("staging-like (s 20261121100000)", true);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
