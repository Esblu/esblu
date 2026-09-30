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
//   ESBLU_EFAKTURA_WEBHOOK_SECRET(S) = whsec_… (čiarkou oddelené pri rotácii)
// =============================================================================

export type EinvoiceRuntimeConfig = { provider: EinvoiceProvider; environment: EinvoiceEnvironment } | null;

export function getEinvoiceProvider(env: Record<string, string | undefined> = process.env): EinvoiceRuntimeConfig {
  assertServerOnly();
  const providerName = env.ESBLU_EINVOICE_PROVIDER?.trim();
  const environment = env.ESBLU_EINVOICE_ENVIRONMENT?.trim();
  if (!providerName) return null;
  if (environment !== "sandbox" && environment !== "live") return null;

  if (providerName === "efaktura_sk") {
    const apiKey = env.ESBLU_EFAKTURA_API_KEY?.trim();
    if (!apiKey) return null;
    return { provider: new EfakturaSkProvider({ apiKey, environment }), environment };
  }
  return null;
}

/** Webhook tajomstvá (rotácia = viac hodnôt). Nikdy sa nelogujú. */
export function getEfakturaWebhookSecrets(env: Record<string, string | undefined> = process.env): string[] {
  assertServerOnly();
  const raw = env.ESBLU_EFAKTURA_WEBHOOK_SECRETS ?? env.ESBLU_EFAKTURA_WEBHOOK_SECRET ?? "";
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
