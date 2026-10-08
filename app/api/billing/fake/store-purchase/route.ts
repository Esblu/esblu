import { authorizeBillingCaller, billingErrorResponse } from "@/lib/billing/server";
import { fakeApplePurchase, fakeGooglePurchase, fakeStoreToken } from "@/lib/billing/stores/fake-stores";
import { appleBundleId, fakeStoreSecret, getStoreMode } from "@/lib/billing/stores/store-config";

// -----------------------------------------------------------------------------
// POST /api/billing/fake/store-purchase — STAGING ONLY (ESBLU_BILLING_STORE_MODE=fake).
// Emuluje to, čo by na zariadení vrátil obchod, keď natívny StoreKit /
// Play Billing plugin ešte nie je v buildoch:
//   { action: "apple_purchase", productId, accountToken, interval }      → { signedTransaction }
//   { action: "google_purchase", productId, basePlanId, accountToken, oldPurchaseToken? } → { purchaseToken }
//   { action: "apple_external_token" | "google_external_token" }         → { token }
// Výsledok NIE JE potvrdenie: klient ho musí poslať na /api/billing/mobile/confirm
// (alebo pri Stripe kanáloch do purchase-intent) a server ho overí.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT = /^[A-Za-z0-9_.]{3,120}$/;

export async function POST(req: Request) {
  if (getStoreMode() !== "fake") return new Response(null, { status: 404 });
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const access = await who.db.rpc("esblu_billing_authorize_manage");
  if (access.error) return billingErrorResponse(access.error);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const secret = fakeStoreSecret();
  const action = body?.action;
  const productId = typeof body?.productId === "string" && PRODUCT.test(body.productId) ? body.productId : null;
  const accountToken = typeof body?.accountToken === "string" && UUID_RE.test(body.accountToken) ? body.accountToken : null;

  if (action === "apple_external_token") return Response.json({ success: true, token: fakeStoreToken("apple") });
  if (action === "google_external_token") return Response.json({ success: true, token: fakeStoreToken("google") });
  if (action === "apple_purchase" && productId && accountToken) {
    const interval = productId.includes("year") ? "year" : "month";
    const result = fakeApplePurchase(secret, { productId, appAccountToken: accountToken, interval, bundleId: appleBundleId() });
    return Response.json({ success: true, signedTransaction: result.signedTransaction });
  }
  const basePlanId = typeof body?.basePlanId === "string" && PRODUCT.test(body.basePlanId) ? body.basePlanId : null;
  if (action === "google_purchase" && productId && basePlanId && accountToken) {
    const oldToken = typeof body?.oldPurchaseToken === "string" ? body.oldPurchaseToken : null;
    const result = fakeGooglePurchase(secret, { productId, basePlanId, obfuscatedAccountId: accountToken, linkedPurchaseToken: oldToken });
    return Response.json({ success: true, purchaseToken: result.purchaseToken });
  }
  return Response.json({ success: false }, { status: 400 });
}
