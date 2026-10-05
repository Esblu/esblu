import Decimal from "decimal.js";
import type { ParsedInboundUbl } from "../ubl/parse.ts";

// =============================================================================
// E-Faktúra inbound — validácia profilu a mapovanie rozparsovaného UBL na
// vstup konceptu prijatej faktúry (esblu_einvoice_inbound_create_draft →
// esblu_received_invoice_draft_core). Čistá funkcia, žiadne AI, žiadne
// hádanie: čo nevieme spoľahlivo namapovať, buď zablokuje koncept (kód), alebo
// sa zapíše ako review reason pre človeka.
//
// Sumy (L3 nález 2026-10-03): koncept MUSÍ byť už pri vzniku finančne zhodný
// s nemenným XML — hlavička (BT-106/109/110/112/114/115), spôsob úhrady
// (BT-81) a rozpis DPH (BG-23) sa prenášajú z XML (`totals`), nič sa
// neprepočítava. XML je zdroj pravdy: ak je doklad sám v sebe nekonzistentný
// alebo obsahuje niečo, čo dátový model Esblu nevie verne uložiť (zľavy/
// prirážky na úrovni dokladu, uhradené zálohy), koncept NEVZNIKNE (žiadny
// ACK) — radšej manuálna kontrola než tichá zmena významu doručeného dokladu.
// =============================================================================

/** EN16931 (vrátane Peppol BIS Billing 3.0 a jeho CIUS/extensions) — CustomizationID začína týmto URN. */
export const EN16931_CUSTOMIZATION_PREFIX = "urn:cen.eu:en16931:2017";

const SUPPORTED_VAT = new Set(["S", "Z", "E", "AE", "K", "G", "O"]);

export type InboundDraftSupplier = {
  legal_name: string | null;
  ico: string | null;
  /** SK DIČ (10 číslic) — iba spoľahlivo odvodené z XML (deriveSupplierDic), inak null. */
  dic: string | null;
  vat_id: string | null;
  country_code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  endpoint_id: string | null;
  endpoint_scheme: string | null;
};

export type InboundDraftItem = {
  description: string;
  quantity: string;
  unit_price: string;
  vat_category_code: string;
  vat_rate: string;
  unit_code: string | null;
};

/** Rozpis DPH (BG-23) presne podľa XML; sadzba je pre iné kategórie ako S vždy 0 (rovnako ako finalizácia). */
export type InboundDraftTaxBreakdown = {
  category: string;
  rate: string;
  taxable: string;
  vat: string;
  exemption_reason_code: string | null;
};

/** Peňažné súčty dokladu presne podľa XML (BG-22) — reťazce s 2 desatinnými miestami. */
export type InboundDraftTotals = {
  line_extension: string;
  tax_exclusive: string;
  vat_total: string;
  tax_inclusive: string;
  rounding: string;
  prepaid: string;
  payable: string;
  breakdown: InboundDraftTaxBreakdown[];
};

export type InboundDraftPayload = {
  supplier: InboundDraftSupplier;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  delivery_date: string | null;
  currency: string;
  iban: string | null;
  bic: string | null;
  payment_reference: string | null;
  /** BT-81 (UNCL4461, iba číselné kódy — DB check ^[0-9]{1,3}$). */
  payment_means_code: string | null;
  buyer_reference: string | null;
  purchase_order_reference: string | null;
  items: InboundDraftItem[];
  totals: InboundDraftTotals;
};

export type MappingResult =
  | { ok: true; draft: InboundDraftPayload; reviewReasons: string[] }
  /** code = verejný kód chyby (UNSUPPORTED_PROFILE / INVALID_XML), detail = strojový podkód. */
  | { ok: false; code: "UNSUPPORTED_PROFILE" | "INVALID_XML"; detail: string };

function blank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === "";
}

const money = (d: Decimal) => d.toFixed(2);
const dec = (v: string | null | undefined) => new Decimal(blank(v) ? "0" : v!.trim());
/** Kľúč skupiny DPH rovnako ako finalizácia: kategória + sadzba (pre iné ako S vždy 0). */
const groupKey = (category: string, rate: Decimal) => `${category}|${rate.toFixed(4)}`;

/** Spôsob úhrady BT-81 — Esblu ukladá iba číselné kódy UNCL4461. */
export function mapPaymentMeansCode(code: string | null): { code: string | null; unsupported: boolean } {
  if (blank(code)) return { code: null, unsupported: false };
  const c = code!.trim();
  return /^[0-9]{1,3}$/.test(c) ? { code: c, unsupported: false } : { code: null, unsupported: true };
}

/** Profil / typ dokladu, ktorý vieme prijať ako koncept prijatej faktúry. */
export function checkInboundProfile(doc: ParsedInboundUbl): { ok: true } | { ok: false; detail: string } {
  if (blank(doc.customizationId) || !doc.customizationId!.trim().startsWith(EN16931_CUSTOMIZATION_PREFIX)) {
    return { ok: false, detail: "CUSTOMIZATION_NOT_EN16931" };
  }
  // Koncept prijatej faktúry (esblu_received_invoice_draft_core) vytvára iba kind regular_invoice.
  if (doc.documentType !== "Invoice") return { ok: false, detail: "CREDIT_NOTE_NOT_SUPPORTED" };
  return { ok: true };
}

/**
 * SK DIČ dodávateľa z XML — iba z jednoznačných zdrojov (nikdy z IČO ani názvu):
 *   1) IČ DPH (BT-31) „SK“ + 10 číslic → DIČ = tých 10 číslic (IČ DPH = SK + DIČ),
 *   2) Peppol endpoint (BT-34) schéma 0245 (SK DIČ) s 10 číslicami,
 *      v sandboxe aj testovacia schéma 9915 (eFaktura.sk sandbox: 9915:DIČ).
 * Ak sa zdroje nezhodujú → null + review reason (radšej človek než zlý údaj).
 * Krajina iná ako SK → null.
 */
export function deriveSupplierDic(
  s: { vatId: string | null; endpointId: string | null; endpointScheme: string | null; countryCode: string | null },
  opts: { allowTestScheme?: boolean } = {}
): { dic: string | null; conflict: boolean } {
  const country = (s.countryCode ?? "").trim().toUpperCase();
  if (country && country !== "SK") return { dic: null, conflict: false };
  const vat = (s.vatId ?? "").replace(/[\s.\-/]/g, "").toUpperCase();
  const fromVat = /^SK[0-9]{10}$/.test(vat) ? vat.slice(2) : null;
  const scheme = (s.endpointScheme ?? "").trim();
  const ep = (s.endpointId ?? "").trim();
  const schemeOk = scheme === "0245" || (opts.allowTestScheme === true && scheme === "9915");
  const fromEndpoint = schemeOk && /^[0-9]{10}$/.test(ep) ? ep : null;
  if (fromVat && fromEndpoint && fromVat !== fromEndpoint) return { dic: null, conflict: true };
  return { dic: fromVat ?? fromEndpoint, conflict: false };
}

export function mapInboundDraft(
  doc: ParsedInboundUbl,
  parserReviewReasons: string[],
  recipientParticipantId: string | null,
  opts: { allowTestScheme?: boolean } = {}
): MappingResult {
  const profile = checkInboundProfile(doc);
  if (!profile.ok) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: profile.detail };

  if (blank(doc.invoiceNumber)) return { ok: false, code: "INVALID_XML", detail: "MISSING_INVOICE_NUMBER" };
  if (blank(doc.issueDate) || parserReviewReasons.includes("INVALID_ISSUE_DATE")) return { ok: false, code: "INVALID_XML", detail: "INVALID_ISSUE_DATE" };
  if (blank(doc.currency) || !/^[A-Z]{3}$/.test(doc.currency!.trim())) return { ok: false, code: "INVALID_XML", detail: "MISSING_CURRENCY" };
  if (doc.lines.length === 0) return { ok: false, code: "INVALID_XML", detail: "NO_LINES" };
  if (blank(doc.supplier.name)) return { ok: false, code: "INVALID_XML", detail: "MISSING_SUPPLIER_NAME" };

  const reasons = new Set(parserReviewReasons.filter((r) => /^[A-Z0-9_]{1,60}$/.test(r)));
  if (doc.typeCode && doc.typeCode !== "380") reasons.add("INVOICE_TYPE_CODE_UNUSUAL");

  // Príjemca musí byť naša organizácia (Peppol to zaručuje; ak nesedí, iba na kontrolu).
  if (recipientParticipantId) {
    const customer = doc.customer.endpointId && doc.customer.endpointScheme ? `${doc.customer.endpointScheme}:${doc.customer.endpointId}` : null;
    if (customer !== recipientParticipantId) reasons.add("RECIPIENT_ENDPOINT_MISMATCH");
  }

  // Peňažné súčty dokladu (BG-22) — povinné v EN16931 (BT-106, BT-109, BT-112, BT-115).
  const t = doc.totals;
  if (blank(t.lineExtension) || blank(t.taxExclusive) || blank(t.taxInclusive) || blank(t.payable)) {
    return { ok: false, code: "INVALID_XML", detail: "MISSING_MONETARY_TOTALS" };
  }
  // Dátový model Esblu nemá zľavy/prirážky na úrovni dokladu ani uhradené zálohy:
  // koncept by nebol zhodný s XML → nevznikne (žiadny ACK, manuálna kontrola).
  if (parserReviewReasons.includes("DOCUMENT_ALLOWANCE_CHARGE_NOT_MAPPED") || !dec(t.taxExclusive).eq(dec(t.lineExtension))) {
    return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "DOCUMENT_ALLOWANCE_CHARGE_UNSUPPORTED" };
  }
  if (!dec(t.prepaid).eq(0)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "PREPAID_AMOUNT_UNSUPPORTED" };

  const items: InboundDraftItem[] = [];
  const lineGroups = new Map<string, Decimal>();
  let lineSum = new Decimal(0);
  for (const line of doc.lines) {
    const category = (line.vatCategory ?? "").trim().toUpperCase();
    if (!SUPPORTED_VAT.has(category)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "VAT_CATEGORY_UNSUPPORTED" };
    if (line.quantity === null || line.lineNetAmount === null) return { ok: false, code: "INVALID_XML", detail: "LINE_INCOMPLETE" };
    const qty = new Decimal(line.quantity);
    if (qty.lte(0)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "NON_POSITIVE_QUANTITY" };
    const lineNet = new Decimal(line.lineNetAmount);
    if (lineNet.decimalPlaces() > 2) return { ok: false, code: "INVALID_XML", detail: "LINE_AMOUNT_PRECISION" };
    // Suma riadka (BT-131) je zdroj pravdy: koncept ju uloží ako round(množstvo × cena, 2)
    // (esblu_received_invoice_draft_core), preto cena musí dať PRESNE túto sumu.
    // Ak ju nedá uvedená cena (napr. zľava na riadku BG-27), použije sa cena
    // odvodená zo sumy riadka (6 desatinných miest) a doklad ide na kontrolu
    // (LINE_AMOUNT_MISMATCH).
    // Ak ani tá nedá presnú sumu, koncept nevznikne.
    const exact = (p: Decimal) => qty.times(p).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).eq(lineNet);
    let unitPrice = line.netUnitPrice !== null ? new Decimal(line.netUnitPrice) : null;
    if (unitPrice === null || unitPrice.decimalPlaces() > 6 || !exact(unitPrice)) {
      if (unitPrice !== null) reasons.add("LINE_AMOUNT_MISMATCH");
      unitPrice = lineNet.div(qty).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
      if (!exact(unitPrice)) return { ok: false, code: "INVALID_XML", detail: "LINE_AMOUNT_NOT_REPRESENTABLE" };
    }
    if (unitPrice.lt(0)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "NEGATIVE_UNIT_PRICE" };
    if (category === "S" && (line.vatPercent === null || new Decimal(line.vatPercent).lte(0))) {
      return { ok: false, code: "INVALID_XML", detail: "S_RATE_MISSING" };
    }
    let description = (line.name ?? "").trim();
    if (!description) {
      reasons.add("LINE_NAME_MISSING");
      description = `#${(line.id ?? String(items.length + 1)).slice(0, 40)}`;
    }
    const rate = category === "S" ? new Decimal(line.vatPercent!) : new Decimal(0);
    items.push({
      description: description.slice(0, 500),
      quantity: qty.toFixed(),
      unit_price: unitPrice.toFixed(),
      vat_category_code: category,
      vat_rate: rate.toFixed(),
      unit_code: line.unitCode && /^[A-Z0-9]{1,3}$/.test(line.unitCode) ? line.unitCode : null,
    });
    const key = groupKey(category, rate);
    lineGroups.set(key, (lineGroups.get(key) ?? new Decimal(0)).plus(lineNet));
    lineSum = lineSum.plus(lineNet);
  }

  // Aritmetika dokladu (EN16931 BR-CO-10/11/13/14/15/16/17). Nesúlad = XML nie je
  // vnútorne konzistentné → koncept nevznikne (nič sa „neopraví").
  const vatTotal = dec(doc.vatTotal);
  const rounding = dec(t.rounding);
  const amounts = [t.lineExtension, t.taxExclusive, t.taxInclusive, t.payable, t.rounding, doc.vatTotal];
  if (amounts.some((a) => !blank(a) && dec(a).decimalPlaces() > 2)) return { ok: false, code: "INVALID_XML", detail: "AMOUNT_PRECISION" };
  if (!lineSum.eq(dec(t.lineExtension))) return { ok: false, code: "INVALID_XML", detail: "TOTALS_LINE_SUM_MISMATCH" };
  if (!dec(t.taxExclusive).plus(vatTotal).eq(dec(t.taxInclusive))) return { ok: false, code: "INVALID_XML", detail: "TOTALS_TAX_INCLUSIVE_MISMATCH" };
  if (!dec(t.taxInclusive).minus(dec(t.prepaid)).plus(rounding).eq(dec(t.payable))) return { ok: false, code: "INVALID_XML", detail: "TOTALS_PAYABLE_MISMATCH" };

  if (doc.taxSubtotals.length === 0) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_MISSING" };
  const breakdown: InboundDraftTaxBreakdown[] = [];
  const seen = new Set<string>();
  let taxableSum = new Decimal(0);
  let vatSum = new Decimal(0);
  for (const st of doc.taxSubtotals) {
    const category = (st.category ?? "").trim().toUpperCase();
    if (!SUPPORTED_VAT.has(category)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "VAT_CATEGORY_UNSUPPORTED" };
    if (blank(st.taxableAmount) || blank(st.taxAmount)) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_INCOMPLETE" };
    if (category === "S" && (blank(st.percent) || dec(st.percent).lte(0))) return { ok: false, code: "INVALID_XML", detail: "S_RATE_MISSING" };
    const rate = category === "S" ? dec(st.percent) : new Decimal(0);
    if (category !== "S" && !blank(st.percent) && !dec(st.percent).eq(0)) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_RATE_INVALID" };
    const taxable = dec(st.taxableAmount);
    const vat = dec(st.taxAmount);
    if (taxable.decimalPlaces() > 2 || vat.decimalPlaces() > 2) return { ok: false, code: "INVALID_XML", detail: "AMOUNT_PRECISION" };
    const key = groupKey(category, rate);
    if (seen.has(key)) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_DUPLICATE" };
    seen.add(key);
    // BR-CO-17 (rovnaký vzorec ako finalizácia Esblu); iné kategórie nesú nulovú daň.
    const expectedVat = category === "S" ? taxable.times(rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : new Decimal(0);
    if (!vat.eq(expectedVat)) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_AMOUNT_MISMATCH" };
    if (!taxable.eq(lineGroups.get(key) ?? new Decimal(-1))) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_LINE_MISMATCH" };
    taxableSum = taxableSum.plus(taxable);
    vatSum = vatSum.plus(vat);
    const exemption = (st.exemptionReasonCode ?? "").trim();
    breakdown.push({
      category,
      rate: rate.toFixed(),
      taxable: money(taxable),
      vat: money(vat),
      exemption_reason_code: /^[A-Z0-9-]{1,30}$/i.test(exemption) ? exemption.toUpperCase() : null,
    });
  }
  if (seen.size !== lineGroups.size) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_LINE_MISMATCH" };
  if (!taxableSum.eq(dec(t.taxExclusive))) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_TAXABLE_MISMATCH" };
  if (!vatSum.eq(vatTotal)) return { ok: false, code: "INVALID_XML", detail: "VAT_BREAKDOWN_TOTAL_MISMATCH" };

  const paymentMeans = mapPaymentMeansCode(doc.paymentMeansCode);
  if (paymentMeans.unsupported) reasons.add("PAYMENT_MEANS_CODE_UNSUPPORTED");

  const s = doc.supplier;
  const legalId = (s.legalId ?? "").replace(/\s+/g, "");
  const country = (s.countryCode ?? "").trim().toUpperCase() || null;
  const ico = /^[0-9]{8}$/.test(legalId) && (s.legalIdScheme === "0158" || (!s.legalIdScheme && country === "SK")) ? legalId : null;
  const dic = deriveSupplierDic({ vatId: s.vatId, endpointId: s.endpointId, endpointScheme: s.endpointScheme, countryCode: country }, opts);
  if (dic.conflict) reasons.add("SUPPLIER_DIC_CONFLICT");

  return {
    ok: true,
    reviewReasons: [...reasons].slice(0, 30),
    draft: {
      supplier: {
        legal_name: s.name!.trim(),
        ico,
        dic: dic.dic,
        vat_id: s.vatId?.trim() || null,
        country_code: country,
        address_line1: s.street,
        address_line2: s.additionalStreet,
        city: s.city,
        postal_code: s.postalCode,
        endpoint_id: s.endpointId,
        endpoint_scheme: s.endpointScheme,
      },
      invoice_number: doc.invoiceNumber!.trim(),
      issue_date: doc.issueDate!.trim(),
      due_date: doc.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.dueDate) ? doc.dueDate : null,
      delivery_date: doc.deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.deliveryDate) ? doc.deliveryDate : null,
      currency: doc.currency!.trim(),
      iban: doc.payeeIban ? doc.payeeIban.replace(/\s+/g, "").toUpperCase() : null,
      bic: doc.payeeBic ? doc.payeeBic.trim().toUpperCase() : null,
      payment_reference: doc.paymentId,
      payment_means_code: paymentMeans.code,
      buyer_reference: doc.buyerReference,
      purchase_order_reference: doc.orderReference,
      items,
      totals: {
        line_extension: money(dec(t.lineExtension)),
        tax_exclusive: money(dec(t.taxExclusive)),
        vat_total: money(vatTotal),
        tax_inclusive: money(dec(t.taxInclusive)),
        rounding: money(rounding),
        prepaid: money(dec(t.prepaid)),
        payable: money(dec(t.payable)),
        breakdown,
      },
    },
  };
}
