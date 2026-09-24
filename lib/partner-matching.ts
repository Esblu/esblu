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
  // SPOKEN: „Tester jeden" / „Tester one" / „Tester eins" = „Tester1".
  // Iba NÁVRH (autoResolvable: false) — prepis reči nie je identita; asistent
  // sa spýta „Myslíte …?". Porovnáva sa celé meno, nie jeho časť.
  const spokenWanted = partnerNameLooseKey(spokenDigits(query));
  if (spokenWanted && spokenWanted !== looseWanted) {
    const spokenHits = rows.filter((row) => partnerNameLooseKey(nameOf(row)) === spokenWanted);
    if (spokenHits.length > 0) return { tier: "suggestion", matches: spokenHits, autoResolvable: false };
  }

  const partialHits = rows.filter((row) => {
    const key = partnerNameLooseKey(nameOf(row));
    return key !== null && containsWithoutSplittingNumber(key, looseWanted);
  });

  if (partialHits.length > 0) {
    return { tier: "suggestion", matches: partialHits, autoResolvable: false };
  }

  // CLOSE: jeden preklep v prepise („Testr1", „Tesster1"). Iba pri dlhších
  // menách, iba JEDINÝ kandidát a vždy len návrh s otázkou.
  const spokenLoose = spokenWanted ?? looseWanted;
  if (spokenLoose.replace(/\s/g, "").length >= 5) {
    const closeHits = rows.filter((row) => {
      const key = partnerNameLooseKey(nameOf(row));
      return key !== null && withinOneEdit(key, spokenLoose);
    });
    if (closeHits.length === 1) return { tier: "suggestion", matches: closeHits, autoResolvable: false };
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

// -----------------------------------------------------------------------------
// Vyslovené číslovky a preklepy prepisu (iba pre NÁVRHY, nikdy automaticky)
// -----------------------------------------------------------------------------

const SPOKEN_DIGITS: Record<string, string> = {
  NULA: "0", JEDEN: "1", JEDNA: "1", JEDNO: "1", DVA: "2", DVE: "2", TRI: "3", STYRI: "4", PAT: "5",
  SEST: "6", SEDEM: "7", OSEM: "8", DEVAT: "9", DESAT: "10",
  ZERO: "0", ONE: "1", TWO: "2", THREE: "3", FOUR: "4", FIVE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9", TEN: "10",
  NULL: "0", EINS: "1", ZWEI: "2", DREI: "3", VIER: "4", FUNF: "5", FUENF: "5", SECHS: "6", SIEBEN: "7", ACHT: "8", NEUN: "9", ZEHN: "10",
};

/** „Tester jeden" → „Tester 1" (celé slová; meno bez číslovky sa nemení). */
export function spokenDigits(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .map((word) => SPOKEN_DIGITS[word.toUpperCase().replace(/[.,;:!?]+$/, "")] ?? word)
    .join(" ");
}

/** Levenshtein ≤ 1 (vloženie, vynechanie alebo zámena jedného znaku). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false; // presnú zhodu riešia vyššie vrstvy
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
