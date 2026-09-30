import { DOMParser, type Element } from "@xmldom/xmldom";
import Decimal from "decimal.js";
import { NS } from "./xml.ts";
import { isIsoDate } from "./format.ts";

// =============================================================================
// Parser PRIJATÉHO UBL (Invoice / CreditNote) — iba polia, ktoré vieme
// spoľahlivo namapovať na koncept prijatej faktúry.
//
// Bezpečnosť a integrita:
//   - DOCTYPE / ENTITY sa odmietnu ešte pred parsovaním (žiadne XXE, žiadne
//     rozbaľovanie entít), veľkosť je obmedzená,
//   - neznáme elementy sa ignorujú, ale všetko, čo by zmenilo sumy a čo
//     nemapujeme (zľavy/prirážky, zálohy, iná mena DPH…), sa zapíše do
//     reviewReasons — výsledok je VŽDY iba návrh na kontrolu človekom,
//   - aritmetika dokladu sa overí; nesúlad = reviewReason, nikdy sa neopraví.
// =============================================================================

export const MAX_INBOUND_XML_BYTES = 5 * 1024 * 1024;

export type ParsedParty = {
  endpointId: string | null;
  endpointScheme: string | null;
  name: string | null;
  vatId: string | null;
  legalId: string | null;
  legalIdScheme: string | null;
  street: string | null;
  additionalStreet: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
};

export type ParsedLine = {
  id: string | null;
  quantity: string | null;
  unitCode: string | null;
  lineNetAmount: string | null;
  name: string | null;
  vatCategory: string | null;
  vatPercent: string | null;
  netUnitPrice: string | null;
};

export type ParsedInboundUbl = {
  documentType: "Invoice" | "CreditNote";
  customizationId: string | null;
  profileId: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  typeCode: string | null;
  currency: string | null;
  buyerReference: string | null;
  orderReference: string | null;
  precedingInvoiceNumber: string | null;
  deliveryDate: string | null;
  supplier: ParsedParty;
  customer: ParsedParty;
  paymentMeansCode: string | null;
  paymentId: string | null;
  payeeIban: string | null;
  payeeBic: string | null;
  vatTotal: string | null;
  taxSubtotals: { category: string | null; percent: string | null; taxableAmount: string | null; taxAmount: string | null; exemptionReasonCode: string | null }[];
  totals: {
    lineExtension: string | null;
    taxExclusive: string | null;
    taxInclusive: string | null;
    prepaid: string | null;
    rounding: string | null;
    payable: string | null;
  };
  lines: ParsedLine[];
};

export type InboundParseResult =
  | { ok: true; document: ParsedInboundUbl; reviewReasons: string[] }
  | { ok: false; error: string };

const AMOUNT = /^-?\d+(\.\d+)?$/;

function children(el: Element, ns: string, local: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      const e = n as Element;
      if (e.namespaceURI === ns && e.localName === local) out.push(e);
    }
  }
  return out;
}
const first = (el: Element | null, ns: string, local: string) => (el ? children(el, ns, local)[0] ?? null : null);
const cac = (el: Element | null, local: string) => first(el, NS.cac, local);
const cbcEl = (el: Element | null, local: string) => first(el, NS.cbc, local);
function text(el: Element | null): string | null {
  if (!el) return null;
  const t = (el.textContent ?? "").trim();
  return t === "" ? null : t;
}
const cbc = (el: Element | null, local: string) => text(cbcEl(el, local));

function party(wrapper: Element | null): ParsedParty {
  const p = cac(wrapper, "Party");
  const endpoint = cbcEl(p, "EndpointID");
  const addr = cac(p, "PostalAddress");
  const legal = cac(p, "PartyLegalEntity");
  const legalIdEl = cbcEl(legal, "CompanyID");
  return {
    endpointId: text(endpoint),
    endpointScheme: endpoint?.getAttribute("schemeID") || null,
    name: cbc(legal, "RegistrationName") ?? cbc(cac(p, "PartyName"), "Name"),
    vatId: cbc(cac(p, "PartyTaxScheme"), "CompanyID"),
    legalId: text(legalIdEl),
    legalIdScheme: legalIdEl?.getAttribute("schemeID") || null,
    street: cbc(addr, "StreetName"),
    additionalStreet: cbc(addr, "AdditionalStreetName"),
    city: cbc(addr, "CityName"),
    postalCode: cbc(addr, "PostalZone"),
    countryCode: cbc(cac(addr, "Country"), "IdentificationCode"),
  };
}

export function parseInboundUbl(input: string | Uint8Array): InboundParseResult {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_INBOUND_XML_BYTES) return { ok: false, error: "UBL_TOO_LARGE" };
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "UBL_NOT_UTF8" };
  }
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) return { ok: false, error: "UBL_DTD_NOT_ALLOWED" };

  let root: Element | null;
  try {
    const doc = new DOMParser({
      onError: (level: string, message: string) => {
        if (level !== "warning") throw new Error(`${level}: ${message}`);
      },
    }).parseFromString(xml, "text/xml");
    root = doc.documentElement as Element | null;
  } catch {
    return { ok: false, error: "UBL_MALFORMED" };
  }
  if (!root) return { ok: false, error: "UBL_MALFORMED" };

  let documentType: "Invoice" | "CreditNote";
  if (root.namespaceURI === NS.invoice && root.localName === "Invoice") documentType = "Invoice";
  else if (root.namespaceURI === NS.creditNote && root.localName === "CreditNote") documentType = "CreditNote";
  else return { ok: false, error: "UBL_UNSUPPORTED_ROOT" };

  const reviewReasons: string[] = [];
  const isCredit = documentType === "CreditNote";

  const taxTotals = children(root, NS.cac, "TaxTotal");
  const docCurrency = cbc(root, "DocumentCurrencyCode");
  const taxTotal = taxTotals.find((t) => cbcEl(t, "TaxAmount")?.getAttribute("currencyID") === docCurrency) ?? taxTotals[0] ?? null;
  if (taxTotals.length > 1) reviewReasons.push("MULTIPLE_TAX_TOTALS");
  if (cbc(root, "TaxCurrencyCode") && cbc(root, "TaxCurrencyCode") !== docCurrency) reviewReasons.push("TAX_CURRENCY_DIFFERS");
  if (children(root, NS.cac, "AllowanceCharge").length > 0) reviewReasons.push("DOCUMENT_ALLOWANCE_CHARGE_NOT_MAPPED");
  if (children(root, NS.cac, "PaymentMeans").length > 1) reviewReasons.push("MULTIPLE_PAYMENT_MEANS");

  const pm = cac(root, "PaymentMeans");
  const payee = cac(pm, "PayeeFinancialAccount");
  const totalsEl = cac(root, "LegalMonetaryTotal");
  const billingRef = cac(cac(root, "BillingReference"), "InvoiceDocumentReference");

  const lineName = isCredit ? "CreditNoteLine" : "InvoiceLine";
  const qtyName = isCredit ? "CreditedQuantity" : "InvoicedQuantity";
  const lines: ParsedLine[] = children(root, NS.cac, lineName).map((l) => {
    if (children(l, NS.cac, "AllowanceCharge").length > 0) reviewReasons.push("LINE_ALLOWANCE_CHARGE_NOT_MAPPED");
    const q = cbcEl(l, qtyName);
    const item = cac(l, "Item");
    const tax = cac(item, "ClassifiedTaxCategory");
    return {
      id: cbc(l, "ID"),
      quantity: text(q),
      unitCode: q?.getAttribute("unitCode") || null,
      lineNetAmount: cbc(l, "LineExtensionAmount"),
      name: cbc(item, "Name"),
      vatCategory: cbc(tax, "ID"),
      vatPercent: cbc(tax, "Percent"),
      netUnitPrice: cbc(cac(l, "Price"), "PriceAmount"),
    };
  });

  const document: ParsedInboundUbl = {
    documentType,
    customizationId: cbc(root, "CustomizationID"),
    profileId: cbc(root, "ProfileID"),
    invoiceNumber: cbc(root, "ID"),
    issueDate: cbc(root, "IssueDate"),
    dueDate: cbc(root, "DueDate") ?? cbc(pm, "PaymentDueDate"),
    typeCode: cbc(root, isCredit ? "CreditNoteTypeCode" : "InvoiceTypeCode"),
    currency: docCurrency,
    buyerReference: cbc(root, "BuyerReference"),
    orderReference: cbc(cac(root, "OrderReference"), "ID"),
    precedingInvoiceNumber: cbc(billingRef, "ID"),
    deliveryDate: cbc(cac(root, "Delivery"), "ActualDeliveryDate"),
    supplier: party(cac(root, "AccountingSupplierParty")),
    customer: party(cac(root, "AccountingCustomerParty")),
    paymentMeansCode: cbc(pm, "PaymentMeansCode"),
    paymentId: cbc(pm, "PaymentID"),
    payeeIban: cbc(payee, "ID"),
    payeeBic: cbc(cac(payee, "FinancialInstitutionBranch"), "ID"),
    vatTotal: cbc(taxTotal, "TaxAmount"),
    taxSubtotals: taxTotal
      ? children(taxTotal, NS.cac, "TaxSubtotal").map((st) => {
          const cat = cac(st, "TaxCategory");
          return {
            category: cbc(cat, "ID"),
            percent: cbc(cat, "Percent"),
            taxableAmount: cbc(st, "TaxableAmount"),
            taxAmount: cbc(st, "TaxAmount"),
            exemptionReasonCode: cbc(cat, "TaxExemptionReasonCode"),
          };
        })
      : [],
    totals: {
      lineExtension: cbc(totalsEl, "LineExtensionAmount"),
      taxExclusive: cbc(totalsEl, "TaxExclusiveAmount"),
      taxInclusive: cbc(totalsEl, "TaxInclusiveAmount"),
      prepaid: cbc(totalsEl, "PrepaidAmount"),
      rounding: cbc(totalsEl, "PayableRoundingAmount"),
      payable: cbc(totalsEl, "PayableAmount"),
    },
    lines,
  };

  // Povinné minimum pre koncept.
  if (!document.invoiceNumber) reviewReasons.push("MISSING_INVOICE_NUMBER");
  if (!isIsoDate(document.issueDate)) reviewReasons.push("INVALID_ISSUE_DATE");
  if (document.dueDate && !isIsoDate(document.dueDate)) reviewReasons.push("INVALID_DUE_DATE");
  if (!document.currency) reviewReasons.push("MISSING_CURRENCY");
  if (lines.length === 0) reviewReasons.push("NO_LINES");
  if (document.totals.prepaid && !new Decimal(document.totals.prepaid).eq(0)) reviewReasons.push("PREPAID_AMOUNT_NOT_MAPPED");

  // Číselné polia musia byť čísla — inak by sa neskôr ticho zmenili.
  const numeric: (string | null)[] = [
    document.vatTotal, ...Object.values(document.totals),
    ...lines.flatMap((l) => [l.quantity, l.lineNetAmount, l.netUnitPrice, l.vatPercent]),
    ...document.taxSubtotals.flatMap((t) => [t.taxableAmount, t.taxAmount, t.percent]),
  ];
  if (numeric.some((v) => v !== null && !AMOUNT.test(v))) {
    return { ok: false, error: "UBL_INVALID_NUMBER" };
  }

  // Aritmetika — iba kontrola.
  const d = (v: string | null) => new Decimal(v ?? "0");
  const lineSum = lines.reduce((acc, l) => acc.plus(d(l.lineNetAmount)), new Decimal(0));
  if (document.totals.lineExtension && !lineSum.eq(d(document.totals.lineExtension))) reviewReasons.push("LINE_SUM_MISMATCH");
  if (document.totals.taxExclusive && document.totals.taxInclusive &&
      !d(document.totals.taxExclusive).plus(d(document.vatTotal)).eq(d(document.totals.taxInclusive))) {
    reviewReasons.push("TAX_INCLUSIVE_MISMATCH");
  }
  if (document.totals.taxInclusive && document.totals.payable &&
      !d(document.totals.taxInclusive).minus(d(document.totals.prepaid)).plus(d(document.totals.rounding)).eq(d(document.totals.payable))) {
    reviewReasons.push("PAYABLE_MISMATCH");
  }
  const subtotalVat = document.taxSubtotals.reduce((acc, t) => acc.plus(d(t.taxAmount)), new Decimal(0));
  if (document.vatTotal && !subtotalVat.eq(d(document.vatTotal))) reviewReasons.push("VAT_BREAKDOWN_MISMATCH");

  return { ok: true, document, reviewReasons: [...new Set(reviewReasons)] };
}
