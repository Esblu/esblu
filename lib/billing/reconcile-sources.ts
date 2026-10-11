// =============================================================================
// Reconciliation zdroje — autoritatívny stav u providera, bez nových
// identifikátorov: iba API, ktoré adaptéry už používajú (Stripe/fake
// getSubscription, Play subscriptionsv2.get, App Store Get All Subscription
// Statuses + overenie JWS). Výstup = NormalizedSubscriptionState rovnakého
// tvaru ako webhook → rovnaká DB cesta.
// =============================================================================

import { normalizeGoogleSubscription } from "@/lib/billing/providers/stores";
import type { ReconcileCandidate, ReconcileSource } from "@/lib/billing/reconciliation";
import type { AppleSignedDataVerifier } from "@/lib/billing/stores/apple-jws";
import type { AppleStoreApi, GooglePlayApi } from "@/lib/billing/stores/store-apis";
import { BillingProviderError, type BillingProvider, type CanonicalStatus, type NormalizedSubscriptionState } from "@/lib/billing/types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const isoFromMillis = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : null;

/** Stripe / fake: BillingProvider.getSubscription (Stripe: GET /v1/subscriptions/{id}). */
export function providerReconcileSource(provider: BillingProvider): ReconcileSource {
  return {
    provider: provider.id,
    fetchState: (c: ReconcileCandidate) =>
      provider.getSubscription({ providerSubscriptionId: c.provider_subscription_id, providerCustomerId: c.provider_customer_id }),
  };
}

/** Google Play: purchases.subscriptionsv2.get(purchaseToken). */
export function googleReconcileSource(api: GooglePlayApi, now: () => Date = () => new Date()): ReconcileSource {
  return {
    provider: "google",
    async fetchState(c) {
      const resource = await api.getSubscriptionV2(c.provider_subscription_id);
      const result = normalizeGoogleSubscription({ purchaseToken: c.provider_subscription_id, eventTimeMillis: now().getTime(), resource });
      return result.kind === "state" ? result.state : null;
    },
  };
}

/**
 * App Store Server API „Get All Subscription Statuses":
 *   status 1 active, 2 expired, 3 billing retry, 4 billing grace period, 5 revoked.
 * Transakcia/renewal sú JWS — overia sa tým istým verifierom ako notifikácie.
 */
export function appleStatusCodeToCanonical(code: unknown): CanonicalStatus | null {
  switch (code) {
    case 1:
      return "active";
    case 2:
      return "expired";
    case 3:
      return "account_hold";
    case 4:
      return "grace_period";
    case 5:
      return "revoked";
    default:
      return null;
  }
}

export function appleReconcileSource(api: AppleStoreApi, verifier: AppleSignedDataVerifier, now: () => Date = () => new Date()): ReconcileSource {
  return {
    provider: "apple",
    async fetchState(c): Promise<NormalizedSubscriptionState | null> {
      const body = await api.getAllSubscriptionStatuses(c.provider_subscription_id);
      const groups = Array.isArray(body.data) ? (body.data as unknown[]) : [];
      for (const group of groups) {
        const last = isObj(group) && Array.isArray(group.lastTransactions) ? (group.lastTransactions as unknown[]) : [];
        for (const entry of last) {
          if (!isObj(entry) || str(entry.originalTransactionId) !== c.provider_subscription_id) continue;
          const status = appleStatusCodeToCanonical(entry.status);
          const signedTx = str(entry.signedTransactionInfo);
          if (!status || !signedTx) throw new BillingProviderError("MALFORMED_PAYLOAD");
          const tx = await verifier.verify<Obj>(signedTx);
          const signedRenewal = str(entry.signedRenewalInfo);
          const renewal = signedRenewal ? await verifier.verify<Obj>(signedRenewal) : null;
          const productId = str(tx.productId);
          if (!productId) throw new BillingProviderError("MALFORMED_PAYLOAD");
          const stateAt = now().toISOString();
          const ended = status === "expired" || status === "revoked";
          return {
            provider_subscription_id: c.provider_subscription_id,
            provider_customer_id: null,
            provider_price_id: productId,
            status,
            current_period_start: isoFromMillis(tx.purchaseDate),
            current_period_end: isoFromMillis(tx.expiresDate),
            cancel_at_period_end: isObj(renewal) && renewal.autoRenewStatus === 0,
            canceled_at: status === "revoked" ? isoFromMillis(tx.revocationDate) ?? stateAt : null,
            ended_at: ended ? isoFromMillis(tx.revocationDate) ?? stateAt : null,
            grace_until: status === "grace_period" && isObj(renewal) ? isoFromMillis(renewal.gracePeriodExpiresDate) : null,
            trial_start: null,
            trial_end: null,
            checkout_ref: null,
            account_token: str(tx.appAccountToken),
            state_at: stateAt,
          };
        }
      }
      return null;
    },
  };
}
