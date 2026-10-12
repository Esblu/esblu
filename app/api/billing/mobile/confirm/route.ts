import { applyVerifiedStorePurchase } from "@/lib/billing/pipeline";
import { authorizeBillingCaller, billingErrorResponse } from "@/lib/billing/server";
import { verifyAppleClientPurchase, verifyGoogleClientPurchase } from "@/lib/billing/stores/store-purchase";
import { appleBundleId, getAppleVerifier, getGooglePlayApi } from "@/lib/billing/stores/store-config";
import { BillingProviderError } from "@/lib/billing/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/mobile/confirm
//   Apple:  { provider: "apple",  checkoutId?, signedTransaction }   (StoreKit 2 jwsRepresentation)
//   Google: { provider: "google", checkoutId?, purchaseToken }       (Play Billing Purchase)
//
// Server overí nákup U OBCHODU (Apple JWS reťaz / Play Developer API), nie
// podľa klienta, a zapíše ho tou istou pipeline ako webhooky → kanonický
// stav → nároky. checkoutId (náš zámer) musí patriť firme volajúceho.
// Bez checkoutId = obnova nákupov (restore) — firma sa určí z account tokenu.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const provider = body?.provider === "apple" || body?.provider === "google" ? body.provider : null;
  const checkoutId = typeof body?.checkoutId === "string" && UUID_RE.test(body.checkoutId) ? body.checkoutId : null;
  if (!provider) return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 400 });

  // Rola + vlastníctvo zámeru (cudzí zámer → found:false).
  if (checkoutId) {
    const intent = await who.db.rpc("esblu_billing_my_intent", { p_checkout_id: checkoutId });
    if (intent.error) return billingErrorResponse(intent.error);
    const row = intent.data as { found?: boolean; provider?: string } | null;
    if (!row?.found || row.provider !== provider) return Response.json({ success: false, code: "ESBLU_BILLING_INTENT_NOT_FOUND" }, { status: 404 });
  } else {
    const access = await who.db.rpc("esblu_billing_authorize_manage");
    if (access.error) return billingErrorResponse(access.error);
  }

  try {
    let verified;
    if (provider === "apple") {
      const verifier = getAppleVerifier();
      if (!verifier) return Response.json({ success: false, code: "ESBLU_BILLING_STORE_NOT_CONFIGURED" }, { status: 503 });
      const jws = typeof body?.signedTransaction === "string" ? body.signedTransaction : "";
      verified = await verifyAppleClientPurchase(verifier, jws, { bundleId: appleBundleId(), environment: "test" });
    } else {
      const api = getGooglePlayApi();
      if (!api) return Response.json({ success: false, code: "ESBLU_BILLING_STORE_NOT_CONFIGURED" }, { status: 503 });
      const token = typeof body?.purchaseToken === "string" ? body.purchaseToken : "";
      verified = await verifyGoogleClientPurchase(api, token, { environment: "test" });
    }
    const state = checkoutId ? { ...verified.state, checkout_ref: checkoutId } : verified.state;
    const result = await applyVerifiedStorePurchase(getSupabaseAdmin(), { id: provider, environment: "test" }, verified.eventId, state, verified.payloadSha256);
    if (result.outcome === "retry") return Response.json({ success: false, code: result.code }, { status: 500 });
    if (verified.acknowledge && (result.outcome === "applied" || result.outcome === "duplicate")) {
      await getGooglePlayApi()?.acknowledge(verified.acknowledge.productId, verified.acknowledge.purchaseToken);
    }
    const ok = result.outcome === "applied" || result.outcome === "duplicate" || result.outcome === "stale";
    return Response.json({ success: ok, outcome: result.outcome, code: result.code }, { status: ok ? 200 : 409 });
  } catch (error) {
    const code = error instanceof BillingProviderError ? `ESBLU_BILLING_${error.code}` : "ESBLU_BILLING_STORE_ERROR";
    return Response.json({ success: false, code }, { status: error instanceof BillingProviderError && error.code !== "PROVIDER_ERROR" ? 400 : 502 });
  }
}
