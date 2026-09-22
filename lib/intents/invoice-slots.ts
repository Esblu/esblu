import { findNumber, findCurrency, findVatRate, mentionsVat } from "./number-words.ts";
import {
  extractInvoiceItems,
  extractSingleAppendedItem,
  MAX_VOICE_ITEMS,
  MAX_VOICE_UNIT_PRICE,
  MAX_DESCRIPTION_LENGTH,
  type InvoiceItemCandidate,
} from "./invoice-items.ts";
import { isVatCategoryCode, type VatCategoryCode } from "../invoicing/vat-categories.ts";

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
};

/** Poradie, v akom sa asistent pýta. Zhora nadol, vždy jedna otázka. */
export type InvoiceDraftField =
  | "partner"
  | "partnerChoice"
  | "items"
  | "itemPrice"
  | "vat";


const SLOT_KEYS: (keyof InvoiceDraftSlots)[] = [
  "partnerId",
  "partnerCandidateIds",
  "items",
  "currency",
  "vatCategoryCode",
  "vatRate",
];


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
  const next: InvoiceDraftSlots = { ...slots };
  const answer = rawAnswer.trim();
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
      const parsed = extractInvoiceItems(`za ${answer}`);

      if (parsed.items.length > 0 && parsed.problem !== "ambiguous") {
        next.items = parsed.items.slice(0, MAX_VOICE_ITEMS);
        const currency = findCurrency(answer);
        if (currency) next.currency = currency;
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
      // Cena sa dopĺňa do PRVEJ položky, ktorej chýba — presne tej, na
      // ktorú sa asistent pýtal.
      const target = firstItemWithoutPrice(next.items);
      if (target === null) return next;

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

    case "vat": {
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

  return { ...slots, items: [...existing, item] };
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

