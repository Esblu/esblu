// =============================================================================
// S15 — Stripe LIVE pripravenosť: prísne oddelenie test ↔ live (20261119130000) + live adaptér.
// SKUTOČNÝ PostgreSQL (PGlite), čistý replay VŠETKÝCH migrácií + skutočná TS pipeline
// (processWebhook / runEventCatchup / reconciliation) s MOCKOM Stripe API. Nikdy Supabase / Stripe.
//
//   npm run test:billing-live-mode-db
// =============================================================================
/* eslint-disable @typescript-eslint/no-unused-vars -- spoločný harness (fixtures pre všetky roly) */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { processWebhook, type BillingDb } from "@/lib/billing/pipeline";
import { StripeLiveProvider, StripeTestProvider } from "@/lib/billing/providers/stripe";
import { runEventCatchup } from "@/lib/billing/event-catchup";
import { providerReconcileSource } from "@/lib/billing/reconcile-sources";
import { runReconciliation } from "@/lib/billing/reconciliation";
import { signTimestamped } from "@/lib/billing/signature";

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
const ms = (v: unknown) => Date.parse(String(v));
const serviceDb: BillingDb = {
  rpc: async (fn, args = {}) => {
    const entries = Object.entries(args);
    const sql = `select public.${fn}(${entries.map(([k], i) => `${k} => $${i + 1}`).join(", ")}) r`;
    const params = entries.map(([, v]) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v));
    try {
      return { data: (await su<{ r: unknown }>(sql, params))[0]?.r ?? null, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  },
};
const setEnv = async (env: "test" | "live", webProvider = "stripe") =>
  su(`update public.billing_runtime_config set environment = $1, web_provider = $2, allow_mock_plans = false, enabled_methods = array['stripe_web_checkout']`, [env, webProvider]);
/** Účinný nárok ZO PREDPLATNÉHO (trial firmy sa nepočíta). */
const subActive = async (company: string) => Number((await su<{ n: number }>("select count(*)::int n from public.company_entitlements where company_id = $1 and source = 'subscription' and status = 'active' and valid_until > now()", [company]))[0].n) > 0;
const voice = async (company: string) => (await su<{ a: boolean }>("select coalesce((public.esblu_resolve_entitlement($1, 'voice') ->> 'active')::boolean, false) a", [company]))[0].a;
const fails = async (fn: () => Promise<unknown>, re: RegExp) => {
  try { await fn(); } catch (e) { assert.match(e instanceof Error ? e.message : String(e), re); return; }
  assert.fail("očakávaná chyba");
};

// Live Stripe mock: všetky objekty livemode=true (ako skutočný live účet).
const LIVE_KEY = "sk_live_" + "L".repeat(24);
const TEST_KEY = "sk_test_" + "T".repeat(24);
const WHSEC_LIVE = "whsec_" + "l".repeat(32);
function stripeLive(subId: string, cpeS: number) {
  const st = {
    livemode: true,
    acct: "acct_LIVEESBLU0001",
    sub: { object: "subscription", id: subId, customer: `cus_${subId}`, status: "active", livemode: true, cancel_at_period_end: false, cancel_at: null as number | null,
      canceled_at: null as number | null, ended_at: null as number | null, metadata: {},
      items: { data: [{ id: "si_l", price: { id: "price_live_complete_m" }, current_period_start: cpeS - 30 * 86400, current_period_end: cpeS }] },
      latest_invoice: `in_${subId}` } as Record<string, unknown>,
    charge: { object: "charge", id: `ch_${subId}`, livemode: true, amount: 1590, amount_refunded: 0, refunded: false, disputed: false, currency: "eur", payment_intent: `pi_${subId}` } as Record<string, unknown>,
    events: [] as Record<string, unknown>[],
    deletes: 0,
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v1/, "");
    const lm = st.livemode;
    if (init?.method === "DELETE") { st.deletes++; const n = Math.floor(Date.now() / 1000); st.sub = { ...st.sub, status: "canceled", canceled_at: n, ended_at: n }; return json(st.sub); }
    if (p === "/account") return json({ object: "account", id: st.acct });
    if (p === "/events") {
      const eb = u.searchParams.get("ending_before");
      const list = [...st.events].reverse();
      if (eb) { const i = list.findIndex((e) => e.id === eb); if (i < 0) return json({ error: {} }, 404); return json({ object: "list", data: list.slice(0, i), has_more: false }); }
      return json({ object: "list", data: list, has_more: false });
    }
    if (p.startsWith("/subscriptions/")) return json({ ...st.sub, livemode: lm });
    if (p === "/invoice_payments") return json({ object: "list", data: [{ invoice: st.sub.latest_invoice, payment: { type: "payment_intent", payment_intent: st.charge.payment_intent } }] });
    if (p.startsWith("/invoices/")) return json({ object: "invoice", id: st.sub.latest_invoice, livemode: lm, parent: { subscription_details: { subscription: st.sub.id } }, lines: { data: [] } });
    if (p.startsWith("/payment_intents/")) return json({ object: "payment_intent", id: st.charge.payment_intent, livemode: lm, latest_charge: st.charge });
    if (p === "/disputes") return json({ object: "list", data: [] });
    return json({ error: {} }, 404);
  }) as unknown as typeof fetch;
  return { st, fetchImpl };
}
let evN = 0;
const ev = (type: string, object: unknown, livemode: boolean) => ({ object: "event", id: `evt_live_${++evN}`, type, created: Math.floor(Date.now() / 1000), livemode, data: { object } });
async function sendWebhook(provider: StripeLiveProvider | StripeTestProvider, event: Record<string, unknown>, secret: string) {
  const raw = JSON.stringify(event);
  return processWebhook(provider, raw, new Headers({ "stripe-signature": signTimestamped(raw, secret, Math.floor(Date.now() / 1000)) }), serviceDb);
}
async function liveFixture(company: string, subId: string, cpeS: number) {
  await su(`insert into public.billing_provider_prices (provider, environment, plan_code, billing_interval, provider_price_id, active)
    values ('stripe', 'live', 'esblu_complete', 'month', 'price_live_complete_m', true) on conflict do nothing`);
  await su(`insert into public.billing_provider_links (provider, environment, link_kind, external_id, company_id) values ('stripe', 'live', 'subscription', $1, $2) on conflict do nothing`, [subId, company]);
  await su(`insert into public.company_plan_selection (company_id, plan_kind, price_tier, modules, source) values ($1, 'complete', 'primary', '{}', 'staging_mock')
    on conflict (company_id) do update set plan_kind = 'complete'`, [company]);
  const m = stripeLive(subId, cpeS);
  const provider = new StripeLiveProvider({ secretKey: LIVE_KEY, webhookSecret: WHSEC_LIVE, fetchImpl: m.fetchImpl });
  return { ...m, provider };
}

// ============================================================================= DB oddelenie
await check("DB: live konfigurácia iba stripe/none, bez mock plánov a bez obchodov; staging ostáva test", async () => {
  assert.equal((await su<{ e: string }>("select environment e from public.billing_runtime_config"))[0].e, "test");
  await fails(() => su("update public.billing_runtime_config set environment = 'live', web_provider = 'fake'"), /live_guard/);
  await fails(() => su("update public.billing_runtime_config set environment = 'live', web_provider = 'stripe', allow_mock_plans = true"), /live_guard/);
  await fails(() => su("update public.billing_runtime_config set environment = 'live', web_provider = 'stripe', allow_mock_plans = false, enabled_methods = array['stripe_web_checkout','google_play']"), /live_guard/);
  await fails(() => su("update public.billing_runtime_config set environment = 'prod'"), /env_check/);
  await setEnv("live");
  assert.equal((await su<{ e: string }>("select environment e from public.billing_runtime_config"))[0].e, "live");
  await setEnv("test", "none");
});

await check("DB: record_event odmietne udalosť iného prostredia (test DB ← live, live DB ← test) — nič sa neuloží", async () => {
  const before = Number((await su<{ n: number }>("select count(*)::int n from public.billing_events"))[0].n);
  await fails(() => su("select public.esblu_billing_record_event('stripe', 'live', 'evt_x_live', 'invoice.paid', now(), null)"), /ENVIRONMENT_MISMATCH/);
  await setEnv("live");
  await fails(() => su("select public.esblu_billing_record_event('stripe', 'test', 'evt_x_test', 'invoice.paid', now(), null)"), /ENVIRONMENT_MISMATCH/);
  await fails(() => su("select public.esblu_billing_record_event('apple', 'test', 'evt_x_apple', 'x', now(), null)"), /ENVIRONMENT_MISMATCH/);
  assert.equal(Number((await su<{ n: number }>("select count(*)::int n from public.billing_events"))[0].n), before);
  await setEnv("test", "none");
});

await check("DB: nároky iba z účtu prostredia DB — testovací účet v live DB nič neodomkne, live účet áno (+ 48 h)", async () => {
  await su("update public.billing_runtime_config set allow_mock_plans = true");
  await mock(C.a, "complete");
  await setEnv("live");
  const cpe = iso(Date.now() - H);
  await su("update public.subscription_accounts set provider_environment = 'test', status = 'canceled', current_period_start = $2::timestamptz - interval '1 month', current_period_end = $2, ended_at = $2, cancel_at_period_end = true, scheduled_end_at = null where company_id = $1", [C.a, cpe]);
  await su("select public.esblu_billing_sync_entitlements($1)", [C.a]);
  assert.equal(await voice(C.a), false, "test účet v live DB");
  await su("update public.subscription_accounts set provider_environment = 'live' where company_id = $1", [C.a]);
  await su("select public.esblu_billing_sync_entitlements($1)", [C.a]);
  assert.equal(await voice(C.a), true, "live účet: riadny koniec + 48 h");
  const until = (await su<{ v: string }>("select max(valid_until)::text v from public.company_entitlements where company_id = $1 and source = 'subscription' and status = 'active'", [C.a]))[0].v;
  assert.equal(ms(until) - ms(cpe), 48 * H);
  await setEnv("test", "none");
  await su("select public.esblu_billing_sync_entitlements($1)", [C.a]);
  assert.equal(await voice(C.a), false, "live účet v test DB nič neodomkne");
});

await check("DB: reconciliation kandidáti iba z prostredia DB; kurzor môže byť live", async () => {
  await su("update public.subscription_accounts set provider_subscription_id = 'sub_env_x', billing_provider = 'stripe', status = 'active', provider_environment = 'live', current_period_start = now() - interval '1 month', current_period_end = now() + interval '2 hours', ended_at = null where company_id = $1", [C.a]);
  await su("update public.billing_reconciliation set next_check_at = now() - interval '1 minute', last_checked_at = null");
  const ids = async () => ((await su<{ r: Array<{ provider_subscription_id: string }> }>("select public.esblu_billing_reconcile_candidates(500) r"))[0].r).map((x) => x.provider_subscription_id);
  assert.ok(!(await ids()).includes("sub_env_x"), "test DB nevidí live účet");
  await setEnv("live");
  assert.ok((await ids()).includes("sub_env_x"), "live DB vidí live účet");
  await su("select public.esblu_billing_event_cursor_claim('stripe', 'live', 'acct_LIVEX0001', gen_random_uuid(), 60)");
  assert.equal(Number((await su<{ n: number }>("select count(*)::int n from public.billing_event_cursors where environment = 'live'"))[0].n), 1);
  await su("delete from public.billing_event_cursors where environment = 'live'");
  await setEnv("test", "none");
});

// ============================================================================= pipeline (mock live Stripe)
await check("live webhook: live udalosť → applied (live cena, live väzba); test udalosť alebo test secret → odmietnuté, nič sa neuloží", async () => {
  await setEnv("live");
  const cpeS = Math.floor(Date.now() / 1000) + 20 * 86400;
  const { st, provider } = await liveFixture(C.b, "sub_live_b", cpeS);
  const r = await sendWebhook(provider, ev("customer.subscription.updated", st.sub, true), WHSEC_LIVE);
  assert.equal(r.outcome, "applied", JSON.stringify(r));
  const acc = (await su<{ status: string; e: string }>("select status, provider_environment e from public.subscription_accounts where company_id = $1", [C.b]))[0];
  assert.deepEqual([acc.status, acc.e], ["active", "live"]);
  assert.equal(await subActive(C.b), true);
  const before = Number((await su<{ n: number }>("select count(*)::int n from public.billing_events"))[0].n);
  const t = await sendWebhook(provider, ev("customer.subscription.updated", st.sub, false), WHSEC_LIVE);
  assert.deepEqual([t.httpStatus, t.outcome, t.code], [400, "rejected", "TEST_MODE_FORBIDDEN"], "test udalosť na live endpointe");
  const w = await sendWebhook(provider, ev("customer.subscription.updated", st.sub, true), "whsec_" + "x".repeat(32));
  assert.equal(w.code, "INVALID_SIGNATURE", "iný (test) webhook secret");
  assert.equal(Number((await su<{ n: number }>("select count(*)::int n from public.billing_events"))[0].n), before, "nič nové v billing_events");
  // test provider (sandbox kľúč) na live DB: podpis OK, ale DB odmietne prostredie
  const testProvider = new StripeTestProvider({ secretKey: TEST_KEY, webhookSecret: WHSEC_LIVE, fetchImpl: st && (async () => new Response("{}")) as unknown as typeof fetch });
  const x = await sendWebhook(testProvider, ev("customer.subscription.updated", { ...st.sub, livemode: false }, false), WHSEC_LIVE);
  assert.equal(x.code, "RECORD_FAILED", "DB guard: test udalosť do live DB sa neuloží");
  await setEnv("test", "none");
});

await check("live: plná refundácia (webhook) → refunded, ukončenie u Stripe; zrušenie ku koncu obdobia → cpe + 48 h; plánovaný predčasný koniec → bez 48 h", async () => {
  await setEnv("live");
  const now = Math.floor(Date.now() / 1000);
  // refundácia
  const r1 = await liveFixture(C.t, "sub_live_t", now + 20 * 86400);
  assert.equal((await sendWebhook(r1.provider, ev("customer.subscription.updated", r1.st.sub, true), WHSEC_LIVE)).outcome, "applied");
  r1.st.charge = { ...r1.st.charge, amount_refunded: 1590, refunded: true };
  const rf = await sendWebhook(r1.provider, ev("charge.refunded", r1.st.charge, true), WHSEC_LIVE);
  assert.equal(rf.outcome, "applied", JSON.stringify(rf));
  assert.equal(rf.code, "PROVIDER_CANCELED");
  assert.equal(r1.st.deletes, 1);
  assert.equal((await su<{ s: string }>("select status s from public.subscription_accounts where company_id = $1", [C.t]))[0].s, "refunded");
  assert.equal(await subActive(C.t), false);
  // zrušenie ku koncu obdobia: riadny koniec → + 48 h (live)
  const cpe = now - 3600;
  const r2 = await liveFixture(C.a2, "sub_live_a2", cpe);
  r2.st.sub = { ...r2.st.sub, status: "canceled", cancel_at_period_end: true, cancel_at: cpe, canceled_at: cpe - 86400, ended_at: cpe };
  assert.equal((await sendWebhook(r2.provider, ev("customer.subscription.deleted", r2.st.sub, true), WHSEC_LIVE)).outcome, "applied");
  assert.equal(await subActive(C.a2), true, "riadny koniec + 48 h");
  // plánovaný predčasný koniec (Stripe skráti obdobie, cancel_at_period_end=false) → bez 48 h
  await su("delete from public.billing_provider_links where external_id = 'sub_live_a2'");
  await su("delete from public.subscription_accounts where company_id = $1", [C.a2]);
  const r3 = await liveFixture(C.a2, "sub_live_a2b", cpe);
  r3.st.sub = { ...r3.st.sub, status: "canceled", cancel_at_period_end: false, cancel_at: cpe, canceled_at: cpe - 86400, ended_at: cpe };
  assert.equal((await sendWebhook(r3.provider, ev("customer.subscription.deleted", r3.st.sub, true), WHSEC_LIVE)).outcome, "applied");
  const a3 = (await su<Json>("select status, provider_subscription_id, scheduled_end_at, ended_at, current_period_end from public.subscription_accounts where company_id = $1", [C.a2]))[0];
  const e3 = await su<Json>("select status, source, valid_until from public.company_entitlements where company_id = $1 and entitlement_key = 'voice'", [C.a2]);
  assert.equal(await subActive(C.a2), false, "predčasný koniec bez 48 h aj v live " + JSON.stringify({ a3, e3 }));
  await setEnv("test", "none");
});

await check("live doťahovanie: kurzor 'live', live udalosť spracovaná, test udalosť v zozname preskočená (nikdy sa neuloží); reconciliation live účtu", async () => {
  await setEnv("live");
  await su("delete from public.billing_event_cursors");
  const now = Math.floor(Date.now() / 1000);
  const f = await liveFixture(C.b, "sub_live_b", now + 20 * 86400);
  f.st.events.push(ev("customer.subscription.updated", f.st.sub, true));
  f.st.events.push(ev("customer.subscription.updated", { ...f.st.sub, livemode: false }, false));
  const r = await runEventCatchup(serviceDb, f.provider, f.provider, { timeBudgetMs: 60_000 });
  assert.equal(r.result, "ok", JSON.stringify(r));
  assert.equal(r.outcomes.applied, 1);
  assert.equal(r.outcomes.rejected, 1, "test udalosť preskočená");
  assert.equal(r.errorCode, "TEST_EVENT_SKIPPED");
  const cur = (await su<{ e: string; a: string; f: number }>("select environment e, account_ref a, consecutive_failures f from public.billing_event_cursors"))[0];
  assert.deepEqual([cur.e, cur.a, cur.f], ["live", "acct_LIVEESBLU0001", 0]);
  assert.equal(await subActive(C.b), true);
  // reconciliation: live provider overí live účet; test provider by bol ENVIRONMENT_MISMATCH
  await su("update public.billing_reconciliation set next_check_at = now() + interval '1 day'");
  const accId = (await su<{ id: string }>("select id from public.subscription_accounts where company_id = $1", [C.b]))[0].id;
  await su("update public.billing_reconciliation set next_check_at = now() - interval '1 minute', last_checked_at = null where account_id = $1", [accId]);
  const testSrc = providerReconcileSource(new StripeTestProvider({ secretKey: TEST_KEY, webhookSecret: WHSEC_LIVE, fetchImpl: f.fetchImpl }));
  const mis = await runReconciliation(serviceDb, { stripe: testSrc }, { limit: 50 });
  assert.equal(mis.results.find((x) => x.accountId === accId)?.errorCode, "ENVIRONMENT_MISMATCH");
  await su("update public.billing_reconciliation set next_check_at = now() - interval '1 minute', last_checked_at = null where account_id = $1", [accId]);
  const ok = await runReconciliation(serviceDb, { stripe: providerReconcileSource(f.provider) }, { limit: 50 });
  assert.equal(ok.results.find((x) => x.accountId === accId)?.result, "in_sync", JSON.stringify(ok));
  await su("delete from public.billing_event_cursors");
  await setEnv("test", "none");
});

await check("live adaptér: objekt s livemode=false z API (test účet za live kľúčom) → TEST_MODE_FORBIDDEN, nič sa nezapíše", async () => {
  await setEnv("live");
  const f = await liveFixture(C.b, "sub_live_b", Math.floor(Date.now() / 1000) + 86400);
  f.st.livemode = false;
  const r = await sendWebhook(f.provider, ev("customer.subscription.updated", f.st.sub, true), WHSEC_LIVE);
  assert.equal(r.outcome, "retry", "normalizácia zlyhá (test objekt) → udalosť failed, nič sa neaplikuje");
  const last = (await su<{ s: string; c: string }>("select status s, error_code c from public.billing_events order by received_at desc limit 1"))[0];
  assert.deepEqual([last.s, last.c], ["failed", "NORMALIZE_FAILED"]);
  await setEnv("test", "none");
});

// ============================================================================= S15b allowlist prvých LIVE nákupov
const liveIntent = (company: string, owner: string) => su(
  `insert into public.billing_checkout_sessions (company_id, created_by, provider, environment, plan_code, billing_interval, provider_price_id, expires_at)
   values ($1, $2, 'stripe', (select environment from public.billing_runtime_config), 'esblu_complete', 'month', 'price_live_complete_m', now() + interval '1 hour') returning id`, [company, owner]);
await check("S15b allowlist: v live prostredí vytvorí LIVE zámer / Checkout iba povolená firma (každá cesta, aj priame API); test prostredie bez zmeny", async () => {
  await su("update public.billing_checkout_sessions set status = 'expired' where status in ('created', 'open')");
  const t = await liveIntent(C.b, U.ownerB);
  assert.equal(t.length, 1, "test prostredie: trigger nič nemení");
  await su("update public.billing_checkout_sessions set status = 'expired' where status in ('created', 'open')");
  await setEnv("live");
  assert.equal((await su<{ s: string }>("select live_purchase_scope s from public.billing_runtime_config"))[0].s, "allowlist", "default = allowlist (fail closed)");
  await fails(() => liveIntent(C.b, U.ownerB), /ESBLU_BILLING_LIVE_NOT_ALLOWED/);
  // klientska cesta (RPC nákupného zámeru) — rovnaká poistka v DB
  await su("update public.billing_runtime_config set web_provider = 'stripe'");
  // firma A2 (bez otvoreného predplatného, mimo allowlistu) — owner A v relácii s aktívnou firmou A2
  const rpc = await attempt(as(U.ownerA, S.ownerA2), "select public.esblu_billing_create_purchase_intent('esblu_complete', 'month', 'web', 'stripe_web_checkout', null, 'new', null)");
  assert.notEqual(rpc.layer, "ok", "nepovolená firma nevytvorí LIVE zámer ani cez RPC");
  assert.match(rpc.message, /ESBLU_BILLING_LIVE_NOT_ALLOWED/, rpc.message);
  // UI: ponuka kanálov
  const mine = await attempt(ownerB, "select public.esblu_billing_my_live_purchase_allowed() a");
  assert.equal(mine.data[0]?.a, false);
  // povolenie internej firmy
  await su("insert into public.billing_live_purchase_allowlist (company_id, note) values ($1, 'interný test')", [C.b]);
  const ok = await liveIntent(C.b, U.ownerB);
  assert.equal(ok.length, 1, "povolená firma vytvorí LIVE zámer");
  assert.equal((await attempt(ownerB, "select public.esblu_billing_my_live_purchase_allowed() a")).data[0]?.a, true);
  // odobratie z allowlistu: k existujúcemu zámeru sa už nepriradí Stripe relácia
  await su("delete from public.billing_live_purchase_allowlist where company_id = $1", [C.b]);
  await fails(() => su("update public.billing_checkout_sessions set provider_session_id = 'cs_live_x' where id = $1", [(ok[0] as Json).id]), /ESBLU_BILLING_LIVE_NOT_ALLOWED/);
  await su("update public.billing_checkout_sessions set status = 'expired' where id = $1", [(ok[0] as Json).id]); // iná zmena prejde
  // otvorenie predaja všetkým = vedomé prepnutie
  await su("update public.billing_runtime_config set live_purchase_scope = 'all'");
  assert.equal((await liveIntent(C.a2, U.ownerA)).length, 1);
  await fails(() => su("update public.billing_runtime_config set live_purchase_scope = 'everyone'"), /live_scope_check/);
  await su("update public.billing_runtime_config set live_purchase_scope = 'allowlist'");
  await su("update public.billing_checkout_sessions set status = 'expired' where status in ('created', 'open')");
  await setEnv("test", "none");
});
await check("S15b allowlist: existujúce LIVE predplatné firmy mimo allowlistu sa ďalej synchronizuje (webhook, nároky); klient allowlist nečíta ani nemení", async () => {
  await setEnv("live");
  const f = await liveFixture(C.b, "sub_live_b", Math.floor(Date.now() / 1000) + 20 * 86400);
  assert.equal(Number((await su<{ n: number }>("select count(*)::int n from public.billing_live_purchase_allowlist where company_id = $1", [C.b]))[0].n), 0);
  const r = await sendWebhook(f.provider, ev("customer.subscription.updated", { ...f.st.sub, cancel_at_period_end: true }, true), WHSEC_LIVE);
  assert.ok(["applied", "stale"].includes(r.outcome), JSON.stringify(r));
  assert.equal(await subActive(C.b), true, "nároky existujúceho predplatného bez zmeny");
  for (const who of [ownerA, ownerB, employeeA, anon]) {
    for (const sql of ["select * from public.billing_live_purchase_allowlist", `insert into public.billing_live_purchase_allowlist (company_id) values ('${C.a}')`,
      "update public.billing_runtime_config set live_purchase_scope = 'all'", `select public.esblu_billing_live_purchase_allowed('${C.a}')`]) {
      const o = await attempt(who, sql);
      assert.ok(o.layer === "privilege" || o.layer === "rls" || (o.layer === "ok" && o.rows === 0), `${who.uid ?? who.role}: ${sql} → ${o.layer}`);
    }
  }
  await setEnv("test", "none");
});
await check("S15b pozastavenie predaja (web_provider='none'): nové nákupy nie, ale webhook / doťahovanie / reconciliation existujúcich predplatných áno — bez predĺženia prístupu", async () => {
  await setEnv("live", "none");
  await su("insert into public.billing_live_purchase_allowlist (company_id) values ($1) on conflict do nothing", [C.a2]);
  const rpc = await attempt(as(U.ownerA, S.ownerA2), "select public.esblu_billing_create_purchase_intent('esblu_complete', 'month', 'web', 'stripe_web_checkout', null, 'new', null)");
  assert.notEqual(rpc.layer, "ok", "predaj pozastavený aj pre povolenú firmu");
  // existujúce predplatné: webhook obnovy prejde, prístup = nové obdobie + 48 h (nie viac)
  const newEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  const f = await liveFixture(C.b, "sub_live_b", newEnd);
  const r = await sendWebhook(f.provider, ev("invoice.paid", { object: "invoice", id: "in_x", livemode: true, parent: { subscription_details: { subscription: "sub_live_b" } } }, true), WHSEC_LIVE);
  assert.equal(r.outcome, "applied", JSON.stringify(r));
  const until = (await su<{ v: string }>("select max(valid_until)::text v from public.company_entitlements where company_id = $1 and source = 'subscription' and status = 'active'", [C.b]))[0].v;
  assert.equal(ms(until) - newEnd * 1000, 48 * H, "prístup kotvený na obdobie od Stripe + 48 h");
  await su("delete from public.billing_event_cursors");
  const c = await runEventCatchup(serviceDb, f.provider, f.provider, { timeBudgetMs: 60_000 });
  assert.notEqual(c.result, "error", "doťahovanie beží aj pri pozastavenom predaji");
  await su("delete from public.billing_event_cursors");
  await su("delete from public.billing_live_purchase_allowlist");
  await setEnv("test", "none");
});
await check("S15b migrácia 20261119140000: idempotentná, rollback a znovu-forward", async () => {
  const sql = read("supabase/migrations/20261119140000_billing_live_purchase_allowlist.sql");
  await db.exec(sql);
  await db.exec(sql);
  await db.exec(read("supabase/rollback/20261119140000_billing_live_purchase_allowlist_rollback.sql"));
  assert.equal((await su<{ n: number }>("select count(*)::int n from information_schema.columns where table_name = 'billing_runtime_config' and column_name = 'live_purchase_scope'"))[0].n, 0);
  await db.exec(sql);
  assert.equal((await su<{ s: string }>("select live_purchase_scope s from public.billing_runtime_config"))[0].s, "allowlist");
});

await check("S15b rollback: neprázdny allowlist sa nezmaže (archív esblu_audit_archive), re-apply = čistá tabuľka", async () => {
  await su("insert into public.billing_live_purchase_allowlist (company_id, note) values ($1, 'rb test')", [C.b]);
  await db.exec(read("supabase/rollback/20261119140000_billing_live_purchase_allowlist_rollback.sql"));
  assert.equal((await su<{ t: string | null }>("select to_regclass('public.billing_live_purchase_allowlist')::text t"))[0].t, null);
  const arch = await su<{ t: string }>(
    "select c.relname::text t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'esblu_audit_archive' and c.relname like 'billing_live_purchase_allowlist_rb_%'");
  assert.equal(arch.length, 1);
  assert.equal((await su<{ n: number }>(`select count(*)::int n from esblu_audit_archive.${arch[0].t}`))[0].n, 1);
  await db.exec(read("supabase/migrations/20261119140000_billing_live_purchase_allowlist.sql"));
  assert.equal((await su<{ n: number }>("select count(*)::int n from public.billing_live_purchase_allowlist"))[0].n, 0);
});

await check("migrácia 20261119130000: idempotentná; rollback (pri test prostredí) a znovu-forward", async () => {
  const sql = read("supabase/migrations/20261119130000_billing_live_mode.sql");
  await su("delete from public.billing_event_cursors where environment = 'live'");
  await setEnv("test", "none");
  await db.exec(sql);
  await db.exec(sql);
  await db.exec(read("supabase/rollback/20261119130000_billing_live_mode_rollback.sql"));
  await fails(() => su("update public.billing_runtime_config set environment = 'live', web_provider = 'stripe'"), /env_check/);
  await su("select public.esblu_billing_record_event('stripe', 'live', 'evt_rb_live', 'x', now(), null)"); // bez guardu po rollbacku
  await su("delete from public.billing_events where provider_event_id = 'evt_rb_live'");
  await db.exec(sql);
  await fails(() => su("select public.esblu_billing_record_event('stripe', 'live', 'evt_rb_live2', 'x', now(), null)"), /ENVIRONMENT_MISMATCH/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
