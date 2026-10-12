import { authorizeBillingCaller, billingErrorResponse } from "@/lib/billing/server";

// -----------------------------------------------------------------------------
// GET /api/billing/subscription — kanonický stav predplatného firmy + plány.
// Rovnaká odpoveď pre web, Android aj iOS (žiadny parameter platformy).
// Firma a rola sa odvodzujú v DB z JWT; detaily obdobia/providera vidí iba
// MANAGE alebo finance.view rola.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const [subscription, plans] = await Promise.all([
    who.db.rpc("esblu_get_my_subscription"),
    who.db.rpc("esblu_billing_list_plans"),
  ]);
  if (subscription.error) return billingErrorResponse(subscription.error);
  if (plans.error) return billingErrorResponse(plans.error);
  return Response.json(
    { success: true, subscription: subscription.data, plans: plans.data },
    { headers: { "Cache-Control": "no-store" } },
  );
}
