// =============================================================================
// Subscriptions lifecycle — unit / contract testy (bez DB, bez siete).
// Suity (prefix v názve): subscription-domain, stripe-adapter, google-play-adapter,
// apple-adapter, cross-provider, provider-modes, reconciliation, native-contract.
//   npm run test:subscriptions-lifecycle   (alias: test:subscription-domain …)
// Voliteľný filter: SUITE=stripe-adapter npm run test:subscriptions-lifecycle
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appleNotificationStatus,
  CANONICAL_STATUSES,
  ENTITLING_STATUSES,
  GOOGLE_STATE_MAP,
  isOpenStatus,
  manageHere,
  managedVia,
  managedViaMessageKey,
  OPEN_STATUSES,
  purchaseDecision,
  STRIPE_STATUS_MAP,
  TERMINAL_STATUSES,
} from "@/lib/billing/canonical-state";
import { canManageOnPlatform, canStartCheckout, hasPaidAccess, parseSubscriptionView } from "@/lib/billing/client-model";
import { normalizeGooglePluginResult } from "@/lib/billing/native-bridge-contract";
import { BILLING_ENV_SCHEMA, resolveProviderModes, validateBillingEnv } from "@/lib/billing/provider-modes";
import { normalizeAppleNotification, normalizeGoogleSubscription, GooglePlayProvider } from "@/lib/billing/providers/stores";
import { mapStripeStatus, StripeTestProvider } from "@/lib/billing/providers/stripe";
import { appleReconcileSource, appleStatusCodeToCanonical, googleReconcileSource } from "@/lib/billing/reconcile-sources";
import { hasDrift, reconcileOne, runReconciliation, type ReconcileCandidate } from "@/lib/billing/reconciliation";
import { signTimestamped } from "@/lib/billing/signature";
import { CANONICAL_STATUSES as PROVIDER_STATUSES, type NormalizedSubscriptionState } from "@/lib/billing/types";
import type { BillingDb } from "@/lib/billing/pipeline";

const SUITE = (process.argv[2] ?? process.env.SUITE ?? "").replace(/^--suite=/, "").trim() || null;
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  const suite = label.split(":")[0];
  if (SUITE && suite !== SUITE) return;
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const MIGRATION = read("supabase/migrations/20261011120000_subscriptions_lifecycle_hardening.sql");
const sqlList = (fn: string) => {
  const body = MIGRATION.slice(MIGRATION.indexOf(`function public.${fn}(`));
  const m = body.match(/in \(([^)]*)\)/);
  return new Set((m ? m[1] : "").match(/'([a-z_]+)'/g)!.map((x) => x.replace(/'/g, "")));
};

// ============================================================================= subscription-domain
await check("subscription-domain: TS kanonické stavy = DB (canonical_statuses)", () => {
  const m = MIGRATION.match(/select array\[([^\]]*)\]::text\[\]/)!;
  const sql = m[1].match(/'([a-z_]+)'/g)!.map((x) => x.replace(/'/g, ""));
  assert.deepEqual(sql, [...CANONICAL_STATUSES]);
  // Provider normalizácia môže vrátiť každý stav okrem 'none'.
  assert.deepEqual([...PROVIDER_STATUSES].sort(), CANONICAL_STATUSES.filter((s) => s !== "none").sort());
});
await check("subscription-domain: open / entitling / terminal sady = DB helpery", () => {
  assert.deepEqual([...OPEN_STATUSES].sort(), [...sqlList("esblu_billing_status_is_open")].sort());
  assert.deepEqual([...ENTITLING_STATUSES].sort(), [...sqlList("esblu_billing_status_is_entitling")].sort());
  assert.deepEqual([...TERMINAL_STATUSES].sort(), [...sqlList("esblu_billing_status_is_terminal")].sort());
});
await check("subscription-domain: sady sú disjunktné a pokrývajú všetky stavy (okrem none)", () => {
  for (const s of CANONICAL_STATUSES) {
    if (s === "none") continue;
    const open = OPEN_STATUSES.has(s);
    const terminal = TERMINAL_STATUSES.has(s);
    assert.ok(open !== terminal, `${s} musí byť buď otvorený, alebo terminálny`);
  }
  for (const s of ENTITLING_STATUSES) assert.ok(OPEN_STATUSES.has(s), `entitling ${s} musí byť otvorený`);
  for (const s of ["account_hold", "pending", "paused", "refunded", "revoked", "canceled", "expired"]) assert.ok(!ENTITLING_STATUSES.has(s as never), s);
});
await check("subscription-domain: nárok nikdy nevzniká z textu providera (mapy idú iba do kanonických stavov)", () => {
  for (const v of Object.values(STRIPE_STATUS_MAP)) assert.ok((CANONICAL_STATUSES as readonly string[]).includes(v));
  for (const v of Object.values(GOOGLE_STATE_MAP)) assert.ok(v === "active_or_expired" || (CANONICAL_STATUSES as readonly string[]).includes(v));
});

// ============================================================================= stripe-adapter
await check("stripe-adapter: mapa stavov (incomplete→pending, unpaid→account_hold, incomplete_expired→expired)", () => {
  assert.equal(mapStripeStatus("incomplete"), "pending");
  assert.equal(mapStripeStatus("unpaid"), "account_hold");
  assert.equal(mapStripeStatus("incomplete_expired"), "expired");
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("bogus"), null);
});

const NOW = 1_790_000_000;
const KEY = "sk_test_" + "a".repeat(24);
const WHSEC = "whsec_" + "b".repeat(32);
const SUB = {
  object: "subscription", id: "sub_r1", customer: "cus_1", status: "active", cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
  metadata: {}, items: { data: [{ id: "si_1", price: { id: "price_pro_m" }, current_period_start: NOW, current_period_end: NOW + 30 * 86400 }] },
};
function stripe(responses: Record<string, unknown>, status = 200) {
  const fetchImpl = (async (url: string) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? responses[key] : { error: {} }), { status: key ? status : 404 });
  }) as unknown as typeof fetch;
  return new StripeTestProvider({ secretKey: KEY, webhookSecret: WHSEC, fetchImpl, now: () => new Date(NOW * 1000) });
}
function stripeEvent(type: string, object: unknown, id = `evt_${type.replace(/\W/g, "_")}`) {
  const raw = JSON.stringify({ object: "event", id, type, created: NOW, livemode: false, data: { object } });
  return { raw, headers: new Headers({ "stripe-signature": signTimestamped(raw, WHSEC, NOW) }) };
}
const CHARGE_BASE = { object: "charge", id: "ch_1", amount: 1218, currency: "eur", payment_intent: "pi_1" };
const lookup = { "/invoice_payments": { data: [{ invoice: "in_1" }] }, "/invoices/in_1": { object: "invoice", id: "in_1", subscription: "sub_r1" }, "/subscriptions/sub_r1": SUB, "/charges/ch_1": CHARGE_BASE };

await check("stripe-adapter: úplný refund → kanonický refunded + refund charge (reporting)", async () => {
  const p = stripe(lookup);
  const e = stripeEvent("charge.refunded", { ...CHARGE_BASE, amount_refunded: 1218, refunded: true });
  const r = await p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers));
  assert.equal(r.kind, "state");
  if (r.kind !== "state") return;
  assert.equal(r.state.status, "refunded");
  assert.ok(r.state.ended_at);
  assert.equal(r.state.charge?.kind, "refund");
});
await check("stripe-adapter: čiastočný refund → iba charge (bez zmeny nároku)", async () => {
  const p = stripe(lookup);
  const e = stripeEvent("charge.refunded", { ...CHARGE_BASE, amount_refunded: 200, refunded: false });
  const r = await p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers));
  assert.equal(r.kind, "charge");
});
await check("stripe-adapter: refund bez dohľadateľného predplatného → audit REFUND_NEEDS_OPERATOR", async () => {
  const p = stripe({ "/invoice_payments": { data: [] } });
  const e = stripeEvent("charge.refunded", { ...CHARGE_BASE, amount_refunded: 1218, refunded: true });
  const r = await p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers));
  assert.deepEqual(r, { kind: "ignore", reason: "REFUND_NEEDS_OPERATOR" });
});
await check("stripe-adapter: dispute.created → review_flag dispute_open, stav bez zmeny; closed lost → revoked; won → príznak zmazaný", async () => {
  const p = stripe(lookup);
  const created = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_1", charge: "ch_1", status: "needs_response" });
  const r1 = await p.normalizeEvent(await p.verifyWebhook(created.raw, created.headers));
  assert.ok(r1.kind === "state" && r1.state.status === "active" && r1.state.review_flag === "dispute_open");
  const lost = stripeEvent("charge.dispute.closed", { object: "dispute", id: "dp_1", charge: "ch_1", status: "lost" }, "evt_lost");
  const r2 = await p.normalizeEvent(await p.verifyWebhook(lost.raw, lost.headers));
  assert.ok(r2.kind === "state" && r2.state.status === "revoked" && r2.state.review_flag === null);
  const won = stripeEvent("charge.dispute.closed", { object: "dispute", id: "dp_1", charge: "ch_1", status: "won" }, "evt_won");
  const r3 = await p.normalizeEvent(await p.verifyWebhook(won.raw, won.headers));
  assert.ok(r3.kind === "state" && r3.state.status === "active" && r3.state.review_flag === null);
});
await check("stripe-adapter: neplatný podpis / live event / starý timestamp sú odmietnuté", async () => {
  const p = stripe(lookup);
  const e = stripeEvent("customer.subscription.updated", SUB);
  await assert.rejects(p.verifyWebhook(e.raw, new Headers({ "stripe-signature": signTimestamped(e.raw, "whsec_" + "c".repeat(32), NOW) })), /INVALID_SIGNATURE/);
  const live = JSON.stringify({ object: "event", id: "evt_live", type: "x", created: NOW, livemode: true, data: { object: {} } });
  await assert.rejects(p.verifyWebhook(live, new Headers({ "stripe-signature": signTimestamped(live, WHSEC, NOW) })), /LIVE_MODE_FORBIDDEN/);
  await assert.rejects(p.verifyWebhook(e.raw, new Headers({ "stripe-signature": signTimestamped(e.raw, WHSEC, NOW - 1000) })), /STALE_SIGNATURE/);
});
await check("stripe-adapter: stav sa vždy znova načíta z API (snapshot v evente sa ignoruje)", async () => {
  const p = stripe({ "/subscriptions/sub_r1": { ...SUB, status: "past_due" } });
  const e = stripeEvent("customer.subscription.updated", { ...SUB, status: "active" });
  const r = await p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers));
  assert.ok(r.kind === "state" && r.state.status === "past_due");
});
await check("stripe-adapter: provider timeout / 5xx pri normalizácii → chyba (pipeline vráti retry)", async () => {
  const p = stripe({ "/subscriptions/sub_r1": { error: {} } }, 503);
  const e = stripeEvent("customer.subscription.updated", SUB);
  await assert.rejects(p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers)), /PROVIDER_ERROR/);
});

// ============================================================================= google-play-adapter
const gResource = (state: string, expiry = "2099-01-01T00:00:00.000Z") => ({
  subscriptionState: state, startTime: "2026-10-01T00:00:00.000Z",
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "acct" },
  lineItems: [{ productId: "esblu_test_pro", expiryTime: expiry, offerDetails: { basePlanId: "monthly" } }],
});
const gState = (state: string, extra: Partial<Parameters<typeof normalizeGoogleSubscription>[0]> = {}) => {
  const r = normalizeGoogleSubscription({ purchaseToken: "gp_tok_123456", eventTimeMillis: Date.parse("2026-10-11T00:00:00Z"), resource: gResource(state), ...extra });
  assert.equal(r.kind, "state");
  return (r as { state: NormalizedSubscriptionState }).state;
};
await check("google-play-adapter: pending / grace (grace_until=expiry) / hold / paused / expired", () => {
  assert.equal(gState("SUBSCRIPTION_STATE_PENDING").status, "pending");
  const grace = gState("SUBSCRIPTION_STATE_IN_GRACE_PERIOD");
  assert.equal(grace.status, "grace_period");
  assert.equal(grace.grace_until, "2099-01-01T00:00:00.000Z");
  assert.equal(gState("SUBSCRIPTION_STATE_ON_HOLD").status, "account_hold");
  assert.equal(gState("SUBSCRIPTION_STATE_PAUSED").status, "paused");
  const exp = gState("SUBSCRIPTION_STATE_EXPIRED");
  assert.equal(exp.status, "expired");
  assert.ok(exp.ended_at);
});
await check("google-play-adapter: RTDN SUBSCRIPTION_REVOKED (12) → revoked; voided purchase → refunded", () => {
  assert.equal(gState("SUBSCRIPTION_STATE_EXPIRED", { notificationType: 12 }).status, "revoked");
  assert.equal(gState("SUBSCRIPTION_STATE_ACTIVE", { voided: true }).status, "refunded");
  assert.equal(gState("SUBSCRIPTION_STATE_ACTIVE", { notificationType: 4 }).status, "active", "iné typy stav neprepisujú");
});
await check("google-play-adapter: canceled s budúcim expiry = active + cancel_at_period_end", () => {
  const s = gState("SUBSCRIPTION_STATE_CANCELED");
  assert.equal(s.status, "active");
  assert.equal(s.cancel_at_period_end, true);
});
await check("google-play-adapter: RTDN voidedPurchaseNotification sa rozpozná (bez API stav nie je)", async () => {
  const api = { getSubscriptionV2: async () => gResource("SUBSCRIPTION_STATE_EXPIRED"), acknowledge: async () => undefined } as never;
  const provider = new GooglePlayProvider({ api, packageName: "com.esblu.app", verifyPushToken: async () => undefined });
  const msg = { packageName: "com.esblu.app", eventTimeMillis: String(Date.parse("2026-10-11T00:00:00Z")), voidedPurchaseNotification: { purchaseToken: "gp_tok_123456", orderId: "GPA.1", productType: 1, refundType: 1 } };
  const raw = JSON.stringify({ message: { messageId: "m-1", data: Buffer.from(JSON.stringify(msg)).toString("base64") } });
  const event = await provider.verifyWebhook(raw, new Headers({ authorization: "Bearer x" }));
  assert.equal(event.eventType, "voided_purchase");
  const r = await provider.normalizeEvent(event);
  assert.ok(r.kind === "state" && r.state.status === "refunded");
});
await check("google-play-adapter: neplatný/chýbajúci stav → MALFORMED (token nikdy nie je dôveryhodný bez API)", () => {
  assert.throws(() => normalizeGoogleSubscription({ purchaseToken: "gp_tok_123456", eventTimeMillis: 1, resource: { subscriptionState: "X" } }), /MALFORMED/);
});

// ============================================================================= apple-adapter
await check("apple-adapter: DID_FAIL_TO_RENEW.GRACE_PERIOD → grace_period (grace_until z renewal), bez grace → account_hold", () => {
  const base = { notificationUUID: "u", signedDate: Date.parse("2026-10-11T00:00:00Z"), transaction: { originalTransactionId: "1000", productId: "com.esblu.test.pro.monthly", purchaseDate: 1, expiresDate: Date.parse("2026-11-11T00:00:00Z") } };
  const g = normalizeAppleNotification({ ...base, notificationType: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD", renewal: { gracePeriodExpiresDate: Date.parse("2026-10-27T00:00:00Z") } });
  assert.ok(g.kind === "state" && g.state.status === "grace_period" && g.state.grace_until === "2026-10-27T00:00:00.000Z");
  const h = normalizeAppleNotification({ ...base, notificationType: "DID_FAIL_TO_RENEW" });
  assert.ok(h.kind === "state" && h.state.status === "account_hold");
  const ge = normalizeAppleNotification({ ...base, notificationType: "GRACE_PERIOD_EXPIRED" });
  assert.ok(ge.kind === "state" && ge.state.status === "account_hold");
});
await check("apple-adapter: REFUND → refunded, REVOKE → revoked (ended_at = revocationDate), REFUND_REVERSED → audit", () => {
  const tx = { originalTransactionId: "1000", productId: "p", purchaseDate: 1, expiresDate: Date.parse("2026-11-11T00:00:00Z"), revocationDate: Date.parse("2026-10-10T00:00:00Z") };
  const r = normalizeAppleNotification({ notificationUUID: "u", signedDate: Date.parse("2026-10-11T00:00:00Z"), transaction: tx, notificationType: "REFUND" });
  assert.ok(r.kind === "state" && r.state.status === "refunded" && r.state.ended_at === "2026-10-10T00:00:00.000Z");
  const v = normalizeAppleNotification({ notificationUUID: "u", signedDate: Date.parse("2026-10-11T00:00:00Z"), transaction: tx, notificationType: "REVOKE" });
  assert.ok(v.kind === "state" && v.state.status === "revoked");
  assert.deepEqual(normalizeAppleNotification({ notificationUUID: "u", signedDate: 1, transaction: tx, notificationType: "REFUND_REVERSED" }), { kind: "ignore", reason: "AUDIT_ONLY" });
  assert.equal(appleNotificationStatus("DID_RENEW", null, "2026-11-01", "2026-10-01"), "active");
});
await check("apple-adapter: App Store Server API status 1..5 → kanonické stavy (reconciliation)", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(appleStatusCodeToCanonical), ["active", "expired", "account_hold", "grace_period", "revoked", null]);
});
await check("apple-adapter: reconcile zdroj overí JWS a nájde originalTransactionId", async () => {
  const verifier = { verify: async (jws: string) => JSON.parse(Buffer.from(jws, "base64").toString("utf8")) } as never;
  const tx = Buffer.from(JSON.stringify({ productId: "com.esblu.test.pro.monthly", purchaseDate: 1, expiresDate: Date.parse("2026-11-11T00:00:00Z"), appAccountToken: "tok" })).toString("base64");
  const renewal = Buffer.from(JSON.stringify({ autoRenewStatus: 0 })).toString("base64");
  const api = { getAllSubscriptionStatuses: async () => ({ data: [{ lastTransactions: [{ originalTransactionId: "1000", status: 1, signedTransactionInfo: tx, signedRenewalInfo: renewal }] }] }), sendExternalPurchaseReport: async () => ({}) };
  const src = appleReconcileSource(api, verifier, () => new Date("2026-10-11T00:00:00Z"));
  const s = await src.fetchState({ provider_subscription_id: "1000" } as ReconcileCandidate);
  assert.ok(s && s.status === "active" && s.cancel_at_period_end === true && s.account_token === "tok");
  assert.equal(await src.fetchState({ provider_subscription_id: "9999" } as ReconcileCandidate), null);
});

// ============================================================================= cross-provider
await check("cross-provider: managed_via a kde sa smie spravovať (nikdy cudzí cancel flow)", () => {
  assert.equal(managedVia("stripe"), "web");
  assert.equal(managedVia("google"), "google_play");
  assert.equal(managedVia("apple"), "app_store");
  assert.equal(manageHere("stripe", "web"), true);
  assert.equal(manageHere("stripe", "android"), false);
  assert.equal(manageHere("stripe", "ios"), false);
  assert.equal(manageHere("google", "android"), true);
  assert.equal(manageHere("google", "web"), false);
  assert.equal(manageHere("google", "ios"), false);
  assert.equal(manageHere("apple", "ios"), true);
  assert.equal(manageHere("apple", "android"), false);
  assert.equal(managedViaMessageKey("google_play"), "subscription.managedVia.googlePlay");
});
await check("cross-provider: aktívne predplatné u ktoréhokoľvek providera blokuje nákup na všetkých platformách", () => {
  for (const provider of ["stripe", "google", "apple"]) {
    for (const platform of ["web", "android", "ios"] as const) {
      for (const status of ["active", "trialing", "grace_period", "past_due", "account_hold", "pending", "paused"]) {
        const d = purchaseDecision({ status, provider }, platform);
        assert.equal(d.allowed, false, `${provider}/${platform}/${status}`);
      }
      for (const status of ["none", "canceled", "expired", "refunded", "revoked"]) {
        assert.equal(purchaseDecision({ status, provider }, platform).allowed, true, `${provider}/${status}`);
      }
    }
  }
});
await check("cross-provider: klientsky model — zobrazenie podľa servera, cancel iba na správnej platforme", () => {
  const view = parseSubscriptionView({ status: "grace_period", can_manage: true, billing_provider: "google", managed_via: "google_play", entitles: true })!;
  assert.equal(view.status, "grace_period");
  assert.equal(hasPaidAccess(view), true);
  assert.equal(canManageOnPlatform(view, "android"), true);
  assert.equal(canManageOnPlatform(view, "web"), false);
  assert.equal(canStartCheckout(view), false);
  const hold = parseSubscriptionView({ status: "account_hold", can_manage: true, entitles: false })!;
  assert.equal(hasPaidAccess(hold), false);
  assert.equal(canStartCheckout(hold), false, "account_hold je otvorený vzťah — žiadny druhý nákup");
  assert.equal(parseSubscriptionView({ status: "weird" }), null, "neznámy stav → fail closed");
  assert.equal(isOpenStatus("refunded"), false);
});

// ============================================================================= provider-modes
await check("provider-modes: default disabled; produkcia vždy disabled; live požiadavka = fail closed", () => {
  assert.deepEqual(resolveProviderModes({}), { web: "disabled", stores: "disabled", productionLocked: false, issues: [] });
  const prod = resolveProviderModes({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_test", ESBLU_BILLING_STORE_MODE: "sandbox" });
  assert.equal(prod.web, "disabled");
  assert.equal(prod.stores, "disabled");
  assert.ok(prod.issues.includes("PRODUCTION_LOCKED"));
  const live = resolveProviderModes({ ESBLU_BILLING_MODE: "live" });
  assert.equal(live.web, "disabled");
  assert.ok(live.issues.includes("LIVE_NOT_APPROVED"));
  assert.equal(validateBillingEnv({ ESBLU_BILLING_MODE: "live" }).ok, false);
});
await check("provider-modes: validácia vracia iba NÁZVY premenných (žiadne hodnoty), live kľúč = chyba", () => {
  const secret = "sk_live_" + "z".repeat(30);
  const r = validateBillingEnv({ ESBLU_BILLING_MODE: "stripe_test", STRIPE_SECRET_KEY: secret });
  assert.ok(r.missing.includes("STRIPE_WEBHOOK_SECRET"));
  assert.ok(r.invalid.includes("STRIPE_SECRET_KEY:LIVE_FORBIDDEN"));
  assert.ok(!JSON.stringify(r).includes(secret), "hodnota secretu sa nesmie vrátiť");
  const ok = validateBillingEnv({ ESBLU_BILLING_MODE: "stripe_test", STRIPE_SECRET_KEY: "sk_test_" + "a".repeat(20), STRIPE_WEBHOOK_SECRET: "whsec_" + "b".repeat(20), ESBLU_BILLING_RETURN_ORIGIN: "https://preview.example", CRON_SECRET: "c".repeat(20) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(BILLING_ENV_SCHEMA.every((r) => !r.name.startsWith("NEXT_PUBLIC_")), "žiadny billing secret nesmie ísť do klienta");
});
await check("provider-modes: store sandbox vyžaduje Google/Apple konfiguráciu (fail closed)", () => {
  const r = validateBillingEnv({ ESBLU_BILLING_STORE_MODE: "sandbox" });
  for (const name of ["GOOGLE_PLAY_PACKAGE_NAME", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "APPLE_IAP_KEY_ID", "APPLE_IAP_ISSUER_ID", "APPLE_IAP_PRIVATE_KEY", "APPLE_ROOT_CA_SHA256", "CRON_SECRET"]) {
    assert.ok(r.missing.includes(name), name);
  }
  assert.equal(r.ok, false);
});

// ============================================================================= reconciliation (bez DB)
const cand = (over: Partial<ReconcileCandidate> = {}): ReconcileCandidate => ({
  account_id: "acc-1", company_id: "co-1", billing_provider: "fake", provider_environment: "test", provider_subscription_id: "sub-1",
  provider_customer_id: null, status: "active", current_period_end: "2026-11-01T00:00:00.000Z", cancel_at_period_end: false, plan_code: "test_pro", ...over,
});
const remote = (over: Partial<NormalizedSubscriptionState> = {}): NormalizedSubscriptionState => ({
  provider_subscription_id: "sub-1", provider_customer_id: null, provider_price_id: "fake_price_pro_month", status: "active",
  current_period_start: null, current_period_end: "2026-11-01T00:00:00.000Z", cancel_at_period_end: false, canceled_at: null, ended_at: null,
  trial_start: null, trial_end: null, checkout_ref: null, account_token: null, state_at: "2026-10-11T00:00:00.000Z", ...over,
});
function memDb(applyResult: string = "applied") {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: BillingDb = {
    rpc: async (fn, args = {}) => {
      calls.push({ fn, args });
      if (fn === "esblu_billing_record_event") return { data: { event_id: "e1", duplicate: false }, error: null };
      if (fn === "esblu_billing_apply_event") return { data: { result: applyResult }, error: null };
      if (fn === "esblu_billing_reconcile_candidates") return { data: [cand()], error: null };
      return { data: {}, error: null };
    },
  };
  return { db, calls };
}
await check("reconciliation: drift detekcia (stav / koniec obdobia / cancel príznak)", () => {
  assert.equal(hasDrift(cand(), remote()), false);
  assert.equal(hasDrift(cand(), remote({ status: "refunded" })), true);
  assert.equal(hasDrift(cand(), remote({ current_period_end: "2026-12-01T00:00:00.000Z" })), true);
  assert.equal(hasDrift(cand(), remote({ cancel_at_period_end: true })), true);
  assert.equal(hasDrift(cand({ current_period_end: "2026-11-01T00:00:00Z" }), remote()), false, "rovnaký okamih v inom formáte");
});
await check("reconciliation: in_sync / corrected (tou istou pipeline) / skipped / timeout error", async () => {
  const a = memDb();
  assert.equal((await reconcileOne(a.db, { fake: { provider: "fake", fetchState: async () => remote() } }, cand())).result, "in_sync");
  const b = memDb();
  assert.equal((await reconcileOne(b.db, { fake: { provider: "fake", fetchState: async () => remote({ status: "revoked" }) } }, cand())).result, "corrected");
  assert.ok(b.calls.some((c) => c.fn === "esblu_billing_apply_event"), "oprava ide cez apply_event");
  assert.ok(b.calls.some((c) => c.fn === "esblu_billing_record_event" && String(c.args.p_event_type) === "esblu.sync.reconcile"));
  const c = memDb();
  assert.deepEqual(await reconcileOne(c.db, {}, cand()), { accountId: "acc-1", result: "skipped", errorCode: "PROVIDER_NOT_CONFIGURED" });
  const d = memDb();
  const slow = { provider: "fake" as const, fetchState: () => new Promise<NormalizedSubscriptionState>(() => undefined) };
  assert.deepEqual(await reconcileOne(d.db, { fake: slow }, cand(), { timeoutMs: 20 }), { accountId: "acc-1", result: "error", errorCode: "PROVIDER_TIMEOUT" });
  const recorded = d.calls.find((x) => x.fn === "esblu_billing_reconcile_record")!;
  assert.equal(recorded.args.p_error_code, "PROVIDER_TIMEOUT");
});
await check("reconciliation: apply zlyhá → error s kódom (žiadne tajomstvá ani telá)", async () => {
  const e = memDb("failed");
  const r = await reconcileOne(e.db, { fake: { provider: "fake", fetchState: async () => remote({ status: "expired" }) } }, cand());
  assert.equal(r.result, "error");
  assert.match(String(r.errorCode), /^[A-Z0-9_]+$/);
});
await check("reconciliation: beh spracuje kandidátov sekvenčne", async () => {
  const { db } = memDb();
  const out = await runReconciliation(db, { fake: { provider: "fake", fetchState: async () => remote() } });
  assert.equal(out.checked, 1);
  assert.equal(out.results[0].result, "in_sync");
});
await check("reconciliation: Google zdroj = subscriptionsv2 (stav z API)", async () => {
  const api = { getSubscriptionV2: async () => gResource("SUBSCRIPTION_STATE_ON_HOLD"), acknowledge: async () => undefined } as never;
  const s = await googleReconcileSource(api).fetchState(cand({ billing_provider: "google", provider_subscription_id: "gp_tok_123456" }));
  assert.equal(s?.status, "account_hold");
});

// ============================================================================= native-contract
await check("native-contract: Play výsledky (pending / already_owned / unavailable / neznámy → error, bez tokenu → error)", () => {
  assert.deepEqual(normalizeGooglePluginResult({ kind: "play", purchaseToken: "tok_1234567890" }), { kind: "play", purchaseToken: "tok_1234567890" });
  assert.deepEqual(normalizeGooglePluginResult({ kind: "play" }), { kind: "error", code: "MISSING_TOKEN" });
  assert.deepEqual(normalizeGooglePluginResult({ kind: "pending", purchaseToken: "t" }), { kind: "pending", purchaseToken: "t" });
  assert.deepEqual(normalizeGooglePluginResult({ kind: "already_owned" }), { kind: "already_owned" });
  assert.deepEqual(normalizeGooglePluginResult({ kind: "billing_unavailable" }), { kind: "billing_unavailable" });
  assert.deepEqual(normalizeGooglePluginResult({ kind: "canceled" }), { kind: "canceled" });
  assert.deepEqual(normalizeGooglePluginResult({ kind: "error", code: "DEVELOPER_ERROR" }), { kind: "error", code: "DEVELOPER_ERROR" });
  assert.deepEqual(normalizeGooglePluginResult({ kind: "weird", code: "<script>" }), { kind: "error", code: "UNKNOWN" });
  assert.deepEqual(normalizeGooglePluginResult(null), { kind: "error", code: "UNKNOWN" });
});
await check("native-contract: UI nikdy neudeľuje nárok z výsledku obchodu (iba server confirm / restore)", () => {
  const page = read("app/nastavenia/predplatne/page.tsx");
  assert.match(page, /result\.kind === "pending"[\s\S]*setBanner\("storePending"\)/);
  assert.match(page, /result\.kind === "already_owned"[\s\S]*restoreGoogle\(\)/);
  assert.match(page, /post\("\/api\/billing\/mobile\/confirm", \{ provider: "google", checkoutId: null, purchaseToken \}\)/);
  assert.match(page, /canManageOnPlatform\(view, platform\)/);
});

console.log(`\nsubscriptions-lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
