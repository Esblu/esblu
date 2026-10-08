import { authorizeBillingCaller, billingErrorResponse } from "@/lib/billing/server";

// -----------------------------------------------------------------------------
// GET /api/billing/purchase-options?platform=web|android|ios&storefront=SK
// Kanály nákupu pre platformu + storefront obchodu (Apple Storefront /
// Play BillingConfig). Rozhodujú DÁTA v DB (billing_channel_rules), nie kód.
// Storefront je iba vstup pre ponuku: kanály s reportingom vyžadujú token,
// ktorý vydá obchod iba v oprávnenom regióne (StoreKit / Play to vynúti).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") ?? "";
  const storefront = (url.searchParams.get("storefront") ?? "").slice(0, 3);
  const { data, error } = await who.db.rpc("esblu_billing_purchase_options", { p_platform: platform, p_storefront: storefront || null });
  if (error) return billingErrorResponse(error);
  return Response.json({ success: true, options: data }, { headers: { "Cache-Control": "no-store" } });
}
