// =============================================================================
// Kanonický (provider-neutrálny) stav predplatného — JEDINÁ mapa
// provider stav → Esblu stav. Zrkadlí DB helpery z
// 20261011120000_subscriptions_lifecycle_hardening.sql:
//   esblu_billing_status_is_open / _is_entitling / _is_terminal,
//   esblu_billing_managed_via / esblu_billing_manage_here.
// Nároky NIKDY nevznikajú z textu providera — iba cez tento model a DB sync.
// Modul je bez importov (testovateľný v Node).
// =============================================================================

export const CANONICAL_STATUSES = [
  "none",
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
export type CanonicalSubscriptionStatus = (typeof CANONICAL_STATUSES)[number];

/** Otvorený vzťah s providerom — druhý nákup (iný provider/predplatné) je zakázaný. */
export const OPEN_STATUSES: ReadonlySet<CanonicalSubscriptionStatus> = new Set([
  "pending", "incomplete", "trialing", "active", "grace_period", "past_due", "account_hold", "unpaid", "paused",
]);
/** Oprávňuje na nároky (v rámci platnosti obdobia / grace). */
export const ENTITLING_STATUSES: ReadonlySet<CanonicalSubscriptionStatus> = new Set([
  "trialing", "active", "grace_period", "past_due",
]);
/** Ukončené — to isté provider ID sa neskorším eventom neoživí. */
export const TERMINAL_STATUSES: ReadonlySet<CanonicalSubscriptionStatus> = new Set([
  "canceled", "expired", "refunded", "revoked",
]);

export const isCanonicalStatus = (v: unknown): v is CanonicalSubscriptionStatus =>
  typeof v === "string" && (CANONICAL_STATUSES as readonly string[]).includes(v);
export const isOpenStatus = (s: string | null | undefined) => !!s && OPEN_STATUSES.has(s as CanonicalSubscriptionStatus);
export const isEntitlingStatus = (s: string | null | undefined) => !!s && ENTITLING_STATUSES.has(s as CanonicalSubscriptionStatus);
export const isTerminalStatus = (s: string | null | undefined) => !!s && TERMINAL_STATUSES.has(s as CanonicalSubscriptionStatus);

// ----------------------------------------------------------------------------- Stripe
/** Stripe Subscription.status → kanonický stav (docs.stripe.com/api/subscriptions/object#status). */
export const STRIPE_STATUS_MAP: Readonly<Record<string, CanonicalSubscriptionStatus>> = {
  incomplete: "pending",
  incomplete_expired: "expired",
  trialing: "trialing",
  active: "active",
  past_due: "past_due", // Esblu grace 7 dní (Smart Retries)
  unpaid: "account_hold", // retries vyčerpané, faktúry ostávajú otvorené
  paused: "paused",
  canceled: "canceled",
};

// ----------------------------------------------------------------------------- Google Play
/** purchases.subscriptionsv2 subscriptionState → kanonický stav. */
export const GOOGLE_STATE_MAP: Readonly<Record<string, CanonicalSubscriptionStatus | "active_or_expired">> = {
  SUBSCRIPTION_STATE_PENDING: "pending",
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace_period",
  SUBSCRIPTION_STATE_ON_HOLD: "account_hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_CANCELED: "active_or_expired", // obnovovanie zrušené; prístup do expiryTime
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
};
/** RTDN SubscriptionNotification.notificationType, ktoré prepíšu stav z API. */
export const GOOGLE_RTDN_OVERRIDES: Readonly<Record<number, CanonicalSubscriptionStatus>> = {
  12: "revoked", // SUBSCRIPTION_REVOKED — refund/odvolanie pred koncom obdobia
};

// ----------------------------------------------------------------------------- Apple
/** App Store Server Notification V2 notificationType(.subtype) → kanonický stav. */
export function appleNotificationStatus(
  type: string,
  subtype: string | null | undefined,
  expiresAtIso: string | null,
  signedAtIso: string,
): CanonicalSubscriptionStatus | "ignore" {
  switch (type) {
    case "REFUND":
      return "refunded";
    case "REVOKE":
      return "revoked"; // Family Sharing / odvolanie
    case "EXPIRED":
      return "expired";
    case "DID_FAIL_TO_RENEW":
      return subtype === "GRACE_PERIOD" ? "grace_period" : "account_hold"; // billing retry bez grace = bez prístupu
    case "GRACE_PERIOD_EXPIRED":
      return "account_hold"; // billing retry pokračuje, prístup končí
    case "TEST":
    case "CONSUMPTION_REQUEST":
    case "PRICE_INCREASE":
    case "REFUND_DECLINED":
    case "REFUND_REVERSED": // operátor (refunded je terminálny — neoživuje sa automaticky)
    case "EXTERNAL_PURCHASE_TOKEN":
      return "ignore";
    default:
      // SUBSCRIBED, DID_RENEW, DID_CHANGE_RENEWAL_*, OFFER_REDEEMED, RENEWAL_EXTENDED…
      return expiresAtIso && expiresAtIso > signedAtIso ? "active" : "expired";
  }
}

// ----------------------------------------------------------------------------- cross-provider
export type ManagedVia = "web" | "google_play" | "app_store" | "esblu_support";
export type ClientPlatform = "web" | "android" | "ios";

export function managedVia(provider: string | null | undefined): ManagedVia | null {
  switch (provider) {
    case "stripe":
    case "fake":
      return "web";
    case "google":
      return "google_play";
    case "apple":
      return "app_store";
    case "manual":
      return "esblu_support";
    default:
      return null;
  }
}

/** Smie táto platforma spravovať predplatné daného providera (zrušiť / obnoviť / zmeniť)? */
export function manageHere(provider: string | null | undefined, platform: ClientPlatform): boolean {
  // Web predplatné: appka iba informuje „Predplatné spravujete cez web" (žiadny cancel flow v appke).
  if (provider === "stripe" || provider === "fake") return platform === "web";
  if (provider === "google") return platform === "android";
  if (provider === "apple") return platform === "ios";
  return false;
}

/** i18n kľúč hlášky „Predplatné spravujete cez …" (nikdy nesmerovať do cudzieho cancel flow). */
export function managedViaMessageKey(via: ManagedVia | null): string | null {
  switch (via) {
    case "web":
      return "subscription.managedVia.web";
    case "google_play":
      return "subscription.managedVia.googlePlay";
    case "app_store":
      return "subscription.managedVia.appStore";
    case "esblu_support":
      return "subscription.managedVia.support";
    default:
      return null;
  }
}

/**
 * Rozhodnutie pred nákupom (zrkadlo DB esblu_billing_purchase_options /
 * create_purchase_intent). Server je autorita — klient to iba zobrazuje.
 */
export function purchaseDecision(current: { status: string | null; provider: string | null } | null, platform: ClientPlatform):
  | { allowed: true }
  | { allowed: false; reason: "ALREADY_SUBSCRIBED"; managedVia: ManagedVia | null; manageHere: boolean } {
  if (current && isOpenStatus(current.status)) {
    return { allowed: false, reason: "ALREADY_SUBSCRIBED", managedVia: managedVia(current.provider), manageHere: manageHere(current.provider, platform) };
  }
  return { allowed: true };
}
