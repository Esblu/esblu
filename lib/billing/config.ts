// =============================================================================
// Billing runtime konfigurácia (SERVER ONLY).
//
// TVRDÉ POISTKY tejto fázy:
//   - VERCEL_ENV=production → billing VŽDY vypnutý (aj keby niekto nastavil env).
//   - Iba test mode: Stripe kľúč musí byť sk_test_/rk_test_ (providers/stripe.ts),
//     DB config povoľuje iba environment='test' (check constraint).
//   - Default = 'off'. Zapína sa iba explicitne na stagingu/preview:
//       ESBLU_BILLING_MODE=fake         (+ ESBLU_FAKE_BILLING_SECRET, ≥16 znakov)
//       ESBLU_BILLING_MODE=stripe_test  (+ STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)
//   - DB (billing_runtime_config.web_provider) musí súhlasiť s režimom servera.
// Hodnoty secrets sa nikdy nelogujú ani nevracajú klientovi.
// =============================================================================

export type BillingServerMode = "off" | "fake" | "stripe_test";

export function getBillingServerMode(env: Record<string, string | undefined> = process.env): BillingServerMode {
  if (env.VERCEL_ENV === "production") return "off";
  const mode = (env.ESBLU_BILLING_MODE ?? "").trim();
  return mode === "fake" || mode === "stripe_test" ? mode : "off";
}

/** Zodpovedá DB billing_runtime_config.web_provider pre daný režim. */
export function webProviderForMode(mode: BillingServerMode): "fake" | "stripe" | null {
  return mode === "fake" ? "fake" : mode === "stripe_test" ? "stripe" : null;
}

/** Absolútny origin pre návratové URL checkoutu/portálu — iba zo servera, nie z požiadavky. */
export function billingReturnOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.ESBLU_BILLING_RETURN_ORIGIN ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    return url.origin;
  } catch {
    return null;
  }
}
