// Relatívny import (rovnako ako v lib/i18n/*) — vďaka nemu sa modul dá
// spustiť priamo v Node, takže testy nepotrebujú bundler ani závislosť.
import { findNumber, findCurrency, tokenize } from "./number-words.ts";

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
// a jednotku nechává nevyplnené; predvolené hodnoty dosadzuje až vrstva
// nad ním, a to iba tie, ktoré dosadí aj formulár v UI.
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
  return /^[\s\d.,;:%-]*$/.test(segment);
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
  const found = findNumber(segment);
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
const PRICE_NOISE = /\b(eur|euro|eura|eurov|euros|czk|usd|dolar\w*|dollars?|kc|kč|pln|gbp)\b/gi;

/**
 * Predložky, ktoré vnútri úseku uvádzajú predmet alebo cenu („**za**
 * kopanie", „kopanie **za** 300 eur"). Odstraňujú sa z popisu, nie z vety —
 * orezávanie celej vety podľa nich bolo príčinou chyby s 1 €.
 */
const SEGMENT_PREPOSITIONS = /(^|\s)(za|fuer|für|for|ueber|über)(\s|$)/gi;

function segmentToItem(segment: string): InvoiceItemCandidate | null {
  const amount = findNumber(segment);

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

  description = description
    .replace(PRICE_NOISE, " ")
    .replace(SEGMENT_PREPOSITIONS, " ")
    .replace(/[.,;:!?]+\s*$/, "")
    .replace(/^\s*[-–—]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

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
  partnerHint?: string
): ItemParseResult {
  const empty = (problem: ItemParseResult["problem"] = null): ItemParseResult => ({
    items: [],
    problem,
    recognized: [],
    unresolved: [],
  });

  const { section, partnerRemoved } = extractItemsSection(rawText, partnerHint);
  if (!section) return empty();

  const allSegments = splitIntoSegments(section);
  if (allSegments.length === 0) return empty();

  // Príkazová hlavička a meno partnera nie sú položky. Meno sa väčšinou
  // odrezalo už pri hľadaní úseku; toto je poistka pre prípad, že stojí vo
  // vete druhýkrát. Útržok po reze chvosta o DPH („23") sa zahodí ticho —
  // je to stopa po našom reze, nie obsah od používateľa.
  const segments = allSegments
    .map(stripCommandHeader)
    .filter((segment): segment is string => segment !== null)
    .filter(
      (segment) => !matchesPartnerHint(segment, partnerHint) && !isCutRemnant(segment)
    );

  if (segments.length === 0) return empty();

  if (segments.length > MAX_VOICE_ITEMS) {
    // Veta, z ktorej vyšlo príliš mnoho úsekov, sa takmer isto rozdelila
    // zle. Bezpečnejšie je to priznať než založiť doklad s deviatimi
    // nezmyselnými riadkami.
    return { items: [], problem: "too_many_items", recognized: [], unresolved: segments };
  }

  const items: InvoiceItemCandidate[] = [];
  const unresolved: string[] = [];
  for (const segment of segments) {
    const item = segmentToItem(segment);
    if (item) items.push(item);
    else unresolved.push(segment);
  }

  if (items.length === 0) return empty();

  const fail = (problem: ItemParseResult["problem"]): ItemParseResult => ({
    items: [],
    problem,
    recognized: items,
    unresolved,
  });

  // Jedna položka bez ceny je bežný, zvládnutý prípad — asistent sa
  // dopýta. Viac položiek, z ktorých niektorej chýba cena, je iné: je to
  // signál, že rozdelenie prebehlo zle, a preto sa nič nevracia.
  const withoutPrice = items.filter((item) => item.unitPrice === undefined);

  if (items.length > 1 && withoutPrice.length > 0) {
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
    const withCurrency = segments.filter(hasCurrencyMarker).length;
    if (withCurrency > 0 && withCurrency < segments.length) {
      return fail("ambiguous");
    }
  }

  if (withoutPrice.length > 0) {
    return { items, problem: "missing_price", recognized: items, unresolved };
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
  const spoken = moneyTokens(segments.join(" ; ")).slice().sort((a, b) => a - b);
  const used = items
    .map((item) => item.unitPrice as number)
    .slice()
    .sort((a, b) => a - b);

  const reconciled =
    spoken.length === used.length && spoken.every((value, index) => value === used[index]);

  if (!reconciled) return fail("ambiguous");

  return { items, problem: null, recognized: items, unresolved };
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
  const stripped = rawAnswer.replace(
    /^\s*(pridaj( este| ešte)?|doplň|doplnit|dodaj|fuege hinzu|füge hinzu|add)\s+/i,
    ""
  );

  const segments = splitIntoSegments(stripped.trim());
  if (segments.length !== 1) return null;

  const item = segmentToItem(segments[0]);
  if (!item || item.unitPrice === undefined) return null;
  if (item.unitPrice < 0 || item.unitPrice > MAX_VOICE_UNIT_PRICE) return null;

  return item;
}
