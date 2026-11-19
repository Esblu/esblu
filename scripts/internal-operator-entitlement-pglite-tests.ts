// =============================================================================
// Interný tarif prevádzkovateľa (20261120100000) — SKUTOČNÝ PostgreSQL (PGlite),
// čistý replay všetkých migrácií vrátane Stripe/billing vetvy (S12–S15b).
// Nikdy Supabase / staging / produkcia.
//
//   - grant iba priama DB rola; anon / authenticated / service_role nič,
//   - krížová kontrola vlastníka, členstva, potvrdeného e-mailu, overenej
//     identity a nejednoznačného subjektu (napodobnenie IČO),
//   - jednorazovosť, všetky moduly bez limitu a bez vypršania,
//   - billing sync / Stripe nároky neodvolá, budúci modul sa pridá sám,
//   - značku interného grantu nevie service_role sfalšovať,
//   - ostatné firmy (Free / Trial / Paid) bez zmeny, odvolanie funguje.
//
//   npm run test:internal-operator-db
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
for (const f of replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")))) {
  await db.exec(read(`${MIGRATIONS}/${f}`));
}

type Who = { role: "authenticated" | "service_role" | "anon"; uid?: string; session?: string };
async function attempt(who: Who, sql: string, params: unknown[] = []): Promise<{ ok: boolean; message: string; data: Row[] }> {
  await db.exec("begin");
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<Row>(sql, params);
    return { ok: true, message: "", data: r.rows };
  } catch (error) {
    return { ok: false, message: (error as { message?: string }).message ?? String(error), data: [] };
  } finally {
    await db.exec("rollback");
  }
}
const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
/** Operátor (rola postgres, bez JWT) v transakcii, ktorá sa vždy vráti späť. */
async function operatorTry(sql: string, params: unknown[] = []): Promise<{ ok: boolean; message: string; data: Row[] }> {
  await db.exec("begin");
  try {
    const r = await db.query<Row>(sql, params);
    return { ok: true, message: "", data: r.rows };
  } catch (error) {
    return { ok: false, message: (error as { message?: string }).message ?? String(error), data: [] };
  } finally {
    await db.exec("rollback");
  }
}

// ----------------------------------------------------------------------------- fixtures
const KEY = "SK:57815941";
const U = {
  op: "d1000000-0000-4000-8000-000000000001", // nový prevádzkovateľ (owner Esblu)
  fake: "d1000000-0000-4000-8000-000000000002", // napodobňovateľ (rovnaké IČO)
  unconfirmed: "d1000000-0000-4000-8000-000000000003",
  emp: "d1000000-0000-4000-8000-000000000004", // zamestnanec Esblu
  other: "d1000000-0000-4000-8000-000000000005", // bežný zákazník
};
const S = {
  op: "d2000000-0000-4000-8000-000000000001", fake: "d2000000-0000-4000-8000-000000000002",
  emp: "d2000000-0000-4000-8000-000000000004", other: "d2000000-0000-4000-8000-000000000005",
};
const C = {
  esblu: "d3000000-0000-4000-8000-000000000001", fake: "d3000000-0000-4000-8000-000000000002",
  unconf: "d3000000-0000-4000-8000-000000000003", other: "d3000000-0000-4000-8000-000000000005",
  trial: "d3000000-0000-4000-8000-000000000006",
};
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at) values
    ('${U.op}', 'op@example.invalid', now()), ('${U.fake}', 'fake@example.invalid', now()),
    ('${U.unconfirmed}', 'unc@example.invalid', null), ('${U.emp}', 'emp@example.invalid', now()),
    ('${U.other}', 'other@example.invalid', now());
  insert into auth.sessions (id, user_id) values
    ('${S.op}', '${U.op}'), ('${S.fake}', '${U.fake}'), ('${S.emp}', '${U.emp}'), ('${S.other}', '${U.other}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values
    ('${C.esblu}', '${U.op}', 'Esblu s. r. o.'), ('${C.fake}', '${U.fake}', 'Esblu s. r. o.'),
    ('${C.unconf}', '${U.unconfirmed}', 'Nepotvrdená'), ('${C.other}', '${U.other}', 'Zákazník s.r.o.');
  insert into public.companies (id, owner_id, name, trial_started_at, trial_ends_at) values
    ('${C.trial}', '${U.other}', 'Trial s.r.o.', now() - interval '1 day', now() + interval '13 days');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.esblu}', '${U.op}', 'owner', 'active', '{}'), ('${C.esblu}', '${U.emp}', 'employee', 'active', '{}'),
    ('${C.fake}', '${U.fake}', 'owner', 'active', '{}'), ('${C.unconf}', '${U.unconfirmed}', 'owner', 'active', '{}'),
    ('${C.other}', '${U.other}', 'owner', 'active', '{}'), ('${C.trial}', '${U.other}', 'owner', 'active', '{}');
  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key, verification_status, verified_source, verified_at)
  values ('${C.esblu}', 'SK', '57815941', '${KEY}', 'verified', 'registry:rpo', now()),
         ('${C.fake}', 'SK', '57815941', '${KEY}', 'verified', 'registry:rpo', now()),
         ('${C.unconf}', 'SK', '11111111', 'SK:11111111', 'verified', 'registry:rpo', now());
  insert into public.session_active_company (session_id, user_id, company_id) values
    ('${S.op}', '${U.op}', '${C.esblu}'), ('${S.emp}', '${U.emp}', '${C.esblu}'), ('${S.other}', '${U.other}', '${C.other}');
  set session_replication_role = origin;
`);
const GRANT = "select public.esblu_operator_grant_internal_plan($1, $2, $3, $4) r";
const okArgs = () => [C.esblu, U.op, KEY, "OPS-2026-11-19 overenie prevadzkovatela"];
const ents = async (company: string) =>
  Object.fromEntries((await su<{ k: string; a: boolean; l: number | null; s: string | null; u: string | null }>(
    `select k.key k, coalesce((r ->> 'active')::boolean, false) a, (r ->> 'limit')::int l, r ->> 'source' s, r ->> 'valid_until' u
     from public.entitlement_catalog k, lateral (select public.esblu_resolve_entitlement($1, k.key) r) x order by k.key`, [company]))
    .map((r) => [r.k, r.a ? { limit: r.l, source: r.s, until: r.u } : "off"]));
const snapshotOthers = async () => JSON.stringify([await ents(C.other), await ents(C.trial), await ents(C.fake),
  await su("select id, plan, trial_started_at, trial_ends_at from public.companies where id <> $1 order by id", [C.esblu])]);

// ----------------------------------------------------------------------------- Data API nemá prístup
await check("anon / authenticated / service_role nevedia zavolať grant ani revoke", async () => {
  for (const who of [{ role: "anon" }, { role: "authenticated", uid: U.op, session: S.op }, { role: "service_role" }] as Who[]) {
    const g = await attempt(who, GRANT, okArgs());
    assert.equal(g.ok, false, `${who.role} grant prešiel`);
    assert.match(g.message, /permission denied/);
    const r = await attempt(who, "select public.esblu_operator_revoke_internal_plan($1, 'x')", [C.esblu]);
    assert.equal(r.ok, false);
    assert.match(r.message, /permission denied/);
  }
});
await check("internal_operator_grants: anon/authenticated bez prístupu, service_role iba SELECT", async () => {
  assert.equal((await attempt({ role: "authenticated", uid: U.op, session: S.op }, "select * from public.internal_operator_grants")).ok, false);
  assert.equal((await attempt({ role: "anon" }, "select * from public.internal_operator_grants")).ok, false);
  assert.equal((await attempt({ role: "service_role" }, "select * from public.internal_operator_grants")).ok, true);
  const ins = await attempt({ role: "service_role" },
    `insert into public.internal_operator_grants (company_id, legal_entity_key, owner_user_id, approval_ref) values ($1, $2, $3, 'abcdefghij')`,
    [C.fake, KEY, U.fake]);
  assert.equal(ins.ok, false);
});
await check("JWT kontext s rolou je odmietnutý aj pri priamej DB role (obrana do hĺbky)", async () => {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await assert.rejects(db.query(GRANT, okArgs()), /ESBLU_OPERATOR_ONLY/);
  } finally {
    await db.exec("rollback");
  }
});

// ----------------------------------------------------------------------------- krížové overenia
await check("napodobnenie: dve firmy s rovnakým IČO → ESBLU_INTERNAL_GRANT_IDENTITY_AMBIGUOUS (ani pre pravú, ani pre falošnú)", async () => {
  assert.match((await operatorTry(GRANT, okArgs())).message, /IDENTITY_AMBIGUOUS/);
  assert.match((await operatorTry(GRANT, [C.fake, U.fake, KEY, "OPS-falosny-pokus"])).message, /IDENTITY_AMBIGUOUS/);
});
// Operátor vyrieši duplicitu (falošná firma odstránená) — ďalšie testy bez nej.
await db.exec(`delete from public.company_legal_identities where company_id = '${C.fake}'`);

await check("nesprávny vlastník / zamestnanec / nesprávny subjekt / nepotvrdený e-mail / krátky approval_ref → odmietnuté", async () => {
  assert.match((await operatorTry(GRANT, [C.esblu, U.emp, KEY, "OPS-zamestnanec"])).message, /OWNER_MISMATCH/);
  assert.match((await operatorTry(GRANT, [C.esblu, U.fake, KEY, "OPS-cudzi-user"])).message, /OWNER_MISMATCH/);
  assert.match((await operatorTry(GRANT, [C.esblu, U.op, "SK:12345678", "OPS-zly-subjekt"])).message, /IDENTITY_MISMATCH/);
  assert.match((await operatorTry(GRANT, [C.fake, U.fake, KEY, "OPS-bez-identity"])).message, /IDENTITY_UNVERIFIED/);
  assert.match((await operatorTry(GRANT, [C.unconf, U.unconfirmed, "SK:11111111", "OPS-nepotvrdeny"])).message, /EMAIL_UNCONFIRMED/);
  assert.match((await operatorTry(GRANT, [C.esblu, U.op, KEY, "short"])).message, /ARGS_REQUIRED/);
  assert.equal((await su<{ n: number }>("select count(*)::int n from public.internal_operator_grants"))[0].n, 0);
});
await check("identita 'manual' (zadaná ručne, nie z registra) nestačí", async () => {
  await db.exec("begin");
  try {
    await db.exec(`update public.company_legal_identities set verification_status = 'manual' where company_id = '${C.esblu}'`);
    await assert.rejects(db.query(GRANT, okArgs()), /IDENTITY_UNVERIFIED/);
  } finally {
    await db.exec("rollback");
  }
});

// ----------------------------------------------------------------------------- pridelenie
const before = await snapshotOthers();
await check("operátor udelí interný tarif: všetky moduly aktívne, bez limitu, bez vypršania, plan=admin, bez trialu", async () => {
  const r = (await su<{ r: { grant_id: string; entitlements: number } }>(GRANT, okArgs()))[0].r;
  const catalog = (await su<{ n: number }>("select count(*)::int n from public.entitlement_catalog"))[0].n;
  assert.equal(r.entitlements, catalog);
  const e = await ents(C.esblu);
  for (const [k, v] of Object.entries(e)) {
    assert.notEqual(v, "off", `${k} nie je aktívny`);
    assert.deepEqual(v, { limit: null, source: "manual", until: null }, `${k}: ${JSON.stringify(v)}`);
  }
  const c = (await su<{ plan: string; trial_started_at: string | null }>("select plan, trial_started_at from public.companies where id = $1", [C.esblu]))[0];
  assert.equal(c.plan, "admin");
  assert.equal(c.trial_started_at, null);
});
await check("ostatné firmy (Free / Trial / falošná) sa nezmenili", async () => {
  assert.equal(await snapshotOthers(), before);
});
await check("jednorazovosť: druhý grant (aj pre inú firmu) → ALREADY_ISSUED", async () => {
  assert.match((await operatorTry(GRANT, okArgs())).message, /ALREADY_ISSUED/);
  await db.exec("begin");
  try {
    await db.exec(`insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key, verification_status, verified_source, verified_at)
                   values ('${C.other}', 'SK', '22222222', 'SK:22222222', 'verified', 'registry:rpo', now())`);
    await assert.rejects(db.query(GRANT, [C.other, U.other, "SK:22222222", "OPS-druhy-grant"]), /ALREADY_ISSUED/);
  } finally {
    await db.exec("rollback");
  }
});
await check("zamestnanec firmy Esblu vidí moduly cez esblu_get_my_company_entitlements (RLS/roly bez zmeny)", async () => {
  const o = await attempt({ role: "authenticated", uid: U.emp, session: S.emp }, "select public.esblu_get_my_company_entitlements() v");
  assert.equal(o.ok, true, o.message);
  const s = JSON.stringify(o.data[0].v);
  for (const k of ["vehicles", "machines", "inventory", "invoicing", "ai_documents", "voice"]) assert.ok(s.includes(k), k);
});
await check("billing sync (Stripe/subscription) interné nároky neodvolá", async () => {
  await su("select public.esblu_billing_sync_entitlements($1)", [C.esblu]);
  const e = await ents(C.esblu);
  for (const v of Object.values(e)) assert.deepEqual(v, { limit: null, source: "manual", until: null });
});
await check("service_role nevie sfalšovať značku interného grantu pre inú firmu", async () => {
  const gid = (await su<{ id: string }>("select id from public.internal_operator_grants where revoked_at is null"))[0].id;
  const o = await attempt({ role: "service_role" },
    `insert into public.company_entitlements (company_id, entitlement_key, source, status, valid_from, external_ref)
     values ($1, 'vehicles', 'manual', 'active', now(), $2)`, [C.other, `internal_operator_grant:${gid}`]);
  assert.equal(o.ok, false);
  assert.match(o.message, /MARKER_FORBIDDEN/);
});
await check("budúci modul v katalógu sa internej firme pridelí automaticky (iba jej)", async () => {
  await db.exec("begin");
  try {
    await db.exec(`insert into public.entitlement_catalog (key, kind, included_in_trial, trial_limit, sort_order)
                   values ('future_module_x', 'module', false, null, 999)`);
    const mine = (await su<{ r: Row }>("select public.esblu_resolve_entitlement($1, 'future_module_x') r", [C.esblu]))[0].r;
    assert.equal(mine.active, true);
    assert.equal(mine.limit, null);
    const other = (await su<{ r: Row }>("select public.esblu_resolve_entitlement($1, 'future_module_x') r", [C.other]))[0].r;
    assert.equal(other.active, false);
  } finally {
    await db.exec("rollback");
  }
});
await check("klient nevie zmeniť companies.plan ani company_entitlements", async () => {
  const op = { role: "authenticated", uid: U.op, session: S.op } as Who;
  assert.equal((await attempt(op, "update public.companies set plan = 'admin' where id = $1", [C.other])).ok, false);
  assert.equal((await attempt(op, "insert into public.company_entitlements (company_id, entitlement_key, source, status, valid_from) values ($1, 'vehicles', 'manual', 'active', now())", [C.other])).ok, false);
});

// ----------------------------------------------------------------------------- odvolanie
await check("odvolanie: nároky revoked, audit zachovaný, plan späť na free", async () => {
  await db.exec("begin");
  try {
    await assert.rejects(db.query("select public.esblu_operator_revoke_internal_plan($1, '')", [C.esblu]), /REASON_REQUIRED/);
  } finally {
    await db.exec("rollback");
  }
  await db.exec("begin");
  try {
    const n = (await db.query<{ n: number }>("select public.esblu_operator_revoke_internal_plan($1, 'test odvolania') n", [C.esblu])).rows[0].n;
    assert.ok(n > 0);
    assert.equal((await db.query<{ r: Row }>("select public.esblu_resolve_entitlement($1, 'vehicles') r", [C.esblu])).rows[0].r.active, false);
    const g = (await db.query<{ revoked_at: string | null }>("select revoked_at from public.internal_operator_grants")).rows;
    assert.equal(g.length, 1);
    assert.ok(g[0].revoked_at);
    assert.equal((await db.query<{ plan: string }>("select plan from public.companies where id = $1", [C.esblu])).rows[0].plan, "free");
  } finally {
    await db.exec("rollback");
  }
});

// ----------------------------------------------------------------------------- rollback chráni audit
await check("rollback 20261120100000: neprázdny audit sa nezmaže (archív), re-apply vytvorí čistú tabuľku", async () => {
  const before = (await db.query<{ n: number }>("select count(*)::int n from public.internal_operator_grants")).rows[0].n;
  assert.ok(before > 0, "precondition: existuje grant");
  await db.exec(read("supabase/rollback/20261120100000_internal_operator_entitlement_rollback.sql"));
  assert.equal((await db.query<{ t: string | null }>("select to_regclass('public.internal_operator_grants')::text t")).rows[0].t, null);
  const arch = (await db.query<{ t: string }>(
    "select c.relname::text t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'esblu_audit_archive' and c.relname like 'internal_operator_grants_rb_%' and c.relkind = 'r'")).rows;
  assert.equal(arch.length, 1);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from esblu_audit_archive.${arch[0].t}`)).rows[0].n, before);
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from public.company_entitlements where external_ref like 'internal_operator_grant:%' and status <> 'revoked'")).rows[0].n, 0);
  assert.equal((await attempt({ role: "service_role" }, `select * from esblu_audit_archive.${arch[0].t}`)).ok, false, "archív bez prístupu service_role");
  await db.exec(read(`${MIGRATIONS}/20261120100000_internal_operator_entitlement.sql`));
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from public.internal_operator_grants")).rows[0].n, 0);
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from pg_indexes where schemaname = 'public' and indexname = 'internal_operator_grants_single_active_idx'")).rows[0].n, 1);
  await db.exec(read("supabase/rollback/20261120100000_internal_operator_entitlement_rollback.sql"));
  assert.equal((await db.query<{ t: string | null }>("select to_regclass('public.internal_operator_grants')::text t")).rows[0].t, null, "prázdna tabuľka sa zmaže");
  await db.exec(read(`${MIGRATIONS}/20261120100000_internal_operator_entitlement.sql`));
});

console.log(`\ninternal-operator-entitlement: ${passed} ok, ${failed} fail`);
if (failed > 0) process.exit(1);
