// =============================================================================
// B2B VOP 1.2 — firemné prijatie Všeobecných obchodných podmienok.
// PGlite, čistý replay všetkých migrácií. Nikdy staging/produkcia.
//   - terms 1.2 publikované (required), hash = legal/terms/1.2.md
//   - esblu_accept_company_terms: iba owner, povinné B2B + oprávnenie, iba
//     aktuálna verzia; eviduje osobu, rolu, verziu, hash, čas, jazyk, firmu
//   - osobné potvrdenie ownera (user_legal_acceptances, via company_terms_gate)
//   - oddelenie firiem (prijatie A neplatí pre B), status RPC pre členov
//   - poradie VOP → DPA, re-accept pri novej verzii, append-only
//   - archivácia dôkazu (scope company_terms), anon bez prístupu, rollback
//
//   npm run test:b2b-terms-db
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
assert.ok(files.includes("20261112100000_b2b_terms_1_2_company_acceptance.sql"));
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


const { createHash } = await import("node:crypto");
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(ROOT, p))).digest("hex");

await check("terms 1.2: aktuálna verzia, hash = legal/terms/1.2.md, firemné prijatie (required=false), lehota 30 dní", async () => {
  const r = await su<{ version: string; required: boolean; content_hash: string; canonical_path: string; d: number }>(
    "select version, required, content_hash, canonical_path, reaccept_notice_days d from public.legal_documents where type = 'terms' order by effective_at desc, created_at desc, version desc limit 1");
  assert.equal(r[0].version, "1.2");
  assert.equal(r[0].required, false);
  assert.equal(r[0].d, 30);
  assert.equal(r[0].content_hash, sha("legal/terms/1.2.md"));
  assert.equal(r[0].canonical_path, "/podmienky-pouzivania");
});

await check("status pred prijatím: každý člen vidí has_current_acceptance = false; cudzí nečlen nič", async () => {
  for (const w of [owner, admin, employee]) {
    const o = await run(w, "select * from public.esblu_get_my_company_terms_status()");
    assert.equal(o.layer, "ok", o.message);
    assert.equal(o.data[0].current_terms_version, "1.2");
    assert.equal(o.data[0].has_current_acceptance, false);
    assert.equal(o.data[0].required_now, true, "nová firma (po zverejnení) → povinné hneď");
    assert.equal(o.data[0].grace_until, null);
    assert.equal(o.data[0].company_name, "Firma A s.r.o.");
    assert.equal(o.data[0].company_registration_id, "12345678");
  }
  const a = await run({ role: "anon" }, "select * from public.esblu_get_my_company_terms_status()");
  assert.equal(a.layer, "privilege");
});

await check("prijatie: admin/employee odmietnutí (owner-only)", async () => {
  for (const w of [admin, employee]) {
    const o = await run(w, "select public.esblu_accept_company_terms('1.2', true, true, 'sk')");
    assert.match(o.message, /ESBLU_NOT_ACTIVE_OWNER/);
  }
});

await check("prijatie: bez B2B vyhlásenia / bez oprávnenia / stará verzia odmietnuté", async () => {
  assert.match((await run(owner, "select public.esblu_accept_company_terms('1.2', false, true, 'sk')")).message, /ESBLU_TERMS_B2B_NOT_CONFIRMED/);
  assert.match((await run(owner, "select public.esblu_accept_company_terms('1.2')")).message, /ESBLU_TERMS_B2B_NOT_CONFIRMED/);
  assert.match((await run(owner, "select public.esblu_accept_company_terms('1.2', true, false, 'sk')")).message, /ESBLU_TERMS_AUTHORITY_NOT_CONFIRMED/);
  assert.match((await run(owner, "select public.esblu_accept_company_terms('1.1', true, true, 'sk')")).message, /ESBLU_NOT_CURRENT_TERMS_VERSION/);
  assert.match((await run(owner, "select public.esblu_accept_company_terms(null, true, true, 'sk')")).message, /ESBLU_NOT_CURRENT_TERMS_VERSION/);
});

await check("poradie VOP → DPA: DPA bez prijatých VOP odmietnutá", async () => {
  const o = await run(owner, "select public.esblu_accept_company_dpa('1.3', true, 'sk')");
  assert.match(o.message, /ESBLU_COMPANY_TERMS_NOT_ACCEPTED/);
});

await check("prijatie owner: eviduje firmu, osobu, rolu, B2B, oprávnenie, verziu, hash, čas, jazyk, metódu", async () => {
  const o = await run(owner, "select (public.esblu_accept_company_terms('1.2', true, true, 'en')).*", [], true);
  assert.equal(o.layer, "ok", o.message);
  const r = o.data[0];
  assert.equal(r.company_id, C.a);
  assert.equal(r.document_type, "terms");
  assert.equal(r.version, "1.2");
  assert.equal(r.accepted_by, U.owner);
  assert.equal(r.accepted_role, "owner");
  assert.equal(r.acceptance_method, "company_terms_gate");
  assert.equal(r.b2b_confirmed, true);
  assert.equal(r.authority_confirmed, true);
  assert.equal(r.document_content_hash, sha("legal/terms/1.2.md"));
  assert.equal(r.display_locale, "en");
  assert.equal(r.company_name_snapshot, "Firma A s.r.o.");
  assert.equal(r.company_registration_id_snapshot, "12345678");
  assert.equal(r.processor_acceptance, null);
  assert.ok(r.accepted_at);
  const u = await su<{ m: Record<string, unknown>; acceptance_method: string }>(
    `select metadata m, acceptance_method from public.user_legal_acceptances where user_id = '${U.owner}' and document_type = 'terms' and version = '1.2'`);
  assert.equal(u.length, 1, "osobné potvrdenie ownera");
  assert.equal(u[0].m.via, "company_terms_gate");
  assert.equal(u[0].m.display_locale, "en");
});

await check("idempotentné / append-only: opakované prijatie neprepíše čas ani jazyk", async () => {
  const before = await su<{ accepted_at: string }>(`select accepted_at::text from public.company_dpa_acceptances where company_id = '${C.a}' and document_type = 'terms'`);
  const o = await run(owner, "select (public.esblu_accept_company_terms('1.2', true, true, 'de')).display_locale l", [], true);
  assert.equal(o.data[0].l, "en");
  const after = await su<{ accepted_at: string }>(`select accepted_at::text from public.company_dpa_acceptances where company_id = '${C.a}' and document_type = 'terms'`);
  assert.deepEqual(after, before);
  for (const w of [owner, admin]) {
    const up = await run(w, `update public.company_dpa_acceptances set b2b_confirmed = false where company_id = '${C.a}'`);
    assert.equal(up.layer, "privilege", w.role);
    const ins = await run(w, `insert into public.company_dpa_acceptances (company_id, document_type, version, accepted_by, acceptance_method, b2b_confirmed, authority_confirmed) values ('${C.b}', 'terms', '1.2', '${U.owner}', 'company_terms_gate', true, true)`);
    assert.equal(ins.layer, "privilege", w.role);
  }
});

await check("CHECK: terms riadok bez B2B / s DPA metódou je odmietnutý aj pre service/superuser", async () => {
  await assert.rejects(su(`insert into public.company_dpa_acceptances (company_id, document_type, version, accepted_by, acceptance_method, b2b_confirmed, authority_confirmed) values ('${C.b}', 'terms', '1.2', '${U.ownerB}', 'company_terms_gate', false, true)`), /terms_evidence_check/);
  await assert.rejects(su(`insert into public.company_dpa_acceptances (company_id, document_type, version, accepted_by, acceptance_method, b2b_confirmed, authority_confirmed) values ('${C.b}', 'terms', '1.2', '${U.ownerB}', 'company_dpa_gate', true, true)`), /acceptance_method_check/);
});

await check("oddelenie firiem: prijatie firmy A neplatí pre firmu B; členovia A vidia prijaté", async () => {
  for (const w of [admin, employee]) {
    const o = await run(w, "select has_current_acceptance h from public.esblu_get_my_company_terms_status()");
    assert.equal(o.data[0].h, true);
  }
  const b = await run(ownerB, "select company_id, has_current_acceptance h from public.esblu_get_my_company_terms_status()");
  assert.equal(b.data[0].company_id, C.b);
  assert.equal(b.data[0].h, false);
  const sel = await run(ownerB, `select 1 from public.company_dpa_acceptances where company_id = '${C.a}'`);
  assert.equal(sel.data.length, 0, "RLS: firma B nevidí prijatia firmy A");
  assert.match((await run(ownerB, "select public.esblu_accept_company_dpa('1.3', true, 'sk')")).message, /ESBLU_COMPANY_TERMS_NOT_ACCEPTED/);
});

await check("po prijatí VOP: DPA prijatie prejde", async () => {
  const o = await run(owner, "select (public.esblu_accept_company_dpa('1.3', true, 'sk')).document_type d", [], true);
  assert.equal(o.layer, "ok", o.message);
  assert.equal(o.data[0].d, "dpa");
});

await check("re-accept: nová účinná verzia VOP → status false, stará verzia odmietnutá", async () => {
  await su(`insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path) values ('terms', '9.9', now(), true, '${"f".repeat(64)}', '/podmienky-pouzivania')`);
  const s = await run(owner, "select current_terms_version v, has_current_acceptance h from public.esblu_get_my_company_terms_status()");
  assert.equal(s.data[0].v, "9.9");
  assert.equal(s.data[0].h, false);
  assert.match((await run(owner, "select public.esblu_accept_company_terms('1.2', true, true, 'sk')")).message, /ESBLU_NOT_CURRENT_TERMS_VERSION/);
  const pend = await run(employee, "select document_type, version from public.esblu_get_my_pending_required_acceptances() where document_type = 'terms'");
  assert.equal(pend.layer, "ok", pend.message);
  assert.equal(pend.data[0]?.version, "9.9", "osobný re-accept cez LegalAcceptanceGate");
  await su("alter table public.legal_documents disable trigger esblu_legal_documents_no_delete");
  await su("delete from public.legal_documents where type = 'terms' and version = '9.9'");
  await su("alter table public.legal_documents enable trigger esblu_legal_documents_no_delete");
});

await check("grace period: existujúca firma → lehota beží OD OZNÁMENIA (company_terms_notices), owner-only, po lehote povinné", async () => {
  const C2 = "e3000000-0000-4000-8000-00000000000c";
  const U4 = "e2000000-0000-4000-8000-0000000000c4";
  const S4 = "e4000000-0000-4000-8000-0000000000c4";
  await su(`insert into auth.users (id, email, email_confirmed_at) values ('${U4}', 'old-owner@example.invalid', now())`);
  await su(`insert into auth.sessions (id, user_id) values ('${S4}', '${U4}')`);
  await su(`set session_replication_role = replica`);
  await su(`insert into public.companies (id, owner_id, name, created_at) values ('${C2}', '${U4}', 'Stará firma s.r.o.', now() - interval '1 year')`);
  await su(`insert into public.company_members (company_id, user_id, role, status, permissions) values ('${C2}', '${U4}', 'owner', 'active', '{}'), ('${C2}', '${U.employee}', 'employee', 'active', '{}')`);
  await su(`set session_replication_role = origin`);
  const oldOwner: Who = { role: "authenticated", uid: U4, session: S4 };
  const req = async () => (await su<{ required_now: boolean; grace_until: string | null; needs_notice: boolean; notified_at: string | null }>(
    `select * from public.esblu_company_terms_requirement('${C2}')`))[0];
  let r0 = await req();
  assert.equal(r0.needs_notice, true);
  assert.equal(r0.notified_at, null);
  assert.equal(r0.required_now, false, "bez oznámenia nie je povinné");
  const fresh = await su<{ required_now: boolean; needs_notice: boolean }>(`select * from public.esblu_company_terms_requirement('${C.b}')`);
  assert.equal(fresh[0].required_now, true, "firma založená po zverejnení → povinné hneď");
  assert.equal(fresh[0].needs_notice, false);
  // owner zaznamená oznámenie (prvé zobrazenie v appke)
  const n = await run(oldOwner, "select (public.esblu_record_company_terms_notice()).*", [], true);
  assert.equal(n.layer, "ok", n.message);
  assert.equal(n.data[0].company_id, C2);
  assert.equal(n.data[0].terms_version, "1.2");
  assert.equal(n.data[0].notified_user_id, U4);
  const days = Math.round((Date.parse(String(n.data[0].grace_until)) - Date.parse(String(n.data[0].notified_at))) / 86_400_000);
  assert.equal(days, 30);
  assert.equal(String(n.data[0].effective_at), String(n.data[0].grace_until));
  // opakovanie neposunie lehotu (append-only)
  const again = await run(oldOwner, "select (public.esblu_record_company_terms_notice()).grace_until g", [], true);
  assert.equal(String(again.data[0].g), String(n.data[0].grace_until));
  r0 = await req();
  assert.equal(r0.required_now, false, "počas lehoty nepovinné");
  assert.ok(r0.grace_until);
  // status pre ownera
  const st = await run(oldOwner, "select needs_notice, notified_at, grace_until, required_now from public.esblu_get_my_company_terms_status()");
  assert.equal(st.data[0].needs_notice, true);
  assert.ok(st.data[0].notified_at);
  // klient nemôže zapisovať priamo
  const ins = await run(oldOwner, `update public.company_terms_notices set grace_until = now() + interval '1 year' where company_id = '${C2}'`);
  assert.equal(ins.layer, "privilege");
  // po uplynutí lehoty
  await su(`update public.company_terms_notices set notified_at = now() - interval '31 days', effective_at = now() - interval '1 day', grace_until = now() - interval '1 day' where company_id = '${C2}'`);
  assert.equal((await req()).required_now, true, "po lehote povinné");
  const fn = await su(`select 1 from pg_proc where proname = 'esblu_company_terms_requirement' and (has_function_privilege('authenticated', oid, 'execute') or has_function_privilege('anon', oid, 'execute'))`);
  assert.equal(fn.length, 0, "interná funkcia bez klientského EXECUTE");
});

await check("oznámenie: nevlastník ho nezaznamená; nová firma nepotrebuje oznámenie", async () => {
  const e = await run(admin, "select public.esblu_record_company_terms_notice()");
  assert.match(e.message, /ESBLU_NOT_ACTIVE_OWNER/);
  const o = await run(ownerB, "select (public.esblu_record_company_terms_notice()).company_id c");
  assert.equal(o.layer, "ok", o.message);
  assert.equal(o.data[0].c, null, "nová firma — bez oznámenia (povinné hneď)");
});

await check("osobný gate: terms 1.1 alebo 1.2 používateľa neblokuje; registrácia 1.2 nespôsobí pending 1.1", async () => {
  const U3 = "e2000000-0000-4000-8000-0000000000c3";
  await su(`insert into auth.users (id, email, email_confirmed_at) values ('${U3}', 'new@example.invalid', now())`);
  await su(`insert into auth.sessions (id, user_id) values ('e4000000-0000-4000-8000-0000000000c3', '${U3}')`);
  const u3: Who = { role: "authenticated", uid: U3, session: "e4000000-0000-4000-8000-0000000000c3" };
  const reg = await run(u3, "select public.esblu_accept_legal_document_registration('terms', '1.2', 'sk')", [], true);
  assert.equal(reg.layer, "ok", reg.message);
  const o = await run(u3, "select document_type, version from public.esblu_get_my_pending_required_acceptances() where document_type = 'terms'");
  assert.equal(o.layer, "ok", o.message);
  assert.equal(o.data.length, 0, "novšia prijatá verzia spĺňa staršiu required 1.1");
});

await check("anon: žiadna nová funkcia nie je spustiteľná", async () => {
  for (const fn of ["esblu_accept_company_terms", "esblu_get_my_company_terms_status"]) {
    const a = await su(`select 1 from pg_proc where proname = '${fn}' and has_function_privilege('anon', oid, 'execute')`);
    assert.equal(a.length, 0, fn);
    const auth = await su(`select 1 from pg_proc where proname = '${fn}' and has_function_privilege('authenticated', oid, 'execute')`);
    assert.equal(auth.length, 1, fn);
  }
});

await check("rollback je fail closed pri existujúcich prijatiach VOP 1.2", async () => {
  await assert.rejects(db.exec(read("supabase/rollback/20261112100000_b2b_terms_1_2_company_acceptance_rollback.sql")), /ROLLBACK_BLOCKED/);
});

await check("výmaz firmy archivuje dôkaz VOP (scope company_terms, b2b_confirmed v details)", async () => {
  await su(`delete from public.company_dpa_acceptances where company_id = '${C.a}'`);
  const ev = await su<{ scope: string; details: Record<string, unknown>; company_registration_id: string }>(
    "select scope, details, company_registration_id from public.legal_acceptance_evidence where document_type = 'terms'");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].scope, "company_terms");
  assert.equal(ev[0].details.b2b_confirmed, true);
  assert.equal(ev[0].details.authority_confirmed, true);
  assert.equal(ev[0].company_registration_id, "12345678");
});

await check("rollback + re-apply na čistej DB (bez prijatí) prejde a je idempotentné", async () => {
  await su("alter table public.legal_acceptance_evidence disable trigger all");
  await su("delete from public.legal_acceptance_evidence");
  await su("alter table public.legal_acceptance_evidence enable trigger all");
  await su("delete from public.company_dpa_acceptances");
  await su("delete from public.company_terms_notices");
  await su("delete from public.user_legal_acceptances where document_type = 'terms' and version = '1.2'");
  await su("delete from public.legal_acceptance_evidence");
  await db.exec(read("supabase/rollback/20261112100000_b2b_terms_1_2_company_acceptance_rollback.sql"));
  assert.equal((await su("select 1 from pg_proc where proname = 'esblu_accept_company_terms'")).length, 0);
  assert.equal((await su("select 1 from public.legal_documents where type = 'terms' and version = '1.2'")).length, 0);
  const f = "supabase/migrations/20261112100000_b2b_terms_1_2_company_acceptance.sql";
  await db.exec(read(f));
  await db.exec(read(f));
  assert.equal((await su("select 1 from pg_proc where proname = 'esblu_accept_company_terms'")).length, 1);
  assert.equal((await su("select 1 from public.legal_documents where type = 'terms' and version = '1.2'")).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
