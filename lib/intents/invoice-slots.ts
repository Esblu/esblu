import { findNumber, findCurrency, findVatRate, mentionsVat, normalizeSpokenAmounts } from "./number-words.ts";
import {
  extractInvoiceItems,
  extractSingleAppendedItem,
  moneyTokens,
  MAX_VOICE_ITEMS,
  MAX_VOICE_UNIT_PRICE,
  MAX_DESCRIPTION_LENGTH,
  type InvoiceItemCandidate,
} from "./invoice-items.ts";
import { isVatCategoryCode, type VatCategoryCode } from "../invoicing/vat-categories.ts";
import {
  detectPriceModeStatement,
  isPriceMode,
  DEFAULT_PRICE_MODE,
  type PriceMode,
} from "../invoicing/price-mode.ts";

// =============================================================================
// Stav rozpracovanej hlasovej faktúry — čisté funkcie nad slotmi.
//
// PREČO SAMOSTATNÝ SÚBOR
// ----------------------
// Tieto funkcie rozhodujú, čo znamená odpoveď používateľa a čo ešte chýba.
// Donedávna sedeli vedľa volaní do databázy, takže sa nedali odskúšať bez
// Supabase — a práve tu vznikla chyba, ktorú nahlásil reálny test: výber
// partnera sa vyhodnotil ako pridanie položky a rozpracované položky sa
// stratili. Stavová logika, ktorá sa nedá spustiť v teste, je stavová
// logika, ktorej nikto neverí.
//
// Súbor preto nemá žiadnu závislosť na databáze ani na prekladoch a dá sa
// spustiť priamo v Node (scripts/draft-state-tests.ts).
//
// ČO TU NIE JE
// ------------
// Nič, čo sa pýta databázy: resolvovanie partnera, čítanie mien, samotné
// založenie dokladu. To zostáva v lib/intents/invoice-draft.ts.
// =============================================================================

/** Odstráni diakritiku a zjednotí veľkosť písmen. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export type { VatCategoryCode, InvoiceItemCandidate };

/**
 * Kandidát na partnera tak, ako ho vidí táto vrstva: identifikátor a
 * označenie. Označenie skladá volajúci z databázy — sem sa dostáva už
 * hotové, aby tento súbor nepotreboval Supabase.
 */
export type PartnerCandidate = { id: string; label: string };

export type InvoiceDraftSlots = {
  partnerId?: string;
  /** Kandidáti pri nejednoznačnom mene — iba identifikátory, max 5. */
  partnerCandidateIds?: string[];
  /**
   * Riadkové položky. Phase 3A: pole namiesto jednej trojice
   * popis/množstvo/cena.
   *
   * Sadzba a kategória DPH tu ZÁMERNE nie sú — platia pre celý doklad.
   * Per-riadkovú daň by hlas rozhodoval bez toho, aby ju používateľ mohol
   * pri diktovaní prehliadnuť, a to je presne to, čo appka o dani
   * nerozhoduje.
   */
  items?: InvoiceItemCandidate[];
  currency?: string;
  vatCategoryCode?: VatCategoryCode;
  vatRate?: number;
  /**
   * Sumy, ktoré v úseku o položkách naozaj zazneli.
   *
   * Nesú sa cez celý dialóg, aby sa tesne pred zápisom dalo overiť, že
   * každá z nich skončila ako cena práve jednej položky. Bez toho sa
   * strata riadku prejaví až na hotovom doklade — čo je presne prípad,
   * keď sa z dvoch položiek stala jedna za 1 €.
   *
   * Po prvej vete ich naplní parser. Odpovede na otázky menia vždy jedno
   * pole naraz a sami si ich udržiavajú v súlade s položkami; hodnota
   * preto nikdy nechýba a rekonciliácia sa nedá preskočiť.
   */
  spokenAmounts?: number[];
  /**
   * Sú vyslovené sumy s daňou, alebo bez nej?
   *
   * Samostatný slot, lebo je to samostatná otázka. „Uvedené ceny sú už s
   * DPH" hovorí, AKO sú sumy vyjadrené; sadzbu z toho odvodiť nemožno a
   * appka sa na ňu preto pýta ďalej. Keď o režime nepovedal nikto nič,
   * platí `DEFAULT_PRICE_MODE` — to isté, čo predvolí formulár v UI.
   */
  priceMode?: PriceMode;
  /**
   * Celková suma, ktorú používateľ vyslovil („… spolu 1 832 eur").
   *
   * NIE JE to cena žiadnej položky a nikdy sa do riadkov nerozpočítava.
   * Keď sú ceny riadkov známe, ich súčet sa s ňou porovná; nesúlad je
   * otázka (pole `total`), nikdy tichá úprava súm.
   */
  statedTotal?: number;
};

export type { PriceMode };

/** Poradie, v akom sa asistent pýta. Zhora nadol, vždy jedna otázka. */
export type InvoiceDraftField =
  | "partner"
  | "partnerChoice"
  | "items"
  | "itemPrice"
  | "total"
  | "vat";

/**
 * Explicitný stav rozhovoru o faktúre. Odvodzuje sa z PRVÉHO uloženého
 * chýbajúceho poľa — teda z otázky, ktorá naozaj zaznela — nie zo slotov
 * nanovo. Tým sa zabezpečuje, že WAITING_ITEMS sa nikdy „nevráti" do
 * WAITING_PARTNER: partner, ktorý je raz vyriešený, v chýbajúcich poliach
 * už nie je, a zmeniť ho vie iba výslovná veta „Zmeň odberateľa na …".
 *
 *   WAITING_PARTNER              partner
 *   WAITING_PARTNER_CONFIRMATION partnerChoice („Myslíte …?" / výber)
 *   WAITING_ITEMS                items
 *   WAITING_ITEM_CLARIFICATION   itemPrice, total
 *   WAITING_PRICE_MODE           vat (sadzba + režim ceny)
 *   DRAFT_READY                  nič nechýba → vznikne DRAFT (nie finalizácia)
 *
 * WAITING_FINAL_CONFIRMATION hlasom neexistuje: finalizácia (číslo, VAT
 * rozpis, nemennosť) je výhradne v UI cez esblu_finalize_invoice().
 */
export type InvoiceConversationStage =
  | "WAITING_PARTNER"
  | "WAITING_PARTNER_CONFIRMATION"
  | "WAITING_ITEMS"
  | "WAITING_ITEM_CLARIFICATION"
  | "WAITING_PRICE_MODE"
  | "DRAFT_READY";

export function invoiceStage(field: InvoiceDraftField | undefined): InvoiceConversationStage {
  switch (field) {
    case "partner": return "WAITING_PARTNER";
    case "partnerChoice": return "WAITING_PARTNER_CONFIRMATION";
    case "items": return "WAITING_ITEMS";
    case "itemPrice":
    case "total": return "WAITING_ITEM_CLARIFICATION";
    case "vat": return "WAITING_PRICE_MODE";
    default: return "DRAFT_READY";
  }
}

/**
 * Uloží chýbajúce polia tak, aby PRVÉ bolo to, na ktoré sa asistent práve
 * pýta. Produkčná chyba: otázka znela „Za čo má byť faktúra?", ale uložené
 * prvé pole bolo `partner` — a ďalšia veta („Kopanie, odvoz materiálu,
 * pracovníci.") sa hľadala ako obchodný partner.
 */
export function orderMissingFields(missing: InvoiceDraftField[], asked: InvoiceDraftField | undefined): InvoiceDraftField[] {
  if (!asked) return missing;
  return [asked, ...missing.filter((field) => field !== asked)];
}


const SLOT_KEYS: (keyof InvoiceDraftSlots)[] = [
  "partnerId",
  "partnerCandidateIds",
  "items",
  "currency",
  "vatCategoryCode",
  "vatRate",
  "spokenAmounts",
  "priceMode",
  "statedTotal",
];

/**
 * Zosúladí zoznam vyslovených súm s položkami.
 *
 * Volá sa po KAŽDEJ zmene položiek v dialógu. Odpoveď na otázku mení vždy
 * jedno pole a appka vie, ktoré — takže po nej je stav zo svojej podstaty
 * v súlade. Riziková je prvá veta a tú rekonciluje parser; táto funkcia
 * drží invariant ďalej, aby sa kontrola pred zápisom nedala obísť tým, že
 * hodnota jednoducho chýba.
 */
export function syncSpokenAmounts(slots: InvoiceDraftSlots): InvoiceDraftSlots {
  const prices = (slots.items ?? [])
    .map((item) => item.unitPrice)
    .filter((price): price is number => typeof price === "number");
  return { ...slots, spokenAmounts: prices };
}


/**
 * Prečíta sloty z uloženého jsonb.
 *
 * Každá hodnota sa overuje samostatne, aj keď ju tam zapísala tá istá
 * aplikácia — riadok v databáze je pre server vstup, nie pamäť procesu.
 */
export function readSlots(raw: unknown): InvoiceDraftSlots {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const slots: InvoiceDraftSlots = {};

  if (typeof source.partnerId === "string" && UUID_PATTERN.test(source.partnerId)) {
    slots.partnerId = source.partnerId;
  }
  if (Array.isArray(source.partnerCandidateIds)) {
    const ids = source.partnerCandidateIds
      .filter((id): id is string => typeof id === "string" && UUID_PATTERN.test(id))
      .slice(0, 5);
    if (ids.length > 0) slots.partnerCandidateIds = ids;
  }
  // Položky sa validujú riadok po riadku. Uložený jsonb je pre server
  // VSTUP, nie pamäť procesu — aj keď ho tam zapísala tá istá aplikácia,
  // medzitým ho mohol niekto zmeniť priamym volaním RPC.
  if (Array.isArray(source.items)) {
    const items: InvoiceItemCandidate[] = [];

    for (const raw of source.items.slice(0, MAX_VOICE_ITEMS)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;

      const description =
        typeof row.description === "string" ? row.description.trim() : "";
      if (!description) continue;

      const item: InvoiceItemCandidate = {
        description: description.slice(0, MAX_DESCRIPTION_LENGTH),
      };

      // Cena: iba konečné, nezáporné číslo v rozumnom rozsahu. NaN,
      // Infinity ani záporná hodnota sa nikdy nestanú nulou — pole
      // jednoducho zostane nevyplnené a asistent sa spýta.
      if (
        typeof row.unitPrice === "number" &&
        Number.isFinite(row.unitPrice) &&
        row.unitPrice >= 0 &&
        row.unitPrice <= MAX_VOICE_UNIT_PRICE
      ) {
        item.unitPrice = row.unitPrice;
      }

      if (
        typeof row.quantity === "number" &&
        Number.isFinite(row.quantity) &&
        row.quantity > 0 &&
        row.quantity <= MAX_VOICE_UNIT_PRICE
      ) {
        item.quantity = row.quantity;
      }

      if (typeof row.unit === "string" && row.unit.trim()) {
        item.unit = row.unit.trim().slice(0, 20);
      }

      if (typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency)) {
        item.currency = row.currency;
      }

      items.push(item);
    }

    if (items.length > 0) slots.items = items;
  }

  if (typeof source.currency === "string" && /^[A-Z]{3}$/.test(source.currency)) {
    slots.currency = source.currency;
  }
  if (typeof source.vatCategoryCode === "string" && isVatCategoryCode(source.vatCategoryCode)) {
    slots.vatCategoryCode = source.vatCategoryCode;
  }
  if (typeof source.vatRate === "number" && Number.isFinite(source.vatRate) && source.vatRate >= 0 && source.vatRate <= 100) {
    slots.vatRate = source.vatRate;
  }

  // Vyslovené sumy prechádzajú rovnakou kontrolou ako ceny. Podvrhnutá
  // hodnota by rekonciláciu neoslabila — musela by sa trafiť do cien,
  // ktoré prešli vlastnou validáciou — ale nedôveryhodný vstup sa tu
  // zásadne nevalidný neprepúšťa.
  if (isPriceMode(source.priceMode)) {
    slots.priceMode = source.priceMode;
  }

  if (
    typeof source.statedTotal === "number" &&
    Number.isFinite(source.statedTotal) &&
    source.statedTotal > 0 &&
    source.statedTotal <= MAX_VOICE_UNIT_PRICE * MAX_VOICE_ITEMS
  ) {
    slots.statedTotal = source.statedTotal;
  }

  if (Array.isArray(source.spokenAmounts)) {
    const amounts = source.spokenAmounts.filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MAX_VOICE_UNIT_PRICE
    );
    if (amounts.length === source.spokenAmounts.length) slots.spokenAmounts = amounts;
  }

  return slots;
}

/** Iba definované hodnoty — kontext sa drží čo najmenší. */
export function serializeSlots(slots: InvoiceDraftSlots): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SLOT_KEYS) {
    const value = slots[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export function missingInvoiceFields(slots: InvoiceDraftSlots): InvoiceDraftField[] {
  const missing: InvoiceDraftField[] = [];

  if (!slots.partnerId) {
    missing.push(slots.partnerCandidateIds?.length ? "partnerChoice" : "partner");
  }
  if (!slots.items || slots.items.length === 0) {
    missing.push("items");
  } else if (slots.items.some((item) => item.unitPrice === undefined)) {
    // Ktorejkoľvek položke chýba cena. Pýta sa vždy na PRVÚ takú (pozri
    // firstItemWithoutPrice) — jedna otázka na jednu chýbajúcu hodnotu.
    missing.push("itemPrice");
  } else if (slots.statedTotal !== undefined && !totalMatches(slots)) {
    // Všetky ceny sú známe, ale ich súčet nesedí s vyslovenou celkovou
    // sumou. Nič sa neupraví — asistent sa spýta.
    missing.push("total");
  }

  // Kategória AJ sadzba musia byť obe známe. Kategória bez sadzby je pri
  // "S" neúplná; sadzba bez kategórie je pri nule nejednoznačná.
  if (!slots.vatCategoryCode || slots.vatRate === undefined) missing.push("vat");

  return missing;
}


const VAT_CATEGORY_KEYWORDS: { code: VatCategoryCode; words: string[] }[] = [
  { code: "Z", words: ["nulova", "nulovu", "zero", "null rate", "nullsatz"] },
  {
    code: "E",
    words: ["oslobod", "befreit", "steuerbefreit", "exempt", "bez dane"],
  },
  {
    code: "AE",
    words: ["prenesen", "reverse", "umkehrung", "steuerschuldnerschaft"],
  },
  { code: "S", words: ["zakladna", "standard", "regelsatz", "bezna"] },
];

/**
 * Spracuje odpoveď používateľa na konkrétnu otázku.
 *
 * Každé pole má vlastné pravidlá, lebo "300" ako odpoveď na otázku o sume
 * a "300" ako odpoveď na otázku o DPH znamenajú niečo iné. Bez viazania na
 * položenú otázku by sa asistent musel domýšľať, čo používateľ myslel.
 */
export function applyAnswer(
  slots: InvoiceDraftSlots,
  field: InvoiceDraftField,
  rawAnswer: string,
  candidates: PartnerCandidate[]
): InvoiceDraftSlots {
  // Invariant o vyslovených sumách drží obal, nie jednotlivé vetvy — inak
  // by ho ďalšia pridaná vetva ticho porušila.
  return syncSpokenAmounts(applyAnswerToSlots(slots, field, rawAnswer, candidates));
}

function applyAnswerToSlots(
  slots: InvoiceDraftSlots,
  field: InvoiceDraftField,
  rawAnswer: string,
  candidates: PartnerCandidate[]
): InvoiceDraftSlots {
  const next: InvoiceDraftSlots = { ...slots };
  const answer = normalizeSpokenAmounts(rawAnswer.trim());
  if (!answer) return next;

  switch (field) {
    case "partner": {
      // Odpoveď na "pre koho" je meno. Resolvovanie proti reálnym
      // partnerom robí volajúci (potrebuje dotaz do databázy), takže tu
      // sa slot nemení.
      return next;
    }

    case "partnerChoice": {
      const folded = fold(answer);
      const picked = candidates.find((candidate) => fold(candidate.label).includes(folded));
      if (picked) {
        next.partnerId = picked.id;
        next.partnerCandidateIds = undefined;
        return next;
      }
      // "prvý"/"druhý"/"the first" — poradie zodpovedá poradiu v otázke.
      const ordinal = readOrdinal(folded);
      if (ordinal !== null && candidates[ordinal]) {
        next.partnerId = candidates[ordinal].id;
        next.partnerCandidateIds = undefined;
      }
      return next;
    }

    case "items": {
      // Odpoveď na „za čo má byť faktúra?" môže obsahovať aj viac položiek
      // naraz („za kopanie 300 eur a dopravu 50"). Rozdelenie rieši ten
      // istý parser ako pri celej vete — vrátane odmietnutia, keď si nie
      // je istý.
      const parsed = extractInvoiceItems(/^\s*(za|fuer|für|for)\s/i.test(answer) ? answer : `za ${answer}`, undefined, { answerContext: true });
      if (parsed.statedTotal !== undefined) next.statedTotal = parsed.statedTotal;

      if (parsed.items.length > 0 && parsed.problem !== "ambiguous") {
        next.items = parsed.items.slice(0, MAX_VOICE_ITEMS);
        const currency = findCurrency(answer);
        if (currency) next.currency = currency;
        // „… po 35 eur s DPH / bez DPH" — ten istý detektor a to isté
        // pravidlo ako pri prvej vete (startInvoiceDraftFlow). Zmiešané
        // alebo nevyslovené = nič sa nenastaví; na režim sa spýta otázka o DPH.
        const statedMode = detectPriceModeStatement(answer);
        if (statedMode === "net" || statedMode === "gross") next.priceMode = statedMode;
        return next;
      }

      // Parser si nie je istý. Odpoveď sa vezme ako JEDEN popis bez ceny —
      // cena sa potom dopýta samostatne. Nikdy sa z nej nestane nula.
      if (parsed.problem !== "ambiguous" && parsed.problem !== "too_many_items") {
        const description = answer.replace(/[.,;:!?]+\s*$/, "").trim();
        if (description) {
          next.items = [{ description: description.slice(0, MAX_DESCRIPTION_LENGTH) }];
        }
      }

      return next;
    }

    case "itemPrice": {
      // Viac cien naraz („kopanie 300, odvoz 650, pracovníci 882") —
      // priradia sa k POMENOVANÝM riadkom, alebo pri holých číslach v
      // poradí, v akom ich otázka vymenovala. Inak nič.
      const multi = assignItemPrices(next, answer);
      if (multi) return multi;

      // Cena sa dopĺňa do PRVEJ položky, ktorej chýba — presne tej, na
      // ktorú sa asistent pýtal.
      const target = firstItemWithoutPrice(next.items);
      if (target === null) return next;
      // Viac čísel, ktoré sa nedali priradiť, nie je jedna cena.
      if (moneyTokens(answer).length > 1) return next;

      const amount = findNumber(answer);
      if (amount && amount.value >= 0 && amount.value <= MAX_VOICE_UNIT_PRICE) {
        const items = [...(next.items ?? [])];
        items[target] = { ...items[target], unitPrice: amount.value };
        next.items = items;
      }

      const currency = findCurrency(answer);
      if (currency) next.currency = currency;
      return next;
    }

    case "total": {
      // „Áno, platí súčet položiek" — riadky sú autoritou, celková suma sa
      // zahodí. Opravu ceny rieši `applyItemCorrection` o vrstvu vyššie.
      const folded = fold(answer);
      if (/(^|\s)(ano|áno|plati sucet|sucet poloziek|spravne|ja|yes|correct|stimmt)(\s|$)/.test(folded)) {
        next.statedTotal = undefined;
      }
      return next;
    }

    case "vat": {
      // REŽIM CENY JE INÁ OTÁZKA NEŽ SADZBA.
      //
      // „Uvedené ceny sú už s DPH" je platná a dôležitá odpoveď — hovorí
      // však o tom, AKO sú sumy vyjadrené, nie o tom, AKÁ daň platí.
      // Uloží sa a dialóg sa pýta ďalej. Bez tohto kroku appka zopakovala
      // tú istú otázku, akoby používateľ nič nepovedal; presne to hlásil
      // reálny test.
      //
      // Zmiešané režimy („prvá cena je s DPH") sa nepodporujú a zámerne sa
      // NEUKLADAJÚ — vrstva nad tým sa spýta.
      const priceModeStatement = detectPriceModeStatement(answer);
      if (priceModeStatement === "net" || priceModeStatement === "gross") {
        next.priceMode = priceModeStatement;
      }

      const rate = findVatRate(answer);
      const bareNumber = rate === null ? findNumber(answer) : null;

      const folded = fold(answer);
      const category = VAT_CATEGORY_KEYWORDS.find((entry) =>
        entry.words.some((word) => folded.includes(word))
      )?.code;

      if (rate !== null) {
        next.vatRate = rate;
        if (category) next.vatCategoryCode = category;
        else if (rate > 0) next.vatCategoryCode = "S";
      } else if (category) {
        next.vatCategoryCode = category;
        // Kategórie mimo "S" majú vždy nulovú daň — to nie je rozhodnutie
        // appky o sadzbe, ale vlastnosť samotnej kategórie (viď VAT engine).
        if (category !== "S") next.vatRate = 0;
      } else if (bareNumber && bareNumber.value >= 0 && bareNumber.value <= 100 && mentionsVat(answer)) {
        next.vatRate = bareNumber.value;
        if (bareNumber.value > 0) next.vatCategoryCode = "S";
      } else if (bareNumber && bareNumber.value > 0 && bareNumber.value <= 100) {
        // Odpoveď na otázku o DPH je holé číslo — v tomto kontexte je to
        // jednoznačne sadzba, aj bez slova "percent".
        next.vatRate = bareNumber.value;
        next.vatCategoryCode = "S";
      }

      return next;
    }
  }
}

/** Súčet riadkov (množstvo × cena) v centoch — rovnako pre oba režimy ceny. */
export function itemsSumCents(items: InvoiceItemCandidate[] | undefined): number {
  return (items ?? []).reduce(
    (sum, item) => sum + Math.round((item.quantity ?? 1) * (item.unitPrice ?? 0) * 100),
    0
  );
}

/** Sedí súčet riadkov s vyslovenou celkovou sumou (na cent)? */
export function totalMatches(slots: InvoiceDraftSlots): boolean {
  if (slots.statedTotal === undefined) return true;
  return itemsSumCents(slots.items) === Math.round(slots.statedTotal * 100);
}

/**
 * Aký je platný režim ceny — vrátane predvoleného.
 *
 * Existuje preto, aby sa `?? DEFAULT_PRICE_MODE` nepísalo na piatich
 * miestach a na šiestom sa zabudlo.
 */
export function effectivePriceMode(slots: InvoiceDraftSlots): PriceMode {
  return slots.priceMode ?? DEFAULT_PRICE_MODE;
}

/** Index prvej položky bez ceny, alebo `null`. */
export function firstItemWithoutPrice(
  items: InvoiceItemCandidate[] | undefined
): number | null {
  if (!items) return null;
  const index = items.findIndex((item) => item.unitPrice === undefined);
  return index === -1 ? null : index;
}

/**
 * Pridá k rozpracovanej faktúre ďalšiu položku („Pridaj ešte dopravu 50
 * eur.").
 *
 * PRIPÁJA, neprepisuje. To je celý zmysel — používateľ, ktorý dopĺňa
 * riadok, o ten predchádzajúci prísť nesmie.
 *
 * Vracia `null`, keď sa z odpovede nedá vyčítať práve jedna položka s
 * cenou, alebo by sa prekročil strop počtu riadkov.
 */
export function appendItemFromAnswer(
  slots: InvoiceDraftSlots,
  rawAnswer: string
): InvoiceDraftSlots | null {
  const item = extractSingleAppendedItem(rawAnswer);
  if (!item) return null;

  const existing = slots.items ?? [];
  if (existing.length >= MAX_VOICE_ITEMS) return null;

  return syncSpokenAmounts({ ...slots, items: [...existing, item] });
}

/**
 * Rozpoznanie zámeru „pridaj ešte ..." počas rozpracovanej faktúry.
 *
 * SLOVESÁ, NIE ČASTICE
 * --------------------
 * Pôvodne bolo v zozname aj „este" (z „ešte"). Znelo to neškodne, ale
 * porovnávalo sa podreťazcom — a „Tester1" po odstránení diakritiky
 * obsahuje „este" (t-**este**-r1). Výber partnera sa tak tváril ako
 * pridanie položky. Častice sú na rozpoznanie zámeru prislabé: nesú ho
 * slovesá, a tie sa hľadajú na hranici slova.
 */
const APPEND_VERBS = [
  "pridaj",
  "pridat",
  "doplň",
  "doplnit",
  "dodaj",
  "prihod",
  "fuege",
  "füge",
  "hinzufuegen",
  "hinzufügen",
  "add",
  "append",
];

export function looksLikeItemAppend(rawText: string): boolean {
  const folded = fold(rawText);
  // „Ešte materiál 120 eur." — častica „ešte" iba na ZAČIATKU vety a iba
  // spolu so sumou (nie podreťazec: „Tester1" ju neobsahuje ako slovo).
  if (/^(a\s+)?(este|plus|noch|also)\s+\S/.test(folded) && findNumber(rawText) !== null) return true;
  return APPEND_VERBS.some((verb) => {
    const stem = fold(verb);
    // Hranica slova na oboch stranách — „pridaj" áno, „Tester1" nie.
    return new RegExp(`(^|[^a-z0-9])${escapeForRegex(stem)}([^a-z0-9]|$)`).test(folded);
  });
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readOrdinal(folded: string): number | null {
  if (/\bprv|\berst|\bfirst|\b1\b/.test(folded)) return 0;
  if (/\bdruh|\bzweit|\bsecond|\b2\b/.test(folded)) return 1;
  if (/\btret|\bdritt|\bthird|\b3\b/.test(folded)) return 2;
  return null;
}



// -----------------------------------------------------------------------------
// Viac cien naraz, opravy a odstránenie položky
// -----------------------------------------------------------------------------

/** Kmeň slova na porovnanie popisov („pracovníkov" ~ „pracovníci"). */
function stemOf(word: string): string {
  const folded = fold(word).replace(/[^a-z0-9]/g, "");
  return folded.length > 5 ? folded.slice(0, 5) : folded;
}

function descriptionKey(value: string): string[] {
  return fold(value)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !["za", "pre", "ten", "tie", "tu", "polozku", "polozka", "polozky"].includes(word))
    .map(stemOf);
}

/**
 * Index položky, na ktorú sa veta odvoláva („dopravu" → „doprava").
 * `null`, keď nesedí žiadna alebo viac ako jedna — vtedy sa nič nemení.
 */
export function findItemByMention(items: InvoiceItemCandidate[] | undefined, mention: string): number | null {
  const wanted = descriptionKey(mention);
  if (wanted.length === 0) return null;
  const hits: number[] = [];
  (items ?? []).forEach((item, index) => {
    const key = descriptionKey(item.description);
    if (wanted.every((stem) => key.includes(stem)) || key.length > 0 && key.every((stem) => wanted.includes(stem))) hits.push(index);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Priradí viac cien naraz. Vráti nové sloty, alebo `null`, keď sa odpoveď
 * nedá jednoznačne priradiť (vtedy sa nič nemení a asistent sa spýta).
 */
export function assignItemPrices(slots: InvoiceDraftSlots, rawAnswer: string): InvoiceDraftSlots | null {
  const answer = normalizeSpokenAmounts(rawAnswer);
  const items = [...(slots.items ?? [])];
  const missing = items.map((item, index) => (item.unitPrice === undefined ? index : -1)).filter((index) => index >= 0);
  if (missing.length === 0) return null;

  const parsed = extractInvoiceItems(/^\s*(za|fuer|für|for)\s/i.test(answer) ? answer : `za ${answer}`, undefined, { answerContext: true });

  // 1) Pomenované riadky: každý rozpoznaný popis musí sedieť práve na jednu
  //    položku bez ceny a žiadna položka nesmie dostať dve ceny.
  if (parsed.problem === null && parsed.items.length >= 1 && parsed.items.every((item) => item.unitPrice !== undefined)) {
    const used = new Set<number>();
    const updates: { index: number; price: number; currency?: string }[] = [];
    for (const item of parsed.items) {
      const index = findItemByMention(items, item.description);
      if (index === null || used.has(index) || !missing.includes(index)) {
        updates.length = 0;
        break;
      }
      used.add(index);
      updates.push({ index, price: item.unitPrice as number, currency: item.currency });
    }
    if (updates.length === parsed.items.length && (updates.length > 1 || missing.length > 1)) {
      for (const update of updates) items[update.index] = { ...items[update.index], unitPrice: update.price };
      const currency = findCurrency(answer);
      return syncSpokenAmounts({ ...slots, items, ...(currency ? { currency } : {}) });
    }
  }

  // 2) Holé čísla („300, 650 a 882 eur") — iba keď ich je presne toľko, koľko
  //    chýba cien, a odpoveď neobsahuje žiadne iné slová okrem meny/spojok.
  if (missing.length > 1) {
    const words = fold(answer).split(/[^a-z0-9]+/).filter(Boolean);
    const onlyNumbers = words.every((word) => /^\d+$/.test(word) || ["a", "and", "und", "plus", "eur", "euro", "eura", "eurov", "po", "za"].includes(word) || findNumber(word) !== null);
    const values = moneyTokens(answer);
    if (onlyNumbers && values.length === missing.length && values.every((value) => value >= 0 && value <= MAX_VOICE_UNIT_PRICE)) {
      missing.forEach((index, i) => {
        items[index] = { ...items[index], unitPrice: values[i] };
      });
      const currency = findCurrency(answer);
      return syncSpokenAmounts({ ...slots, items, ...(currency ? { currency } : {}) });
    }
  }
  return null;
}

export type ItemCorrection =
  | { kind: "remove"; index: number }
  | { kind: "change_price"; index: number; price: number }
  | { kind: "unclear" };

const REMOVE_VERBS = /^(odstran|vymaz|zmaz|odober|vyhod|zrus polozku|remove|delete|entferne|losche|loesche)\S*\s+(.+)$/;
const CHANGE_VERBS = /^(zmen|uprav|oprav|daj|nastav|change|set|andere|aendere|setze)\S*\s+(.+?)\s+(na|to|auf)\s+(.+)$/;

/**
 * „Odstráň dopravu." / „Zmeň kopanie na 350 eur." počas rozpracovanej
 * faktúry. Vráti `null`, keď veta opravou nie je. `unclear`, keď opravou
 * je, ale položka sa nedá určiť jednoznačne — vtedy sa nič nemení a
 * asistent sa spýta (nikdy nezmení nesprávny riadok).
 */
export function readItemCorrection(slots: InvoiceDraftSlots, rawAnswer: string): ItemCorrection | null {
  const folded = fold(normalizeSpokenAmounts(rawAnswer)).replace(/[.!?]+$/, "").trim();
  const change = CHANGE_VERBS.exec(folded);
  if (change) {
    const mention = change[2].replace(/^(polozku|polozka|cenu|sumu|cena)\s+/, "");
    if (/odberatel|zakaznik|partner|kunde|customer/.test(mention)) return null;
    const amount = findNumber(change[4]);
    const index = findItemByMention(slots.items, mention);
    if (!amount || moneyTokens(change[4]).length !== 1 || index === null || amount.value < 0 || amount.value > MAX_VOICE_UNIT_PRICE) {
      return { kind: "unclear" };
    }
    return { kind: "change_price", index, price: amount.value };
  }
  const remove = REMOVE_VERBS.exec(folded);
  if (remove) {
    const mention = remove[2].replace(/^(polozku|polozka|riadok)\s+/, "");
    const index = findItemByMention(slots.items, mention);
    return index === null ? { kind: "unclear" } : { kind: "remove", index };
  }
  return null;
}

export function applyItemCorrection(slots: InvoiceDraftSlots, correction: Exclude<ItemCorrection, { kind: "unclear" }>): InvoiceDraftSlots {
  const items = [...(slots.items ?? [])];
  if (correction.kind === "remove") items.splice(correction.index, 1);
  else items[correction.index] = { ...items[correction.index], unitPrice: correction.price };
  return syncSpokenAmounts({ ...slots, items: items.length > 0 ? items : undefined });
}

/**
 * „Zmeň odberateľa na Tester2." — jediná cesta späť k partnerovi, keď už
 * je vyriešený. Vráti vyslovené meno, alebo `null`.
 */
export function readPartnerChange(rawAnswer: string): string | null {
  const match = /^(?:zmen|zmeň|iny|iný|ina|iná|change|andere[rn]?)\S*\s+(?:odberate\S*|zakazn\S*|zákazn\S*|partner\S*|obchodn\S+\s+partner\S*|customer|kunde\S*)\s+(?:na|to|auf)\s+(.+?)[.!?]*$/i.exec(rawAnswer.trim());
  const name = match?.[1]?.trim();
  return name && name.split(/\s+/).length <= 6 ? name : null;
}

/**
 * Vyzerá odpoveď na otázku „Pre ktorého odberateľa?" ako položky faktúry
 * („Kopanie 300 eur, doprava 100 eur")? Vtedy to NIE JE meno partnera.
 */
export function looksLikeInvoiceItems(rawAnswer: string): boolean {
  // Iba so SUMOU V MENE. Holé číslo nestačí: „Tester jedna" / „Tester 1"
  // je meno partnera s číslovkou, nie položka „Tester" za 1 €.
  if (findCurrency(rawAnswer) === null) return false;
  const parsed = extractInvoiceItems(`za ${rawAnswer}`, undefined, { answerContext: true });
  return parsed.items.some((item) => item.unitPrice !== undefined) || parsed.statedTotal !== undefined || parsed.recognized.length > 0;
}
