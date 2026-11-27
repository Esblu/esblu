// =============================================================================
// Unified subscriptions — provider-neutrálne typy.
//
// ZÁSADA: provider (Stripe / Apple / Google / fake) iba DORUČUJE udalosti.
// Zdroj pravdy je DB vrstva Esblu (subscription_accounts → company_entitlements
// cez esblu_billing_apply_event). Tento modul nepozná nároky ani limity.
// =============================================================================

export type BillingProviderId = "stripe" | "apple" | "google" | "fake";
/** S15: "live" iba Stripe v schválenom produkčnom režime (lib/billing/config.ts); obchody a fake sú vždy "test". */
export type BillingEnvironment = "test" | "live";
export type BillingInterval = "month" | "year";

/** Kanonické stavy — rovnaké pre všetkých providerov (DB check constraint). Mapa: lib/billing/canonical-state.ts. */
export const CANONICAL_STATUSES = [
  "pending",
  "incomplete",
  "trialing",
  "active",
  "grace_period",
  "past_due",
  "account_hold",
  "unpaid",
  "paused",
  "canceled",
  "expired",
  "refunded",
  "revoked",
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
  /**
   * Plánované PREDČASNÉ ukončenie k zvolenému dátumu (Stripe `cancel_at` mimo konca obdobia).
   * Null = žiadne. Prístup končí k tomuto dátumu bez 48 h ochrannej lehoty (S13, 2026-11-19).
   */
  scheduled_end_at?: string | null;
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
  /** Koniec grace podľa providera (Apple gracePeriodExpiresDate / Google expiryTime počas grace). */
  grace_until?: string | null;
  /** Rizikový príznak pre operátora (spor / čiastočný refund); null = vyčistiť. Nemení nároky. */
  review_flag?: "dispute_open" | "refund_partial" | "refund_reversed" | null;
  /** Google linkedPurchaseToken — výslovné nahradenie predplatného tým istým providerom. */
  replaces_subscription_id?: string | null;
  /** Platba (iba ak event nesie platbu) — vstup pre reporting obchodom (Google/Apple). */
  charge?: NormalizedCharge | null;
};

/** Platba predplatného pre reporting obchodom. Sumy v najmenších jednotkách meny. */
export type NormalizedCharge = {
  id: string;
  kind: "purchase" | "refund";
  amount_pre_tax_minor: number | null;
  tax_minor: number | null;
  currency: string | null;
  at: string;
  tax_country: string | null;
  refunded_charge_id?: string | null;
  /** Refundácia: obdobie služby refundovanej faktúry (riadok predplatného) a rozsah dopadu. */
  invoice_period_start?: string | null;
  invoice_period_end?: string | null;
  refund_scope?: "partial" | "older_invoice" | "current_period" | null;
};

/** Overená (podpis OK) udalosť providera — ešte NEnormalizovaná. */
export type VerifiedProviderEvent = {
  provider: BillingProviderId;
  environment: BillingEnvironment;
  eventId: string;
  eventType: string;
  createdAt: string;
  /**
   * SHA-256 surového tela webhooku (ochrana „rovnaké ID, iné telo“). `null` = udalosť načítaná
   * priamo z API providera (doťahovanie / retry): je autentická (kľúčom overený kanál), ale jej
   * serializácia sa od webhooku vždy líši → porovnanie hashov sa preskočí (P4, nález § 2.3).
   */
  payloadSha256: string | null;
  /** API verzia, v ktorej provider udalosť serializoval (Stripe `api_version`), ak ju uvádza. */
  apiVersion?: string | null;
  /** Provider-špecifický objekt (iba v pamäti servera, nikdy sa neukladá celý). */
  data: unknown;
};

/**
 * P4: účtovná kópia dokladu providera (Stripe faktúra / dobropis). Iba údaje potrebné pre účtovníctvo:
 * žiadne meno, e-mail ani adresa odberateľa (iba krajina a daňové identifikátory tak, ako ich Stripe
 * na doklade uvádza). Sumy v najmenších jednotkách meny.
 */
export type BillingDocumentRecord = {
  kind: "invoice" | "credit_note";
  provider_document_id: string;
  /** Dobropis → pôvodná faktúra. */
  related_invoice_id: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  payment_intent_id: string | null;
  document_number: string | null;
  status: string | null;
  currency: string | null;
  subtotal_minor: number | null;
  subtotal_excl_tax_minor: number | null;
  total_minor: number | null;
  total_excl_tax_minor: number | null;
  tax_minor: number | null;
  amount_paid_minor: number | null;
  customer_country: string | null;
  customer_tax_exempt: string | null;
  customer_tax_ids: Array<{ type: string; value: string }>;
  /** Daňové riadky tak, ako ich provider poslal (iba primitívne polia, orezané). */
  tax_details: Array<Record<string, unknown>>;
  service_period_start: string | null;
  service_period_end: string | null;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  hosted_url: string | null;
  pdf_url: string | null;
  credit_reason: string | null;
  credit_type: string | null;
};

/** P4: refundácia platby (charge.refunded) — kontrola, že k nej vznikol dobropis. */
export type BillingRefundObservation = {
  payment_intent_id: string;
  amount_refunded_minor: number;
  currency: string | null;
  observed_at: string;
};

export type BillingDocumentCapture = { documents: BillingDocumentRecord[]; refunds: BillingRefundObservation[] };

/** Výsledok normalizácie: buď zmena stavu, alebo vedome ignorovaný typ. */
export type NormalizationResult =
  /**
   * followUp "cancel_provider_now": po zápise terminálneho stavu (plná refundácia aktuálneho
   * obdobia, prehraný spor) okamžite ukončiť predplatné U PROVIDERA — inak by ďalej účtoval
   * firme, ktorá už nemá prístup (2026-11-18, Stripe Test Clock nález).
   */
  | { kind: "state"; state: NormalizedSubscriptionState; followUp?: "cancel_provider_now" }
  | { kind: "charge"; providerSubscriptionId: string; charge: NormalizedCharge }
  | { kind: "ignore"; reason: string };

export type CheckoutRequest = {
  checkoutId: string;
  /** Checkout otvorený z mobilnej appky (Stripe origin_context=mobile_app). */
  mobileApp?: boolean;
  providerPriceId: string;
  providerCustomerId: string | null;
  successUrl: string;
  cancelUrl: string;
  /**
   * Koniec platnosti zámeru z DB (ISO). Stripe `expires_at` = rovnaký okamih → relácia
   * zanikne spolu so zámerom a opakovanie s tým istým Idempotency-Key má zhodné parametre.
   */
  expiresAt?: string | null;
  /** Verzia VOP prijatá firmou pri objednávke (metadáta relácie a predplatného). */
  termsVersion?: string | null;
};

/** Výsledok expirácie hosted checkout relácie u providera. */
export type CheckoutExpireResult = "expired" | "complete" | "open";

export type CheckoutSession = { providerSessionId: string; url: string };

export type ProviderSubscriptionRef = {
  providerSubscriptionId: string;
  providerCustomerId: string | null;
};

export type BillingProviderErrorCode =
  | "NOT_CONFIGURED"
  | "LIVE_MODE_FORBIDDEN"
  | "TEST_MODE_FORBIDDEN"
  | "INVALID_SIGNATURE"
  | "STALE_SIGNATURE"
  | "MALFORMED_PAYLOAD"
  | "UNSUPPORTED_OPERATION"
  | "PROVIDER_ERROR";

export class BillingProviderError extends Error {
  readonly code: BillingProviderErrorCode;
  constructor(code: BillingProviderErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
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
  /** Zrušenie rozpracovanej platby (iba webové providery s hosted checkoutom). */
  expireCheckout?(providerSessionId: string): Promise<CheckoutExpireResult>;
  getSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState>;
  cancelSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState>;
  /** Okamžité ukončenie u providera bez ďalšej faktúry a bez prorácie (iba webové providery). */
  cancelSubscriptionNow?(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState>;
  resumeSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState>;
  changePlan(ref: ProviderSubscriptionRef, newProviderPriceId: string): Promise<NormalizedSubscriptionState>;
  createPortalSession(providerCustomerId: string, returnUrl: string): Promise<{ url: string }>;
  /** S12: stav pre reconciliation vrátane platby aktuálneho obdobia (refund / spor bez webhooku). */
  getReconcileState?(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState & { providerOpen: boolean; followUp?: "cancel_provider_now" }>;
  verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedProviderEvent>;
  normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult>;
  /** P4: účtovné doklady z udalosti (faktúra / dobropis / refundácia); null = udalosť doklad nenesie. */
  captureDocuments?(event: VerifiedProviderEvent): Promise<BillingDocumentCapture | null>;
  /** P4: API verzia, ktorú provider posiela (Stripe-Version) — na kontrolu verzie webhook endpointu. */
  readonly apiVersion?: string | null;
}
