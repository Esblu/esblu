// =============================================================================
// P4 (2026-11-23) — billing prevádzka: retry zlyhaných udalostí (catch-up replay, backoff, dead-letter),
// ops alerty (perzistencia, deduplikácia, doručenie bez PII), účtovná kópia Stripe dokladov
// (faktúra / dobropis / refundácia), archív PDF, mesačný účtovný export, prístupová matica, migrácie
// 20261123100000–20261123120000 vrátane rollbacku (bez straty auditných dát).
// SKUTOČNÝ PostgreSQL (PGlite), čistý replay VŠETKÝCH migrácií + skutočná TS pipeline s MOCKOM
// Stripe API. Nikdy Supabase / Stripe.
//
//   npm run test:billing-ops-db
// =============================================================================
/* eslint-disable @typescript-eslint/no-unused-vars -- spoločný harness (fixtures pre všetky roly) */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { processWebhook, type BillingDb } from "@/lib/billing/pipeline";
import { StripeTestProvider } from "@/lib/billing/providers/stripe";
import { runEventCatchup } from "@/lib/billing/event-catchup";
import { runFailedEventRetry } from "@/lib/billing/event-retry";
import { dbOpsSignals, formatAlertEmail, runOpsMonitor, recordHeartbeat, type AlertMailer, type PendingAlert } from "@/lib/billing/ops-alerts";
import { fetchStripePdf, runDocumentArchive, type ArchiveStorage } from "@/lib/billing/document-archive";
import { buildAccountingCsv, importStripeBalanceTransactions, monthRange } from "@/lib/billing/accounting-export";
import { STRIPE_API_VERSION } from "@/lib/billing/stripe-api-version";
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const H = 3600_000;
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
const fails = async (fn: () => Promise<unknown>, re: RegExp) => {
  try { await fn(); } catch (e) { assert.match(e instanceof Error ? e.message : String(e), re); return; }
  assert.fail("očakávaná chyba");
};
const n = async (sql: string, params: unknown[] = []) => Number((await su<{ n: number }>(sql, params))[0].n);
const evRow = async (id: string) => (await su<Json>("select status, attempts, error_code, dead_letter, dead_lettered_at, next_retry_at, payload_sha256 from public.billing_events where provider_event_id = $1", [id]))[0];
const alerts = async (code: string) => su<Json>("select * from public.billing_ops_alerts where code = $1 and environment = 'test' order by created_at", [code]);

// Staging DB: test prostredie, web_provider stripe.
await su("update public.billing_runtime_config set environment = 'test', web_provider = 'stripe', allow_mock_plans = false, enabled_methods = array['stripe_web_checkout']");

// ----------------------------------------------------------------------------- Stripe sandbox mock
const KEY = "sk_test_" + "T".repeat(24);
const WHSEC = "whsec_" + "t".repeat(32);
type Call = { method: string; path: string; version: string | null };
function stripeMock(subId: string, cpeS: number) {
  const st = {
    acct: "acct_TESTOPS0001",
    failSubscription: false,
    sub: { object: "subscription", id: subId, customer: `cus_${subId}`, status: "active", livemode: false, cancel_at_period_end: false, cancel_at: null as number | null,
      canceled_at: null as number | null, ended_at: null as number | null, metadata: {},
      items: { data: [{ id: "si_t", price: { id: "price_test_ops_m" }, current_period_start: cpeS - 30 * 86400, current_period_end: cpeS }] },
      latest_invoice: `in_${subId}` } as Record<string, unknown>,
    events: [] as Record<string, unknown>[],
    eventStore: new Map<string, Record<string, unknown>>(),
    balance: [] as Record<string, unknown>[],
    payouts: [] as Record<string, unknown>[],
    payoutTxns: new Map<string, Record<string, unknown>[]>(),
    calls: [] as Call[],
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v1/, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    st.calls.push({ method: init?.method ?? "GET", path: p, version: headers["Stripe-Version"] ?? null });
    if (p === "/account") return json({ object: "account", id: st.acct });
    if (p === "/events") {
      const eb = u.searchParams.get("ending_before");
      const list = [...st.events].reverse();
      if (eb) { const i = list.findIndex((e) => e.id === eb); if (i < 0) return json({ error: {} }, 404); return json({ object: "list", data: list.slice(0, i), has_more: false }); }
      return json({ object: "list", data: list, has_more: false });
    }
    if (p.startsWith("/events/")) { const e = st.eventStore.get(decodeURIComponent(p.slice(8))); return e ? json(e) : json({ error: {} }, 404); }
    if (p.startsWith("/subscriptions/")) return st.failSubscription ? json({ error: {} }, 503) : json(st.sub);
    if (p === "/invoice_payments") return json({ object: "list", data: [{ object: "invoice_payment", status: "paid", invoice: u.searchParams.get("invoice"), payment: { type: "payment_intent", payment_intent: `pi_${subId}` } }] });
    if (p === "/balance_transactions") {
      const payout = u.searchParams.get("payout");
      if (payout) return json({ object: "list", data: st.payoutTxns.get(payout) ?? [], has_more: false });
      return json({ object: "list", data: st.balance, has_more: false });
    }
    if (p === "/payouts") return json({ object: "list", data: st.payouts, has_more: false });
    return json({ error: {} }, 404);
  }) as unknown as typeof fetch;
  const provider = new StripeTestProvider({ secretKey: KEY, webhookSecret: WHSEC, fetchImpl });
  return { st, provider, fetchImpl };
}
let evN = 0;
const NOW_S = () => Math.floor(Date.now() / 1000);
function ev(type: string, object: unknown, apiVersion: string = STRIPE_API_VERSION) {
  return { object: "event", id: `evt_ops${++evN}x`, type, api_version: apiVersion, created: NOW_S(), livemode: false, data: { object } };
}
/** Webhook s INOU serializáciou ako API (Stripe posiela formátovaný JSON) — presne nález § 2.3. */
async function webhook(provider: StripeTestProvider, event: Record<string, unknown>, pretty = true, secret = WHSEC) {
  const raw = pretty ? JSON.stringify(event, null, 2) : JSON.stringify(event);
  return processWebhook(provider, raw, new Headers({ "stripe-signature": signTimestamped(raw, secret, NOW_S()) }), serviceDb, dbOpsSignals(serviceDb, "test"));
}
async function fixture(company: string, subId: string) {
  await su(`insert into public.billing_provider_prices (provider, environment, plan_code, billing_interval, provider_price_id, active)
    values ('stripe', 'test', 'esblu_complete', 'month', 'price_test_ops_m', true) on conflict do nothing`);
  await su(`insert into public.billing_provider_links (provider, environment, link_kind, external_id, company_id) values ('stripe', 'test', 'subscription', $1, $2) on conflict do nothing`, [subId, company]);
  await su(`insert into public.company_plan_selection (company_id, plan_kind, price_tier, modules, source) values ($1, 'complete', 'primary', '{}', 'staging_mock')
    on conflict (company_id) do update set plan_kind = 'complete'`, [company]);
  return stripeMock(subId, NOW_S() + 20 * 86400);
}
const invoice = (subId: string, status: string, extra: Record<string, unknown> = {}) => ({
  object: "invoice", id: `in_${subId}`, livemode: false, number: "ESB-0001", status, currency: "eur", customer: `cus_${subId}`,
  customer_name: "Jana Tajna", customer_email: "jana@example.invalid", customer_address: { country: "SK", line1: "Tajná 1" },
  customer_tax_exempt: "none", customer_tax_ids: [{ type: "eu_vat", value: "SK2020000000" }],
  subtotal: 1590, subtotal_excluding_tax: 1590, total: 1590, total_excluding_tax: 1590, amount_paid: status === "paid" ? 1590 : 0,
  total_taxes: [], status_transitions: { finalized_at: NOW_S() - 60, paid_at: status === "paid" ? NOW_S() : null },
  hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/test_x", invoice_pdf: "https://pay.stripe.com/invoice/acct_x/test_x/pdf",
  parent: { subscription_details: { subscription: subId } },
  lines: { data: [{ period: { start: NOW_S() - 60, end: NOW_S() + 30 * 86400 } }] }, ...extra,
});

// ============================================================================= 1) API verzia
await check("API verzia: každý request pipeline (webhook, doťahovanie, doklady) nesie Stripe-Version = pripnutá konštanta", async () => {
  const f = await fixture(C.a, "sub_ops_ver");
  const r = await webhook(f.provider, ev("customer.subscription.updated", f.st.sub));
  assert.equal(r.outcome, "applied", JSON.stringify(r));
  assert.ok(f.st.calls.length > 0);
  for (const c of f.st.calls) assert.equal(c.version, STRIPE_API_VERSION, `${c.method} ${c.path}`);
  const bad = new StripeTestProvider({ secretKey: KEY, webhookSecret: WHSEC, fetchImpl: f.fetchImpl, apiVersion: "2019-01-01" });
  await fails(() => bad.getSubscription({ providerSubscriptionId: "sub_ops_ver", providerCustomerId: null }), /NOT_CONFIGURED/);
});
await check("API verzia: webhook endpoint s inou verziou → ops alert WEBHOOK_API_VERSION_MISMATCH, udalosť sa spracuje", async () => {
  const f = await fixture(C.a, "sub_ops_ver");
  const r = await webhook(f.provider, ev("customer.subscription.updated", f.st.sub, "2024-06-20"));
  assert.ok(["applied", "stale", "duplicate"].includes(r.outcome), JSON.stringify(r));
  const a = await alerts("WEBHOOK_API_VERSION_MISMATCH");
  assert.equal(a.length, 1);
  assert.equal(a[0].state, "open");
});

// ============================================================================= 2) replay zlyhanej udalosti
await check("§ 2.3: udalosť zlyhaná vo webhooku (iné telo) → doťahovanie ju ZNOVA spracuje (nie payload_mismatch)", async () => {
  await su("delete from public.billing_event_cursors");
  const f = await fixture(C.b, "sub_ops_cu");
  await runEventCatchup(serviceDb, f.provider, f.provider, { timeBudgetMs: 60_000 }); // bootstrap kurzora
  f.st.sub = { ...f.st.sub, cancel_at_period_end: true };
  const e = ev("customer.subscription.updated", f.st.sub);
  f.st.events.push(e);
  f.st.failSubscription = true;
  const w = await webhook(f.provider, e, true);
  assert.deepEqual([w.outcome, w.code], ["retry", "NORMALIZE_FAILED"]);
  const before = await evRow(String(e.id));
  assert.equal(before.status, "failed");
  assert.match(String(before.payload_sha256), /^[0-9a-f]{64}$/, "webhook uložil hash formátovaného tela");
  f.st.failSubscription = false;
  const c = await runEventCatchup(serviceDb, f.provider, f.provider, { timeBudgetMs: 60_000 });
  assert.equal(c.result, "ok", JSON.stringify(c));
  assert.equal(c.outcomes.applied, 1, "doťahovanie udalosť aplikovalo " + JSON.stringify(c));
  assert.equal(c.outcomes.duplicate ?? 0, 0);
  const after = await evRow(String(e.id));
  assert.deepEqual([after.status, after.attempts, after.dead_letter], ["processed", 2, false]);
  assert.equal((await su<Json>("select cancel_at_period_end c from public.subscription_accounts where company_id = $1", [C.b]))[0].c, true);
  // podvrh rovnakého ID s iným telom cez WEBHOOK je stále odmietnutý (ochrana ostáva pre podpísaný kanál)
  const forged = await webhook(f.provider, { ...e, type: "customer.subscription.deleted" }, false);
  assert.deepEqual([forged.outcome, forged.code], ["duplicate", "payload_mismatch"]);
});

await check("retry: zlyhaná udalosť bez doťahovania → backoff 5 min, potom runFailedEventRetry (GET /v1/events/{id}) → applied", async () => {
  const f = await fixture(C.b, "sub_ops_cu");
  f.st.sub = { ...f.st.sub, cancel_at_period_end: false };
  const e = ev("customer.subscription.updated", f.st.sub);
  f.st.eventStore.set(String(e.id), e);
  f.st.failSubscription = true;
  assert.equal((await webhook(f.provider, e)).outcome, "retry");
  const r1 = await evRow(String(e.id));
  const delay = Date.parse(r1.next_retry_at) - Date.now();
  assert.ok(delay > 4 * 60_000 && delay <= 5 * 60_000 + 5_000, `backoff ~5 min (${delay})`);
  const notDue = await runFailedEventRetry(serviceDb, f.provider, f.provider);
  assert.equal(notDue.claimed, 0, "pred termínom sa neopakuje");
  f.st.failSubscription = false;
  await su("update public.billing_events set next_retry_at = now() - interval '1 second' where provider_event_id = $1", [e.id]);
  const r = await runFailedEventRetry(serviceDb, f.provider, f.provider);
  assert.equal(r.claimed, 1);
  assert.equal(r.outcomes.applied, 1, JSON.stringify(r));
  const done = await evRow(String(e.id));
  assert.deepEqual([done.status, done.next_retry_at, done.dead_letter], ["processed", null, false]);
  assert.ok(f.st.calls.some((c) => c.path === `/events/${e.id}`));
});

await check("retry: backoff rastie, po 8 pokusoch dead-letter; trvalá chyba = hneď dead-letter; udalosť mimo retencie = EVENT_UNAVAILABLE", async () => {
  const f = await fixture(C.b, "sub_ops_cu");
  const e = ev("customer.subscription.updated", f.st.sub);
  f.st.eventStore.set(String(e.id), e);
  f.st.failSubscription = true;
  assert.equal((await webhook(f.provider, e)).outcome, "retry");
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    await su("update public.billing_events set next_retry_at = now() - interval '1 second' where provider_event_id = $1", [e.id]);
    const r = await runFailedEventRetry(serviceDb, f.provider, f.provider);
    assert.equal(r.claimed, 1, `pokus ${i + 2}`);
    const row = await evRow(String(e.id));
    if (row.dead_letter) break;
    delays.push(Math.round((Date.parse(row.next_retry_at) - Date.now()) / 60_000));
  }
  const row = await evRow(String(e.id));
  assert.deepEqual([row.status, row.attempts, row.dead_letter], ["failed", 8, true], JSON.stringify(row));
  assert.deepEqual(delays, [10, 20, 40, 80, 160, 320], "exponenciálny backoff (min)");
  await su("update public.billing_events set next_retry_at = now() - interval '1 second' where provider_event_id = $1", [e.id]);
  assert.equal((await runFailedEventRetry(serviceDb, f.provider, f.provider)).claimed, 0, "dead-letter sa automaticky neopakuje");
  // trvalá chyba
  const bad = await su<Json>("select public.esblu_billing_record_event('stripe', 'test', 'evt_opsperm1', 'invoice.paid', now(), null) r");
  await su("update public.billing_events set status = 'failed', error_code = 'MALFORMED_PAYLOAD' where id = $1", [bad[0].r.event_id]);
  assert.equal((await evRow("evt_opsperm1")).dead_letter, true);
  // mimo retencie
  const gone = await su<Json>("select public.esblu_billing_record_event('stripe', 'test', 'evt_opsgone1', 'invoice.paid', now(), null) r");
  await su("update public.billing_events set status = 'failed', error_code = 'NORMALIZE_FAILED' where id = $1", [gone[0].r.event_id]);
  await su("update public.billing_events set next_retry_at = now() - interval '1 second' where provider_event_id = 'evt_opsgone1'");
  f.st.failSubscription = false;
  const g = await runFailedEventRetry(serviceDb, f.provider, f.provider);
  assert.equal(g.outcomes.dead_letter, 1, JSON.stringify(g));
  const gr = await evRow("evt_opsgone1");
  assert.deepEqual([gr.error_code, gr.dead_letter], ["EVENT_UNAVAILABLE", true]);
  // neskoršie doručenie Stripe (rovnaké telo) dead-letter udalosti stále spracuje → úspech zruší dead_letter, čas ostáva
  const again = await webhook(f.provider, e);
  assert.equal(again.outcome === "applied" || again.outcome === "stale", true, JSON.stringify(again));
  const fin = await evRow(String(e.id));
  assert.equal(fin.dead_letter, false);
  assert.ok(fin.dead_lettered_at, "auditná stopa dead-letter ostáva");
});

// ============================================================================= 3) ops alerty
const SECRET_RE = /(evt_|cus_|sub_|pi_|in_|cn_|txn_|whsec_|sk_|rk_|@|Jana|SK20)/;
await check("alerty: neplatné podpisy — 9 = counting, 10. v okne = open; jeden riadok (deduplikácia); detail bez tajomstiev", async () => {
  const f = await fixture(C.a, "sub_ops_ver");
  for (let i = 0; i < 9; i++) {
    const r = await webhook(f.provider, ev("customer.subscription.updated", f.st.sub), false, "whsec_" + "x".repeat(32));
    assert.equal(r.code, "INVALID_SIGNATURE");
  }
  let a = await alerts("WEBHOOK_SIGNATURE_FAILURES");
  assert.deepEqual([a.length, a[0].state, a[0].occurrences], [1, "counting", 9]);
  await webhook(f.provider, ev("customer.subscription.updated", f.st.sub), false, "whsec_" + "x".repeat(32));
  a = await alerts("WEBHOOK_SIGNATURE_FAILURES");
  assert.deepEqual([a.length, a[0].state, a[0].occurrences], [1, "open", 10]);
  assert.doesNotMatch(JSON.stringify(a[0].details), SECRET_RE);
  // sanitizácia v DB: e-mail, ID a text sa zahodia
  await su("select public.esblu_billing_ops_raise('test', 'TEST_SANITIZE', 'warning', 60, 1, $1::jsonb)",
    [JSON.stringify({ count: 3, email: "a@b.sk", sub: "sub_123", ok_code: "NORMALIZE_FAILED", Nested: 1, obj: { x: 1 } })]);
  assert.deepEqual((await alerts("TEST_SANITIZE"))[0].details, { count: 3, ok_code: "NORMALIZE_FAILED" });
  await fails(() => su("select public.esblu_billing_ops_raise('test', 'bad code', 'warning', 60, 1, '{}')"), /OPS_ALERT_INVALID/);
});

await check("alerty: collect — dead-letter, zlyhané udalosti, oneskorenie doťahovania, cron heartbeat, reconciliation; auto-resolve", async () => {
  await su("delete from public.billing_ops_alerts where code <> 'WEBHOOK_SIGNATURE_FAILURES'");
  const r = (await su<Json>("select public.esblu_billing_ops_collect('test') r"))[0].r;
  assert.ok(r.raised.includes("EVENT_DEAD_LETTER"), JSON.stringify(r));
  assert.equal((await alerts("EVENT_DEAD_LETTER"))[0].severity, "critical");
  // doťahovanie bez úspechu > 1 h
  await su("update public.billing_event_cursors set last_success_at = now() - interval '2 hours', consecutive_failures = 3, last_error_code = 'PROVIDER_ERROR' where environment = 'test'");
  // cron heartbeat: 2 zlyhania za sebou
  await recordHeartbeat(serviceDb, "stripe_events", "test", false, "CATCHUP_FAILED");
  await recordHeartbeat(serviceDb, "stripe_events", "test", false, "CATCHUP_FAILED");
  // reconciliation: nezhoda opravená v posledných 6 h + dead-letter
  const acc = (await su<{ id: string }>("select id from public.subscription_accounts where company_id = $1", [C.b]))[0].id;
  await su(`insert into public.billing_reconciliation (account_id, last_checked_at, last_result, dead_letter) values ($1, now(), 'corrected', false)
            on conflict (account_id) do update set last_checked_at = now(), last_result = 'corrected', dead_letter = false`, [acc]);
  const r2 = (await su<Json>("select public.esblu_billing_ops_collect('test') r"))[0].r;
  for (const code of ["CATCHUP_LAG", "CRON_STRIPE_EVENTS_FAILING", "RECONCILE_MISMATCH", "EVENT_DEAD_LETTER"]) assert.ok(r2.raised.includes(code), `${code} ${JSON.stringify(r2)}`);
  const lag = (await alerts("CATCHUP_LAG"))[0];
  assert.equal(lag.details.last_error, "PROVIDER_ERROR");
  assert.ok(lag.details.minutes_since_success >= 119);
  // druhý collect v tom istom okne → stále 1 riadok na kód (deduplikácia)
  await su("select public.esblu_billing_ops_collect('test')");
  assert.equal((await alerts("CATCHUP_LAG")).length, 1);
  assert.equal((await alerts("CATCHUP_LAG"))[0].occurrences, 2);
  // náprava → auto-resolve
  await su("update public.billing_event_cursors set last_success_at = now(), consecutive_failures = 0, last_error_code = null where environment = 'test'");
  await recordHeartbeat(serviceDb, "stripe_events", "test", true);
  const r3 = (await su<Json>("select public.esblu_billing_ops_collect('test') r"))[0].r;
  assert.ok(!r3.raised.includes("CATCHUP_LAG") && r3.resolved >= 2, JSON.stringify(r3));
  assert.equal((await alerts("CATCHUP_LAG"))[0].state, "resolved");
  assert.equal((await alerts("CRON_STRIPE_EVENTS_FAILING"))[0].state, "resolved");
});

await check("alerty: doručenie — jeden e-mail na alert a okno (opakovaný beh nič nepošle), text bez PII/ID/tajomstiev, zlyhanie = opakuje sa", async () => {
  const sent: Array<{ subject: string; text: string }> = [];
  let failNext = true;
  const mailer: AlertMailer = { async send(m) { if (failNext) { failNext = false; return "failed"; } sent.push(m); return "sent"; } };
  const first = await runOpsMonitor(serviceDb, "test", mailer);
  assert.equal(first.notifyFailed, 1);
  const second = await runOpsMonitor(serviceDb, "test", mailer);
  const third = await runOpsMonitor(serviceDb, "test", mailer);
  assert.equal(third.notified, 0, "deduplikácia — žiadny ďalší e-mail");
  assert.ok(first.notified + first.notifyFailed >= 2, JSON.stringify(first));
  assert.equal(second.notified, 1, "neúspešne doručený alert sa zopakuje " + JSON.stringify(second));
  assert.equal(sent.length, first.notified + 1);
  assert.ok(sent.some((m) => /CRITICAL: EVENT_DEAD_LETTER/.test(m.subject)));
  for (const m of sent) assert.doesNotMatch(m.subject + m.text, SECRET_RE, m.text);
  assert.ok(third.open.critical >= 1, "otvorený kritický alert → cron 503");
  const unsafe = formatAlertEmail({ id: "x", environment: "test", code: "X<script>", severity: "critical", occurrences: 1, first_seen_at: "x", last_seen_at: "x",
    details: { email: "jana@example.invalid", sub: "sub_1", n: 2 } } as PendingAlert);
  assert.doesNotMatch(unsafe.subject + unsafe.text, /script|jana|sub_1/);
});

// ============================================================================= 4) doklady
const doc = async (id: string) => (await su<Json>("select * from public.billing_invoice_documents where provider_document_id = $1", [id]))[0];
await check("doklady: invoice.finalized → paid (webhook) + replay + staršia udalosť z doťahovania → 1 riadok, stav iba dopredu, bez mena/e-mailu/adresy", async () => {
  const f = await fixture(C.t, "sub_ops_doc");
  const fin = ev("invoice.finalized", invoice("sub_ops_doc", "open"));
  const r1 = await webhook(f.provider, fin);
  assert.deepEqual([r1.outcome, r1.code], ["ignored", "DOCUMENT_ONLY"], JSON.stringify(r1) + JSON.stringify(await su("select status, error_code from public.billing_events order by received_at desc limit 1")));
  let d = await doc("in_sub_ops_doc");
  assert.deepEqual([d.status, d.kind, d.company_id, d.document_number, d.payment_intent_id], ["open", "invoice", C.t, "ESB-0001", null]);
  const paid = ev("invoice.paid", invoice("sub_ops_doc", "paid"));
  assert.equal((await webhook(f.provider, paid)).outcome, "applied");
  d = await doc("in_sub_ops_doc");
  assert.deepEqual([d.status, Number(d.total_minor), Number(d.tax_minor), d.currency, d.customer_country, d.payment_intent_id, d.provider_subscription_id],
    ["paid", 1590, 0, "EUR", "SK", "pi_sub_ops_doc", "sub_ops_doc"]);
  assert.deepEqual(d.customer_tax_ids, [{ type: "eu_vat", value: "SK2020000000" }]);
  assert.ok(d.pdf_next_attempt_at, "PDF čaká na archiváciu");
  const row = JSON.stringify(d);
  assert.doesNotMatch(row, /Jana|jana@|Tajná/, "meno / e-mail / adresa sa neukladajú");
  // replay toho istého webhooku = duplicate; staršia udalosť (finalized) cez API = nezníži stav
  assert.equal((await webhook(f.provider, paid)).outcome, "duplicate");
  const older = await su<Json>("select public.esblu_billing_upsert_document('test', 'evt_opsold1', $1::jsonb) r",
    [JSON.stringify({ kind: "invoice", provider_document_id: "in_sub_ops_doc", status: "open", total_minor: 999 })]);
  assert.equal(older[0].r.forward, false);
  d = await doc("in_sub_ops_doc");
  assert.deepEqual([d.status, Number(d.total_minor)], ["paid", 1590]);
  assert.equal(await n("select count(*)::int n from public.billing_invoice_documents where provider_document_id = 'in_sub_ops_doc'"), 1);
  // iné prostredie sa nezapíše
  await fails(() => su("select public.esblu_billing_upsert_document('live', null, $1::jsonb)", [JSON.stringify({ kind: "invoice", provider_document_id: "in_x" })]), /ENVIRONMENT_MISMATCH/);
});

await check("doklady: refundácia bez dobropisu → po 24 h alert REFUND_WITHOUT_CREDIT_NOTE; credit_note.created (väzba na faktúru) → alert zmizne", async () => {
  const f = await fixture(C.t, "sub_ops_doc");
  const charge = { object: "charge", id: "ch_opsdoc", livemode: false, amount: 1590, amount_refunded: 1590, refunded: true, currency: "eur", payment_intent: "pi_sub_ops_doc", invoice: "in_sub_ops_doc" };
  await webhook(f.provider, ev("charge.refunded", charge));
  const obs = (await su<Json>("select * from public.billing_refund_observations where payment_intent_id = 'pi_sub_ops_doc'"))[0];
  assert.equal(Number(obs.amount_refunded_minor), 1590);
  assert.equal(await n("select count(*)::int n from public.esblu_billing_refunds_without_credit_note('test', interval '24 hours')"), 0, "pred 24 h nie");
  await su("update public.billing_refund_observations set first_observed_at = now() - interval '25 hours'");
  let r = (await su<Json>("select public.esblu_billing_ops_collect('test') r"))[0].r;
  assert.ok(r.raised.includes("REFUND_WITHOUT_CREDIT_NOTE"), JSON.stringify(r));
  const note = { object: "credit_note", id: "cn_opsdoc1", livemode: false, number: "ESB-0001-CN-01", invoice: "in_sub_ops_doc", status: "issued", currency: "eur",
    customer: "cus_sub_ops_doc", subtotal: 1590, subtotal_excluding_tax: 1590, total: 1590, total_excluding_tax: 1590, total_taxes: [], reason: "requested_by_customer",
    type: "post_payment", created: NOW_S(), effective_at: NOW_S(), pdf: "https://pay.stripe.com/credit_notes/acct_x/test_cn/pdf", memo: "Jana Tajna" };
  assert.equal((await webhook(f.provider, ev("credit_note.created", note))).code, "DOCUMENT_ONLY");
  const cn = await doc("cn_opsdoc1");
  assert.deepEqual([cn.kind, cn.related_invoice_id, cn.company_id, cn.status, cn.credit_reason], ["credit_note", "in_sub_ops_doc", C.t, "issued", "requested_by_customer"]);
  assert.doesNotMatch(JSON.stringify(cn), /Jana/);
  r = (await su<Json>("select public.esblu_billing_ops_collect('test') r"))[0].r;
  assert.ok(!r.raised.includes("REFUND_WITHOUT_CREDIT_NOTE"), JSON.stringify(r));
  assert.equal((await alerts("REFUND_WITHOUT_CREDIT_NOTE"))[0].state, "resolved");
});

await check("doklady: zlyhanie zápisu dokladu → udalosť failed DOCUMENT_FAILED (retry), nič sa neaplikuje polovične", async () => {
  const f = await fixture(C.t, "sub_ops_doc");
  const e = ev("invoice.finalized", invoice("sub_ops_doc", "open", { id: "in_bad-id!" }));
  const r = await webhook(f.provider, e);
  assert.deepEqual([r.outcome, r.code], ["retry", "DOCUMENT_FAILED"]);
  const row = await evRow(String(e.id));
  assert.deepEqual([row.status, row.error_code, row.dead_letter], ["failed", "DOCUMENT_FAILED", false]);
  assert.ok(row.next_retry_at);
});

// ============================================================================= 5) archív PDF
await check("archív PDF: stiahne iba z *.stripe.com, uloží bez prepisu, SHA-256 + cesta; potom nemenné", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n% esblu test\n");
  const store = new Map<string, Uint8Array>();
  const storage: ArchiveStorage = {
    async upload(p, b) { if (store.has(p)) return "exists"; store.set(p, b); return "ok"; },
    async download(p) { return store.get(p) ?? null; },
  };
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    if (url.includes("/credit_notes/")) return new Response(null, { status: 302, headers: { location: "https://files.stripe.com/files/cn.pdf" } });
    return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
  }) as unknown as typeof fetch;
  const r = await runDocumentArchive(serviceDb, "test", storage, { fetchImpl });
  assert.deepEqual([r.claimed, r.archived, r.failed], [2, 2, 0], JSON.stringify(r));
  const d = await doc("in_sub_ops_doc");
  assert.match(d.pdf_sha256, /^[0-9a-f]{64}$/);
  assert.match(d.pdf_storage_path, /^test\/\d{4}\/\d{2}\/invoice\/in_sub_ops_doc\.pdf$/);
  assert.ok(store.has(d.pdf_storage_path));
  assert.ok(urls.includes("https://files.stripe.com/files/cn.pdf"), "presmerovanie v rámci stripe.com");
  assert.equal((await runDocumentArchive(serviceDb, "test", storage, { fetchImpl })).claimed, 0, "už archivované");
  await fails(() => su("update public.billing_invoice_documents set pdf_sha256 = repeat('0', 64) where provider_document_id = 'in_sub_ops_doc'"), /ARCHIVE_IMMUTABLE/);
  // SSRF ochrana
  const evil = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.pdf" } })) as unknown as typeof fetch;
  assert.equal(await fetchStripePdf("https://pay.stripe.com/invoice/x/pdf", evil), "URL_NOT_ALLOWED");
  assert.equal(await fetchStripePdf("https://stripe.com.evil.example/x", fetch), "URL_NOT_ALLOWED");
  const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  assert.equal(await fetchStripePdf("https://pay.stripe.com/invoice/x/pdf", html), "NOT_A_PDF");
  await fails(() => su("update public.billing_invoice_documents set pdf_url = 'https://evil.example/x.pdf' where provider_document_id = 'cn_opsdoc1'"), /url_check/);
});

// ============================================================================= 6) účtovný export
await check("export: import balance transactions + výplaty → CSV s hrubou sumou, poplatkom, čistou sumou a payout ID; audit exportu", async () => {
  const f = await fixture(C.t, "sub_ops_doc");
  const t = NOW_S() - 30;
  f.st.balance = [
    { object: "balance_transaction", id: "txn_opsch1", type: "charge", reporting_category: "charge", amount: 1590, fee: 47, net: 1543, currency: "eur", status: "available", created: t, available_on: t + 86400,
      source: { object: "charge", id: "ch_opsdoc", payment_intent: "pi_sub_ops_doc", billing_details: { email: "jana@example.invalid" } } },
    { object: "balance_transaction", id: "txn_opsre1", type: "refund", reporting_category: "refund", amount: -1590, fee: 0, net: -1590, currency: "eur", status: "available", created: t + 5,
      source: { object: "refund", id: "re_opsdoc", charge: "ch_opsdoc", payment_intent: "pi_sub_ops_doc" } },
  ];
  f.st.payouts = [{ object: "payout", id: "po_opsp1", status: "paid", arrival_date: t + 2 * 86400 }];
  f.st.payoutTxns.set("po_opsp1", [f.st.balance[0]]);
  const month = new Date().toISOString().slice(0, 7);
  const range = monthRange(month)!;
  const imp = await importStripeBalanceTransactions(serviceDb, f.provider, "test", range);
  assert.deepEqual([imp.transactions, imp.payouts, imp.payoutLinks, imp.truncated], [2, 1, 1, false]);
  assert.ok(f.st.calls.filter((c) => c.path === "/balance_transactions").every((c) => c.version === STRIPE_API_VERSION));
  // idempotentný import
  await importStripeBalanceTransactions(serviceDb, f.provider, "test", range);
  assert.equal(await n("select count(*)::int n from public.billing_balance_transactions"), 2);
  const rows = (await su<Json>("select public.esblu_billing_accounting_export('test', $1, $2, $3) r", [range.from.toISOString(), range.to.toISOString(), U.ownerA]))[0].r as Json[];
  const inv = rows.find((r) => r.record_type === "invoice" && r.stripe_document_id === "in_sub_ops_doc")!;
  assert.deepEqual([Number(inv.gross_minor), Number(inv.fee_minor), Number(inv.net_minor), inv.payout_ids, inv.pdf_archived], [1590, 47, 1543, "po_opsp1", true]);
  const cn = rows.find((r) => r.record_type === "credit_note")!;
  assert.deepEqual([cn.related_invoice_number, Number(cn.gross_minor)], ["ESB-0001", -1590]);
  assert.equal(rows.filter((r) => r.record_type === "balance_transaction").length, 2);
  const csv = buildAccountingCsv(rows);
  assert.ok(csv.startsWith("﻿record_type;document_date;document_number"));
  assert.match(csv, /"invoice";"[^"]+";"ESB-0001";"in_sub_ops_doc"/);
  assert.match(csv, /;15\.90;0\.00;15\.90;/);
  assert.match(csv, /;15\.90;0\.47;15\.43;/);
  assert.match(csv, /"eu_vat:SK2020000000"/);
  assert.doesNotMatch(csv, /jana@|Jana|Tajná/);
  assert.equal(await n("select count(*)::int n from public.billing_accounting_export_log where actor_user_id = $1", [U.ownerA]), 1);
  await fails(() => su("select public.esblu_billing_accounting_export('test', now(), now() - interval '1 day', null)"), /EXPORT_INVALID/);
  assert.equal(monthRange("2026-13"), null);
});

// ============================================================================= 7) prístupová matica
await check("prístup: owner / admin / employee / iná firma / anon — žiadne čítanie ani zápis nových tabuliek, žiadne service RPC; admin export iba cez billing_ops_admins", async () => {
  const tables = ["billing_invoice_documents", "billing_refund_observations", "billing_balance_transactions", "billing_ops_admins", "billing_accounting_export_log", "billing_ops_alerts", "billing_ops_heartbeats"];
  const rpcs = [
    "select public.esblu_billing_accounting_export('test', now() - interval '1 day', now(), null)",
    "select public.esblu_billing_upsert_document('test', null, '{}'::jsonb)",
    "select public.esblu_billing_ops_raise('test', 'X', 'warning', 60, 1, '{}')",
    "select public.esblu_billing_ops_collect('test')",
    "select public.esblu_billing_event_retry_claim('stripe', 'test', 5)",
    "select public.esblu_billing_document_archive_claim('test', 5)",
    "select public.esblu_billing_upsert_balance_transactions('test', '[]'::jsonb)",
  ];
  const ownerA = as(U.ownerA, S.ownerA), adminA = as(U.adminA, S.adminA), employeeA = as(U.employeeA, S.employeeA), ownerB = as(U.ownerB, S.ownerB);
  for (const who of [ownerA, adminA, employeeA, ownerB, anon]) {
    for (const t of tables) {
      for (const sql of [`select * from public.${t}`, `update public.${t} set environment = environment`, `delete from public.${t}`]) {
        if (t === "billing_ops_admins" && sql.includes("environment")) continue;
        const o = await attempt(who, sql);
        assert.ok(o.layer === "privilege" || o.layer === "rls" || (o.layer === "ok" && o.rows === 0), `${who.uid ?? who.role}: ${sql} → ${o.layer} ${o.rows}`);
      }
    }
    for (const sql of rpcs) assert.equal((await attempt(who, sql)).layer, "privilege", `${who.uid ?? who.role}: ${sql}`);
  }
  assert.equal((await attempt(anon, "select public.esblu_billing_is_ops_admin() a")).layer, "privilege");
  assert.equal((await attempt(ownerA, "select public.esblu_billing_is_ops_admin() a")).data[0].a, false);
  await su("insert into public.billing_ops_admins (user_id, note) values ($1, 'test operátor')", [U.ownerB]);
  assert.equal((await attempt(ownerB, "select public.esblu_billing_is_ops_admin() a")).data[0].a, true);
  assert.equal((await attempt(ownerA, "select public.esblu_billing_is_ops_admin() a")).data[0].a, false, "iná firma / iný používateľ");
  // service_role nemá DELETE nad účtovnými dátami
  assert.equal((await attempt(service, "delete from public.billing_invoice_documents")).layer, "privilege");
  assert.equal((await attempt(service, "delete from public.billing_ops_alerts")).layer, "privilege");
  assert.equal((await attempt(service, "insert into public.billing_ops_admins (user_id) values (gen_random_uuid())")).layer, "privilege");
});

// ============================================================================= 8) migrácie + rollback
await check("migrácie 20261123100000–20261123120000: idempotentné; rollback NEMAŽE auditné/účtovné dáta (esblu_audit_archive); znovu-forward", async () => {
  const fwd = ["20261123100000_billing_event_retry", "20261123110000_billing_invoice_documents", "20261123120000_billing_ops_alerts"];
  for (const m of fwd) { await db.exec(read(`${MIGRATIONS}/${m}.sql`)); await db.exec(read(`${MIGRATIONS}/${m}.sql`)); }
  const docs = await n("select count(*)::int n from public.billing_invoice_documents");
  const alertsN = await n("select count(*)::int n from public.billing_ops_alerts");
  const dead = await n("select count(*)::int n from public.billing_events where dead_lettered_at is not null");
  assert.ok(docs >= 2 && alertsN >= 3 && dead >= 1);
  await su("insert into storage.objects (bucket_id, name) values ('billing-documents', 'test/2026/11/invoice/in_x.pdf')");
  for (const m of [...fwd].reverse()) await db.exec(read(`supabase/rollback/${m}_rollback.sql`));
  assert.equal((await su<{ t: string | null }>("select to_regclass('public.billing_invoice_documents')::text t"))[0].t, null);
  const archived = async (prefix: string) => {
    const t = await su<{ t: string }>("select c.relname::text t from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'esblu_audit_archive' and c.relname like $1 and c.relkind = 'r'", [`${prefix}_rb_%`]);
    assert.equal(t.length, 1, prefix);
    return n(`select count(*)::int n from esblu_audit_archive.${t[0].t}`);
  };
  assert.equal(await archived("billing_invoice_documents"), docs);
  assert.equal(await archived("billing_ops_alerts"), alertsN);
  assert.ok((await archived("billing_balance_transactions")) >= 2);
  assert.equal(await archived("billing_ops_admins"), 1);
  assert.equal(await n("select count(*)::int n from public.billing_events where dead_lettered_at is not null"), dead, "dead-letter stopa ostáva");
  assert.equal(await n("select count(*)::int n from storage.buckets where id = 'billing-documents'"), 1, "bucket s archivovanými PDF ostáva");
  for (const m of fwd) await db.exec(read(`${MIGRATIONS}/${m}.sql`));
  assert.equal(await n("select count(*)::int n from public.billing_invoice_documents"), 0, "re-apply = čisté tabuľky");
  assert.equal(await n("select count(*)::int n from pg_trigger where tgname = 'esblu_billing_events_retry_plan'"), 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
