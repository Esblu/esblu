// =============================================================================
// Subscriptions lifecycle — unit / contract testy (bez DB, bez siete).
// Suity (prefix v názve): subscription-domain, stripe-adapter, google-play-adapter,
// apple-adapter, cross-provider, provider-modes, reconciliation, native-contract.
//   npm run test:subscriptions-lifecycle   (alias: test:subscription-domain …)
// Voliteľný filter: SUITE=stripe-adapter npm run test:subscriptions-lifecycle
// =============================================================================
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
import { canManageOnPlatform, canStartCheckout, hasPaidAccess, parsePurchaseOptions, parseSubscriptionView, screenModel } from "@/lib/billing/client-model";
import { gatePurchaseOptions, methodAllowedByServer, providerGateFromEnv } from "@/lib/billing/server-gates";
import { normalizeGooglePluginResult } from "@/lib/billing/native-bridge-contract";
import { BILLING_ENV_SCHEMA, resolveProviderModes, validateBillingEnv } from "@/lib/billing/provider-modes";
import { normalizeAppleNotification, normalizeGoogleSubscription, GooglePlayProvider } from "@/lib/billing/providers/stores";
import { assertStripeKeyFor, assertStripeTestKey, mapStripeStatus, stripeExpiresAt, StripeLiveProvider, StripeTestProvider } from "@/lib/billing/providers/stripe";
import { billingEnvironmentForMode, getBillingServerMode } from "@/lib/billing/config";
import { startWebCheckout } from "@/lib/billing/web-checkout";
import { resolveManageProvider } from "@/lib/billing/manage-guard";
import { appleReconcileSource, appleStatusCodeToCanonical, googleReconcileSource } from "@/lib/billing/reconcile-sources";
import { hasDrift, reconcileOne, runReconciliation, type ReconcileCandidate } from "@/lib/billing/reconciliation";
import { signTimestamped } from "@/lib/billing/signature";
import { STRIPE_API_VERSION, resolveStripeApiVersion } from "@/lib/billing/stripe-api-version";
import { STRIPE_CATCHUP_EVENT_TYPES, stripeCreditNoteDocument, stripeInvoiceDocument } from "@/lib/billing/providers/stripe";
import { buildAccountingCsv, csvText, formatMinor, monthRange } from "@/lib/billing/accounting-export";
import { formatAlertEmail, resendMailerFromEnv, safeDetails } from "@/lib/billing/ops-alerts";
import {
  archivePath,
  buildPdfRequestOptions,
  fetchStripePdf,
  guardedLookup,
  isAllowedPdfRedirect,
  isAllowedStripeUrl,
  isBlockedAddress,
  PDF_REQUEST_HEADERS,
  safePdfFetch,
  STRIPE_PDF_STORAGE_HOSTS,
} from "@/lib/billing/document-archive";
import { createServer as createNetServer } from "node:net";
import { request as httpsRequest } from "node:https";
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
// Aktuálne obdobie = posledná faktúra predplatného (latest_invoice).
const lookup = { "/invoice_payments": { data: [{ invoice: "in_1" }] }, "/invoices/in_1": { object: "invoice", id: "in_1", subscription: "sub_r1", period_start: NOW - 30 * 86400, period_end: NOW, lines: { data: [{ period: { start: NOW, end: NOW + 30 * 86400 } }] } }, "/subscriptions/sub_r1": { ...SUB, latest_invoice: "in_1" }, "/charges/ch_1": CHARGE_BASE };

await check("stripe-adapter: úplný refund → kanonický refunded + refund charge (reporting)", async () => {
  const p = stripe(lookup);
  const e = stripeEvent("charge.refunded", { ...CHARGE_BASE, amount_refunded: 1218, refunded: true });
  const r = await p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers));
  assert.equal(r.kind, "state");
  if (r.kind !== "state") return;
  assert.equal(r.state.status, "refunded");
  assert.ok(r.state.ended_at);
  assert.equal(r.state.charge?.kind, "refund");
  assert.equal(r.followUp, "cancel_provider_now", "plná refundácia aktuálneho obdobia → ukončiť aj u Stripe");
  // väzba na faktúru a obdobie služby (riadok predplatného, nie posunuté invoice.period_*)
  assert.equal(r.state.charge?.refunded_charge_id, "in_1");
  assert.equal(r.state.charge?.refund_scope, "current_period");
  assert.equal(r.state.charge?.invoice_period_start, new Date(NOW * 1000).toISOString());
  assert.equal(r.state.charge?.invoice_period_end, new Date((NOW + 30 * 86400) * 1000).toISOString());
});
await check("stripe-adapter: plná refundácia STARŠEJ faktúry → iba účtovný záznam, prístup aj predplatné ostávajú", async () => {
  const p = stripe({ ...lookup, "/subscriptions/sub_r1": { ...SUB, latest_invoice: "in_2" } });
  const e = stripeEvent("charge.refunded", { ...CHARGE_BASE, amount_refunded: 1218, refunded: true });
  const r = await p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers));
  assert.equal(r.kind, "charge");
  if (r.kind === "charge") { assert.equal(r.charge.kind, "refund"); assert.equal(r.charge.refund_scope, "older_invoice"); }
});
await check("stripe-adapter: cancelSubscriptionNow → DELETE bez faktúry a prorácie; už ukončené = idempotentné", async () => {
  const calls: string[] = [];
  let deleted = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url.replace("https://api.stripe.com/v1", "")}`);
    if (init.method === "DELETE") {
      if (deleted) return new Response(JSON.stringify({ error: { code: "resource_missing" } }), { status: 400 });
      deleted = true;
    }
    return new Response(JSON.stringify({ ...SUB, status: deleted ? "canceled" : "active", canceled_at: NOW, ended_at: NOW }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new StripeTestProvider({ secretKey: KEY, webhookSecret: WHSEC, fetchImpl, now: () => new Date(NOW * 1000) });
  const a = await p.cancelSubscriptionNow({ providerSubscriptionId: "sub_r1", providerCustomerId: "cus_1" });
  assert.equal(a.status, "canceled");
  assert.ok(calls[0].startsWith("DELETE /subscriptions/sub_r1?") && calls[0].includes("invoice_now=false") && calls[0].includes("prorate=false"), calls[0]);
  const b = await p.cancelSubscriptionNow({ providerSubscriptionId: "sub_r1", providerCustomerId: "cus_1" });
  assert.equal(b.status, "canceled");
});
await check("stripe-adapter: prehraný spor → revoked + ukončiť u Stripe", async () => {
  const p = stripe({ ...lookup, "/charges/ch_1": CHARGE_BASE });
  const e = stripeEvent("charge.dispute.closed", { object: "dispute", id: "dp_1", charge: "ch_1", status: "lost" });
  const r = await p.normalizeEvent(await p.verifyWebhook(e.raw, e.headers));
  assert.equal(r.kind, "state");
  if (r.kind === "state") { assert.equal(r.state.status, "revoked"); assert.equal(r.followUp, "cancel_provider_now"); }
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
  const ended = parseSubscriptionView({ status: "canceled", entitles: false, access_until: "2026-12-20T21:57:52Z", post_period_protection: true })!;
  assert.equal(ended.postPeriodProtection, true, "48 h ochranná lehota sa zobrazí");
  assert.equal(ended.accessUntil, "2026-12-20T21:57:52Z");
  const plain = parseSubscriptionView({ status: "canceled", entitles: false })!;
  assert.equal(plain.postPeriodProtection, false, "bez poľa zo servera → bez lehoty (fail closed)");
  assert.equal(plain.accessUntil, null);
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
  assert.match(page, /screenModel\(view, options, platform, bridge\)/);
});

// ============================================================================= provider-gate
await check("provider-gate: kanál bez zapojeného providera sa neponúkne ani nespustí (fail closed)", () => {
  const off = providerGateFromEnv({});
  assert.deepEqual(off, { webEnabled: false, storesEnabled: false });
  const webOnly = providerGateFromEnv({ ESBLU_BILLING_MODE: "fake" });
  assert.equal(methodAllowedByServer("stripe_web_checkout", webOnly), true);
  assert.equal(methodAllowedByServer("google_play", webOnly), false, "web zapnutý, obchody vypnuté → žiadny Play nákup");
  assert.equal(methodAllowedByServer("apple_iap", webOnly), false);
  assert.equal(methodAllowedByServer("google_choice_developer", webOnly), true, "billing choice platí webový provider");
  const prod = providerGateFromEnv({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "fake", ESBLU_BILLING_STORE_MODE: "fake" });
  assert.deepEqual(prod, { webEnabled: false, storesEnabled: false }, "produkcia vždy vypnutá");
  const db = { platform: "android", current: null, purchase_allowed: true, view_only: false,
    methods: [{ method: "google_play", provider: "google", plans: [] }, { method: "google_choice_developer", provider: "fake", plans: [] }] };
  const gated = gatePurchaseOptions(db, webOnly) as { methods: { method: string }[]; purchase_allowed: boolean; view_only: boolean };
  assert.deepEqual(gated.methods.map((m) => m.method), ["google_choice_developer"]);
  const none = gatePurchaseOptions(db, off) as { methods: unknown[]; purchase_allowed: boolean; view_only: boolean };
  assert.deepEqual(none.methods, []);
  assert.equal(none.purchase_allowed, false);
  assert.equal(none.view_only, true);
  assert.deepEqual(gatePurchaseOptions("garbage", webOnly), { methods: [], purchase_allowed: false, view_only: true });
});
await check("provider-gate: routy purchase-options a purchase-intent bránu naozaj používajú", () => {
  const opts = read("app/api/billing/purchase-options/route.ts");
  assert.match(opts, /const gate = providerGateFromEnv\(\)/);
  assert.match(opts, /gatePurchaseOptions\(data, gate\)/);
  assert.match(opts, /esblu_billing_my_live_purchase_allowed/, "S15b: LIVE allowlist pred ponukou kanálov");
  assert.match(opts, /if \(live\.error \|\| live\.data !== true\) gate\.webEnabled = false/, "fail closed");
  const intent = read("app/api/billing/purchase-intent/route.ts");
  assert.match(intent, /methodAllowedByServer\(method, providerGateFromEnv\(\)\)/);
  assert.ok(intent.indexOf("methodAllowedByServer") < intent.indexOf("esblu_billing_create_purchase_intent"), "brána pred zápisom do DB");
});

// ============================================================================= billing-ui (test mode, obrazovka Predplatné)
const viewOf = (o: Record<string, unknown>) => parseSubscriptionView({ server_time: "2026-10-11T00:00:00Z", trial: {}, plan_entitlements: [], ...o })!;
const optsOf = (platform: string, methods: string[], extra: Record<string, unknown> = {}) => parsePurchaseOptions({
  platform, can_manage: true, ...extra,
  methods: methods.map((m) => ({ method: m, provider: m === "google_play" ? "google" : m === "apple_iap" ? "apple" : "fake", plans: [{ plan_code: "test_pro", intervals: [{ interval: "month", store_product_id: null }], entitlements: [] }] })),
});
const none = { status: "none", can_manage: true, entitles: false };
await check("billing-ui: billing vypnutý → stránka 'disabled' (404/503), žiadny nákup", () => {
  const page = read("app/nastavenia/predplatne/page.tsx");
  assert.match(page, /response\.status === 404 \|\| response\.status === 503[\s\S]{0,40}setState\("disabled"\)/);
  assert.match(page, /state === "disabled" && <p[^>]*>\{t\("subscription\.disabled"\)\}/);
  const m = screenModel(viewOf(none), parsePurchaseOptions({ platform: "web", methods: [] }), "web", null);
  assert.deepEqual(m.buyActions, []);
  assert.equal(m.showViewOnly, true);
});
await check("billing-ui (RC hardening): double-submit, timeout, stop pollingu, invalidácia nárokov, žiadny večný loading", () => {
  const page = read("app/nastavenia/predplatne/page.tsx");
  // synchrónna poistka (ref) vo všetkých akciách
  for (const fn of ["runAction", "manageStripe", "restoreApple"]) {
    assert.match(page, new RegExp(`async function ${fn}\\([^)]*\\) \\{[\\s\\S]{0,200}inFlightRef\\.current`), fn);
  }
  // po úspešnom redirecte na checkout/portál sa busy neresetuje
  assert.match(page, /navigating = true;\s*window\.location\.assign\(intent\.url\)/);
  assert.match(page, /if \(!navigating\) \{\s*inFlightRef\.current = false;/);
  // žiadny holý fetch bez timeoutu
  assert.equal((page.match(/\bfetch\(/g) ?? []).length, 1, "jediný fetch = vnútri fetchWithTimeout");
  assert.match(page, /controller\.abort\(\), BILLING_FETCH_TIMEOUT_MS/);
  // polling končí po odchode zo stránky
  assert.match(page, /if \(!aliveRef\.current\) return "aborted" as const;/);
  // potvrdená kúpa/obnova → dashboard načíta nároky znova
  assert.match(page, /ENTITLEMENT_CHANGING_BANNERS\.has\(banner\)\) invalidateCompanyEntitlements\(\)/);
  for (const b of ["confirmed", "purchaseConfirmed", "restoreDone"]) assert.ok(page.includes(`"${b}"`));
  // štart: bridge/storefront/sieť nesmú nechať stránku v "loading"
  assert.match(page, /try \{\s*const \{ loadNativeBillingBridge \}/);
  assert.match(page, /sleep\(BILLING_FETCH_TIMEOUT_MS\)\.then\(\(\) => null\)/);
  // návrat z checkoutu: počas čakania na webhook sú tlačidlá zablokované
  assert.match(page, /inFlightRef\.current = true;\s*setBusy\(true\);\s*try \{\s*await waitForCheckout\(checkoutId\)/);
  // Apple restore dáva spätnú väzbu
  assert.match(page, /setBanner\(transactions\.length > 0 \? "restoreDone" : "restoreNone"\)/);
});

await check("billing-ui: fake/test provider bez predplatného → web: kúpiť cez web; Android: Play (ak server ponúkne)", () => {
  assert.deepEqual(screenModel(viewOf(none), optsOf("web", ["stripe_web_checkout"]), "web", null).buyActions.map((a) => a.kind), ["web_checkout"]);
  const android = screenModel(viewOf(none), optsOf("android", ["google_play"]), "android", { available: true });
  assert.deepEqual(android.buyActions.map((a) => a.kind), ["google"]);
  assert.equal(android.showRestore, true);
  assert.equal(android.managedViaKey, null);
});
await check("billing-ui: aktívne cez web → na webe správa; v appke iba 'spravujete cez web', žiadny nákup", () => {
  const v = viewOf({ status: "active", can_manage: true, billing_provider: "fake", managed_via: "web", entitles: true, plan_code: "test_pro" });
  const web = screenModel(v, optsOf("web", ["stripe_web_checkout"], { current: { status: "active" } }), "web", null);
  assert.equal(web.showManageControls, true);
  assert.equal(web.showWebChangePlan, true);
  assert.deepEqual(web.buyActions, [], "nič otvorené nesmie ponúknuť druhý nákup");
  for (const platform of ["android", "ios"] as const) {
    const m = screenModel(v, optsOf(platform, [], { current: { status: "active" } }), platform, { available: true });
    assert.equal(m.managedViaKey, "subscription.managedVia.web", platform);
    assert.equal(m.showManageControls, false);
    assert.deepEqual(m.buyActions, []);
    assert.equal(m.showViewOnly, false, "nie 'v regióne sa nedá kúpiť' pri platenom predplatnom");
  }
});
await check("billing-ui: aktívne cez Google → na Androide správa v Play + zmena plánu cez Play; web/iOS 'spravujete cez Google Play'", () => {
  const v = viewOf({ status: "active", can_manage: true, billing_provider: "google", managed_via: "google_play", entitles: true, plan_code: "test_pro" });
  const android = screenModel(v, optsOf("android", ["google_play"], { current: { status: "active" } }), "android", { available: true });
  assert.equal(android.showManageControls, true);
  assert.equal(android.storeManaged, "google");
  assert.equal(android.storeChangeAction?.kind, "google");
  assert.equal(android.showWebChangePlan, false);
  assert.deepEqual(android.buyActions, []);
  assert.equal(screenModel(v, optsOf("web", []), "web", null).managedViaKey, "subscription.managedVia.googlePlay");
  assert.equal(screenModel(v, optsOf("ios", []), "ios", { available: true }).managedViaKey, "subscription.managedVia.googlePlay");
});
await check("billing-ui: aktívne cez Apple → iOS správa v App Store; Android/web 'spravujete cez App Store'", () => {
  const v = viewOf({ status: "active", can_manage: true, billing_provider: "apple", managed_via: "app_store", entitles: true, plan_code: "test_pro" });
  const ios = screenModel(v, optsOf("ios", ["apple_iap"], { current: { status: "active" } }), "ios", { available: true });
  assert.equal(ios.showManageControls, true);
  assert.equal(ios.storeChangeAction?.kind, "apple_iap");
  assert.equal(screenModel(v, optsOf("android", []), "android", { available: true }).managedViaKey, "subscription.managedVia.appStore");
  assert.equal(screenModel(v, optsOf("web", []), "web", null).managedViaKey, "subscription.managedVia.appStore");
});
await check("billing-ui: restore / already owned / pending / billing unavailable → správne bannery, nič sa neudelí na klientovi", () => {
  const page = read("app/nastavenia/predplatne/page.tsx");
  assert.match(page, /result\.kind === "pending"[\s\S]{0,200}setBanner\("storePending"\)/);
  assert.match(page, /result\.kind === "already_owned"[\s\S]{0,240}restoreGoogle\((true)?\)/);
  assert.match(page, /result\.kind === "billing_unavailable" \|\| result\.kind === "error"[\s\S]{0,60}setBanner\("storeUnavailable"\)/);
  assert.match(page, /setBanner\(tokens\.length > 0 \? "restoreDone" : "restoreNone"\)/);
  for (const lang of ["sk", "en", "de"]) {
    const dict = read(`lib/i18n/dictionaries/${lang}.ts`);
    for (const key of ["storePending", "storeUnavailableNow", "alreadyOwned", "restoreDone", "restoreNone", "viewOnly", "disabled"]) assert.match(dict, new RegExp(`\\b${key}:`), `${lang}.${key}`);
    for (const via of ["web", "googlePlay", "appStore", "support"]) assert.match(dict, new RegExp(`\\b${via}:`), `${lang}.managedVia.${via}`);
  }
  // Natívny plugin nedostupný (billing-off build) → 'nákup v obchode nedostupný', žiadne tlačidlo obnovy
  const m = screenModel(viewOf(none), optsOf("android", ["google_play"]), "android", { available: false });
  assert.equal(m.showStoreUnavailable, true);
  assert.equal(m.showRestore, false);
});
await check("billing-ui: employee/accountant (bez správy) → iba prehľad, žiadne tlačidlá", () => {
  const v = viewOf({ status: "active", can_manage: false, entitles: true, plan_code: "test_pro" });
  const m = screenModel(v, optsOf("web", ["stripe_web_checkout"]), "web", null);
  assert.equal(m.showReadOnly, true);
  assert.deepEqual(m.buyActions, []);
  assert.equal(m.showManageControls, false);
  assert.equal(m.managedViaKey, null);
  assert.equal(m.showRestore, false);
});

// ============================================================================= stripe-adapter: jedna relácia (2026-11-18)
/** Mock Stripe: relácie podľa Idempotency-Key (ako Stripe), voliteľný výpadok a súbeh. */
function mockStripeCheckout(opts: { failFirstAfterCreate?: boolean; inFlightConflicts?: number } = {}) {
  const sessions = new Map<string, { id: string; url: string; status: string; body: string }>();
  const calls: { key: string | null; body: string }[] = [];
  let created = 0;
  let conflicts = opts.inFlightConflicts ?? 0;
  let failNext = opts.failFirstAfterCreate === true;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    const body = String(init.body ?? "");
    calls.push({ key, body });
    if (url.endsWith("/checkout/sessions") && init.method === "POST") {
      if (conflicts > 0) { conflicts--; return new Response(JSON.stringify({ error: { code: "idempotency_key_in_use" } }), { status: 409 }); }
      let session = key ? sessions.get(key) : undefined;
      if (session && session.body !== body) return new Response(JSON.stringify({ error: { type: "idempotency_error" } }), { status: 400 });
      if (!session) {
        created++;
        session = { id: `cs_test_${created}`, url: `https://checkout.stripe.test/c/${created}`, status: "open", body };
        if (key) sessions.set(key, session);
      }
      if (failNext) { failNext = false; return new Response("upstream timeout", { status: 504 }); }
      return new Response(JSON.stringify({ object: "checkout.session", id: session.id, url: session.url, livemode: false }), { status: 200 });
    }
    const exp = url.match(/\/checkout\/sessions\/([^/]+)\/expire$/);
    if (exp) {
      const s = [...sessions.values()].find((x) => x.id === exp[1]);
      if (!s || s.status !== "open") return new Response(JSON.stringify({ error: {} }), { status: 400 });
      s.status = "expired";
      return new Response(JSON.stringify({ object: "checkout.session", id: s.id, status: "expired", livemode: false }), { status: 200 });
    }
    const get = url.match(/\/checkout\/sessions\/([^/?]+)$/);
    if (get) {
      const s = [...sessions.values()].find((x) => x.id === get[1]);
      return new Response(JSON.stringify({ object: "checkout.session", id: get[1], status: s?.status ?? "expired", livemode: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: {} }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sessions, calls, createdCount: () => created };
}
const INTENT = { checkout_id: "11111111-2222-4333-8444-555555555555", provider: "stripe", provider_price_id: "price_x", provider_customer_id: null, expires_at: new Date(Date.now() + 3600_000).toISOString(), reused: false };
const attachLog: string[] = [];
const attach = async (checkoutId: string, sessionId: string) => { attachLog.push(`${checkoutId}:${sessionId}`); return { error: null }; };

await check("stripe-adapter: dve karty prehliadača — ten istý zámer → 1 Stripe relácia (Idempotency-Key + expires_at)", async () => {
  const m = mockStripeCheckout({ inFlightConflicts: 1 });
  const stripe = new StripeTestProvider({ secretKey: "sk_test_" + "a".repeat(24), webhookSecret: "whsec_x", fetchImpl: m.fetchImpl });
  attachLog.length = 0;
  const [a, b] = await Promise.all([
    startWebCheckout({ provider: stripe, intent: INTENT, origin: "https://staging.esblu.test", attach }),
    startWebCheckout({ provider: stripe, intent: { ...INTENT, reused: true }, origin: "https://staging.esblu.test", attach }),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal(m.createdCount(), 1, "jediná zaplatiteľná relácia");
  assert.equal(a.ok && a.url, b.ok && b.url);
  assert.ok(m.calls.every((c) => c.key === `esblu-checkout-${INTENT.checkout_id}`));
  const expires = stripeExpiresAt(INTENT.expires_at);
  assert.ok(m.calls[0].body.includes(`expires_at=${expires}`));
  assert.equal(new Set(attachLog).size, 1);
});
await check("stripe-adapter: výpadok po vytvorení relácie (504) → opakovanie s tým istým kľúčom vráti tú istú reláciu", async () => {
  const m = mockStripeCheckout({ failFirstAfterCreate: true });
  const stripe = new StripeTestProvider({ secretKey: "sk_test_" + "a".repeat(24), webhookSecret: "whsec_x", fetchImpl: m.fetchImpl });
  attachLog.length = 0;
  const r = await startWebCheckout({ provider: stripe, intent: INTENT, origin: "https://staging.esblu.test", attach });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(m.createdCount(), 1);
  assert.equal(m.calls.length, 2);
  // aj keby server vrátil 502 (maxAttempts 1), opakovanie klienta dostane ten istý zámer → tú istú reláciu
  const m2 = mockStripeCheckout({ failFirstAfterCreate: true });
  const s2 = new StripeTestProvider({ secretKey: "sk_test_" + "a".repeat(24), webhookSecret: "whsec_x", fetchImpl: m2.fetchImpl });
  const first = await startWebCheckout({ provider: s2, intent: INTENT, origin: "https://staging.esblu.test", attach, maxAttempts: 1 });
  assert.equal(first.ok, false);
  const retry = await startWebCheckout({ provider: s2, intent: { ...INTENT, reused: true }, origin: "https://staging.esblu.test", attach, maxAttempts: 1 });
  assert.ok(retry.ok);
  assert.equal(m2.createdCount(), 1);
});
await check("stripe-adapter: zrušenie rozpracovanej platby — open → expired; dokončená relácia sa nezruší", async () => {
  const m = mockStripeCheckout();
  const stripe = new StripeTestProvider({ secretKey: "sk_test_" + "a".repeat(24), webhookSecret: "whsec_x", fetchImpl: m.fetchImpl });
  const r = await startWebCheckout({ provider: stripe, intent: INTENT, origin: "https://staging.esblu.test", attach });
  assert.ok(r.ok);
  assert.equal(await stripe.expireCheckout("cs_test_1"), "expired");
  m.sessions.get(`esblu-checkout-${INTENT.checkout_id}`)!.status = "complete";
  assert.equal(await stripe.expireCheckout("cs_test_1"), "complete");
  assert.equal(stripeExpiresAt(null), null);
  assert.equal(stripeExpiresAt("2026-11-18T12:00:00.000Z"), 1795003200);
});

await check("stripe-adapter: kľúče — sk_test_/rk_test_/rkcs_test_ (sandbox) povolené; *_live_ vrátane rkcs_live_ odmietnuté", () => {
  for (const k of ["sk_test_", "rk_test_", "rkcs_test_"]) assert.equal(assertStripeTestKey(k + "A1b2C3d4E5"), k + "A1b2C3d4E5");
  for (const k of ["sk_live_", "rk_live_", "rkcs_live_"]) assert.throws(() => assertStripeTestKey(k + "A1b2C3d4E5"), /LIVE_MODE_FORBIDDEN/);
  assert.throws(() => assertStripeTestKey("pk_test_A1b2C3d4E5"), /NOT_CONFIGURED/);
  const env = { ESBLU_BILLING_MODE: "stripe_test", ESBLU_BILLING_RETURN_ORIGIN: "http://localhost:3000", STRIPE_SECRET_KEY: "rkcs_test_A1b2C3d4E5", STRIPE_WEBHOOK_SECRET: "whsec_A1b2C3d4E5" };
  assert.ok(!validateBillingEnv(env).invalid.includes("STRIPE_SECRET_KEY"));
  assert.ok(validateBillingEnv({ ...env, STRIPE_SECRET_KEY: "rkcs_live_A1b2C3d4E5" }).invalid.some((x) => x.startsWith("STRIPE_SECRET_KEY")));
});

await check("S12 cron: bez CRON_SECRET 401; billing vypnutý / VERCEL_ENV=production → configured:false bez volania Stripe ani DB", async () => {
  const saved = { ...process.env };
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => { calls.push(String(u)); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
  try {
    process.env.CRON_SECRET = "c".repeat(32);
    // atrapy pre import modulov (žiadne spojenie sa nevytvorí — billing je vypnutý skôr)
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:9";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-placeholder";
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-placeholder";
    const { GET } = await import("../app/api/cron/billing-stripe-events/route.ts");
    const req = (auth?: string) => new Request("http://localhost/api/cron/billing-stripe-events", { headers: auth ? { authorization: auth } : {} });
    assert.equal((await GET(req())).status, 401);
    assert.equal((await GET(req("Bearer wrong"))).status, 401);
    delete process.env.ESBLU_BILLING_MODE;
    let r = await GET(req(`Bearer ${"c".repeat(32)}`));
    assert.deepEqual(await r.json(), { success: true, configured: false });
    process.env.ESBLU_BILLING_MODE = "stripe_test";
    process.env.VERCEL_ENV = "production";
    r = await GET(req(`Bearer ${"c".repeat(32)}`));
    assert.deepEqual(await r.json(), { success: true, configured: false }, "produkcia = billing tvrdo vypnutý");
    assert.deepEqual(calls, [], "žiadne sieťové volanie");
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

// ============================================================================= S15 live režim
const LIVE_K = "sk_live_" + "L".repeat(24);
const TEST_K = "sk_test_" + "T".repeat(24);
const WH = "whsec_" + "w".repeat(32);
await check("S15 config: stripe_live IBA v produkcii so schválením; produkcia bez schválenia / so stripe_test / fake = off; mimo produkcie live = off", () => {
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_live", ESBLU_BILLING_LIVE_APPROVED: "true" }), "stripe_live");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_live" }), "off", "bez schválenia");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_live", ESBLU_BILLING_LIVE_APPROVED: "TRUE" }), "off", "presne 'true'");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_test", ESBLU_BILLING_LIVE_APPROVED: "true" }), "off");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "fake", ESBLU_BILLING_LIVE_APPROVED: "true" }), "off");
  for (const v of ["preview", "development", undefined]) {
    assert.equal(getBillingServerMode({ VERCEL_ENV: v, ESBLU_BILLING_MODE: "stripe_live", ESBLU_BILLING_LIVE_APPROVED: "true" }), "off", `VERCEL_ENV=${v}`);
  }
  assert.equal(billingEnvironmentForMode("stripe_live"), "live");
  assert.equal(billingEnvironmentForMode("stripe_test"), "test");
  assert.equal(billingEnvironmentForMode("off"), null);
});
await check("S15 kľúče: live provider odmietne test kľúč (TEST_MODE_FORBIDDEN) a rkcs_live; test provider odmietne live kľúč", () => {
  const code = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return (e as { code?: string }).code; } };
  assert.equal(code(() => assertStripeKeyFor("live", LIVE_K)), "ok");
  assert.equal(code(() => assertStripeKeyFor("live", "rk_live_" + "x".repeat(20))), "ok");
  assert.equal(code(() => assertStripeKeyFor("live", TEST_K)), "TEST_MODE_FORBIDDEN");
  assert.equal(code(() => assertStripeKeyFor("live", "rkcs_test_" + "x".repeat(20))), "TEST_MODE_FORBIDDEN");
  assert.equal(code(() => assertStripeKeyFor("live", "rkcs_live_" + "x".repeat(20))), "NOT_CONFIGURED");
  assert.equal(code(() => assertStripeKeyFor("live", undefined)), "NOT_CONFIGURED");
  assert.equal(code(() => assertStripeKeyFor("test", LIVE_K)), "LIVE_MODE_FORBIDDEN");
  assert.equal(code(() => assertStripeTestKey(LIVE_K)), "LIVE_MODE_FORBIDDEN");
});
await check("S15 webhook a API: livemode musí zodpovedať prostrediu (live ← test udalosť / objekt = odmietnuté a naopak)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const evt = (livemode: boolean) => JSON.stringify({ object: "event", id: "evt_s15", type: "invoice.paid", created: now, livemode, data: { object: {} } });
  const live = new StripeLiveProvider({ secretKey: LIVE_K, webhookSecret: WH, now: () => new Date(now * 1000) });
  const test = new StripeTestProvider({ secretKey: TEST_K, webhookSecret: WH, now: () => new Date(now * 1000) });
  const verify = async (p: StripeLiveProvider | StripeTestProvider, raw: string) => {
    try { const e = await p.verifyWebhook(raw, new Headers({ "stripe-signature": signTimestamped(raw, WH, now) })); return e.environment; }
    catch (e) { return (e as { code?: string }).code; }
  };
  assert.equal(await verify(live, evt(true)), "live");
  assert.equal(await verify(live, evt(false)), "TEST_MODE_FORBIDDEN");
  assert.equal(await verify(test, evt(false)), "test");
  assert.equal(await verify(test, evt(true)), "LIVE_MODE_FORBIDDEN");
  const missing = JSON.stringify({ object: "event", id: "evt_s15b", type: "invoice.paid", created: now, data: { object: {} } });
  assert.equal(await verify(live, missing), "TEST_MODE_FORBIDDEN", "chýbajúci livemode v live = odmietnuté");
  assert.equal(await verify(test, missing), "LIVE_MODE_FORBIDDEN", "chýbajúci livemode v test = odmietnuté");
  const code = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return (e as { code?: string }).code; } };
  assert.equal(code(() => live.eventFromApi({ object: "event", id: "e", type: "x", created: now, livemode: false })), "TEST_MODE_FORBIDDEN");
  assert.equal(code(() => test.eventFromApi({ object: "event", id: "e", type: "x", created: now, livemode: true })), "LIVE_MODE_FORBIDDEN");
  const testObj = (async () => new Response(JSON.stringify({ object: "subscription", id: "sub_x", livemode: false }), { status: 200 })) as unknown as typeof fetch;
  const liveApi = new StripeLiveProvider({ secretKey: LIVE_K, webhookSecret: WH, fetchImpl: testObj });
  await assert.rejects(() => liveApi.getSubscription({ providerSubscriptionId: "sub_x", providerCustomerId: null }), (e: unknown) => (e as { code?: string }).code === "TEST_MODE_FORBIDDEN");
  const liveObj = (async () => new Response(JSON.stringify({ object: "subscription", id: "sub_x", livemode: true }), { status: 200 })) as unknown as typeof fetch;
  const testApi = new StripeTestProvider({ secretKey: TEST_K, webhookSecret: WH, fetchImpl: liveObj });
  await assert.rejects(() => testApi.getSubscription({ providerSubscriptionId: "sub_x", providerCustomerId: null }), (e: unknown) => (e as { code?: string }).code === "LIVE_MODE_FORBIDDEN");
});
await check("S15 env schéma: produkcia live úplná = ok; test kľúče vedľa live, http návrat, live premenné mimo produkcie = chyba (iba názvy)", () => {
  const prod = { VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_live", ESBLU_BILLING_LIVE_APPROVED: "true", STRIPE_LIVE_SECRET_KEY: LIVE_K,
    STRIPE_LIVE_WEBHOOK_SECRET: WH, ESBLU_BILLING_RETURN_ORIGIN: "https://www.esblu.com", CRON_SECRET: "c".repeat(32) };
  const ok = validateBillingEnv(prod);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.modes.web, "live");
  const mixed = validateBillingEnv({ ...prod, STRIPE_SECRET_KEY: TEST_K, STRIPE_WEBHOOK_SECRET: WH });
  assert.equal(mixed.ok, false);
  assert.ok(mixed.invalid.includes("STRIPE_SECRET_KEY:TEST_CONFIG_IN_LIVE") && mixed.invalid.includes("STRIPE_WEBHOOK_SECRET:TEST_CONFIG_IN_LIVE"));
  assert.ok(validateBillingEnv({ ...prod, ESBLU_BILLING_RETURN_ORIGIN: "http://localhost:3000" }).invalid.includes("ESBLU_BILLING_RETURN_ORIGIN:HTTPS_REQUIRED"));
  assert.ok(validateBillingEnv({ ...prod, STRIPE_LIVE_SECRET_KEY: TEST_K }).invalid.includes("STRIPE_LIVE_SECRET_KEY"));
  const missing = validateBillingEnv({ ...prod, STRIPE_LIVE_WEBHOOK_SECRET: "" });
  assert.ok(missing.missing.includes("STRIPE_LIVE_WEBHOOK_SECRET"));
  const preview = validateBillingEnv({ VERCEL_ENV: "preview", ESBLU_BILLING_MODE: "stripe_test", STRIPE_SECRET_KEY: TEST_K, STRIPE_WEBHOOK_SECRET: WH,
    STRIPE_LIVE_SECRET_KEY: LIVE_K, ESBLU_BILLING_RETURN_ORIGIN: "https://x.vercel.app", CRON_SECRET: "c".repeat(32) });
  assert.ok(preview.invalid.includes("STRIPE_LIVE_SECRET_KEY:LIVE_OUTSIDE_PRODUCTION"));
  const unapproved = resolveProviderModes({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_live" });
  assert.equal(unapproved.web, "disabled");
  assert.ok(unapproved.issues.includes("LIVE_NOT_APPROVED"));
  for (const r of [ok, mixed, preview]) assert.ok(!JSON.stringify(r).includes(LIVE_K) && !JSON.stringify(r).includes(TEST_K), "žiadne hodnoty");
});
await check("S15 getWebBillingProvider: live iba pri platnej produkčnej konfigurácii; zámer iného prostredia → null; checkout iného prostredia sa nevolá", async () => {
  const saved = { ...process.env };
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:9";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-placeholder";
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-placeholder";
    const { getWebBillingProvider } = await import("../lib/billing/server.ts");
    Object.assign(process.env, { VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_live", ESBLU_BILLING_LIVE_APPROVED: "true", STRIPE_LIVE_SECRET_KEY: LIVE_K,
      STRIPE_LIVE_WEBHOOK_SECRET: WH, ESBLU_BILLING_RETURN_ORIGIN: "https://www.esblu.com", CRON_SECRET: "c".repeat(32) });
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.ESBLU_FAKE_BILLING_SECRET;
    const p = getWebBillingProvider("stripe");
    assert.ok(p instanceof StripeLiveProvider, "live provider");
    assert.equal(p?.environment, "live");
    assert.equal(getWebBillingProvider("stripe", "test"), null, "zámer z test prostredia");
    assert.ok(getWebBillingProvider("stripe", "live") instanceof StripeLiveProvider);
    process.env.STRIPE_SECRET_KEY = TEST_K;
    assert.equal(getWebBillingProvider("stripe"), null, "test kľúč vedľa live = fail closed");
    delete process.env.STRIPE_SECRET_KEY;
    process.env.ESBLU_BILLING_LIVE_APPROVED = "false";
    assert.equal(getWebBillingProvider("stripe"), null, "bez schválenia");
    Object.assign(process.env, { VERCEL_ENV: "preview", ESBLU_BILLING_MODE: "stripe_test", STRIPE_SECRET_KEY: TEST_K, STRIPE_WEBHOOK_SECRET: WH });
    const t = getWebBillingProvider("stripe");
    assert.ok(t instanceof StripeTestProvider && !(t instanceof StripeLiveProvider));
    assert.equal(getWebBillingProvider("stripe", "live"), null);
    let called = 0;
    const r = await startWebCheckout({
      provider: { ...(t as StripeTestProvider), environment: "test", createCheckout: async () => { called++; return { providerSessionId: "cs", url: "u" }; } } as unknown as StripeTestProvider,
      intent: { checkout_id: "11111111-1111-4111-8111-111111111111", provider: "stripe", provider_price_id: "price_x", provider_customer_id: null, environment: "live" },
      origin: "https://x", attach: async () => ({ error: null }),
    });
    assert.equal(r.ok, false);
    assert.equal(called, 0, "provider sa pri inom prostredí nevolá");
  } finally {
    process.env = saved;
  }
});

await check("S15b manage: provider iba z prostredia predplatného; nesúlad / neznáme prostredie = 409 bez volania providera", () => {
  const live = new StripeLiveProvider({ secretKey: LIVE_K, webhookSecret: WH });
  const test = new StripeTestProvider({ secretKey: TEST_K, webhookSecret: WH });
  const calls: Array<[string | null | undefined, string | null | undefined]> = [];
  const serverIs = (p: StripeLiveProvider | StripeTestProvider | null) => (expected?: string | null, env?: string | null) => {
    calls.push([expected, env]);
    if (!p) return null;
    if (env && env !== p.environment) return null;
    return p;
  };
  const acc = (env: string | null, sub = "sub_1") => ({ billing_provider: "stripe", provider_environment: env, provider_customer_id: "cus_1", provider_subscription_id: sub });
  const ok = resolveManageProvider(acc("live"), serverIs(live));
  assert.ok(ok.ok && ok.provider === live);
  const r1 = resolveManageProvider(acc("test"), serverIs(live));
  assert.deepEqual(r1.ok ? null : [r1.status, r1.code], [409, "ESBLU_BILLING_ENVIRONMENT_MISMATCH"], "test predplatné na live serveri");
  const r2 = resolveManageProvider(acc("live"), serverIs(test));
  assert.deepEqual(r2.ok ? null : [r2.status, r2.code], [409, "ESBLU_BILLING_ENVIRONMENT_MISMATCH"], "live predplatné na test serveri");
  const r3 = resolveManageProvider(acc(null), serverIs(test));
  assert.deepEqual(r3.ok ? null : r3.code, "ESBLU_BILLING_ENVIRONMENT_MISMATCH", "neznáme prostredie");
  const r4 = resolveManageProvider(acc("test"), serverIs(null));
  assert.deepEqual(r4.ok ? null : [r4.status, r4.code], [503, "ESBLU_BILLING_DISABLED"]);
  const r5 = resolveManageProvider({ billing_provider: "google", provider_environment: "test", provider_customer_id: null, provider_subscription_id: "tok" }, serverIs(test));
  assert.equal(r5.ok ? null : r5.code, "ESBLU_BILLING_MANAGE_IN_STORE");
  const none = resolveManageProvider({ billing_provider: null, provider_environment: null, provider_customer_id: null, provider_subscription_id: null }, serverIs(test));
  assert.ok(none.ok, "bez predplatného: route vráti NO_ACTIVE_SUBSCRIPTION bez volania providera");
});
await check("S15b secrets: live/test Stripe premenné iba v serverových moduloch; žiadny klientsky (.tsx) import billing servera, žiadne NEXT_PUBLIC_*STRIPE*/LIVE", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    if (n === "node_modules" || n.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const files = ["app", "lib"].flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f));
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const client = f.endsWith(".tsx") || /^["']use client["']/m.test(src);
    if (/NEXT_PUBLIC_[A-Z_]*(STRIPE|LIVE)/.test(src)) bad.push(`${f}: NEXT_PUBLIC stripe/live`);
    if (client && /STRIPE_(LIVE_)?(SECRET_KEY|WEBHOOK_SECRET)|ESBLU_BILLING_LIVE_APPROVED/.test(src)) bad.push(`${f}: secret v klientskom module`);
    if (client && /@\/lib\/billing\/(server|provider-modes|config|providers\/stripe)"/.test(src)) bad.push(`${f}: klient importuje serverový billing`);
    if (/console\.(log|info|warn|error)\([^)]*(STRIPE_|secretKey|webhookSecret)/.test(src)) bad.push(`${f}: log tajomstva`);
  }
  const readers = files.filter((f) => /process\.env\.STRIPE_LIVE_(SECRET_KEY|WEBHOOK_SECRET)/.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers, ["lib/billing/server.ts"], "live secrety číta iba lib/billing/server.ts");
  assert.deepEqual(bad, []);
});

await check("S15b doťahovanie: web_provider='none' (pozastavený predaj) synchronizáciu nevypína; vypína ju iba režim servera alebo fake", () => {
  const src = read("app/api/cron/billing-stripe-events/route.ts");
  assert.match(src, /config\?\.web_provider !== "stripe" && config\?\.web_provider !== "none"/);
  const webhook = read("app/api/billing/webhooks/stripe/route.ts");
  assert.ok(!/web_provider/.test(webhook), "webhook nezávisí od pozastavenia predaja");
  const rec = read("app/api/cron/billing-reconcile/route.ts");
  assert.ok(!/web_provider/.test(rec), "reconciliation nezávisí od pozastavenia predaja");
});

// ============================================================================= P4: API verzia, doklady, ops, export
await check("stripe-adapter: KAŽDÝ request nesie Stripe-Version = pripnutá verzia (GET, POST, DELETE, list)", async () => {
  const seen: Array<string | undefined> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push((init.headers as Record<string, string>)["Stripe-Version"]);
    if (url.includes("/checkout/sessions")) return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/x", livemode: false }), { status: 200 });
    if (url.includes("/events")) return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
    return new Response(JSON.stringify({ ...SUB, livemode: false }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new StripeTestProvider({ secretKey: KEY, webhookSecret: WHSEC, fetchImpl, now: () => new Date(NOW * 1000) });
  const ref = { providerSubscriptionId: "sub_r1", providerCustomerId: "cus_1" };
  await p.getSubscription(ref);
  await p.cancelSubscription(ref);
  await p.cancelSubscriptionNow(ref);
  await p.createCheckout({ checkoutId: "11111111-1111-4111-8111-111111111111", providerPriceId: "price_1", providerCustomerId: null, successUrl: "https://x/s", cancelUrl: "https://x/c" });
  await p.listEvents({ limit: 1 });
  await p.listBalanceTransactions({ limit: 1 }).catch(() => null);
  assert.ok(seen.length >= 6);
  assert.ok(seen.every((v) => v === STRIPE_API_VERSION), JSON.stringify(seen));
  assert.equal(p.apiVersion, STRIPE_API_VERSION);
});
await check("stripe-adapter: override verzie iba na overenú verziu, inak NOT_CONFIGURED (fail closed) a validateBillingEnv ju hlási", async () => {
  assert.equal(resolveStripeApiVersion(undefined), STRIPE_API_VERSION);
  assert.equal(resolveStripeApiVersion(""), STRIPE_API_VERSION);
  assert.equal(resolveStripeApiVersion(STRIPE_API_VERSION), STRIPE_API_VERSION);
  assert.equal(resolveStripeApiVersion("2026-09-30.endive"), null);
  let called = false;
  const p = new StripeTestProvider({ secretKey: KEY, webhookSecret: WHSEC, apiVersion: "2024-06-20", fetchImpl: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch });
  await assert.rejects(p.getSubscription({ providerSubscriptionId: "sub_1", providerCustomerId: null }), /NOT_CONFIGURED/);
  assert.equal(called, false, "bez overenej verzie sa Stripe nevolá");
  const env = { ESBLU_BILLING_MODE: "stripe_test", STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WHSEC, ESBLU_BILLING_RETURN_ORIGIN: "https://staging.esblu.com", CRON_SECRET: "x".repeat(20) };
  assert.ok(validateBillingEnv({ ...env, STRIPE_API_VERSION }).ok);
  assert.ok(validateBillingEnv({ ...env, STRIPE_API_VERSION: "2024-06-20" }).invalid.includes("STRIPE_API_VERSION"));
  assert.ok(validateBillingEnv({ ...env, STRIPE_LIVE_REPORTING_KEY: "rk_live_" + "a".repeat(20) }).invalid.includes("STRIPE_LIVE_REPORTING_KEY:LIVE_OUTSIDE_PRODUCTION"));
});
await check("stripe-adapter: udalosť z API (doťahovanie/retry) → payloadSha256 null (§ 2.3), api_version sa prenáša; webhook → hash tela", async () => {
  const p = stripe({});
  const e = p.eventFromApi({ object: "event", id: "evt_a", type: "invoice.paid", created: NOW, livemode: false, api_version: STRIPE_API_VERSION, data: { object: {} } });
  assert.equal(e.payloadSha256, null);
  assert.equal(e.apiVersion, STRIPE_API_VERSION);
  const w = stripeEvent("customer.subscription.updated", SUB);
  assert.match(String((await p.verifyWebhook(w.raw, w.headers)).payloadSha256), /^[0-9a-f]{64}$/);
  assert.ok(STRIPE_CATCHUP_EVENT_TYPES.length <= 20, "Stripe types[] max 20");
  for (const t of ["invoice.finalized", "credit_note.created", "credit_note.voided"]) assert.ok(STRIPE_CATCHUP_EVENT_TYPES.includes(t), t);
});
await check("stripe-adapter: faktúra / dobropis → účtovná kópia bez mena, e-mailu a adresy; daňové polia tak, ako prišli", () => {
  const inv = stripeInvoiceDocument({ object: "invoice", id: "in_9", number: "ESB-9", status: "paid", currency: "eur", customer: "cus_9", customer_name: "Jana", customer_email: "j@x.sk",
    customer_address: { country: "cz", line1: "Ulica 1" }, customer_tax_ids: [{ type: "eu_vat", value: "CZ12345678", verification: { status: "verified" } }],
    total: 1590, total_excluding_tax: 1590, total_taxes: [{ amount: 0, tax_behavior: "exclusive", taxability_reason: "reverse_charge", taxable_amount: 1590, nested: { deep: { x: 1 } } }],
    status_transitions: { finalized_at: NOW, paid_at: NOW }, invoice_pdf: "https://pay.stripe.com/x/pdf", parent: { subscription_details: { subscription: "sub_9" } } })!;
  assert.deepEqual([inv.kind, inv.customer_country, inv.tax_minor, inv.provider_subscription_id, inv.issued_at], ["invoice", "CZ", 0, "sub_9", new Date(NOW * 1000).toISOString()]);
  assert.deepEqual(inv.customer_tax_ids, [{ type: "eu_vat", value: "CZ12345678" }]);
  assert.equal(inv.tax_details[0].taxability_reason, "reverse_charge");
  assert.doesNotMatch(JSON.stringify(inv), /Jana|j@x|Ulica|deep/);
  const cn = stripeCreditNoteDocument({ object: "credit_note", id: "cn_9", invoice: "in_9", number: "ESB-9-CN", status: "issued", total: 1590, total_excluding_tax: 1590, created: NOW, memo: "Jana" })!;
  assert.deepEqual([cn.kind, cn.related_invoice_id, cn.status], ["credit_note", "in_9", "issued"]);
  assert.doesNotMatch(JSON.stringify(cn), /Jana/);
});
await check("billing-ops: CSV — sumy z centov, ochrana pred formula injection, BOM + ; ; mesiac", () => {
  assert.equal(formatMinor(1590, "EUR"), "15.90");
  assert.equal(formatMinor(-47, "EUR"), "-0.47");
  assert.equal(formatMinor(500, "JPY"), "500");
  assert.equal(csvText("=HYPERLINK(1)"), `"'=HYPERLINK(1)"`);
  assert.equal(csvText('a"b'), `"a""b"`);
  const csv = buildAccountingCsv([{ record_type: "invoice", document_number: "@evil", currency: "EUR", total_minor: 1590, customer_tax_ids: [{ type: "eu_vat", value: "SK1" }], pdf_archived: false }]);
  assert.ok(csv.startsWith("\uFEFFrecord_type;"));
  assert.match(csv, /"'@evil"/);
  assert.match(csv, /;15\.90;/);
  assert.deepEqual(monthRange("2026-12"), { from: new Date(Date.UTC(2026, 11, 1)), to: new Date(Date.UTC(2027, 0, 1)) });
  assert.equal(monthRange("2026-1"), null);
});
await check("billing-ops: e-mail alertu iba s kódmi a číslami; Resend iba pri všetkých troch premenných; archív iba *.stripe.com", () => {
  assert.deepEqual(safeDetails({ count: 2, email: "a@b.sk", code: "NORMALIZE_FAILED", id: "sub_1", x: { y: 1 } }), { count: 2, code: "NORMALIZE_FAILED" });
  const m = formatAlertEmail({ id: "1", environment: "live", code: "CATCHUP_LAG", severity: "critical", occurrences: 3, first_seen_at: "2026-11-23T10:00:00Z", last_seen_at: "2026-11-23T11:00:00Z", details: { minutes_since_success: 75, who: "jana@x.sk" } });
  assert.equal(m.subject, "[Esblu billing][live] CRITICAL: CATCHUP_LAG");
  assert.match(m.text, /minutes_since_success: 75/);
  assert.doesNotMatch(m.text, /jana/);
  assert.equal(resendMailerFromEnv({}), null);
  assert.equal(resendMailerFromEnv({ RESEND_API_KEY: "re_" + "a".repeat(20), ESBLU_OPS_ALERT_EMAIL_TO: "ops@esblu.com" }), null);
  assert.ok(resendMailerFromEnv({ RESEND_API_KEY: "re_" + "a".repeat(20), ESBLU_OPS_ALERT_EMAIL_TO: "ops@esblu.com", ESBLU_OPS_ALERT_EMAIL_FROM: "Esblu <ops@esblu.com>" }));
  assert.ok(isAllowedStripeUrl("https://pay.stripe.com/invoice/x/pdf"));
  for (const u of ["http://pay.stripe.com/x", "https://stripe.com.evil.io/x", "https://evil.io/stripe.com/", "https://u:p@pay.stripe.com/x", "https://pay.stripe.com:8443/x"]) assert.equal(isAllowedStripeUrl(u), false, u);
  assert.equal(archivePath("live", "invoice", "in_1A", "2026-11-23T10:00:00Z"), "live/2026/11/invoice/in_1A.pdf");
  assert.equal(archivePath("live", "invoice", "../x", "2026-11-23T10:00:00Z"), null);
});

// ----------------------------------------------------------------------------- S17-5 (2026-11-22): archív PDF cez S3 Stripe
const S3 = "https://stripe-upload-api.s3.us-west-1.amazonaws.com/invoices/x.pdf?X-Amz-Signature=abc";
const PAY = "https://pay.stripe.com/invoice/acct_x/test_tok/pdf?s=ap";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% esblu s17-5\n");
await check("billing-ops: S17-5 presmerovanie PDF — presný S3 hostiteľ Stripe IBA z *.stripe.com; nič iné z AWS", () => {
  assert.deepEqual([...STRIPE_PDF_STORAGE_HOSTS], ["stripe-upload-api.s3.us-west-1.amazonaws.com"]);
  assert.equal(isAllowedPdfRedirect(S3, PAY), true);
  assert.equal(isAllowedPdfRedirect("https://files.stripe.com/x.pdf", PAY), true);
  assert.equal(isAllowedStripeUrl(S3), false, "S3 nie je povolený ako prvá URL dokladu");
  for (const [next, from, why] of [
    [S3, S3, "z S3 ďalej nikam"],
    [S3, "https://evil.example/x", "presmerovanie z cudzieho hostiteľa"],
    [S3, "https://stripe-upload-api.s3.us-west-1.amazonaws.com/a", "S3 → S3"],
    ["https://stripe-upload-api.s3.us-east-1.amazonaws.com/x.pdf", PAY, "iný región"],
    ["https://evil.s3.us-west-1.amazonaws.com/x.pdf", PAY, "iný bucket"],
    ["https://s3.us-west-1.amazonaws.com/stripe-upload-api/x.pdf", PAY, "path-style S3"],
    ["https://stripe-upload-api.s3.us-west-1.amazonaws.com.evil.io/x.pdf", PAY, "podvrhnutý sufix"],
    ["https://xstripe-upload-api.s3.us-west-1.amazonaws.com/x.pdf", PAY, "podvrhnutý prefix"],
    ["https://evil.amazonaws.com/x.pdf", PAY, "*.amazonaws.com"],
    ["http://stripe-upload-api.s3.us-west-1.amazonaws.com/x.pdf", PAY, "http"],
    ["https://stripe-upload-api.s3.us-west-1.amazonaws.com:8443/x.pdf", PAY, "port"],
    ["https://u:p@stripe-upload-api.s3.us-west-1.amazonaws.com/x.pdf", PAY, "prihlasovacie údaje"],
    ["https://169.254.169.254/latest/meta-data", PAY, "metadata IP"],
    ["https://[::1]/x.pdf", PAY, "IPv6 literál"],
    ["https://127.0.0.1/x.pdf", PAY, "IPv4 literál"],
    ["not a url", PAY, "neplatná URL"],
  ] as const) assert.equal(isAllowedPdfRedirect(next, from), false, why);
});
await check("billing-ops: S17-5 SSRF — blokované neverejné IP (v4/v6, mapované, tunelované), verejné povolené", () => {
  for (const a of ["10.1.2.3", "127.0.0.1", "0.0.0.0", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "2001:db8::1", "ff02::1", "nie-ip"]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ["52.219.193.10", "3.5.160.1", "54.187.174.169", "8.8.8.8", "172.32.0.1", "2600:1f14::1", "2a00:1450:4001::1"]) assert.equal(isBlockedAddress(a), false, a);
});
await check("billing-ops: S17-5 lookup pri pripojení — zmiešané/privátne adresy odmietnuté, DNS rebinding sa kontroluje pri KAŽDOM pripojení", async () => {
  const answers: string[][] = [["52.219.193.10"], ["52.219.193.10", "10.0.0.5"], ["127.0.0.1"]];
  let call = 0;
  const fake = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => {
    const list = answers[Math.min(call++, answers.length - 1)];
    cb(null, list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  }) as unknown as Parameters<typeof guardedLookup>[0];
  const lk = guardedLookup(fake);
  const run = (opts: unknown) => new Promise<{ err: string | null; addr: unknown }>((res) => lk("stripe-upload-api.s3.us-west-1.amazonaws.com", opts, (err, addr) => res({ err: err ? String(err.code) : null, addr })));
  assert.deepEqual(await run({}), { err: null, addr: "52.219.193.10" });
  assert.equal((await run({ all: true })).err, "ADDRESS_NOT_ALLOWED", "jedna privátna adresa = odmietnuť celý hostiteľ");
  assert.equal((await run(4)).err, "ADDRESS_NOT_ALLOWED", "rebinding na 127.0.0.1 pri ďalšom pripojení");
});
await check("billing-ops: S17-5 požiadavka na PDF — bez cookies/autentifikácie, bez poolu, TLS overené; IP z lookupu sa skutočne použije", async () => {
  assert.deepEqual(Object.keys(PDF_REQUEST_HEADERS).sort(), ["accept", "user-agent"]);
  const o = buildPdfRequestOptions(new URL(S3));
  const h = o.headers as Record<string, string>;
  for (const bad of ["authorization", "cookie", "apikey", "stripe-account", "x-api-key", "proxy-authorization"]) assert.equal(Object.keys(h).some((k) => k.toLowerCase() === bad), false, bad);
  assert.deepEqual([o.agent, o.rejectUnauthorized, o.port, o.method, o.servername, typeof o.lookup], [false, true, 443, "GET", "stripe-upload-api.s3.us-west-1.amazonaws.com", "function"]);
  assert.equal(o.path, "/invoices/x.pdf?X-Amz-Signature=abc");
  // skutočný socket: hostiteľ "sa preloží" na 127.0.0.1 → spojenie sa NEOTVORÍ (server nedostane žiadne pripojenie)
  let connections = 0;
  const srv = createNetServer(() => { connections++; });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as Parameters<typeof guardedLookup>[0];
  const err = await new Promise<string>((res) => {
    const req = httpsRequest({ ...buildPdfRequestOptions(new URL(S3), guardedLookup(toLoopback)), port }, () => res("connected"));
    req.on("error", (e: NodeJS.ErrnoException) => res(String(e.code ?? e.message)));
    req.end();
  });
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(err, "ADDRESS_NOT_ALLOWED");
  assert.equal(connections, 0);
  // klient odmietne bez siete: IP literál, cudzí hostiteľ, http
  for (const u of ["https://127.0.0.1/x.pdf", "https://[::1]/x.pdf", "https://evil.example/x.pdf", "http://pay.stripe.com/x", "https://evil.s3.us-west-1.amazonaws.com/x"]) {
    await assert.rejects(() => safePdfFetch(u), (e: { code?: string }) => e.code === "URL_NOT_ALLOWED", u);
  }
});
await check("billing-ops: S17-5 fetchStripePdf — pay.stripe.com → S3 → PDF; chybné PDF, veľkosť, presmerovania a SSRF kódy", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const chain = (map: Record<string, () => Response>) => (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const f = map[new URL(url).hostname];
    if (!f) throw new Error("neočakávaný hostiteľ " + url);
    return f();
  }) as unknown as typeof fetch;
  const ok = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: S3 } }), "stripe-upload-api.s3.us-west-1.amazonaws.com": () => new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } }) });
  const got = await fetchStripePdf(PAY, ok);
  assert.ok(got instanceof Uint8Array && Buffer.from(got).equals(Buffer.from(PDF_BYTES)), "PDF = bajty zo Stripe");
  assert.deepEqual(seen.map((s) => new URL(s.url).hostname), ["pay.stripe.com", "stripe-upload-api.s3.us-west-1.amazonaws.com"]);
  for (const s of seen) { assert.equal(s.init?.headers, undefined, "žiadne vlastné hlavičky"); assert.equal(s.init?.credentials, "omit"); assert.equal(s.init?.redirect, "manual"); }
  const s3loop = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: S3 } }), "stripe-upload-api.s3.us-west-1.amazonaws.com": () => new Response(null, { status: 302, headers: { location: S3 } }) });
  assert.equal(await fetchStripePdf(PAY, s3loop), "URL_NOT_ALLOWED", "S3 → S3 presmerovanie");
  const s3evil = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: S3 } }), "stripe-upload-api.s3.us-west-1.amazonaws.com": () => new Response(null, { status: 302, headers: { location: "https://files.stripe.com/x" } }) });
  assert.equal(await fetchStripePdf(PAY, s3evil), "URL_NOT_ALLOWED", "z S3 ani späť na stripe.com");
  const otherBucket = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: "https://evil.s3.us-west-1.amazonaws.com/x.pdf" } }) });
  assert.equal(await fetchStripePdf(PAY, otherBucket), "URL_NOT_ALLOWED");
  assert.equal(await fetchStripePdf(S3, ok), "URL_NOT_ALLOWED", "S3 ako prvá URL");
  const html = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: S3 } }), "stripe-upload-api.s3.us-west-1.amazonaws.com": () => new Response("<Error>AccessDenied</Error>", { status: 200 }) });
  assert.equal(await fetchStripePdf(PAY, html), "NOT_A_PDF");
  const denied = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: S3 } }), "stripe-upload-api.s3.us-west-1.amazonaws.com": () => new Response("x", { status: 403 }) });
  assert.equal(await fetchStripePdf(PAY, denied), "HTTP_4XX");
  const big = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: S3 } }), "stripe-upload-api.s3.us-west-1.amazonaws.com": () => new Response(PDF_BYTES, { status: 200, headers: { "content-length": String(16 * 1024 * 1024) } }) });
  assert.equal(await fetchStripePdf(PAY, big), "PDF_TOO_LARGE");
  const loop = chain({ "pay.stripe.com": () => new Response(null, { status: 302, headers: { location: "https://files.stripe.com/a" } }), "files.stripe.com": () => new Response(null, { status: 302, headers: { location: "https://pay.stripe.com/b" } }) });
  assert.equal(await fetchStripePdf(PAY, loop), "TOO_MANY_REDIRECTS");
  for (const code of ["ADDRESS_NOT_ALLOWED", "PDF_TOO_LARGE", "URL_NOT_ALLOWED"]) {
    const thrower = (async () => { throw Object.assign(new Error(code), { code }); }) as unknown as typeof fetch;
    assert.equal(await fetchStripePdf(PAY, thrower), code);
  }
  const tls = (async () => { throw Object.assign(new Error("cert"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }); }) as unknown as typeof fetch;
  assert.equal(await fetchStripePdf(PAY, tls), "FETCH_FAILED", "TLS/sieť = FETCH_FAILED (backoff), nie úspech");
});

console.log(`\nsubscriptions-lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
