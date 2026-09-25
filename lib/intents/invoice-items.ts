// Relatívny import (rovnako ako v lib/i18n/*) — vďaka nemu sa modul dá
// spustiť priamo v Node, takže testy nepotrebujú bundler ani závislosť.
import { findNumber, findCurrency, normalizeSpokenAmounts, tokenize } from "./number-words.ts";

// =============================================================================
// Rozpoznanie RIADKOVÝCH POLOŽIEK z jednej vyslovenej vety.
//
// PREČO SAMOSTATNÝ MODUL
// ----------------------
// Do Phase 2 vedel hlas založiť faktúru s jednou položkou. „Kopanie 300 a
// doprava 50" sa dalo spracovať dvoma spôsobmi a oba sú zlé: buď vznikne
// jeden riadok „kopanie 300 a doprava" za 50, alebo jeden riadok za 350.
// Prvé je nezmysel, druhé je tichá strata informácie na daňovom doklade.
//
// Preto sa veta rozdeľuje na ŠTRUKTÚROVANÉ kandidátske položky a keď sa
// rozdeliť nedá spoľahlivo, nevráti sa nič a asistent sa spýta. Hádanie
// hraníc medzi položkami tu neexistuje.
//
// ČO TENTO MODUL NEROBÍ
// ---------------------
// Nerozhoduje o DPH (to je právne rozhodnutie — pozri invoice-draft.ts),
// neopravuje prepis reči a nedopĺňa ceny, ktoré vo vete nie sú. Množstvo
// a jednotku vyplní IBA pri výslovnom „10 hodín po 35 eur" (pozri
// readQuantityPrice); inak ich nechá prázdne a predvolené hodnoty dosadí
// až vrstva nad ním, a to iba tie, ktoré dosadí aj formulár v UI.
// =============================================================================

/**
 * Jedna rozpoznaná položka. Všetko okrem popisu je nepovinné — keď cena
 * vo vete nie je, je to dôvod na otázku, nie na nulu.
 */
export type InvoiceItemCandidate = {
  description: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  currency?: string;
};

export type ItemParseResult = {
  items: InvoiceItemCandidate[];
  /**
   * Prečo sa parsovanie zastavilo. `null` znamená, že výsledok je
   * použiteľný taký, aký je.
   *
   *   "ambiguous"       vetu sa nedalo rozdeliť na položky spoľahlivo
   *   "missing_price"   niektorá položka nemá cenu
   *   "too_many_items"  viac položiek, než hlasová cesta pripúšťa
   */
  problem: "ambiguous" | "missing_price" | "too_many_items" | null;
  /**
   * Čo sa z vety prečítať PODARILO, aj keď sa výsledok nakoniec nepoužije.
   *
   * Pri `problem !== null` zostáva `items` úmyselne prázdne — čiastočný
   * doklad je horší než otázka. Otázka však musí znieť konkrétne
   * („rozumel som kopanie 300, neviem spracovať dovoz"), inak používateľ
   * nemá ako pomôcť. Preto sa rozpoznané aj nerozpoznané úseky nesú ďalej.
   */
  recognized: InvoiceItemCandidate[];
  /** Úseky, z ktorých sa položka spoľahlivo prečítať nedala. */
  unresolved: string[];
  /**
   * Celková suma, ktorú používateľ vyslovil („… spolu 1 832 eur").
   *
   * NIKDY sa nerozpočítava do riadkov — slúži iba na kontrolu súčtu, keď
   * používateľ ceny riadkov povie. Nie je to položka a nie je to peňažná
   * hodnota niektorej položky.
   */
  statedTotal?: number;
};

/** Voľby parsera, ktoré zapína iba volajúci so známym kontextom. */
export type ItemParseOptions = {
  /**
   * Odpoveď na otázku „Za čo má byť faktúra?" / „Aké sú ceny?".
   *
   * Partner je v tej chvíli už vyriešený alebo sa na neho pýta iná otázka,
   * takže číslo v odpovedi nemôže byť súčasťou jeho mena („Tester 1").
   * Iba vtedy sa smie mena uvedená raz na konci („300, 650 a 830 eur")
   * preniesť na všetky riadky — a aj to len pri úplne pravidelnom tvare.
   */
  answerContext?: boolean;
};

// -----------------------------------------------------------------------------
// Limity hlasovej cesty
// -----------------------------------------------------------------------------
//
// Fakturačný model appky ani databáza dnes žiadny strop na počet položiek
// ani dĺžku popisu nemajú — overené v `validateDraftBeforeFinalize` aj v
// CHECK constraintoch. Tieto limity preto platia VÝHRADNE pre diktovanie a
// nie sú novým fakturačným pravidlom: kto klikne do formulára, nie je nimi
// dotknutý.
//
// Dôvod pre ne je praktický. Veta, z ktorej by vyšlo desať položiek, sa
// takmer isto rozdelila zle, a bezbrehý popis by znamenal, že do dokladu
// prejde celý transkript. Strop je teda detektor chyby, nie obchodná
// hranica.

/** Najviac položiek z jednej hlasovej faktúry. */
export const MAX_VOICE_ITEMS = 10;

/** Najviac znakov popisu. Zhodné s orezaním v readSlots(). */
export const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Najvyššia jednotková cena, ktorú hlas prijme.
 *
 * `invoice_items.unit_price` je `numeric(18,6)`, teda technicky unesie
 * ~10^12. Tento strop je nižší zámerne: je to poistka proti chybe
 * rozpoznávania reči („tristo" vs. zle pochopená dlhá číselná sekvencia),
 * nie limit toho, čo smie firma fakturovať. Vyššiu sumu používateľ zadá
 * vo formulári.
 */
export const MAX_VOICE_UNIT_PRICE = 1_000_000;

// -----------------------------------------------------------------------------
// Rozdeľovanie vety
// -----------------------------------------------------------------------------

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Oddeľovače položiek.
 *
 * Čiarka a bodkočiarka sú jednoznačné. Spojka („a", „und", „and") je
 * nejednoznačná — vyskytuje sa aj vnútri popisu („dovoz a odvoz") — preto
 * sa použije IBA vtedy, keď na oboch stranách vznikne úsek s vlastnou
 * cenou. To rozhodnutie robí `splitIntoSegments` nižšie, nie tento zoznam.
 */
// Čiarka je oddeľovač položiek AJ desatinná značka. Delí sa preto iba na
// čiarke, ktorá nestojí medzi dvoma číslicami — inak by sa „50,50" rozpadlo
// na dve položky po 50. (Bez tejto podmienky test „desatinná čiarka"
// skutočne padol.)
const HARD_SEPARATORS = /(?<!\d)[,;]\s*|\s*[,;](?!\d)|\s+\+\s+/;
const CONJUNCTIONS = ["a", "und", "and", "plus"];

/**
 * Frázy, ktoré uvádzajú predmet fakturácie.
 *
 * Už sa NEPOUŽÍVAJÚ na orezanie celej vety — to bola príčina dokladu za
 * 1 € (podrobnosti v `extractItemsSection`). Slúžia iba na jednu úzku
 * vec: oddeliť príkazovú hlavičku od prvej položky VNÚTRI úseku, v ktorom
 * obe stoja vedľa seba („Vytvor faktúru pre Tester1 **za** kopanie 300").
 */
const ITEMS_LEAD_PHRASES = [" za ", " fuer ", " für ", " for ", " ueber ", " über ", ":"];

/**
 * Frázy, ktoré uvádzajú DPH. Úsek od nich dozadu do položiek nepatrí —
 * inak by „s 23 percent DPH" skončilo ako ďalšia položka.
 */
const VAT_TAIL_PHRASES = [
  " s dph",
  " s 2",
  " s 1",
  " so ",
  " mit ",
  " with ",
  " plus 2",
  " plus 1",
  " vat",
  " dph",
  " mwst",
  " mehrwertsteuer",
  " umsatzsteuer",
  " percent",
  " prozent",
  "%",
];

// -----------------------------------------------------------------------------
// Celková suma („spolu 1 832 eur") — nie je položka
// -----------------------------------------------------------------------------

const TOTAL_MARKERS = /(^|[^a-z])(spolu|celkom|dokopy|dohromady|celkova suma|celkovu sumu|celkovej sume|v celkovej|suma spolu|insgesamt|gesamt|zusammen|in total|total|altogether|overall)([^a-z]|$)/;

/** Je úsek vyslovenou celkovou sumou („suma spolu 1832 eur")? */
function isTotalSegment(segment: string): boolean {
  return TOTAL_MARKERS.test(fold(segment)) && findNumber(segment) !== null;
}

/** Hodnota celkovej sumy — iba pri práve jednom čísle v úseku. */
function readTotal(segment: string): number | null {
  const numbers = moneyTokens(segment);
  if (numbers.length !== 1) return null;
  const value = numbers[0];
  return Number.isFinite(value) && value > 0 && value <= MAX_VOICE_UNIT_PRICE * MAX_VOICE_ITEMS ? value : null;
}

// -----------------------------------------------------------------------------
// Počet v popise („za dvoch pracovníkov 830 eur") — nie je cena ani množstvo
// -----------------------------------------------------------------------------
//
// Slovná číslovka pred podstatným menom opisuje predmet („dvoch
// pracovníkov"). Cenou nie je. Množstvom sa stane IBA vo výslovnom tvare
// „2 hodiny po 40 eur" (readQuantityPrice) — tu sa nič neprepočítava a
// popis ostáva tak, ako zaznel. Uplatní sa iba vtedy, keď úsek má práve
// jednu inú sumu s menou; inak ostáva doterajšie prísne správanie.

const COUNT_WORDS = new Set([
  "dva", "dve", "dvoch", "dvaja", "dvom", "dvoma", "tri", "troch", "traja", "trom", "styri", "styroch", "styria",
  "pat", "piati", "piatich", "sest", "siesti", "siestich", "jeden", "jedna", "jedneho", "jednej",
  "zwei", "drei", "vier", "funf", "fuenf", "two", "three", "four", "five",
]);

type PricedNumber = { value: number; startToken: number; endToken: number; countTokens: number[] };

/** Všetky čísla úseku v poradí (s pozíciami tokenov). */
function allNumbers(segment: string): { value: number; startToken: number; endToken: number }[] {
  const out: { value: number; startToken: number; endToken: number }[] = [];
  let from = 0;
  for (let guard = 0; guard < 32; guard++) {
    const found = findNumber(segment, from);
    if (!found) break;
    out.push(found);
    from = found.endToken + 1;
  }
  return out;
}

/**
 * Cena úseku. Pri jednom čísle je to ono. Pri viacerých iba vtedy, keď
 * práve jedno stojí pred menou a všetky ostatné sú slovné počty pred
 * podstatným menom („dvoch pracovníkov"). Inak `null` = doterajšia cesta.
 */
function pricedNumber(segment: string): PricedNumber | null {
  const numbers = allNumbers(segment);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return { ...numbers[0], countTokens: [] };
  const tokens = tokenize(segment);
  const withCurrency = numbers.filter((n) => findCurrency(tokens[n.endToken + 1] ?? "") !== null);
  if (withCurrency.length !== 1) return null;
  const price = withCurrency[0];
  const others = numbers.filter((n) => n !== price);
  const countTokens: number[] = [];
  for (const other of others) {
    if (other.startToken !== other.endToken) return null;
    const word = tokens[other.startToken] ?? "";
    const next = tokens[other.startToken + 1] ?? "";
    if (!COUNT_WORDS.has(word) || !/^[a-z]{3,}$/.test(next) || next in UNIT_WORDS || findCurrency(next)) return null;
    countTokens.push(other.startToken);
  }
  return { ...price, countTokens };
}

/** Peňažné hodnoty úseku — bez slovných počtov v popise. */
function segmentMoney(segment: string): number[] {
  const priced = pricedNumber(segment);
  if (priced && priced.countTokens.length > 0) return [priced.value];
  return moneyTokens(segment);
}

/** Výplňové slová pred cenou („suma", „v hodnote"), ktoré do popisu nepatria. */
const PRICE_FILLERS = /(^|\s)(v\s+sume|v\s+hodnote|vo\s+v[yý][sš]ke|suma|sumu|sume|cena|cenu|hodnota|betrag|preis|amount|price)(?=\s|$)/gi;

/**
 * Odstrihne hlavičku príkazu a chvost o DPH. Vráti iba úsek s položkami.
 *
 * POSTUP
 * ------
 * 1. Odreže sa chvost o DPH (prvá zmienka).
 * 2. Ak je známe meno partnera, odreže sa VŠETKO PO NEHO vrátane. Meno je
 *    jediná časť príkazu, ktorá môže obsahovať číslo („Tester 1"), a je to
 *    zároveň jediný bod, ktorý vie appka overiť proti evidencii.
 * 3. Bez známeho mena sa berie veta od začiatku a príkazovú hlavičku
 *    vyradí až klasifikácia úsekov.
 *
 * PREČO SA UŽ NEHĽADÁ „POSLEDNÁ" UVÁDZACIA FRÁZA
 * ----------------------------------------------
 * Skoršia verzia začínala úsek za POSLEDNÝM „za"/„für"/„for". Vo vete
 * „kopanie za 300 eur, dovoz za 45 eur" je posledné „za" to, ktoré uvádza
 * cenu DRUHEJ položky — úsek sa tým zredukoval na „45 eur", z ktorého
 * nevyšla ani jedna položka, a náhradná cesta potom zložila doklad z
 * popisu jednej časti vety a ceny z úplne inej. Tak vznikol riadok
 * „300 eur, dovoz" za 1 € — tá jednotka pochádzala z mena „Tester 1".
 *
 * Predložka pred cenou sa preto rieši tam, kam patrí: v jednotlivom úseku
 * (`segmentToItem`), nie orezaním celej vety.
 */
function extractItemsSection(
  rawText: string,
  partnerHint?: string
): { section: string; partnerRemoved: boolean } {
  const folded = fold(rawText);

  // Koniec: pred najskoršou zmienkou o DPH.
  let end = rawText.length;
  for (const phrase of VAT_TAIL_PHRASES) {
    const index = folded.indexOf(fold(phrase));
    if (index !== -1 && index < end) end = index;
  }

  let start = 0;
  let partnerRemoved = false;

  if (partnerHint && partnerHint.trim()) {
    const found = findPartnerMention(rawText, partnerHint);
    if (found && found.end <= end) {
      start = found.end;
      partnerRemoved = true;
    }
  }

  return { section: rawText.slice(start, end).trim(), partnerRemoved };
}

/**
 * Nájde vo vete meno partnera aj vtedy, keď sa medzery nezhodujú
 * („Tester 1" v evidencii, „tester1" v prepise a naopak).
 *
 * Porovnáva sa nad textom bez diakritiky a bez nepísmenových znakov, a
 * pozícia sa prepočíta späť na pôvodný reťazec. Bez tohto by sa meno s
 * číslom stalo položkou za jedno euro — presne to sa v produkcii stalo.
 */
function findPartnerMention(
  rawText: string,
  partnerHint: string
): { start: number; end: number } | null {
  const folded = fold(rawText);

  // Mapovanie: pre každý „hustý" znak si pamätáme index v pôvodnom texte.
  const denseChars: string[] = [];
  const originalIndex: number[] = [];
  for (let i = 0; i < folded.length; i++) {
    if (/[a-z0-9]/.test(folded[i])) {
      denseChars.push(folded[i]);
      originalIndex.push(i);
    }
  }

  const dense = denseChars.join("");
  const needle = fold(partnerHint).replace(/[^a-z0-9]/g, "");
  if (!needle) return null;

  const at = dense.indexOf(needle);
  if (at === -1) return null;

  return {
    start: originalIndex[at],
    end: originalIndex[at + needle.length - 1] + 1,
  };
}

// -----------------------------------------------------------------------------
// Klasifikácia úsekov bez uvádzacej frázy
// -----------------------------------------------------------------------------
//
// Keď veta uvádzaciu frázu nemá, treba rozhodnúť, ktoré úseky sú položky a
// ktoré patria k príkazu. Rozhoduje sa DETERMINISTICKY a iba na dvoch
// veciach, ktoré sa dajú overiť: na slovese príkazu a na mene partnera,
// ktoré už rozpoznala vrstva nad parserom. Nič sa neháda podľa podobnosti.

const CREATE_VERBS = /(vytvor|vystav|sprav|urob|zaloz|nova|novu|erstell|schreib|create|make|issue|new)/;
const INVOICE_NOUNS = /(faktur|rechnung|invoice)/;

/**
 * „Vytvor faktúru pre Tester1" — príkazová hlavička, nie predmet.
 *
 * Sloveso nestačí vyžadovať: ľudia ho pri diktovaní často vynechajú
 * („Faktúru pre Tester1 za kopanie…"). Rozhoduje preto podstatné meno
 * dokladu spolu so slovesom ALEBO s predložkou, ktorá uvádza odberateľa.
 */
// Porovnáva sa nad textom BEZ diakritiky, preto „fur" (z „für") a „uber"
// (z „über") — nie tvary s prehláskou, tie sa sem nikdy nedostanú.
const CUSTOMER_PREPOSITIONS = /(^|[^a-z])(pre|pro|fuer|fur|for|uber)([^a-z]|$)/;

function looksLikeCommandHeader(segment: string): boolean {
  const folded = fold(segment);
  if (!INVOICE_NOUNS.test(folded)) return false;
  return CREATE_VERBS.test(folded) || CUSTOMER_PREPOSITIONS.test(folded);
}

/**
 * Oddelí príkaz od prvej položky vnútri jedného úseku.
 *
 * „Vytvor faktúru pre Tester1 za kopanie 300 eur" je jeden úsek, v ktorom
 * stojí príkaz aj položka. Rez sa robí na PRVEJ uvádzacej fráze za
 * hlavičkou — tam, kde sa hovorí o predmete. Keď v úseku s hlavičkou
 * žiadna fráza nie je, nie je v ňom ani položka a úsek zaniká.
 *
 * Toto je jediné miesto, kde uvádzacia fráza ešte niečo reže, a reže vždy
 * najviac jeden úsek — nikdy nie celú vetu.
 */
function stripCommandHeader(segment: string): string | null {
  if (!looksLikeCommandHeader(segment)) return segment;

  // POSLEDNÁ fráza v tomto úseku, nie prvá: tá istá predložka uvádza aj
  // odberateľa, aj predmet („invoice **for** X **for** excavation"), a
  // odberateľ stojí vždy skôr. Reže sa pritom IBA tento jeden úsek —
  // presne v tom je rozdiel oproti chybe, ktorá orezávala celú vetu.
  const folded = fold(segment);
  let cut = -1;
  for (const phrase of ITEMS_LEAD_PHRASES) {
    const index = folded.lastIndexOf(fold(phrase));
    if (index !== -1 && index + phrase.length > cut) cut = index + phrase.length;
  }

  if (cut === -1) return null;
  const rest = segment.slice(cut).trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Je úsek menom partnera, ktoré už rozpoznala vrstva nad parserom?
 *
 * Porovnáva sa voľne (bez diakritiky, bez medzier a interpunkcie), aby
 * „Tester 1" v príkaze sedelo s „Tester1" v evidencii. Toto je JEDINÝ
 * spôsob, akým sa úsek s číslom smie vyradiť z položiek — bez známeho
 * mena by sa „Tester 1" stal položkou za jedno euro.
 */
function matchesPartnerHint(segment: string, hint: string | undefined): boolean {
  if (!hint) return false;
  const key = (value: string) => fold(value).replace(/[^a-z0-9]/g, "");
  const segmentKey = key(segment);
  const hintKey = key(hint);
  return segmentKey.length > 0 && hintKey.length > 0 && segmentKey === hintKey;
}

/** Nesie úsek explicitnú menu („300 eur")? */
function hasCurrencyMarker(segment: string): boolean {
  return findCurrency(segment) !== null;
}

/**
 * Útržok, ktorý zostal po odrezaní chvosta o DPH („…, 23" z „…, 23 % DPH").
 *
 * Nie je to obsah od používateľa, ale stopa po NAŠOM reze. Zahodí sa ticho;
 * všetko ostatné, čomu parser nerozumie, skončí ako dôvod na otázku.
 */
function isCutRemnant(segment: string): boolean {
  if (/^[\s\d.,;:%-]*$/.test(segment)) return true;
  // „…, všetko s DPH" / „…, ceny sú bez DPH" — po reze chvosta o DPH ostane
  // iba úvod k režimu ceny. Nie je to položka; režim ceny číta
  // detectPriceModeStatement z celej vety.
  return /^(a\s+)?(vsetko|vsetky(\s+(ceny|sumy|polozky))?|ceny(\s+su)?(\s+uvedene)?|sumy(\s+su)?|je\s+to|to\s+je|alles|all|everything|prices(\s+are)?|preise(\s+sind)?)(\s+(je|su|sind|are|is))?[.!?]*$/.test(fold(segment).trim());
}

// -----------------------------------------------------------------------------
// Rekonciliácia peňažných hodnôt
// -----------------------------------------------------------------------------
//
// Účtovná poistka, nie jazyková. Každá suma vyslovená v úseku o položkách
// musí skončiť ako cena PRÁVE JEDNEJ položky. Keď sa počty nerovnajú,
// niekde sa suma stratila, zdvojila alebo prepadla do popisu — a vtedy sa
// doklad nezakladá, nech by výsledok vyzeral akokoľvek rozumne.
//
// Percento DPH sa medzi peňažné hodnoty nepočíta; rozoznáva sa podľa toho,
// že za číslom stojí „percent"/„%", nie podľa jeho veľkosti.

/** Všetky čísla v texte, ktoré nie sú percentom. */
export function moneyTokens(text: string): number[] {
  const tokens = tokenize(text);
  const out: number[] = [];

  let from = 0;
  // Strop na počet prechodov je poistka proti nekonečnu, nie obchodné
  // pravidlo: každý prechod posúva kurzor aspoň o jeden token.
  for (let guard = 0; guard < 64; guard++) {
    const found = findNumber(text, from);
    if (!found) break;

    const next = tokens[found.endToken + 1] ?? "";
    const self = tokens[found.endToken] ?? "";
    const isPercent = /percent|prozent|%/.test(next) || /%/.test(self);

    if (!isPercent) out.push(found.value);
    from = found.endToken + 1;
  }

  return out;
}

/**
 * Rozdelí úsek na kandidátske segmenty.
 *
 * Najprv podľa jednoznačných oddeľovačov. Segment, ktorý obsahuje spojku
 * A ZÁROVEŇ dve čísla, sa rozdelí aj na tej spojke — „kopanie 300 a
 * doprava 50" sú dve položky, ale „dovoz a odvoz 300" je jedna.
 */
function splitIntoSegments(section: string): string[] {
  const hard = section
    .split(HARD_SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean);

  const out: string[] = [];

  for (const segment of hard) {
    out.push(...splitOnConjunctionIfTwoPrices(segment));
  }

  return out;
}

/**
 * Stojí suma na konci úseku (po vynechaní názvu meny)?
 *
 * „kopanie 300", „kopanie 300 eur" → áno. „50 doprava" → nie.
 */
function amountIsTrailing(segment: string): boolean {
  const found = pricedNumber(segment) ?? findNumber(segment);
  if (!found) return false;

  const tokens = tokenize(segment);
  for (let i = found.endToken + 1; i < tokens.length; i++) {
    if (!findCurrency(tokens[i])) return false;
  }
  return true;
}

function splitOnConjunctionIfTwoPrices(segment: string): string[] {
  const words = segment.split(/\s+/);

  for (let i = 1; i < words.length - 1; i++) {
    if (!CONJUNCTIONS.includes(fold(words[i]))) continue;

    const left = words.slice(0, i).join(" ");
    const right = words.slice(i + 1).join(" ");

    // Rozdeľuje sa IBA keď má cenu každá strana A ZÁROVEŇ stojí suma na
    // oboch stranách rovnako. „kopanie 300 a doprava 50" sú dve položky
    // rovnakého tvaru; „kopanie 300 a 50 doprava" tvar mení, a zmena tvaru
    // uprostred výpočtu je presne to, čo sa nemá dohadovať. Taký segment
    // zostane celý a rekonciliácia súm ho pošle na otázku.
    if (findNumber(left) && findNumber(right) && amountIsTrailing(left) === amountIsTrailing(right)) {
      return [
        ...splitOnConjunctionIfTwoPrices(left),
        ...splitOnConjunctionIfTwoPrices(right),
      ];
    }
  }

  return [segment];
}

// -----------------------------------------------------------------------------
// Segment -> položka
// -----------------------------------------------------------------------------

/** Slová, ktoré v popise nemajú čo robiť (zvyšky po oddelení sumy). */
const PRICE_NOISE = /\b(eur|euro|eura|eurov|euros|czk|usd|dolar\w*|dollars?|kc|kč|pln|gbp)\b|€/gi;

/**
 * Predložky, ktoré vnútri úseku uvádzajú predmet alebo cenu („**za**
 * kopanie", „kopanie **za** 300 eur"). Odstraňujú sa z popisu, nie z vety —
 * orezávanie celej vety podľa nich bolo príčinou chyby s 1 €.
 */
const SEGMENT_PREPOSITIONS = /(^|\s)(za|fuer|für|for|ueber|über)(\s|$)/gi;

// -----------------------------------------------------------------------------
// Množstvo × jednotková cena („10 hodín po 35 eur")
// -----------------------------------------------------------------------------
//
// Jazyk tu iba ROZPOZNÁ tri hodnoty — množstvo, jednotku a jednotkovú cenu.
// Riadkovú sumu, základ, daň ani súčty NEPOČÍTA: tie vzniknú z uložených
// `quantity` a `unit_price` v kanonickom peňažnom modeli (VAT engine
// a finalizácia v DB), rovnako ako pri položke zadanej vo formulári.
//
// Prísne pravidlá, aby sa nič nehádalo:
//   - množstvo MUSÍ mať známu jednotku („10 hodín", „5 kusov", „3 tony"),
//   - cena MUSÍ byť uvedená spojkou jednotkovej ceny („po", „à", „zu",
//     „at", „je") alebo „za … za hodinu / per hour / each",
//   - v úseku sú práve dve čísla (množstvo a cena) a cena má menu.
// „10 hodín za 350 eur" nie je jednotková cena — ostáva na doterajšej
// ceste (dve sumy bez jednoznačného vzťahu → otázka).

/** Jednotky, ktorým rozumieme, na zaužívané označenie v doklade („hod", „ks" …). */
const UNIT_WORDS: Record<string, string> = {
  h: "hod", hod: "hod", hodina: "hod", hodiny: "hod", hodin: "hod", hodinu: "hod", hodinami: "hod",
  hour: "hod", hours: "hod", hr: "hod", hrs: "hod", stunde: "hod", stunden: "hod", std: "hod",
  ks: "ks", kus: "ks", kusy: "ks", kusov: "ks", kusu: "ks", piece: "ks", pieces: "ks", pcs: "ks", pc: "ks", stuck: "ks", stueck: "ks",
  t: "t", tona: "t", tony: "t", ton: "t", tonu: "t", tonne: "t", tonnes: "t", tons: "t", tonnen: "t",
  kg: "kg", kilo: "kg", kila: "kg", kilogram: "kg", kilogramov: "kg", kilograms: "kg", kilogramm: "kg",
  m: "m", meter: "m", metre: "m", metrov: "m", meters: "m", metres: "m",
  m2: "m2", "m²": "m2", m3: "m3", "m³": "m3", kubik: "m3", kubiky: "m3", kubikov: "m3",
  l: "l", liter: "l", litre: "l", litrov: "l", liters: "l", litres: "l",
  km: "km", kilometer: "km", kilometrov: "km", kilometers: "km",
  den: "deň", dni: "deň", day: "deň", days: "deň", tag: "deň", tage: "deň",
};

/** Spojky, za ktorými nasleduje JEDNOTKOVÁ cena. „à" sa porovnáva v pôvodnom tvare (zložené „a" je spojka „a"). */
const UNIT_PRICE_CONNECTORS = new Set(["po", "zu", "at", "je", "@"]);

/** „… za hodinu", „per hour", „pro Stunde", „each" za cenou — cena je za jednotku. */
const PER_UNIT_WORDS = new Set(["za", "na", "per", "pro", "je", "/", "a"]);
const EACH_WORDS = new Set(["each", "apiece", "kus", "stuck", "stueck", "jeden", "jednu"]);

/** Slová bez významu na okraji popisu („of excavation", „… bez" po reze „DPH"). */
const DESCRIPTION_EDGE_NOISE = /^(?:of|von|der|die|das|z|zo)\s+|(?:^|\s+)(?:bez|s|so|ohne|mit|without|with|inkl|vratane|vrátane)$/i;

/** „-2 hodiny" — záporné množstvo sa neprijíma (ani ako súčasť popisu). */
function hasNegativeQuantity(segment: string): boolean {
  const match = /(?:^|\s)[-−–]\s*\d+(?:[.,]\d+)?\s+(\S+)/.exec(segment);
  return Boolean(match && UNIT_WORDS[tokenize(match[1])[0] ?? ""]);
}

type QuantityPrice = {
  quantity: number;
  unit: string;
  unitPrice: number;
  /** Indexy tokenov, ktoré do popisu nepatria. */
  consumed: Set<number>;
};

function readQuantityPrice(segment: string): QuantityPrice | null {
  const tokens = tokenize(segment);
  const raw = segment.trim().split(/\s+/);
  const qty = findNumber(segment);
  if (!qty || qty.startToken !== qty.endToken) return null;
  const unit = UNIT_WORDS[tokens[qty.endToken + 1] ?? ""];
  if (!unit || !Number.isFinite(qty.value) || qty.value <= 0) return null;

  const price = findNumber(segment, qty.endToken + 2);
  if (!price || price.startToken !== price.endToken) return null;
  const connectorIndex = price.startToken - 1;
  const connector = tokens[connectorIndex] ?? "";
  const rawConnector = (raw[connectorIndex] ?? "").toLowerCase();

  // Mena hneď za cenou (35 eur / 35 €).
  const currencyIndex = price.endToken + 1;
  if (!findCurrency(tokens[currencyIndex] ?? "")) return null;

  const consumed = new Set<number>([qty.startToken, qty.endToken + 1, price.startToken, currencyIndex]);

  let isUnitPrice = false;
  if (UNIT_PRICE_CONNECTORS.has(connector) || rawConnector === "à") {
    isUnitPrice = true;
    consumed.add(connectorIndex);
  }
  // „za 35 eur za hodinu", „35 euros per hour", „35 euros each"
  const after = tokens[currencyIndex + 1] ?? "";
  const afterUnit = tokens[currencyIndex + 2] ?? "";
  if (PER_UNIT_WORDS.has(after) && UNIT_WORDS[afterUnit] === unit) {
    isUnitPrice = true;
    consumed.add(currencyIndex + 1).add(currencyIndex + 2);
    if (connector === "za" || connector === "for" || connector === "fur" || connector === "fuer") consumed.add(connectorIndex);
  } else if (EACH_WORDS.has(after)) {
    isUnitPrice = true;
    consumed.add(currencyIndex + 1);
    if (connector === "za" || connector === "for") consumed.add(connectorIndex);
  }
  if (!isUnitPrice) return null;

  // Práve dve čísla: množstvo a cena. Iné číslo = nejasné → doterajšia cesta.
  if (moneyTokens(segment).length !== 2) return null;
  if (!Number.isFinite(price.value) || price.value < 0 || price.value > MAX_VOICE_UNIT_PRICE) return null;

  return { quantity: qty.value, unit, unitPrice: price.value, consumed };
}

function quantityPriceItem(segment: string, qp: QuantityPrice): InvoiceItemCandidate | null {
  const words = segment.trim().split(/\s+/);
  let description = words.filter((_, index) => !qp.consumed.has(index)).join(" ");
  description = description
    .replace(PRICE_NOISE, " ")
    .replace(SEGMENT_PREPOSITIONS, " ")
    .replace(/[.,;:!?]+\s*$/, "")
    .replace(/^\s*[-–—]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++) description = description.replace(DESCRIPTION_EDGE_NOISE, "").trim();
  if (!description) return null;

  const item: InvoiceItemCandidate = {
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    quantity: qp.quantity,
    unit: qp.unit,
    unitPrice: qp.unitPrice,
  };
  const currency = findCurrency(segment);
  if (currency) item.currency = currency;
  return item;
}

/**
 * „Výkopové práce, 10 hodín po 35 eur" — čiarka tu nedelí dve položky:
 * úsek bez čísla, za ktorým nasleduje množstvo × cena bez popisu, je jeho
 * popis. Spojí sa IBA táto dvojica; všetko ostatné ostáva rozdelené.
 */
function mergeQuantityContinuations(segments: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const next = segments[i + 1];
    if (next !== undefined && !findNumber(segments[i])) {
      const qp = readQuantityPrice(next);
      if (qp && quantityPriceItem(next, qp) === null) {
        out.push(`${segments[i]} ${next}`);
        i++;
        continue;
      }
    }
    out.push(segments[i]);
  }
  return out;
}

/**
 * Popis bez meny, predložiek a výplňových slov. Opakuje sa, kým sa niečo
 * mení — „za Za kopanie suma" má dve predložky za sebou a jeden prechod
 * regulárneho výrazu by druhú nechal (medzera medzi nimi sa spotrebuje).
 */
function cleanDescription(value: string): string {
  let description = value;
  for (let i = 0; i < 4; i++) {
    const next = description
      .replace(PRICE_NOISE, " ")
      .replace(SEGMENT_PREPOSITIONS, " ")
      .replace(PRICE_FILLERS, " ")
      .replace(/[.,;:!?]+\s*$/, "")
      .replace(/^\s*[-–—]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (next === description) break;
    description = next;
  }
  return description;
}

function segmentToItem(segment: string): InvoiceItemCandidate | null {
  const qp = readQuantityPrice(segment);
  if (qp) return quantityPriceItem(segment, qp);

  const amount = pricedNumber(segment) ?? findNumber(segment);

  // Popis = segment bez čísla a bez názvu meny.
  let description = segment;
  if (amount) {
    const tokens = segment.split(/\s+/);
    // findNumber pracuje nad normalizovanými tokenmi; na odstránenie z
    // POVODNEHO textu sa použije rovnaké delenie podľa medzier, čo pre
    // tieto vety stačí a zachová pôvodné písmená v popise.
    description = tokens
      .filter((_, index) => index < amount.startToken || index > amount.endToken)
      .join(" ");
  }

  description = cleanDescription(description);

  if (!description) return null;

  const item: InvoiceItemCandidate = {
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
  };

  if (amount) item.unitPrice = amount.value;

  const currency = findCurrency(segment);
  if (currency) item.currency = currency;

  return item;
}

// -----------------------------------------------------------------------------
// Verejné API
// -----------------------------------------------------------------------------

/**
 * Vytiahne položky z celej vyslovenej vety.
 *
 * Vracia položky AJ dôvod, prečo sa výsledku nedá veriť. Volajúci sa podľa
 * `problem` rozhodne, či sa spýta — tento modul sám nikdy nedopĺňa
 * chýbajúce hodnoty.
 */
export function extractInvoiceItems(
  rawText: string,
  /**
   * Meno partnera, ako ho z vety prečítala vrstva nad parserom. Slúži
   * VÝHRADNE na to, aby sa úsek s menom nestal položkou; na nič iné sa
   * nepoužíva a jeho neprítomnosť nikdy nespôsobí tichý výsledok.
   */
  partnerHint?: string,
  options: ItemParseOptions = {}
): ItemParseResult {
  let statedTotal: number | undefined;
  const empty = (problem: ItemParseResult["problem"] = null): ItemParseResult => ({
    items: [],
    problem,
    recognized: [],
    unresolved: [],
    ...(statedTotal !== undefined ? { statedTotal } : {}),
  });

  // „10 831 eur" je JEDNA suma (tisíce oddelené medzerou) — interná kópia.
  rawText = normalizeSpokenAmounts(rawText);
  const { section, partnerRemoved } = extractItemsSection(rawText, partnerHint);
  if (!section) return empty();

  const allSegments = splitIntoSegments(section);
  if (allSegments.length === 0) return empty();

  // Príkazová hlavička a meno partnera nie sú položky. Meno sa väčšinou
  // odrezalo už pri hľadaní úseku; toto je poistka pre prípad, že stojí vo
  // vete druhýkrát. Útržok po reze chvosta o DPH („23") sa zahodí ticho —
  // je to stopa po našom reze, nie obsah od používateľa.
  const headerless = allSegments
    .map(stripCommandHeader)
    .filter((segment): segment is string => segment !== null)
    .filter(
      (segment) => !matchesPartnerHint(segment, partnerHint) && !isCutRemnant(segment)
    );

  // „… suma spolu 1 832 eur" — celková suma nie je položka. Vyberie sa iba
  // jeden taký úsek; dva súčty v jednej vete sú nejasné → otázka.
  const totalSegments = headerless.filter(isTotalSegment);
  if (totalSegments.length > 1) return empty("ambiguous");
  if (totalSegments.length === 1) {
    const total = readTotal(totalSegments[0]);
    if (total === null) return empty("ambiguous");
    statedTotal = total;
  }
  let segments = headerless.filter((segment) => !isTotalSegment(segment));
  // „kopanie a odvoz spolu 500 eur" — bez ďalších úsekov je „spolu" iba
  // spôsob, ako povedať cenu jedného riadku, nie celková suma k iným.
  if (segments.length === 0 && totalSegments.length === 1) {
    segments = headerless;
    statedTotal = undefined;
  }

  // „kopanie materiál, odvoz materiálu, pracovníci za 10 831 eur" — výpočet
  // popisov BEZ jediného čísla a suma „za …" iba na konci celého výpočtu.
  // Suma je vyslovená za celým zoznamom → celková suma (nerozpočíta sa).
  // Asistent sa na ceny riadkov spýta a ich súčet s ňou porovná, takže nič
  // nevzniká odhadom. Pri inom tvare (dve sumy, suma uprostred) ostáva
  // doterajšia prísna cesta.
  if (statedTotal === undefined && segments.length >= 3) {
    const last = segments[segments.length - 1];
    const trailing = /^(.*\S)\s+(?:za|for|fuer|für)\s+(\S+(?:\s+\S+)?)$/i.exec(last.replace(/[.!?]+$/, ""));
    const money = moneyTokens(last);
    if (
      trailing &&
      money.length === 1 &&
      hasCurrencyMarker(last) &&
      findNumber(trailing[1]) === null &&
      segments.slice(0, -1).every((segment) => findNumber(segment) === null)
    ) {
      statedTotal = money[0];
      segments = [...segments.slice(0, -1), trailing[1]];
    }
  }

  if (segments.length === 0) return empty();
  const merged = mergeQuantityContinuations(segments);
  segments.length = 0;
  segments.push(...merged);

  if (segments.length > MAX_VOICE_ITEMS) {
    // Veta, z ktorej vyšlo príliš mnoho úsekov, sa takmer isto rozdelila
    // zle. Bezpečnejšie je to priznať než založiť doklad s deviatimi
    // nezmyselnými riadkami.
    return { items: [], problem: "too_many_items", recognized: [], unresolved: segments, ...(statedTotal !== undefined ? { statedTotal } : {}) };
  }

  const items: InvoiceItemCandidate[] = [];
  const unresolved: string[] = [];
  for (const segment of segments) {
    const item = segmentToItem(segment);
    if (item) items.push(item);
    else unresolved.push(segment);
  }

  // Množstvo × cena bez popisu („10 hodín po 35 eur") alebo záporné
  // množstvo: vieme, že ide o položku, ale nie ČO to je / nedá sa prijať.
  // Nesmie z toho vzniknúť riadok s celou vetou ako popisom a cenou
  // doplnenou neskôr (35 € namiesto 350 €) — preto „nejasné" → otázka.
  const totalPart = statedTotal !== undefined ? { statedTotal } : {};
  if (segments.some(hasNegativeQuantity) || unresolved.some((segment) => readQuantityPrice(segment) !== null)) {
    return { items: [], problem: "ambiguous", recognized: items, unresolved, ...totalPart };
  }

  if (items.length === 0) return empty();

  const fail = (problem: ItemParseResult["problem"]): ItemParseResult => ({
    items: [],
    problem,
    recognized: items,
    unresolved,
    ...totalPart,
  });

  // Jedna položka bez ceny je bežný, zvládnutý prípad — asistent sa
  // dopýta. Viac položiek, z ktorých niektorej chýba cena, je iné: je to
  // signál, že rozdelenie prebehlo zle, a preto sa nič nevracia.
  //
  // VÝNIMKA: vety bez JEDINÉHO čísla („kopanie, odvoz materiálu,
  // pracovníci"). Tam sa nič stratiť nemohlo — nie je čo — a čiarka je
  // jednoznačný oddeľovač. Takéto popisy sa vrátia bez ceny a asistent sa
  // na ceny spýta. Nič sa nedopĺňa a celková suma sa nerozpočítava.
  const withoutPrice = items.filter((item) => item.unitPrice === undefined);
  // Iba keď sú BEZ ceny všetky položky a vo vete niet ani jedného čísla —
  // zmes riadkov s cenou a bez nej ostáva otázkou ako doteraz.
  const pureDescriptions =
    withoutPrice.length === items.length && segments.every((segment) => findNumber(segment) === null);

  if (items.length > 1 && withoutPrice.length > 0 && !pureDescriptions) {
    return fail("ambiguous");
  }

  // ROZDIELNE ZNAČENIE MENY — keď meno partnera nebolo známe.
  //
  // Bez overeného mena sa nedá odlíšiť „Tester 1" od položky za jedno
  // euro. Keď časť úsekov menu nesie a časť nie, je to typicky stopa po
  // niečom, čo položka nie je — vtedy sa nič nevracia a asistent sa spýta.
  //
  // Keď meno známe BOLO a odrezalo sa, pravidlo sa neuplatňuje:
  // „Erdarbeiten 300 Euro und Transport 50" je legitímne.
  if (!partnerRemoved && items.length > 1) {
    const priced = segments.filter((segment) => findNumber(segment) !== null);
    const withCurrency = priced.filter(hasCurrencyMarker).length;
    if (withCurrency > 0 && withCurrency < priced.length) {
      // „kopanie 300, odvoz 650, pracovníci 830 eur" v ODPOVEDI na otázku o
      // položkách: mena raz na konci. Prenesie sa IBA pri úplne pravidelnom
      // tvare — každý úsek má práve jednu sumu na konci a menu nesie výhradne
      // posledný. Inak otázka ako doteraz.
      const regular =
        options.answerContext === true &&
        withCurrency === 1 &&
        hasCurrencyMarker(priced[priced.length - 1]) &&
        priced.every((segment) => segmentMoney(segment).length === 1 && amountIsTrailing(segment));
      if (!regular) return fail("ambiguous");
      const currency = findCurrency(priced[priced.length - 1]);
      if (currency) for (const item of items) if (item.unitPrice !== undefined) item.currency = currency;
    }
  }

  if (withoutPrice.length > 0) {
    return { items, problem: "missing_price", recognized: items, unresolved, ...totalPart };
  }

  const outOfRange = items.some(
    (item) =>
      item.unitPrice !== undefined &&
      (!Number.isFinite(item.unitPrice) ||
        item.unitPrice < 0 ||
        item.unitPrice > MAX_VOICE_UNIT_PRICE)
  );
  if (outOfRange) return fail("ambiguous");

  // ------------------------------------------------------------------
  // REKONCILIÁCIA: každá vyslovená suma musí skončiť ako cena práve
  // jednej položky.
  //
  // Toto je posledná a najdôležitejšia kontrola tohto modulu. Pravidlá
  // vyššie hovoria, či sa veta dala rozdeliť; toto hovorí, či sa pri tom
  // nestratili peniaze. Porovnáva sa MULTIMNOŽINA hodnôt, nie ich počet —
  // dve položky po 50 € sú v poriadku, ale „50" navyše nie je.
  //
  // Percentá sa do peňažných hodnôt nepočítajú; rozoznávajú sa podľa
  // slova za číslom, nie podľa veľkosti.
  // ------------------------------------------------------------------
  // Porovnáva sa nad ÚSEKMI, ktoré zostali — nie nad celou vetou. Meno
  // partnera („Tester 1") a útržok po reze chvosta o DPH sa vyradili vyššie
  // a ich čísla sem nepatria; všetko ostatné áno, vrátane úsekov, z ktorých
  // položka nevyšla. Práve tie sú dôvod, prečo rekonciliácia existuje.
  // Množstvo („10 hodín") je číslo, nie peniaze — z vyslovených súm sa
  // odoberie práve raz za každú položku, ktorá ho má.
  const spokenAll = segments.flatMap(segmentMoney);
  for (const item of items) {
    if (item.quantity === undefined) continue;
    const at = spokenAll.indexOf(item.quantity);
    if (at !== -1) spokenAll.splice(at, 1);
  }
  const spoken = spokenAll.slice().sort((a, b) => a - b);
  const used = items
    .map((item) => item.unitPrice as number)
    .slice()
    .sort((a, b) => a - b);

  const reconciled =
    spoken.length === used.length && spoken.every((value, index) => value === used[index]);

  if (!reconciled) return fail("ambiguous");

  return { items, problem: null, recognized: items, unresolved, ...totalPart };
}

/**
 * Rozpozná JEDNU doplnenú položku z odpovede ako „pridaj ešte dopravu 50
 * eur".
 *
 * Odpoveď na doplnenie sa vyhodnocuje samostatne a úmyselne prísnejšie:
 * musí z nej vyjsť práve jedna položka s cenou. Keď vyjde viac, vráti sa
 * `null` a volajúci sa spýta — pridávanie viacerých riadkov naraz „po
 * ceste" je presne ten prípad, kde sa tichá chyba najľahšie prehliadne.
 */
export function extractSingleAppendedItem(rawAnswer: string): InvoiceItemCandidate | null {
  const stripped = normalizeSpokenAmounts(rawAnswer).replace(
    /^\s*(pridaj( este| ešte)?|doplň|doplnit|dodaj|fuege hinzu|füge hinzu|add|(a\s+)?(este|ešte|plus|noch|also))\s+/i,
    ""
  );

  const segments = mergeQuantityContinuations(splitIntoSegments(stripped.trim()));
  if (segments.length !== 1) return null;
  if (hasNegativeQuantity(segments[0])) return null;

  const item = segmentToItem(segments[0]);
  if (!item || item.unitPrice === undefined) return null;
  if (item.unitPrice < 0 || item.unitPrice > MAX_VOICE_UNIT_PRICE) return null;

  return item;
}
