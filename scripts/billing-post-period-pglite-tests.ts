// =============================================================================
// Billing — 48 h ochranná lehota po skončení zaplateného obdobia (20261119100000).
// SKUTOČNÝ PostgreSQL (PGlite), čistý replay VŠETKÝCH migrácií (rovnako ako
// test:pricing-entitlements-db). Nikdy Supabase / staging / produkcia.
//
//   - hranice času (47 h 58 min / 48 h 1 min), kotva = current_period_end,
//   - riadny koniec vs. ukončenie uprostred obdobia (dunning, okamžité zrušenie),
//   - past_due = iba grace_until (žiadne sčítavanie), refund/spor = hneď bez prístupu,
//   - trial u providera bez 48 h, neskorý webhook neposúva koniec,
//   - serverové vynucovanie (resolver bez cronu, klient nič nepredĺži, iná firma nič nevidí),
//   - dáta firmy sa nemažú, UI pole access_until / post_period_protection.
//
//   npm run test:billing-post-period-db
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

// ----------------------------------------------------------------------------- Data API simulácia
type Who = { role: "authenticated" | "service_role" | "anon"; uid?: string; session?: string };
const as = (uid: string, session: string): Who => ({ role: "authenticated", uid, session });
type Outcome = { layer: "ok" | "privilege" | "rls" | "error"; rows: number; message: string; data: Row[] };
async function run(who: Who, sql: string, params: unknown[] = [], commit = false): Promise<Outcome> {
  await db.exec("begin");
  let ok = false;
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<Row>(sql, params);
    ok = true;
    const affected = (r as { affectedRows?: number }).affectedRows;
    return { layer: "ok", rows: r.rows.length || affected || 0, message: "", data: r.rows };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? String(error);
    if (e.code === "42501" && /permission denied/.test(message)) return { layer: "privilege", rows: 0, message, data: [] };
    if (e.code === "42501" && /row-level security/.test(message)) return { layer: "rls", rows: 0, message, data: [] };
    return { layer: "error", rows: 0, message: `${e.code ?? "?"} ${message}`, data: [] };
  } finally {
    await db.exec(commit && ok ? "commit" : "rollback");
  }
}
const attempt = (who: Who, sql: string, params: unknown[] = []) => run(who, sql, params, false);
const commitAs = (who: Who, sql: string, params: unknown[] = []) => run(who, sql, params, true);
const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

// ----------------------------------------------------------------------------- fixtures
const U = {
  ownerA: "c6000000-0000-4000-8000-0000000000a1", adminA: "c6000000-0000-4000-8000-0000000000a2",
  accountantA: "c6000000-0000-4000-8000-0000000000a3", employeeA: "c6000000-0000-4000-8000-0000000000a4",
  ownerB: "c6000000-0000-4000-8000-0000000000b1", ownerT: "c6000000-0000-4000-8000-0000000000e1",
};
const C = {
  a: "c7000000-0000-4000-8000-00000000000a", a2: "c7000000-0000-4000-8000-0000000000a2",
  b: "c7000000-0000-4000-8000-00000000000b", t: "c7000000-0000-4000-8000-00000000000e",
};
const S = {
  ownerA: "c8000000-0000-4000-8000-0000000000a1", ownerA2: "c8000000-0000-4000-8000-0000000000a9",
  adminA: "c8000000-0000-4000-8000-0000000000a2", accountantA: "c8000000-0000-4000-8000-0000000000a3",
  employeeA: "c8000000-0000-4000-8000-0000000000a4", ownerB: "c8000000-0000-4000-8000-0000000000b1",
  ownerT: "c8000000-0000-4000-8000-0000000000e1",
};
await db.exec(`
  insert into auth.users (id, email) values
    ('${U.ownerA}', 'pa@example.invalid'), ('${U.adminA}', 'pad@example.invalid'), ('${U.accountantA}', 'pac@example.invalid'),
    ('${U.employeeA}', 'pe@example.invalid'), ('${U.ownerB}', 'pb@example.invalid'), ('${U.ownerT}', 'pt@example.invalid');
  insert into auth.sessions (id, user_id) values
    ('${S.ownerA}', '${U.ownerA}'), ('${S.ownerA2}', '${U.ownerA}'), ('${S.adminA}', '${U.adminA}'),
    ('${S.accountantA}', '${U.accountantA}'), ('${S.employeeA}', '${U.employeeA}'), ('${S.ownerB}', '${U.ownerB}'),
    ('${S.ownerT}', '${U.ownerT}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values
    ('${C.a}', '${U.ownerA}', 'Firma A'), ('${C.a2}', '${U.ownerA}', 'Firma A2'), ('${C.b}', '${U.ownerB}', 'Firma B');
  insert into public.companies (id, owner_id, name, trial_started_at, trial_ends_at) values
    ('${C.t}', '${U.ownerT}', 'Trial s.r.o.', now() - interval '1 day', now() + interval '13 days');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.ownerA}', 'owner', 'active', '{}'), ('${C.a}', '${U.adminA}', 'admin', 'active', '{"billing":{"manage":true}}'),
    ('${C.a}', '${U.accountantA}', 'accountant', 'active', '{}'), ('${C.a}', '${U.employeeA}', 'employee', 'active', '{}'),
    ('${C.a2}', '${U.ownerA}', 'owner', 'active', '{}'),
    ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${C.t}', '${U.ownerT}', 'owner', 'active', '{}');
  insert into public.session_active_company (session_id, user_id, company_id) values
    ('${S.ownerA}', '${U.ownerA}', '${C.a}'), ('${S.ownerA2}', '${U.ownerA}', '${C.a2}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select co, d.version, own, 'company_dpa_gate'
    from (values ('${C.a}'::uuid, '${U.ownerA}'::uuid), ('${C.a2}'::uuid, '${U.ownerA}'::uuid), ('${C.b}'::uuid, '${U.ownerB}'::uuid), ('${C.t}'::uuid, '${U.ownerT}'::uuid)) v(co, own),
         (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  set session_replication_role = origin;
`);
const ownerA = as(U.ownerA, S.ownerA), adminA = as(U.adminA, S.adminA),
  accountantA = as(U.accountantA, S.accountantA), employeeA = as(U.employeeA, S.employeeA), ownerB = as(U.ownerB, S.ownerB);
const service: Who = { role: "service_role" };
const anon: Who = { role: "anon" };

const MOCK = "select public.esblu_staging_mock_set_plan($1, $2, $3, $4, $5, $6, $7, $8, $9) r";
async function mock(company: string, kind: "complete" | "modular", modules: string[] = [], packs: number[] = [0, 0, 0, 0, 0], active = true) {
  const o = await commitAs(service, MOCK, [company, kind, modules, ...packs, active]);
  if (o.layer !== "ok") throw new Error(o.message);
  return o.data[0].r as { company_id: string; plan_code: string; tier: string };
}
const ents = async (company: string) =>
  Object.fromEntries((await su<{ k: string; a: boolean; l: number | null }>(
    `select k.key k, coalesce((public.esblu_resolve_entitlement($1, k.key) ->> 'active')::boolean, false) a,
            (public.esblu_resolve_entitlement($1, k.key) ->> 'limit')::int l
     from public.entitlement_catalog k order by k.key`, [company])).map((r) => [r.k, r.a ? r.l : "off"])) as Record<string, number | null | "off">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
await su("update public.billing_runtime_config set allow_mock_plans = true");
/** Firma s plánom Komplet a účtom v danom stave (service zápis = to, čo by zapísal apply_event). */
async function account(company: string, patch: { status: string; cpe: string | null; ended?: string | null; trialEnd?: string | null; grace?: string | null; cape?: boolean }) {
  await mock(company, "complete");
  await su(
    `update public.subscription_accounts set status = $2, current_period_start = $3::timestamptz - interval '1 month', current_period_end = $3::timestamptz,
       ended_at = $4::timestamptz, provider_trial_end = $5::timestamptz, grace_until = $6::timestamptz, cancel_at_period_end = $7
     where company_id = $1`,
    [company, patch.status, patch.cpe, patch.ended ?? null, patch.trialEnd ?? null, patch.grace ?? null, patch.cape ?? false]);
  await su("select public.esblu_billing_sync_entitlements($1)", [company]);
}
const subRows = (company: string) => su<{ status: string; valid_until: string }>(
  "select status, valid_until::text valid_until from public.company_entitlements where company_id = $1 and source = 'subscription' order by entitlement_key", [company]);
const voice = async (company: string) => (await ents(company)).voice !== "off";
const mySub = async (who: Who) => {
  const o = await attempt(who, "select public.esblu_get_my_subscription() v");
  if (o.layer !== "ok") throw new Error(o.message);
  return o.data[0].v as Json;
};
const ms = (v: unknown) => Date.parse(String(v));

await check("helper: kotva cpe + 48 h, tolerancia 5 min, trial, ukončenie uprostred obdobia, terminálne a dunning stavy bez 48 h", async () => {
  const f = async (st: string, cpe: string | null, ended: string | null, trial: string | null = null) =>
    (await su<{ v: string | null }>("select to_char(public.esblu_billing_post_period_protection_until($1, $2::timestamptz, $3::timestamptz, $4::timestamptz) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') v", [st, cpe, ended, trial]))[0].v;
  const cpe = "2026-12-18T21:57:52Z", plus48 = "2026-12-20T21:57:52Z";
  assert.equal(await f("active", cpe, null), plus48, "aktívne / zrušené obnovovanie pred koncom");
  assert.equal(await f("trialing", cpe, null), plus48);
  assert.equal(await f("canceled", cpe, cpe), plus48, "riadny koniec");
  assert.equal(await f("expired", cpe, "2026-12-18T21:53:00Z"), plus48, "tolerancia 5 min");
  assert.equal(await f("canceled", cpe, "2026-12-18T21:52:51Z"), null, "viac ako 5 min pred cpe = uprostred obdobia");
  assert.equal(await f("canceled", cpe, "2026-12-01T00:00:00Z"), null, "dunning / okamžité zrušenie");
  assert.equal(await f("canceled", cpe, "2027-03-01T00:00:00Z"), plus48, "neskoré skončenie neposúva kotvu");
  assert.equal(await f("canceled", cpe, cpe, cpe), null, "koniec trialu ≠ zaplatené obdobie");
  for (const st of ["refunded", "revoked", "past_due", "grace_period", "unpaid", "account_hold", "paused", "incomplete", "pending", "none"]) {
    assert.equal(await f(st, cpe, cpe), null, st);
  }
  assert.equal(await f("canceled", null, cpe), null);
  for (const who of [ownerA, employeeA, anon]) assert.equal((await attempt(who, "select public.esblu_billing_post_period_protection_until('active', now(), null, null)")).layer, "privilege");
});

await check("riadny koniec 1 h po cpe: prístup do cpe + 48 h (resolver, celá firma), UI access_until + post_period_protection", async () => {
  const cpe = iso(Date.now() - 1 * H);
  await account(C.a, { status: "canceled", cpe, ended: cpe, cape: true });
  const rows = await subRows(C.a);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.status, "active");
    assert.equal(ms(r.valid_until) - ms(cpe), 48 * H);
  }
  assert.equal(await voice(C.a), true);
  const s = await mySub(ownerA);
  assert.equal(s.status, "canceled");
  assert.equal(s.post_period_protection, true);
  assert.equal(ms(s.access_until) - ms(cpe), 48 * H);
  const e = await mySub(employeeA);
  assert.equal(e.post_period_protection, true, "aj zamestnanec vidí, že prístup dobieha");
  assert.equal(e.current_period_end, undefined, "detaily iba pre oprávnených");
});

await check("hranica: 47 h 58 min po cpe = prístup; 48 h 1 min po cpe = bez prístupu, nároky revoked", async () => {
  let cpe = iso(Date.now() - (48 * H - 2 * 60_000));
  await account(C.b, { status: "canceled", cpe, ended: cpe, cape: true });
  assert.equal(await voice(C.b), true);
  cpe = iso(Date.now() - (48 * H + 60_000));
  await account(C.b, { status: "canceled", cpe, ended: cpe, cape: true });
  assert.equal(await voice(C.b), false);
  assert.ok((await subRows(C.b)).every((r) => r.status === "revoked"));
  const s = await mySub(ownerB);
  assert.equal(s.access_until, null);
  assert.equal(s.post_period_protection, false);
});

await check("zrušené obnovovanie: active + cancel_at_period_end aj neskorý webhook o skončení = ten istý koniec (žiadne sčítavanie)", async () => {
  const cpe = iso(Date.now() - 47 * H);
  await account(C.a, { status: "active", cpe, cape: true });
  const before = (await subRows(C.a)).map((r) => r.valid_until);
  assert.equal(await voice(C.a), true, "webhook o skončení ešte neprišiel");
  await account(C.a, { status: "canceled", cpe, ended: iso(Date.now()), cape: true });
  assert.deepEqual((await subRows(C.a)).map((r) => r.valid_until), before);
  assert.equal(ms(before[0]) - ms(cpe), 48 * H);
});

await check("neúspešná platba: past_due = iba grace_until; ukončenie po neúspešných pokusoch (uprostred obdobia) = hneď bez prístupu", async () => {
  const newEnd = iso(Date.now() + 29 * 24 * H); // Stripe posunie obdobie pri obnove aj keď platba zlyhá
  const grace = iso(Date.now() + 6 * 24 * H);
  await account(C.a, { status: "past_due", cpe: newEnd, grace });
  for (const r of await subRows(C.a)) assert.equal(ms(r.valid_until), ms(grace), "nie cpe + 48 h ani grace + 48 h");
  assert.equal(await voice(C.a), true);
  await account(C.a, { status: "past_due", cpe: newEnd, grace: iso(Date.now() - 60_000) });
  assert.equal(await voice(C.a), false, "po grace bez prístupu, 48 h sa nepridáva");
  await account(C.a, { status: "canceled", cpe: newEnd, ended: iso(Date.now()) });
  assert.equal(await voice(C.a), false, "dunning koniec");
  await account(C.a, { status: "unpaid", cpe: newEnd });
  assert.equal(await voice(C.a), false);
});

await check("refundácie: úplná (refunded) a prehraný spor (revoked) = hneď bez prístupu aj počas ochrannej lehoty; čiastočná nemení stav", async () => {
  const cpe = iso(Date.now() - 1 * H);
  await account(C.a, { status: "canceled", cpe, ended: cpe, cape: true });
  assert.equal(await voice(C.a), true);
  await account(C.a, { status: "refunded", cpe, ended: iso(Date.now()) });
  assert.equal(await voice(C.a), false, "úplná refundácia ukončí aj ochrannú lehotu");
  await account(C.a, { status: "refunded", cpe: iso(Date.now() + 20 * 24 * H), ended: iso(Date.now()) });
  assert.equal(await voice(C.a), false, "úplná refundácia aktuálneho obdobia");
  await account(C.a, { status: "revoked", cpe: iso(Date.now() + 20 * 24 * H), ended: iso(Date.now()) });
  assert.equal(await voice(C.a), false);
  // čiastočná refundácia = iba review_flag na účte, stav active → nároky bez zmeny (bez extra 48 h)
  const activeEnd = iso(Date.now() + 10 * 24 * H);
  await account(C.a, { status: "active", cpe: activeEnd });
  await su("update public.subscription_accounts set review_flag = 'refund_partial' where company_id = $1", [C.a]);
  await su("select public.esblu_billing_sync_entitlements($1)", [C.a]);
  for (const r of await subRows(C.a)) assert.equal(ms(r.valid_until) - ms(activeEnd), 48 * H, "čiastočná refundácia nepridáva ani neuberá");
});

await check("trial u providera a okamžité zrušenie uprostred obdobia = bez 48 h", async () => {
  const cpe = iso(Date.now() - 1 * H);
  await account(C.b, { status: "canceled", cpe, ended: cpe, trialEnd: cpe });
  assert.equal(await voice(C.b), false);
  await account(C.b, { status: "canceled", cpe: iso(Date.now() + 20 * 24 * H), ended: iso(Date.now()) });
  assert.equal(await voice(C.b), false);
});

await check("serverové vynucovanie: po uplynutí valid_until resolver odmietne bez cronu; klient nepredĺži; iná firma nič nevidí", async () => {
  const cpe = iso(Date.now() - 1 * H);
  await account(C.a, { status: "canceled", cpe, ended: cpe, cape: true });
  assert.equal(await voice(C.a), true);
  await su("update public.company_entitlements set valid_until = now() - interval '1 second' where company_id = $1 and source = 'subscription'", [C.a]);
  assert.equal(await voice(C.a), false, "bez resync / cronu");
  for (const who of [ownerA, adminA, accountantA, employeeA, ownerB, anon]) {
    const o = await attempt(who, `update public.company_entitlements set valid_until = now() + interval '1 year' where company_id = '${C.a}'`);
    assert.notEqual(o.layer === "ok" && o.rows > 0, true, `${who.uid ?? who.role} nesmie predĺžiť nárok (${o.layer} ${o.rows})`);
    const s = await attempt(who, `select public.esblu_billing_sync_entitlements('${C.a}')`);
    assert.equal(s.layer, "privilege");
  }
  assert.equal(await voice(C.a), false);
  const b = await mySub(ownerB);
  assert.notEqual(b.company_id, C.a);
});

await check("dáta firmy po skončení lehoty ostávajú (firma, členovia, účet, riadky nárokov iba revoked)", async () => {
  const cpe = iso(Date.now() - 49 * H);
  await account(C.a, { status: "canceled", cpe, ended: cpe, cape: true });
  const n = async (sql: string) => Number((await su<{ n: number }>(sql, [C.a]))[0].n);
  assert.equal(await n("select count(*)::int n from public.companies where id = $1"), 1);
  assert.equal(await n("select count(*)::int n from public.company_members where company_id = $1"), 4);
  assert.equal(await n("select count(*)::int n from public.subscription_accounts where company_id = $1"), 1);
  assert.ok(await n("select count(*)::int n from public.company_entitlements where company_id = $1 and source = 'subscription' and status = 'revoked'") > 0);
  assert.equal(await n("select count(*)::int n from public.company_entitlements where company_id = $1 and source = 'subscription' and status = 'active'"), 0);
});

await check("migrácia: idempotentná, bez DROP TABLE / DELETE / TRUNCATE, bez zapnutia live", async () => {
  const sql = read("supabase/migrations/20261119100000_billing_post_period_protection.sql");
  await db.exec(sql);
  await db.exec(sql);
  const low = sql.toLowerCase().replace(/--.*$/gm, "");
  assert.ok(!/drop\s+table|\btruncate\b|delete\s+from/.test(low));
  assert.ok(!/environment\s*=\s*'live'/.test(low));
  const cpe = iso(Date.now() - 1 * H);
  await account(C.b, { status: "canceled", cpe, ended: cpe, cape: true });
  assert.equal(await voice(C.b), true);
});

await check("rollback: obnoví pôvodné správanie (canceled = hneď off) a odstráni helper; forward znova zapne lehotu", async () => {
  await db.exec(read("supabase/rollback/20261119100000_billing_post_period_protection_rollback.sql"));
  const cpe = iso(Date.now() - 1 * H);
  await account(C.b, { status: "canceled", cpe, ended: cpe, cape: true });
  assert.equal(await voice(C.b), false);
  assert.equal((await su<{ n: number }>("select count(*)::int n from pg_proc where proname = 'esblu_billing_post_period_protection_until'"))[0].n, 0);
  await db.exec(read("supabase/migrations/20261119100000_billing_post_period_protection.sql"));
  await su("select public.esblu_billing_sync_entitlements($1)", [C.b]);
  assert.equal(await voice(C.b), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
