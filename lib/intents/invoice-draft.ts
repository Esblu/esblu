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
import { type VatCategoryCode } from "@/lib/invoicing/vat-engine";
import { matchPartnersByName, type PartnerMatchTier } from "@/lib/partner-matching";
import { findNumber, findCurrency, findVatRate } from "@/lib/intents/number-words";
import {
  extractInvoiceItems,
  MAX_VOICE_ITEMS,
  MAX_VOICE_UNIT_PRICE,
  MAX_DESCRIPTION_LENGTH,
} from "@/lib/intents/invoice-items";
// Čisté funkcie nad slotmi žijú vedľa, aby sa dali odskúšať bez databázy.
// Re-export nižšie drží doterajšie importy volajúcich nezmenené; sem sa
// dovážajú iba tie, ktoré tento súbor naozaj volá.
import {
  firstItemWithoutPrice,
  type InvoiceDraftSlots,
  type InvoiceDraftField,
  type PartnerCandidate,
} from "@/lib/intents/invoice-slots";

export {
  applyAnswer,
  type PartnerCandidate,
  appendItemFromAnswer,
  looksLikeItemAppend,
  missingInvoiceFields,
  readSlots,
  serializeSlots,
  firstItemWithoutPrice,
  type InvoiceDraftSlots,
  type InvoiceDraftField,
} from "@/lib/intents/invoice-slots";

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
export function extractInvoiceSlotsFromText(
  rawText: string,
  /** Meno partnera z vety — aby sa úsek s ním nestal položkou. */
  partnerHint?: string
): InvoiceDraftSlots {
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

  // Položky. Rozdelenie vety rieši lib/intents/invoice-items.ts a keď si
  // nie je isté, vráti prázdno s dôvodom — vtedy sa tu nič nedosadí a
  // asistent sa spýta. Viac položiek, z ktorých jednej chýba cena, sa
  // ZÁMERNE neuloží ani čiastočne: bol by to signál, že rozdelenie
  // prebehlo zle, a čiastočný doklad je horší než otázka.
  const parsed = extractInvoiceItems(rawText, partnerHint);
  if (parsed.items.length > 0 && parsed.problem !== "ambiguous") {
    slots.items = parsed.items;
  }

  // Keď parser rozdelenie ODMIETOL, náhradná jednopoložková cesta nižšie sa
  // NESMIE spustiť. Inak by z vety s dvoma riadkami vznikol doklad s jedným
  // — presne to sa stalo pri „kopanie 300 euro, dovoz 50 euro": druhý
  // riadok zmizol a používateľ sa to dozvedel až z hotového konceptu.
  if (parsed.problem === "ambiguous" || parsed.problem === "too_many_items") {
    return slots;
  }

  // Jediná položka bez ceny sa smie prevziať — je to bežný prípad („za
  // kopanie") a chýbajúca cena je ďalšia otázka, nie chyba rozdelenia.
  if (!slots.items) {
    const description = extractAfterPhrase(rawText, DESCRIPTION_PHRASES);
    if (description) {
      const cleaned = stripTrailingAmount(description);
      if (cleaned) {
        const amount = findAmountExcludingVat(rawText);
        slots.items = [
          {
            description: cleaned.slice(0, MAX_DESCRIPTION_LENGTH),
            ...(amount !== null && amount >= 0 && amount <= MAX_VOICE_UNIT_PRICE
              ? { unitPrice: amount }
              : {}),
          },
        ];
      }
    }
  }

  return slots;
}

/**
 * Dôvod, prečo sa veta nedala rozdeliť na položky — na formulovanie
 * otázky. `null`, keď problém nie je.
 */
export function itemParseProblem(
  rawText: string,
  partnerHint?: string
): "ambiguous" | "too_many_items" | null {
  const parsed = extractInvoiceItems(rawText, partnerHint);
  return parsed.problem === "ambiguous" || parsed.problem === "too_many_items"
    ? parsed.problem
    : null;
}

/**
 * Rozpoznané a nerozpoznané úseky pre znenie otázky.
 *
 * Existuje preto, že „nerozumel som" je pri dvoch položkách zbytočne
 * bezmocná odpoveď. Používateľ vie doplniť presne to, čo appka pomenuje.
 */
export function describeItemParse(
  rawText: string,
  partnerHint?: string
): {
  problem: "ambiguous" | "too_many_items" | null;
  recognized: { description: string; unitPrice?: number }[];
  unresolved: string[];
} {
  const parsed = extractInvoiceItems(rawText, partnerHint);
  const problem =
    parsed.problem === "ambiguous" || parsed.problem === "too_many_items"
      ? parsed.problem
      : null;
  return {
    problem,
    recognized: parsed.recognized.map((item) => ({
      description: item.description,
      ...(item.unitPrice === undefined ? {} : { unitPrice: item.unitPrice }),
    })),
    unresolved: parsed.unresolved,
  };
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

// -----------------------------------------------------------------------------
// Odpovede na otázky
// -----------------------------------------------------------------------------

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
    case "items":
      return { question: translate(locale, "search.voice.invoice.askDescription") };
    case "itemPrice":
      return { question: translate(locale, "search.voice.invoice.askAmount") };
    case "vat":
      return { question: translate(locale, "search.voice.invoice.askVat") };
  }
}

/**
 * Otázka na položku, ktorej chýba cena, s pomenovaním TEJ položky.
 *
 * Pri jednej položke by stačilo „Aká je suma?". Pri viacerých je to
 * nejednoznačné — používateľ musí vedieť, o ktorý riadok ide, inak cenu
 * priradí k nesprávnemu.
 */
export function buildItemPriceQuestion(
  locale: Locale,
  slots: InvoiceDraftSlots
): string {
  const index = firstItemWithoutPrice(slots.items);
  const items = slots.items ?? [];

  if (index === null) return translate(locale, "search.voice.invoice.askAmount");
  if (items.length <= 1) return translate(locale, "search.voice.invoice.askAmount");

  return translate(locale, "search.voice.invoice.askAmountForItem", {
    item: items[index].description,
  });
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
  if (!slots.partnerId || !slots.items || slots.items.length === 0) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }
  if (!slots.vatCategoryCode || slots.vatRate === undefined) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }
  if (slots.items.length > MAX_VOICE_ITEMS) {
    return { kind: "error", text: translate(locale, "search.voice.invoice.tooManyItems") };
  }

  // Posledná kontrola pred zápisom: každá položka musí mať cenu v rozsahu.
  // `missingInvoiceFields` to už overil, ale sloty prišli z databázy a
  // medzi overením a zápisom je vždy nejaká vzdialenosť. Cena sa tu nikdy
  // nedosadzuje — chýbajúca znamená odmietnutie, nie nulu.
  const invalidItem = slots.items.find(
    (item) =>
      item.unitPrice === undefined ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice < 0 ||
      item.unitPrice > MAX_VOICE_UNIT_PRICE ||
      !item.description.trim()
  );
  if (invalidItem) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const currency =
    slots.currency ?? (await readPartnerCurrency(supabase, slots.partnerId)) ?? FALLBACK_CURRENCY;

  // Sadzba a kategória DPH platia pre celý doklad — presne tak, ako ich
  // používateľ vyslovil. Per-riadková daň by znamenala, že o niektorom
  // riadku rozhodla appka.
  const vatRate = slots.vatCategoryCode === "S" ? slots.vatRate : 0;

  const items: DraftInvoiceItemInput[] = slots.items.map((item) => ({
    description: item.description,
    quantity: item.quantity ?? DEFAULT_QUANTITY,
    unit: item.unit ?? DEFAULT_UNIT,
    unit_price: item.unitPrice as number,
    vat_category_code: slots.vatCategoryCode as VatCategoryCode,
    vat_rate: vatRate,
  }));

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

    await replaceDraftInvoiceItems(invoice.id, items, supabase);

    const totals = previewDraftTotals(items);
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
        // Každý riadok samostatne. Súhrn, ktorý by položky zlúčil do jednej
        // sumy, by zakryl práve to, čo má používateľ skontrolovať.
        ...items.map((row, index) => ({
          label:
            items.length > 1
              ? `${index + 1}. ${translate(locale, "invoices.newInvoice.itemDescriptionLabel")}`
              : translate(locale, "invoices.newInvoice.itemDescriptionLabel"),
          value: `${row.description} — ${formatAmount(row.unit_price)} ${currency}`,
        })),
        {
          label: translate(locale, "invoices.newInvoice.itemVatCategoryLabel"),
          value: `${items[0].vat_category_code} · ${formatAmount(items[0].vat_rate)} %`,
        },
        // Základ a daň, nie iba celková suma. Pri jednej položke sa dali
        // dopočítať z hlavy; pri dvoch už nie, a práve vtedy má kontrola
        // zmysel — chýbajúci riadok je vidieť na základe dane skôr než
        // kdekoľvek inde. Všetky tri čísla počíta ten istý VAT engine z
        // tých istých položiek, ktoré sa práve uložili.
        {
          label: translate(locale, "invoices.newInvoice.subtotalLabel"),
          value: `${totals.subtotalAmount} ${currency}`,
        },
        {
          label: translate(locale, "invoices.newInvoice.vatTotalLabel"),
          value: `${totals.vatTotalAmount} ${currency}`,
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
