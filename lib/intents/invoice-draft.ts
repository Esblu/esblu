import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { IntentResult } from "@/lib/intents/types";
import type { ReadContext } from "@/lib/intents/handlers-navigation-finance";
import {
  createDraftInvoice,
  replaceDraftInvoiceItems,
  previewDraftTotals,
  type DraftInvoiceItemInput,
} from "@/lib/invoices";
import { isVatCategoryCode, type VatCategoryCode } from "@/lib/invoicing/vat-engine";
import { matchPartnersByName, type PartnerMatchTier } from "@/lib/partner-matching";
import { findNumber, findCurrency, findVatRate, mentionsVat } from "@/lib/intents/number-words";

// =============================================================================
// Voice Phase 2 — vytvorenie DRAFTU vydanej faktúry rečou.
//
// ČO TÁTO VRSTVA JE A ČO NIE JE
// -----------------------------
// Je to vypĺňanie formulára diktovaním. Nie je to fakturačná logika:
// číslo dokladu, súčty, daňový rozpis ani finalizácia sem nepatria a
// nepatria ani do dosahu hlasu — tie vznikajú výhradne v
// esblu_finalize_invoice(). Výsledkom je vždy DRAFT, ktorý používateľ
// otvorí a skontroluje. Nikdy hotový doklad.
//
// PREČO SA NEPOUŽÍVA NOVÁ CESTA ZÁPISU
// ------------------------------------
// Draft sa zakladá tými istými funkciami, ktoré používa formulár v UI
// (createDraftInvoice + replaceDraftInvoiceItems), len s klientom
// obliekaným tokenom volajúceho. Prechádza teda tou istou RLS politikou
// `invoices_insert_finance_draft` (finance manage + document_status='draft'
// + invoice_number is null) a tými istými CHECK constraintmi. Keby hlas
// dostal vlastnú cestu zápisu, mala by vlastné chyby — a tie by sa
// objavili až vtedy, keď by na nich niekomu záležalo.
//
// O ČOM ASISTENT NEROZHODUJE
// --------------------------
// O dani. Sadzba ani kategória DPH sa nikdy neodvodzuje z krajiny, typu
// služby ani z toho, čo mal partner minule. Buď ju používateľ vysloví,
// alebo sa naňu asistent spýta. Je to právne rozhodnutie a to nie je vec,
// ktorú by mal robiť rozpoznávač reči.
//
// Rovnako sa nikdy nezaloží nový partner. Keď sa vyslovené meno nenájde,
// asistent to povie — nedomyslí si, že "Tester1" má byť nová firma.
// =============================================================================

// -----------------------------------------------------------------------------
// Stav dialógu
// -----------------------------------------------------------------------------

/**
 * Sloty držané medzi krokmi.
 *
 * ZÁMERNE tu NIE JE názov partnera, len jeho id — meno sa zakaždým dočíta
 * cez RLS. Uložený kontext tak sám osebe nie je zdrojom osobných údajov a
 * keď používateľ o prístup k partnerovi medzitým príde, otázka sa nepoloží
 * nad menom, ktoré už vidieť nemá.
 */
export type InvoiceDraftSlots = {
  partnerId?: string;
  /** Kandidáti pri nejednoznačnom mene — iba identifikátory, max 5. */
  partnerCandidateIds?: string[];
  description?: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  currency?: string;
  vatCategoryCode?: VatCategoryCode;
  vatRate?: number;
};

/** Poradie, v akom sa asistent pýta. Zhora nadol, vždy jedna otázka. */
export type InvoiceDraftField =
  | "partner"
  | "partnerChoice"
  | "description"
  | "unitPrice"
  | "vat";

const SLOT_KEYS: (keyof InvoiceDraftSlots)[] = [
  "partnerId",
  "partnerCandidateIds",
  "description",
  "quantity",
  "unit",
  "unitPrice",
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
  if (typeof source.description === "string" && source.description.trim()) {
    slots.description = source.description.trim().slice(0, 200);
  }
  if (typeof source.quantity === "number" && Number.isFinite(source.quantity) && source.quantity > 0) {
    slots.quantity = source.quantity;
  }
  if (typeof source.unit === "string" && source.unit.trim()) {
    slots.unit = source.unit.trim().slice(0, 20);
  }
  if (typeof source.unitPrice === "number" && Number.isFinite(source.unitPrice) && source.unitPrice >= 0) {
    slots.unitPrice = source.unitPrice;
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

// -----------------------------------------------------------------------------
// Predvolené hodnoty, ktoré NIE SÚ odhad
// -----------------------------------------------------------------------------
//
// Doplniť sa smie iba to, čo appka doplní aj vo formulári — inak by hlas
// vytváral doklady s inými východiskami než klikanie, čo je horšie než
// keby sa spýtal. Množstvo 1 a jednotka "ks" pochádzajú z emptyItem()
// v app/faktury/InvoiceDetailView.tsx; mena z default_currency partnera,
// a až keď ju partner nemá, z rovnakého "EUR", aké predvyplní formulár
// novej faktúry.
//
// Sadzba DPH tu ZÁMERNE nie je. Formulár ju síce predvyplní z
// company_billing_profile.default_vat_rate, ale predvyplnené pole vidí
// používateľ pred očami a môže ho prepísať — pri diktovaní by tichý
// default znamenal odoslanú hodnotu, ktorú nikto nevidel.

const DEFAULT_QUANTITY = 1;
const DEFAULT_UNIT = "ks";
const FALLBACK_CURRENCY = "EUR";

// -----------------------------------------------------------------------------
// Extrakcia z vety
// -----------------------------------------------------------------------------

/**
 * Frázy, za ktorými nasleduje predmet fakturácie ("za kopanie", "für
 * Erdarbeiten", "for excavation"). Popis je jediná hodnota, ktorú appka
 * berie ako voľný text — nemá overiteľný tvar, iba dĺžku.
 */
const DESCRIPTION_PHRASES = [
  "za ",
  "fuer ",
  "für ",
  "for ",
  "ueber ",
  "über ",
];

// Meno odberateľa sa z vety ZÁMERNE nevyberá deterministicky. "pre" a
// "für" uvádzajú v týchto vetách aj predmet fakturácie ("faktúru pre
// Tester1 za kopanie" vs. "Rechnung für Erdarbeiten") a rozlíšiť ich bez
// znalosti jazyka a kontextu sa nedá spoľahlivo. Meno preto rozpoznáva
// klasifikátor (`partnerQuery`) a server ho VŽDY overí proti reálnym
// partnerom firmy — chybný odhad tak skončí otázkou, nie zlým dokladom.

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Text medzi frázou a ďalším predelom vety. */
function extractAfterPhrase(rawText: string, phrases: string[]): string | undefined {
  const folded = fold(rawText);

  let bestIndex = -1;
  let bestLength = 0;

  for (const phrase of phrases) {
    const foldedPhrase = fold(phrase);
    const index = folded.indexOf(foldedPhrase);
    if (index === -1) continue;
    // Najskorší výskyt vyhráva; pri zhode dlhšia fráza.
    if (bestIndex === -1 || index < bestIndex || (index === bestIndex && foldedPhrase.length > bestLength)) {
      bestIndex = index;
      bestLength = foldedPhrase.length;
    }
  }

  if (bestIndex === -1) return undefined;

  const tail = rawText.slice(bestIndex + bestLength);
  // Popis/meno končí tam, kde začína ďalšia časť príkazu.
  const cut = tail.split(/\s+(?:za|für|fuer|for|s\s|so\s|mit|with|plus|über|ueber|a\s|und\s|and\s)\s*/i)[0];
  const cleaned = cut.replace(/[.,;:!?]+\s*$/, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : undefined;
}

/**
 * Vytiahne z jednej vety všetko, čo sa z nej dá bezpečne vyčítať.
 *
 * Nič, čo tu nevyjde, sa nedopĺňa — chýbajúce hodnoty sa stanú otázkou.
 */
export function extractInvoiceSlotsFromText(rawText: string): InvoiceDraftSlots {
  const slots: InvoiceDraftSlots = {};

  const currency = findCurrency(rawText);
  if (currency) slots.currency = currency;

  // Sadzba DPH iba keď je naozaj vyslovená ako percento.
  const vatRate = findVatRate(rawText);
  if (vatRate !== null) {
    slots.vatRate = vatRate;
    // Nenulová vyslovená sadzba znamená bežnú daň — kategória "S" je tu
    // dôsledok toho, čo používateľ povedal, nie rozhodnutie appky. Nulová
    // sadzba sa takto uzavrieť nedá (oslobodenie, prenesenie povinnosti a
    // nulová sadzba sú tri rôzne veci), preto sa pri nej kategória nechá
    // chýbať a asistent sa spýta.
    if (vatRate > 0) slots.vatCategoryCode = "S";
  }

  // Suma. Hľadá sa až ZA sadzbou DPH, ak nejaká bola — inak by "23 percent"
  // mohlo skončiť ako cena.
  const amount = findAmountExcludingVat(rawText);
  if (amount !== null) slots.unitPrice = amount;

  const description = extractAfterPhrase(rawText, DESCRIPTION_PHRASES);
  if (description) slots.description = stripTrailingAmount(description);

  return slots;
}

/**
 * Suma z vety, s vylúčením čísla, ktoré patrí k percentu DPH.
 */
function findAmountExcludingVat(rawText: string): number | null {
  const vatRate = findVatRate(rawText);

  let searchFrom = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = findNumber(rawText, searchFrom);
    if (!found) return null;
    if (vatRate !== null && found.value === vatRate && isPercentContext(rawText, found.endToken)) {
      searchFrom = found.endToken + 1;
      continue;
    }
    return found.value;
  }
  return null;
}

/** Stojí hneď za týmto tokenom slovo "percent"/"%"? */
function isPercentContext(rawText: string, endToken: number): boolean {
  const tokens = fold(rawText).split(/\s+/).filter(Boolean);
  const next = tokens[endToken + 1] ?? "";
  return /percent|prozent|%/.test(next) || /%/.test(tokens[endToken] ?? "");
}

/** "kopanie 300" → "kopanie" (suma sa už uložila do ceny). */
function stripTrailingAmount(description: string): string {
  return description.replace(/[\s,]*\d[\d.,\s]*$/, "").trim() || description;
}

// -----------------------------------------------------------------------------
// Resolvovanie partnera
// -----------------------------------------------------------------------------

export type PartnerCandidate = { id: string; label: string };

export type PartnerResolution = {
  tier: PartnerMatchTier;
  /** Smie sa použiť bez pýtania? Nikdy pri `suggestion`. */
  autoResolvable: boolean;
  candidates: PartnerCandidate[];
};

type PartnerRow = { id: string; legal_name: string | null; ico: string | null };

/**
 * Nájde odberateľa podľa vysloveného mena alebo IČO.
 *
 * Filtruje sa v JS nad RLS-obmedzenou množinou, nikdy cez PostgREST
 * `.or()` — voľný text z prepisu reči sa do dopytového výrazu nedostane.
 *
 * Samotné porovnávanie názvov robí zdieľaný lib/partner-matching.ts, ten
 * istý kanonický kľúč, akým appka páruje dodávateľov na prijatých
 * faktúrach. Bola to pôvodne nezávislá vetva s `includes()` a práve na nej
 * vznikla chyba z reálneho testu: partner „Tester1" a prepis „Tester 1"
 * boli pre ňu dva rôzne reťazce.
 */
export async function resolvePartnerCandidates(
  supabase: SupabaseClient,
  query: string
): Promise<PartnerResolution> {
  const empty: PartnerResolution = { tier: "none", autoResolvable: false, candidates: [] };

  const trimmed = query.trim();
  if (!trimmed) return empty;

  const { data, error } = await supabase
    .from("business_partners")
    .select("id, legal_name, ico")
    .order("legal_name", { ascending: true })
    .limit(300);

  if (error) return empty;

  const rows = (data as PartnerRow[]) ?? [];

  // IČO je identifikátor, nie názov — presná zhoda je deterministická a
  // rozhoduje pred akýmkoľvek porovnávaním mien. Rovnaká priorita ako pri
  // párovaní dodávateľov v lib/invoicing/supplier-matching.ts.
  const identifier = trimmed.replace(/[\s.\-/]/g, "");
  if (/^\d{6,}$/.test(identifier)) {
    const icoHits = rows.filter((row) => (row.ico ?? "").replace(/[\s.\-/]/g, "") === identifier);
    if (icoHits.length > 0) {
      return {
        tier: "exact",
        autoResolvable: icoHits.length === 1,
        candidates: icoHits.slice(0, 5).map(toCandidate),
      };
    }
  }

  const match = matchPartnersByName(trimmed, rows, (row) => row.legal_name);

  return {
    tier: match.tier,
    autoResolvable: match.autoResolvable,
    candidates: match.matches.slice(0, 5).map(toCandidate),
  };
}

function toCandidate(row: PartnerRow): PartnerCandidate {
  return {
    id: row.id,
    label: row.ico ? `${row.legal_name ?? ""} · ${row.ico}` : row.legal_name ?? "",
  };
}

/** Označenia pre už vyriešené id — meno sa nikdy neukladá, vždy sa číta. */
export async function readPartnerLabels(
  supabase: SupabaseClient,
  ids: string[]
): Promise<PartnerCandidate[]> {
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from("business_partners")
    .select("id, legal_name, ico")
    .in("id", ids);

  if (error) return [];

  const rows = (data as { id: string; legal_name: string | null; ico: string | null }[]) ?? [];
  // Poradie podľa vstupu, aby odpoveď "ten prvý" znamenala to, čo sa pýtalo.
  return ids
    .map((id) => rows.find((row) => row.id === id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({
      id: row.id,
      label: row.ico ? `${row.legal_name ?? ""} · ${row.ico}` : row.legal_name ?? "",
    }));
}

/** Predvolená mena partnera — skutočné nastavenie, nie odhad. */
async function readPartnerCurrency(
  supabase: SupabaseClient,
  partnerId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("business_partners")
    .select("default_currency")
    .eq("id", partnerId)
    .maybeSingle();

  const currency = (data as { default_currency: string | null } | null)?.default_currency;
  return typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)
    ? currency.toUpperCase()
    : null;
}

// -----------------------------------------------------------------------------
// Čo ešte chýba
// -----------------------------------------------------------------------------

export function missingInvoiceFields(slots: InvoiceDraftSlots): InvoiceDraftField[] {
  const missing: InvoiceDraftField[] = [];

  if (!slots.partnerId) {
    missing.push(slots.partnerCandidateIds?.length ? "partnerChoice" : "partner");
  }
  if (!slots.description) missing.push("description");
  if (slots.unitPrice === undefined) missing.push("unitPrice");
  // Kategória AJ sadzba musia byť obe známe. Kategória bez sadzby je pri
  // "S" neúplná; sadzba bez kategórie je pri nule nejednoznačná.
  if (!slots.vatCategoryCode || slots.vatRate === undefined) missing.push("vat");

  return missing;
}

// -----------------------------------------------------------------------------
// Odpovede na otázky
// -----------------------------------------------------------------------------

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
      // Odpoveď na "pre koho" je meno — resolvovanie robí volajúci, tu sa
      // iba zapamätá, čo sa má hľadať.
      next.description = next.description;
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

    case "description": {
      next.description = answer.replace(/[.,;:!?]+\s*$/, "").slice(0, 200);
      return next;
    }

    case "unitPrice": {
      const amount = findNumber(answer);
      if (amount) next.unitPrice = amount.value;
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

function readOrdinal(folded: string): number | null {
  if (/\bprv|\berst|\bfirst|\b1\b/.test(folded)) return 0;
  if (/\bdruh|\bzweit|\bsecond|\b2\b/.test(folded)) return 1;
  if (/\btret|\bdritt|\bthird|\b3\b/.test(folded)) return 2;
  return null;
}

// -----------------------------------------------------------------------------
// Otázky
// -----------------------------------------------------------------------------

export function buildQuestion(
  locale: Locale,
  field: InvoiceDraftField,
  candidates: PartnerCandidate[]
): { question: string; choices?: { value: string; label: string }[] } {
  switch (field) {
    case "partner":
      return { question: translate(locale, "search.voice.invoice.askPartner") };
    case "partnerChoice":
      return {
        question: translate(locale, "search.voice.invoice.askPartnerChoice", {
          names: candidates.map((candidate) => candidate.label).join(", "),
        }),
        choices: candidates.map((candidate) => ({
          value: candidate.id,
          label: candidate.label,
        })),
      };
    case "description":
      return { question: translate(locale, "search.voice.invoice.askDescription") };
    case "unitPrice":
      return { question: translate(locale, "search.voice.invoice.askAmount") };
    case "vat":
      return { question: translate(locale, "search.voice.invoice.askVat") };
  }
}

// -----------------------------------------------------------------------------
// Vytvorenie draftu
// -----------------------------------------------------------------------------

/**
 * Založí draft vydanej faktúry z kompletných slotov.
 *
 * Volá sa AŽ keď `missingInvoiceFields()` vráti prázdno. Permission sa
 * kontroluje o vrstvu vyššie (route) a napokon ju vynucuje RLS — tu sa
 * zámerne nič neduplikuje, aby nevznikla druhá, odlišná definícia toho,
 * kto smie fakturovať.
 */
export async function createInvoiceDraftFromSlots(
  supabase: SupabaseClient,
  locale: Locale,
  companyId: string,
  userId: string,
  slots: InvoiceDraftSlots,
  /**
   * Kalendárny deň používateľa, už overený a ohraničený na serveri
   * (`resolveClientCalendarDate`). Server beží v UTC, takže bez tejto hodnoty
   * by o polnoci stredoeurópskeho času vznikol doklad s včerajším dátumom —
   * presne chyba, ktorá sa prejavila v reálnom teste.
   */
  issueDate: string
): Promise<IntentResult> {
  if (!slots.partnerId || !slots.description || slots.unitPrice === undefined) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }
  if (!slots.vatCategoryCode || slots.vatRate === undefined) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const currency =
    slots.currency ?? (await readPartnerCurrency(supabase, slots.partnerId)) ?? FALLBACK_CURRENCY;

  const item: DraftInvoiceItemInput = {
    description: slots.description,
    quantity: slots.quantity ?? DEFAULT_QUANTITY,
    unit: slots.unit ?? DEFAULT_UNIT,
    unit_price: slots.unitPrice,
    vat_category_code: slots.vatCategoryCode,
    // Kategórie mimo "S" nesú daň 0 — vynútené aj VAT enginom.
    vat_rate: slots.vatCategoryCode === "S" ? slots.vatRate : 0,
  };

  try {
    const invoice = await createDraftInvoice(
      companyId,
      userId,
      {
        direction: "issued",
        kind: "regular_invoice",
        currency,
        issue_date: issueDate,
        due_date: null,
        customer_business_partner_id: slots.partnerId,
        variable_symbol: null,
        payment_terms_days: null,
        corrects_invoice_id: null,
      },
      supabase
    );

    await replaceDraftInvoiceItems(invoice.id, [item], supabase);

    const totals = previewDraftTotals([item]);
    const partner = (await readPartnerLabels(supabase, [slots.partnerId]))[0];

    return {
      kind: "draft_created",
      title: translate(locale, "search.voice.invoice.draftCreatedTitle"),
      note: translate(locale, "search.voice.invoice.draftReviewNote"),
      summary: [
        {
          label: translate(locale, "invoices.newInvoice.businessPartnerLabel"),
          value: partner?.label ?? "—",
        },
        {
          label: translate(locale, "invoices.newInvoice.itemDescriptionLabel"),
          value: item.description,
        },
        {
          label: translate(locale, "invoices.newInvoice.itemUnitPriceLabel"),
          value: `${formatAmount(item.unit_price)} ${currency}`,
        },
        {
          label: translate(locale, "invoices.newInvoice.itemVatCategoryLabel"),
          value: `${item.vat_category_code} · ${formatAmount(item.vat_rate)} %`,
        },
        {
          label: translate(locale, "invoices.newInvoice.totalLabel"),
          value: `${totals.totalAmount} ${currency}`,
        },
      ],
      entity: {
        type: "document",
        id: invoice.id,
        label: translate(locale, "search.voice.invoice.openDraft"),
        href: `/faktury/${invoice.id}`,
      },
    };
  } catch (error) {
    // RLS/CHECK odmietnutie sa používateľovi nikdy nezobrazuje v pôvodnom
    // znení — bola by to mapa databázy.
    console.error(
      "createInvoiceDraftFromSlots: draft sa nepodarilo vytvoriť:",
      error instanceof Error ? error.message : error
    );
    return { kind: "error", text: translate(locale, "search.voice.invoice.createFailed") };
  }
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// -----------------------------------------------------------------------------
// Vstupná podmienka
// -----------------------------------------------------------------------------

/**
 * Fakturovať smie iba ten, kto má finančnú správu. Kontroluje sa PRED
 * akýmkoľvek dotazom — zamestnanec nemá dostať otázku "pre koho?" na
 * príkaz, ktorý by aj tak nesmel dokončiť.
 */
export function canCreateInvoiceDraft(ctx: ReadContext & { financeManage: boolean }): boolean {
  return ctx.financeManage === true;
}
