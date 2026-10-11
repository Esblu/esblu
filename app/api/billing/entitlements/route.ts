import { authorizeBillingCaller, billingErrorResponse } from "@/lib/billing/server";

// -----------------------------------------------------------------------------
// GET /api/billing/entitlements — vysvetliteľné nároky firmy (prečo je nárok
// aktívny, zdroj, platnosť). Rovnaký resolver ako dashboard
// (esblu_get_my_company_entitlements); referencia/provider iba MANAGE/VIEW roly.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const { data, error } = await who.db.rpc("esblu_billing_explain_my_entitlements");
  if (error) return billingErrorResponse(error);
  return Response.json({ success: true, entitlements: data }, { headers: { "Cache-Control": "no-store" } });
}
