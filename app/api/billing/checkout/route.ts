import { billingReturnOrigin } from "@/lib/billing/config";
import { authorizeBillingCaller, billingErrorResponse, getWebBillingProvider } from "@/lib/billing/server";
import { startWebCheckout, type WebIntentData } from "@/lib/billing/web-checkout";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/checkout   { planCode, interval }
//
// Klient posiela IBA kód plánu a interval. Rolu (IBA owner aktívnej firmy),
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
  const data = intent.data as WebIntentData;

  const provider = getWebBillingProvider(data.provider);
  if (!provider) return Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 503 });

  // Súbežný / opakovaný pokus dostane ten istý zámer → tú istú reláciu (lib/billing/web-checkout.ts).
  const result = await startWebCheckout({
    provider,
    intent: data,
    origin,
    attach: async (checkoutId, sessionId) =>
      getSupabaseAdmin().rpc("esblu_billing_attach_checkout_session", { p_checkout_id: checkoutId, p_provider_session_id: sessionId }),
  });
  if (!result.ok) {
    if (result.code === "ESBLU_BILLING_CHECKOUT_STATE") return billingErrorResponse(result.error as { message?: string } | null);
    return Response.json({ success: false, code: result.code }, { status: 502 });
  }
  return Response.json({ success: true, checkoutId: result.checkoutId, url: result.url, reused: result.reused });
}
