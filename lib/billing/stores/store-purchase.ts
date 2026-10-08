// =============================================================================
// Overenie nákupu z mobilu (StoreKit 2 / Play Billing) — SERVER ONLY.
//
// Klient pošle iba to, čo mu vrátil obchod (Apple: podpísaná transakcia JWS,
// Google: purchaseToken). Server:
//   Apple  → overí JWS (reťaz k Apple rootu) + bundle ID + prostredie,
//   Google → načíta autoritatívny stav cez Play Developer API (subscriptionsv2),
// a vyrobí NORMALIZOVANÝ stav (rovnaký formát ako Stripe/webhooky). Firmu
// určí DB z appAccountToken / obfuscatedAccountId (vydal ich server).
// Klientom tvrdený plán, cena ani „success" sa nikdy nepoužijú.
// =============================================================================

import { sha256Hex } from "@/lib/billing/signature";
import { normalizeAppleNotification, normalizeGoogleSubscription } from "@/lib/billing/providers/stores";
import { BillingProviderError, type NormalizedSubscriptionState } from "@/lib/billing/types";
import type { AppleSignedDataVerifier } from "@/lib/billing/stores/apple-jws";
import type { GooglePlayApi } from "@/lib/billing/stores/store-apis";

export type VerifiedStorePurchase = {
  eventId: string;
  state: NormalizedSubscriptionState;
  payloadSha256: string;
  /** Google: potvrdiť nákup po úspešnom zápise (inak do 3 dní auto-refund). */
  acknowledge?: { productId: string; purchaseToken: string } | null;
};

export async function verifyAppleClientPurchase(
  verifier: AppleSignedDataVerifier,
  signedTransaction: string,
  expected: { bundleId: string; environment: "test" },
): Promise<VerifiedStorePurchase> {
  const tx = await verifier.verify<Record<string, unknown>>(signedTransaction);
  if (tx.bundleId !== expected.bundleId) throw new BillingProviderError("INVALID_SIGNATURE", "bundle");
  // test = Apple Sandbox / Xcode. Produkčné transakcie sa v test prostredí neprijmú.
  if (tx.environment !== "Sandbox" && tx.environment !== "Xcode") throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
  const result = normalizeAppleNotification({
    notificationType: "CLIENT_PURCHASE",
    notificationUUID: String(tx.transactionId ?? ""),
    signedDate: Number(tx.signedDate ?? Date.now()),
    transaction: tx,
    renewal: null,
  });
  if (result.kind !== "state") throw new BillingProviderError("MALFORMED_PAYLOAD");
  return {
    eventId: `client:apple:${String(tx.transactionId)}`,
    state: result.state,
    payloadSha256: sha256Hex(signedTransaction),
    acknowledge: null,
  };
}

export async function verifyGoogleClientPurchase(
  api: GooglePlayApi,
  purchaseToken: string,
  expected: { environment: "test" },
): Promise<VerifiedStorePurchase> {
  if (typeof purchaseToken !== "string" || purchaseToken.length < 10 || purchaseToken.length > 2048 || !/^[A-Za-z0-9_.:=+/-]+$/.test(purchaseToken)) {
    throw new BillingProviderError("MALFORMED_PAYLOAD");
  }
  const resource = await api.getSubscriptionV2(purchaseToken);
  // test prostredie prijíma iba testovacie nákupy (license testers).
  if (expected.environment === "test" && !resource.testPurchase) throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
  const result = normalizeGoogleSubscription({ purchaseToken, eventTimeMillis: Date.now(), resource });
  if (result.kind !== "state") throw new BillingProviderError("MALFORMED_PAYLOAD");
  const items = Array.isArray(resource.lineItems) ? (resource.lineItems as Record<string, unknown>[]) : [];
  const productId = typeof items[0]?.productId === "string" ? (items[0].productId as string) : null;
  return {
    eventId: `client:google:${sha256Hex(purchaseToken).slice(0, 40)}:${result.state.status}`,
    state: result.state,
    payloadSha256: sha256Hex(JSON.stringify(resource)),
    acknowledge:
      productId && resource.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" ? { productId, purchaseToken } : null,
  };
}
