import { billingReturnOrigin } from "@/lib/billing/config";
import { authorizeBillingCaller, billingErrorResponse, getWebBillingProvider } from "@/lib/billing/server";
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

  const provider = getWebBillingProvider(data.provider);
  const origin = billingReturnOrigin();
  if (!provider || !origin) return Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 503 });
  // Návrat na https URL — na mobile ju zachytí App Link / Universal Link (deep-link-resolve).
  const returnBase = `${origin}/nastavenia/predplatne?checkout_id=${encodeURIComponent(data.checkout_id)}`;
  try {
    const session = await provider.createCheckout({
      checkoutId: data.checkout_id,
      providerPriceId: data.provider_price_id,
      providerCustomerId: data.provider_customer_id,
      mobileApp: platform !== "web",
      successUrl: `${returnBase}&checkout=returned`,
      cancelUrl: `${returnBase}&checkout=canceled`,
    });
    const attach = await getSupabaseAdmin().rpc("esblu_billing_attach_checkout_session", {
      p_checkout_id: data.checkout_id,
      p_provider_session_id: session.providerSessionId,
    });
    if (attach.error) return billingErrorResponse(attach.error);
    return Response.json({ success: true, kind: "redirect", checkoutId: data.checkout_id, url: session.url });
  } catch {
    return Response.json({ success: false, code: "ESBLU_BILLING_PROVIDER_ERROR" }, { status: 502 });
  }
}
