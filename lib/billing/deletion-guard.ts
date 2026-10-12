// =============================================================================
// Zrušenie účtu × predplatné — KANONICKÉ PRAVIDLO (2026-10-12).
//
// Nesmie nastať: Esblu účet/firma zmazaná + provider (Stripe / Google Play /
// App Store) ďalej účtuje + Esblu už nemá väzbu na provider subscription.
//
// Pravidlo (fail closed):
//   - BEZ externého vzťahu (none, manual grant, Esblu 14-dňový trial, free)
//     → zrušenie povolené.
//   - UKONČENÉ predplatné (canceled / expired / refunded / revoked)
//     → povolené.
//   - AKTÍVNE, ALE NEOBNOVUJÚCE SA (active / trialing + cancel_at_period_end)
//     → povolené: provider už nebude účtovať; zostávajúce zaplatené obdobie
//       zaniká spolu s účtom (UI to povie pred potvrdením).
//   - AKTÍVNE A OBNOVUJÚCE SA (active / trialing bez cancel_at_period_end;
//     „trialing" = trial PROVIDERA, ktorý sa zmení na platbu) → BLOKOVANÉ.
//   - PLATBA / STAV RIEŠENÝ PROVIDEROM (pending, incomplete, grace_period,
//     past_due, account_hold, unpaid, paused) → BLOKOVANÉ (provider môže
//     ešte strhnúť platbu alebo predplatné obnoviť).
//   - NEZNÁMY stav alebo chyba čítania → BLOKOVANÉ.
//   - OTVORENÝ CHECKOUT (created/open, neexpirovaný) → BLOKOVANÉ (platba by
//     mohla prebehnúť po zmazaní firmy).
//   - ČLEN (nie owner), ktorý predplatné kúpil cez Google Play / App Store
//     (viazané na JEHO účet obchodu) a predplatné sa stále obnovuje →
//     BLOKOVANÉ, kým ho v obchode nezruší.
//
// Zrkadlí DB predikát public.esblu_billing_blocks_account_deletion
// (20261012120000_account_deletion_subscription_guard.sql). Parita je
// testovaná v scripts/account-deletion-subscription-pglite-tests.ts.
// Modul je bez importov (testovateľný v Node, použiteľný aj v klientovi).
// =============================================================================

export type DeletionSubscriptionStatus =
  | "none" // žiadny platený vzťah ani trial/grant
  | "trial" // Esblu 14-dňový trial (bez platby)
  | "manual" // manuálny / beta grant (bez externého providera)
  | "ended" // externé predplatné ukončené
  | "active_non_renewing" // zaplatené do konca obdobia, neobnoví sa
  | "active_renewing" // obnovuje sa → bude účtované
  | "payment_in_progress" // pending / incomplete / grace / past_due / hold / unpaid / paused
  | "checkout_in_progress" // otvorený checkout (platba môže ešte prebehnúť)
  | "unknown"; // stav sa nepodarilo overiť

export type DeletionBlockingReason =
  | "ACTIVE_SUBSCRIPTION_RENEWING"
  | "SUBSCRIPTION_PAYMENT_IN_PROGRESS"
  | "CHECKOUT_IN_PROGRESS"
  | "STORE_SUBSCRIPTION_PURCHASER"
  | "SUBSCRIPTION_STATE_UNVERIFIED";

export type DeletionManagedVia = "web" | "google_play" | "app_store" | "esblu_support";
export type DeletionProvider = "stripe" | "google" | "apple" | "manual" | "fake";

export type SubscriptionDeletionCheck = {
  can_delete: boolean;
  blocking_reason: DeletionBlockingReason | null;
  subscription_status: DeletionSubscriptionStatus;
  provider: DeletionProvider | null;
  managed_via: DeletionManagedVia | null;
  /** ISO; pri active_non_renewing = koniec zaplateného obdobia (UI upozornenie). */
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

/** Kanonický riadok public.subscription_accounts (iba stĺpce potrebné pre rozhodnutie). */
export type SubscriptionAccountSnapshot = {
  status: string | null;
  billing_provider: string | null;
  cancel_at_period_end: boolean | null;
  current_period_end: string | null;
};

export type DeletionGuardInput = {
  /** null = firma nemá subscription_accounts riadok (alebo billing schéma neexistuje). */
  account: SubscriptionAccountSnapshot | null;
  /** Provider otvoreného (created/open, neexpirovaného) checkoutu firmy, ak existuje. */
  openCheckoutProvider: string | null;
  /** Mazanie celej firmy (owner) alebo iba člena. */
  scope: "company" | "member";
  /** Člen: kúpil aktuálne predplatné cez obchod (billing_checkout_sessions.created_by). */
  memberIsStorePurchaser?: boolean;
  /** Informačný kontext pre neblokujúce stavy. */
  trialActive?: boolean;
  manualGrantActive?: boolean;
  /** Čítanie stavu zlyhalo → fail closed. */
  readFailed?: boolean;
};

const EXTERNAL_PROVIDERS: ReadonlySet<string> = new Set(["stripe", "google", "apple", "fake"]);
const STORE_PROVIDERS: ReadonlySet<string> = new Set(["google", "apple"]);
const TERMINAL: ReadonlySet<string> = new Set(["canceled", "expired", "refunded", "revoked"]);
const ACTIVE: ReadonlySet<string> = new Set(["active", "trialing"]);
const PAYMENT_IN_PROGRESS: ReadonlySet<string> = new Set([
  "pending", "incomplete", "grace_period", "past_due", "account_hold", "unpaid", "paused",
]);

export function managedViaFor(provider: string | null): DeletionManagedVia | null {
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

function asProvider(p: string | null): DeletionProvider | null {
  return p === "stripe" || p === "google" || p === "apple" || p === "manual" || p === "fake" ? p : null;
}

/**
 * Stav externého predplatného pre zrušenie účtu (bez checkoutu / člena).
 * Rovnaké pravidlo ako DB public.esblu_billing_blocks_account_deletion.
 */
export function classifySubscriptionForDeletion(account: SubscriptionAccountSnapshot | null): {
  status: DeletionSubscriptionStatus;
  blocks: boolean;
} {
  if (!account) return { status: "none", blocks: false };
  const status = account.status ?? "none";
  const provider = account.billing_provider;
  if (status === "none") return { status: "none", blocks: false };
  // Manuálny / bez providera = žiadne externé účtovanie.
  if (!provider || provider === "manual") return { status: "manual", blocks: false };
  if (!EXTERNAL_PROVIDERS.has(provider)) return { status: "unknown", blocks: true };
  if (TERMINAL.has(status)) return { status: "ended", blocks: false };
  if (ACTIVE.has(status)) {
    return account.cancel_at_period_end === true
      ? { status: "active_non_renewing", blocks: false }
      : { status: "active_renewing", blocks: true };
  }
  if (PAYMENT_IN_PROGRESS.has(status)) return { status: "payment_in_progress", blocks: true };
  return { status: "unknown", blocks: true };
}

export function evaluateDeletionGuard(input: DeletionGuardInput): SubscriptionDeletionCheck {
  const account = input.account;
  const provider = asProvider(account?.billing_provider ?? null);
  const base = {
    provider,
    managed_via: managedViaFor(account?.billing_provider ?? null),
    current_period_end: account?.current_period_end ?? null,
    cancel_at_period_end: account?.cancel_at_period_end === true,
  };

  if (input.readFailed) {
    return { ...base, can_delete: false, blocking_reason: "SUBSCRIPTION_STATE_UNVERIFIED", subscription_status: "unknown" };
  }

  const sub = classifySubscriptionForDeletion(account);

  if (input.scope === "member") {
    // Firma (a jej predplatné) ostáva — člen blokuje iba ak je platiteľom cez
    // SVOJ účet obchodu a predplatné sa stále obnovuje / čaká na platbu.
    if (
      input.memberIsStorePurchaser === true &&
      provider !== null &&
      STORE_PROVIDERS.has(provider) &&
      sub.blocks
    ) {
      return { ...base, can_delete: false, blocking_reason: "STORE_SUBSCRIPTION_PURCHASER", subscription_status: sub.status };
    }
    return { ...base, can_delete: true, blocking_reason: null, subscription_status: sub.status };
  }

  if (sub.blocks) {
    const reason: DeletionBlockingReason =
      sub.status === "active_renewing"
        ? "ACTIVE_SUBSCRIPTION_RENEWING"
        : sub.status === "payment_in_progress"
          ? "SUBSCRIPTION_PAYMENT_IN_PROGRESS"
          : "SUBSCRIPTION_STATE_UNVERIFIED";
    return { ...base, can_delete: false, blocking_reason: reason, subscription_status: sub.status };
  }

  if (input.openCheckoutProvider) {
    return {
      ...base,
      provider: provider ?? asProvider(input.openCheckoutProvider),
      managed_via: base.managed_via ?? managedViaFor(input.openCheckoutProvider),
      can_delete: false,
      blocking_reason: "CHECKOUT_IN_PROGRESS",
      subscription_status: "checkout_in_progress",
    };
  }

  // Neblokujúce: spresni kontext pre UI (ukončené / neobnovujúce sa majú prednosť).
  let status: DeletionSubscriptionStatus = sub.status;
  if (status === "none") {
    status = input.manualGrantActive ? "manual" : input.trialActive ? "trial" : "none";
  }
  return { ...base, can_delete: true, blocking_reason: null, subscription_status: status };
}

/** i18n kľúč dôvodu blokácie / upozornenia (settings.deleteModal.subscription.*). */
export function deletionReasonKey(check: SubscriptionDeletionCheck): string | null {
  if (check.can_delete) {
    return check.subscription_status === "active_non_renewing" ? "settings.deleteModal.subscription.nonRenewingWarning" : null;
  }
  switch (check.blocking_reason) {
    case "ACTIVE_SUBSCRIPTION_RENEWING":
      return "settings.deleteModal.subscription.blockedRenewing";
    case "SUBSCRIPTION_PAYMENT_IN_PROGRESS":
      return "settings.deleteModal.subscription.blockedPayment";
    case "CHECKOUT_IN_PROGRESS":
      return "settings.deleteModal.subscription.blockedCheckout";
    case "STORE_SUBSCRIPTION_PURCHASER":
      return "settings.deleteModal.subscription.blockedPurchaser";
    default:
      return "settings.deleteModal.subscription.blockedUnverified";
  }
}

/** „Kde predplatné spravujete" — existujúce kľúče subscription.managedVia.* (rovnaké ako obrazovka Predplatné). */
export function deletionManagedViaKey(check: SubscriptionDeletionCheck): string | null {
  if (check.can_delete || check.blocking_reason === "SUBSCRIPTION_STATE_UNVERIFIED") return null;
  switch (check.managed_via) {
    case "google_play":
      return "subscription.managedVia.googlePlay";
    case "app_store":
      return "subscription.managedVia.appStore";
    case "esblu_support":
      return "subscription.managedVia.support";
    case "web":
      return "subscription.managedVia.web";
    default:
      return null;
  }
}
