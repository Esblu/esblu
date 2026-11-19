// =============================================================================
// S15 (2026-11-19): správa predplatného (/api/billing/manage) iba providerom TOHO ISTÉHO
// prostredia (test ↔ live), v akom predplatné vzniklo. Nesúlad = odmietnutie PRED akýmkoľvek
// volaním providera (žiadne zrušenie / zmena / portál u Stripe, žiadny zápis do DB).
// =============================================================================

import type { BillingProvider } from "@/lib/billing/types";

export type ManageAccount = {
  billing_provider: string | null;
  provider_environment?: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
};

export type ManageProviderResult =
  | { ok: true; provider: BillingProvider }
  | { ok: false; status: number; code: "ESBLU_BILLING_MANAGE_IN_STORE" | "ESBLU_BILLING_DISABLED" | "ESBLU_BILLING_ENVIRONMENT_MISMATCH"; store?: string };

export function resolveManageProvider(
  account: ManageAccount,
  getProvider: (expected?: string | null, expectedEnvironment?: string | null) => BillingProvider | null,
): ManageProviderResult {
  if (account.billing_provider === "apple" || account.billing_provider === "google") {
    return { ok: false, status: 409, code: "ESBLU_BILLING_MANAGE_IN_STORE", store: account.billing_provider };
  }
  const hasProviderRef = !!(account.provider_subscription_id || account.provider_customer_id);
  const env = account.provider_environment ?? null;
  // Predplatné / zákazník bez známeho prostredia sa nikdy nespravuje (nevieme, ktorý účet Stripe).
  if (hasProviderRef && env !== "test" && env !== "live") return { ok: false, status: 409, code: "ESBLU_BILLING_ENVIRONMENT_MISMATCH" };
  const anyProvider = getProvider(account.billing_provider);
  if (!anyProvider) return { ok: false, status: 503, code: "ESBLU_BILLING_DISABLED" };
  if (hasProviderRef && anyProvider.environment !== env) return { ok: false, status: 409, code: "ESBLU_BILLING_ENVIRONMENT_MISMATCH" };
  const provider = hasProviderRef ? getProvider(account.billing_provider, env) : anyProvider;
  if (!provider) return { ok: false, status: 409, code: "ESBLU_BILLING_ENVIRONMENT_MISMATCH" };
  return { ok: true, provider };
}
