// =============================================================================
// Push notifikácie — SKUTOČNÝ PostgreSQL test (PGlite) pre
//   20260927110000_push_notifications.sql (tabuľky),
//   20261001130000_push_devices_session_binding.sql (natívne zariadenia,
//   väzba na session, RPC),
// nad M1 Human Chat modelom (20260930150000 — doslovne z repa).
//
// Matica rolí: owner / admin / accountant / employee / neaktívny člen /
// vlastník INEJ firmy. NIKDY sa nepripája na Supabase.
//
// SPUSTENIE (PGlite nie je závislosť projektu):
//   npm i --no-save @electric-sql/pglite@0.5.8
//   npm run test:push-db
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

async function loadPglite(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  const crypto = dir ? pathToFileURL(path.join(dir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto";
  try {
    const { PGlite } = await import(main);
    const { pgcrypto } = await import(crypto);
    return new PGlite({ extensions: { pgcrypto } }) as Db;
  } catch (error) {
    console.error("PGlite nie je nainštalovaný: npm i --no-save @electric-sql/pglite@0.5.8  (alebo PGLITE_DIR=…)");
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Schéma: prod-verná kostra + Supabase auth stuby + chat tabuľky (prod stĺpce)
// -----------------------------------------------------------------------------
await db.exec(read("scripts/sql/pglite/m1-authz-baseline.sql"));
await db.exec(`
  create table auth.users (id uuid primary key);
  -- auth.sessions: prod stĺpce, ktoré migrácia používa (id, user_id, not_after).
  create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, not_after timestamptz);
  create function auth.jwt() returns jsonb language sql stable as $f$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
  $f$;
  grant execute on function auth.jwt() to anon, authenticated;
  grant usage on schema public, auth to service_role;

  create table public.chat_conversations (
    id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
    type text not null, direct_user_low uuid, direct_user_high uuid, created_at timestamptz default now(), created_by uuid);
  create table public.chat_conversation_members (
    id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.chat_conversations(id),
    company_id uuid not null, user_id uuid not null, last_read_at timestamptz, joined_at timestamptz default now(),
    unique (conversation_id, user_id));
  create table public.chat_messages (
    id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.chat_conversations(id),
    company_id uuid not null, author_id uuid, body text not null default '', created_at timestamptz default now(),
    edited_at timestamptz, deleted_at timestamptz);
  create table public.chat_attachments (
    id uuid primary key default gen_random_uuid(), message_id uuid not null, company_id uuid not null,
    storage_bucket text not null default 'chat-attachments', storage_path text not null);
  create table public.chat_message_references (
    id uuid primary key default gen_random_uuid(), message_id uuid not null, company_id uuid not null,
    entity_type text not null, entity_id uuid not null);
  create or replace function public.esblu_can_read_document(p_id uuid) returns boolean language sql stable as $f$ select false $f$;
  grant select, insert, update on public.chat_conversations, public.chat_conversation_members, public.chat_messages to authenticated;
`);
// Supabase default privileges: nové tabuľky a funkcie v public dostanú granty
// pre anon/authenticated/service_role. Bez tejto emulácie by testy grantov
// prechádzali aj vtedy, keby migrácia zabudla na revoke.
await db.exec(`
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
for (const migration of [
  "supabase/migrations/20260930150000_m1_authz_human_chat_membership.sql",
  "supabase/migrations/20260927110000_push_notifications.sql",
  "supabase/migrations/20261001130000_push_devices_session_binding.sql",
]) {
  await db.exec(read(migration));
}
// Idempotencia: druhé spustenie migrácie nezlyhá.
await check("migrácia 20261001130000 je idempotentná (druhé spustenie)", async () => {
  await db.exec(read("supabase/migrations/20261001130000_push_devices_session_binding.sql"));
});

// -----------------------------------------------------------------------------
// Dáta
// -----------------------------------------------------------------------------
const CA = "a0000000-0000-4000-8000-000000000001";
const CB = "b0000000-0000-4000-8000-000000000002";
const U = {
  owner: "10000000-0000-4000-8000-000000000001",
  admin: "10000000-0000-4000-8000-000000000002",
  acc: "10000000-0000-4000-8000-000000000003",
  emp: "10000000-0000-4000-8000-000000000004",
  emp2: "10000000-0000-4000-8000-000000000005",
  gone: "10000000-0000-4000-8000-000000000006",
  b: "20000000-0000-4000-8000-000000000001",
};
const S: Record<keyof typeof U, string> = {
  owner: "5e000000-0000-4000-8000-000000000001",
  admin: "5e000000-0000-4000-8000-000000000002",
  acc: "5e000000-0000-4000-8000-000000000003",
  emp: "5e000000-0000-4000-8000-000000000004",
  emp2: "5e000000-0000-4000-8000-000000000005",
  gone: "5e000000-0000-4000-8000-000000000006",
  b: "5e000000-0000-4000-8000-000000000007",
};
await db.exec(`
  insert into public.companies values ('${CA}', 'A'), ('${CB}', 'B');
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into auth.sessions (id, user_id) values ${(Object.keys(U) as (keyof typeof U)[]).map((k) => `('${S[k]}', '${U[k]}')`).join(", ")};
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${CA}', '${U.owner}', 'owner', 'active', '{}'),
    ('${CA}', '${U.admin}', 'admin', 'active', '{}'),
    ('${CA}', '${U.acc}', 'accountant', 'active', '{}'),
    ('${CA}', '${U.emp}', 'employee', 'active', '{}'),
    ('${CA}', '${U.emp2}', 'employee', 'active', '{}'),
    ('${CA}', '${U.gone}', 'employee', 'disabled', '{}'),
    ('${CB}', '${U.b}', 'owner', 'active', '{}');
`);

const uuid = () => crypto.randomUUID();
const fcmToken = () => `fcm_${uuid().replace(/-/g, "")}:APA91b${"x".repeat(100)}`;
const apnsToken = () => (uuid() + uuid()).replace(/-/g, "");

async function as<T>(uid: string, fn: () => Promise<T>, claims: Record<string, unknown> = {}): Promise<T> {
  const key = (Object.keys(U) as (keyof typeof U)[]).find((k) => U[k] === uid);
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", session_id: key ? S[key] : undefined, ...claims }),
    ]);
    await db.exec("set local role authenticated");
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec("set local role service_role");
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
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
async function register(uid: string, token: string, installation: string, opts: { provider?: string; platform?: string; locale?: string; claims?: Record<string, unknown> } = {}) {
  const { rows } = await as(
    uid,
    () =>
      db.query<{ r: string }>("select public.esblu_push_register_device($1, $2, $3, $4, $5, $6) r", [
        opts.provider ?? "fcm",
        opts.platform ?? "android",
        token,
        installation,
        opts.locale ?? "sk",
        "1.0.0",
      ]),
    opts.claims
  );
  return rows[0].r;
}
async function device(token: string) {
  const { rows } = await db.query<{ user_id: string; company_id: string; auth_session_id: string; revoked_at: string | null; revoke_reason: string | null; locale: string }>(
    "select user_id, company_id, auth_session_id, revoked_at, revoke_reason, locale from public.push_devices where token = $1",
    [token]
  );
  return rows[0];
}
async function targets(companyId: string, userIds: string[]) {
  const { rows } = await asService(() =>
    db.query<{ target_kind: string; target_id: string; user_id: string; locale: string; token: string | null; endpoint: string | null }>(
      "select * from public.esblu_push_delivery_targets($1, $2::uuid[])",
      [companyId, userIds]
    )
  );
  return rows;
}

// =============================================================================
// Registrácia — väzba na auth user + firma + session (nikdy z parametrov)
// =============================================================================
const TOK: Record<string, string> = {};
await check("registrácia: owner/admin/accountant/employee → riadok vlastnej firmy, vlastný user, session z JWT", async () => {
  for (const role of ["owner", "admin", "acc", "emp"] as const) {
    TOK[role] = fcmToken();
    assert.equal(await register(U[role], TOK[role], uuid()), "registered", role);
    const row = await device(TOK[role]);
    assert.equal(row.user_id, U[role], role);
    assert.equal(row.company_id, CA, role);
    assert.equal(row.auth_session_id, S[role], role);
  }
});
await check("registrácia: RPC nemá parameter user/company — token za iného usera zaregistrovať nejde", async () => {
  const { rows } = await db.query<{ args: string }>(
    "select pg_get_function_identity_arguments('public.esblu_push_register_device(text,text,text,uuid,text,text)'::regprocedure) args"
  );
  assert.ok(!/p_(user|company|session)/i.test(rows[0].args.replace("p_user_agent", "")), rows[0].args);
  const web = await db.query<{ args: string }>(
    "select pg_get_function_identity_arguments('public.esblu_push_register_web(text,text,text,text,text)'::regprocedure) args"
  );
  assert.ok(!/p_(user|company|session)/i.test(web.rows[0].args.replace("p_user_agent", "")), web.rows[0].args);
});
await check("registrácia: bez session_id v JWT, bez prihlásenia, neaktívny člen → odmietnuté", async () => {
  await fails(() => register(U.emp, fcmToken(), uuid(), { claims: { session_id: undefined } }), /ESBLU_PUSH_SESSION_REQUIRED/);
  await fails(() => register(U.emp, fcmToken(), uuid(), { claims: { session_id: "not-a-uuid" } }), /ESBLU_PUSH_SESSION_REQUIRED/);
  await fails(() => register(U.gone, fcmToken(), uuid()), /ESBLU_NO_ACTIVE_COMPANY/);
  await fails(
    () => as(U.emp, () => db.query("select public.esblu_push_register_device('fcm','android',$1,$2,'sk',null)", [fcmToken(), uuid()]), { sub: "" }),
    /NOT_AUTHENTICATED/
  );
});
await check("registrácia: neplatný tvar tokenu / provider / platforma / verzia → 22023", async () => {
  for (const [token, provider, platform] of [
    ["short", "fcm", "android"],
    ["x".repeat(40) + " evil", "fcm", "android"],
    [fcmToken(), "apns", "android"],
    [fcmToken(), "webpush", "web"],
    ["https://evil.example/" + "x".repeat(40), "fcm", "android"],
  ]) {
    await fails(() => register(U.emp, token, uuid(), { provider, platform }), /ESBLU_PUSH_INVALID_DEVICE/);
  }
  await fails(
    () => as(U.emp, () => db.query("select public.esblu_push_register_device('fcm','android',$1,$2,'sk','1.0; drop')", [fcmToken(), uuid()])),
    /ESBLU_PUSH_INVALID_DEVICE/
  );
});
await check("idempotencia: opakovaná registrácia → 'refreshed', stále 1 riadok", async () => {
  const token = fcmToken();
  const install = uuid();
  assert.equal(await register(U.emp2, token, install), "registered");
  assert.equal(await register(U.emp2, token, install), "refreshed");
  assert.equal(await register(U.emp2, token, install, { locale: "de" }), "refreshed");
  const { rows } = await db.query<{ n: number }>("select count(*)::int n from public.push_devices where token = $1", [token]);
  assert.equal(rows[0].n, 1);
  assert.equal((await device(token)).locale, "de", "jazyk zariadenia sa aktualizuje");
});
await check("token refresh: nový token tej istej inštalácie nahradí starý (replaced), aktívny je práve jeden", async () => {
  const install = uuid();
  const oldToken = fcmToken();
  const newToken = fcmToken();
  await register(U.admin, oldToken, install);
  assert.equal(await register(U.admin, newToken, install), "registered");
  assert.equal((await device(oldToken)).revoke_reason, "replaced");
  assert.equal((await device(newToken)).revoked_at, null);
  const { rows } = await db.query<{ n: number }>("select count(*)::int n from public.push_devices where installation_id = $1 and revoked_at is null", [install]);
  assert.equal(rows[0].n, 1);
});
await check("multi-device: Android + iPhone (APNs) toho istého používateľa → oba ciele", async () => {
  const android = fcmToken();
  const ios = apnsToken();
  await register(U.owner, android, uuid());
  assert.equal(await register(U.owner, ios, uuid(), { provider: "apns", platform: "ios" }), "registered");
  const list = await targets(CA, [U.owner]);
  const tokens = list.map((t) => t.token);
  assert.ok(tokens.includes(android) && tokens.includes(ios) && tokens.includes(TOK.owner));
  assert.ok(list.some((t) => t.target_kind === "apns") && list.some((t) => t.target_kind === "fcm"));
});
await check("cudzí aktívny token z inej inštalácie sa NEPREVEZME (conflict), pôvodný riadok nedotknutý", async () => {
  assert.equal(await register(U.emp, TOK.owner, uuid()), "conflict");
  const row = await device(TOK.owner);
  assert.equal(row.user_id, U.owner);
  assert.equal(row.revoked_at, null);
  assert.equal(await register(U.b, TOK.owner, uuid()), "conflict", "cudzia firma tiež nie");
});
await check("tá istá inštalácia, iný používateľ (prepnutie účtu na zariadení) → token prejde na nového používateľa", async () => {
  const install = uuid();
  const token = fcmToken();
  await register(U.emp, token, install);
  assert.equal(await register(U.acc, token, install), "refreshed");
  const row = await device(token);
  assert.equal(row.user_id, U.acc);
  assert.equal(row.auth_session_id, S.acc);
  assert.ok(!(await targets(CA, [U.emp])).some((t) => t.token === token), "pôvodný používateľ ho už nedostane");
});
await check("cross-company: zariadenie firmy B nie je cieľom firmy A (ani pri explicitnom user_id)", async () => {
  const token = fcmToken();
  await register(U.b, token, uuid());
  assert.equal((await device(token)).company_id, CB);
  assert.equal((await targets(CA, [U.b])).length, 0);
  assert.ok((await targets(CB, [U.b])).some((t) => t.token === token));
  assert.ok(!(await targets(CB, [U.owner, U.emp])).length, "členovia A nie sú cieľmi firmy B");
});

// =============================================================================
// Priamy prístup a serverové funkcie
// =============================================================================
await check("authenticated: žiadny priamy prístup k push_devices / push_subscriptions / preferences / deliveries", async () => {
  for (const sql of [
    "select count(*) from public.push_devices",
    "select count(*) from public.push_subscriptions",
    "select count(*) from public.notification_preferences",
    "select count(*) from public.notification_deliveries",
    `insert into public.push_devices (user_id, company_id, provider, platform, token, installation_id) values ('${U.emp}', '${CA}', 'fcm', 'android', '${fcmToken()}', '${uuid()}')`,
    `update public.push_devices set user_id = '${U.emp}'`,
  ]) {
    await fails(() => as(U.emp, () => db.query(sql)), /permission denied/);
  }
});
await check("authenticated (aj owner): serverové RPC (ciele, príjemcovia, výsledok, upratanie) zakázané", async () => {
  for (const sql of [
    `select * from public.esblu_push_delivery_targets('${CA}', array['${U.owner}']::uuid[])`,
    `select * from public.esblu_push_chat_recipients('${uuid()}')`,
    `select public.esblu_push_record_outcome('fcm', '${uuid()}', 'invalid')`,
    "select public.esblu_push_revoke_ended()",
    "select * from public.esblu_push_companies_with_targets()",
    "select public.esblu_push_current_session_id()",
  ]) {
    await fails(() => as(U.owner, () => db.query(sql)), /permission denied/);
  }
  for (const sql of ["select public.esblu_push_register_device('fcm','android','x','00000000-0000-4000-8000-000000000000','sk',null)"]) {
    await fails(async () => {
      await db.exec("begin");
      try {
        await db.exec("set local role anon");
        await db.query(sql);
      } finally {
        await db.exec("rollback");
      }
    }, /permission denied/);
  }
});
await check("my_devices: iba vlastné zariadenia aktívnej firmy, bez tokenu/endpointu", async () => {
  const { rows } = await as(U.owner, () => db.query<Row>("select * from public.esblu_push_my_devices()"));
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.ok(!("token" in row) && !("endpoint" in row));
  }
  assert.ok(rows.some((r) => r.current_session === true));
  const other = await as(U.emp2, () => db.query<Row>("select * from public.esblu_push_my_devices()"));
  assert.ok(other.rows.length >= 1 && other.rows.length < rows.length + 5);
});

// =============================================================================
// Odhlásenie, session, členstvo, neplatné tokeny
// =============================================================================
await check("odhlásenie zariadenia: iba vlastné (cudzí installation_id → 0), po odhlásení nie je cieľom", async () => {
  const install = uuid();
  const token = fcmToken();
  await register(U.emp, token, install);
  const foreign = await as(U.acc, () => db.query<{ n: number }>("select public.esblu_push_unregister_device($1, $2) n", [install, token]));
  assert.equal(foreign.rows[0].n, 0);
  assert.equal((await device(token)).revoked_at, null);
  const own = await as(U.emp, () => db.query<{ n: number }>("select public.esblu_push_unregister_device($1, null) n", [install]));
  assert.equal(own.rows[0].n, 1);
  assert.equal((await device(token)).revoke_reason, "unregistered");
  assert.ok(!(await targets(CA, [U.emp])).some((t) => t.token === token));
});
await check("zrušená session (odhlásenie inde / reset hesla): starý token sa nedoručí a upratanie ho zruší", async () => {
  const token = fcmToken();
  await register(U.emp2, token, uuid());
  assert.ok((await targets(CA, [U.emp2])).some((t) => t.token === token));
  await db.query("delete from auth.sessions where id = $1", [S.emp2]);
  assert.ok(!(await targets(CA, [U.emp2])).some((t) => t.token === token), "session neexistuje → žiadny cieľ");
  const { rows } = await asService(() => db.query<{ n: number }>("select public.esblu_push_revoke_ended() n"));
  assert.ok(rows[0].n >= 1);
  assert.equal((await device(token)).revoke_reason, "session_ended");
  // Nové prihlásenie = nová session → registrácia zariadenie znovu oživí.
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [S.emp2, U.emp2]);
  assert.equal(await register(U.emp2, token, uuid()), "refreshed");
  assert.equal((await device(token)).revoked_at, null);
});
await check("expirovaná session (not_after v minulosti) → žiadny cieľ", async () => {
  await db.query("update auth.sessions set not_after = now() - interval '1 minute' where id = $1", [S.admin]);
  assert.equal((await targets(CA, [U.admin])).length, 0);
  await db.query("update auth.sessions set not_after = null where id = $1", [S.admin]);
  assert.ok((await targets(CA, [U.admin])).length > 0);
});
await check("odobratie z firmy: zariadenie sa nedoručí, upratanie → membership_ended", async () => {
  await db.query("update public.company_members set status = 'disabled' where user_id = $1", [U.acc]);
  assert.equal((await targets(CA, [U.acc])).length, 0);
  await asService(() => db.query("select public.esblu_push_revoke_ended()"));
  assert.equal((await device(TOK.acc)).revoke_reason, "membership_ended");
  await db.query("update public.company_members set status = 'active' where user_id = $1", [U.acc]);
  assert.equal((await targets(CA, [U.acc])).some((t) => t.token === TOK.acc), false, "zrušený riadok sa sám neoživí");
});
await check("neplatný token (FCM UNREGISTERED / APNs 410) → record_outcome zruší, 'sent' zapíše úspech", async () => {
  const [target] = (await targets(CA, [U.admin])).filter((t) => t.token === TOK.admin);
  assert.ok(target);
  await asService(() => db.query("select public.esblu_push_record_outcome('fcm', $1, 'sent')", [target.target_id]));
  const ok = await db.query<{ last_success_at: string | null }>("select last_success_at from public.push_devices where id = $1", [target.target_id]);
  assert.ok(ok.rows[0].last_success_at);
  await asService(() => db.query("select public.esblu_push_record_outcome('fcm', $1, 'invalid')", [target.target_id]));
  assert.equal((await device(TOK.admin)).revoke_reason, "invalid_token");
  assert.equal((await targets(CA, [U.admin])).some((t) => t.token === TOK.admin), false);
});

// =============================================================================
// Web push cez RPC (väzba na session, vlastníctvo endpointu)
// =============================================================================
const endpoint = (n: string) => `https://push.example.invalid/${n}-${uuid()}`;
const webKeys = ["B".repeat(87), "a".repeat(22)];
async function registerWeb(uid: string, ep: string, locale = "sk") {
  const { rows } = await as(uid, () =>
    db.query<{ r: string }>("select public.esblu_push_register_web($1, $2, $3, $4, 'test-agent') r", [ep, webKeys[0], webKeys[1], locale])
  );
  return rows[0].r;
}
await check("web push: registrácia s jazykom a session, idempotentná; cudzí aktívny endpoint → conflict", async () => {
  const ep = endpoint("owner");
  assert.equal(await registerWeb(U.owner, ep, "en"), "registered");
  assert.equal(await registerWeb(U.owner, ep, "en"), "refreshed");
  assert.equal(await registerWeb(U.emp, ep), "conflict");
  assert.equal(await registerWeb(U.b, ep), "conflict");
  const t = (await targets(CA, [U.owner])).find((row) => row.endpoint === ep);
  assert.ok(t && t.target_kind === "webpush" && t.locale === "en");
  await fails(() => registerWeb(U.owner, "http://insecure.example/x"), /ESBLU_PUSH_INVALID_DEVICE/);
});
await check("web push: odhlásenie iba vlastného endpointu; zrušený endpoint prevezme nový používateľ", async () => {
  const ep = endpoint("emp");
  await registerWeb(U.emp, ep);
  const foreign = await as(U.owner, () => db.query<{ n: number }>("select public.esblu_push_unregister_web($1) n", [ep]));
  assert.equal(foreign.rows[0].n, 0);
  const own = await as(U.emp, () => db.query<{ n: number }>("select public.esblu_push_unregister_web($1) n", [ep]));
  assert.equal(own.rows[0].n, 1);
  assert.equal(await registerWeb(U.emp2, ep), "refreshed");
  assert.ok((await targets(CA, [U.emp2])).some((row) => row.endpoint === ep));
  assert.ok(!(await targets(CA, [U.emp])).some((row) => row.endpoint === ep));
});

// =============================================================================
// Human Chat príjemcovia — presne podľa M1 membership modelu
// =============================================================================
const CH_COMPANY = "c1000000-0000-4000-8000-000000000001";
const CH_DIRECT = "c1000000-0000-4000-8000-000000000002";
const CH_B = "c1000000-0000-4000-8000-000000000003";
const [low, high] = [U.owner, U.emp].sort();
await db.exec(`
  insert into public.chat_conversations (id, company_id, type) values ('${CH_COMPANY}', '${CA}', 'company'), ('${CH_B}', '${CB}', 'company');
  insert into public.chat_conversations (id, company_id, type, direct_user_low, direct_user_high) values ('${CH_DIRECT}', '${CA}', 'direct', '${low}', '${high}');
  insert into public.chat_conversation_members (conversation_id, company_id, user_id) values
    ('${CH_DIRECT}', '${CA}', '${U.owner}'), ('${CH_DIRECT}', '${CA}', '${U.emp}'),
    -- read pointer admina vo firemnom kanáli + podvrhnutý riadok v direct (neoprávňuje)
    ('${CH_COMPANY}', '${CA}', '${U.admin}'), ('${CH_DIRECT}', '${CA}', '${U.admin}');
`);
async function message(conversation: string, company: string, author: string | null, deleted = false) {
  const id = uuid();
  await db.query("insert into public.chat_messages (id, conversation_id, company_id, author_id, body, deleted_at) values ($1, $2, $3, $4, 'x', $5)", [
    id,
    conversation,
    company,
    author,
    deleted ? new Date().toISOString() : null,
  ]);
  return id;
}
async function recipients(messageId: string) {
  const { rows } = await asService(() => db.query<{ r: string }>("select r from public.esblu_push_chat_recipients($1) r", [messageId]));
  return rows.map((row) => row.r).sort();
}
await check("chat push: firemný kanál → všetci aktívni členovia firmy okrem autora (aj zamestnanec a účtovník)", async () => {
  const id = await message(CH_COMPANY, CA, U.emp);
  assert.deepEqual(await recipients(id), [U.owner, U.admin, U.acc, U.emp2].sort());
});
await check("chat push: direct → iba druhý účastník; admin/owner mimo dvojice nie (ani s podvrhnutým riadkom)", async () => {
  assert.deepEqual(await recipients(await message(CH_DIRECT, CA, U.owner)), [U.emp]);
  assert.deepEqual(await recipients(await message(CH_DIRECT, CA, U.emp)), [U.owner]);
});
await check("chat push: cudzia firma, neaktívny člen, zmazaná správa, nesúlad firmy → nikto navyše", async () => {
  const b = await recipients(await message(CH_B, CB, U.b));
  assert.deepEqual(b, [], "firma B má iba autora");
  assert.ok(!(await recipients(await message(CH_COMPANY, CA, U.owner))).includes(U.gone));
  assert.deepEqual(await recipients(await message(CH_COMPANY, CA, U.owner, true)), []);
  assert.deepEqual(await recipients(await message(CH_COMPANY, CB, U.b)), [], "správa firmy B v konverzácii firmy A");
});
await check("chat push = esblu_chat_can_access_conversation: príjemca smie konverzáciu čítať, ostatní nie", async () => {
  for (const conv of [CH_COMPANY, CH_DIRECT]) {
    const author = U.owner;
    const got = await recipients(await message(conv, CA, author));
    for (const [key, uid] of Object.entries(U)) {
      if (uid === author) continue;
      const { rows } = await as(uid, () => db.query<{ ok: boolean }>("select public.esblu_chat_can_access_conversation($1) ok", [conv]));
      assert.equal(got.includes(uid), rows[0].ok, `${conv} ${key}`);
    }
  }
});

// =============================================================================
// Predvoľby
// =============================================================================
await check("predvoľby: default, zápis iba vlastný v aktívnej firme, prázdne okno dní zakázané", async () => {
  const def = await as(U.emp, () => db.query<{ p: Row }>("select public.esblu_push_get_my_preferences() p"));
  assert.equal(def.rows[0].p.show_message_preview, false);
  await as(U.emp, () => db.query("select public.esblu_push_set_my_preferences(true, false, true, array[7, 7, 1])"));
  const got = await as(U.emp, () => db.query<{ p: Row }>("select public.esblu_push_get_my_preferences() p"));
  assert.deepEqual(got.rows[0].p.deadline_days, [7, 1]);
  assert.equal(got.rows[0].p.show_message_preview, true);
  const { rows } = await db.query<{ company_id: string; user_id: string }>("select company_id, user_id from public.notification_preferences");
  assert.deepEqual(rows, [{ company_id: CA, user_id: U.emp }]);
  await fails(() => as(U.emp, () => db.query("select public.esblu_push_set_my_preferences(true, true, false, array[]::int[])")), /check/i);
  await fails(() => as(U.emp, () => db.query("select public.esblu_push_set_my_preferences(true, true, false, array[400])")), /check/i);
  await fails(() => as(U.gone, () => db.query("select public.esblu_push_set_my_preferences(true, true, false, null)")), /ESBLU_NO_ACTIVE_COMPANY/);
  // NULL prvky sa neuložia (CHECK by ich prepustil); samé NULL = prázdne okno → zakázané.
  await as(U.emp, () => db.query("select public.esblu_push_set_my_preferences(true, true, false, array[null, 7, null]::int[])"));
  const noNull = await as(U.emp, () => db.query<{ p: Row }>("select public.esblu_push_get_my_preferences() p"));
  assert.deepEqual(noNull.rows[0].p.deadline_days, [7]);
  await fails(() => as(U.emp, () => db.query("select public.esblu_push_set_my_preferences(true, true, false, array[null]::int[])")), /check/i);
});

// =============================================================================
// Katalóg: SECURITY DEFINER, search_path a granty (so Supabase default privileges)
// =============================================================================
const USER_RPCS = [
  "esblu_push_register_device", "esblu_push_unregister_device", "esblu_push_register_web", "esblu_push_unregister_web",
  "esblu_push_get_my_preferences", "esblu_push_set_my_preferences", "esblu_push_my_devices",
];
const SERVER_RPCS = [
  "esblu_push_delivery_targets", "esblu_push_companies_with_targets", "esblu_push_chat_recipients",
  "esblu_push_record_outcome", "esblu_push_revoke_ended",
];
await check("katalóg: každá push SECURITY DEFINER funkcia má search_path='' a presne očakávané EXECUTE granty", async () => {
  const { rows } = await db.query<{ name: string; secdef: boolean; config: string[] | null; anon: boolean; auth: boolean; service: boolean }>(`
    select p.proname name, p.prosecdef secdef, p.proconfig config,
           has_function_privilege('anon', p.oid, 'execute') anon,
           has_function_privilege('authenticated', p.oid, 'execute') auth,
           has_function_privilege('service_role', p.oid, 'execute') service
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'esblu\\_push\\_%'
    order by 1`);
  const names = rows.map((r) => r.name);
  assert.deepEqual([...names].sort(), [...USER_RPCS, ...SERVER_RPCS, "esblu_push_current_session_id"].sort());
  for (const r of rows) {
    assert.ok((r.config ?? []).some((c) => c === 'search_path=""' || c === "search_path="), `${r.name}: search_path`);
    assert.equal(r.anon, false, `${r.name}: anon EXECUTE`);
    if (USER_RPCS.includes(r.name)) {
      assert.equal(r.secdef, true, `${r.name}: SECURITY DEFINER`);
      assert.equal(r.auth, true, `${r.name}: authenticated EXECUTE`);
    } else if (SERVER_RPCS.includes(r.name)) {
      assert.equal(r.secdef, true, `${r.name}: SECURITY DEFINER`);
      assert.equal(r.auth, false, `${r.name}: authenticated EXECUTE`);
      assert.equal(r.service, true, `${r.name}: service_role EXECUTE`);
    } else {
      assert.equal(r.secdef, false, `${r.name}: nie SECURITY DEFINER`);
      assert.equal(r.auth, false, `${r.name}: authenticated EXECUTE`);
    }
  }
});
await check("katalóg: anon ani authenticated nemajú žiadne tabuľkové právo na push tabuľky", async () => {
  for (const table of ["push_devices", "push_subscriptions", "notification_preferences", "notification_deliveries"]) {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
        const { rows } = await db.query<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) ok`, [role, `public.${table}`, priv]);
        assert.equal(rows[0].ok, false, `${role} ${priv} ${table}`);
      }
    }
    const rls = await db.query<{ on: boolean; n: number }>(
      `select c.relrowsecurity "on", (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = $1) n
       from pg_class c where c.oid = $2::regclass`, [table, `public.${table}`]);
    assert.deepEqual(rls.rows[0], { on: true, n: 0 }, `${table}: RLS zapnuté, bez politík`);
  }
});
await check("anon: žiadne user-scoped push RPC (ani s podvrhnutým JWT sub)", async () => {
  for (const sql of [
    "select public.esblu_push_unregister_device('00000000-0000-4000-8000-000000000000', null)",
    "select public.esblu_push_register_web('https://push.example.test/x', 'a', 'b', 'sk', null)",
    "select public.esblu_push_unregister_web('https://push.example.test/x')",
    "select public.esblu_push_get_my_preferences()",
    "select public.esblu_push_set_my_preferences(true, true, false, null)",
    "select * from public.esblu_push_my_devices()",
  ]) {
    await fails(async () => {
      await db.exec("begin");
      try {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.owner, role: "anon" })]);
        await db.exec("set local role anon");
        await db.query(sql);
      } finally {
        await db.exec("rollback");
      }
    }, /permission denied/);
  }
});
await check("inštalácia iného používateľa: bez znalosti installation_id sa cudzie zariadenie nezruší ani neprevezme", async () => {
  const victimToken = fcmToken();
  const victimInstall = uuid();
  assert.equal(await register(U.emp2, victimToken, victimInstall), "registered");
  // Útočník (iná firma) pozná token, ale nie installation_id → conflict, obeť nedotknutá.
  assert.equal(await register(U.b, victimToken, uuid()), "conflict");
  // Útočník s vlastnou inštaláciou a vlastným tokenom neovplyvní riadok obete.
  assert.equal(await register(U.b, fcmToken(), uuid()), "registered");
  const { rows } = await db.query<{ user_id: string; revoked_at: string | null; company_id: string }>(
    "select user_id, revoked_at, company_id from public.push_devices where token = $1", [victimToken]);
  assert.deepEqual(rows, [{ user_id: U.emp2, revoked_at: null, company_id: CA }]);
});

await check("firmy s cieľmi: iba firmy s aktívnym zariadením", async () => {
  const { rows } = await asService(() => db.query<{ c: string }>("select c from public.esblu_push_companies_with_targets() c"));
  const ids = rows.map((row) => row.c).sort();
  assert.deepEqual(ids, [CA, CB].sort());
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo (PGlite ${(await db.query<{ v: string }>("select version() v")).rows[0].v.split(" ").slice(0, 2).join(" ")})`);
if (failed > 0) process.exit(1);
