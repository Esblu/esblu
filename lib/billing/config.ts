// =============================================================================
// Billing runtime konfigurácia (SERVER ONLY).
//
// TVRDÉ POISTKY tejto fázy:
//   - VERCEL_ENV=production → billing vypnutý, okrem schváleného live režimu (S15):
//     ESBLU_BILLING_MODE=stripe_live + ESBLU_BILLING_LIVE_APPROVED=true + live kľúče
//     STRIPE_LIVE_SECRET_KEY / STRIPE_LIVE_WEBHOOK_SECRET + DB environment='live'.
//   - Mimo produkcie iba test mode: sk_test_/rk_test_/rkcs_test_ (providers/stripe.ts);
//     stripe_live mimo produkcie = off.
//   - Default = 'off'. Zapína sa iba explicitne na stagingu/preview:
//       ESBLU_BILLING_MODE=fake         (+ ESBLU_FAKE_BILLING_SECRET, ≥16 znakov)
//       ESBLU_BILLING_MODE=stripe_test  (+ STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)
//   - DB (billing_runtime_config.web_provider) musí súhlasiť s režimom servera.
// Hodnoty secrets sa nikdy nelogujú ani nevracajú klientovi.
// =============================================================================

export type BillingServerMode = "off" | "fake" | "stripe_test" | "stripe_live";

/**
 * Režim webového billingu (fail closed).
 *   - VERCEL_ENV=production: IBA `stripe_live`, a to len s výslovným schválením
 *     ESBLU_BILLING_LIVE_APPROVED=true; čokoľvek iné (fake, stripe_test, chýbajúce schválenie) → off.
 *   - Preview / development / lokálne: `fake` alebo `stripe_test`; `stripe_live` → off (live nikdy mimo produkcie).
 */
export function getBillingServerMode(env: Record<string, string | undefined> = process.env): BillingServerMode {
  const mode = (env.ESBLU_BILLING_MODE ?? "").trim();
  if (env.VERCEL_ENV === "production") {
    return mode === "stripe_live" && (env.ESBLU_BILLING_LIVE_APPROVED ?? "").trim() === "true" ? "stripe_live" : "off";
  }
  return mode === "fake" || mode === "stripe_test" ? mode : "off";
}

/** Zodpovedá DB billing_runtime_config.web_provider pre daný režim. */
export function webProviderForMode(mode: BillingServerMode): "fake" | "stripe" | null {
  return mode === "fake" ? "fake" : mode === "stripe_test" || mode === "stripe_live" ? "stripe" : null;
}

/** S15: prostredie providera pre režim — musí sa zhodovať s DB billing_runtime_config.environment. */
export function billingEnvironmentForMode(mode: BillingServerMode): "test" | "live" | null {
  return mode === "stripe_live" ? "live" : mode === "fake" || mode === "stripe_test" ? "test" : null;
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
