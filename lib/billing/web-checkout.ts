// =============================================================================
// Webový hosted checkout (Stripe / fake) — spoločný postup pre
// POST /api/billing/checkout a POST /api/billing/purchase-intent (2026-11-18).
//
// Najviac JEDNA zaplatiteľná relácia na firmu:
//   - DB (esblu_billing_create_purchase_intent) pod advisory lockom firmy vráti pri
//     súbežnom alebo opakovanom pokuse TEN ISTÝ zámer (`reused: true`),
//   - provider sa volá s Idempotency-Key odvodeným zo zámeru (`esblu-checkout-<id>`)
//     a s rovnakými parametrami (návratové URL zo zámeru, `expires_at` zo zámeru)
//     → Stripe vráti tú istú reláciu, aj keď prvý pokus spadol po vytvorení relácie,
//   - priradenie relácie k zámeru je idempotentné.
// Výpadok providera: 1 okamžité opakovanie s tým istým kľúčom; inak 502 a klient
// môže pokus zopakovať (dostane ten istý zámer → tú istú reláciu).
// =============================================================================

import { BillingProviderError, type BillingProvider, type CheckoutSession } from "@/lib/billing/types";

export type WebIntentData = {
  checkout_id: string;
  provider: string;
  provider_price_id: string;
  provider_customer_id: string | null;
  expires_at?: string | null;
  reused?: boolean;
  /** S15: prostredie zámeru z DB (billing_runtime_config.environment) — provider musí mať rovnaké. */
  environment?: string | null;
};

export type AttachFn = (checkoutId: string, providerSessionId: string) => Promise<{ error: unknown | null }>;

export type WebCheckoutResult =
  | { ok: true; checkoutId: string; url: string; reused: boolean }
  | { ok: false; code: "ESBLU_BILLING_PROVIDER_ERROR" | "ESBLU_BILLING_CHECKOUT_STATE"; error?: unknown };

export function checkoutReturnBase(origin: string, checkoutId: string): string {
  return `${origin}/nastavenia/predplatne?checkout_id=${encodeURIComponent(checkoutId)}`;
}

export async function startWebCheckout(input: {
  provider: BillingProvider;
  intent: WebIntentData;
  origin: string;
  mobileApp?: boolean;
  attach: AttachFn;
  maxAttempts?: number;
}): Promise<WebCheckoutResult> {
  const { provider, intent, origin } = input;
  // S15: zámer z iného prostredia (test ↔ live) sa nikdy nepošle tomuto providerovi (fail closed).
  if (intent.environment && intent.environment !== provider.environment) return { ok: false, code: "ESBLU_BILLING_PROVIDER_ERROR" };
  const returnBase = checkoutReturnBase(origin, intent.checkout_id);
  const request = {
    checkoutId: intent.checkout_id,
    providerPriceId: intent.provider_price_id,
    providerCustomerId: intent.provider_customer_id,
    mobileApp: input.mobileApp === true,
    successUrl: `${returnBase}&checkout=returned`,
    cancelUrl: `${returnBase}&checkout=canceled`,
    expiresAt: intent.expires_at ?? null,
  };
  const attempts = Math.max(1, input.maxAttempts ?? 2);
  let session: CheckoutSession | null = null;
  for (let attempt = 1; attempt <= attempts && !session; attempt++) {
    try {
      session = await provider.createCheckout(request);
    } catch (error) {
      // Konfiguračné chyby sa neopakujú; sieťové / 5xx áno (ten istý Idempotency-Key).
      if (error instanceof BillingProviderError && error.code !== "PROVIDER_ERROR") break;
      if (attempt === attempts) break;
    }
  }
  if (!session) return { ok: false, code: "ESBLU_BILLING_PROVIDER_ERROR" };
  const attached = await input.attach(intent.checkout_id, session.providerSessionId);
  if (attached.error) return { ok: false, code: "ESBLU_BILLING_CHECKOUT_STATE", error: attached.error };
  return { ok: true, checkoutId: intent.checkout_id, url: session.url, reused: intent.reused === true };
}
