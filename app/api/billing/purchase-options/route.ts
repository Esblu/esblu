import { authorizeBillingCaller, billingErrorResponse } from "@/lib/billing/server";
import { gatePurchaseOptions, providerGateFromEnv } from "@/lib/billing/server-gates";

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
  // S15b: LIVE nákup iba pre firmy z allowlistu — inak sa webové kanály neponúknu (DB ich aj tak odmietne).
  // Chyba kontroly = fail closed (bez webových kanálov).
  const live = await who.db.rpc("esblu_billing_my_live_purchase_allowed");
  const gate = providerGateFromEnv();
  if (live.error || live.data !== true) gate.webEnabled = false;
  // Kanál bez zapojeného providera na tomto serveri sa neponúkne (fail closed).
  return Response.json({ success: true, options: gatePurchaseOptions(data, gate) }, { headers: { "Cache-Control": "no-store" } });
}
