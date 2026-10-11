// =============================================================================
// Billing provider režimy + env schéma (SERVER ONLY, bez hodnôt secrets).
//
//   disabled — default; nič sa nepredáva ani nespracúva
//   fake     — staging emulácia (HMAC fake provider / fake obchody)
//   sandbox  — Stripe test mode / Apple Sandbox / Google license testing
//   live     — V TEJTO FÁZE NEPODPOROVANÉ: požiadavka na live → disabled
//              + issue LIVE_NOT_APPROVED (fail closed). Zapnutie live =
//              nová migrácia (billing_runtime_config.environment='live'),
//              nový kód a výslovný súhlas vlastníka.
// VERCEL_ENV=production → vždy disabled.
// validateBillingEnv vracia iba NÁZVY chýbajúcich/neplatných premenných.
// =============================================================================

import { getBillingServerMode } from "@/lib/billing/config";
import { getStoreMode } from "@/lib/billing/stores/store-config";

export type ProviderMode = "disabled" | "fake" | "sandbox" | "live";
type Env = Record<string, string | undefined>;

export type ProviderModes = {
  web: ProviderMode; // Stripe (web checkout, Android billing choice, iOS EU link)
  stores: ProviderMode; // Google Play Billing + Apple StoreKit
  productionLocked: boolean;
  issues: string[];
};

export function resolveProviderModes(env: Env = process.env): ProviderModes {
  const issues: string[] = [];
  const productionLocked = env.VERCEL_ENV === "production";
  const rawWeb = (env.ESBLU_BILLING_MODE ?? "").trim();
  const rawStores = (env.ESBLU_BILLING_STORE_MODE ?? "").trim();
  if (rawWeb === "live" || rawStores === "live") issues.push("LIVE_NOT_APPROVED");
  const webServer = getBillingServerMode(env);
  const web: ProviderMode = webServer === "fake" ? "fake" : webServer === "stripe_test" ? "sandbox" : "disabled";
  const storeMode = getStoreMode(env);
  const stores: ProviderMode = storeMode === "fake" ? "fake" : storeMode === "sandbox" ? "sandbox" : "disabled";
  if (productionLocked && (rawWeb || rawStores)) issues.push("PRODUCTION_LOCKED");
  return { web, stores, productionLocked, issues };
}

type EnvRule = { name: string; secret: boolean; required: (m: ProviderModes) => boolean; valid: (v: string) => boolean };

/** Kontrakt premenných prostredia (hodnoty sa nikdy nevracajú ani nelogujú). */
export const BILLING_ENV_SCHEMA: readonly EnvRule[] = [
  { name: "ESBLU_FAKE_BILLING_SECRET", secret: true, required: (m) => m.web === "fake" || m.stores === "fake", valid: (v) => v.length >= 16 },
  { name: "ESBLU_BILLING_RETURN_ORIGIN", secret: false, required: (m) => m.web !== "disabled", valid: (v) => /^https:\/\/[^/]+$/.test(v) || /^http:\/\/localhost(:\d+)?$/.test(v) },
  { name: "STRIPE_SECRET_KEY", secret: true, required: (m) => m.web === "sandbox", valid: (v) => /^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(v) },
  { name: "STRIPE_WEBHOOK_SECRET", secret: true, required: (m) => m.web === "sandbox", valid: (v) => /^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(v) },
  { name: "STRIPE_API_VERSION", secret: false, required: () => false, valid: (v) => /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(v) },
  { name: "GOOGLE_PLAY_PACKAGE_NAME", secret: false, required: (m) => m.stores === "sandbox", valid: (v) => v === "com.esblu.app" },
  { name: "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", secret: true, required: (m) => m.stores === "sandbox", valid: (v) => { try { const j = JSON.parse(v) as Record<string, unknown>; return typeof j.client_email === "string" && typeof j.private_key === "string"; } catch { return false; } } },
  { name: "GOOGLE_RTDN_AUDIENCE", secret: false, required: (m) => m.stores === "sandbox", valid: (v) => /^https:\/\//.test(v) },
  { name: "GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL", secret: false, required: (m) => m.stores === "sandbox", valid: (v) => /^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(v) },
  { name: "APPLE_BUNDLE_ID", secret: false, required: () => false, valid: (v) => v === "com.esblu.app" },
  { name: "APPLE_IAP_KEY_ID", secret: false, required: (m) => m.stores === "sandbox", valid: (v) => /^[A-Z0-9]{10}$/.test(v) },
  { name: "APPLE_IAP_ISSUER_ID", secret: false, required: (m) => m.stores === "sandbox", valid: (v) => /^[0-9a-f-]{36}$/i.test(v) },
  { name: "APPLE_IAP_PRIVATE_KEY", secret: true, required: (m) => m.stores === "sandbox", valid: (v) => v.includes("BEGIN PRIVATE KEY") },
  { name: "APPLE_ROOT_CA_SHA256", secret: false, required: (m) => m.stores === "sandbox", valid: (v) => /^[0-9a-f]{64}(,[0-9a-f]{64})*$/i.test(v) },
  { name: "CRON_SECRET", secret: true, required: (m) => m.web !== "disabled" || m.stores !== "disabled", valid: (v) => v.length >= 16 },
];

/** Fail-closed validácia: vráti iba NÁZVY premenných a typ problému. */
export function validateBillingEnv(env: Env = process.env): { modes: ProviderModes; missing: string[]; invalid: string[]; ok: boolean } {
  const modes = resolveProviderModes(env);
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const rule of BILLING_ENV_SCHEMA) {
    const value = (env[rule.name] ?? "").trim();
    if (!value) {
      if (rule.required(modes)) missing.push(rule.name);
      continue;
    }
    if (!rule.valid(value)) invalid.push(rule.name);
  }
  // Live kľúč omylom v prostredí = vždy chyba (aj keď by sa nepoužil).
  if (/^(sk|rk)_live_/.test((env.STRIPE_SECRET_KEY ?? "").trim())) invalid.push("STRIPE_SECRET_KEY:LIVE_FORBIDDEN");
  return { modes, missing, invalid, ok: missing.length === 0 && invalid.length === 0 && !modes.issues.includes("LIVE_NOT_APPROVED") };
}
