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
import { checkVoiceInvoiceDraft } from "@/lib/invoicing/voice-financial-validator";
import { findCurrency, findVatRate } from "@/lib/intents/number-words";
import { extractInvoiceItems } from "@/lib/intents/invoice-items";
// Čisté funkcie nad slotmi žijú vedľa, aby sa dali odskúšať bez databázy.
// Re-export nižšie drží doterajšie importy volajúcich nezmenené; sem sa
// dovážajú iba tie, ktoré tento súbor naozaj volá.
import {
  effectivePriceMode,
  firstItemWithoutPrice,
  missingInvoiceFields,
  type InvoiceDraftSlots,
  type InvoiceDraftField,
  type PartnerCandidate,
} from "@/lib/intents/invoice-slots";

export {
  applyAnswer,
  effectivePriceMode,
  type PriceMode,
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

// Meno odberateľa sa z vety ZÁMERNE nevyberá deterministicky. "pre" a
// "für" uvádzajú v týchto vetách aj predmet fakturácie ("faktúru pre
// Tester1 za kopanie" vs. "Rechnung für Erdarbeiten") a rozlíšiť ich bez
// znalosti jazyka a kontextu sa nedá spoľahlivo. Meno preto rozpoznáva
// klasifikátor (`partnerQuery`) a server ho VŽDY overí proti reálnym
// partnerom firmy — chybný odhad tak skončí otázkou, nie zlým dokladom.

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
  // Vyslovená celková suma sa NErozpočítava — iba sa zapamätá na kontrolu.
  if (parsed.statedTotal !== undefined) slots.statedTotal = parsed.statedTotal;
  if (parsed.items.length > 0 && parsed.problem !== "ambiguous") {
    slots.items = parsed.items;
    // Sumy z vety sa nesú ďalej, aby sa dali tesne pred zápisom porovnať
    // s cenami na doklade. Pozri lib/invoicing/voice-financial-validator.ts.
    slots.spokenAmounts = parsed.items
      .map((item) => item.unitPrice)
      .filter((price): price is number => typeof price === "number");
  }

  // Keď parser rozdelenie ODMIETOL, náhradná jednopoložková cesta nižšie sa
  // NESMIE spustiť. Inak by z vety s dvoma riadkami vznikol doklad s jedným
  // — presne to sa stalo pri „kopanie 300 euro, dovoz 50 euro": druhý
  // riadok zmizol a používateľ sa to dozvedel až z hotového konceptu.
  if (parsed.problem === "ambiguous" || parsed.problem === "too_many_items") {
    return slots;
  }

  // NÁHRADNÁ JEDNOPOLOŽKOVÁ CESTA JE ZRUŠENÁ.
  //
  // Brala popis z jedného miesta vety a cenu z iného, pričom tie dve
  // miesta nič nespájalo. Vo vete „Vytvor faktúru Tester 1, kopanie za 300
  // eur, dovoz za 45 eur" tak vznikol riadok „300 eur, dovoz" za 1 € —
  // jednotka pochádzala z mena partnera, lebo to bolo prvé číslo v texte.
  //
  // Keď z vety nevyjde ani jedna položka, je to otázka („Za čo má byť
  // faktúra?"), nie príležitosť poskladať doklad z úlomkov.

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
      // Jediný kandidát z vysloveného mena („Tester jeden" → „Tester1"):
      // potvrdenie „Myslíte …?", nie výber zo zoznamu.
      if (candidates.length === 1) {
        return {
          question: translate(locale, "search.voice.invoice.confirmPartnerCandidate", { name: candidates[0].label }),
          choices: [{ value: candidates[0].id, label: candidates[0].label }],
        };
      }
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
    case "total":
      return { question: translate(locale, "search.voice.invoice.askAmount") };
    case "vat":
      // Znenie dopĺňa `buildVatQuestion` — potrebuje sloty, ktoré sem
      // nechodia. Toto je východisko pre prípad bez kontextu.
      return { question: translate(locale, "search.voice.invoice.askVat") };
  }
}

/**
 * Otázka na DPH, ktorá nezahodí, čo už používateľ povedal.
 *
 * Keď oznámil, že ceny sú s daňou, otázka to zopakuje — inak to vyzerá,
 * akoby ho appka nepočula. Presne to sa v reálnom teste stalo: človek
 * odpovedal „uvedené ceny sú už s DPH" a dostal späť tú istú otázku, slovo
 * za slovom.
 *
 * Sadzba sa z režimu NEODVODZUJE. „S DPH" nehovorí, akou sadzbou, a Esblu
 * si ju nedomýšľa ani z krajiny, ani z partnera, ani zo sumy.
 */
export function buildVatQuestion(locale: Locale, slots: InvoiceDraftSlots): string {
  const mode = effectivePriceMode(slots);

  if (slots.priceMode === undefined) {
    return translate(locale, "search.voice.invoice.askVat");
  }

  return translate(
    locale,
    mode === "gross"
      ? "search.voice.invoice.askVatAfterGross"
      : "search.voice.invoice.askVatAfterNet"
  );
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

  // Viac riadkov bez ceny: jedna otázka na všetky, s ich menami — a keď
  // zaznela celková suma, zopakuje sa aj tá (nerozpočítava sa).
  const missing = items.filter((item) => item.unitPrice === undefined);
  if (missing.length > 1) {
    const names = joinNames(locale, missing.map((item) => item.description));
    return slots.statedTotal !== undefined
      ? translate(locale, "search.voice.invoice.askItemPricesWithTotal", {
          count: missing.length,
          items: names,
          total: formatMoneyForSpeech(locale, slots.statedTotal),
        })
      : translate(locale, "search.voice.invoice.askItemPrices", { items: names });
  }

  return translate(locale, "search.voice.invoice.askAmountForItem", {
    item: items[index].description,
  });
}

/** „kopanie, odvoz materiálu a pracovníci". */
function joinNames(locale: Locale, names: string[]): string {
  if (names.length <= 1) return names.join("");
  const and = translate(locale, "search.voice.invoice.and");
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

/** „1 832 €" — rovnaký tvar ako v súhrne, bez zaokrúhľovania. */
function formatMoneyForSpeech(locale: Locale, value: number): string {
  const tag = locale === "de" ? "de-DE" : locale === "en" ? "en-GB" : "sk-SK";
  return `${new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(value)} €`;
}

/**
 * Súčet riadkov nesedí s vyslovenou celkovou sumou — otázka, nikdy tichá
 * úprava. Nič sa nerozpočítava ani nezaokrúhľuje.
 */
export function buildTotalMismatchQuestion(locale: Locale, slots: InvoiceDraftSlots, sumCents: number): string {
  return translate(locale, "search.voice.invoice.totalMismatch", {
    sum: formatMoneyForSpeech(locale, sumCents / 100),
    total: formatMoneyForSpeech(locale, slots.statedTotal ?? 0),
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
  const currency =
    slots.currency ?? (await readPartnerCurrency(supabase, slots.partnerId ?? "")) ?? FALLBACK_CURRENCY;

  // ------------------------------------------------------------------
  // FINANČNÁ BRÁNA.
  //
  // Jediné miesto v hlasovej ceste, kde vzniká doklad, a preto jediné
  // miesto, kde sa rozhoduje, či smie vzniknúť. Kontroluje DETERMINISTICKÝ
  // validátor — nie model a nie parser. Tí dvaja rozumejú vete; o tom, či
  // sa z porozumenia smie stať účtovný doklad, rozhoduje toto.
  //
  // Kontroluje sa tu znova aj to, čo už overil `missingInvoiceFields`:
  // sloty prišli z databázy a medzi overením a zápisom je vždy nejaká
  // vzdialenosť. Nič sa nedopĺňa — chýbajúca hodnota znamená odmietnutie,
  // nikdy nulu ani jednotku.
  // ------------------------------------------------------------------
  const rejection = checkVoiceInvoiceDraft({
    financeManage: true, // route ho overila pred vstupom do dialógu
    partnerId: slots.partnerId,
    items: slots.items ?? [],
    currency,
    vatCategoryCode: slots.vatCategoryCode,
    vatRate: slots.vatRate,
    spokenAmounts: slots.spokenAmounts ?? [],
    parserAmbiguous: false, // ambiguitu zachytáva flow skôr, než sa sem dôjde
    pendingQuestions: missingInvoiceFields(slots).length,
    priceModeMixed: false, // zmiešané režimy zachytáva flow skôr, než sa sem dôjde
    localDate: issueDate,
    idempotencyClaimed: true, // claim prebehol v continueFlow
  });

  if (rejection) {
    console.error("createInvoiceDraftFromSlots: finančná brána odmietla doklad:", rejection);
    return {
      kind: "error",
      text: translate(
        locale,
        rejection === "too_many_items"
          ? "search.voice.invoice.tooManyItems"
          : "search.voice.invoice.notConfident"
      ),
    };
  }

  // Po bráne sú tieto hodnoty overené. Zúžia sa raz a ďalej sa používajú
  // iba ony — nie `slots`, aby sa nedalo omylom siahnuť na neoverené pole.
  const partnerId = slots.partnerId as string;
  const checkedItems = slots.items ?? [];
  const vatCategoryCode = slots.vatCategoryCode as VatCategoryCode;

  // Sadzba a kategória DPH platia pre celý doklad — presne tak, ako ich
  // používateľ vyslovil. Per-riadková daň by znamenala, že o niektorom
  // riadku rozhodla appka.
  const vatRate = vatCategoryCode === "S" ? (slots.vatRate as number) : 0;

  // REŽIM CENY.
  //
  // Vyslovená suma sa NEPREPOČÍTAVA. Uloží sa presne tak, ako zaznela, a
  // `price_mode` povie, čo znamená — základ dane si z nej dopočíta VAT
  // engine a DB pri finalizácii, obe rovnakým pravidlom.
  //
  // Predtým sa tu cena s daňou delila sadzbou a do `unit_price` išiel
  // výsledok. Vyslovená suma tým prestala v modeli existovať, takže sa
  // nemalo čo skontrolovať — a 750 + 250 + 800 vyšlo v produkcii ako
  // 1800,01. Pozri KANONICKÝ PEŇAŽNÝ MODEL v lib/invoicing/vat-engine.ts.
  const priceMode = effectivePriceMode(slots);

  // MNOŽSTVO A CENA SA MIEŠAŤ NESMÚ.
  //
  // Množstvo má predvolenú hodnotu, cena nikdy — `unit_price` sa berie
  // výhradne z `unitPrice`, ktoré brána overila ako kladné konečné číslo.
  // Keby sa sem dostalo `DEFAULT_QUANTITY`, vznikol by doklad za 1 €.
  const items: DraftInvoiceItemInput[] = checkedItems.map((item) => ({
    description: item.description,
    quantity: item.quantity ?? DEFAULT_QUANTITY,
    unit: item.unit ?? DEFAULT_UNIT,
    unit_price: item.unitPrice as number,
    price_mode: priceMode,
    vat_category_code: vatCategoryCode,
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
        customer_business_partner_id: partnerId,
        variable_symbol: null,
        payment_terms_days: null,
        corrects_invoice_id: null,
      },
      supabase
    );

    await replaceDraftInvoiceItems(invoice.id, items, supabase);

    const totals = previewDraftTotals(items);
    const partner = (await readPartnerLabels(supabase, [partnerId]))[0];

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
        //
        // Pri cenách S DAŇOU sa v riadku ukazuje suma S DAŇOU — teda to,
        // čo človek povedal. Základ, ktorý z nej appka dopočítala, by na
        // kontrolu nesedel: nikto nediktoval 203,25.
        ...items.map((row, index) => ({
          label:
            items.length > 1
              ? `${index + 1}. ${translate(locale, "invoices.newInvoice.itemDescriptionLabel")}`
              : translate(locale, "invoices.newInvoice.itemDescriptionLabel"),
          // Riadková suma z toho istého výpočtu, ktorý sa práve uložil — nie
          // druhé, nezávislé číslo. V režime s daňou je to vyslovená suma,
          // v režime bez dane základ. V oboch prípadoch to, čo človek zadal.
          value: `${row.description} — ${
            priceMode === "gross"
              ? totals.lines[index].lineGrossAmount
              : totals.lines[index].lineNetAmount
          } ${currency}`,
        })),
        {
          label: translate(locale, "invoices.newInvoice.itemVatCategoryLabel"),
          value: `${items[0].vat_category_code} · ${formatAmount(items[0].vat_rate)} %`,
        },
        // Režim ceny patrí do kontroly. Bez neho sa dva rôzne doklady —
        // jeden so sumami s daňou a druhý bez — na prvý pohľad nedajú
        // odlíšiť, hoci sa líšia o celú daň.
        {
          label: translate(locale, "search.voice.invoice.priceModeLabel"),
          value: translate(
            locale,
            priceMode === "gross"
              ? "search.voice.invoice.priceModeGross"
              : "search.voice.invoice.priceModeNet"
          ),
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
