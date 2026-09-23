// =============================================================================
// Chyby odovzdania účtovníkovi — jeden zoznam, ktorý platí pre kód aj preklady.
//
// PREČO TENTO SÚBOR EXISTUJE
// --------------------------
// Dôvody zlyhania vznikali priamo v route ako voľné reťazce a preklad sa
// skladal šablónou `handoff.errors.package.${reason}`. Kým reťazec a kľúč
// sedeli, fungovalo to; keď nesedeli, používateľ dostal do tváre
//
//     handoff.errors.package.missing_original_document
//
// Presne to sa v produkcii stalo — chybové kľúče skončili pri predchádzajúcej
// úprave v nesprávnom bloku slovníka a nikto si to nevšimol, lebo nič
// nespadlo. Chyba, ktorá sa zobrazí ako názov premennej, je horšia než žiadna
// hláška: používateľ nevie, čo sa stalo, ani čo s tým.
//
// Odteraz je zoznam dôvodov TU a test ho porovnáva so všetkými tromi
// slovníkmi. Nový dôvod bez prekladu neprejde testom, nie až produkciou.
//
// Modul nemá importy, takže ten istý zoznam beží v appke aj v teste.
// =============================================================================

/**
 * Strojovo čitateľné kódy. Toto je to, čo chodí po sieti a čo sa loguje —
 * nie preložený text.
 *
 * Front-end sa NIKDY nerozhoduje podľa anglickej vety. Porovnáva kód.
 * Preložený text je iba na čítanie pre človeka a smie sa kedykoľvek zmeniť
 * bez toho, aby sa čokoľvek rozbilo.
 */
export const HANDOFF_ERROR_CODES = [
  // --- vstup a oprávnenia
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NO_ACTIVE_COMPANY",
  "NO_DOCUMENTS_SELECTED",
  "NO_FINALIZED_DOCUMENTS",
  "NOT_ELIGIBLE",
  "TOO_MANY_INVOICES",

  // --- chýbajúce alebo pokazené podklady
  "MISSING_ORIGINAL_DOCUMENT",
  "MISSING_SUPPORTING_DOCUMENT",
  "MISSING_ATTACHMENT",
  "MISSING_SELLER_SNAPSHOT",
  "ORIGINAL_HASH_MISMATCH",
  "UNKNOWN_DIRECTION",
  "INVALID_FINANCIAL_TOTALS",

  // --- výroba balíka
  "PDF_GENERATION_FAILED",
  "DUPLICATE_PATH",
  "UNSAFE_PATH",
  "EMPTY_PACKAGE",
  "TOO_MANY_FILES",
  "PACKAGE_TOO_LARGE",
  "FILE_TOO_LARGE",
  "PACKAGE_VERIFICATION_FAILED",
  "RECORD_FAILED",

  // --- posledná inštancia
  "INTERNAL_ERROR",
] as const;

export type HandoffErrorCode = (typeof HANDOFF_ERROR_CODES)[number];

/**
 * Vnútorné dôvody → kódy.
 *
 * Vnútorné dôvody sú podrobnejšie než to, čo má zmysel hovoriť používateľovi:
 * „chýba súbor v ZIP-e" a „nesedí odtlačok" sú pre neho tá istá veta („balík
 * sa nepodarilo overiť"), ale v logu sa líšia a to je dobre.
 */
const REASON_TO_CODE: Record<string, HandoffErrorCode> = {
  missing_original_document: "MISSING_ORIGINAL_DOCUMENT",
  missing_supporting_document: "MISSING_SUPPORTING_DOCUMENT",
  missing_attachment: "MISSING_ATTACHMENT",
  missing_seller_snapshot: "MISSING_SELLER_SNAPSHOT",
  original_hash_mismatch: "ORIGINAL_HASH_MISMATCH",
  unknown_direction: "UNKNOWN_DIRECTION",
  pdf_generation_failed: "PDF_GENERATION_FAILED",
  duplicate_path: "DUPLICATE_PATH",
  unsafe_path: "UNSAFE_PATH",
  empty_package: "EMPTY_PACKAGE",
  too_many_invoices: "TOO_MANY_INVOICES",
  too_many_files: "TOO_MANY_FILES",
  package_too_large: "PACKAGE_TOO_LARGE",
  file_too_large: "FILE_TOO_LARGE",
  // Tri rôzne vnútorné príčiny, pre používateľa jedna veta.
  verification_missing_file: "PACKAGE_VERIFICATION_FAILED",
  verification_hash_mismatch: "PACKAGE_VERIFICATION_FAILED",
  verification_missing_manifest: "PACKAGE_VERIFICATION_FAILED",
  unexpected_error: "INTERNAL_ERROR",
};

/** Kód pre vnútorný dôvod. Neznámy dôvod nikdy nespadne — je to INTERNAL_ERROR. */
export function handoffErrorCode(reason: string): HandoffErrorCode {
  return REASON_TO_CODE[reason] ?? "INTERNAL_ERROR";
}

/** Prekladový kľúč pre kód. */
export function handoffErrorKey(code: string): string {
  return `handoff.errors.code.${code}`;
}

/**
 * Kľúč, ktorý sa použije, keď preklad pre konkrétny kód chýba.
 *
 * Je to poistka, nie výhovorka: keď preklad existuje, použije sa on. Táto
 * veta nastúpi iba vtedy, keď by inak používateľ videl názov premennej.
 */
export const HANDOFF_GENERIC_ERROR_KEY = "handoff.errors.genericPackageFailure";

/**
 * Je to platný kód? Používa sa na vstupe do UI, aby sa z odpovede servera
 * nedalo vyrobiť ľubovoľný prekladový kľúč.
 */
export function isHandoffErrorCode(value: unknown): value is HandoffErrorCode {
  return (
    typeof value === "string" &&
    (HANDOFF_ERROR_CODES as readonly string[]).includes(value)
  );
}
