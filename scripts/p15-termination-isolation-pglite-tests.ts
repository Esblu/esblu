// =============================================================================
// P1-5 / GDPR 2.0 — ukončenie firmy bez zákazníckeho archívu (20261127100000) + bezpečnostné opravy
// (20261128100000): definitívny a overený výmaz súborov, úplnosť a integrita exportu, deregistrácia eFaktúry,
// izolácia RECIPIENT_MISMATCH a incidentový záznam. PGlite, iba syntetické údaje, dva replaye migrácií:
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
const SHA_OK = (t: string) => (t === "a" ? "a1" : "b1").repeat(32);
const SHA_UBL = (t: string) => (t === "a" ? "a2" : "b2").repeat(32);
const SHA_MM = (t: string) => (t === "a" ? "a3" : "b3").repeat(32);

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
  const count = async (sql: string, params: unknown[] = []) => Number((await su<{ n: number }>(sql, params))[0].n);
  /** Zmena v transakcii, ktorá sa vždy vráti (pozorovanie bez trvalého zásahu). */
  const inTx = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec("begin");
    try {
      return await fn();
    } finally {
      await db.exec("rollback");
    }
  };
  const svc: Who = { role: "service_role" };
  const owner: Who = { role: "authenticated", uid: U.owner, session: S.owner };
  const ownerB: Who = { role: "authenticated", uid: U.ownerB, session: S.ownerB };

  await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
  // 20261121100000 je od 2026-11-26 v supabase/superseded (produkcia ju nedostane); staging-like ju vloží na pôvodné miesto.
  const files = replayOrder([...readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")),
    ...(withArchiveMigration ? [ARCHIVE_MIGRATION] : [])]);
  assert.ok(files.includes("20261128100000_termination_purge_export_integrity.sql"));
  assert.ok(!readdirSync(path.join(ROOT, MIGRATIONS)).includes(ARCHIVE_MIGRATION), "20261121100000 nesmie byť v supabase/migrations");
  for (const f of files) await db.exec(read(f === ARCHIVE_MIGRATION ? `supabase/superseded/${f}` : `${MIGRATIONS}/${f}`));

  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) values
      ('${U.owner}', 'owner@example.invalid', now(), now()), ('${U.admin}', 'admin@example.invalid', now(), now()),
      ('${U.ownerB}', 'ownerb@example.invalid', now(), now());
    insert into auth.sessions (id, user_id) values ('${S.owner}', '${U.owner}'), ('${S.admin}', '${U.admin}'), ('${S.ownerB}', '${U.ownerB}');
    insert into storage.buckets (id, name) values ('ai-inbox-documents', 'ai-inbox-documents'), ('billing-documents', 'billing-documents'),
      ('vehicle-photos', 'vehicle-photos') on conflict do nothing;
    set session_replication_role = replica;
    insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.owner}', 'Syntetická A s.r.o.'), ('${C.b}', '${U.ownerB}', 'Syntetická B s.r.o.');
    insert into public.company_members (company_id, user_id, role, status, permissions) values
      ('${C.a}', '${U.owner}', 'owner', 'active', '{}'), ('${C.a}', '${U.admin}', 'admin', 'active', '{}'),
      ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}');
    set session_replication_role = origin;
  `);
  const p = (c: string, rest: string) => `${c}/${rest}`;
  const seed = async (c: string, t: string) => db.exec(`
    set session_replication_role = replica;
    insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number)
      values ('${t}1000000-0000-4000-8000-000000000001', '${c}', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-${t}-1');
    insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status)
      values ('${t}1000000-0000-4000-8000-000000000001', '${c}', 'accounted');
    insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_storage_path, ubl_sha256)
      values ('${t}1000000-0000-4000-8000-000000000011', '${c}', '${t}1000000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 1,
              'idem-p15-${t}-000000000000', '${p(c, `outbound/${t}/${SHA_UBL(t)}.xml`)}', '${SHA_UBL(t)}');
    insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, processing_status, quarantined_at, quarantine_reason)
      values ('${t}1000000-0000-4000-8000-000000000012', '${c}', 'efaktura_sk', 'sandbox', 'p15-ok-${t}', '${p(c, `inbound/efaktura_sk/ok-${t}/${SHA_OK(t)}.xml`)}', '${SHA_OK(t)}',
              'failed', now(), 'DRAFT_CREATE_FAILED');
    insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, processing_status, last_error_code)
      values ('${t}1000000-0000-4000-8000-000000000013', '${c}', 'efaktura_sk', 'sandbox', 'p15-mm-${t}', '${p(c, `inbound/efaktura_sk/mm-${t}/${SHA_MM(t)}.xml`)}', '${SHA_MM(t)}',
              'failed', 'RECIPIENT_MISMATCH');
    insert into public.einvoice_events (company_id, inbound_id, to_state, source) values
      ('${c}', '${t}1000000-0000-4000-8000-000000000012', 'stored', 'system'),
      ('${c}', '${t}1000000-0000-4000-8000-000000000013', 'failed', 'system');
    insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_role,
        statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel)
      values ('${c}', 'efaktura_sk', 'sandbox', '{send,receive}', '${c === C.a ? U.owner : U.ownerB}', 'owner',
        'mandate-sk-1', '${HEX("2")}', 'sk', true, 'enroll');
    insert into public.documents (company_id, storage_bucket, storage_path, document_type)
      values ('${c}', 'ai-inbox-documents', '${p(c, `doc-${t}.pdf`)}', 'invoice');
    insert into public.vehicles (id, company_id, spz) values ('${t}1000000-0000-4000-8000-000000000021', '${c}', 'QA${t}001');
    set session_replication_role = origin;
    insert into storage.objects (bucket_id, name, metadata) values
      ('einvoice-documents', '${p(c, `outbound/${t}/${SHA_UBL(t)}.xml`)}', '{"eTag":"e1","size":10}'),
      ('einvoice-documents', '${p(c, `inbound/efaktura_sk/ok-${t}/${SHA_OK(t)}.xml`)}', '{"eTag":"e2","size":10}'),
      ('einvoice-documents', '${p(c, `inbound/efaktura_sk/mm-${t}/${SHA_MM(t)}.xml`)}', '{"eTag":"e3","size":10}'),
      ('einvoice-documents', '${p(c, "orphan/left-behind.xml")}', '{"eTag":"e4","size":10}'),
      ('ai-inbox-documents', '${p(c, `doc-${t}.pdf`)}', '{"eTag":"e5","size":10}');
  `);
  await seed(C.a, "a");
  await seed(C.b, "b");
  await su(`insert into storage.objects (bucket_id, name, metadata) values ('billing-documents', 'test/2026/11/invoice/in_p15.pdf', '{"eTag":"bd"}')`);

  const ack = (over: Record<string, unknown> = {}) => JSON.stringify({
    authority_confirmed: true, text_version: "sk-2026-11-23", text_sha256: HEX("1"), confirmed_at: new Date().toISOString(),
    ip_sha256: HEX("3"), user_agent_sha256: HEX("4"), ...over,
  });
  const exec = (u: string, c: string, mode: string, a: string, commit = false) =>
    run(svc, "select public.esblu_company_termination_execute($1, $2, false, $3, $4::jsonb) r", [u, c, mode, a], commit);
  const fp = async (c: string) => (await su<{ f: { fingerprint: string; counts: Record<string, number> } }>(`select public.esblu_company_export_fingerprint('${c}') f`))[0].f;
  const fileList = (c: string) => su<{ bucket: string; path: string; expected_sha256: string | null }>(
    "select bucket, path, expected_sha256 from public.esblu_company_export_file_list($1) order by bucket, path", [c]);
  const beginBound = async (u: string, c: string, list?: Array<{ bucket: string; path: string }>) => {
    const l = list ?? (await fileList(c)).map((f) => ({ bucket: f.bucket, path: f.path }));
    const parts = l.length === 0 ? 0 : Math.ceil(l.length / 100);
    return run(svc, "select public.esblu_company_export_begin($1, $2, 'test.v2', $3, $4, $5, $6, $7, $8::jsonb) id",
      [u, c, l.length, parts, HEX("a"), HEX("b"), (await fp(c)).fingerprint, JSON.stringify(l)], true);
  };
  type Ev = { bucket: string; path: string; sha256: string; bytes: string };
  const evidence = async (c: string, over: (e: Ev) => Ev = (e) => e) =>
    (await fileList(c)).map((f) => over({ bucket: f.bucket, path: f.path, sha256: f.expected_sha256 ?? HEX("d"), bytes: "10" }));
  const part = (id: string, u: string, c: string, ev: Ev[], missing: Array<{ bucket: string; path: string }> = [], index = 0) =>
    run(svc, "select public.esblu_company_export_part_files($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) st",
      [id, u, c, index, JSON.stringify(ev), JSON.stringify(missing), HEX("e")], true);
  /** Kompletný export viazaný na súbory (úspešná cesta). */
  const exportRun = async (u = U.owner, c = C.a) => {
    const b = await beginBound(u, c);
    assert.equal(b.layer, "ok", b.message);
    const id = String(b.data[0].id);
    const st = await part(id, u, c, await evidence(c));
    assert.equal(st.data[0]?.st, "completed", st.message);
    return id;
  };
  const runStatus = async (id: string) => (await su<{ status: string; error_code: string | null }>(`select status, error_code from public.company_export_runs where id = $1`, [id]))[0];
  const failRuns = (c: string) => su(`update public.company_export_runs set status = 'failed', error_code = 'TEST', completed_at = null where company_id = $1 and status <> 'failed'`, [c]);
  const snapshot = async () => ({
    a: await count(`select (select count(*) from public.invoices where company_id='${C.a}') + (select count(*) from public.einvoice_inbound where company_id='${C.a}') + (select count(*) from public.companies where id='${C.a}') n`),
    b: await count(`select (select count(*) from public.invoices where company_id='${C.b}') + (select count(*) from public.einvoice_inbound where company_id='${C.b}') + (select count(*) from public.einvoice_events where company_id='${C.b}') + (select count(*) from storage.objects where name like '${C.b}/%') n`),
    terminations: await count(`select count(*)::int n from public.company_terminations`),
    jobs: await count(`select count(*)::int n from public.account_deletion_cleanup_jobs`),
  });
  const base = await snapshot();
  const nothingChanged = async (why: string) => assert.deepEqual(await snapshot(), base, `${why}: nič sa nezmenilo`);

  await check("prostredie: esblu_retention " + (withArchiveMigration ? "existuje a ostáva nedotknutá" : "neexistuje (ako produkcia)"), async () => {
    const ns = (await su<{ r: string | null }>(`select to_regnamespace('esblu_retention')::text r`))[0].r;
    assert.equal(ns !== null, withArchiveMigration);
  });

  // ================================================================== R3 izolácia
  await check("R3 RLS: owner A vidí iba vlastné doklady (nie RECIPIENT_MISMATCH) a ich udalosti; owner B nič z A", async () => {
    const a = await run(owner, "select id from public.einvoice_inbound order by id");
    assert.equal(a.layer, "ok", a.message);
    assert.deepEqual(a.data.map((r) => r.id), ["a1000000-0000-4000-8000-000000000012"]);
    const ev = await run(owner, "select inbound_id from public.einvoice_events where inbound_id is not null");
    assert.deepEqual(ev.data.map((r) => r.inbound_id), ["a1000000-0000-4000-8000-000000000012"]);
    assert.equal((await run(ownerB, `select count(*)::int n from public.einvoice_inbound where company_id = '${C.a}'`)).data[0].n, 0);
  });

  await check("R3 Storage: klient nečíta objekty einvoice-documents (ani vlastné, ani mismatch)", async () => {
    for (const w of [owner, ownerB, { role: "anon" } as Who]) {
      const o = await run(w, "select count(*)::int n from storage.objects where bucket_id = 'einvoice-documents'");
      assert.ok(o.layer === "privilege" || o.data[0].n === 0, `${w.role}: ${o.message}`);
    }
  });

  await check("R3 export: zoznam súborov ani odtlačok neobsahujú doklad RECIPIENT_MISMATCH; osirelý súbor nie je údaj na export", async () => {
    const l = (await fileList(C.a)).map((f) => f.path);
    assert.ok(!l.some((x) => x.includes("/mm-a/")), "mismatch XML nie je v exporte");
    assert.ok(!l.some((x) => x.includes("orphan/")), "osirelý objekt nie je záznam firmy");
    assert.ok(l.every((x) => x.startsWith(`${C.a}/`)), "iba súbory firmy A");
    const f = await fp(C.a);
    assert.equal(f.counts.einvoice_inbound, 1);
    assert.equal(f.counts.einvoice_events, 1);
  });

  // ================================================================== F2/F4 úplnosť a integrita exportu
  await check("odtlačok pokrýva všetky tabuľky exportu (45), je deterministický a klient nemá EXECUTE", async () => {
    const f1 = await fp(C.a);
    assert.equal(Object.keys(f1.counts).length, 45);
    assert.equal((await fp(C.a)).fingerprint, f1.fingerprint);
    assert.notEqual((await fp(C.b)).fingerprint, f1.fingerprint);
    for (const fn of ["esblu_company_export_fingerprint", "esblu_company_export_file_list", "esblu_company_export_storage_fingerprint"]) {
      assert.equal((await run(owner, `select public.${fn}('${C.a}')`)).layer, "privilege", fn);
    }
  });

  await check("odtlačok: lease/retry stĺpce prenosu e-faktúr ho nemenia (žiadne falošné STALE); zmena obsahu áno", async () => {
    const f0 = (await fp(C.a)).fingerprint;
    const [lease, content] = await inTx(async () => {
      await db.exec(`update public.einvoice_inbound set locked_until = now() + interval '2 minutes', retry_count = retry_count + 1 where id = 'a1000000-0000-4000-8000-000000000012'`);
      const l = (await fp(C.a)).fingerprint;
      await db.exec(`update public.einvoice_outbound set provider_status = 'DELIVERED' where id = 'a1000000-0000-4000-8000-000000000011'`);
      return [l, (await fp(C.a)).fingerprint];
    });
    assert.equal(lease, f0);
    assert.notEqual(content, f0);
  });

  await check("begin: zoznam súborov servera musí presne zodpovedať DB (chýbajúci / cudzí súbor = ESBLU_EXPORT_FILES_MISMATCH)", async () => {
    const l = (await fileList(C.a)).map((f) => ({ bucket: f.bucket, path: f.path }));
    const missingOne = await beginBound(U.owner, C.a, l.slice(1));
    assert.match(missingOne.message, /ESBLU_EXPORT_FILES_MISMATCH/);
    const foreign = await beginBound(U.owner, C.a, [...l.slice(1), { bucket: "einvoice-documents", path: `${C.b}/inbound/efaktura_sk/ok-b/${SHA_OK("b")}.xml` }]);
    assert.match(foreign.message, /ESBLU_EXPORT_FILES_MISMATCH/, "súbor inej firmy");
    const mm = await beginBound(U.owner, C.a, [...l.slice(1), { bucket: "einvoice-documents", path: `${C.a}/inbound/efaktura_sk/mm-a/${SHA_MM("a")}.xml` }]);
    assert.match(mm.message, /ESBLU_EXPORT_FILES_MISMATCH/, "R3 súbor");
  });

  await check("dávka: iná identita súboru pri rovnakom počte = FILES_CHANGED; chýbajúci = FILES_MISSING; zlý SHA-256 originálu = FILES_CORRUPT", async () => {
    let b = await beginBound(U.owner, C.a);
    let id = String(b.data[0].id);
    const ev = await evidence(C.a);
    const swapped = ev.map((e, i) => (i === 0 ? { ...e, path: `${e.path}.x` } : e));
    assert.equal((await part(id, U.owner, C.a, swapped)).data[0].st, "failed");
    assert.equal((await runStatus(id)).error_code, "FILES_CHANGED");
    b = await beginBound(U.owner, C.a); id = String(b.data[0].id);
    assert.equal((await part(id, U.owner, C.a, ev.slice(1), [{ bucket: ev[0].bucket, path: ev[0].path }])).data[0].st, "failed");
    assert.equal((await runStatus(id)).error_code, "FILES_MISSING");
    b = await beginBound(U.owner, C.a); id = String(b.data[0].id);
    const corrupt = await evidence(C.a, (e) => (e.path.includes("/ok-a/") ? { ...e, sha256: HEX("f") } : e));
    assert.equal((await part(id, U.owner, C.a, corrupt)).data[0].st, "failed");
    assert.equal((await runStatus(id)).error_code, "FILES_CORRUPT");
    const ubl = await evidence(C.a, (e) => (e.path.includes("/outbound/") ? { ...e, sha256: HEX("f") } : e));
    b = await beginBound(U.owner, C.a); id = String(b.data[0].id);
    assert.equal((await part(id, U.owner, C.a, ubl)).data[0].st, "failed");
    assert.equal((await runStatus(id)).error_code, "FILES_CORRUPT", "UBL");
    assert.equal((await exec(U.owner, C.a, "exported", ack())).message.match(/ESBLU_TERMINATION_EXPORT_(NOT_VERIFIED|STALE)/)?.[0], "ESBLU_TERMINATION_EXPORT_NOT_VERIFIED");
    // pôvodné _part na beh viazaný na súbory nefunguje
    b = await beginBound(U.owner, C.a); id = String(b.data[0].id);
    const legacy = await run(svc, "select public.esblu_company_export_part($1, $2, $3, 0, $4, $5, 0)", [id, U.owner, C.a, ev.length, HEX("e")]);
    assert.match(legacy.message, /ESBLU_EXPORT_FILES_BOUND/);
    await failRuns(C.a);
    await nothingChanged("integrita");
  });

  await check("súbeh: súbor sa zmení medzi začiatkom exportu a dávkou → FILES_CHANGED", async () => {
    const b = await beginBound(U.owner, C.a);
    const id = String(b.data[0].id);
    await su(`update storage.objects set updated_at = now() + interval '1 second', metadata = '{"eTag":"changed","size":10}' where name = '${C.a}/doc-a.pdf'`);
    assert.equal((await part(id, U.owner, C.a, await evidence(C.a))).data[0].st, "failed");
    assert.equal((await runStatus(id)).error_code, "FILES_CHANGED");
    await failRuns(C.a);
  });

  await check("súbeh: údaje sa zmenia medzi odtlačkom a begin → ESBLU_EXPORT_DATA_CHANGED", async () => {
    const before = (await fp(C.a)).fingerprint;
    await su(`insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status) values ('a1000000-0000-4000-8000-000000000001', '${C.a}', 'unprocessed')`);
    const l = (await fileList(C.a)).map((f) => ({ bucket: f.bucket, path: f.path }));
    const o = await run(svc, "select public.esblu_company_export_begin($1, $2, 't', $3, 1, $4, $5, $6, $7::jsonb) id", [U.owner, C.a, l.length, HEX("a"), HEX("b"), before, JSON.stringify(l)]);
    assert.match(o.message, /ESBLU_EXPORT_DATA_CHANGED/);
  });

  await check("po exporte: doplnené vozidlo → STALE (preflight aj výmaz)", async () => {
    await exportRun();
    assert.equal((await run(svc, "select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()])).data[0].c, null);
    await db.exec(`set session_replication_role = replica; insert into public.vehicles (company_id, spz) values ('${C.a}', 'QAa999'); set session_replication_role = origin;`);
    assert.equal((await run(svc, "select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()])).data[0].c, "ESBLU_TERMINATION_EXPORT_STALE");
    assert.match((await exec(U.owner, C.a, "exported", ack())).message, /ESBLU_TERMINATION_EXPORT_STALE/);
    await db.exec(`set session_replication_role = replica; delete from public.vehicles where spz = 'QAa999'; set session_replication_role = origin;`);
    await nothingChanged("vozidlo");
  });

  await check("po exporte: výmena súboru na rovnakej ceste (rovnaký počet) → STALE; nový súbor → STALE", async () => {
    await exportRun();
    await inTx(async () => {
      await db.exec(`update storage.objects set updated_at = now() + interval '5 seconds', metadata = '{"eTag":"replaced","size":11}' where name = '${C.a}/doc-a.pdf'`);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE", "výmena obsahu");
    });
    await inTx(async () => {
      await db.exec(`set session_replication_role = replica; insert into public.documents (company_id, storage_bucket, storage_path, document_type) values ('${C.a}', 'ai-inbox-documents', '${C.a}/doc-new.pdf', 'invoice'); set session_replication_role = origin;`);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE", "nový súbor");
    });
    await nothingChanged("súbory");
  });

  // ================================================================== brána (potvrdenie, prihlásenie, cross-company)
  await check("BLOCK: potvrdenie oprávnenej osoby chýba / je neplatné / staré → ESBLU_TERMINATION_ACK_REQUIRED", async () => {
    await exportRun();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    for (const [why, a] of [
      ["prázdne", "{}"], ["bez oprávnenia", ack({ authority_confirmed: false })], ["oprávnenie ako text", ack({ authority_confirmed: "true" })],
      ["bez verzie", ack({ text_version: null })], ["bez SHA", ack({ text_sha256: null })], ["staré", ack({ confirmed_at: old })],
    ] as Array<[string, string]>) {
      assert.match((await exec(U.owner, C.a, "exported", a)).message, /ESBLU_TERMINATION_ACK_REQUIRED/, why);
    }
    await su(`update auth.users set last_sign_in_at = now() - interval '2 hours' where id = '${U.owner}'`);
    const o = await exec(U.owner, C.a, "exported", ack());
    await su(`update auth.users set last_sign_in_at = now() where id = '${U.owner}'`);
    assert.match(o.message, /ESBLU_TERMINATION_REAUTH_REQUIRED/);
    assert.match((await exec(U.owner, C.a, "waived", ack())).message, /ESBLU_TERMINATION_EXPORT_REQUIRED/);
    await nothingChanged("ack");
  });

  await check("BLOCK cross-company: owner B ani admin A nevymaže A; export B nepomôže A; klient nemá EXECUTE", async () => {
    await exportRun(U.ownerB, C.b);
    assert.match((await exec(U.ownerB, C.a, "exported", ack())).message, /ESBLU_NOT_ACTIVE_OWNER/);
    assert.match((await exec(U.admin, C.a, "exported", ack())).message, /ESBLU_NOT_ACTIVE_OWNER/);
    for (const w of [owner, ownerB, { role: "anon" } as Who]) {
      for (const sql of [
        "select public.esblu_company_termination_execute($1, $2, false, 'exported', $3::jsonb)",
        "select public.esblu_company_export_part_files($1, $2, $2, 0, '[]', '[]', $3)",
        "select public.esblu_cleanup_job_confirm_storage($1)",
      ]) {
        const args = sql.includes("execute(") ? [U.owner, C.a, ack()] : sql.includes("part_files") ? [U.owner, C.a, HEX("e")] : [U.owner];
        assert.equal((await run(w, sql, args)).layer, "privilege", `${w.role} ${sql.slice(14, 60)}`);
      }
    }
    await failRuns(C.b);
    await nothingChanged("cross-company");
  });

  // ================================================================== F3 deregistrácia eFaktúry
  const enroll = () => db.exec(`set session_replication_role = replica;
    insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id)
    values ('${C.a}', 'efaktura_sk', 'sandbox', 'org-a', '9915:a') on conflict do nothing; set session_replication_role = origin;`);
  const derReq = (reason = "company_termination") =>
    run(svc, "select public.esblu_einvoice_deregistration_request($1, 'sandbox', $2, $3, $4) r",
      [C.a, reason, reason === "operator" ? null : U.owner, reason === "operator" ? "ops:p15" : null], true);
  const derJob = async () => (await su<{ id: string }>(`select id from public.einvoice_deregistrations where company_id = $1 order by created_at desc limit 1`, [C.a]))[0].id;
  const claim = async (id: string) => run(svc, "select id from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'sandbox', 1, 60, $1)", [id], true);
  const finish = (id: string, outcome: string, code: string | null) =>
    run(svc, "select state from public.esblu_einvoice_deregistration_finish($1, $2, $3, null, null)", [id, outcome, code], true);

  await check("F3 neočakávaná zmena mandátu po exporte (odvolanie používateľom / operátorská deregistrácia / nový mandát) → STALE", async () => {
    await exportRun();
    await inTx(async () => {
      await db.exec(`update public.einvoice_mandates set revoked_at = now(), revoked_by_kind = 'user', revoked_by_user_id = '${U.owner}', revocation_reason_code = 'USER' where company_id = '${C.a}'`);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE", "používateľ");
    });
    await inTx(async () => {
      await db.exec(`update public.einvoice_mandates set revoked_at = now(), revoked_by_kind = 'deregistration', revocation_reason_code = 'OPERATOR' where company_id = '${C.a}'`);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE", "operátor");
    });
    await inTx(async () => {
      await db.exec(`update public.einvoice_mandates set revoked_at = now(), revoked_by_kind = 'deregistration', revocation_reason_code = 'COMPANY_TERMINATION' where company_id = '${C.a}'`);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE", "COMPANY_TERMINATION bez deregistračného jobu ukončenia");
    });
    await inTx(async () => {
      await db.exec(`set session_replication_role = replica; insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_role,
        statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel) values ('${C.a}', 'efaktura_sk', 'sandbox', '{send}', '${U.owner}', 'owner', 'm2', '${HEX("2")}', 'sk', true, 'regrant');
        set session_replication_role = origin;`);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE", "nový mandát");
    });
    await nothingChanged("mandáty");
  });

  await check("F3 operátorská deregistrácia (nie ukončenie) po exporte → STALE", async () => {
    await enroll();
    await exportRun();
    await inTx(async () => {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await db.query("select public.esblu_einvoice_deregistration_request($1, 'sandbox', 'operator', null, 'ops:p15')", [C.a]);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE");
    });
  });

  await check("F3 export → deregistrácia ukončenia: zlyhanie poskytovateľa, timeout lease, opakovanie — nič sa nezmaže; po dokončení výmaz BEZ nového exportu", async () => {
    // (firma A je registrovaná z predchádzajúceho testu, export je aktuálny)
    assert.equal((await run(svc, "select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()])).data[0].c, null);
    const r = await derReq();
    assert.equal(r.layer, "ok", r.message);
    const job = await derJob();
    assert.equal(await count(`select count(*)::int n from public.einvoice_mandates where company_id = $1 and revocation_reason_code = 'COMPANY_TERMINATION'`, [C.a]), 1, "mandát odvolaný ukončením");
    assert.equal((await run(svc, "select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()])).data[0].c, null,
      "očakávané odvolanie nemení odtlačok");
    // registrácia ešte trvá → výmaz zastavený
    assert.match((await exec(U.owner, C.a, "exported", ack())).message, /ESBLU_EINVOICE_PROVIDER_ENROLLED/);
    // zlyhanie poskytovateľa → retry_wait
    assert.equal((await claim(job)).data.length, 1);
    assert.equal((await finish(job, "retry", "EINVOICE_PROVIDER_UNAVAILABLE")).data[0].state, "retry_wait");
    assert.match((await exec(U.owner, C.a, "exported", ack())).message, /ESBLU_EINVOICE_PROVIDER_ENROLLED/);
    // timeout: lease vyprší, job sa znova prevezme
    await su(`update public.einvoice_deregistrations set next_attempt_at = now() - interval '1 minute' where id = $1`, [job]);
    assert.equal((await claim(job)).data.length, 1);
    await su(`update public.einvoice_deregistrations set locked_until = now() - interval '1 minute' where id = $1`, [job]);
    assert.equal((await claim(job)).data.length, 1, "po vypršaní lease");
    await nothingChanged("deregistrácia prebieha");
    // dokončenie u poskytovateľa → mapovanie zmizne, odtlačok sa nezmenil → výmaz prejde bez nového exportu
    assert.equal((await finish(job, "completed", null)).data[0].state, "completed");
    assert.equal((await run(svc, "select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()])).data[0].c, null);
  });

  await check("F3 nový prijatý doklad počas ukončovania (po exporte) → STALE, nič sa nezmaže", async () => {
    await inTx(async () => {
      await db.exec(`set session_replication_role = replica; insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id) values ('${C.a}', 'efaktura_sk', 'sandbox', 'p15-late'); set session_replication_role = origin;`);
      const o = await db.query<{ c: string | null }>("select public.esblu_company_termination_preflight($1, $2, 'exported', $3::jsonb) c", [U.owner, C.a, ack()]);
      assert.equal(o.rows[0].c, "ESBLU_TERMINATION_EXPORT_STALE");
    });
  });

  // ================================================================== F1 ochrana cieľov cleanup jobu
  await check("F1 ciele: e-faktúry iba v jobe autorizovaného ukončenia a pod prefixom firmy; billing-documents nikdy (chyba, nie tiché preskočenie)", async () => {
    const ins = (targets: unknown[], extra = "") => run(svc,
      `insert into public.account_deletion_cleanup_jobs (kind, user_id, company_id, storage_targets, storage_target_count${extra ? ", termination_id" : ""}) values ('owner', $1, $2, $3::jsonb, 1${extra})`,
      [U.ownerB, C.b, JSON.stringify(targets)]);
    assert.match((await ins([{ bucket: "einvoice-documents", path: `${C.b}/x.xml` }])).message, /ESBLU_CLEANUP_TARGET_PROTECTED/, "bez ukončenia");
    assert.match((await ins([{ bucket: "billing-documents", path: "test/x.pdf" }])).message, /ESBLU_CLEANUP_TARGET_PROTECTED/);
    assert.match((await ins([{ bucket: "einvoice-documents", path: `${C.b}/x.xml` }], ", gen_random_uuid()")).message, /ESBLU_CLEANUP_TARGET_PROTECTED/, "neexistujúce ukončenie");
    assert.equal((await ins([{ bucket: "ai-inbox-documents", path: `${C.b}/y.pdf` }])).layer, "ok");
  });

  // ================================================================== úspech + overený výmaz
  let tid = "";
  let job = "";
  await check("PASS: výmaz bez archívu; ciele = všetky súbory firmy vrátane karantény, R3 a osirelých; nič z firmy B ani billing", async () => {
    const o = await exec(U.owner, C.a, "exported", ack(), true);
    assert.equal(o.layer, "ok", o.message);
    const r = o.data[0].r as Row;
    tid = String(r.termination_id);
    job = String(r.job_id);
    const targets = (r.storage_targets as Array<{ bucket: string; path: string }>).map((t) => `${t.bucket}:${t.path}`).sort();
    assert.deepEqual(targets, [
      `ai-inbox-documents:${C.a}/doc-a.pdf`,
      `einvoice-documents:${C.a}/inbound/efaktura_sk/mm-a/${SHA_MM("a")}.xml`,
      `einvoice-documents:${C.a}/inbound/efaktura_sk/ok-a/${SHA_OK("a")}.xml`,
      `einvoice-documents:${C.a}/orphan/left-behind.xml`,
      `einvoice-documents:${C.a}/outbound/a/${SHA_UBL("a")}.xml`,
    ]);
    const j = await su<Row>(`select termination_id, company_id, storage_status from public.account_deletion_cleanup_jobs where id = $1`, [job]);
    assert.deepEqual([j[0].termination_id, j[0].company_id, j[0].storage_status], [tid, C.a, "pending"]);
    const t = await su<Row>(`select * from public.company_terminations where id = $1`, [tid]);
    assert.equal(t[0].termination_mode, "customer_delete");
    assert.equal(t[0].storage_purged_at, null);
    assert.match(String(t[0].storage_targets_sha256), /^[0-9a-f]{64}$/);
    assert.equal((t[0].deleted_counts as Row).einvoice_inbound_recipient_mismatch, 1);
    assert.equal(await count(`select count(*)::int n from public.companies where id = $1`, [C.a]), 0);
    if (withArchiveMigration) assert.equal(await count(`select count(*)::int n from esblu_retention.archived_records`), 0, "nič sa nearchivuje");
  });

  await check("F5 R3 incident: záznam bez obsahu/cesty/strán; klient ani service_role ho nezapíšu; nevytvára cestu k cudzím údajom", async () => {
    const inc = await su<Row>(`select * from public.einvoice_misdelivery_incidents where mailbox_company_id = $1`, [C.a]);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].xml_sha256, SHA_MM("a"));
    assert.match(String(inc[0].provider_received_id_sha256), /^[0-9a-f]{64}$/);
    assert.equal(inc[0].termination_id, tid);
    const cols = Object.keys(inc[0]);
    for (const bad of ["xml_storage_path", "path", "provider_received_id", "sender_participant_id", "sender_ico", "document_number", "receiver"]) assert.ok(!cols.includes(bad), bad);
    assert.ok(!JSON.stringify(inc[0]).includes("p15-mm-a"), "surové ID u poskytovateľa sa neukladá");
    for (const w of [owner, ownerB, { role: "anon" } as Who]) assert.equal((await run(w, "select * from public.einvoice_misdelivery_incidents")).layer, "privilege", w.role);
    assert.equal((await run(svc, `insert into public.einvoice_misdelivery_incidents (provider, environment, provider_received_id_sha256, mailbox_company_id) values ('x', 'sandbox', '${HEX("9")}', '${C.b}')`)).layer, "privilege");
    assert.equal((await run(svc, "delete from public.einvoice_misdelivery_incidents")).layer, "privilege");
  });

  await check("F1 job ukončenia: ručné „hotovo“, nové ciele, cudzí prefix ani zmena termination_id nie sú možné", async () => {
    assert.match((await run(svc, `update public.account_deletion_cleanup_jobs set storage_status = 'done' where id = $1`, [job])).message, /ESBLU_CLEANUP_UNVERIFIED/);
    assert.match((await run(svc, `update public.account_deletion_cleanup_jobs set storage_targets = storage_targets || '[{"bucket":"ai-inbox-documents","path":"${C.b}/doc-b.pdf"}]'::jsonb where id = $1`, [job])).message, /ESBLU_CLEANUP_TARGETS_IMMUTABLE/);
    assert.match((await run(svc, `update public.account_deletion_cleanup_jobs set storage_targets = '[{"bucket":"einvoice-documents","path":"${C.b}/orphan/left-behind.xml"}]'::jsonb where id = $1`, [job])).message, /ESBLU_CLEANUP_TARGET_PROTECTED|ESBLU_CLEANUP_TARGETS_IMMUTABLE/);
    assert.match((await run(svc, `update public.account_deletion_cleanup_jobs set termination_id = gen_random_uuid() where id = $1`, [job])).message, /ESBLU_CLEANUP_JOB_IMMUTABLE/);
    assert.match((await run(svc, `update public.account_deletion_cleanup_jobs set storage_verified_at = now() where id = $1`, [job])).message, /ESBLU_CLEANUP_UNVERIFIED/);
  });

  await check("F1 overenie: hotovo iba ak v Storage neostal žiadny cieľ ani objekt pod prefixom firmy; čiastočný výmaz = pending so zvyškom; neskorý objekt sa doplní", async () => {
    const confirm = async () => (await run(svc, "select public.esblu_cleanup_job_confirm_storage($1) r", [job], true)).data[0].r as { done: boolean; remaining: number };
    let r = await confirm();
    assert.deepEqual([r.done, r.remaining], [false, 5], "nič nezmazané");
    // čiastočný výmaz (výpadok uprostred)
    await su(`delete from storage.objects where bucket_id = 'einvoice-documents' and name like '${C.a}/inbound/%'`);
    r = await confirm();
    assert.deepEqual([r.done, r.remaining], [false, 3]);
    const j = await su<{ storage_targets: unknown[]; storage_status: string; last_error_code: string }>(`select storage_targets, storage_status, last_error_code from public.account_deletion_cleanup_jobs where id = $1`, [job]);
    assert.equal(j[0].storage_targets.length, 3, "ciele = zvyšok (obnoviteľné)");
    assert.equal(j[0].last_error_code, "ESBLU_STORAGE_NOT_PURGED");
    assert.equal((await su<Row>(`select storage_purged_at from public.company_terminations where id = $1`, [tid]))[0].storage_purged_at, null);
    // zvyšok zmazaný, ale medzitým pribudol objekt pod prefixom firmy (napr. dobehnutý upload)
    await su(`delete from storage.objects where name like '${C.a}/%'`);
    await su(`insert into storage.objects (bucket_id, name) values ('einvoice-documents', '${C.a}/inbound/late/late.xml')`);
    r = await confirm();
    assert.deepEqual([r.done, r.remaining], [false, 1], "neskorý objekt pod prefixom");
    await su(`delete from storage.objects where name like '${C.a}/%'`);
    r = await confirm();
    assert.equal(r.done, true);
    const t = await su<Row>(`select storage_purged_at, storage_verified_count from public.company_terminations where id = $1`, [tid]);
    assert.ok(t[0].storage_purged_at);
    assert.equal(t[0].storage_verified_count, 5);
    const again = await confirm();
    assert.equal(again.done, true, "idempotentné");
    assert.equal(await count(`select count(*)::int n from storage.objects where name like '${C.b}/%'`), 5, "firma B nedotknutá");
    assert.equal(await count(`select count(*)::int n from storage.objects where bucket_id = 'billing-documents'`), 1, "billing-documents nedotknuté");
  });

  await check("izolácia po výmaze: firma B úplne nedotknutá; mandát A ostáva (append-only); opakovanie = already_completed", async () => {
    assert.equal((await snapshot()).b, base.b);
    assert.equal(await count(`select count(*)::int n from public.einvoice_mandates where company_id = $1`, [C.a]), 1);
    const again = await exec(U.owner, C.a, "exported", ack(), true);
    assert.equal((again.data[0].r as Row).already_completed, true);
  });

  await check("spätná kompatibilita: starší pending job s e-faktúrou (pred 20261128) sa nikdy neoznačí ako hotový; iné zmeny jobu prejdú", async () => {
    assert.match((await run(svc, `insert into public.account_deletion_cleanup_jobs (kind, user_id, company_id, storage_targets, storage_target_count)
      values ('owner', $1, $2, '[{"bucket":"einvoice-documents","path":"${C.b}/legacy.xml"}]', 1)`, [U.ownerB, C.b])).message, /ESBLU_CLEANUP_TARGET_PROTECTED/, "nový taký job nevznikne");
    await db.exec(`set session_replication_role = replica;
      insert into public.account_deletion_cleanup_jobs (id, kind, user_id, company_id, storage_targets, storage_target_count)
      values ('f9000000-0000-4000-8000-000000000001', 'owner', '${U.ownerB}', '${C.b}', '[{"bucket":"einvoice-documents","path":"${C.b}/legacy.xml"}]', 1);
      set session_replication_role = origin;`);
    const id = "f9000000-0000-4000-8000-000000000001";
    assert.equal((await run(svc, `update public.account_deletion_cleanup_jobs set auth_status = 'done', attempts = attempts + 1 where id = $1`, [id])).layer, "ok");
    await su(`insert into storage.objects (bucket_id, name) values ('einvoice-documents', '${C.b}/legacy.xml')`);
    const c = await run(svc, "select public.esblu_cleanup_job_confirm_storage($1) r", [id], true);
    assert.deepEqual(c.data[0].r, { done: false, remaining: 1 }, "objekt existuje → nikdy hotovo (aplikácia ho bez ukončenia nezmaže) → retry → alert");
    assert.equal((await su<{ s: string }>(`select storage_status s from public.account_deletion_cleanup_jobs where id = $1`, [id]))[0].s, "pending");
    await su(`delete from storage.objects where name = '${C.b}/legacy.xml'`);
  });

  await check("monitoring: vyčerpané pokusy a ukončenie bez overeného výmazu > 24 h sa započítajú", async () => {
    await su(`insert into public.account_deletion_cleanup_jobs (kind, user_id, storage_targets, storage_target_count, attempts) values ('owner', $1, '[{"bucket":"ai-inbox-documents","path":"x"}]', 1, 30)`, [U.ownerB]);
    await su(`insert into public.company_terminations (company_id, requested_by, status, export_mode, termination_mode, completed_at)
      values (gen_random_uuid(), $1, 'completed', null, 'customer_delete', now() - interval '2 days')`, [U.ownerB]).catch(() => undefined);
    const h = (await run(svc, "select public.esblu_cleanup_health(30) h")).data[0].h as Row;
    assert.ok(Number(h.exhausted) >= 1);
    assert.equal((await run(owner, "select public.esblu_cleanup_health(30)")).layer, "privilege");
  });

  await check("rollback 20261128100000 (evidencia ostáva) + re-apply idempotentné", async () => {
    await db.exec(read("supabase/rollback/20261128100000_termination_purge_export_integrity_rollback.sql"));
    assert.equal((await su("select 1 from pg_proc where proname = 'esblu_cleanup_job_confirm_storage'")).length, 0);
    assert.notEqual((await su<{ r: string | null }>("select to_regclass('public.einvoice_misdelivery_incidents')::text r"))[0].r, null, "incidenty ostávajú");
    assert.equal(await count(`select count(*)::int n from public.einvoice_misdelivery_incidents`), 1);
    const f = "supabase/migrations/20261128100000_termination_purge_export_integrity.sql";
    await db.exec(read(f));
    await db.exec(read(f));
    assert.equal((await su("select 1 from pg_proc where proname = 'esblu_cleanup_job_confirm_storage'")).length, 1);
    await db.exec(read("supabase/rollback/20261128100000_termination_purge_export_integrity_rollback.sql"));
    await db.exec(read("supabase/rollback/20261127100000_company_termination_customer_delete_rollback.sql"));
    await db.exec(read("supabase/migrations/20261127100000_company_termination_customer_delete.sql"));
    await db.exec(read(f));
    assert.equal((await su("select 1 from pg_proc where proname = 'esblu_company_termination_execute'")).length, 1);
  });

  await db.close();
}

await suite("prod-like (bez 20261121100000)", false);
await suite("staging-like (s 20261121100000)", true);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
