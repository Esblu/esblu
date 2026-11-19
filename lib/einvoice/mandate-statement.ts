// =============================================================================
// E-Faktúra — verzia textu elektronického poverenia (mandátu). Zdieľané klient/server.
//
// Text, ktorý používateľ vidí pri aktivácii (checkbox), je i18n kľúč
// EINVOICE_MANDATE_STATEMENT_KEY. Server ho pri udelení mandátu zahashuje
// (SHA-256 nad verziou, jazykom a presným textom) a uloží do einvoice_mandates.
// ZMENA TEXTU V AKOMKOĽVEK JAZYKU = NOVÁ VERZIA (test scripts/einvoice-mandate-tests.ts
// má pripnuté hashe; bez zmeny verzie zlyhá). Klient posiela verziu, ktorú zobrazil;
// iná verzia než aktuálna serverová = 409 MANDATE_STATEMENT_OUTDATED.
// =============================================================================

export const EINVOICE_MANDATE_STATEMENT_VERSION = "efaktura-mandate-2026-11-19";
export const EINVOICE_MANDATE_STATEMENT_KEY = "invoices.einvoice.reception.confirm";

export type MandateScope = "send" | "receive";

/** Z odpovede esblu_einvoice_my_mandate: obsahuje účinný rozsah `scope`? Čokoľvek iné = nie (fail closed). */
export function mandateAllows(data: unknown, scope: MandateScope): boolean {
  const s = data && typeof data === "object" ? (data as { effective_scope?: unknown }).effective_scope : null;
  return Array.isArray(s) && s.includes(scope);
}
