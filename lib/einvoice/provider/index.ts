import "server-only";

import { EfakturaSkProvider } from "./efaktura-sk.ts";
import { assertServerOnly, type EinvoiceEnvironment, type EinvoiceProvider } from "./types.ts";

// =============================================================================
// Výber poskytovateľa — SERVER-ONLY. Kľúč sa číta iba z env servera
// (nikdy NEXT_PUBLIC_*). Kým env nie je nastavené, vráti null a volajúci
// musí odpovedať „E-Faktúra nie je nakonfigurovaná" — žiadny fallback na mock
// v produkčnom kóde (mock je iba pre testy, importuje sa priamo).
//
// Premenné (zatiaľ NENASTAVENÉ v žiadnom prostredí):
//   ESBLU_EINVOICE_PROVIDER      = efaktura_sk
//   ESBLU_EINVOICE_ENVIRONMENT   = sandbox | live
//   ESBLU_EFAKTURA_API_KEY       = efk_pk_test_… / efk_pk_live_…
//   ESBLU_EFAKTURA_BASE_URL      = voliteľné, default https://api.efaktura.sk
//                                  (sandbox aj live — prostredie určuje prefix kľúča)
//   ESBLU_EFAKTURA_WEBHOOK_SECRET(S) = whsec_… (čiarkou oddelené pri rotácii)
//
// Phase 6 — živé prostredie (live) sa NEAKTIVUJE iba chybou v env. Okrem
// ESBLU_EINVOICE_ENVIRONMENT=live a live kľúča (prefix efk_pk_live_) musí
// platiť aj:
//   ESBLU_EINVOICE_LIVE_ENABLED = "true"       (explicitné potvrdenie)
//   VERCEL_ENV                  = "production" (nikdy preview / lokálne)
// Inak → null (= nenakonfigurované, fail-closed). Ďalšie nezávislé brány:
// einvoice_rollout (company + environment) a einvoice_organizations (environment).
// =============================================================================

export type EinvoiceRuntimeConfig = { provider: EinvoiceProvider; environment: EinvoiceEnvironment } | null;

export function getEinvoiceProvider(env: Record<string, string | undefined> = process.env): EinvoiceRuntimeConfig {
  assertServerOnly();
  const providerName = env.ESBLU_EINVOICE_PROVIDER?.trim();
  const environment = env.ESBLU_EINVOICE_ENVIRONMENT?.trim();
  if (!providerName) return null;
  if (environment !== "sandbox" && environment !== "live") return null;
  if (environment === "live" && (env.ESBLU_EINVOICE_LIVE_ENABLED?.trim() !== "true" || env.VERCEL_ENV?.trim() !== "production")) {
    return null;
  }

  if (providerName === "efaktura_sk") {
    const apiKey = env.ESBLU_EFAKTURA_API_KEY?.trim();
    if (!apiKey) return null;
    // Voliteľné; default https://api.efaktura.sk. Host je overený voči allowlistu.
    const baseUrl = env.ESBLU_EFAKTURA_BASE_URL?.trim() || undefined;
    return { provider: new EfakturaSkProvider({ apiKey, environment, baseUrl }), environment };
  }
  return null;
}

/** Webhook tajomstvá (rotácia = viac hodnôt). Nikdy sa nelogujú. */
export function getEfakturaWebhookSecrets(env: Record<string, string | undefined> = process.env): string[] {
  assertServerOnly();
  const raw = env.ESBLU_EFAKTURA_WEBHOOK_SECRETS ?? env.ESBLU_EFAKTURA_WEBHOOK_SECRET ?? "";
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
