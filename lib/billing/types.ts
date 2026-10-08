// =============================================================================
// Unified subscriptions — provider-neutrálne typy.
//
// ZÁSADA: provider (Stripe / Apple / Google / fake) iba DORUČUJE udalosti.
// Zdroj pravdy je DB vrstva Esblu (subscription_accounts → company_entitlements
// cez esblu_billing_apply_event). Tento modul nepozná nároky ani limity.
// =============================================================================

export type BillingProviderId = "stripe" | "apple" | "google" | "fake";
export type BillingEnvironment = "test";
export type BillingInterval = "month" | "year";

/** Kanonické stavy — rovnaké pre všetkých providerov (DB check constraint). */
export const CANONICAL_STATUSES = [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "canceled",
  "expired",
] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

/**
 * Normalizovaný stav predplatného — vstup pre esblu_billing_apply_event.
 * NEOBSAHUJE company_id ani plan_code: firmu aj plán určuje DB z vlastných
 * tabuliek (checkout_ref / provider links / billing_provider_prices).
 */
export type NormalizedSubscriptionState = {
  provider_subscription_id: string | null;
  provider_customer_id: string | null;
  provider_price_id: string | null;
  status: CanonicalStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  ended_at: string | null;
  trial_start: string | null;
  trial_end: string | null;
  /** UUID našej billing_checkout_sessions (Stripe client_reference_id). */
  checkout_ref: string | null;
  /** Apple appAccountToken / Google obfuscatedExternalAccountId. */
  account_token: string | null;
  /** Čas stavu u providera (ISO) — ochrana poradia. */
  state_at: string;
  /** Google linkedPurchaseToken — výslovné nahradenie predplatného tým istým providerom. */
  replaces_subscription_id?: string | null;
};

/** Overená (podpis OK) udalosť providera — ešte NEnormalizovaná. */
export type VerifiedProviderEvent = {
  provider: BillingProviderId;
  environment: BillingEnvironment;
  eventId: string;
  eventType: string;
  createdAt: string;
  payloadSha256: string;
  /** Provider-špecifický objekt (iba v pamäti servera, nikdy sa neukladá celý). */
  data: unknown;
};

/** Výsledok normalizácie: buď zmena stavu, alebo vedome ignorovaný typ. */
export type NormalizationResult =
  | { kind: "state"; state: NormalizedSubscriptionState }
  | { kind: "ignore"; reason: string };

export type CheckoutRequest = {
  checkoutId: string;
  providerPriceId: string;
  providerCustomerId: string | null;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSession = { providerSessionId: string; url: string };

export type ProviderSubscriptionRef = {
  providerSubscriptionId: string;
  providerCustomerId: string | null;
};

export type BillingProviderErrorCode =
  | "NOT_CONFIGURED"
  | "LIVE_MODE_FORBIDDEN"
  | "INVALID_SIGNATURE"
  | "STALE_SIGNATURE"
  | "MALFORMED_PAYLOAD"
  | "UNSUPPORTED_OPERATION"
  | "PROVIDER_ERROR";

export class BillingProviderError extends Error {
  readonly code: BillingProviderErrorCode;
  constructor(code: BillingProviderErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "BillingProviderError";
  }
}

/**
 * Provider-neutrálne rozhranie. Webové providery (stripe, fake) podporujú
 * checkout/portal/cancel; Apple a Google nákup aj zrušenie prebieha v obchode
 * (StoreKit / Play) — server iba overuje a normalizuje ich notifikácie.
 */
export interface BillingProvider {
  readonly id: BillingProviderId;
  readonly environment: BillingEnvironment;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  getSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState>;
  cancelSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState>;
  resumeSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState>;
  changePlan(ref: ProviderSubscriptionRef, newProviderPriceId: string): Promise<NormalizedSubscriptionState>;
  createPortalSession(providerCustomerId: string, returnUrl: string): Promise<{ url: string }>;
  verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedProviderEvent>;
  normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult>;
}
