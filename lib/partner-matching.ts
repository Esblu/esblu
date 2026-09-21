// =============================================================================
// Zhoda obchodného partnera podľa NÁZVU.
//
// PREČO TENTO SÚBOR VZNIKOL
// -------------------------
// Reálny test na mobile: partner v databáze sa volá „Tester1", prepis reči
// vrátil „Tester 1", a appka odpovedala, že takého odberateľa nepozná.
// Príčina bola v tom, že hlasový resolver porovnával `includes()` nad
// reťazcom, z ktorého sa odstránila iba diakritika a veľkosť písmen —
// medzera medzi písmenom a číslicou zostala, takže „tester1" a „tester 1"
// boli dva rôzne reťazce.
//
// Rozpoznávač reči medzeru pri číslici pridáva a uberá bežne. Nie je to
// preklep používateľa, je to vlastnosť prepisu. Preto sa to rieši
// normalizáciou, nie tým, že by používateľ musel hovoriť inak.
//
// PREČO TO NIE JE ĎALŠÍ MATCHER
// -----------------------------
// Kanonický názov firmy už v appke existuje — `normalizeCompanyName()` v
// lib/invoicing/supplier-matching.ts, ktorý rieši diakritiku, interpunkciu,
// viacnásobné medzery a právne formy. Tento súbor ho POUŽÍVA a pridáva nad
// ním jednu jedinú vec navyše. Druhá, samostatná definícia toho, čo je
// „rovnaký názov firmy", by sa časom rozišla — a rozišla by sa práve tam,
// kde na tom záleží: pri zakladaní dokladu.
//
// ČO SA NEROBÍ
// ------------
// Nezavádza sa podobnostné porovnávanie (Levenshtein a spol.) ani žiadny
// automatický výber „najbližšieho" partnera. Zlý odberateľ na faktúre je
// chyba, ktorá sa ťahá do všetkých ďalších dokladov a do právne záväzného
// výstupu. Keď si appka nie je istá, pýta sa — aj keď je kandidát len
// jeden.
// =============================================================================

/**
 * Právne formy, ktoré sa z názvu odstraňujú pred porovnaním.
 *
 * Je to najčastejší zdroj falošného nezhodnutia („Stavby s.r.o." vs.
 * „Stavby, s. r. o."). Zároveň je to presne dôvod, prečo samotné meno nikdy
 * nestačí na automatický výber pri párovaní dodávateľa — po odstránení
 * formy môžu splynúť dve rôzne firmy.
 *
 * Presunuté sem z lib/invoicing/supplier-matching.ts BEZ ZMENY obsahu;
 * supplier matching odtiaľto importuje, takže definícia je jedna.
 */
const LEGAL_FORM_PATTERN =
  /\b(s\s?r\s?o|spol\s?s\s?r\s?o|a\s?s|k\s?s|v\s?o\s?s|gmbh|ag|ug|kg|ohg|mbh|ltd|llc|inc|plc|sp\s?z\s?o\s?o|zo|se)\b/g;

/**
 * Prísny kanonický kľúč — presne to, čo appka považuje za ten istý názov
 * pri párovaní dodávateľov. Bez diakritiky, bez interpunkcie, bez právnej
 * formy, jednotné medzery. „Stavby, s. r. o." → „STAVBY".
 */
export function partnerNameExactKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,;:()"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEGAL_FORM_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return normalized === "" ? null : normalized;
}

/**
 * Voľnejší kľúč: navyše zlúči oddeľovač MEDZI PÍSMENOM A ČÍSLICOU.
 *
 *   „Tester 1"  → TESTER1
 *   „Tester-1"  → TESTER1
 *   „ABC 123"   → ABC123
 *   „Firma-24"  → FIRMA24
 *
 * Kľúčové obmedzenie: oddeľovač sa odstraňuje IBA na hranici písmeno↔číslica.
 * Medzery medzi slovami zostávajú nedotknuté — „Test Supplier Alpha" sa
 * nikdy nezmení na „TESTSUPPLIERALPHA". Plošné odstránenie medzier by
 * zlúčilo názvy, ktoré spolu nesúvisia, a práve to je hranica medzi
 * „toleruje prepis reči" a „háda".
 *
 * Číslice sa nespájajú navzájom: „Tester 11" ostáva odlišné od „Tester1"
 * aj od „Tester 1 1".
 */
export function partnerNameLooseKey(value: string | null | undefined): string | null {
  const exact = partnerNameExactKey(value);
  if (!exact) return null;

  const collapsed = exact
    // písmeno, oddeľovač, číslica
    .replace(/(?<=[A-Z])[\s\-_]+(?=\d)/g, "")
    // číslica, oddeľovač, písmeno
    .replace(/(?<=\d)[\s\-_]+(?=[A-Z])/g, "");

  return collapsed === "" ? null : collapsed;
}

// -----------------------------------------------------------------------------
// Úrovne istoty
// -----------------------------------------------------------------------------

/**
 * Ako silná zhoda to je.
 *
 *   exact       kanonické názvy sú zhodné
 *   strong      zhodné po zlúčení oddeľovača pri číslici (prepis reči)
 *   suggestion  názov je len obsiahnutý v inom — NÁVRH, nikdy výber
 *   none        nič
 *
 * `exact` a `strong` sú EKVIVALENCIE: sú symetrické a nezávisia od toho,
 * ktorý reťazec je dopyt. `suggestion` ekvivalencia nie je — „Tester" je
 * obsiahnuté v „Tester1" aj v „Tester2" — a preto z nej nikdy nesmie
 * vzniknúť automatický výber.
 */
export type PartnerMatchTier = "exact" | "strong" | "suggestion" | "none";

export type PartnerNameMatch<T> = {
  tier: PartnerMatchTier;
  matches: T[];
  /**
   * Smie sa použiť bez pýtania?
   *
   * `true` VÝHRADNE keď je zhoda ekvivalenciou (exact/strong) a kandidát
   * je práve jeden. Pri návrhu je `false` aj pri jedinom kandidátovi —
   * jediný podobný názov nie je to isté ako správny názov.
   */
  autoResolvable: boolean;
};

/**
 * Nájde partnerov zodpovedajúcich vyslovenému/napísanému názvu.
 *
 * Postupuje po úrovniach a vráti PRVÚ, ktorá niečo našla. Nemieša ich:
 * keby sa výsledky zlúčili, jedna presná zhoda by sa utopila medzi piatimi
 * čiastočnými a používateľ by dostal zbytočnú otázku.
 *
 * `nameOf` umožňuje volať funkciu nad ľubovoľným tvarom riadka (hlasový
 * resolver pracuje s úzkym výberom stĺpcov, iné miesta s celým partnerom).
 */
export function matchPartnersByName<T>(
  query: string,
  rows: readonly T[],
  nameOf: (row: T) => string | null | undefined
): PartnerNameMatch<T> {
  const exactWanted = partnerNameExactKey(query);
  const looseWanted = partnerNameLooseKey(query);
  if (!exactWanted || !looseWanted) {
    return { tier: "none", matches: [], autoResolvable: false };
  }

  // Trieda ekvivalencie sa počíta na VOĽNEJŠOM kľúči, a to aj pre presnú
  // zhodu. Je to zámer: keď firma má partnerov „Tester1" aj „Tester 1
  // s.r.o.", vyslovené „Tester 1" sedí na oboch rovnako dobre. Vybrať ten,
  // ktorý sa náhodou zhoduje aj znak po znaku, by vyzeralo ako istota,
  // hoci by to bola zhoda okolností v zápise.
  const looseHits = rows.filter((row) => partnerNameLooseKey(nameOf(row)) === looseWanted);

  if (looseHits.length > 0) {
    const hasExact = looseHits.some((row) => partnerNameExactKey(nameOf(row)) === exactWanted);
    return {
      tier: hasExact ? "exact" : "strong",
      matches: looseHits,
      autoResolvable: looseHits.length === 1,
    };
  }

  // Čiastočná zhoda — vždy iba ponuka na výber, nikdy rozhodnutie.
  const partialHits = rows.filter((row) => {
    const key = partnerNameLooseKey(nameOf(row));
    return key !== null && containsWithoutSplittingNumber(key, looseWanted);
  });

  if (partialHits.length > 0) {
    return { tier: "suggestion", matches: partialHits, autoResolvable: false };
  }

  return { tier: "none", matches: [], autoResolvable: false };
}

/**
 * Obsahuje `haystack` reťazec `needle` tak, že sa pritom NEROZREŽE číslo?
 *
 * Toto pravidlo je celý rozdiel medzi užitočným návrhom a nebezpečným:
 *
 *   „TESTER"  v „TESTER1"   → áno. Používateľ povedal kratší názov.
 *   „TESTER1" v „TESTER11"  → NIE. Jednotka a jedenástka sú iné firmy;
 *                             ponúknuť Tester11 na povel „Tester1" by
 *                             viedlo k faktúre na nesprávnu firmu.
 *   „TESTER1" v „TESTER1 BAU" → áno, číslo zostalo celé.
 *
 * Inými slovami: zhoda sa nesmie začínať ani končiť uprostred súvislej
 * postupnosti číslic.
 */
function containsWithoutSplittingNumber(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;

    const before = at > 0 ? haystack[at - 1] : "";
    const after = haystack[at + needle.length] ?? "";

    const cutsNumberAtStart = /\d/.test(before) && /\d/.test(needle[0]);
    const cutsNumberAtEnd = /\d/.test(after) && /\d/.test(needle[needle.length - 1]);

    if (!cutsNumberAtStart && !cutsNumberAtEnd) return true;
    from = at + 1;
  }
}
