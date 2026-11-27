import { billingReturnOrigin } from "@/lib/billing/config";
import { authorizeBillingCaller, billingErrorResponse, getWebBillingProvider } from "@/lib/billing/server";
import { methodAllowedByServer, providerGateFromEnv } from "@/lib/billing/server-gates";
import { startWebCheckout } from "@/lib/billing/web-checkout";
import { checkOrderGate } from "@/lib/billing/order-gate";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/purchase-intent
//   { planCode, interval, platform, method, storefront?, mode?: "new"|"change", storeToken? }
//
// Jednotný nákupný zámer pre web, Android aj iOS. DB overí rolu, kanál
// (pravidlá platforma+storefront), plán, cenu a jedno-predplatné pravidlo.
//   - Stripe kanály (web, Apple EÚ link/in-app, Google billing choice) →
//     { kind: "redirect", url } — Stripe Checkout (origin_context=mobile_app na mobile);
//     návrat cez App Link / Universal Link na /nastavenia/predplatne.
//   - apple_iap / google_play → { kind: "store", productId, accountToken } —
//     appka spustí StoreKit / Play Billing s týmto account tokenom.
// Výsledok platby sa NIKDY neberie od klienta — iba webhook / overenie obchodu.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_CODE = /^[a-z][a-z0-9_]{1,40}$/;
const METHOD = /^[a-z_]{3,40}$/;

export async function POST(req: Request) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const planCode = typeof body?.planCode === "string" ? body.planCode : "";
  const interval = body?.interval === "month" || body?.interval === "year" ? body.interval : null;
  const platform = body?.platform === "web" || body?.platform === "android" || body?.platform === "ios" ? body.platform : null;
  const method = typeof body?.method === "string" ? body.method : "";
  const storefront = typeof body?.storefront === "string" ? body.storefront.slice(0, 3) : null;
  const mode = body?.mode === "change" ? "change" : "new";
  const storeToken = typeof body?.storeToken === "string" ? body.storeToken : null;
  if (!PLAN_CODE.test(planCode) || !interval || !platform || !METHOD.test(method)) {
    return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 400 });
  }
  // Provider kanála musí byť na tomto serveri zapojený — inak by appka spustila
  // nákup v obchode, ktorý server nevie overiť (fail closed, pred zápisom do DB).
  if (!methodAllowedByServer(method, providerGateFromEnv())) {
    return Response.json({ success: false, code: "ESBLU_BILLING_PROVIDER_NOT_CONFIGURED" }, { status: 409 });
  }
  // Predajný plán + potvrdenie objednávky + prijaté aktuálne VOP (VOP 1.3 čl. 10.4) — pred zápisom do DB.
  const gate = await checkOrderGate(who.db, { planCode, interval, orderConsent: body?.orderConsent, termsVersion: body?.termsVersion });
  if (!gate.ok) return Response.json({ success: false, code: gate.code }, { status: gate.status });

  const intent = await who.db.rpc("esblu_billing_create_purchase_intent", {
    p_plan_code: planCode,
    p_interval: interval,
    p_platform: platform,
    p_method: method,
    p_storefront: storefront,
    p_mode: mode,
    p_store_token: storeToken,
  });
  if (intent.error || !intent.data) return billingErrorResponse(intent.error);
  const data = intent.data as {
    checkout_id: string;
    provider: string;
    provider_price_id: string;
    provider_customer_id: string | null;
    account_token: string | null;
    replaces_subscription_id: string | null;
    expires_at?: string | null;
    reused?: boolean;
    environment?: string | null;
  };

  if (data.provider === "apple" || data.provider === "google") {
    // Google product ID je "<productId>:<basePlanId>" (server-side mapovanie).
    const [productId, basePlanId] = data.provider === "google" ? data.provider_price_id.split(":") : [data.provider_price_id, null];
    return Response.json({
      success: true,
      kind: "store",
      checkoutId: data.checkout_id,
      provider: data.provider,
      productId,
      basePlanId,
      accountToken: data.account_token,
      replacesSubscriptionId: data.replaces_subscription_id,
    });
  }

  const provider = getWebBillingProvider(data.provider, data.environment);
  const origin = billingReturnOrigin();
  if (!provider || !origin) return Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 503 });
  // Návrat na https URL — na mobile ju zachytí App Link / Universal Link (deep-link-resolve).
  // Súbežný / opakovaný pokus dostane ten istý zámer → tú istú reláciu (lib/billing/web-checkout.ts).
  const result = await startWebCheckout({
    provider,
    intent: data,
    origin,
    mobileApp: platform !== "web",
    termsVersion: gate.termsVersion,
    attach: async (checkoutId, sessionId) =>
      getSupabaseAdmin().rpc("esblu_billing_attach_checkout_session", { p_checkout_id: checkoutId, p_provider_session_id: sessionId }),
  });
  if (!result.ok) {
    if (result.code === "ESBLU_BILLING_CHECKOUT_STATE") return billingErrorResponse(result.error as { message?: string } | null);
    return Response.json({ success: false, code: result.code }, { status: 502 });
  }
  return Response.json({ success: true, kind: "redirect", checkoutId: result.checkoutId, url: result.url, reused: result.reused });
}
