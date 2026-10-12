import { billingReturnOrigin } from "@/lib/billing/config";
import { applyProviderState } from "@/lib/billing/pipeline";
import { authorizeBillingCaller, billingErrorResponse, getWebBillingProvider } from "@/lib/billing/server";
import { sha256Hex } from "@/lib/billing/signature";
import { BillingProviderError } from "@/lib/billing/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/manage   { action: "cancel" | "resume" | "change" | "portal", planCode?, interval? }
//
// Rola sa overí v DB (esblu_billing_authorize_manage — owner alebo admin s
// permissions.billing.manage; accountant/employee 403). Provider ID a
// subscription ID sa berú z kanonického stavu firmy, nikdy z požiadavky.
// Výsledný stav providera ide rovnakou pipeline ako webhook (record → apply).
// Apple/Google predplatné sa spravuje v obchode → 409 MANAGE_IN_STORE.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_CODE = /^[a-z][a-z0-9_]{1,40}$/;

export async function POST(req: Request) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;
  if (action !== "cancel" && action !== "resume" && action !== "change" && action !== "portal") {
    return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 400 });
  }

  const auth = await who.db.rpc("esblu_billing_authorize_manage");
  if (auth.error || !auth.data) return billingErrorResponse(auth.error);
  const account = auth.data as {
    status: string;
    billing_provider: string | null;
    provider_customer_id: string | null;
    provider_subscription_id: string | null;
    billing_interval: "month" | "year" | null;
  };

  if (account.billing_provider === "apple" || account.billing_provider === "google") {
    return Response.json({ success: false, code: "ESBLU_BILLING_MANAGE_IN_STORE", store: account.billing_provider }, { status: 409 });
  }
  const provider = getWebBillingProvider(account.billing_provider);
  if (!provider) return Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 503 });

  try {
    if (action === "portal") {
      const origin = billingReturnOrigin();
      if (!origin || !account.provider_customer_id) {
        return Response.json({ success: false, code: "ESBLU_BILLING_NO_CUSTOMER" }, { status: 409 });
      }
      const portal = await provider.createPortalSession(account.provider_customer_id, `${origin}/nastavenia/predplatne`);
      return Response.json({ success: true, url: portal.url });
    }

    if (!account.provider_subscription_id || !["active", "trialing", "past_due"].includes(account.status)) {
      return Response.json({ success: false, code: "ESBLU_BILLING_NO_ACTIVE_SUBSCRIPTION" }, { status: 409 });
    }
    const ref = { providerSubscriptionId: account.provider_subscription_id, providerCustomerId: account.provider_customer_id };

    let state;
    if (action === "cancel") state = await provider.cancelSubscription(ref);
    else if (action === "resume") state = await provider.resumeSubscription(ref);
    else {
      const planCode = typeof body?.planCode === "string" ? body.planCode : "";
      const interval = body?.interval === "month" || body?.interval === "year" ? body.interval : account.billing_interval;
      if (!PLAN_CODE.test(planCode) || !interval) {
        return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 400 });
      }
      // Plán → price ID výhradne zo servera (schválené mapovanie v DB).
      const price = await getSupabaseAdmin().rpc("esblu_billing_resolve_price", {
        p_provider: provider.id,
        p_environment: provider.environment,
        p_plan_code: planCode,
        p_interval: interval,
      });
      if (price.error || typeof price.data !== "string") {
        return Response.json({ success: false, code: "ESBLU_BILLING_PLAN_NOT_PURCHASABLE" }, { status: 400 });
      }
      state = await provider.changePlan(ref, price.data);
    }

    const applied = await applyProviderState(getSupabaseAdmin(), provider, action, state, sha256Hex(JSON.stringify(state)));
    if (applied.outcome !== "applied" && applied.outcome !== "duplicate" && applied.outcome !== "stale") {
      return Response.json({ success: false, code: applied.code ?? "ESBLU_BILLING_SYNC_FAILED" }, { status: 502 });
    }
    return Response.json({ success: true });
  } catch (error) {
    const code = error instanceof BillingProviderError ? `ESBLU_BILLING_${error.code}` : "ESBLU_BILLING_PROVIDER_ERROR";
    return Response.json({ success: false, code }, { status: 502 });
  }
}
