// =============================================================================
// Kategórie DPH — jediný zdroj pravdy.
//
// Presunuté z lib/invoicing/vat-engine.ts BEZ ZMENY obsahu. Dôvod je
// praktický: vat-engine ťahá decimal.js a ďalšie moduly, takže sa nedá
// načítať tam, kde treba len overiť, či je „S" platná kategória. Tento
// súbor NEMÁ žiadne importy, takže ho môže použiť ktorákoľvek vrstva —
// vrátane testov, ktoré bežia priamo v Node.
//
// Allowlist je zhodný s CHECK constraintom na `invoice_items.
// vat_category_code` aj `invoice_tax_breakdowns` v produkčnej databáze.
// Nová kategória sa pridáva SEM a do migrácie, nikde inde.
// =============================================================================

// K (intrakomunitárne dodanie), G (vývoz mimo EÚ) a O (mimo predmetu DPH —
// typicky neplatiteľ DPH) pribudli v migrácii 20261002110000 (EN16931 / Peppol).
// Finalizácia ich počíta ako 0 % (sadzbu berie iba pre S). AI sken a príjem
// prijatých faktúr ich zatiaľ neprijímajú (vlastné allowlisty S/Z/E/AE).
export type VatCategoryCode = "S" | "Z" | "E" | "AE" | "K" | "G" | "O";

export const VAT_CATEGORY_CODES: readonly VatCategoryCode[] = ["S", "Z", "E", "AE", "K", "G", "O"];

/** Kategórie, ktoré prijíma esblu_create_received_invoice_draft (zatiaľ bez K/G/O). */
export const RECEIVED_VAT_CATEGORY_CODES: readonly VatCategoryCode[] = ["S", "Z", "E", "AE"];

export function isVatCategoryCode(value: string): value is VatCategoryCode {
  return (VAT_CATEGORY_CODES as readonly string[]).includes(value);
}
