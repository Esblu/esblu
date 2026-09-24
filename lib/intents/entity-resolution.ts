// =============================================================================
// Rozlíšenie mena entity z prirodzenej reči — zdieľané pre sklad, stroje,
// vozidlá (a čítanie cez lib/entity-search.ts).
//
// PREČO
// -----
// Slovenčina skloňuje: „Kotúč na asfalt" zaznie ako „kotúča na asfalt",
// „kotúčom na asfalt"; „Bager CAT" ako „bagra CAT". Presné porovnanie potom
// nenájde nič a asistent povie „Nič sa nenašlo".
//
// VRSTVY (od najistejšej)
//   1. exact      — rovnaké meno po normalizácii (veľkosť písmen,
//                   diakritika, medzery, interpunkcia)
//   2. inflected  — rovnaké meno po odstránení pádových koncoviek KAŽDÉHO
//                   slova (rovnaký počet slov, rovnaké poradie)
//   3. partial    — predpona slova (pôvodné správanie pre čítanie a
//                   nedeštruktívne zápisy, napr. „vrutov" → „Vruty")
//
// Žiadna štatistika, žiadny Levenshtein. O NEBEZPEČNEJ akcii (mazanie)
// rozhoduje volajúci: iná než `exact` zhoda sa používateľovi iba ponúkne
// („Myslíte …?") a potvrdí; viac kandidátov = výber, nikdy tip.
// =============================================================================

export type NameConfidence = "exact" | "inflected" | "partial";

export type NameResolution<T> =
  | { match: T; confidence: NameConfidence }
  | { ambiguous: T[] }
  | { none: true };

/** Veľkosť písmen, diakritika, interpunkcia a medzery nerozhodujú. */
export function normalizeEntityKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Pádové koncovky (SK/CZ), najdlhšie prvé. Slovo musí po odstránení mať
// aspoň 3 znaky; slová s číslicou a krátke slová sa nemenia.
const CASE_ENDINGS = ["iach", "ami", "ach", "ovi", "om", "ou", "ov", "mi", "a", "u", "e", "y", "i"];

/** Kmeň jedného slova: bez pádovej koncovky a bez pohyblivého „e" (bager/bagra). */
export function tokenStem(token: string): string {
  let stem = token;
  if (stem.length < 4 || /\d/.test(stem)) return stem;
  for (const ending of CASE_ENDINGS) {
    if (stem.endsWith(ending) && stem.length - ending.length >= 3) {
      stem = stem.slice(0, -ending.length);
      break;
    }
  }
  // Pohyblivé „e" pred poslednou spoluhláskou: bager → bagr (= bagra, bagrom).
  if (stem.length >= 4) stem = stem.replace(/([^aeiouy])e([^aeiouy])$/, "$1$2");
  return stem;
}

/** Meno bez skloňovania — porovnáva sa celé, slovo po slove. */
export function inflectionKey(value: string | null | undefined): string {
  return normalizeEntityKey(value).split(" ").filter(Boolean).map(tokenStem).join(" ");
}

function stemPrefixVariants(key: string): string[] {
  const variants = new Set([key]);
  for (const ending of ["ami", "ovi", "ov", "om", "ou", "ach", "u", "a", "y", "e", "i"]) {
    if (key.length - ending.length >= 3 && key.endsWith(ending)) variants.add(key.slice(0, -ending.length));
  }
  return Array.from(variants);
}

export function resolveEntityByName<T>(
  rows: readonly T[],
  spoken: string,
  nameOf: (row: T) => string | null | undefined
): NameResolution<T> {
  const key = normalizeEntityKey(spoken);
  if (!key) return { none: true };

  const exact = rows.filter((row) => normalizeEntityKey(nameOf(row)) === key);
  if (exact.length === 1) return { match: exact[0], confidence: "exact" };
  if (exact.length > 1) return { ambiguous: exact };

  const inflected = inflectionKey(spoken);
  const byStem = rows.filter((row) => inflectionKey(nameOf(row)) === inflected);
  if (byStem.length === 1) return { match: byStem[0], confidence: "inflected" };
  if (byStem.length > 1) return { ambiguous: byStem };

  const variants = stemPrefixVariants(key);
  const partial = rows.filter((row) => {
    const name = normalizeEntityKey(nameOf(row));
    return variants.some((variant) => name.startsWith(variant) || name.split(" ").some((word) => word.startsWith(variant)));
  });
  if (partial.length === 1) return { match: partial[0], confidence: "partial" };
  if (partial.length > 1) return { ambiguous: partial };
  return { none: true };
}
