// =============================================================================
// Deterministická finančná brána pred vznikom hlasového konceptu faktúry.
//
// PREČO EXISTUJE
// --------------
// Z produkcie: nadiktované „kopanie za 300 eur, dovoz za 45 eur s 23 %
// DPH" sa uložilo ako JEDEN riadok „300 eur, dovoz" za 1 €. Základ 1 €,
// DPH 0,23 €, spolu 1,23 €. Žiadna z tých hodnôt nebola vo vete.
//
// Jednotka nepochádzala z ceny — pochádzala z mena partnera „Tester 1".
// Popis pochádzal z jednej časti vety, cena z úplne inej a nič tie dve
// časti nespájalo. Každá vrstva urobila „niečo rozumné" a dokopy vznikol
// doklad, ktorý nezodpovedal ničomu, čo človek povedal.
//
// DVE VRSTVY
// ----------
//   A. jazyková — rozumie vete (parser aj model)
//   B. finančná — rozhoduje, či sa z toho smie stať doklad
//
// Táto vrstva je B a je POSLEDNÁ. Model ani parser ju neobchádzajú: keď
// tu čokoľvek nesedí, doklad NEVZNIKNE a asistent sa spýta. Nikdy sa tu
// nič nedopĺňa, nezaokrúhľuje ani „neopravuje" — brána buď pustí, alebo
// nie.
//
// Modul nemá importy, takže tie isté pravidlá bežia na serveri aj v teste.
// =============================================================================

/** Prečo brána doklad nepustila. Kódy sú interné, nie text pre používateľa. */
export type VoiceDraftRejection =
  | "not_authorized"
  | "partner_missing"
  | "no_items"
  | "too_many_items"
  | "description_empty"
  | "quantity_invalid"
  | "unit_price_invalid"
  | "currency_invalid"
  | "vat_missing"
  | "vat_invalid"
  | "money_not_reconciled"
  | "parser_ambiguous"
  | "clarification_pending"
  | "gross_price_ambiguous"
  | "local_date_invalid"
  | "idempotency_not_claimed";

export type VoiceDraftCheckInput = {
  /** Výsledok serverovej kontroly oprávnenia, nie tvrdenie klienta. */
  financeManage: boolean;
  partnerId: string | null | undefined;
  items: {
    description?: string | null;
    quantity?: number | null;
    unitPrice?: number | null;
  }[];
  currency: string | null | undefined;
  vatCategoryCode: string | null | undefined;
  vatRate: number | null | undefined;
  /** Sumy vyslovené v úseku o položkách. */
  spokenAmounts: number[];
  /** Parser priznal, že si rozdelením nie je istý. */
  parserAmbiguous: boolean;
  /** Ešte beží otázka — dialóg nie je dokončený. */
  pendingQuestions: number;
  /** Veta hovorí o cene s DPH, ale sadzba nezaznela. */
  grossPriceAmbiguous: boolean;
  /** Kalendárny deň používateľa, už overený serverom. */
  localDate: string | null | undefined;
  /** Jednorazové uplatnenie dialógu prebehlo. */
  idempotencyClaimed: boolean;
};

export const MAX_VOICE_DRAFT_ITEMS = 10;
export const MAX_VOICE_DRAFT_UNIT_PRICE = 1_000_000;
export const MAX_VOICE_DRAFT_QUANTITY = 100_000;

const VAT_CATEGORIES = ["S", "Z", "E", "AE"];

/**
 * Frázy, ktoré hovoria, že suma UŽ obsahuje daň.
 *
 * „kopanie 300 eur s DPH" a „kopanie 300 eur s 23 % DPH" znamenajú dve
 * rôzne veci a líšia sa o 56 €. Esblu ukladá jednotkovú cenu bez dane,
 * takže prvú vetu by musela prepočítať — a to je rozhodnutie o daňovom
 * základe, nie o jazyku. Preto sa nepočíta, ale pýta.
 *
 * Zámerne sa NEuplatňuje, keď vo vete zaznela sadzba: „s 23 percent DPH"
 * je bežné a jednoznačné vyjadrenie dane navyše.
 */
export function mentionsGrossPrice(rawText: string): boolean {
  const folded = rawText
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  return (
    /(^|\s)(s|so|vratane|vcetne)\s+(dph|dane)(\s|$|[.,])/.test(folded) ||
    /(^|\s)inkl\.?\s*(mwst|ust|steuer)/.test(folded) ||
    /(^|\s)(brutto|bruttopreis)(\s|$|[.,])/.test(folded) ||
    /includ\w*\s+(vat|tax)/.test(folded) ||
    /(^|\s)incl\.?\s*(vat|tax)(\s|$|[.,])/.test(folded)
  );
}

function isCalendarDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return false;
  // Odmietne 2026-02-31: Date.parse by ho posunul na marec.
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prejde doklad tesne pred zápisom. `null` znamená „smie vzniknúť".
 *
 * Poradie kontrol je od najlacnejších a najvšeobecnejších po tie, ktoré
 * potrebujú položky. Na výsledku nezáleží — ktorákoľvek chyba znamená to
 * isté: doklad nevznikne.
 */
export function checkVoiceInvoiceDraft(input: VoiceDraftCheckInput): VoiceDraftRejection | null {
  if (!input.financeManage) return "not_authorized";
  if (!input.partnerId || !UUID.test(input.partnerId)) return "partner_missing";

  if (input.pendingQuestions > 0) return "clarification_pending";
  if (input.parserAmbiguous) return "parser_ambiguous";
  if (input.grossPriceAmbiguous) return "gross_price_ambiguous";

  if (!isCalendarDate(input.localDate)) return "local_date_invalid";
  if (!input.idempotencyClaimed) return "idempotency_not_claimed";

  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
    return "currency_invalid";
  }

  if (typeof input.vatCategoryCode !== "string" || !VAT_CATEGORIES.includes(input.vatCategoryCode)) {
    return "vat_missing";
  }
  if (
    typeof input.vatRate !== "number" ||
    !Number.isFinite(input.vatRate) ||
    input.vatRate < 0 ||
    input.vatRate > 100
  ) {
    return "vat_invalid";
  }

  const items = input.items ?? [];
  if (items.length === 0) return "no_items";
  if (items.length > MAX_VOICE_DRAFT_ITEMS) return "too_many_items";

  for (const item of items) {
    if (typeof item.description !== "string" || item.description.trim() === "") {
      return "description_empty";
    }

    // MNOŽSTVO A PENIAZE SÚ DVE RÔZNE VECI.
    //
    // Množstvo smie byť predvolené (1 ks), cena NIKDY. Chýbajúca cena je
    // dôvod na otázku; keby sa tu doplnila jednotka, vznikol by doklad za
    // 1 € — presne ten, kvôli ktorému tento súbor existuje. Preto sa
    // kontrolujú samostatne a cena musí byť KLADNÁ, nie iba nezáporná.
    const quantity = item.quantity ?? 1;
    if (
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > MAX_VOICE_DRAFT_QUANTITY
    ) {
      return "quantity_invalid";
    }

    const unitPrice = item.unitPrice;
    if (
      typeof unitPrice !== "number" ||
      !Number.isFinite(unitPrice) ||
      unitPrice <= 0 ||
      unitPrice > MAX_VOICE_DRAFT_UNIT_PRICE
    ) {
      return "unit_price_invalid";
    }
  }

  // REKONCILIÁCIA SÚM.
  //
  // Každá suma vyslovená v úseku o položkách musí skončiť ako cena práve
  // jednej položky. Porovnáva sa multimnožina hodnôt, nie ich počet — dve
  // položky po 50 € sú v poriadku, jedna suma navyše nie je.
  const spoken = (input.spokenAmounts ?? []).slice().sort((a, b) => a - b);
  const used = items.map((item) => item.unitPrice as number).slice().sort((a, b) => a - b);

  if (spoken.length !== used.length) return "money_not_reconciled";
  for (let i = 0; i < spoken.length; i++) {
    if (spoken[i] !== used[i]) return "money_not_reconciled";
  }

  return null;
}
