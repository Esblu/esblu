// =============================================================================
// Esblu — parsovanie čísel z prirodzenej reči (SK/CZ/DE/EN).
//
// PREČO EXISTUJE
// --------------
// Prepis reči nesmie skončiť v číselnom stĺpci databázy. "tristo eur" nie
// je číslo a `Number("tristo")` je NaN; "300,50" je v JavaScripte tiež NaN.
// Keby sa niekde použilo `parseFloat(transcript)`, faktúra by ticho vznikla
// so sumou 300 namiesto 300,50 — alebo s NaN, ktoré by DB odmietla až na
// constraint. Preto sa každá suma prekladá TU, deterministicky, a keď sa
// preložiť nedá, vráti sa `null` a asistent sa spýta. Nikdy sa neháda.
//
// PREČO NIE AI
// ------------
// Klasifikáciu zámeru robí model, prevod čísla nie. Číslo má jednu správnu
// hodnotu a overiteľné pravidlá; nechať ho na model znamená pripustiť, že
// sa raz pomýli o rád. Táto vrstva je preto celá deterministická a
// testovateľná.
// =============================================================================

/** Odstráni diakritiku, aby "päťdesiat" aj "patdesiat" viedli k tej istej vetve. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// -----------------------------------------------------------------------------
// Slovné číslovky
// -----------------------------------------------------------------------------
//
// Jeden spoločný slovník pre všetky jazyky. Nie je to nedbalosť — je to
// rovnaké rozhodnutie ako vo zvyšku parsera: jazyk je vstup, nie samostatná
// vetva logiky. Kolízia medzi jazykmi tu nehrozí, lebo žiadne z týchto slov
// neznamená v inom jazyku iné číslo.

/** Jednotky a nepravidelné tvary do 19. */
const UNIT_WORDS: Record<string, number> = {
  nula: 0, null: 0, zero: 0,

  jeden: 1, jedna: 1, jedno: 1, jednu: 1, ein: 1, eine: 1, eins: 1, one: 1,
  dva: 2, dve: 2, dvoch: 2, zwei: 2, zwo: 2, two: 2,
  tri: 3, troch: 3, drei: 3, three: 3,
  styri: 4, styroch: 4, vier: 4, four: 4,
  pat: 5, piatich: 5, funf: 5, fuenf: 5, five: 5,
  sest: 6, siestich: 6, sechs: 6, six: 6,
  sedem: 7, siedmich: 7, sieben: 7, seven: 7,
  osem: 8, osmich: 8, acht: 8, eight: 8,
  devat: 9, deviatich: 9, neun: 9, nine: 9,

  desat: 10, zehn: 10, ten: 10,
  jedenast: 11, elf: 11, eleven: 11,
  dvanast: 12, zwolf: 12, zwoelf: 12, twelve: 12,
  trinast: 13, dreizehn: 13, thirteen: 13,
  strnast: 14, vierzehn: 14, fourteen: 14,
  patnast: 15, funfzehn: 15, fuenfzehn: 15, fifteen: 15,
  sestnast: 16, sechzehn: 16, sixteen: 16,
  sedemnast: 17, siebzehn: 17, seventeen: 17,
  osemnast: 18, achtzehn: 18, eighteen: 18,
  devatnast: 19, neunzehn: 19, nineteen: 19,
};

/** Desiatky. */
const TENS_WORDS: Record<string, number> = {
  dvadsat: 20, zwanzig: 20, twenty: 20,
  tridsat: 30, dreissig: 30, dreisig: 30, thirty: 30,
  styridsat: 40, vierzig: 40, forty: 40,
  patdesiat: 50, funfzig: 50, fuenfzig: 50, fifty: 50,
  sestdesiat: 60, sechzig: 60, sixty: 60,
  sedemdesiat: 70, siebzig: 70, seventy: 70,
  osemdesiat: 80, achtzig: 80, eighty: 80,
  devatdesiat: 90, neunzig: 90, ninety: 90,
};

/** Slovenské zlepené stovky — "tristo" je jedno slovo, nie "tri sto". */
const HUNDRED_WORDS: Record<string, number> = {
  sto: 100, stovka: 100,
  dvesto: 200, tristo: 300, styristo: 400, patsto: 500,
  seststo: 600, sedemsto: 700, osemsto: 800, devatsto: 900,
};

const SCALE_HUNDRED = new Set(["hundert", "hundred"]);
const SCALE_THOUSAND = new Set(["tisic", "tisicka", "tausend", "thousand"]);

/** Spojky, ktoré medzi číslovkami nič neznamenajú ("dreihundertundfünfzig"). */
const FILLER_WORDS = new Set(["a", "und", "and"]);

/**
 * Nemčina píše číslovky ako jedno slovo ("dreihundertfünfzig") a navyše
 * obrátene ("einundzwanzig" = 21). Rozdelí sa preto na najdlhšie známe
 * kúsky zľava a poskladá rovnakým algoritmom ako oddelené slová.
 *
 * Vráti `null`, keď slovo nie je celé poskladateľné zo známych kúskov —
 * radšej nič, než polovičný výsledok z náhodnej zhody podreťazca.
 */
function splitGluedNumberWord(word: string): string[] | null {
  const parts: string[] = [];
  let rest = word;

  const known = [
    ...Object.keys(HUNDRED_WORDS),
    ...Object.keys(TENS_WORDS),
    ...Object.keys(UNIT_WORDS),
    ...SCALE_HUNDRED,
    ...SCALE_THOUSAND,
    ...FILLER_WORDS,
  ].sort((a, b) => b.length - a.length);

  let guard = 0;
  while (rest.length > 0) {
    if (guard++ > 16) return null;
    const match = known.find((candidate) => rest.startsWith(candidate));
    if (!match) return null;
    parts.push(match);
    rest = rest.slice(match.length);
  }

  return parts.length > 1 ? parts : null;
}

/**
 * Poskladá postupnosť číselných slov na jedno číslo.
 *
 * Pracuje s dvoma akumulátormi (bežný a celkový), čo je štandardný spôsob,
 * ako zvládnuť "dvetisíctristopäťdesiat" bez špeciálnych prípadov: násobiče
 * (sto/tisíc) vynásobia bežný akumulátor, tisíc ho navyše preleje do
 * celkového.
 *
 * Nemecké obrátené poradie ("einundzwanzig" → jeden, und, dvadsať) vychádza
 * správne samo — jednotka aj desiatka sa jednoducho spočítajú.
 */
function assembleWords(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let sawAnything = false;

  for (const word of words) {
    if (FILLER_WORDS.has(word)) continue;

    if (word in UNIT_WORDS) {
      current += UNIT_WORDS[word];
      sawAnything = true;
      continue;
    }
    if (word in TENS_WORDS) {
      current += TENS_WORDS[word];
      sawAnything = true;
      continue;
    }
    if (word in HUNDRED_WORDS) {
      current += HUNDRED_WORDS[word];
      sawAnything = true;
      continue;
    }
    if (SCALE_HUNDRED.has(word)) {
      current = (current === 0 ? 1 : current) * 100;
      sawAnything = true;
      continue;
    }
    if (SCALE_THOUSAND.has(word)) {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      sawAnything = true;
      continue;
    }

    return null;
  }

  return sawAnything ? total + current : null;
}

/** Je toto slovo (alebo zlepenina) číslovka? */
function isNumberWord(word: string): boolean {
  return (
    word in UNIT_WORDS ||
    word in TENS_WORDS ||
    word in HUNDRED_WORDS ||
    SCALE_HUNDRED.has(word) ||
    SCALE_THOUSAND.has(word) ||
    splitGluedNumberWord(word) !== null
  );
}

// -----------------------------------------------------------------------------
// Číselné zápisy
// -----------------------------------------------------------------------------

/**
 * Prevedie zapísané číslo na hodnotu.
 *
 * Desatinný oddeľovač je nejednoznačný naprieč jazykmi: "300.50" je v
 * angličtine 300,50, "1.500" je v nemčine 1500. Pravidlá sú preto
 * explicitné a zámerne konzervatívne:
 *
 *  - dva rôzne oddeľovače ("1.234,50") → posledný je desatinný,
 *  - jeden oddeľovač a PRÁVE tri číslice za ním ("1.234") → tisícky,
 *  - jeden oddeľovač a iný počet číslic ("300,50", "300.5") → desatinný.
 *
 * Tvary, ktoré tieto pravidlá nepokryjú, vracajú `null` — asistent sa
 * spýta. To je jediný prípad, keď je otázka lepšia než odhad.
 */
function parseNumericToken(token: string): number | null {
  const cleaned = token.replace(/\s| /g, "");
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;

  const hasDot = cleaned.includes(".");
  const hasComma = cleaned.includes(",");

  let normalized: string;

  if (hasDot && hasComma) {
    const decimalSeparator = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = cleaned.split(thousandsSeparator).join("").replace(decimalSeparator, ".");
  } else if (hasDot || hasComma) {
    const separator = hasDot ? "." : ",";
    if (cleaned.indexOf(separator) !== cleaned.lastIndexOf(separator)) {
      // Viac rovnakých oddeľovačov ("1.234.567") — vždy tisícky.
      normalized = cleaned.split(separator).join("");
    } else {
      const [head, tail] = cleaned.split(separator);
      normalized = tail.length === 3 ? `${head}${tail}` : `${head}.${tail}`;
    }
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

// -----------------------------------------------------------------------------
// Verejné API
// -----------------------------------------------------------------------------

export type ParsedNumber = {
  value: number;
  /** Index prvého a posledného spotrebovaného tokenu — aby volajúci vedel,
   *  ktorú časť vety už číslo "zabralo" a nehľadal v nej popis položky. */
  startToken: number;
  endToken: number;
};

/**
 * Rozdelenie vety na tokeny.
 *
 * Bodky a čiarky sa odstraňujú iba na KRAJOCH tokenu (koncová interpunkcia
 * vety), nikdy zvnútra — inak by sa z "300,50" stalo "30050".
 */
export function tokenize(text: string): string[] {
  return fold(text)
    .replace(/[„""'()]/g, " ")
    .split(/[\s;:!?]+/)
    .map((token) => token.replace(/^[.,]+/, "").replace(/[.,]+$/, ""))
    .filter(Boolean);
}

/**
 * Nájde PRVÉ číslo vo vete — zapísané číslicami alebo slovami.
 *
 * Vracia `null`, keď vo vete žiadne číslo nie je alebo sa nedá bezpečne
 * preložiť. Volajúci z toho urobí otázku, nikdy default.
 */
export function findNumber(text: string, fromToken = 0): ParsedNumber | null {
  const tokens = tokenize(text);

  for (let i = fromToken; i < tokens.length; i++) {
    const numeric = parseNumericToken(tokens[i]);
    if (numeric !== null) {
      return { value: numeric, startToken: i, endToken: i };
    }

    if (!isNumberWord(tokens[i])) continue;

    // Zober čo najdlhšiu súvislú postupnosť číselných slov — "tristo
    // päťdesiat" je jedno číslo, nie tristo a potom päťdesiat.
    const words: string[] = [];
    let end = i;
    for (let j = i; j < tokens.length; j++) {
      const token = tokens[j];
      if (FILLER_WORDS.has(token)) {
        // Spojka sa berie iba vtedy, keď po nej ešte pokračuje číslovka.
        const next = tokens[j + 1];
        if (!next || !isNumberWord(next)) break;
        words.push(token);
        continue;
      }
      if (!isNumberWord(token)) break;
      const glued = splitGluedNumberWord(token);
      if (glued) words.push(...glued);
      else words.push(token);
      end = j;
    }

    const assembled = assembleWords(words);
    if (assembled !== null) {
      return { value: assembled, startToken: i, endToken: end };
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Meny a percentá
// -----------------------------------------------------------------------------

/**
 * Meny, ktoré appka vie rozpoznať z reči. Zámerne krátky zoznam — mena sa
 * primárne berie z nastavení partnera/firmy a reč ju iba prepisuje, keď ju
 * používateľ vysloví. Nerozpoznaná mena neznamená chybu, iba že sa použije
 * predvolená.
 */
const CURRENCY_WORDS: { code: string; words: string[] }[] = [
  { code: "EUR", words: ["eur", "euro", "eura", "eurov", "euros", "€"] },
  { code: "CZK", words: ["czk", "korun", "koruny", "korun ceskych", "kc"] },
  { code: "USD", words: ["usd", "dolar", "dolare", "dolarov", "dollar", "dollars", "$"] },
  { code: "GBP", words: ["gbp", "libra", "libier", "pound", "pounds"] },
  { code: "PLN", words: ["pln", "zloty", "zlotych"] },
];

/**
 * „10 831 eur" → „10831 eur". Prepis reči (aj formát čísla v SK/CZ/DE)
 * oddeľuje tisíce medzerou, nezalomiteľnou alebo úzkou medzerou. Bez
 * spojenia by sa z jednej sumy stali dve čísla — 10 € a „831" v popise.
 *
 * Spája sa IBA skupina, za ktorou hneď stojí mena (eur, €, Kč …) — prípadne
 * desatinná časť s čiarkou („1 250,50 €") — a každá ďalšia skupina má presne
 * tri číslice. Čiarka ani bodka sa nikdy
 * neprekračujú („300, 650 eur" ostávajú dve sumy). Veľkosť sumy nehrá
 * rolu — vyslovená suma je autoritatívny vstup, nič sa nezaokrúhľuje ani
 * nespochybňuje.
 *
 * Vracia NOVÝ reťazec na interné spracovanie; zobrazený prepis sa nemení.
 */
export function normalizeSpokenAmounts(text: string): string {
  return text.replace(
    /(?<![\d.,])([1-9]\d{0,2})((?:[   ]\d{3})+)(?=(?:,\d{1,2})?\s*(?:€|eur|euro|eura|eurov|euros|czk|kč|kc|korún|korun|usd|\$|gbp|pln)(?![a-zá-ž]))/gi,
    (_match, head: string, groups: string) => head + groups.replace(/[   ]/g, "")
  );
}

export function findCurrency(text: string): string | null {
  const folded = fold(text);
  for (const currency of CURRENCY_WORDS) {
    for (const word of currency.words) {
      const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(word)}([^a-z0-9]|$)`, "i");
      if (pattern.test(folded)) return currency.code;
    }
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Slová, ktoré vo vete označujú DPH. */
const VAT_WORDS = [
  "dph",
  "dani",
  "dan",
  "mehrwertsteuer",
  "mwst",
  "umsatzsteuer",
  "ust",
  "vat",
  "tax",
];

export function mentionsVat(text: string): boolean {
  const folded = fold(text);
  return VAT_WORDS.some((word) =>
    new RegExp(`(^|[^a-z])${escapeRegex(word)}([^a-z]|$)`).test(folded)
  );
}

const PERCENT_WORDS = ["percent", "percenta", "percentami", "prozent", "%"];

/**
 * Sadzba DPH vyslovená vo vete.
 *
 * Vráti hodnotu IBA vtedy, keď je vo vete číslo pri slove "percent"/"%".
 * Samotné "s DPH" sadzbu neurčuje a táto funkcia na ňom zámerne vráti
 * `null` — o tom, aká sadzba platí, nerozhoduje asistent (viď
 * lib/intents/invoice-draft.ts).
 */
export function findVatRate(text: string): number | null {
  const folded = fold(text);

  const hasPercentToken = PERCENT_WORDS.some((word) => folded.includes(word));
  if (!hasPercentToken) return null;

  // Číslo tesne pred slovom percento — "23 percent", "dvadsaťtri percent".
  const percentIndex = Math.min(
    ...PERCENT_WORDS.map((word) => {
      const index = folded.indexOf(word);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    })
  );

  const before = folded.slice(0, percentIndex);
  const digitMatch = before.match(/(\d+(?:[.,]\d+)?)\s*$/);
  if (digitMatch) {
    const value = parseNumericToken(digitMatch[1]);
    return value !== null && value >= 0 && value <= 100 ? value : null;
  }

  const spoken = findNumber(before);
  if (spoken && spoken.value >= 0 && spoken.value <= 100) {
    // Iba keď číslovka naozaj stojí na konci úseku pred "percent" — inak by
    // "faktúra za 300 eur percent" priradila 300 ako sadzbu.
    const tokens = tokenize(before);
    if (spoken.endToken === tokens.length - 1) return spoken.value;
  }

  return null;
}
