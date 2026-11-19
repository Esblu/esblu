// =============================================================================
// Stripe API verzia — JEDINÝ zdroj pravdy pre každé volanie Stripe API (P4, 2026-11-23).
//
// Prečo: bez hlavičky `Stripe-Version` použije Stripe predvolenú verziu ÚČTU. Live účet môže mať inú
// predvolenú verziu ako sandbox, v ktorom bol kód overený → iné tvary objektov (napr. `invoice.parent`,
// `invoice_payments`, obdobie na položke predplatného) a tiché chyby normalizácie.
//
// Pravidlá:
//   - každý request adaptéra (lib/billing/providers/stripe.ts) posiela `Stripe-Version` = táto verzia,
//   - override cez env `STRIPE_API_VERSION` je povolený IBA na verziu zo zoznamu
//     STRIPE_VALIDATED_API_VERSIONS (overenú sandbox testami S12/S13 s touto hlavičkou); iná hodnota
//     = provider sa nespustí (NOT_CONFIGURED, fail closed) a validateBillingEnv ju hlási ako neplatnú,
//   - verzia Stripe webhook endpointu (Dashboard → Webhooks → API version) MUSÍ byť rovnaká;
//     nezhoda sa hlási ako ops alert WEBHOOK_API_VERSION_MISMATCH (udalosť sa aj tak spracuje, lebo
//     stav sa vždy znova načíta z API s pripnutou verziou).
// Zmena verzie = zmena kódu (nová konštanta + testy + sandbox beh), nie iba prepnutie premennej.
// =============================================================================

/**
 * Verzia, voči ktorej je napísaný adaptér: od 2025-03-31 („basil“) nesie faktúra predplatné v
 * `invoice.parent.subscription_details`, platby faktúry sú v `/v1/invoice_payments` a obdobie je na
 * položke predplatného. Pred prvým LIVE predajom zopakovať sandbox testy S12/S13 s touto hlavičkou.
 */
export const STRIPE_API_VERSION = "2025-03-31.basil";

/** Verzie výslovne overené pre tento kód (override cez env iba na niektorú z nich). */
export const STRIPE_VALIDATED_API_VERSIONS: readonly string[] = [STRIPE_API_VERSION];

/**
 * Výsledná verzia pre klienta: bez override = pripnutá konštanta; override iba ak je v zozname
 * overených verzií, inak `null` (volajúci zlyhá fail-closed). Prázdna hodnota = bez override.
 */
export function resolveStripeApiVersion(override: string | null | undefined): string | null {
  const value = (override ?? "").trim();
  if (!value) return STRIPE_API_VERSION;
  return STRIPE_VALIDATED_API_VERSIONS.includes(value) ? value : null;
}

export function isValidatedStripeApiVersion(value: string): boolean {
  return STRIPE_VALIDATED_API_VERSIONS.includes(value.trim());
}
