// =============================================================================
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
const service: Who = { role: "service_role" };

const U = {
  ownerA: "d2000000-0000-4000-8000-0000000000a1",
  employeeA: "d2000000-0000-4000-8000-0000000000a4",
  staleUnconfirmed: "d2000000-0000-4000-8000-0000000000e1",
  freshUnconfirmed: "d2000000-0000-4000-8000-0000000000e2",
  staleConfirmed: "d2000000-0000-4000-8000-0000000000e3",
  staleMember: "d2000000-0000-4000-8000-0000000000e4",
};
const C = { a: "d3000000-0000-4000-8000-00000000000a" };
const S = { ownerA: "d4000000-0000-4000-8000-0000000000a1", employeeA: "d4000000-0000-4000-8000-0000000000a4" };
const ownerA: Who = { role: "authenticated", uid: U.ownerA, session: S.ownerA };
const employeeA: Who = { role: "authenticated", uid: U.employeeA, session: S.employeeA };
const anon: Who = { role: "anon" };

await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, created_at) values
    ('${U.ownerA}', 'oa@example.invalid', now() - interval '200 days', now() - interval '200 days'),
    ('${U.employeeA}', 'ea@example.invalid', now() - interval '200 days', now() - interval '200 days'),
    ('${U.staleUnconfirmed}', 'su@example.invalid', null, now() - interval '45 days'),
    ('${U.freshUnconfirmed}', 'fu@example.invalid', null, now() - interval '5 days'),
    ('${U.staleConfirmed}', 'sc@example.invalid', now() - interval '44 days', now() - interval '45 days'),
    ('${U.staleMember}', 'sm@example.invalid', null, now() - interval '45 days');
  insert into auth.sessions (id, user_id) values ('${S.ownerA}', '${U.ownerA}'), ('${S.employeeA}', '${U.employeeA}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.ownerA}', 'Firma A');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.ownerA}', 'owner', 'active', '{}'),
    ('${C.a}', '${U.employeeA}', 'employee', 'active', '{}'),
    ('${C.a}', '${U.staleMember}', 'employee', 'active', '{}');
  set session_replication_role = origin;
`);

// ----------------------------------------------------------------------------- legal verzie
await check("legal_documents: privacy_policy 1.4 required, cookie_policy 1.1 nie required, hash = SK súbor", async () => {
  const rows = await su<{ type: string; version: string; required: boolean; content_hash: string }>(
    "select type, version, required, content_hash from public.legal_documents where (type, version) in (('privacy_policy','1.4'),('cookie_policy','1.1')) order by type"
  );
  assert.equal(rows.length, 2);
  const { createHash } = await import("node:crypto");
  const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(ROOT, p))).digest("hex");
  const cookie = rows.find((r) => r.type === "cookie_policy")!;
  const privacy = rows.find((r) => r.type === "privacy_policy")!;
  assert.equal(cookie.required, false);
  assert.equal(privacy.required, true);
  assert.equal(cookie.content_hash, sha("legal/cookies/1.1.md"));
  assert.equal(privacy.content_hash, sha("legal/privacy/1.4.md"));
});

await check("legal gate: používateľ s privacy 1.3 + terms 1.1 má pending privacy_policy 1.4 (+ terms 1.2 od B2B VOP)", async () => {
  await su(`insert into public.user_legal_acceptances (user_id, document_type, version, acceptance_method) values
    ('${U.employeeA}', 'terms', '1.1', 'registration'), ('${U.employeeA}', 'privacy_policy', '1.3', 'registration')`);
  const o = await run(employeeA, "select * from public.esblu_get_my_pending_required_acceptances()");
  assert.equal(o.layer, "ok", o.message);
  const pending = o.data.map((r) => `${r.document_type ?? r.type}:${r.version}`);
  // 20261112100000: VOP 1.2 (required) → osobný re-accept aj pre terms.
  assert.deepEqual([...pending].sort(), ["privacy_policy:1.4", "terms:1.2"]);
});

// ----------------------------------------------------------------------------- technická retencia
await check("retencia: maže iba záznamy nad maximom CLIA, zvyšok ostáva", async () => {
  await db.exec(`
    set session_replication_role = replica;
    insert into public.push_devices (user_id, company_id, provider, platform, token, installation_id, revoked_at, revoke_reason) values
      ('${U.ownerA}', '${C.a}', 'fcm', 'android', repeat('a', 40), gen_random_uuid(), now() - interval '31 days', 'unregistered'),
      ('${U.ownerA}', '${C.a}', 'fcm', 'android', repeat('b', 40), gen_random_uuid(), now() - interval '29 days', 'unregistered'),
      ('${U.ownerA}', '${C.a}', 'fcm', 'android', repeat('c', 40), gen_random_uuid(), null, null);
    insert into public.push_subscriptions (user_id, company_id, endpoint, p256dh, auth_secret, revoked_at) values
      ('${U.ownerA}', '${C.a}', 'https://push.example/old', repeat('p', 60), repeat('s', 20), now() - interval '40 days'),
      ('${U.ownerA}', '${C.a}', 'https://push.example/active', repeat('p', 60), repeat('s', 20), null);
    insert into public.notification_deliveries (user_id, company_id, kind, dedupe_key, sent_at) values
      ('${U.ownerA}', '${C.a}', 'deadline', 'deadline:vehicle_stk:x:2026-01-01:overdue', now() - interval '91 days'),
      ('${U.ownerA}', '${C.a}', 'deadline', 'deadline:vehicle_stk:x:2026-12-01:30', now() - interval '10 days'),
      ('${U.ownerA}', '${C.a}', 'chat', 'chat:old', now() - interval '95 days');
    insert into public.company_invites (company_id, email, role, invited_by, token_hash, status, created_at, expires_at, accepted_at, revoked_at) values
      ('${C.a}', 'expired-old@example.invalid', 'employee', '${U.ownerA}', repeat('1', 64), 'pending', now() - interval '60 days', now() - interval '31 days', null, null),
      ('${C.a}', 'expired-fresh@example.invalid', 'employee', '${U.ownerA}', repeat('2', 64), 'pending', now() - interval '20 days', now() - interval '10 days', null, null),
      ('${C.a}', 'revoked-old@example.invalid', 'employee', '${U.ownerA}', repeat('3', 64), 'revoked', now() - interval '60 days', now() - interval '50 days', null, now() - interval '40 days'),
      ('${C.a}', 'accepted@example.invalid', 'employee', '${U.ownerA}', repeat('4', 64), 'accepted', now() - interval '300 days', now() - interval '293 days', now() - interval '299 days', null),
      ('${C.a}', 'pending@example.invalid', 'employee', '${U.ownerA}', repeat('5', 64), 'pending', now() - interval '1 day', now() + interval '6 days', null, null);
    insert into public.account_deletion_cleanup_jobs (kind, user_id, company_id, storage_status, auth_status, created_at, updated_at, completed_at) values
      ('member', gen_random_uuid(), null, 'done', 'done', now() - interval '100 days', now() - interval '100 days', now() - interval '100 days'),
      ('member', gen_random_uuid(), null, 'done', 'done', now() - interval '10 days', now() - interval '10 days', now() - interval '10 days'),
      ('owner', gen_random_uuid(), null, 'pending', 'pending', now() - interval '200 days', now() - interval '200 days', null);
    insert into public.media_deletion_queue (company_id, bucket_id, object_path, completed_at) values
      ('${C.a}', 'vehicle-photos', '${C.a}/old.jpg', now() - interval '91 days'),
      ('${C.a}', 'vehicle-photos', '${C.a}/fresh.jpg', now() - interval '1 day'),
      ('${C.a}', 'vehicle-photos', '${C.a}/pending.jpg', null);
    set session_replication_role = origin;
  `);

  const o = await run(service, "select public.esblu_purge_gdpr_technical_retention(1000) r", [], true);
  assert.equal(o.layer, "ok", o.message);
  const r = o.data[0].r as Record<string, number>;
  assert.equal(r.push_devices, 1);
  assert.equal(r.push_subscriptions, 1);
  assert.equal(r.notification_deliveries, 2);
  assert.equal(r.company_invites, 2);
  assert.equal(r.account_deletion_jobs, 1);
  assert.equal(r.media_deletion_queue, 1);

  assert.equal((await su("select 1 from public.push_devices")).length, 2);
  assert.deepEqual((await su<{ e: string }>("select endpoint e from public.push_subscriptions")).map((x) => x.e), ["https://push.example/active"]);
  assert.deepEqual((await su<{ k: string }>("select dedupe_key k from public.notification_deliveries")).map((x) => x.k), ["deadline:vehicle_stk:x:2026-12-01:30"]);
  assert.deepEqual(
    (await su<{ e: string }>("select email e from public.company_invites order by e")).map((x) => x.e),
    ["accepted@example.invalid", "expired-fresh@example.invalid", "pending@example.invalid"]
  );
  assert.deepEqual((await su<{ s: string }>("select storage_status s from public.account_deletion_cleanup_jobs order by created_at")).map((x) => x.s), ["pending", "done"]);
  assert.equal((await su("select 1 from public.media_deletion_queue")).length, 2);

  const again = await run(service, "select public.esblu_purge_gdpr_technical_retention(1000) r", [], true);
  assert.ok(Object.values(again.data[0].r as Record<string, number>).every((n) => n === 0), "druhý beh je no-op");
});

await check("neúspešné registrácie: iba nepotvrdené bez členstva a firmy staršie ako 30 dní", async () => {
  const o = await run(service, "select array_agg(x) ids from public.esblu_list_stale_unconfirmed_auth_users(30, 50) x");
  assert.equal(o.layer, "ok", o.message);
  assert.deepEqual(o.data[0].ids, [U.staleUnconfirmed]);
  const floor = await run(service, "select count(*)::int n from public.esblu_list_stale_unconfirmed_auth_users(1, 50)");
  assert.equal(floor.data[0].n, 1, "minimum 30 dní — kratšia lehota sa nedá vynútiť");
});

await check("klient (owner / employee / anon) nevie spustiť purge ani výber účtov", async () => {
  for (const who of [ownerA, employeeA, anon]) {
    for (const sql of ["select public.esblu_purge_gdpr_technical_retention(10)", "select * from public.esblu_list_stale_unconfirmed_auth_users(30, 10)"]) {
      const o = await run(who, sql);
      assert.equal(o.layer, "privilege", `${who.role}: ${sql} → ${o.layer} ${o.message}`);
    }
  }
});

// ----------------------------------------------------------------------------- technický výmaz chat príloh
await check("zrušenie firmy: storage_targets obsahujú aj chat-attachments", async () => {
  await db.exec(`
    set session_replication_role = replica;
    insert into public.chat_conversations (id, company_id, type) values ('d5000000-0000-4000-8000-000000000001', '${C.a}', 'company');
    insert into public.chat_messages (id, conversation_id, company_id, author_id, body) values
      ('d6000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', '${C.a}', '${U.ownerA}', 'x');
    insert into public.chat_attachments (message_id, company_id, storage_bucket, storage_path, mime_type, file_size) values
      ('d6000000-0000-4000-8000-000000000001', '${C.a}', 'chat-attachments', '${C.a}/chat/file.pdf', 'application/pdf', 10);
    set session_replication_role = origin;
  `);
  const o = await run(service, "select public.esblu_account_deletion_commit('owner', $1, $2, false) r", [U.ownerA, C.a]);
  assert.equal(o.layer, "ok", o.message);
  const targets = (o.data[0].r as { storage_targets: { bucket: string; path: string }[] }).storage_targets;
  assert.ok(
    targets.some((t) => t.bucket === "chat-attachments" && t.path === `${C.a}/chat/file.pdf`),
    JSON.stringify(targets)
  );
});

// ----------------------------------------------------------------------------- rollback + re-apply
await check("rollback oboch J10 migrácií prejde, vráti stav a migrácie sa dajú znovu aplikovať (idempotentne)", async () => {
  await db.exec(read("supabase/rollback/20261110110000_clia_privacy_1_4_cookies_1_1_rollback.sql"));
  await db.exec(read("supabase/rollback/20261110100000_clia_gdpr_retention_alignment_rollback.sql"));
  assert.equal((await su("select 1 from public.legal_documents where (type, version) in (('privacy_policy','1.4'),('cookie_policy','1.1'))")).length, 0);
  assert.equal((await su("select 1 from pg_proc where proname in ('esblu_purge_gdpr_technical_retention','esblu_list_stale_unconfirmed_auth_users')")).length, 0);
  const def = (await su<{ d: string }>("select pg_get_functiondef('public.esblu_account_deletion_commit(text,uuid,uuid,boolean)'::regprocedure) d"))[0].d;
  assert.ok(!def.includes("chat_attachments"), "rollback vrátil pôvodnú definíciu");
  // trigger proti DELETE je po rollbacku znova zapnutý
  await assert.rejects(db.exec("delete from public.legal_documents where type = 'terms' and version = '1.1'"));
  for (const f of ["20261110100000_clia_gdpr_retention_alignment.sql", "20261110110000_clia_privacy_1_4_cookies_1_1.sql"]) {
    await db.exec(read(`supabase/migrations/${f}`));
    await db.exec(read(`supabase/migrations/${f}`));
  }
  assert.equal((await su("select 1 from public.legal_documents where (type, version) in (('privacy_policy','1.4'),('cookie_policy','1.1'))")).length, 2);
  const def2 = (await su<{ d: string }>("select pg_get_functiondef('public.esblu_account_deletion_commit(text,uuid,uuid,boolean)'::regprocedure) d"))[0].d;
  assert.ok(def2.includes("chat_attachments"));
  const grants = await su<{ g: string }>("select grantee::text g from information_schema.routine_privileges where routine_name = 'esblu_purge_gdpr_technical_retention' and privilege_type = 'EXECUTE' order by 1");
  assert.deepEqual(grants.map((r) => r.g).filter((g) => g !== "postgres"), ["service_role"]);
});

await check("rollback legal seedu je fail closed, keď už existuje potvrdenie 1.4", async () => {
  await su(`insert into public.user_legal_acceptances (user_id, document_type, version, acceptance_method) values ('${U.ownerA}', 'privacy_policy', '1.4', 'legal_gate') on conflict do nothing`);
  await assert.rejects(db.exec(read("supabase/rollback/20261110110000_clia_privacy_1_4_cookies_1_1_rollback.sql")), /ROLLBACK_BLOCKED/);
  assert.equal((await su("select 1 from public.legal_documents where type = 'privacy_policy' and version = '1.4'")).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
