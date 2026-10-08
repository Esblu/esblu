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

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleJwsVerifier, encodeOid, sha256Fingerprint } from "@/lib/billing/stores/apple-jws";
import { appleApiToken, signJwt, verifyGoogleOidcToken } from "@/lib/billing/stores/jwt";
import { AppleStoreServerApi, GooglePlayDeveloperApi } from "@/lib/billing/stores/store-apis";
import { appleExternalPurchaseReport, googleExternalTransactionBody, googleRefundBody, StoreReportError, type StoreReportRow } from "@/lib/billing/stores/store-reporting";
import { getStoreMode } from "@/lib/billing/stores/store-config";
import { parsePurchaseOptions, plansFor, purchaseActions } from "@/lib/billing/client-model";
import { stripeChargeFromInvoice } from "@/lib/billing/providers/stripe";
import { resolveEsbluDeepLink } from "../mobile/app/deep-link-resolve.ts";

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
  assert.equal(purchaseChannel("android", { canManage: true }), "mobile_purchase");
  assert.equal(purchaseChannel("ios", { canManage: true }), "mobile_purchase");
  assert.equal(purchaseChannel("ios", { canManage: false }), "none");
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

// ----------------------------------------------------------------------------- MOBILE PURCHASE (unit)

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Testovacia EC P-256 reťaz (root → intermediate → leaf) cez openssl; voliteľne s Apple OID. */
function makeChain(withAppleOids: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "esblu-apple-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "ext.cnf"), [
    "[ca]", "basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign",
    ...(withAppleOids ? ["1.2.840.113635.100.6.2.1=ASN1:NULL"] : []),
    "[leaf]", "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature",
    ...(withAppleOids ? ["1.2.840.113635.100.6.11.1=ASN1:NULL"] : []),
  ].join("\n"));
  for (const n of ["root", "int", "leaf"]) run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${n}.key`);
  run("req", "-x509", "-new", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "30", "-out", "root.pem", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  run("req", "-new", "-key", "int.key", "-subj", "/CN=Test Int", "-out", "int.csr");
  run("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "30", "-extfile", "ext.cnf", "-extensions", "ca", "-out", "int.pem");
  run("req", "-new", "-key", "leaf.key", "-subj", "/CN=Test Leaf", "-out", "leaf.csr");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-days", "30", "-extfile", "ext.cnf", "-extensions", "leaf", "-out", "leaf.pem");
  const der = (f: string) => new X509Certificate(readFileSync(join(dir, f))).raw.toString("base64");
  return { x5c: [der("leaf.pem"), der("int.pem"), der("root.pem")], leafKey: readFileSync(join(dir, "leaf.key"), "utf8"), root: new X509Certificate(readFileSync(join(dir, "root.pem"))) };
}
function signAppleJws(payload: Record<string, unknown>, chain: ReturnType<typeof makeChain>, alg = "ES256") {
  return signJwt({ alg, x5c: chain.x5c }, payload, chain.leafKey);
}

await check("Apple JWS: platná reťaz + Apple OID + ES256 → payload", async () => {
  const chain = makeChain(true);
  const verifier = new AppleJwsVerifier({ trustedRootSha256: [sha256Fingerprint(chain.root)] });
  const payload = await verifier.verify(signAppleJws({ transactionId: "1", bundleId: "com.esblu.app" }, chain));
  assert.equal(payload.transactionId, "1");
});
await check("Apple JWS: nedôveryhodný root / zmenený payload / chýbajúce Apple OID / bez rootu → odmietnuté", async () => {
  const chain = makeChain(false);
  const other = makeChain(true);
  const jws = signAppleJws({ transactionId: "1" }, chain);
  await rejects(() => new AppleJwsVerifier({ trustedRootSha256: [sha256Fingerprint(other.root)] }).verify(jws), "INVALID_SIGNATURE");
  await rejects(() => new AppleJwsVerifier({ trustedRootSha256: [sha256Fingerprint(chain.root)] }).verify(jws), "INVALID_SIGNATURE"); // OID chýba
  const lax = new AppleJwsVerifier({ trustedRootSha256: [sha256Fingerprint(chain.root)], requireAppleOids: false });
  assert.equal((await lax.verify(jws)).transactionId, "1");
  const [h, , s] = jws.split(".");
  await rejects(() => lax.verify(`${h}.${b64url(JSON.stringify({ transactionId: "2" }))}.${s}`), "INVALID_SIGNATURE");
  await rejects(() => new AppleJwsVerifier({ trustedRootSha256: [] }).verify(jws), "NOT_CONFIGURED");
  // podvrhnutá reťaz: leaf podpísaný cudzím kľúčom s pravým rootom v x5c
  const mixed = signJwt({ alg: "ES256", x5c: [other.x5c[0], chain.x5c[1], chain.x5c[2]] }, { transactionId: "3" }, other.leafKey);
  await rejects(() => lax.verify(mixed), "INVALID_SIGNATURE");
  assert.equal(encodeOid("1.2.840.113635.100.6.11.1").toString("hex"), "060a2a864886f76364060b01");
});

await check("Google OIDC (Pub/Sub push): RS256 + iss/aud/email/exp", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "k1" };
  const now = 1_800_000_000;
  const claims = { iss: "https://accounts.google.com", aud: "https://staging/api/billing/webhooks/google", email: "rtdn@proj.iam.gserviceaccount.com", email_verified: true, exp: now + 600 };
  const token = signJwt({ alg: "RS256", kid: "k1" }, claims, pem);
  const expect = { audience: claims.aud, email: claims.email, jwks: { keys: [jwk] }, nowSeconds: now };
  assert.equal(verifyGoogleOidcToken(token, expect).email, claims.email);
  assert.throws(() => verifyGoogleOidcToken(token, { ...expect, audience: "x" }), /INVALID_SIGNATURE/);
  assert.throws(() => verifyGoogleOidcToken(token, { ...expect, nowSeconds: now + 3600 }), /STALE_SIGNATURE/);
  assert.throws(() => verifyGoogleOidcToken(signJwt({ alg: "RS256", kid: "k2" }, claims, pem), expect), /INVALID_SIGNATURE/);
  assert.throws(() => verifyGoogleOidcToken(signJwt({ alg: "RS256", kid: "k1" }, { ...claims, email_verified: false }, pem), expect), /INVALID_SIGNATURE/);
});

await check("Google Play API: service-account JWT grant, subscriptionsv2 / acknowledge / externalTransactions cesty", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.test" }));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  const api = new GooglePlayDeveloperApi("com.esblu.app", { client_email: "sa@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, fetchImpl);
  await api.getSubscriptionV2("tok");
  await api.acknowledge("esblu_test_pro", "tok");
  await api.createExternalTransaction("esblu_abc", { a: 1 });
  const grant = new URLSearchParams(String(calls[0].init.body));
  assert.equal(grant.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const claims = JSON.parse(Buffer.from(grant.get("assertion")!.split(".")[1], "base64url").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
  assert.ok(calls[1].url.endsWith("/applications/com.esblu.app/purchases/subscriptionsv2/tokens/tok"));
  assert.ok(calls[2].url.endsWith("/purchases/subscriptions/esblu_test_pro/tokens/tok:acknowledge"));
  assert.ok(calls[3].url.endsWith("/externalTransactions?externalTransactionId=esblu_abc"));
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer ya29.test");
});
await check("Apple API: ES256 token (kid, aud, bid), iba sandbox host; live zakázané", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = appleApiToken({ keyId: "KID123", issuerId: "iss-uuid", bundleId: "com.esblu.app", privateKeyPem: pem }, 1_800_000_000);
  const [h, p, s] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).kid, "KID123");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(claims.bid, "com.esblu.app");
  assert.ok(cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey(publicKey.export({ type: "spki", format: "pem" })), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.throws(() => new AppleStoreServerApi({ keyId: "k", issuerId: "i", bundleId: "b", privateKeyPem: pem }, "live"), /LIVE_MODE_FORBIDDEN/);
});

const baseRow: StoreReportRow = {
  id: "r1", store: "google", report_kind: "google_initial", external_transaction_id: "esblu_0123456789abcdef0123456789abcdef",
  initial_external_transaction_id: null, store_token: "ext-token-1", amount_pre_tax_minor: 990, tax_minor: 228, currency: "EUR",
  tax_country: "SK", transaction_at: "2026-10-08T10:00:00.000Z", period_start: "2026-10-08T10:00:00.000Z", period_end: "2026-11-08T10:00:00.000Z", product_id: "test_pro",
};
await check("reporting telá: Google initial/renewal/refund (priceMicros), Apple LINE_ITEM (milli, ISO-3), chýbajúce dáta = chyba", () => {
  const initial = googleExternalTransactionBody(baseRow);
  assert.deepEqual(initial.originalPreTaxAmount, { currency: "EUR", priceMicros: "9900000" });
  assert.deepEqual(initial.originalTaxAmount, { currency: "EUR", priceMicros: "2280000" });
  assert.deepEqual(initial.recurringTransaction, { externalTransactionToken: "ext-token-1", externalSubscription: { subscriptionType: "RECURRING" } });
  assert.deepEqual(initial.userTaxAddress, { regionCode: "SK" });
  const renewal = googleExternalTransactionBody({ ...baseRow, report_kind: "google_renewal", initial_external_transaction_id: "esblu_first" });
  assert.equal((renewal.recurringTransaction as Record<string, unknown>).initialExternalTransactionId, "esblu_first");
  assert.ok("partialRefund" in googleRefundBody({ ...baseRow, report_kind: "google_refund" }));
  assert.throws(() => googleExternalTransactionBody({ ...baseRow, tax_country: null }), StoreReportError);
  const appleToken = Buffer.from(JSON.stringify({ externalPurchaseId: "SANDBOX_1" })).toString("base64");
  const report = appleExternalPurchaseReport({ ...baseRow, store: "apple", report_kind: "apple_subscription_start", external_transaction_id: "0123456789abcdef0123456789abcdef", store_token: appleToken });
  assert.equal(report.requestIdentifier, "01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(report.externalPurchaseId, "SANDBOX_1");
  const item = (report.lineItems as Record<string, unknown>[])[0];
  assert.equal(item.amountTaxExclusive, 9900);
  assert.equal(item.amountTaxInclusive, 12180);
  assert.equal(item.taxCountry, "SVK");
  assert.equal(item.subscriptionDaysOfPaidService, 31);
  assert.throws(() => appleExternalPurchaseReport({ ...baseRow, store: "apple", report_kind: "apple_refund", store_token: appleToken }), /APPLE_REFUND_SCHEMA_UNVERIFIED/);
  assert.throws(() => appleExternalPurchaseReport({ ...baseRow, store: "apple", report_kind: "apple_subscription_start", store_token: "not-base64-json" }), /APPLE_TOKEN_UNDECODABLE/);
});

await check("store mode: production vždy off; default off", () => {
  assert.equal(getStoreMode({ VERCEL_ENV: "production", ESBLU_BILLING_STORE_MODE: "sandbox" }), "off");
  assert.equal(getStoreMode({}), "off");
  assert.equal(getStoreMode({ ESBLU_BILLING_STORE_MODE: "fake" }), "fake");
  assert.equal(getStoreMode({ ESBLU_BILLING_STORE_MODE: "live" }), "off");
});

const optionsJson = (platform: string, methods: string[]) => ({
  platform, storefront: "SK", can_manage: true,
  methods: methods.map((m) => ({ method: m, provider: m.startsWith("apple_iap") ? "apple" : m === "google_play" ? "google" : "fake", reporting: "none",
    plans: [{ plan_code: "test_pro", intervals: [{ interval: "month", store_product_id: m === "apple_iap" ? "com.esblu.test.pro.monthly" : null }], entitlements: [] }] })),
});
await check("mobilné UI: Android EEA = 1 tlačidlo s Google choice screen; iOS EÚ = IAP + karta (rovnocenné); view-only", () => {
  const android = parsePurchaseOptions(optionsJson("android", ["google_play", "google_choice_developer"]))!;
  assert.deepEqual(purchaseActions(android), [{ kind: "google", method: "google_play", billingChoice: true }]);
  const androidUs = parsePurchaseOptions(optionsJson("android", ["google_play"]))!;
  assert.deepEqual(purchaseActions(androidUs), [{ kind: "google", method: "google_play", billingChoice: false }]);
  const ios = parsePurchaseOptions(optionsJson("ios", ["apple_iap", "apple_eu_link_checkout"]))!;
  assert.deepEqual(purchaseActions(ios).map((a) => a.kind), ["apple_iap", "apple_external"]);
  assert.equal(plansFor(ios, "apple_iap", "month")[0].storeProductId, "com.esblu.test.pro.monthly");
  assert.equal(plansFor(ios, "apple_iap", "year").length, 0);
  const none = parsePurchaseOptions({ platform: "ios", methods: [], can_manage: true })!;
  assert.equal(none.viewOnly, true);
  assert.equal(parsePurchaseOptions({ platform: "ios", methods: [{ method: "free_money" }] })!.methods.length, 0, "neznáma metóda sa ignoruje");
});

await check("Stripe: invoice.paid → platba pre reporting (bez dane / daň / krajina)", () => {
  const charge = stripeChargeFromInvoice({ object: "invoice", id: "in_1", total: 1218, total_excluding_tax: 990, currency: "eur", customer_address: { country: "sk" }, status_transitions: { paid_at: NOW } })!;
  assert.deepEqual(charge, { id: "in_1", kind: "purchase", amount_pre_tax_minor: 990, tax_minor: 228, currency: "EUR", at: new Date(NOW * 1000).toISOString(), tax_country: "SK" });
  assert.equal(stripeChargeFromInvoice({ object: "charge" }), null);
});
await check("Stripe: refund bez charge.invoice → invoice_payments → invoice → predplatné (charge result)", async () => {
  const stripe = stripeWithFetch({
    "/invoice_payments": { object: "list", data: [{ invoice: "in_9" }], livemode: false },
    "/invoices/in_9": { object: "invoice", id: "in_9", parent: { subscription_details: { subscription: "sub_9" } }, livemode: false },
  });
  const n = await stripe.normalizeEvent({ provider: "stripe", environment: "test", eventId: "evt_r", eventType: "charge.refunded", createdAt: "2026-10-08T00:00:00.000Z", payloadSha256: "x", data: { object: "charge", id: "ch_1", payment_intent: "pi_1", amount_refunded: 500, currency: "eur" } });
  assert.equal(n.kind, "charge");
  if (n.kind === "charge") {
    assert.equal(n.providerSubscriptionId, "sub_9");
    assert.equal(n.charge.refunded_charge_id, "in_9");
    assert.equal(n.charge.amount_pre_tax_minor, 500);
  }
});
await check("Stripe Checkout z mobilu: origin_context=mobile_app", async () => {
  const captured: Captured[] = [];
  const stripe = stripeWithFetch({ "/checkout/sessions": { id: "cs_test_m", url: "https://checkout.stripe.com/c/pay/cs_test_m", livemode: false } }, captured);
  await stripe.createCheckout({ checkoutId: "chk-m", providerPriceId: "price_x", providerCustomerId: null, mobileApp: true, successUrl: "https://s/x", cancelUrl: "https://s/y" });
  assert.equal(new URLSearchParams(String(captured[0].init.body)).get("origin_context"), "mobile_app");
});
await check("deep link návratu z checkoutu: iba UUID checkout_id + returned|canceled", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(resolveEsbluDeepLink(`https://www.esblu.com/nastavenia/predplatne?checkout_id=${id}&checkout=returned`), `/nastavenia/predplatne.html?checkout_id=${id}&checkout=returned`);
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/nastavenia/predplatne?checkout_id=<script>&checkout=success&x=1"), "/nastavenia/predplatne.html");
  assert.equal(resolveEsbluDeepLink("https://evil.example/nastavenia/predplatne?checkout_id=" + id), null);
});

console.log(`\nsubscriptions: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
