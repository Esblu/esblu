// =============================================================================
// Esblu — Company lookup: normalizácia vstupu a registrových hodnôt.
// =============================================================================
// Čisté funkcie bez importov (klient aj server, testovateľné v Node).
//
// Zásady:
//   - IČO kanonicky 8 číslic (registre ho tak vedú, napr. "00151742"),
//   - DIČ kanonicky 10 číslic, inak null,
//   - kontrolná číslica IČO je IBA varovanie — staršie/špeciálne IČO ju
//     nemusia spĺňať a register je autorita, nie náš algoritmus,
//   - registrové texty sa iba bezpečne očistia (riadiace znaky, nadbytočné
//     medzery, dĺžka). Žiadne "opravy" obsahu, preklepy ani formátovanie
//     PSČ — čo je v registri, to sa zobrazí.
// =============================================================================

export const NAME_QUERY_MIN_LENGTH = 3;
export const NAME_QUERY_MAX_LENGTH = 100;
export const ICO_QUERY_MIN_DIGITS = 6;
export const SEARCH_RESULT_LIMIT = 10;

const MAX_TEXT_LENGTH = 300;

/** Odstráni riadiace a neviditeľné formátovacie znaky, zlúči whitespace. */
export function cleanRegistryText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFC")
    // C0/C1 riadiace znaky, zero-width a bidi override znaky.
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

/**
 * Kanonické IČO (8 číslic) z používateľského vstupu alebo registra.
 * Povolené sú iba číslice a medzery (napr. "31 322 832"). 6–8 číslic sa
 * doplní nulami zľava (registre vedú IČO s úvodnými nulami). Inak null.
 */
export function canonicalIco(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[\d ]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/ /g, "");
  if (digits.length < ICO_QUERY_MIN_DIGITS || digits.length > 8) return null;
  const padded = digits.padStart(8, "0");
  return padded === "00000000" ? null : padded;
}

/** Kontrolná číslica IČO (mod 11, váhy 8..2). Iba informatívne. */
export function icoChecksumValid(ico: string): boolean {
  if (!/^\d{8}$/.test(ico)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += Number(ico[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ico[7]);
}

/** Kanonické DIČ: presne 10 číslic (medzery povolené na vstupe), inak null. */
export function canonicalDic(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/ /g, "").trim();
  return /^\d{10}$/.test(digits) ? digits : null;
}

export type ParsedLookupQuery =
  | { kind: "ico"; ico: string }
  | { kind: "name"; name: string }
  | { kind: "error"; code: "QUERY_TOO_SHORT" | "INVALID_QUERY" | "INVALID_ICO" };

/**
 * Interpretácia jedného vyhľadávacieho poľa: čisto číselný vstup (s
 * medzerami) je IČO, čokoľvek iné je názov.
 */
export function parseLookupQuery(raw: unknown): ParsedLookupQuery {
  if (typeof raw !== "string") return { kind: "error", code: "INVALID_QUERY" };
  const trimmed = raw.trim();
  if (/^[\d ]+$/.test(trimmed) && trimmed.length > 0) {
    const digits = trimmed.replace(/ /g, "");
    if (digits.length < ICO_QUERY_MIN_DIGITS) return { kind: "error", code: "QUERY_TOO_SHORT" };
    const ico = canonicalIco(trimmed);
    return ico ? { kind: "ico", ico } : { kind: "error", code: "INVALID_ICO" };
  }
  const name = cleanRegistryText(trimmed, NAME_QUERY_MAX_LENGTH + 1);
  if (!name || name.length < NAME_QUERY_MIN_LENGTH) return { kind: "error", code: "QUERY_TOO_SHORT" };
  if (name.length > NAME_QUERY_MAX_LENGTH) return { kind: "error", code: "INVALID_QUERY" };
  return { kind: "name", name };
}

/** Porovnávací kľúč bez diakritiky a veľkosti písmen (iba na radenie). */
export function foldForCompare(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Ochrana dátumov z registra: iba YYYY-MM-DD, inak null. */
export function isoDateOrNull(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
