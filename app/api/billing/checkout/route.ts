import { billingReturnOrigin } from "@/lib/billing/config";
import { authorizeBillingCaller, billingErrorResponse, getWebBillingProvider } from "@/lib/billing/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/checkout   { planCode, interval }
//
// Klient posiela IBA kód plánu a interval. Rolu (owner / admin+billing.manage),
// firmu, povolenie plánu, provider, prostredie a provider price ID určí
// esblu_billing_create_checkout_intent v DB. Price/product ID z prehliadača sa
// nikdy nečíta. Návratové URL skladá server z ESBLU_BILLING_RETURN_ORIGIN.
// Návrat s ?checkout=… NIE JE dôkaz platby — UI čaká na webhook (GET
// /api/billing/checkout/[id]).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_CODE = /^[a-z][a-z0-9_]{1,40}$/;

export async function POST(req: Request) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const planCode = typeof body?.planCode === "string" ? body.planCode : "";
  const interval = body?.interval === "month" || body?.interval === "year" ? body.interval : null;
  if (!PLAN_CODE.test(planCode) || !interval) {
    return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 400 });
  }

  const origin = billingReturnOrigin();
  if (!origin) return Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 503 });

  const intent = await who.db.rpc("esblu_billing_create_checkout_intent", { p_plan_code: planCode, p_interval: interval });
  if (intent.error || !intent.data) return billingErrorResponse(intent.error);
  const data = intent.data as { checkout_id: string; provider: string; provider_price_id: string; provider_customer_id: string | null };

  const provider = getWebBillingProvider(data.provider);
  if (!provider) return Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 503 });

  const returnBase = `${origin}/nastavenia/predplatne?checkout_id=${encodeURIComponent(data.checkout_id)}`;
  try {
    const session = await provider.createCheckout({
      checkoutId: data.checkout_id,
      providerPriceId: data.provider_price_id,
      providerCustomerId: data.provider_customer_id,
      successUrl: `${returnBase}&checkout=returned`,
      cancelUrl: `${returnBase}&checkout=canceled`,
    });
    const attach = await getSupabaseAdmin().rpc("esblu_billing_attach_checkout_session", {
      p_checkout_id: data.checkout_id,
      p_provider_session_id: session.providerSessionId,
    });
    if (attach.error) return billingErrorResponse(attach.error);
    return Response.json({ success: true, checkoutId: data.checkout_id, url: session.url });
  } catch {
    return Response.json({ success: false, code: "ESBLU_BILLING_PROVIDER_ERROR" }, { status: 502 });
  }
}
