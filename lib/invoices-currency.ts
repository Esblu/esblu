// =============================================================================
// Kód meny v tvare, v akom sa smie ULOŽIŤ.
//
// PREČO JE TO SAMOSTATNÝ SÚBOR
// ----------------------------
// Bez importov, takže to isté pravidlo sa dá odskúšať v obyčajnom Node —
// rovnaký dôvod ako pri lib/sanitize-filename.ts a lib/invoicing/price-mode.ts.
// `lib/invoices.ts` ho re-exportuje, takže volajúci sa nemenia.
//
// ČO SA STALO
// -----------
// Do produkcie sa cez formulár dostalo „EUR " s medzerou na konci.
// `Intl.NumberFormat` na neplatný kód meny nereaguje náhradnou hodnotou, ale
// `RangeError` — a modul Faktúry prestal ísť otvoriť.
//
// Zobrazenie je proti tomu odolné (lib/i18n/format.ts), ale odolné
// zobrazenie nie je dôvod ukladať nezmysel.
// =============================================================================

/**
 * Orezanie a veľké písmená. „eur", „EUR " aj „ eur " znamenajú to isté a
 * ukladá sa z nich to isté.
 *
 * Čo tri písmená nedá, sa NEODHADUJE a neprepisuje na „EUR" — uloží sa
 * orezané tak, ako to človek napísal. Vymyslieť menu za používateľa by pri
 * peniazoch bolo horšie než nechať ju divnú: divnú je vidieť a dá sa
 * opraviť, vymyslená sa tvári správne.
 */
export function normalizeCurrency(raw: string): string {
  const trimmed = (raw ?? "").trim();
  return /^[A-Za-z]{3}$/.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}
