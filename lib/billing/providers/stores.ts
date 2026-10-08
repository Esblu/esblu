// =============================================================================
// Apple App Store + Google Play — ARCHITEKTÚRA, nie aktivácia.
//
// Nákup aj zrušenie prebieha v obchode (StoreKit 2 / Play Billing Library).
// Server iba (1) overí notifikáciu, (2) načíta autoritatívny stav cez API
// obchodu, (3) normalizuje ho na kanonický stav. Firma sa páruje cez
// appAccountToken (Apple) / obfuscatedExternalAccountId (Google) — token
// vydá server (esblu_billing_issue_account_token), nie klient.
//
// STAV: verifyWebhook / API volania sú ZÁMERNE `NOT_CONFIGURED`:
//   - Apple: overenie JWS (x5c reťaz → Apple Root CA G3), bundle ID,
//     App Store Server API kľúč — vyžaduje Apple Developer Program,
//     produkty v App Store Connect a rozhodnutie o IAP (docs/subscriptions-store-compliance).
//   - Google: Pub/Sub push OIDC token + Play Developer API
//     (purchases.subscriptionsv2.get) cez service account — vyžaduje Play
//     Console produkty a rozhodnutie o Play Billing.
// Normalizačné funkcie nižšie sú čisté a otestované na fixture payloadoch.
// =============================================================================

import {
  BillingProviderError,
  type BillingProvider,
  type CanonicalStatus,
  type NormalizationResult,
  type VerifiedProviderEvent,
} from "@/lib/billing/types";

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const isoFromMillis = (value: unknown): string | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

abstract class StoreProviderBase implements BillingProvider {
  abstract readonly id: "apple" | "google";
  readonly environment = "test" as const;
  async createCheckout(): Promise<never> {
    throw new BillingProviderError("UNSUPPORTED_OPERATION", "store purchases start in the native app");
  }
  async getSubscription(): Promise<never> {
    throw new BillingProviderError("NOT_CONFIGURED");
  }
  async cancelSubscription(): Promise<never> {
    // Apple/Google: zrušenie robí používateľ v obchode; server dostane notifikáciu.
    throw new BillingProviderError("UNSUPPORTED_OPERATION", "cancel in the store");
  }
  async resumeSubscription(): Promise<never> {
    throw new BillingProviderError("UNSUPPORTED_OPERATION", "resume in the store");
  }
  async changePlan(): Promise<never> {
    throw new BillingProviderError("UNSUPPORTED_OPERATION", "change plan in the store");
  }
  async createPortalSession(): Promise<never> {
    throw new BillingProviderError("UNSUPPORTED_OPERATION", "manage in the store");
  }
  async verifyWebhook(): Promise<never> {
    throw new BillingProviderError("NOT_CONFIGURED");
  }
  abstract normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult>;
}

// ----------------------------------------------------------------------------- Apple
/** Dekódované (už overené) časti App Store Server Notification V2. */
export type AppleDecodedNotification = {
  notificationType: string;
  subtype?: string | null;
  notificationUUID: string;
  signedDate: number;
  transaction: Obj; // JWSTransactionDecodedPayload
  renewal?: Obj | null; // JWSRenewalInfoDecodedPayload
};

export function normalizeAppleNotification(n: AppleDecodedNotification): NormalizationResult {
  const tx = n.transaction;
  const originalTransactionId = str(tx.originalTransactionId);
  const productId = str(tx.productId);
  if (!originalTransactionId || !productId) throw new BillingProviderError("MALFORMED_PAYLOAD");
  const signedAt = isoFromMillis(n.signedDate) ?? new Date().toISOString();
  const expiresAt = isoFromMillis(tx.expiresDate);
  const autoRenewOff = isObj(n.renewal) && n.renewal.autoRenewStatus === 0;

  let status: CanonicalStatus;
  switch (n.notificationType) {
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      status = "expired";
      break;
    case "REFUND":
    case "REVOKE":
      status = "canceled";
      break;
    case "DID_FAIL_TO_RENEW":
      status = "past_due";
      break;
    case "TEST":
    case "CONSUMPTION_REQUEST":
    case "PRICE_INCREASE":
    case "REFUND_DECLINED":
    case "REFUND_REVERSED":
    case "EXTERNAL_PURCHASE_TOKEN":
      return { kind: "ignore", reason: "AUDIT_ONLY" };
    default:
      status = expiresAt && expiresAt > signedAt ? "active" : "expired";
  }

  return {
    kind: "state",
    state: {
      provider_subscription_id: originalTransactionId,
      provider_customer_id: null,
      provider_price_id: productId,
      status,
      current_period_start: isoFromMillis(tx.purchaseDate),
      current_period_end: expiresAt,
      cancel_at_period_end: autoRenewOff,
      canceled_at: status === "canceled" ? isoFromMillis(tx.revocationDate) ?? signedAt : null,
      ended_at: status === "canceled" || status === "expired" ? signedAt : null,
      trial_start: null,
      trial_end: null,
      checkout_ref: null,
      account_token: str(tx.appAccountToken),
      state_at: signedAt,
    },
  };
}

export class AppleAppStoreProvider extends StoreProviderBase {
  readonly id = "apple" as const;
  async normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    return normalizeAppleNotification(event.data as AppleDecodedNotification);
  }
}

// ----------------------------------------------------------------------------- Google
/** Výsledok purchases.subscriptionsv2.get (SubscriptionPurchaseV2) + RTDN obálka. */
export type GoogleSubscriptionSnapshot = {
  purchaseToken: string;
  eventTimeMillis: number | string;
  notificationType?: number;
  resource: Obj;
};

export function mapGoogleState(state: unknown, expiryIso: string | null, nowIso: string): { status: CanonicalStatus; cancelAtPeriodEnd: boolean } | null {
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return { status: "active", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_CANCELED":
      // Zrušené obnovovanie, prístup do konca obdobia.
      return expiryIso && expiryIso > nowIso
        ? { status: "active", cancelAtPeriodEnd: true }
        : { status: "expired", cancelAtPeriodEnd: true };
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return { status: "past_due", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return { status: "unpaid", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_PAUSED":
      return { status: "paused", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_EXPIRED":
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return { status: "expired", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_PENDING":
      return { status: "incomplete", cancelAtPeriodEnd: false };
    default:
      return null;
  }
}

export function normalizeGoogleSubscription(s: GoogleSubscriptionSnapshot): NormalizationResult {
  const r = s.resource;
  const items = Array.isArray(r.lineItems) ? (r.lineItems as unknown[]) : [];
  const item = items.length === 1 && isObj(items[0]) ? (items[0] as Obj) : null;
  const productId = item ? str(item.productId) : null;
  const basePlanId = item && isObj(item.offerDetails) ? str(item.offerDetails.basePlanId) : null;
  const expiry = item ? isoFromMillis(Date.parse(String(item.expiryTime ?? ""))) : null;
  const stateAt = isoFromMillis(s.eventTimeMillis) ?? new Date().toISOString();
  const mapped = mapGoogleState(r.subscriptionState, expiry, stateAt);
  if (!mapped || !s.purchaseToken) throw new BillingProviderError("MALFORMED_PAYLOAD");
  const account = isObj(r.externalAccountIdentifiers) ? str(r.externalAccountIdentifiers.obfuscatedExternalAccountId) : null;
  const started = isoFromMillis(Date.parse(String(r.startTime ?? "")));
  return {
    kind: "state",
    state: {
      provider_subscription_id: s.purchaseToken,
      provider_customer_id: null,
      // Server-side mapovanie: "<productId>:<basePlanId>" → billing_provider_prices.
      provider_price_id: productId && basePlanId ? `${productId}:${basePlanId}` : null,
      status: mapped.status,
      current_period_start: started,
      current_period_end: expiry,
      cancel_at_period_end: mapped.cancelAtPeriodEnd,
      canceled_at: mapped.cancelAtPeriodEnd ? stateAt : null,
      ended_at: mapped.status === "expired" ? stateAt : null,
      trial_start: null,
      trial_end: null,
      checkout_ref: null,
      account_token: account,
      state_at: stateAt,
      replaces_subscription_id: str(r.linkedPurchaseToken),
    },
  };
}

export class GooglePlayProvider extends StoreProviderBase {
  readonly id = "google" as const;
  async normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    return normalizeGoogleSubscription(event.data as GoogleSubscriptionSnapshot);
  }
}
