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
// VRSTVY (matchPartnersByName) — prvá, ktorá niečo nájde, rozhoduje
// ------------------------------------------------------------------
//   exact / strong  kanonický kľúč (diakritika, veľkosť, interpunkcia,
//                   právna forma, medzera pri číslici) — výber, ak je jediný
//   strong (hlas)   pomlčky/lomky a vyslovená právna forma na konci
//                   („es er ó", „gé em bé há") — výber, ak je jediný
//   suggestion      vyslovená číslovka („Tester jeden"), čiastočný názov,
//                   podobnosť (preklep / prepis reči) — VŽDY iba otázka
//
// Podobnosť (edit distance nad fonetickým kľúčom) nikdy nevyberá sama: iba
// jediný jasný kandidát, rovnaké číslice, a asistent sa spýta „Myslíte …?".
// Zlý odberateľ na faktúre je chyba, ktorá sa ťahá do všetkých ďalších
// dokladov — keď si appka nie je istá, pýta sa, aj keď je kandidát jeden.
// Žiadne konkrétne mená firiem v kóde: algoritmus je všeobecný.
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

/**
 * Vyslovené právne formy na KONCI názvu („… es er ó", „… gé em bé há").
 * Iba na konci — uprostred názvu by „a es" mohlo byť obsahom mena.
 * Hodnota sa porovnáva po odstránení diakritiky a malými písmenami.
 */
const SPOKEN_LEGAL_FORM_SUFFIX =
  /\s+(?:es\s*er\s*o|spol(?:ocnost)?\s+s\s+rucenim\s+obmedzenym|ge\s*em\s*be\s*ha|a\s*es|ka\s*es|a\s*ge|el\s*te\s*de|sro|gmbh|as|ag)\s*$/;

/**
 * Hlasový kľúč: to isté ako `partnerNameLooseKey`, navyše
 *   - pomlčka, lomka, „&" a „+" = medzera („Ján Novák - Zemné práce" =
 *     „Ján Novák zemné práce"),
 *   - vyslovená právna forma na konci sa odstráni („Stavby Kysuce es er ó").
 *
 * Je to EKVIVALENCIA (symetrická): mení iba zápis, nie slová. Slová sa
 * nikdy nevynechávajú ani nespájajú — „Stavby Kysuce" a „Stavby Kysuce Plus"
 * ostávajú rôzne.
 */
export function partnerNameVoiceKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-‐-―/&+_]/g, " ")
    .replace(/[.,;:()"'!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(SPOKEN_LEGAL_FORM_SUFFIX, "")
    .trim();
  return partnerNameLooseKey(cleaned);
}

/**
 * Fonetický kľúč — VÝHRADNE na návrh „Myslíte …?", nikdy na výber.
 * Pokrýva bežné odchýlky prepisu reči bez slovníka mien: prehlásky
 * prepísané ako „ue/oe/ae", zdvojené písmená, y/i, w/v, ck/k, ph/f, th/t.
 * „Müller Bau" / „Mueller Bau" / „Muler Bau" → „MULERBAU".
 */
export function partnerNamePhoneticKey(value: string | null | undefined): string | null {
  const voice = partnerNameVoiceKey(value);
  if (!voice) return null;
  const key = voice
    .replace(/UE/g, "U")
    .replace(/OE/g, "O")
    .replace(/AE/g, "A")
    .replace(/CK/g, "K")
    .replace(/PH/g, "F")
    .replace(/TH/g, "T")
    .replace(/Y/g, "I")
    .replace(/W/g, "V")
    .replace(/([A-Z])\1+/g, "$1")
    .replace(/\s+/g, "");
  return key === "" ? null : key;
}

/** Číslice v názve — pri podobnosti sa NIKDY nesmú líšiť (Tester1 ≠ Tester2). */
function digitsOf(key: string): string {
  return key.replace(/\D/g, "");
}

/** Levenshteinova vzdialenosť (malé reťazce, názvy firiem). */
function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
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

  // HLASOVÁ EKVIVALENCIA: pomlčky/lomky a vyslovená právna forma na konci
  // („Stavby Kysuce es er ó", „Ján Novák zemné práce"). Mení sa iba zápis,
  // nie slová — preto je to rovnocenné presnej zhode (jediný = výber).
  const voiceWanted = partnerNameVoiceKey(query);
  if (voiceWanted) {
    const voiceHits = rows.filter((row) => partnerNameVoiceKey(nameOf(row)) === voiceWanted);
    if (voiceHits.length > 0) return { tier: "strong", matches: voiceHits, autoResolvable: voiceHits.length === 1 };
  }

  // SPOKEN: „Tester jeden" / „Tester one" / „Tester eins" → číslica.
  // Iba NÁVRH (autoResolvable: false) — prepis reči nie je identita; asistent
  // sa spýta „Myslíte …?". Porovnáva sa celé meno, nie jeho časť.
  const spokenWanted = partnerNameVoiceKey(spokenDigits(query));
  if (spokenWanted && spokenWanted !== voiceWanted) {
    const spokenHits = rows.filter((row) => partnerNameVoiceKey(nameOf(row)) === spokenWanted);
    if (spokenHits.length > 0) return { tier: "suggestion", matches: spokenHits, autoResolvable: false };
  }

  // Čiastočná zhoda — vždy iba ponuka na výber, nikdy rozhodnutie
  // („Stavby" pri „Stavby Kysuce" aj „Stavby Kysuce Plus" → otázka).
  const partialWanted = spokenWanted ?? voiceWanted ?? looseWanted;
  const partialHits = rows.filter((row) => {
    const key = partnerNameVoiceKey(nameOf(row));
    return key !== null && containsWithoutSplittingNumber(key, partialWanted);
  });

  if (partialHits.length > 0) {
    return { tier: "suggestion", matches: partialHits, autoResolvable: false };
  }

  // PODOBNOSŤ (preklep / prepis reči): „Miler Bau" → „Müller Bau GmbH",
  // „Testr1" → „Tester1". Iba pri dostatočne dlhom mene, iba JEDINÝ jasný
  // kandidát (žiadny iný nie je rovnako blízko), číslice sa nesmú líšiť —
  // a vždy len návrh s otázkou, nikdy výber.
  const phoneticWanted = partnerNamePhoneticKey(spokenDigits(query));
  if (phoneticWanted && phoneticWanted.length >= 5) {
    const allowed = phoneticWanted.length >= 10 ? 2 : 1;
    const scored = rows
      .map((row) => {
        const key = partnerNamePhoneticKey(nameOf(row));
        if (!key || digitsOf(key) !== digitsOf(phoneticWanted)) return null;
        return { row, distance: editDistance(key, phoneticWanted) };
      })
      .filter((entry): entry is { row: T; distance: number } => entry !== null && entry.distance <= allowed)
      .sort((a, b) => a.distance - b.distance);
    if (scored.length === 1 || (scored.length > 1 && scored[1].distance > scored[0].distance)) {
      return { tier: "suggestion", matches: [scored[0].row], autoResolvable: false };
    }
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
