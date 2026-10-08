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

import { sha256Hex } from "@/lib/billing/signature";
import type { AppleSignedDataVerifier } from "@/lib/billing/stores/apple-jws";
import type { GooglePlayApi } from "@/lib/billing/stores/store-apis";
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
  abstract verifyWebhook(rawBody?: string, headers?: Headers): Promise<VerifiedProviderEvent>;
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

const APPLE_AUDIT_TYPES = new Set(["TEST", "CONSUMPTION_REQUEST", "PRICE_INCREASE", "REFUND_DECLINED", "REFUND_REVERSED", "EXTERNAL_PURCHASE_TOKEN"]);

export function normalizeAppleNotification(n: AppleDecodedNotification): NormalizationResult {
  if (APPLE_AUDIT_TYPES.has(n.notificationType)) return { kind: "ignore", reason: "AUDIT_ONLY" };
  const tx = n.transaction ?? {};
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
  private readonly verifier: AppleSignedDataVerifier | null;
  private readonly bundleId: string;

  constructor(verifier: AppleSignedDataVerifier | null = null, bundleId = "com.esblu.app") {
    super();
    this.verifier = verifier;
    this.bundleId = bundleId;
  }

  /** App Store Server Notifications V2: { signedPayload } → overené JWS (+ vnorené transakcie). */
  async verifyWebhook(rawBody?: string): Promise<VerifiedProviderEvent> {
    if (!this.verifier) throw new BillingProviderError("NOT_CONFIGURED");
    let body: unknown;
    try {
      body = JSON.parse(rawBody ?? "");
    } catch {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    const signedPayload = isObj(body) ? str(body.signedPayload) : null;
    if (!signedPayload) throw new BillingProviderError("MALFORMED_PAYLOAD");
    const payload = await this.verifier.verify<Obj>(signedPayload);
    const data = isObj(payload.data) ? payload.data : {};
    if (data.bundleId !== undefined && data.bundleId !== this.bundleId) throw new BillingProviderError("INVALID_SIGNATURE", "bundle");
    if (data.environment !== undefined && data.environment !== "Sandbox") throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
    const signedTx = str(data.signedTransactionInfo);
    const signedRenewal = str(data.signedRenewalInfo);
    const transaction = signedTx ? await this.verifier.verify<Obj>(signedTx) : {};
    const renewal = signedRenewal ? await this.verifier.verify<Obj>(signedRenewal) : null;
    const uuid = str(payload.notificationUUID);
    const type = str(payload.notificationType);
    if (!uuid || !type) throw new BillingProviderError("MALFORMED_PAYLOAD");
    const signedDate = typeof payload.signedDate === "number" ? payload.signedDate : Date.now();
    const decoded: AppleDecodedNotification = { notificationType: type, subtype: str(payload.subtype), notificationUUID: uuid, signedDate, transaction, renewal };
    return {
      provider: "apple",
      environment: "test",
      eventId: uuid,
      eventType: payload.subtype ? `${type}.${String(payload.subtype)}` : type,
      createdAt: new Date(signedDate).toISOString(),
      payloadSha256: sha256Hex(rawBody ?? ""),
      data: decoded,
    };
  }

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

export type GoogleRtdnConfig = {
  api: GooglePlayApi;
  packageName: string;
  /** Overenie Pub/Sub push OIDC tokenu; null = NOT_CONFIGURED. */
  verifyPushToken: ((bearer: string) => Promise<void>) | null;
};

export class GooglePlayProvider extends StoreProviderBase {
  readonly id = "google" as const;
  private readonly rtdn: GoogleRtdnConfig | null;

  constructor(rtdn: GoogleRtdnConfig | null = null) {
    super();
    this.rtdn = rtdn;
  }

  /** RTDN (Pub/Sub push): OIDC bearer → message.data (base64 DeveloperNotification). */
  async verifyWebhook(rawBody?: string, headers?: Headers): Promise<VerifiedProviderEvent> {
    if (!this.rtdn || !this.rtdn.verifyPushToken) throw new BillingProviderError("NOT_CONFIGURED");
    const bearer = (headers?.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer) throw new BillingProviderError("INVALID_SIGNATURE");
    await this.rtdn.verifyPushToken(bearer);
    let body: unknown;
    let notification: Obj;
    try {
      body = JSON.parse(rawBody ?? "");
      const message = isObj(body) && isObj(body.message) ? body.message : null;
      notification = JSON.parse(Buffer.from(String(message?.data ?? ""), "base64").toString("utf8")) as Obj;
      if (!message || !str(message.messageId)) throw new Error("x");
      (notification as Obj).__messageId = message.messageId;
    } catch {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    if (notification.packageName !== this.rtdn.packageName) throw new BillingProviderError("INVALID_SIGNATURE", "package");
    const sub = isObj(notification.subscriptionNotification) ? notification.subscriptionNotification : null;
    const eventTime = Number(notification.eventTimeMillis ?? Date.now());
    return {
      provider: "google",
      environment: "test",
      eventId: `rtdn:${String(notification.__messageId)}`,
      eventType: sub ? `subscription.${String(sub.notificationType)}` : notification.testNotification ? "test" : "other",
      createdAt: new Date(eventTime).toISOString(),
      payloadSha256: sha256Hex(rawBody ?? ""),
      data: sub ? { purchaseToken: str(sub.purchaseToken), eventTimeMillis: eventTime } : null,
    };
  }

  async normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    const data = event.data as { purchaseToken?: string | null; eventTimeMillis?: number; resource?: Obj } | null;
    if (!data?.purchaseToken) return { kind: "ignore", reason: "AUDIT_ONLY" };
    // RTDN nesie iba „niečo sa zmenilo" → autoritatívny stav z Play Developer API.
    const resource = data.resource ?? (this.rtdn ? await this.rtdn.api.getSubscriptionV2(data.purchaseToken) : null);
    if (!resource) throw new BillingProviderError("NOT_CONFIGURED");
    const result = normalizeGoogleSubscription({ purchaseToken: data.purchaseToken, eventTimeMillis: data.eventTimeMillis ?? Date.now(), resource });
    // Acknowledge (do 3 dní, inak auto-refund) pre aktívne nákupy, ktoré klient nepotvrdil.
    if (this.rtdn && result.kind === "state" && result.state.status === "active" && resource.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
      const items = Array.isArray(resource.lineItems) ? (resource.lineItems as Obj[]) : [];
      const productId = str(items[0]?.productId);
      if (productId) await this.rtdn.api.acknowledge(productId, data.purchaseToken);
    }
    return result;
  }
}
