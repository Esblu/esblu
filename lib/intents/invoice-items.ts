// Relatívny import (rovnako ako v lib/i18n/*) — vďaka nemu sa modul dá
// spustiť priamo v Node, takže testy nepotrebujú bundler ani závislosť.
import { findNumber, findCurrency } from "./number-words.ts";

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
 * Frázy, ktoré uvádzajú predmet fakturácie. Všetko pred prvou z nich je
 * hlavička príkazu („Vytvor faktúru pre Tester1") a do položiek nepatrí.
 */
const ITEMS_LEAD_PHRASES = [
  " za ",
  " fuer ",
  " für ",
  " for ",
  " ueber ",
  " über ",
  ":",
];

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
 * KTORÁ UVÁDZACIA FRÁZA
 * ---------------------
 * Tá istá predložka uvádza aj odberateľa, aj predmet: „Rechnung **für**
 * Tester1 **für** Erdarbeiten", „invoice **for** X **for** excavation".
 * Prvý výskyt je preto takmer vždy ten nesprávny — berie sa POSLEDNÝ,
 * pretože položky stoja vo vete na konci, hneď pred zmienkou o DPH.
 * Dvojbodka má prednosť, keď je prítomná: je jednoznačná.
 *
 * Známe obmedzenie: veta, ktorej POPIS sám obsahuje uvádzaciu predložku
 * („za práce za september 300 eur"), sa odreže na poslednom výskyte a
 * popisom sa stane „september". Nie je to tichá strata sumy ani položky —
 * popis je v koncepte vidieť a dá sa prepísať.
 */
function extractItemsSection(rawText: string): string {
  const folded = fold(rawText);

  // Začiatok: za POSLEDNOU uvádzacou frázou.
  let start = 0;
  let bestIndex = -1;
  for (const phrase of ITEMS_LEAD_PHRASES) {
    const index = folded.lastIndexOf(fold(phrase));
    if (index !== -1 && index > bestIndex) {
      bestIndex = index;
      start = index + phrase.length;
    }
  }
  if (bestIndex === -1) return "";

  // Koniec: pred najskoršou zmienkou o DPH, ktorá nasleduje za začiatkom.
  let end = rawText.length;
  for (const phrase of VAT_TAIL_PHRASES) {
    const index = folded.indexOf(fold(phrase), start);
    if (index !== -1 && index < end) end = index;
  }

  return rawText.slice(start, end).trim();
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

function splitOnConjunctionIfTwoPrices(segment: string): string[] {
  const words = segment.split(/\s+/);

  for (let i = 1; i < words.length - 1; i++) {
    if (!CONJUNCTIONS.includes(fold(words[i]))) continue;

    const left = words.slice(0, i).join(" ");
    const right = words.slice(i + 1).join(" ");

    // Rozdeľuje sa IBA keď má cenu každá strana. Inak je spojka časťou
    // popisu a segment zostáva celý.
    if (findNumber(left) && findNumber(right)) {
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
export function extractInvoiceItems(rawText: string): ItemParseResult {
  const section = extractItemsSection(rawText);
  if (!section) return { items: [], problem: null };

  const segments = splitIntoSegments(section);
  if (segments.length === 0) return { items: [], problem: null };

  if (segments.length > MAX_VOICE_ITEMS) {
    // Veta, z ktorej vyšlo príliš mnoho úsekov, sa takmer isto rozdelila
    // zle. Bezpečnejšie je to priznať než založiť doklad s deviatimi
    // nezmyselnými riadkami.
    return { items: [], problem: "too_many_items" };
  }

  const items: InvoiceItemCandidate[] = [];
  for (const segment of segments) {
    const item = segmentToItem(segment);
    if (item) items.push(item);
  }

  if (items.length === 0) return { items: [], problem: null };

  // Jedna položka bez ceny je bežný, zvládnutý prípad — asistent sa
  // dopýta. Viac položiek, z ktorých niektorej chýba cena, je iné: je to
  // signál, že rozdelenie prebehlo zle, a preto sa nič nevracia.
  const withoutPrice = items.filter((item) => item.unitPrice === undefined);

  if (items.length > 1 && withoutPrice.length > 0) {
    return { items: [], problem: "ambiguous" };
  }

  if (withoutPrice.length > 0) {
    return { items, problem: "missing_price" };
  }

  const outOfRange = items.some(
    (item) =>
      item.unitPrice !== undefined &&
      (!Number.isFinite(item.unitPrice) ||
        item.unitPrice < 0 ||
        item.unitPrice > MAX_VOICE_UNIT_PRICE)
  );
  if (outOfRange) return { items: [], problem: "ambiguous" };

  return { items, problem: null };
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
