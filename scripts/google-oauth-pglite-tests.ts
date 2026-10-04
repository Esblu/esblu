// =============================================================================
// Google OAuth — serverové brány nad SKUTOČNÝM PostgreSQL (PGlite).
//
// Funkcie sa načítajú DOSLOVNE z migrácií v repe:
//   - Auth hook „Before User Created“
//       * AKTUÁLNY produkčný stav: 20260818140000 (bez OAuth vetvy),
//       * NAVRHNUTÝ: 20260927120000 (pozvaný cez Google; Apple bez vetvy),
//   - esblu_ensure_my_owner_company, esblu_accept_company_invite:
//       20260929100000 (produkčná verzia closed_beta_p0_hardening).
// Supabase Auth server sa simuluje iba tým, čo reálne posiela hooku
// (event.user.email, user_metadata, app_metadata.provider) a auth.uid().
// NIKDY sa nepripája na Supabase.
//
// SPUSTENIE (PGlite nie je závislosť projektu):
//   npm i --no-save @electric-sql/pglite@0.5.8
//   npm run test:google-oauth-db
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

/** Vyberie z migrácie presne jednu definíciu funkcie (create or replace … $function$;). */
function extractFunction(file: string, name: string): string {
  const sql = read(file).replace(/\r\n/g, "\n");
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${file}: ${name} nenájdená`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${file}: ${name} bez konca`);
  return sql.slice(start, end + "$function$;".length);
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
// Schéma — iba stĺpce, ktoré funkcie používajú (prod názvy).
// -----------------------------------------------------------------------------
await db.exec(`
  create schema extensions;
  create extension pgcrypto schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('test.uid', true), '')::uuid
  $f$;

  create table public.companies (id uuid primary key default gen_random_uuid(), owner_id uuid, name text not null);
  create table public.company_members (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    user_id uuid not null,
    role text not null,
    status text not null default 'active'
  );
  create unique index one_active_membership on public.company_members(user_id) where status = 'active';
  create table public.company_billing_profile (company_id uuid primary key, legal_name text);
  create table public.settings (user_id uuid primary key, company_name text);
  create table public.beta_allowlist (
    email text primary key, revoked_at timestamptz, consumed_at timestamptz, consumed_by uuid
  );
  create table public.company_invites (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    email text not null,
    role text not null,
    token_hash text not null unique,
    status text not null default 'pending',
    expires_at timestamptz not null,
    invited_by uuid,
    accepted_at timestamptz,
    accepted_by uuid
  );
  -- Kapacita tímu (nároky) nie je predmetom tohto testu.
  create function public.esblu_require_entitlement_capacity(p_company uuid, p_key text, p_current bigint)
    returns void language sql as $f$ select null::void $f$;
`);

const HOOK_PROD = extractFunction("supabase/migrations/20260818140000_fix_beta_allowlist_prevent_consumed_reuse.sql", "esblu_before_user_created_beta_gate");
const HOOK_PROPOSED = extractFunction("supabase/migrations/20260927120000_beta_gate_allow_oauth_invites.sql", "esblu_before_user_created_beta_gate");
await db.exec(extractFunction("supabase/migrations/20260929100000_closed_beta_p0_hardening.sql", "esblu_ensure_my_owner_company"));
await db.exec(extractFunction("supabase/migrations/20260929100000_closed_beta_p0_hardening.sql", "esblu_accept_company_invite"));

// -----------------------------------------------------------------------------
// Pomocníci
// -----------------------------------------------------------------------------
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = async () => (await db.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0].id;

async function hook(email: string, provider: string, userMetadata: Row = {}): Promise<Row> {
  const event = { user: { email, user_metadata: userMetadata, app_metadata: { provider } } };
  const { rows } = await db.query<{ r: Row }>("select public.esblu_before_user_created_beta_gate($1::jsonb) as r", [JSON.stringify(event)]);
  return rows[0].r;
}
const allowed = (r: Row) => Object.keys(r).length === 0;

/** Supabase vytvorí auth.users (OAuth: e-mail z Google) iba ak hook povolí. */
async function signUpViaGoogle(email: string): Promise<string | null> {
  if (!allowed(await hook(email, "google"))) return null;
  const id = await uuid();
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('test.uid', $1, false)", [uid]);
  try {
    return await fn();
  } finally {
    await db.query("select set_config('test.uid', '', false)");
  }
}

async function errorOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const ensure = (uid: string) => asUser(uid, () => db.query("select * from public.esblu_ensure_my_owner_company()"));
const accept = (uid: string, token: string) => asUser(uid, () => db.query("select * from public.esblu_accept_company_invite($1)", [token]));
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0].n);

// Firma s vlastníkom a pozvánkami.
const ownerId = await uuid();
await db.query("insert into auth.users (id, email) values ($1, 'owner@firma.example')", [ownerId]);
const companyId = (await db.query<{ id: string }>("insert into public.companies (owner_id, name) values ($1, 'Firma A') returning id::text", [ownerId])).rows[0].id;
await db.query("insert into public.company_members (company_id, user_id, role) values ($1, $2, 'owner')", [companyId, ownerId]);

async function invite(email: string, role: string, opts: { status?: string; expiresIn?: string } = {}): Promise<string> {
  const token = createHash("sha256").update(email + role + Math.random()).digest("hex");
  await db.query(
    `insert into public.company_invites (company_id, email, role, token_hash, status, expires_at, invited_by)
     values ($1, $2, $3, $4, $5, now() + $6::interval, $7)`,
    [companyId, email, role, sha(token), opts.status ?? "pending", opts.expiresIn ?? "7 days", ownerId]
  );
  return token;
}

// =============================================================================
// Testy — NAVRHNUTÝ hook (20260927120000)
// =============================================================================
await db.exec(HOOK_PROPOSED);

await check("A–D existujúci používateľ: Google prihlásenie nevytvára nového používateľa (hook sa nevolá) ani druhú firmu", async () => {
  // Prepojenie identity rieši Supabase bez vzniku auth.users → hook ani
  // ensure sa nespustí. Aj keby klient zavolal ensure, je to no-op.
  const before = await count("select count(*)::int as n from public.companies");
  const r = await ensure(ownerId);
  assert.equal((r.rows[0] as Row).created, false);
  assert.equal(await count("select count(*)::int as n from public.companies"), before);
  assert.equal(await count("select count(*)::int as n from public.company_members where user_id = $1", [ownerId]), 1);
});

await check("E allowlistovaný nový owner cez Google → účet vznikne, firma a owner členstvo raz, slot sa spotrebuje", async () => {
  await db.query("insert into public.beta_allowlist (email) values ('novy.owner@gmail.example')");
  const uid = await signUpViaGoogle("novy.owner@gmail.example");
  assert.ok(uid, "hook mal povoliť");
  const r = await ensure(uid!);
  assert.equal((r.rows[0] as Row).created, true);
  assert.equal(await count("select count(*)::int as n from public.company_members where user_id = $1 and role = 'owner'", [uid]), 1);
  assert.equal(await count("select count(*)::int as n from public.beta_allowlist where email = 'novy.owner@gmail.example' and consumed_at is not null"), 1);
  // druhé volanie = žiadna druhá firma
  const again = await ensure(uid!);
  assert.equal((again.rows[0] as Row).created, false);
});

await check("F neallowlistovaný e-mail cez Google → hook 403; účet, firma ani členstvo nevzniknú", async () => {
  const before = await count("select count(*)::int as n from public.companies");
  const r = await hook("cudzi@gmail.example", "google");
  assert.equal((r.error as Row)?.http_code, 403);
  assert.match(String((r.error as Row)?.message), /uzavretej beta/);
  assert.equal(await signUpViaGoogle("cudzi@gmail.example"), null);
  assert.equal(await count("select count(*)::int as n from public.companies"), before);
});

await check("F obrana do hĺbky: aj keby hook nebol zapnutý, ensure bez allowlistu firmu nezaloží", async () => {
  const uid = await uuid();
  await db.query("insert into auth.users (id, email) values ($1, 'bez.hooku@gmail.example')", [uid]);
  assert.match(await errorOf(() => ensure(uid)), /ESBLU_BETA_ACCESS_REQUIRED/);
  assert.equal(await count("select count(*)::int as n from public.company_members where user_id = $1", [uid]), 0);
});

await check("F spotrebovaný alebo zrušený allowlist slot nepustí", async () => {
  await db.query("insert into public.beta_allowlist (email, consumed_at) values ('spotrebovany@gmail.example', now())");
  await db.query("insert into public.beta_allowlist (email, revoked_at) values ('zruseny@gmail.example', now())");
  assert.equal(allowed(await hook("spotrebovany@gmail.example", "google")), false);
  assert.equal(allowed(await hook("zruseny@gmail.example", "google")), false);
});

for (const role of ["admin", "employee", "accountant"]) {
  await check(`G platná pozvánka (${role}) + Google na ten istý e-mail → účet vznikne, prijatie dá presne rolu ${role}`, async () => {
    const email = `pozvany.${role}@gmail.example`;
    const token = await invite(email, role);
    const uid = await signUpViaGoogle(email);
    assert.ok(uid, "hook mal povoliť pozvaného");
    // Pozvaný si nesmie založiť vlastnú firmu (vrátil by sa na pozvánku).
    assert.match(await errorOf(() => ensure(uid!)), /ESBLU_PENDING_INVITE_EXISTS/);
    const r = await accept(uid!, token);
    assert.equal((r.rows[0] as Row).role, role);
    assert.equal(await count("select count(*)::int as n from public.company_members where user_id = $1 and company_id = $2 and role = $3", [uid, companyId, role]), 1);
  });
}

await check("H pozvánka pre iný e-mail: Google účet s iným e-mailom pozvánku neprijme (ESBLU_INVITE_EMAIL_MISMATCH)", async () => {
  const token = await invite("spravny@firma.example", "employee");
  await db.query("insert into public.beta_allowlist (email) values ('iny@gmail.example')");
  const uid = await signUpViaGoogle("iny@gmail.example");
  assert.ok(uid);
  assert.match(await errorOf(() => accept(uid!, token)), /ESBLU_INVITE_EMAIL_MISMATCH/);
  assert.equal(await count("select count(*)::int as n from public.company_members where user_id = $1 and company_id = $2", [uid, companyId]), 0);
  // a bez allowlistu ani pozvánky na vlastný e-mail sa účet vôbec nevytvorí
  assert.equal(await signUpViaGoogle("iny.bez.pristupu@gmail.example"), null);
});

await check("I vypršaná pozvánka: hook ju nepovažuje za platnú a prijatie zlyhá", async () => {
  const token = await invite("vyprsana@gmail.example", "employee", { expiresIn: "-1 hour" });
  assert.equal(allowed(await hook("vyprsana@gmail.example", "google")), false);
  const uid = await uuid();
  await db.query("insert into auth.users (id, email) values ($1, 'vyprsana@gmail.example')", [uid]);
  assert.match(await errorOf(() => accept(uid, token)), /ESBLU_INVITE_EXPIRED/);
});

await check("J použitá pozvánka: druhý pokus zlyhá, hook ju už nepovažuje za platnú", async () => {
  const email = "pouzita@gmail.example";
  const token = await invite(email, "employee");
  const uid = await signUpViaGoogle(email);
  assert.ok(uid);
  await accept(uid!, token);
  assert.match(await errorOf(() => accept(uid!, token)), /ESBLU_INVITE_ALREADY_ACCEPTED/);
  assert.equal(allowed(await hook(email, "google")), false);
});

await check("zrušená pozvánka neotvára hook ani prijatie", async () => {
  const token = await invite("zrusena.poz@gmail.example", "employee", { status: "revoked" });
  assert.equal(allowed(await hook("zrusena.poz@gmail.example", "google")), false);
  const uid = await uuid();
  await db.query("insert into auth.users (id, email) values ($1, 'zrusena.poz@gmail.example')", [uid]);
  assert.match(await errorOf(() => accept(uid, token)), /ESBLU_INVITE_REVOKED/);
});

await check("OAuth vetva hooku: iba app_metadata.provider = google; Apple, iný poskytovateľ ani user_metadata ju neotvorí", async () => {
  await invite("iba.google@gmail.example", "employee");
  assert.equal(allowed(await hook("iba.google@gmail.example", "google")), true);
  assert.equal(allowed(await hook("iba.google@gmail.example", "apple")), false);
  assert.equal(allowed(await hook("iba.google@gmail.example", "Apple")), false);
  assert.equal(allowed(await hook("iba.google@gmail.example", "github")), false);
  assert.equal(allowed(await hook("iba.google@gmail.example", "email")), false);
  assert.equal(allowed(await hook("iba.google@gmail.example", "", { provider: "google" })), false);
});

await check("e-mail/heslo: pôvodná token vetva a allowlist fungujú bez zmeny", async () => {
  const token = await invite("heslo.pozvany@firma.example", "admin");
  assert.equal(allowed(await hook("heslo.pozvany@firma.example", "email", { esblu_invite_token: token })), true);
  assert.equal(allowed(await hook("heslo.pozvany@firma.example", "email", { esblu_invite_token: "f".repeat(64) })), false);
  await db.query("insert into public.beta_allowlist (email) values ('heslo.owner@firma.example')");
  assert.equal(allowed(await hook("heslo.owner@firma.example", "email")), true);
});

await check("veľkosť písmen a medzery v e-maile od Google nemenia výsledok", async () => {
  await invite("velke.pismena@gmail.example", "employee");
  assert.equal(allowed(await hook("  Velke.Pismena@Gmail.Example ", "google")), true);
});

// =============================================================================
// Dnešný PRODUKČNÝ hook (bez OAuth vetvy) — ako sa správa po zapnutí Google
// =============================================================================
await db.exec(HOOK_PROD);

await check("PROD hook dnes: allowlistovaný owner cez Google prejde", async () => {
  await db.query("insert into public.beta_allowlist (email) values ('prod.owner@gmail.example')");
  assert.equal(allowed(await hook("prod.owner@gmail.example", "google")), true);
});

await check("PROD hook dnes: neallowlistovaný cez Google → 403", async () => {
  assert.equal(allowed(await hook("prod.cudzi@gmail.example", "google")), false);
});

await check("PROD hook dnes: NOVÝ pozvaný (bez allowlistu) cez Google je BEZPEČNE odmietnutý — treba migráciu 20260927120000", async () => {
  await invite("prod.pozvany@gmail.example", "employee");
  const r = await hook("prod.pozvany@gmail.example", "google");
  assert.equal((r.error as Row)?.http_code, 403);
});

console.log(`google-oauth-db: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
