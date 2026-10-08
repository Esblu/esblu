// =============================================================================
// Unified subscriptions — unit / contract testy (bez siete, bez DB).
//   npm run test:subscriptions
// DB + RLS + end-to-end pipeline: scripts/subscriptions-pglite-tests.ts
// =============================================================================

import assert from "node:assert/strict";
import { getBillingServerMode, billingReturnOrigin, webProviderForMode } from "@/lib/billing/config";
import { processWebhook, type BillingDb } from "@/lib/billing/pipeline";
import { FakeBillingProvider } from "@/lib/billing/providers/fake";
import {
  StripeTestProvider,
  assertStripeTestKey,
  mapStripeStatus,
  normalizeStripeSubscription,
  stripeSubscriptionIdFromEvent,
} from "@/lib/billing/providers/stripe";
import { AppleAppStoreProvider, GooglePlayProvider, mapGoogleState, normalizeAppleNotification } from "@/lib/billing/providers/stores";
import { signTimestamped, verifyTimestampedSignature } from "@/lib/billing/signature";
import { BillingProviderError, type BillingProvider } from "@/lib/billing/types";
import {
  canStartCheckout,
  interpretCheckoutReturn,
  parseSubscriptionView,
  purchaseChannel,
} from "@/lib/billing/client-model";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function rejects(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof BillingProviderError, String(error));
    assert.equal(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const NOW = 1_790_000_000; // pevný čas (s)
const TEST_KEY = "sk_test_" + "a".repeat(24);
const WHSEC = "whsec_" + "b".repeat(32);

// ----------------------------------------------------------------------------- podpisy
await check("podpis: ok / zlý secret / starý timestamp / malformed / tolerance 0", () => {
  const body = '{"id":"evt_1"}';
  const header = signTimestamped(body, WHSEC, NOW);
  assert.equal(verifyTimestampedSignature(header, body, WHSEC, NOW), "ok");
  assert.equal(verifyTimestampedSignature(header, body, "whsec_other_secret_xxxx", NOW), "invalid");
  assert.equal(verifyTimestampedSignature(header, body + " ", WHSEC, NOW), "invalid");
  assert.equal(verifyTimestampedSignature(header, body, WHSEC, NOW + 301), "stale");
  assert.equal(verifyTimestampedSignature("v1=abc", body, WHSEC, NOW), "malformed");
  assert.equal(verifyTimestampedSignature(null, body, WHSEC, NOW), "malformed");
  assert.equal(verifyTimestampedSignature(header, body, WHSEC, NOW, 0), "malformed");
  // viac v1 (rotácia secretu) — stačí jeden platný
  assert.equal(verifyTimestampedSignature(`${header},v1=${"0".repeat(64)}`, body, WHSEC, NOW), "ok");
});

// ----------------------------------------------------------------------------- Stripe guards
await check("Stripe: live kľúč je zakázaný, chýbajúci = NOT_CONFIGURED", () => {
  assert.throws(() => assertStripeTestKey("sk_live_" + "x".repeat(24)), (e: unknown) => (e as BillingProviderError).code === "LIVE_MODE_FORBIDDEN");
  assert.throws(() => assertStripeTestKey("rk_live_" + "x".repeat(24)), (e: unknown) => (e as BillingProviderError).code === "LIVE_MODE_FORBIDDEN");
  assert.throws(() => assertStripeTestKey(undefined), (e: unknown) => (e as BillingProviderError).code === "NOT_CONFIGURED");
  assert.equal(assertStripeTestKey(TEST_KEY), TEST_KEY);
});
await check("Stripe: mapovanie stavov", () => {
  assert.equal(mapStripeStatus("incomplete_expired"), "expired");
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("weird"), null);
});
const SUB_NEW_API = {
  object: "subscription",
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  metadata: { esblu_checkout_id: "11111111-1111-4111-8111-111111111111" },
  items: { data: [{ id: "si_1", price: { id: "price_pro_m" }, current_period_start: NOW, current_period_end: NOW + 30 * 86400 }] },
};
await check("Stripe: normalizácia (period na položke — nové API; na sub — staré API; cancel_at)", () => {
  const s = normalizeStripeSubscription(SUB_NEW_API, "2026-10-08T00:00:00.000Z");
  assert.equal(s.provider_price_id, "price_pro_m");
  assert.equal(s.current_period_end, new Date((NOW + 30 * 86400) * 1000).toISOString());
  assert.equal(s.checkout_ref, "11111111-1111-4111-8111-111111111111");
  const old = normalizeStripeSubscription({ ...SUB_NEW_API, current_period_start: NOW, current_period_end: NOW + 86400, items: { data: [{ id: "si", price: { id: "p" } }] } }, "x");
  assert.equal(old.current_period_end, new Date((NOW + 86400) * 1000).toISOString());
  const cancelAt = normalizeStripeSubscription({ ...SUB_NEW_API, cancel_at: NOW + 30 * 86400 }, "x");
  assert.equal(cancelAt.cancel_at_period_end, true);
  const multi = normalizeStripeSubscription({ ...SUB_NEW_API, items: { data: [SUB_NEW_API.items.data[0], SUB_NEW_API.items.data[0]] } }, "x");
  assert.equal(multi.provider_price_id, null, "viac položiek → DB odmietne UNKNOWN_PRICE");
});
await check("Stripe: ID predplatného z checkout / invoice (parent.subscription_details) / subscription eventu", () => {
  assert.deepEqual(stripeSubscriptionIdFromEvent("checkout.session.completed", { mode: "subscription", subscription: "sub_9", client_reference_id: "ref" }), { subscriptionId: "sub_9", checkoutRef: "ref" });
  assert.equal(stripeSubscriptionIdFromEvent("checkout.session.completed", { mode: "payment", subscription: "sub_9" }).subscriptionId, null);
  assert.equal(stripeSubscriptionIdFromEvent("invoice.paid", { parent: { subscription_details: { subscription: "sub_7" } } }).subscriptionId, "sub_7");
  assert.equal(stripeSubscriptionIdFromEvent("invoice.payment_failed", { subscription: "sub_6" }).subscriptionId, "sub_6");
  assert.equal(stripeSubscriptionIdFromEvent("customer.subscription.deleted", { id: "sub_5" }).subscriptionId, "sub_5");
});

type Captured = { url: string; init: RequestInit };
function stripeWithFetch(responses: Record<string, unknown>, captured: Captured[] = []) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? responses[key] : { error: {} }), { status: key ? 200 : 404 });
  }) as unknown as typeof fetch;
  return new StripeTestProvider({ secretKey: TEST_KEY, webhookSecret: WHSEC, fetchImpl, now: () => new Date(NOW * 1000) });
}

await check("Stripe Checkout: subscription mode, price zo servera, client_reference_id, tax ID, idempotency, žiadne karty", async () => {
  const captured: Captured[] = [];
  const stripe = stripeWithFetch({ "/checkout/sessions": { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", livemode: false } }, captured);
  const session = await stripe.createCheckout({ checkoutId: "chk-1", providerPriceId: "price_pro_m", providerCustomerId: null, successUrl: "https://s/x", cancelUrl: "https://s/y" });
  assert.equal(session.providerSessionId, "cs_test_1");
  const body = new URLSearchParams(String(captured[0].init.body));
  assert.equal(body.get("mode"), "subscription");
  assert.equal(body.get("line_items[0][price]"), "price_pro_m");
  assert.equal(body.get("client_reference_id"), "chk-1");
  assert.equal(body.get("tax_id_collection[enabled]"), "true");
  assert.equal(body.get("payment_method_types[0]"), null, "dynamické platobné metódy (Apple/Google Pay podľa Dashboardu)");
  assert.ok(![...body.keys()].some((k) => /card|cvc|number/i.test(k)));
  assert.equal((captured[0].init.headers as Record<string, string>)["Idempotency-Key"], "esblu-checkout-chk-1");
});
await check("Stripe: odpoveď s livemode=true → LIVE_MODE_FORBIDDEN", async () => {
  const stripe = stripeWithFetch({ "/checkout/sessions": { id: "cs_live", url: "https://x", livemode: true } });
  await rejects(() => stripe.createCheckout({ checkoutId: "c", providerPriceId: "p", providerCustomerId: null, successUrl: "https://s", cancelUrl: "https://s" }), "LIVE_MODE_FORBIDDEN");
});
await check("Stripe webhook: podpis, livemode, refetch predplatného (nie snapshot z eventu)", async () => {
  const stripe = stripeWithFetch({ "/subscriptions/sub_1": { ...SUB_NEW_API, status: "past_due", livemode: false } });
  const event = { id: "evt_1", object: "event", type: "invoice.payment_failed", created: NOW, livemode: false, data: { object: { subscription: "sub_1" } } };
  const raw = JSON.stringify(event);
  const verified = await stripe.verifyWebhook(raw, new Headers({ "stripe-signature": signTimestamped(raw, WHSEC, NOW) }));
  const n = await stripe.normalizeEvent(verified);
  assert.equal(n.kind, "state");
  if (n.kind === "state") assert.equal(n.state.status, "past_due");
  const liveRaw = JSON.stringify({ ...event, livemode: true });
  await rejects(() => stripe.verifyWebhook(liveRaw, new Headers({ "stripe-signature": signTimestamped(liveRaw, WHSEC, NOW) })), "LIVE_MODE_FORBIDDEN");
  await rejects(() => stripe.verifyWebhook(raw, new Headers({ "stripe-signature": signTimestamped(raw, WHSEC, NOW - 1000) })), "STALE_SIGNATURE");
  await rejects(() => stripe.verifyWebhook(raw, new Headers()), "INVALID_SIGNATURE");
  const refund = await stripe.normalizeEvent({ ...verified, eventType: "charge.refunded" });
  assert.deepEqual(refund, { kind: "ignore", reason: "AUDIT_ONLY" });
});

// ----------------------------------------------------------------------------- Apple / Google
await check("Apple: stavy notifikácií", () => {
  const base = { notificationUUID: "u", signedDate: NOW * 1000, transaction: { originalTransactionId: "1", productId: "p", purchaseDate: NOW * 1000, expiresDate: (NOW + 86400) * 1000, appAccountToken: "tok" } };
  const status = (type: string) => {
    const n = normalizeAppleNotification({ ...base, notificationType: type });
    return n.kind === "state" ? n.state.status : n.reason;
  };
  assert.equal(status("SUBSCRIBED"), "active");
  assert.equal(status("DID_RENEW"), "active");
  assert.equal(status("DID_FAIL_TO_RENEW"), "past_due");
  assert.equal(status("EXPIRED"), "expired");
  assert.equal(status("REFUND"), "canceled");
  assert.equal(status("TEST"), "AUDIT_ONLY");
});
await check("Google: stavy subscriptionsv2", () => {
  const future = "2099-01-01T00:00:00.000Z";
  assert.deepEqual(mapGoogleState("SUBSCRIPTION_STATE_CANCELED", future, "2026-10-08T00:00:00Z"), { status: "active", cancelAtPeriodEnd: true });
  assert.equal(mapGoogleState("SUBSCRIPTION_STATE_ON_HOLD", future, "x")?.status, "unpaid");
  assert.equal(mapGoogleState("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", future, "x")?.status, "past_due");
  assert.equal(mapGoogleState("SUBSCRIPTION_STATE_UNKNOWN", future, "x"), null);
});

// ----------------------------------------------------------------------------- provider contract
await check("provider contract: všetci implementujú rozhranie; Apple/Google overenie = NOT_CONFIGURED", async () => {
  const providers: BillingProvider[] = [
    stripeWithFetch({}),
    new FakeBillingProvider("x".repeat(20)),
    new AppleAppStoreProvider(),
    new GooglePlayProvider(),
  ];
  for (const p of providers) {
    for (const m of ["createCheckout", "getSubscription", "cancelSubscription", "resumeSubscription", "changePlan", "createPortalSession", "verifyWebhook", "normalizeEvent"] as const) {
      assert.equal(typeof p[m], "function", `${p.id}.${m}`);
    }
    assert.equal(p.environment, "test");
  }
  await rejects(() => new AppleAppStoreProvider().verifyWebhook(), "NOT_CONFIGURED");
  await rejects(() => new GooglePlayProvider().verifyWebhook(), "NOT_CONFIGURED");
  await rejects(() => new AppleAppStoreProvider().cancelSubscription(), "UNSUPPORTED_OPERATION");
  await rejects(() => new FakeBillingProvider("short").createCheckout({ checkoutId: "c", providerPriceId: "p", providerCustomerId: null, successUrl: "", cancelUrl: "" }), "NOT_CONFIGURED");
});

// ----------------------------------------------------------------------------- pipeline (mock DB)
await check("pipeline: zlý podpis → 400 bez zápisu; normalizácia zlyhá → 500 retry + event 'failed'", async () => {
  const calls: string[] = [];
  const mockDb: BillingDb = {
    rpc: async (fn) => {
      calls.push(fn);
      if (fn === "esblu_billing_record_event") return { data: { event_id: "e1", duplicate: false }, error: null };
      return { data: null, error: null };
    },
  };
  const stripe = stripeWithFetch({}); // refetch → 404 → PROVIDER_ERROR
  const raw = JSON.stringify({ id: "evt_2", object: "event", type: "invoice.paid", created: NOW, livemode: false, data: { object: { subscription: "sub_x" } } });
  const bad = await processWebhook(stripe, raw, new Headers({ "stripe-signature": "t=1,v1=00" }), mockDb);
  assert.equal(bad.httpStatus, 400);
  assert.deepEqual(calls, []);
  const retry = await processWebhook(stripe, raw, new Headers({ "stripe-signature": signTimestamped(raw, WHSEC, NOW) }), mockDb);
  assert.equal(retry.httpStatus, 500);
  assert.deepEqual(calls, ["esblu_billing_record_event", "esblu_billing_close_event"]);
});

// ----------------------------------------------------------------------------- config guards
await check("config: production = vždy off; default off; return origin iba https", () => {
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "stripe_test" }), "off");
  assert.equal(getBillingServerMode({}), "off");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "preview", ESBLU_BILLING_MODE: "fake" }), "fake");
  assert.equal(getBillingServerMode({ ESBLU_BILLING_MODE: "stripe_live" }), "off");
  assert.equal(webProviderForMode("stripe_test"), "stripe");
  assert.equal(billingReturnOrigin({ ESBLU_BILLING_RETURN_ORIGIN: "http://evil.example" }), null);
  assert.equal(billingReturnOrigin({ ESBLU_BILLING_RETURN_ORIGIN: "https://staging.esblu.example/path" }), "https://staging.esblu.example");
});

// ----------------------------------------------------------------------------- UI model
await check("UI: platobný kanál podľa platformy a roly", () => {
  assert.equal(purchaseChannel("web", { canManage: true }), "web_checkout");
  assert.equal(purchaseChannel("web", { canManage: false }), "none");
  assert.equal(purchaseChannel("android", { canManage: true }), "web_info_text");
  assert.equal(purchaseChannel("ios", { canManage: true }), "none");
});
await check("UI: ?checkout=success bez serverového potvrdenia nikdy nie je 'confirmed'", () => {
  assert.equal(interpretCheckoutReturn({ checkout: "success" }, { checkoutStatus: null, subscription: null }), "unknown");
  assert.equal(interpretCheckoutReturn({ checkout: "success" }, { checkoutStatus: "open", subscription: { status: "none" } }), "pending");
  assert.equal(interpretCheckoutReturn({ checkout: "success" }, { checkoutStatus: "completed", subscription: { status: "incomplete" } }), "pending");
  assert.equal(interpretCheckoutReturn({}, { checkoutStatus: "completed", subscription: { status: "active" } }), "confirmed");
  assert.equal(interpretCheckoutReturn({ checkout: "success" }, { checkoutStatus: "rejected", subscription: { status: "active" } }), "failed");
});
await check("UI: neplatná odpoveď servera → null (fail closed); checkout iba bez aktívneho predplatného", () => {
  assert.equal(parseSubscriptionView({ status: "super_active" }), null);
  assert.equal(parseSubscriptionView(null), null);
  const v = parseSubscriptionView({ status: "active", can_manage: true, plan_entitlements: [{ key: "voice", limit: null }] })!;
  assert.equal(v.planEntitlements[0].key, "voice");
  assert.equal(canStartCheckout(v), false);
  assert.equal(canStartCheckout({ ...v, status: "expired" }), true);
  assert.equal(canStartCheckout({ ...v, status: "expired", canManage: false }), false);
});

console.log(`\nsubscriptions: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
