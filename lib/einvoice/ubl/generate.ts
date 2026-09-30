import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { createUblDocument, XmlInvalidCharacterError, type XmlBuilder } from "./xml.ts";
import { isoDate, money, percent, plainDecimal, toDecimal } from "./format.ts";
import type {
  UblInvoiceSnapshot,
  UblIssue,
  UblItem,
  UblParty,
  UblTaxBreakdown,
  UblVatCategoryCode,
  UblWarning,
} from "./model.ts";
import type { Element } from "@xmldom/xmldom";

// =============================================================================
// UBL 2.1 / Peppol BIS Billing 3.0 z FINALIZOVANEJ vydanej faktúry.
//
// Zásady:
//   - vstup je nemenný snapshot načítaný serverom (invoices + invoice_parties +
//     invoice_items + invoice_tax_breakdowns), nikdy klientský payload,
//   - žiadne automatické „opravy": keď údaj chýba alebo nesedí, UBL sa
//     NEVYGENERUJE a vráti sa zoznam problémov (UblIssue) na opravu človekom,
//   - deterministický výstup (pevné poradie, žiadne časové pečiatky) a SHA-256
//     presne tých bajtov, ktoré sa odošlú,
//   - kontroluje iba pravidlá EN16931 / Peppol, ktoré vieme doložiť.
//     SK FS nadstavba (SK-BT-*) je len upozornenie — autoritatívne ju overí
//     preflight poskytovateľa (TODO po sandbox kľúči / OpenAPI).
//
// Nie je to validácia voči XSD ani Schematronu — tú generátor nenahrádza.
// =============================================================================

export const PEPPOL_BIS3_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const PEPPOL_BIS3_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

/**
 * Kód dôvodu oslobodenia pre kategórie, pri ktorých je kód jednoznačne daný
 * samotnou kategóriou (VATEX zoznam CEF). Pre E (oslobodenie) jednoznačný kód
 * neexistuje — musí ho zadať človek (BR-E-10), inak sa UBL nevygeneruje.
 */
const CATEGORY_VATEX: Partial<Record<UblVatCategoryCode, string>> = {
  AE: "VATEX-EU-AE",
  K: "VATEX-EU-IC",
  G: "VATEX-EU-G",
  O: "VATEX-EU-O",
};

export type UblGenerationResult =
  | { ok: true; xml: string; bytes: Uint8Array; sha256: string; documentType: "Invoice" | "CreditNote"; warnings: UblWarning[] }
  | { ok: false; issues: UblIssue[]; warnings: UblWarning[] };

type TypeInfo = { root: "Invoice" | "CreditNote"; typeCode: string } | null;

function documentTypeFor(kind: string): TypeInfo {
  switch (kind) {
    case "regular_invoice":
      return { root: "Invoice", typeCode: "380" };
    case "debit_note":
      return { root: "Invoice", typeCode: "383" };
    case "credit_note":
      return { root: "CreditNote", typeCode: "381" };
    default:
      // payment_received_invoice (daňový doklad k prijatej platbe): typ dokladu
      // pre SK Peppol nevieme potvrdiť — TODO po OpenAPI / odpovedi poskytovateľa.
      return null;
  }
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

function vatIdOf(party: UblParty): string | null {
  // BT-31 / BT-48: explicitný vat_identifier, inak IČ DPH (ten istý údaj — SK DIČ pre DPH).
  if (!blank(party.vat_identifier)) return party.vat_identifier!.trim();
  if (!blank(party.ic_dph)) return party.ic_dph!.trim();
  return null;
}

/** Kontroly, ktoré musia prejsť pred vygenerovaním. Vracia chyby aj upozornenia. */
export function checkUblPreconditions(s: UblInvoiceSnapshot): { issues: UblIssue[]; warnings: UblWarning[] } {
  const issues: UblIssue[] = [];
  const warnings: UblWarning[] = [];
  const add = (code: string, rule: string, message: string) => issues.push({ code, rule, message });
  const warn = (code: string, rule: string, message: string) => warnings.push({ code, rule, message });
  const inv = s.invoice;

  if (inv.direction !== "issued") add("NOT_ISSUED", "-", "UBL sa generuje iba z vydanej faktúry.");
  if (inv.document_status !== "finalized") add("NOT_FINALIZED", "-", "UBL sa generuje iba z finalizovanej faktúry.");
  if (blank(inv.invoice_number)) add("MISSING_INVOICE_NUMBER", "BT-1", "Chýba číslo faktúry.");
  if (!isoDate(inv.issue_date)) add("INVALID_ISSUE_DATE", "BT-2", "Chýba alebo je neplatný dátum vystavenia.");
  if (!documentTypeFor(inv.kind)) add("KIND_UNSUPPORTED", "BT-3", `Druh dokladu „${inv.kind}" zatiaľ nie je podporovaný pre e-faktúru.`);
  if (inv.currency !== "EUR") add("CURRENCY_UNSUPPORTED", "BT-5/BT-6", "Zatiaľ iba EUR (pri inej mene je povinný BT-111 v EUR — TODO).");

  if (blank(inv.buyer_reference) && blank(inv.purchase_order_reference)) {
    add("MISSING_BUYER_OR_ORDER_REFERENCE", "PEPPOL-EN16931-R003", "Vyplňte referenciu kupujúceho (BT-10) alebo číslo objednávky (BT-13).");
  }
  if (!isoDate(inv.due_date) && inv.kind !== "credit_note" && toDecimal(inv.total_amount).gt(0)) {
    add("MISSING_DUE_DATE", "BR-CO-25", "Chýba dátum splatnosti (BT-9).");
  }
  if (inv.kind === "credit_note" || inv.kind === "debit_note") {
    if (!s.correctedInvoice || blank(s.correctedInvoice.invoice_number)) {
      add("MISSING_PRECEDING_INVOICE", "BT-25", "Opravný doklad musí odkazovať na číslo opravovanej faktúry.");
    }
  }

  for (const [label, party, isSeller] of [["Predávajúci", s.seller, true], ["Kupujúci", s.buyer, false]] as const) {
    if (blank(party.legal_name)) add(`${isSeller ? "SELLER" : "BUYER"}_MISSING_NAME`, isSeller ? "BR-06" : "BR-07", `${label}: chýba obchodné meno.`);
    if (blank(party.country_code) || !/^[A-Z]{2}$/.test(party.country_code!.trim())) {
      add(`${isSeller ? "SELLER" : "BUYER"}_MISSING_COUNTRY`, isSeller ? "BR-09" : "BR-11", `${label}: chýba kód krajiny.`);
    }
    if (blank(party.electronic_address) || blank(party.electronic_address_scheme_id)) {
      add(
        `${isSeller ? "SELLER" : "BUYER"}_MISSING_ENDPOINT`,
        isSeller ? "PEPPOL-EN16931-R020 (BT-34)" : "PEPPOL-EN16931-R010 (BT-49)",
        `${label}: chýba elektronická adresa (Peppol ID) a jej schéma.`
      );
    }
  }
  // SK FS nadstavba — presné znenie nepoznáme, iba upozorňujeme (preflight rozhodne).
  if (blank(s.seller.address_line1) || blank(s.seller.city) || blank(s.seller.postal_code)) {
    warn("SK_SELLER_ADDRESS_INCOMPLETE", "SK-BT-35/37/38 (TODO)", "Predávajúci: neúplná adresa (ulica, mesto, PSČ).");
  }
  if (blank(s.buyer.address_line1) || blank(s.buyer.city) || blank(s.buyer.postal_code)) {
    warn("SK_BUYER_ADDRESS_INCOMPLETE", "SK-BT-50/52/53 (TODO)", "Kupujúci: neúplná adresa (ulica, mesto, PSČ).");
  }
  if (blank(s.seller.legal_registration_id)) warn("SK_SELLER_LEGAL_ID_MISSING", "SK-BT-30 (TODO)", "Predávajúci: chýba registračné číslo (BT-30).");
  if (blank(s.buyer.legal_registration_id)) warn("SK_BUYER_LEGAL_ID_MISSING", "SK-BT-47 (TODO)", "Kupujúci: chýba registračné číslo (BT-47).");

  if (s.items.length === 0) add("NO_LINES", "BR-16", "Faktúra nemá žiadne položky.");

  const categories = new Set(s.items.map((i) => i.vat_category_code));
  const sellerVat = vatIdOf(s.seller);
  const buyerVat = vatIdOf(s.buyer);
  if (categories.has("O")) {
    if (categories.size > 1) add("O_MIXED_WITH_OTHER_CATEGORIES", "BR-O-11", "Kategória O (mimo DPH) sa nesmie kombinovať s inými kategóriami.");
    if (sellerVat) add("O_WITH_SELLER_VAT_ID", "BR-O-02", "Pri kategórii O (neplatiteľ DPH) nesmie byť uvedené IČ DPH predávajúceho.");
  }
  if ([...categories].some((c) => c !== "O") && !sellerVat) {
    add("SELLER_VAT_ID_REQUIRED", "BR-S-02 / BR-Z-02 / BR-E-02 / BR-AE-02 / BR-IC-02 / BR-G-02", "Predávajúci: chýba IČ DPH (BT-31).");
  }
  if ((categories.has("AE") || categories.has("K")) && !buyerVat) {
    add("BUYER_VAT_ID_REQUIRED", "BR-AE-02 / BR-IC-02", "Kupujúci: pri prenesení daňovej povinnosti / dodaní do EÚ je povinné IČ DPH (BT-48).");
  }

  for (const item of s.items) {
    const where = `Položka ${item.position}`;
    if (blank(item.description)) add("LINE_MISSING_NAME", "BT-153", `${where}: chýba názov.`);
    if (blank(item.unit_code) || !/^[A-Z0-9]{1,3}$/.test(item.unit_code!.trim())) {
      add("LINE_MISSING_UNIT_CODE", "BT-130", `${where}: chýba kód mernej jednotky (UN/ECE Rec 20).`);
    }
    if (item.vat_category_code === "S" && !toDecimal(item.vat_rate).gt(0)) {
      add("LINE_S_RATE_NOT_POSITIVE", "BR-S-05", `${where}: kategória S vyžaduje kladnú sadzbu DPH.`);
    }
    if (netUnitPrice(item) === null) {
      add("LINE_PRICE_NOT_REPRESENTABLE", "PEPPOL-EN16931-R120", `${where}: čistú jednotkovú cenu nemožno presne vyjadriť (množstvo × cena ≠ suma riadka).`);
    }
  }

  for (const b of s.taxBreakdowns) {
    if (b.vat_category_code === "E" && blank(b.vat_exemption_reason_code) && blank(b.vat_exemption_reason_text)) {
      add("E_EXEMPTION_REASON_MISSING", "BR-E-10", "Oslobodenie od DPH (E) vyžaduje dôvod oslobodenia.");
    }
  }

  // Aritmetika hlavičky (BR-CO-10 / BR-CO-15) — len kontrola, nič sa neprepočítava.
  const lineSum = s.items.reduce((acc, i) => acc.plus(toDecimal(i.line_net_amount)), new Decimal(0));
  if (!lineSum.eq(toDecimal(inv.subtotal_amount))) {
    add("LINE_SUM_MISMATCH", "BR-CO-10", "Súčet riadkov sa nerovná základu faktúry.");
  }
  const breakdownVat = s.taxBreakdowns.reduce((acc, b) => acc.plus(toDecimal(b.vat_amount)), new Decimal(0));
  if (!breakdownVat.eq(toDecimal(inv.vat_total_amount))) {
    add("VAT_SUM_MISMATCH", "BR-CO-14", "Súčet DPH v rozpise sa nerovná DPH faktúry.");
  }
  const expectedTotal = toDecimal(inv.subtotal_amount).plus(toDecimal(inv.vat_total_amount)).plus(toDecimal(inv.rounding_amount));
  if (!expectedTotal.eq(toDecimal(inv.total_amount))) {
    add("TOTAL_MISMATCH", "BR-CO-15 / BR-CO-16", "Celková suma nesedí so základom, DPH a zaokrúhlením.");
  }

  if (!blank(s.seller.iban) && blank(inv.payment_means_code)) {
    add("MISSING_PAYMENT_MEANS_CODE", "BR-49 (BT-81)", "Pri IBAN je povinný kód spôsobu úhrady (napr. prevodný príkaz) — vyberte ho v koncepte faktúry.");
  }

  return { issues, warnings };
}

/**
 * Čistá jednotková cena (BT-146) tak, aby round(množstvo × cena, 2) = suma
 * riadka (PEPPOL-EN16931-R120). Pri cene bez DPH je to zadaná cena; pri cene
 * s DPH sa odvodí zo sumy riadka. Ak presná hodnota neexistuje, vráti null.
 */
function netUnitPrice(item: UblItem): Decimal | null {
  const qty = toDecimal(item.quantity);
  const lineNet = toDecimal(item.line_net_amount);
  if (qty.lte(0)) return null;
  const candidate = item.price_mode === "net"
    ? toDecimal(item.unit_price)
    : lineNet.div(qty).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
  return qty.times(candidate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).eq(lineNet) ? candidate : null;
}

/**
 * ISO 6523 ICD pre slovenské IČO (BT-30 / BT-47 schemeID).
 * Zdroj: Peppol BIS Billing 3.0 (May 2026) — ISO 6523 ICD code list,
 * https://docs.peppol.eu/poacc/billing/3.0/codelist/ICD/ :
 * „0158 — Identification number of economic subject (ICO) … Slovak Statistical Office".
 * (0245 = SK DIČ, používa sa pre Peppol participant ID, nie pre IČO.)
 */
export const SK_ICO_ICD_SCHEME = "0158";

/**
 * schemeID pre PartyLegalEntity/CompanyID. Explicitne uložená schéma má prednosť;
 * ak chýba a ide o slovenskú stranu s 8-miestnym IČO, doplní sa 0158
 * (SK FS overlay: SK-BT-30/47-SCHEME-REQUIRED).
 */
function legalRegistrationSchemeOf(party: UblParty): string | null {
  if (!blank(party.legal_registration_scheme_id)) return party.legal_registration_scheme_id!.trim();
  const id = party.legal_registration_id?.trim() ?? "";
  if (party.country_code?.trim().toUpperCase() === "SK" && /^[0-9]{8}$/.test(id)) return SK_ICO_ICD_SCHEME;
  return null;
}

function addParty(x: XmlBuilder, parent: Element, party: UblParty) {
  const p = x.group(parent, "cac:Party");
  x.text(p, "cbc:EndpointID", party.electronic_address!.trim(), { schemeID: party.electronic_address_scheme_id!.trim() });

  const addr = x.group(p, "cac:PostalAddress");
  if (!blank(party.address_line1)) x.text(addr, "cbc:StreetName", party.address_line1!.trim());
  if (!blank(party.address_line2)) x.text(addr, "cbc:AdditionalStreetName", party.address_line2!.trim());
  if (!blank(party.city)) x.text(addr, "cbc:CityName", party.city!.trim());
  if (!blank(party.postal_code)) x.text(addr, "cbc:PostalZone", party.postal_code!.trim());
  const country = x.group(addr, "cac:Country");
  x.text(country, "cbc:IdentificationCode", party.country_code!.trim());

  const vat = vatIdOf(party);
  if (vat) {
    const pts = x.group(p, "cac:PartyTaxScheme");
    x.text(pts, "cbc:CompanyID", vat);
    x.text(x.group(pts, "cac:TaxScheme"), "cbc:ID", "VAT");
  }

  const legal = x.group(p, "cac:PartyLegalEntity");
  x.text(legal, "cbc:RegistrationName", party.legal_name.trim());
  if (!blank(party.legal_registration_id)) {
    const scheme = legalRegistrationSchemeOf(party);
    const attrs = scheme ? { schemeID: scheme } : undefined;
    x.text(legal, "cbc:CompanyID", party.legal_registration_id!.trim(), attrs);
  }

  if (!blank(party.email)) {
    x.text(x.group(p, "cac:Contact"), "cbc:ElectronicMail", party.email!.trim());
  }
}

function addTaxCategory(x: XmlBuilder, parent: Element, qname: "cac:TaxCategory" | "cac:ClassifiedTaxCategory", code: UblVatCategoryCode, rate: number | string, breakdown?: UblTaxBreakdown) {
  const cat = x.group(parent, qname);
  x.text(cat, "cbc:ID", code);
  // BR-O-05 / BR-O-10: kategória O nemá sadzbu; ostatné áno (0 pre Z/E/AE/K/G).
  if (code !== "O") x.text(cat, "cbc:Percent", percent(code === "S" ? rate : 0));
  if (breakdown) {
    const reasonCode = blank(breakdown.vat_exemption_reason_code)
      ? CATEGORY_VATEX[code] ?? null
      : breakdown.vat_exemption_reason_code!.trim();
    if (reasonCode) x.text(cat, "cbc:TaxExemptionReasonCode", reasonCode);
    if (!blank(breakdown.vat_exemption_reason_text)) x.text(cat, "cbc:TaxExemptionReason", breakdown.vat_exemption_reason_text!.trim());
  }
  x.text(x.group(cat, "cac:TaxScheme"), "cbc:ID", "VAT");
}

/** Vygeneruje UBL. Pri akomkoľvek probléme vráti ok:false so zoznamom — nikdy nič neopraví. */
export function generateUbl(s: UblInvoiceSnapshot): UblGenerationResult {
  const { issues, warnings } = checkUblPreconditions(s);
  if (issues.length > 0) return { ok: false, issues, warnings };

  const inv = s.invoice;
  const type = documentTypeFor(inv.kind)!;
  const isCredit = type.root === "CreditNote";

  try {
    const x = createUblDocument(type.root);
    const r = x.root;
    const cur = { currencyID: inv.currency };

    x.text(r, "cbc:CustomizationID", PEPPOL_BIS3_CUSTOMIZATION_ID);
    x.text(r, "cbc:ProfileID", PEPPOL_BIS3_PROFILE_ID);
    x.text(r, "cbc:ID", inv.invoice_number!.trim());
    x.text(r, "cbc:IssueDate", isoDate(inv.issue_date)!);
    if (!isCredit && isoDate(inv.due_date)) x.text(r, "cbc:DueDate", isoDate(inv.due_date)!);
    x.text(r, isCredit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", type.typeCode);
    if (isoDate(inv.tax_point_date)) x.text(r, "cbc:TaxPointDate", isoDate(inv.tax_point_date)!);
    x.text(r, "cbc:DocumentCurrencyCode", inv.currency);
    if (!blank(inv.buyer_reference)) x.text(r, "cbc:BuyerReference", inv.buyer_reference!.trim());
    if (!blank(inv.purchase_order_reference)) {
      x.text(x.group(r, "cac:OrderReference"), "cbc:ID", inv.purchase_order_reference!.trim());
    }
    if (s.correctedInvoice && !blank(s.correctedInvoice.invoice_number)) {
      const ref = x.group(x.group(r, "cac:BillingReference"), "cac:InvoiceDocumentReference");
      x.text(ref, "cbc:ID", s.correctedInvoice.invoice_number!.trim());
      if (isoDate(s.correctedInvoice.issue_date)) x.text(ref, "cbc:IssueDate", isoDate(s.correctedInvoice.issue_date)!);
    }

    addParty(x, x.group(r, "cac:AccountingSupplierParty"), s.seller);
    addParty(x, x.group(r, "cac:AccountingCustomerParty"), s.buyer);

    if (isoDate(inv.delivery_date)) {
      x.text(x.group(r, "cac:Delivery"), "cbc:ActualDeliveryDate", isoDate(inv.delivery_date)!);
    }

    if (!blank(inv.payment_means_code)) {
      const pm = x.group(r, "cac:PaymentMeans");
      x.text(pm, "cbc:PaymentMeansCode", inv.payment_means_code!.trim());
      if (isCredit && isoDate(inv.due_date)) x.text(pm, "cbc:PaymentDueDate", isoDate(inv.due_date)!);
      if (!blank(inv.payment_reference)) x.text(pm, "cbc:PaymentID", inv.payment_reference!.trim());
      if (!blank(s.seller.iban)) {
        const acct = x.group(pm, "cac:PayeeFinancialAccount");
        x.text(acct, "cbc:ID", s.seller.iban!.replace(/\s+/g, "").toUpperCase());
        if (!blank(s.seller.bic)) {
          x.text(x.group(acct, "cac:FinancialInstitutionBranch"), "cbc:ID", s.seller.bic!.trim().toUpperCase());
        }
      }
    }

    const taxTotal = x.group(r, "cac:TaxTotal");
    x.text(taxTotal, "cbc:TaxAmount", money(inv.vat_total_amount), cur);
    const breakdowns = [...s.taxBreakdowns].sort((a, b) =>
      a.vat_category_code === b.vat_category_code
        ? toDecimal(a.vat_rate).cmp(toDecimal(b.vat_rate))
        : a.vat_category_code < b.vat_category_code ? -1 : 1
    );
    for (const b of breakdowns) {
      const sub = x.group(taxTotal, "cac:TaxSubtotal");
      x.text(sub, "cbc:TaxableAmount", money(b.taxable_amount), cur);
      x.text(sub, "cbc:TaxAmount", money(b.vat_amount), cur);
      addTaxCategory(x, sub, "cac:TaxCategory", b.vat_category_code, b.vat_rate, b);
    }

    const totals = x.group(r, "cac:LegalMonetaryTotal");
    const taxExclusive = toDecimal(inv.subtotal_amount);
    x.text(totals, "cbc:LineExtensionAmount", money(taxExclusive), cur);
    x.text(totals, "cbc:TaxExclusiveAmount", money(taxExclusive), cur);
    x.text(totals, "cbc:TaxInclusiveAmount", money(taxExclusive.plus(toDecimal(inv.vat_total_amount))), cur);
    if (!toDecimal(inv.rounding_amount).eq(0)) x.text(totals, "cbc:PayableRoundingAmount", money(inv.rounding_amount), cur);
    x.text(totals, "cbc:PayableAmount", money(inv.total_amount), cur);

    const items = [...s.items].sort((a, b) => a.position - b.position);
    for (const item of items) {
      const line = x.group(r, isCredit ? "cac:CreditNoteLine" : "cac:InvoiceLine");
      x.text(line, "cbc:ID", String(item.position));
      x.text(line, isCredit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity", plainDecimal(item.quantity), { unitCode: item.unit_code!.trim() });
      x.text(line, "cbc:LineExtensionAmount", money(item.line_net_amount), cur);
      const it = x.group(line, "cac:Item");
      x.text(it, "cbc:Name", item.description.trim());
      addTaxCategory(x, it, "cac:ClassifiedTaxCategory", item.vat_category_code, item.vat_rate);
      const price = x.group(line, "cac:Price");
      x.text(price, "cbc:PriceAmount", plainDecimal(netUnitPrice(item)!), cur);
    }

    const xml = x.serialize();
    const bytes = new TextEncoder().encode(xml);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { ok: true, xml, bytes, sha256, documentType: type.root, warnings };
  } catch (error) {
    if (error instanceof XmlInvalidCharacterError) {
      return {
        ok: false,
        warnings,
        issues: [{ code: "INVALID_XML_CHARACTER", rule: "XML 1.0", message: `Nepovolený znak v poli ${error.context} — opravte údaj.` }],
      };
    }
    throw error;
  }
}
