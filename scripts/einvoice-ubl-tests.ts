// =============================================================================
// E-Faktúra — jednotkové testy bez siete a bez databázy:
//   UBL generátor (lib/einvoice/ubl/generate.ts), parser prijatého UBL
//   (parse.ts), export (export.ts), overenie podpisu webhooku, mock provider,
//   eFaktura.sk skeleton a výber poskytovateľa z env.
//
// Všetky údaje sú syntetické. Nejde o validáciu voči XSD / Schematronu —
// tá vyžaduje oficiálne artefakty (TODO, pozri report).
// Spustenie: npm run test:einvoice-ubl
// =============================================================================

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { hasTranslation } from "../lib/i18n/translate.ts";
import { evaluateEinvoiceReadiness } from "../lib/einvoice/readiness.ts";
import { buildProvisionalSnapshot } from "../lib/einvoice/provisional-snapshot.ts";
import { DOMParser } from "@xmldom/xmldom";
import { generateUbl, checkUblPreconditions, PEPPOL_BIS3_CUSTOMIZATION_ID, PEPPOL_BIS3_PROFILE_ID } from "../lib/einvoice/ubl/generate.ts";
import { parseInboundUbl, MAX_INBOUND_XML_BYTES } from "../lib/einvoice/ubl/parse.ts";
import { NS } from "../lib/einvoice/ubl/xml.ts";
import type { UblInvoiceSnapshot, UblItem, UblParty, UblTaxBreakdown } from "../lib/einvoice/ubl/model.ts";
import { buildIssuedInvoiceUblExport, ublExportFileName } from "../lib/einvoice/export.ts";
import { verifyEfakturaWebhookSignature } from "../lib/einvoice/provider/efaktura-sk-webhook.ts";
import { MockEinvoiceProvider } from "../lib/einvoice/provider/mock.ts";
import {
  EfakturaSkProvider,
  assertEfakturaKeyMatchesEnvironment,
  buildEfakturaHeaders,
  mapEfakturaConnectorStatus,
  mapEfakturaSendState,
} from "../lib/einvoice/provider/efaktura-sk.ts";
import { getEfakturaWebhookSecrets, getEinvoiceProvider } from "../lib/einvoice/provider/index.ts";
import { EinvoiceProviderError } from "../lib/einvoice/provider/types.ts";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Syntetické fixtúry
// -----------------------------------------------------------------------------
const seller = (over: Partial<UblParty> = {}): UblParty => ({
  role: "seller", legal_name: "Syntetická A s.r.o.", ico: "11111111", dic: "2020000000", ic_dph: "SK2020000000",
  address_line1: "Testovacia 1", address_line2: null, city: "Bratislava", postal_code: "81101", country_code: "SK",
  iban: "SK3112000000198742637541", bic: "TESTSKBX", email: "fakturacia@example.test",
  electronic_address: "2020000000", electronic_address_scheme_id: "9950",
  legal_registration_id: "11111111", legal_registration_scheme_id: null, vat_identifier: null, ...over,
});
const buyer = (over: Partial<UblParty> = {}): UblParty => ({
  role: "buyer", legal_name: "Odberateľ s.r.o.", ico: "33333333", dic: "2040000000", ic_dph: "SK2040000000",
  address_line1: "Príkladná 3", address_line2: null, city: "Žilina", postal_code: "01001", country_code: "SK",
  iban: null, bic: null, email: null, electronic_address: "2040000000", electronic_address_scheme_id: "9950",
  legal_registration_id: "33333333", legal_registration_scheme_id: null, vat_identifier: null, ...over,
});
const item = (over: Partial<UblItem> = {}): UblItem => ({
  position: 1, description: "Práca", quantity: 2, unit_code: "HUR", unit_price: 50, price_mode: "net",
  vat_category_code: "S", vat_rate: 23, line_net_amount: 100, ...over,
});
const tax = (over: Partial<UblTaxBreakdown> = {}): UblTaxBreakdown => ({
  vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23,
  vat_exemption_reason_code: null, vat_exemption_reason_text: null, ...over,
});

/** Platiteľ DPH, dve sadzby (23 % a 19 %). */
function vatPayerSnapshot(): UblInvoiceSnapshot {
  return {
    invoice: {
      id: "f0000000-0000-4000-8000-000000000001", company_id: "a0000000-0000-4000-8000-000000000001",
      direction: "issued", kind: "regular_invoice", document_status: "finalized", invoice_number: "2026000001",
      issue_date: "2026-10-01", due_date: "2026-10-15", delivery_date: "2026-09-30", tax_point_date: null,
      currency: "EUR", subtotal_amount: 110, vat_total_amount: 24.9, total_amount: 134.9, rounding_amount: 0,
      buyer_reference: "OBJ-REF-1", purchase_order_reference: "PO-77", payment_means_code: "30",
      payment_reference: "2026000001", corrects_invoice_id: null,
    },
    seller: seller(),
    buyer: buyer(),
    items: [
      item(),
      item({ position: 2, description: "Materiál", quantity: 1, unit_code: "H87", unit_price: 10, vat_rate: 19, line_net_amount: 10 }),
    ],
    taxBreakdowns: [tax(), tax({ vat_rate: 19, taxable_amount: 10, vat_amount: 1.9 })],
    correctedInvoice: null,
  };
}
/** Neplatiteľ DPH — kategória O, bez IČ DPH predávajúceho. */
function nonVatPayerSnapshot(): UblInvoiceSnapshot {
  const s = vatPayerSnapshot();
  s.seller = seller({ ic_dph: null, vat_identifier: null, dic: "2020000000" });
  s.invoice = { ...s.invoice, subtotal_amount: 100, vat_total_amount: 0, total_amount: 100 };
  s.items = [item({ vat_category_code: "O", vat_rate: 0 })];
  s.taxBreakdowns = [tax({ vat_category_code: "O", vat_rate: 0, vat_amount: 0 })];
  return s;
}
function singleCategory(code: UblItem["vat_category_code"], extra: Partial<UblTaxBreakdown> = {}): UblInvoiceSnapshot {
  const s = vatPayerSnapshot();
  s.invoice = { ...s.invoice, subtotal_amount: 100, vat_total_amount: 0, total_amount: 100 };
  s.items = [item({ vat_category_code: code, vat_rate: 0 })];
  s.taxBreakdowns = [tax({ vat_category_code: code, vat_rate: 0, vat_amount: 0, ...extra })];
  return s;
}
function creditNoteSnapshot(): UblInvoiceSnapshot {
  const s = vatPayerSnapshot();
  s.invoice = { ...s.invoice, kind: "credit_note", invoice_number: "2026000002", corrects_invoice_id: "f0000000-0000-4000-8000-000000000009" };
  s.correctedInvoice = { invoice_number: "2026000001", issue_date: "2026-09-01" };
  return s;
}

function ok(s: UblInvoiceSnapshot) {
  const r = generateUbl(s);
  if (!r.ok) throw new Error(`očakávané ok, problémy: ${r.issues.map((i) => i.code).join(", ")}`);
  return r;
}
function issueCodes(s: UblInvoiceSnapshot): string[] {
  const r = generateUbl(s);
  if (r.ok) return [];
  return r.issues.map((i) => i.code);
}
function dom(xml: string) {
  return new DOMParser().parseFromString(xml, "text/xml");
}
function all(xml: string, ns: string, local: string): string[] {
  const list = dom(xml).getElementsByTagNameNS(ns, local);
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i].textContent ?? "");
  return out;
}

// =============================================================================
// UBL — štruktúra a fixtúry
// =============================================================================
await check("platiteľ DPH, dve sadzby: Invoice 380, Peppol BIS 3 ID, rozpis podľa sadzby, sumy", () => {
  const r = ok(vatPayerSnapshot());
  assert.equal(r.documentType, "Invoice");
  assert.ok(r.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Invoice '));
  assert.match(r.xml, /^[^\n]*\n<Invoice [^>]*xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/);
  assert.equal((r.xml.match(/xmlns:cbc=/g) ?? []).length, 1); // namespace iba raz na koreni
  assert.deepEqual(all(r.xml, NS.cbc, "CustomizationID"), [PEPPOL_BIS3_CUSTOMIZATION_ID]);
  assert.deepEqual(all(r.xml, NS.cbc, "ProfileID"), [PEPPOL_BIS3_PROFILE_ID]);
  assert.deepEqual(all(r.xml, NS.cbc, "InvoiceTypeCode"), ["380"]);
  assert.deepEqual(all(r.xml, NS.cbc, "DueDate"), ["2026-10-15"]);
  assert.deepEqual(all(r.xml, NS.cbc, "ActualDeliveryDate"), ["2026-09-30"]);
  assert.deepEqual(all(r.xml, NS.cbc, "TaxableAmount"), ["10.00", "100.00"]); // zoradené podľa sadzby
  assert.deepEqual(all(r.xml, NS.cbc, "PayableAmount"), ["134.90"]);
  assert.deepEqual(all(r.xml, NS.cbc, "TaxInclusiveAmount"), ["134.90"]);
  assert.match(r.xml, /<cbc:InvoicedQuantity unitCode="HUR">2<\/cbc:InvoicedQuantity>/);
  assert.match(r.xml, /<cbc:PaymentMeansCode>30<\/cbc:PaymentMeansCode>/);
  assert.match(r.xml, /<cac:PayeeFinancialAccount><cbc:ID>SK3112000000198742637541<\/cbc:ID>/);
  assert.match(r.xml, /<cac:PartyTaxScheme><cbc:CompanyID>SK2020000000<\/cbc:CompanyID>/);
  assert.equal(r.warnings.length, 0);
});

await check("poradie prvkov hlavičky zodpovedá UBL 2.1 Invoice", () => {
  const r = ok(vatPayerSnapshot());
  const root = dom(r.xml).documentElement!;
  const names: string[] = [];
  for (let n = root.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) names.push((n as unknown as { localName: string }).localName);
  const order = ["CustomizationID", "ProfileID", "ID", "IssueDate", "DueDate", "InvoiceTypeCode", "DocumentCurrencyCode",
    "BuyerReference", "OrderReference", "AccountingSupplierParty", "AccountingCustomerParty", "Delivery", "PaymentMeans",
    "TaxTotal", "LegalMonetaryTotal", "InvoiceLine", "InvoiceLine"];
  assert.deepEqual(names, order);
});

await check("neplatiteľ DPH (O): bez Percent, VATEX-EU-O, bez PartyTaxScheme predávajúceho", () => {
  const r = ok(nonVatPayerSnapshot());
  assert.doesNotMatch(r.xml, /<cbc:Percent>/);
  assert.deepEqual(all(r.xml, NS.cbc, "TaxExemptionReasonCode"), ["VATEX-EU-O"]);
  const supplier = r.xml.slice(r.xml.indexOf("<cac:AccountingSupplierParty>"), r.xml.indexOf("</cac:AccountingSupplierParty>"));
  assert.doesNotMatch(supplier, /PartyTaxScheme/);
});

await check("O: IČ DPH predávajúceho a mix s inou kategóriou sú blokované (BR-O-02 / BR-O-11)", () => {
  const withVat = nonVatPayerSnapshot();
  withVat.seller = seller();
  assert.ok(issueCodes(withVat).includes("O_WITH_SELLER_VAT_ID"));
  const mixed = vatPayerSnapshot();
  mixed.items = [mixed.items[0], item({ position: 2, vat_category_code: "O", vat_rate: 0, line_net_amount: 10, unit_price: 5 })];
  assert.ok(issueCodes(mixed).includes("O_MIXED_WITH_OTHER_CATEGORIES"));
});

await check("prenesenie daňovej povinnosti (AE): VATEX-EU-AE, Percent 0; bez IČ DPH kupujúceho blokované", () => {
  const r = ok(singleCategory("AE"));
  assert.deepEqual(all(r.xml, NS.cbc, "TaxExemptionReasonCode"), ["VATEX-EU-AE"]);
  assert.deepEqual(all(r.xml, NS.cbc, "Percent"), ["0", "0"]);
  const noBuyerVat = singleCategory("AE");
  noBuyerVat.buyer = buyer({ ic_dph: null, vat_identifier: null });
  assert.ok(issueCodes(noBuyerVat).includes("BUYER_VAT_ID_REQUIRED"));
});

await check("intrakomunitárne dodanie (K) → VATEX-EU-IC, vývoz (G) → VATEX-EU-G", () => {
  assert.deepEqual(all(ok(singleCategory("K")).xml, NS.cbc, "TaxExemptionReasonCode"), ["VATEX-EU-IC"]);
  assert.deepEqual(all(ok(singleCategory("G")).xml, NS.cbc, "TaxExemptionReasonCode"), ["VATEX-EU-G"]);
});

await check("oslobodenie (E): bez dôvodu blokované (BR-E-10), s dôvodom prejde bez hádania kódu", () => {
  assert.ok(issueCodes(singleCategory("E")).includes("E_EXEMPTION_REASON_MISSING"));
  const r = ok(singleCategory("E", { vat_exemption_reason_text: "Oslobodené podľa § 28 (syntetický text)" }));
  assert.deepEqual(all(r.xml, NS.cbc, "TaxExemptionReasonCode"), []);
  assert.deepEqual(all(r.xml, NS.cbc, "TaxExemptionReason"), ["Oslobodené podľa § 28 (syntetický text)"]);
});

await check("dobropis: CreditNote 381, BillingReference, CreditNoteLine, splatnosť v PaymentMeans", () => {
  const r = ok(creditNoteSnapshot());
  assert.equal(r.documentType, "CreditNote");
  assert.match(r.xml, /^<\?xml[^>]*\?>\n<CreditNote [^>]*xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/);
  assert.deepEqual(all(r.xml, NS.cbc, "CreditNoteTypeCode"), ["381"]);
  assert.match(r.xml, /<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>2026000001<\/cbc:ID><cbc:IssueDate>2026-09-01<\/cbc:IssueDate>/);
  assert.match(r.xml, /<cbc:CreditedQuantity unitCode="HUR">/);
  assert.match(r.xml, /<cbc:PaymentDueDate>2026-10-15<\/cbc:PaymentDueDate>/);
  assert.equal(all(r.xml, NS.cbc, "DueDate").length, 0);
  const noRef = creditNoteSnapshot();
  noRef.correctedInvoice = null;
  assert.ok(issueCodes(noRef).includes("MISSING_PRECEDING_INVOICE"));
});

await check("elektronické adresy: EndpointID so schemeID; chýbajúca adresa alebo schéma blokuje", () => {
  const r = ok(vatPayerSnapshot());
  assert.equal((r.xml.match(/<cbc:EndpointID schemeID="9950">/g) ?? []).length, 2);
  const noSeller = vatPayerSnapshot();
  noSeller.seller = seller({ electronic_address_scheme_id: null });
  const noBuyer = vatPayerSnapshot();
  noBuyer.buyer = buyer({ electronic_address: null });
  assert.ok(issueCodes(noSeller).includes("SELLER_MISSING_ENDPOINT"));
  assert.ok(issueCodes(noBuyer).includes("BUYER_MISSING_ENDPOINT"));
});

await check("ťarchopis: Invoice 383 s BillingReference", () => {
  const s = creditNoteSnapshot();
  s.invoice = { ...s.invoice, kind: "debit_note" };
  const r = ok(s);
  assert.deepEqual(all(r.xml, NS.cbc, "InvoiceTypeCode"), ["383"]);
});

// =============================================================================
// Escaping, neplatné znaky, determinizmus
// =============================================================================
await check("escaping: & < > \" ' v texte aj atribúte sa zakódujú a spätne prečítajú presne", () => {
  const s = vatPayerSnapshot();
  const tricky = `Odberateľ & Syn <"test"> 'x' ]]> ${"\u00e1\u017e"}`;
  s.buyer = buyer({ legal_name: tricky, electronic_address_scheme_id: `99"50` });
  s.invoice = { ...s.invoice, buyer_reference: "</cbc:BuyerReference><evil/>" };
  const r = ok(s);
  assert.doesNotMatch(r.xml, /<evil\/>/);
  assert.match(r.xml, /<cbc:BuyerReference>&lt;\/cbc:BuyerReference&gt;&lt;evil\/&gt;<\/cbc:BuyerReference>/);
  assert.match(r.xml, /schemeID="99&quot;50"/);
  assert.deepEqual(all(r.xml, NS.cbc, "BuyerReference"), ["</cbc:BuyerReference><evil/>"]);
  assert.ok(all(r.xml, NS.cbc, "RegistrationName").includes(tricky));
  const parsed = parseInboundUbl(r.xml);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.document.customer.name, tricky);
    assert.equal(parsed.document.customer.endpointScheme, `99"50`);
  }
});

await check("neplatný XML 1.0 znak sa neodstráni potichu — UBL sa nevygeneruje", () => {
  const s = vatPayerSnapshot();
  s.items = [item({ description: "Práca\u0001" }), s.items[1]];
  const r = generateUbl(s);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.issues.map((i) => i.code), ["INVALID_XML_CHARACTER"]);
});

await check("determinizmus: rovnaký vstup = rovnaké bajty a SHA-256; poradie vstupných polí nehrá rolu", () => {
  const a = ok(vatPayerSnapshot());
  const b = ok(vatPayerSnapshot());
  assert.equal(a.xml, b.xml);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, createHash("sha256").update(a.bytes).digest("hex"));
  assert.equal(new TextDecoder().decode(a.bytes), a.xml);
  const shuffled = vatPayerSnapshot();
  shuffled.items = [...shuffled.items].reverse();
  shuffled.taxBreakdowns = [...shuffled.taxBreakdowns].reverse();
  assert.equal(ok(shuffled).sha256, a.sha256);
  const changed = vatPayerSnapshot();
  changed.invoice = { ...changed.invoice, buyer_reference: "OBJ-REF-2" };
  assert.notEqual(ok(changed).sha256, a.sha256);
  assert.doesNotMatch(a.xml, /T\d\d:\d\d/); // žiadne časové pečiatky
});

await check("čísla ako text aj number dávajú rovnaký výstup (numeric z PostgREST)", () => {
  const s = vatPayerSnapshot();
  s.invoice = { ...s.invoice, subtotal_amount: "110.00", vat_total_amount: "24.90", total_amount: "134.90", rounding_amount: "0.00" };
  s.items = s.items.map((i) => ({ ...i, quantity: String(i.quantity), unit_price: `${i.unit_price}.0000`, line_net_amount: `${i.line_net_amount}.00` }));
  assert.equal(ok(s).sha256, ok(vatPayerSnapshot()).sha256);
});

// =============================================================================
// Fail-closed — nič sa neopraví
// =============================================================================
await check("fail-closed: každý chýbajúci / nesúladný údaj je problém, vstup ostane nezmenený", () => {
  const cases: Array<[string, (s: UblInvoiceSnapshot) => void]> = [
    ["NOT_FINALIZED", (s) => { s.invoice.document_status = "draft"; }],
    ["NOT_ISSUED", (s) => { s.invoice.direction = "received"; }],
    ["MISSING_INVOICE_NUMBER", (s) => { s.invoice.invoice_number = null; }],
    ["CURRENCY_UNSUPPORTED", (s) => { s.invoice.currency = "CZK"; }],
    ["MISSING_BUYER_OR_ORDER_REFERENCE", (s) => { s.invoice.buyer_reference = null; s.invoice.purchase_order_reference = " "; }],
    ["MISSING_DUE_DATE", (s) => { s.invoice.due_date = null; }],
    ["KIND_UNSUPPORTED", (s) => { s.invoice.kind = "payment_received_invoice"; }],
    ["SELLER_MISSING_NAME", (s) => { s.seller.legal_name = " "; }],
    ["BUYER_MISSING_COUNTRY", (s) => { s.buyer.country_code = "Slovensko"; }],
    ["SELLER_VAT_ID_REQUIRED", (s) => { s.seller.ic_dph = null; }],
    ["LINE_MISSING_UNIT_CODE", (s) => { s.items[0].unit_code = null; }],
    ["LINE_MISSING_UNIT_CODE", (s) => { s.items[0].unit_code = "hod"; }],
    ["LINE_S_RATE_NOT_POSITIVE", (s) => { s.items[0].vat_rate = 0; }],
    ["LINE_PRICE_NOT_REPRESENTABLE", (s) => { s.items[0].quantity = 3; s.items[0].unit_price = 33.33; }],
    ["LINE_SUM_MISMATCH", (s) => { s.invoice.subtotal_amount = 111; }],
    ["VAT_SUM_MISMATCH", (s) => { s.taxBreakdowns[0].vat_amount = 22; }],
    ["TOTAL_MISMATCH", (s) => { s.invoice.total_amount = 135; }],
    ["MISSING_PAYMENT_MEANS_CODE", (s) => { s.invoice.payment_means_code = null; }],
    ["NO_LINES", (s) => { s.items = []; }],
  ];
  for (const [code, mutate] of cases) {
    const s = vatPayerSnapshot();
    mutate(s);
    const before = structuredClone(s);
    const r = generateUbl(s);
    assert.equal(r.ok, false, code);
    if (!r.ok) assert.ok(r.issues.some((i) => i.code === code), `${code}: ${r.issues.map((i) => i.code).join(",")}`);
    assert.deepEqual(s, before, `${code}: vstup sa zmenil`);
  }
});

await check("bez IBAN a bez kódu úhrady prejde a PaymentMeans sa nevymyslí", () => {
  const s = vatPayerSnapshot();
  s.seller = seller({ iban: null, bic: null });
  s.invoice = { ...s.invoice, payment_means_code: null };
  const r = ok(s);
  assert.doesNotMatch(r.xml, /PaymentMeans/);
});

await check("cena s DPH (gross): čistá jednotková cena sa odvodí zo sumy riadka presne", () => {
  const s = vatPayerSnapshot();
  s.items = [item({ price_mode: "gross", unit_price: 61.5, quantity: 2, line_net_amount: 100 }), s.items[1]];
  const r = ok(s);
  assert.deepEqual(all(r.xml, NS.cbc, "PriceAmount"), ["50", "10"]);
});

await check("SK nadstavba: neúplná adresa je iba upozornenie; chýbajúci legal_registration_id pri SK IČO nevadí (BT-47 = IČO zo snapshotu)", () => {
  const s = vatPayerSnapshot();
  s.buyer = buyer({ address_line1: null, legal_registration_id: null, legal_registration_scheme_id: null });
  const r = ok(s);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ["SK_BUYER_ADDRESS_INCOMPLETE"]);
  assert.deepEqual(checkUblPreconditions(s).issues, []);
});

// =============================================================================
// Export
// =============================================================================
await check("export: názov súboru bez nebezpečných znakov, bajty + SHA-256 z generátora", () => {
  assert.equal(ublExportFileName("FA/2026 001", "id"), "FA_2026_001.xml");
  assert.equal(ublExportFileName("../../etc", "id"), "etc.xml");
  assert.equal(ublExportFileName(null, "f0000000-0000"), "f0000000-0000.xml");
  const e = buildIssuedInvoiceUblExport(vatPayerSnapshot());
  assert.equal(e.ok, true);
  if (e.ok) {
    assert.equal(e.file.fileName, "2026000001.xml");
    assert.equal(e.file.contentType, "application/xml");
    assert.equal(e.file.sha256, createHash("sha256").update(e.file.bytes).digest("hex"));
  }
  const bad = vatPayerSnapshot();
  bad.invoice.document_status = "draft";
  assert.equal(buildIssuedInvoiceUblExport(bad).ok, false);
});

// =============================================================================
// Parser prijatého UBL
// =============================================================================
await check("parser: round-trip vlastného UBL zachová polia a nemá dôvody na kontrolu", () => {
  const r = ok(vatPayerSnapshot());
  const p = parseInboundUbl(r.bytes);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const d = p.document;
  assert.equal(d.documentType, "Invoice");
  assert.equal(d.invoiceNumber, "2026000001");
  assert.equal(d.issueDate, "2026-10-01");
  assert.equal(d.dueDate, "2026-10-15");
  assert.equal(d.currency, "EUR");
  assert.equal(d.supplier.endpointId, "2020000000");
  assert.equal(d.supplier.endpointScheme, "9950");
  assert.equal(d.supplier.vatId, "SK2020000000");
  assert.equal(d.payeeIban, "SK3112000000198742637541");
  assert.equal(d.totals.payable, "134.90");
  assert.equal(d.lines.length, 2);
  assert.deepEqual(d.lines[0], { id: "1", quantity: "2", unitCode: "HUR", lineNetAmount: "100.00", name: "Práca", vatCategory: "S", vatPercent: "23", netUnitPrice: "50" });
  assert.deepEqual(p.reviewReasons, []);
});

await check("parser: dobropis sa rozpozná (CreditNote, splatnosť z PaymentMeans)", () => {
  const p = parseInboundUbl(ok(creditNoteSnapshot()).xml);
  assert.equal(p.ok, true);
  if (p.ok) {
    assert.equal(p.document.documentType, "CreditNote");
    assert.equal(p.document.precedingInvoiceNumber, "2026000001");
    assert.equal(p.document.dueDate, "2026-10-15");
  }
});

await check("parser: DOCTYPE / ENTITY / zlý root / poškodené XML / nie UTF-8 / príliš veľké sú odmietnuté", () => {
  const xml = ok(vatPayerSnapshot()).xml;
  const withDoctype = xml.replace("?>\n", '?>\n<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n');
  assert.deepEqual(parseInboundUbl(withDoctype), { ok: false, error: "UBL_DTD_NOT_ALLOWED" });
  assert.deepEqual(parseInboundUbl(xml.replace("<cbc:Note>", "").replace("</Invoice>", "<!ENTITY y 'z'></Invoice>")), { ok: false, error: "UBL_DTD_NOT_ALLOWED" });
  assert.deepEqual(parseInboundUbl('<?xml version="1.0"?><Order xmlns="urn:x"/>'), { ok: false, error: "UBL_UNSUPPORTED_ROOT" });
  assert.deepEqual(parseInboundUbl(xml.slice(0, xml.length - 20)), { ok: false, error: "UBL_MALFORMED" });
  assert.deepEqual(parseInboundUbl(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e])), { ok: false, error: "UBL_NOT_UTF8" });
  assert.deepEqual(parseInboundUbl(new Uint8Array(MAX_INBOUND_XML_BYTES + 1)), { ok: false, error: "UBL_TOO_LARGE" });
});

await check("parser: nečíselná suma je chyba (nie tichá konverzia)", () => {
  const xml = ok(vatPayerSnapshot()).xml.replace('<cbc:PayableAmount currencyID="EUR">134.90', '<cbc:PayableAmount currencyID="EUR">134,90');
  assert.deepEqual(parseInboundUbl(xml), { ok: false, error: "UBL_INVALID_NUMBER" });
});

await check("parser: nesúlad súm a nemapované zľavy/zálohy → dôvody na kontrolu, nič sa neopraví", () => {
  const base = ok(vatPayerSnapshot()).xml;
  const payable = parseInboundUbl(base.replace('<cbc:PayableAmount currencyID="EUR">134.90', '<cbc:PayableAmount currencyID="EUR">200.00'));
  assert.equal(payable.ok, true);
  if (payable.ok) {
    assert.ok(payable.reviewReasons.includes("PAYABLE_MISMATCH"));
    assert.equal(payable.document.totals.payable, "200.00");
  }
  const allowance = parseInboundUbl(base.replace("<cac:TaxTotal>",
    '<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="EUR">5.00</cbc:Amount></cac:AllowanceCharge><cac:TaxTotal>'));
  assert.equal(allowance.ok, true);
  if (allowance.ok) assert.ok(allowance.reviewReasons.includes("DOCUMENT_ALLOWANCE_CHARGE_NOT_MAPPED"));
  const prepaid = parseInboundUbl(base.replace("<cbc:PayableAmount", '<cbc:PrepaidAmount currencyID="EUR">10.00</cbc:PrepaidAmount><cbc:PayableAmount'));
  assert.equal(prepaid.ok, true);
  if (prepaid.ok) assert.ok(prepaid.reviewReasons.includes("PREPAID_AMOUNT_NOT_MAPPED"));
  const vat = parseInboundUbl(base.replace('<cbc:TaxAmount currencyID="EUR">24.90', '<cbc:TaxAmount currencyID="EUR">25.90'));
  assert.equal(vat.ok, true);
  if (vat.ok) assert.ok(vat.reviewReasons.includes("VAT_BREAKDOWN_MISMATCH"));
});

await check("parser: neznáme elementy sa ignorujú bez zmeny namapovaných hodnôt", () => {
  const base = ok(vatPayerSnapshot()).xml;
  const extended = base.replace("<cbc:DocumentCurrencyCode>",
    '<cbc:Note>poznámka</cbc:Note><x:Custom xmlns:x="urn:example:ext"><cbc:ID>999</cbc:ID></x:Custom><cbc:DocumentCurrencyCode>');
  const a = parseInboundUbl(base);
  const b = parseInboundUbl(extended);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) {
    assert.deepEqual(b.document, a.document);
    assert.deepEqual(b.reviewReasons, []);
  }
});

// =============================================================================
// Webhook podpis
// =============================================================================
const SECRET = "whsec_synthetic_" + "s".repeat(24);
const sign = (t: number, body: string, secret = SECRET) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const BODY = '{"event":"document.received","id":"evt_1"}';
const NOW = 1_790_000_000;

await check("webhook: platný podpis prejde, zmenené telo / zlé tajomstvo nie", () => {
  assert.deepEqual(verifyEfakturaWebhookSignature({ rawBody: BODY, signatureHeader: `t=${NOW},v1=${sign(NOW, BODY)}`, secrets: [SECRET], nowSeconds: NOW }), { ok: true, timestamp: NOW });
  assert.deepEqual(
    verifyEfakturaWebhookSignature({ rawBody: BODY + " ", signatureHeader: `t=${NOW},v1=${sign(NOW, BODY)}`, secrets: [SECRET], nowSeconds: NOW }),
    { ok: false, reason: "SIGNATURE_MISMATCH" }
  );
  assert.deepEqual(
    verifyEfakturaWebhookSignature({ rawBody: BODY, signatureHeader: `t=${NOW},v1=${sign(NOW, BODY, "other")}`, secrets: [SECRET], nowSeconds: NOW }),
    { ok: false, reason: "SIGNATURE_MISMATCH" }
  );
  // podpis inej pečiatky (replay s prepísaným t) nesedí
  assert.deepEqual(
    verifyEfakturaWebhookSignature({ rawBody: BODY, signatureHeader: `t=${NOW + 1},v1=${sign(NOW, BODY)}`, secrets: [SECRET], nowSeconds: NOW }),
    { ok: false, reason: "SIGNATURE_MISMATCH" }
  );
});

await check("webhook: stará / budúca pečiatka, chýbajúca / zlá hlavička, žiadne tajomstvo", () => {
  const v = (header: string | null, now = NOW, secrets = [SECRET]) =>
    verifyEfakturaWebhookSignature({ rawBody: BODY, signatureHeader: header, secrets, nowSeconds: now });
  assert.deepEqual(v(`t=${NOW},v1=${sign(NOW, BODY)}`, NOW + 301), { ok: false, reason: "STALE_TIMESTAMP" });
  assert.deepEqual(v(`t=${NOW},v1=${sign(NOW, BODY)}`, NOW + 300), { ok: true, timestamp: NOW });
  assert.deepEqual(v(`t=${NOW + 400},v1=${sign(NOW + 400, BODY)}`), { ok: false, reason: "FUTURE_TIMESTAMP" });
  assert.deepEqual(v(null), { ok: false, reason: "MISSING_HEADER" });
  assert.deepEqual(v(`v1=${sign(NOW, BODY)}`), { ok: false, reason: "MALFORMED_HEADER" });
  assert.deepEqual(v(`t=abc,v1=${sign(NOW, BODY)}`), { ok: false, reason: "MALFORMED_HEADER" });
  assert.deepEqual(v(`t=${NOW},v1=XYZ`), { ok: false, reason: "MALFORMED_HEADER" });
  assert.deepEqual(v(`t=${NOW},v1=${sign(NOW, BODY)}`, NOW, []), { ok: false, reason: "NO_SECRET" });
  assert.deepEqual(v(`t=${NOW},v1=${sign(NOW, BODY)}`, NOW, [""]), { ok: false, reason: "NO_SECRET" });
});

await check("webhook: rotácia — viac v1 aj viac tajomstiev, stačí jedna zhoda; bajty tela sa overujú presne", () => {
  const header = `t=${NOW},v1=${"0".repeat(64)},v1=${sign(NOW, BODY, "new-secret")}`;
  assert.equal(verifyEfakturaWebhookSignature({ rawBody: BODY, signatureHeader: header, secrets: [SECRET, "new-secret"], nowSeconds: NOW }).ok, true);
  const bytes = new TextEncoder().encode(BODY);
  assert.equal(verifyEfakturaWebhookSignature({ rawBody: bytes, signatureHeader: `t=${NOW},v1=${sign(NOW, BODY)}`, secrets: [SECRET], nowSeconds: NOW }).ok, true);
});

// =============================================================================
// Mock provider
// =============================================================================
const orgInput = { environment: "sandbox" as const, legalName: "Syntetická A", ico: "11111111", dic: "2020000000", icDph: "SK2020000000",
  address: { street: "Testovacia 1", city: "Bratislava", postalCode: "81101", countryCode: "SK" } };

await check("mock: založenie organizácie je idempotentné podľa IČO, participant 9915: v sandboxe", async () => {
  const p = new MockEinvoiceProvider();
  const a = await p.provisionOrganization(orgInput);
  const b = await p.provisionOrganization(orgInput);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(a.providerOrgId, b.providerOrgId);
  assert.equal(a.participantId, "9915:2020000000");
  assert.equal(a.peppolEligible, true);
  const noDic = await p.provisionOrganization({ ...orgInput, ico: "22222222", dic: "123" });
  assert.equal(noDic.peppolEligible, false);
  assert.equal(noDic.participantId, null);
  const live = await p.provisionOrganization({ ...orgInput, environment: "live" });
  assert.notEqual(live.providerOrgId, a.providerOrgId);
  assert.equal(live.participantId, "0245:2020000000");
});

await check("mock: odoslanie s rovnakým kľúčom a UBL = ten istý výsledok; iný UBL = konflikt", async () => {
  const p = new MockEinvoiceProvider();
  const org = await p.provisionOrganization(orgInput);
  const ctx = { environment: "sandbox" as const, providerOrgId: org.providerOrgId };
  const r = ok(vatPayerSnapshot());
  const key = "esblu-out-f00000000000400080000000000000001-1";
  const first = await p.sendUbl(ctx, { idempotencyKey: key, ubl: r.bytes, ublSha256: r.sha256, receiverParticipantId: "9915:2040000000" });
  const second = await p.sendUbl(ctx, { idempotencyKey: key, ubl: r.bytes, ublSha256: r.sha256, receiverParticipantId: "9915:2040000000" });
  assert.equal(first.providerSubmissionId, second.providerSubmissionId);
  const other = ok(creditNoteSnapshot());
  await assert.rejects(
    p.sendUbl(ctx, { idempotencyKey: key, ubl: other.bytes, ublSha256: other.sha256, receiverParticipantId: "9915:2040000000" }),
    (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_IDEMPOTENCY_CONFLICT"
  );
  await assert.rejects(
    p.sendUbl(ctx, { idempotencyKey: "esblu-out-other-key-000001", ubl: r.bytes, ublSha256: "0".repeat(64), receiverParticipantId: "9915:2040000000" }),
    (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_UBL_HASH_MISMATCH"
  );
  await assert.rejects(
    p.sendUbl(ctx, { idempotencyKey: "short", ubl: r.bytes, ublSha256: r.sha256, receiverParticipantId: "9915:2040000000" }),
    (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_IDEMPOTENCY_KEY_INVALID"
  );
  p.setSubmissionState(first.providerSubmissionId, "delivered");
  const status = await p.getOutboundStatus(ctx, { providerSubmissionId: first.providerSubmissionId });
  assert.equal(status.state, "delivered");
  const evidence = await p.getDeliveryEvidence(ctx, { providerSubmissionId: first.providerSubmissionId });
  assert.equal(evidence?.ublSha256, r.sha256);
});

await check("mock: cudzia organizácia nevidí podanie ani prijaté doklady (org scope)", async () => {
  const p = new MockEinvoiceProvider();
  const a = await p.provisionOrganization(orgInput);
  const b = await p.provisionOrganization({ ...orgInput, ico: "44444444", dic: "2050000000" });
  const ctxA = { environment: "sandbox" as const, providerOrgId: a.providerOrgId };
  const ctxB = { environment: "sandbox" as const, providerOrgId: b.providerOrgId };
  const r = ok(vatPayerSnapshot());
  const sent = await p.sendUbl(ctxA, { idempotencyKey: "esblu-out-scope-test-000001", ubl: r.bytes, ublSha256: r.sha256, receiverParticipantId: "9915:x" });
  await assert.rejects(p.getOutboundStatus(ctxB, { providerSubmissionId: sent.providerSubmissionId }), /EINVOICE_SUBMISSION_NOT_FOUND/);
  await assert.rejects(
    p.sendUbl(ctxB, { idempotencyKey: "esblu-out-scope-test-000001", ubl: r.bytes, ublSha256: r.sha256, receiverParticipantId: "9915:x" }),
    /EINVOICE_IDEMPOTENCY_CONFLICT/
  );
  await assert.rejects(p.getOrganization({ environment: "sandbox", providerOrgId: "nope" }), /EINVOICE_ORGANIZATION_NOT_FOUND/);
  p.addInbound(ctxA, { providerReceivedId: "rcv-1", senderParticipantId: "9915:x", senderIco: null, documentNumber: "IN-1", documentType: "Invoice", receivedAt: null, isTest: true }, r.bytes);
  assert.equal((await p.listUnacknowledgedInbound(ctxA)).length, 1);
  assert.equal((await p.listUnacknowledgedInbound(ctxB)).length, 0);
  await assert.rejects(p.getInboundDocument(ctxB, "rcv-1"), /EINVOICE_INBOUND_NOT_FOUND/);
  await assert.rejects(p.acknowledgeInbound(ctxB, "rcv-1"), /EINVOICE_INBOUND_NOT_FOUND/);
  await p.acknowledgeInbound(ctxA, "rcv-1");
  await p.acknowledgeInbound(ctxA, "rcv-1"); // idempotentné
  assert.equal((await p.listUnacknowledgedInbound(ctxA)).length, 0);
});

const legalEntities = (xml: string): Array<{ id: string | null; scheme: string | null }> => {
  const list = dom(xml).getElementsByTagNameNS(NS.cac, "PartyLegalEntity");
  const out: Array<{ id: string | null; scheme: string | null }> = [];
  for (let i = 0; i < list.length; i++) {
    const id = list[i].getElementsByTagNameNS(NS.cbc, "CompanyID")[0];
    out.push({ id: id ? id.textContent : null, scheme: id ? id.getAttribute("schemeID") || null : null });
  }
  return out;
};

await check("BT-30/BT-47: SK strana → CompanyID = IČO zo snapshotu, schemeID 0158 (vždy); mimo SK iba explicitné údaje", () => {
  const s = vatPayerSnapshot();
  s.seller = seller({ legal_registration_id: null, legal_registration_scheme_id: null });
  s.buyer = buyer({ legal_registration_id: "", legal_registration_scheme_id: "" });
  assert.deepEqual(legalEntities(ok(s).xml), [{ id: "11111111", scheme: "0158" }, { id: "33333333", scheme: "0158" }]);
  // explicitná schéma 0158 a zhodné registračné číslo sú v poriadku
  const explicit = vatPayerSnapshot();
  explicit.seller = seller({ legal_registration_id: "11 111 111", legal_registration_scheme_id: "0158" });
  assert.deepEqual(legalEntities(ok(explicit).xml)[0], { id: "11111111", scheme: "0158" });
  // zahraničný kupujúci: nič sa nedopĺňa ani nehádá
  const foreign = vatPayerSnapshot();
  foreign.buyer = buyer({ country_code: "CZ", ico: null, legal_registration_id: "CZ-REG-1", legal_registration_scheme_id: null });
  assert.deepEqual(legalEntities(ok(foreign).xml), [{ id: "11111111", scheme: "0158" }, { id: "CZ-REG-1", scheme: null }]);
  const foreignNone = vatPayerSnapshot();
  foreignNone.buyer = buyer({ country_code: "CZ", ico: null, legal_registration_id: null });
  assert.deepEqual(legalEntities(ok(foreignNone).xml)[1], { id: null, scheme: null });
});

await check("BT-30/BT-47: chýbajúce alebo neplatné SK IČO = TVRDÝ BLOK (nie upozornenie), pre dodávateľa aj odberateľa", () => {
  for (const ico of [null, "", "1234567", "123456789", "ABCDEFGH"]) {
    const s = vatPayerSnapshot();
    s.seller = seller({ ico, legal_registration_id: null });
    const r = generateUbl(s);
    assert.equal(r.ok, false, String(ico));
    if (!r.ok) assert.ok(r.issues.some((i) => i.code === "SELLER_MISSING_ICO"), String(ico));
    assert.ok(!r.warnings.some((w) => w.code.includes("ICO")), "nesmie byť iba upozornenie");
  }
  const b = vatPayerSnapshot();
  b.buyer = buyer({ ico: null, legal_registration_id: null });
  const rb = generateUbl(b);
  assert.equal(rb.ok, false);
  if (!rb.ok) assert.deepEqual(rb.issues.map((i) => i.code), ["BUYER_MISSING_ICO"]);
  // IČO sa NEdoplní z legal_registration_id ani nevyplní nulami
  const guessed = vatPayerSnapshot();
  guessed.buyer = buyer({ ico: null, legal_registration_id: "33333333" });
  assert.equal(generateUbl(guessed).ok, false);
});

await check("BT-30/BT-47: konflikt IČO vs. registračné číslo alebo iná schéma ako 0158 = blok (nič sa potichu neprepíše)", () => {
  const mismatch = vatPayerSnapshot();
  mismatch.buyer = buyer({ legal_registration_id: "99999999" });
  const r1 = generateUbl(mismatch);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.deepEqual(r1.issues.map((i) => i.code), ["BUYER_LEGAL_ID_ICO_MISMATCH"]);
  const scheme = vatPayerSnapshot();
  scheme.seller = seller({ legal_registration_scheme_id: "0245" });
  const r2 = generateUbl(scheme);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.deepEqual(r2.issues, [{ code: "SELLER_LEGAL_SCHEME_CONFLICT", rule: "SK-BT-30 (BT-30, schemeID 0158)", params: { scheme: "0245" } }]);
});

await check("BT-47 po finalizácii: UBL sa riadi IBA snapshotom faktúry (invoice_parties), nie aktuálnym partnerom", () => {
  // Generátor nemá prístup k business_partners — vstup je výlučne snapshot.
  const before = ok(vatPayerSnapshot());
  const snap = vatPayerSnapshot();
  const after = ok(snap);
  assert.equal(before.sha256, after.sha256);
  assert.ok(!/business_partners|peppol_identifier/.test(readFileSync(new URL("../lib/einvoice/ubl/generate.ts", import.meta.url), "utf8")));
});

await check("výsledok kontroly je strojovo čitateľný: iba code / rule / params, žiadny hotový text", () => {
  const s = vatPayerSnapshot();
  s.invoice = { ...s.invoice, invoice_number: null, buyer_reference: null, purchase_order_reference: null };
  s.items = [item({ unit_code: null }), s.items[1]];
  const { issues } = checkUblPreconditions(s);
  assert.ok(issues.length >= 3);
  for (const issue of issues) {
    assert.deepEqual(Object.keys(issue).filter((k) => !["code", "rule", "params"].includes(k)), [], issue.code);
    assert.match(issue.code, /^[A-Z0-9_]+$/);
  }
  assert.deepEqual(issues.find((i) => i.code === "LINE_MISSING_UNIT_CODE")?.params, { position: 1 });
});

await check("i18n: každý kód z generátora a readiness má preklad v sk / en / de", () => {
  const sources = ["../lib/einvoice/ubl/generate.ts", "../lib/einvoice/readiness.ts"]
    .map((f) => readFileSync(new URL(f, import.meta.url), "utf8"))
    .join("\n");
  const codes = new Set<string>();
  for (const m of sources.matchAll(/(?:add|warn)\(\s*[`"]([A-Z0-9_${}]+)[`"]/g)) codes.add(m[1]);
  for (const m of sources.matchAll(/code: "([A-Z0-9_]+)"/g)) codes.add(m[1]);
  const expanded = new Set<string>();
  for (const code of codes) {
    if (code.includes("${P}")) {
      expanded.add(code.replace("${P}", "SELLER"));
      expanded.add(code.replace("${P}", "BUYER"));
    } else expanded.add(code);
  }
  assert.ok(expanded.size >= 40, `nájdených kódov: ${expanded.size}`);
  for (const locale of ["sk", "en", "de"] as const) {
    for (const code of expanded) {
      assert.ok(hasTranslation(locale, `invoices.einvoice.issues.${code}`), `${locale}: ${code}`);
    }
  }
});

// =============================================================================
// eFaktura.sk skeleton + výber poskytovateľa
// =============================================================================
const FAKE_TEST_KEY = "efk_pk_test_" + "0".repeat(24); // syntetický, nikdy skutočný

await check("eFaktura: kľúč musí zodpovedať prostrediu, kľúč sa neprezradí v JSON", () => {
  assert.doesNotThrow(() => assertEfakturaKeyMatchesEnvironment(FAKE_TEST_KEY, "sandbox"));
  assert.throws(() => assertEfakturaKeyMatchesEnvironment(FAKE_TEST_KEY, "live"), /EINVOICE_KEY_ENVIRONMENT_MISMATCH|nezodpovedá/);
  assert.throws(() => new EfakturaSkProvider({ apiKey: "efk_pk_live_" + "1".repeat(24), environment: "sandbox" }));
  assert.throws(() => new EfakturaSkProvider({ apiKey: "", environment: "sandbox" }));
  const p = new EfakturaSkProvider({ apiKey: FAKE_TEST_KEY, environment: "sandbox" });
  assert.doesNotMatch(JSON.stringify(p), /efk_pk_/);
  assert.doesNotMatch(JSON.stringify({ p }), /efk_pk_/);
});

// Sieťové operácie adaptéra (fake fetch, bez siete): scripts/einvoice-efaktura-adapter-tests.ts
await check("eFaktura: lokálne kontroly vstupu zlyhajú PRED akýmkoľvek sieťovým volaním", async () => {
  let calls = 0;
  const p = new EfakturaSkProvider({
    apiKey: FAKE_TEST_KEY,
    environment: "sandbox",
    fetchImpl: async () => { calls++; throw new Error("sieť je v tomto teste zakázaná"); },
  });
  const ctx = { environment: "sandbox" as const, providerOrgId: "org" };
  await assert.rejects(p.provisionOrganization({ ...orgInput, environment: "live" }), (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_ENVIRONMENT_MISMATCH");
  await assert.rejects(p.verifyRecipient(ctx, "9915:x y"), (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_INVALID_PARTICIPANT");
  await assert.rejects(p.preflight(ctx, { ubl: new Uint8Array(0) }), (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_INVALID_INPUT");
  await assert.rejects(p.sendUbl(ctx, { idempotencyKey: "short", ubl: new Uint8Array(1), ublSha256: "0".repeat(64) }), (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_INVALID_IDEMPOTENCY_KEY");
  await assert.rejects(p.sendUbl(ctx, { idempotencyKey: "k".repeat(16), ubl: new Uint8Array(1), ublSha256: "0".repeat(64) }), (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_UBL_HASH_MISMATCH");
  await assert.rejects(p.getOutboundStatus(ctx, { providerSubmissionId: "../x" }), (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_INVALID_ID");
  await assert.rejects(p.getInboundDocument({ environment: "live", providerOrgId: "org" }, "r"), (e: unknown) => e instanceof EinvoiceProviderError && e.code === "EINVOICE_ENVIRONMENT_MISMATCH");
  assert.equal(calls, 0);
});

await check("eFaktura: hlavičky a mapovanie zdokumentovaných stavov; neznámy stav = null", () => {
  assert.deepEqual(buildEfakturaHeaders({ apiKey: FAKE_TEST_KEY, providerOrgId: "org_1", idempotencyKey: "idem-key-0000000001", contentType: "application/xml" }), {
    "X-API-Key": FAKE_TEST_KEY, Accept: "application/json", "X-Organization-Id": "org_1", "Idempotency-Key": "idem-key-0000000001", "Content-Type": "application/xml",
  });
  assert.deepEqual(Object.keys(buildEfakturaHeaders({ apiKey: FAKE_TEST_KEY })), ["X-API-Key", "Accept"]);
  assert.equal(mapEfakturaSendState("DELIVERED"), "delivered");
  assert.equal(mapEfakturaSendState("ERROR"), "failed");
  assert.equal(mapEfakturaSendState("DEFERRED"), "deferred");
  assert.equal(mapEfakturaSendState("delivered"), null);
  assert.equal(mapEfakturaSendState("SOMETHING_NEW"), null);
  assert.equal(mapEfakturaConnectorStatus("staged"), "staged");
  assert.equal(mapEfakturaConnectorStatus("rejected"), "rejected");
  assert.equal(mapEfakturaConnectorStatus("weird"), null);
});

await check("výber poskytovateľa: bez env → null (žiadny mock fallback); iba efaktura_sk so správnym kľúčom", () => {
  assert.equal(getEinvoiceProvider({}), null);
  assert.equal(getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "mock", ESBLU_EINVOICE_ENVIRONMENT: "sandbox" }), null);
  assert.equal(getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox" }), null);
  assert.equal(getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "staging", ESBLU_EFAKTURA_API_KEY: FAKE_TEST_KEY }), null);
  const cfg = getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox", ESBLU_EFAKTURA_API_KEY: FAKE_TEST_KEY });
  assert.equal(cfg?.environment, "sandbox");
  assert.equal(cfg?.provider.name, "efaktura_sk");
  assert.throws(() => getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "live", ESBLU_EFAKTURA_API_KEY: FAKE_TEST_KEY }));
  assert.deepEqual(getEfakturaWebhookSecrets({ ESBLU_EFAKTURA_WEBHOOK_SECRETS: " a , ,b" }), ["a", "b"]);
  assert.deepEqual(getEfakturaWebhookSecrets({}), []);
});

await check("tajomstvá nie sú v NEXT_PUBLIC_* ani v klientských súboroch", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk(path.join(root, "lib/einvoice"));
  walk(path.join(root, "app/api/invoices"));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /NEXT_PUBLIC_[A-Z_]*(EINVOICE|EFAKTURA)/, f);
    assert.doesNotMatch(src, /efk_pk_(test|live)_[A-Za-z0-9]{8,}/, f);
    assert.doesNotMatch(src, /^["']use client["']/m, f);
  }
  const detail = readFileSync(path.join(root, "app/faktury/InvoiceDetailView.tsx"), "utf8");
  assert.doesNotMatch(detail, /lib\/einvoice\/provider/);
});

// =============================================================================
// Readiness (pred finalizáciou / pred odoslaním) — čistá funkcia
// =============================================================================
const ORG_OK = { participantId: "9950:2020000000", peppolEligible: true };
const READY_ALL = { financeManage: true, einvoiceEntitlement: true, providerConfigured: true, organization: ORG_OK };
const rcodes = (r: ReturnType<typeof evaluateEinvoiceReadiness>) => r.issues.map((i) => i.code);

await check("readiness: kompletná finalizovaná faktúra + oprávnenie + nárok + organizácia → ready", () => {
  const r = evaluateEinvoiceReadiness({ ...READY_ALL, mode: "pre_send", snapshot: vatPayerSnapshot() });
  assert.equal(r.ready, true, JSON.stringify(r.issues));
  assert.deepEqual(r.issues, []);
});

await check("readiness: chýbajúci nárok einvoice a finance.manage blokujú (aj keď je doklad v poriadku)", () => {
  const r = evaluateEinvoiceReadiness({ ...READY_ALL, financeManage: false, einvoiceEntitlement: false, mode: "pre_send", snapshot: vatPayerSnapshot() });
  assert.equal(r.ready, false);
  assert.deepEqual(rcodes(r), ["FINANCE_MANAGE_REQUIRED", "EINVOICE_ENTITLEMENT_REQUIRED"]);
  assert.deepEqual(r.issues.map((i) => i.category), ["access", "entitlement"]);
});

await check("readiness: organizácia nepripravená / chýba / iný participant ako BT-34 predávajúceho → blok", () => {
  for (const organization of [null, { participantId: null, peppolEligible: true }, { participantId: "9950:2020000000", peppolEligible: false }]) {
    assert.deepEqual(rcodes(evaluateEinvoiceReadiness({ ...READY_ALL, organization, mode: "pre_send", snapshot: vatPayerSnapshot() })), ["ORGANIZATION_NOT_READY"]);
  }
  const r = evaluateEinvoiceReadiness({ ...READY_ALL, organization: { participantId: "9915:2020000000", peppolEligible: true }, mode: "pre_send", snapshot: vatPayerSnapshot() });
  assert.deepEqual(rcodes(r), ["SELLER_ENDPOINT_MISMATCH"]);
});

await check("readiness: chýbajúca konfigurácia poskytovateľa blokuje iba odoslanie (pre_send), nie kontrolu konceptu", () => {
  assert.deepEqual(rcodes(evaluateEinvoiceReadiness({ ...READY_ALL, providerConfigured: false, mode: "pre_send", snapshot: vatPayerSnapshot() })), ["PROVIDER_NOT_CONFIGURED"]);
  const draft = vatPayerSnapshot();
  draft.invoice = { ...draft.invoice, document_status: "draft", invoice_number: null };
  assert.deepEqual(rcodes(evaluateEinvoiceReadiness({ ...READY_ALL, providerConfigured: false, mode: "pre_finalize", snapshot: draft })), []);
});

await check("readiness: chýbajúce IČO, EN16931 polia, endpoint a nesediace sumy sú tvrdý blok (machine codes)", () => {
  const s = vatPayerSnapshot();
  s.seller = seller({ ico: null, legal_registration_id: null });
  s.buyer = buyer({ electronic_address: null });
  s.invoice = { ...s.invoice, buyer_reference: null, purchase_order_reference: null, total_amount: 999 };
  const r = evaluateEinvoiceReadiness({ ...READY_ALL, mode: "pre_send", snapshot: s });
  assert.equal(r.ready, false);
  for (const code of ["SELLER_MISSING_ICO", "BUYER_MISSING_ENDPOINT", "MISSING_BUYER_OR_ORDER_REFERENCE", "TOTAL_MISMATCH"]) {
    assert.ok(rcodes(r).includes(code), code);
  }
  for (const issue of r.issues) assert.equal(issue.category, "document");
});

await check("provisional snapshot: predávajúci z profilu, kupujúci z partnera, sumy z VAT enginu (pre_finalize)", () => {
  const snap = buildProvisionalSnapshot({
    invoice: {
      id: "f0000000-0000-4000-8000-000000000003", company_id: "a0000000-0000-4000-8000-000000000001", direction: "issued",
      kind: "regular_invoice", document_status: "draft", invoice_number: null, issue_date: "2026-10-01", due_date: "2026-10-15",
      delivery_date: null, tax_point_date: null, currency: "EUR", rounding_amount: 0, buyer_reference: "REF",
      purchase_order_reference: null, payment_means_code: "30", payment_reference: null, corrects_invoice_id: null,
    },
    items: [
      { position: 1, description: "Práca", quantity: 2, unit_code: "HUR", unit_price: 50, price_mode: "net", vat_category_code: "S", vat_rate: 23 },
      { position: 2, description: "Materiál", quantity: 1, unit_code: "H87", unit_price: 10, price_mode: "net", vat_category_code: "S", vat_rate: 19 },
    ],
    profile: { ...seller(), contact_email: "fakturacia@example.test" },
    partner: { ...buyer(), email: null },
  });
  assert.equal(snap.seller.role, "seller");
  assert.equal(snap.seller.ico, "11111111");
  assert.equal(snap.buyer.ico, "33333333");
  assert.equal(String(snap.invoice.subtotal_amount), "110.00");
  assert.equal(String(snap.invoice.total_amount), "134.90");
  const r = evaluateEinvoiceReadiness({ ...READY_ALL, mode: "pre_finalize", snapshot: snap });
  assert.deepEqual(rcodes(r), []);
  // bez partnera (kupujúci) → blok, nič sa nevymyslí
  const noPartner = buildProvisionalSnapshot({ invoice: snap.invoice as never, items: [], profile: null, partner: null });
  const r2 = evaluateEinvoiceReadiness({ ...READY_ALL, mode: "pre_finalize", snapshot: noPartner });
  for (const code of ["SELLER_MISSING_NAME", "BUYER_MISSING_NAME", "NO_LINES"]) assert.ok(rcodes(r2).includes(code), code);
});

await check("server vrstva E-Faktúry: server-only, user-scoped klient, žiadny service_role ani vlastný auth klient", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  for (const f of [
    "../lib/einvoice/provider/index.ts", "../lib/einvoice/provider/efaktura-sk.ts", "../lib/einvoice/provider/efaktura-sk-webhook.ts",
    "../lib/einvoice/load-finalized-invoice.ts", "../lib/einvoice/readiness-server.ts",
    "../app/api/invoices/[id]/ubl/route.ts", "../app/api/invoices/[id]/einvoice-readiness/route.ts",
  ]) {
    const src = read(f);
    assert.match(src, /^import "server-only";/, f);
    assert.doesNotMatch(src, /SERVICE_ROLE|service_role_key|getSupabaseAdmin|supabase-admin/, f);
    assert.doesNotMatch(src, /NEXT_PUBLIC_[A-Z_]*(EFAKTURA|EINVOICE)/, f);
  }
  for (const f of ["../app/api/invoices/[id]/ubl/route.ts", "../app/api/invoices/[id]/einvoice-readiness/route.ts"]) {
    const src = read(f);
    assert.match(src, /getUserScopedSupabaseClient/, f);
    assert.doesNotMatch(src, /createClient\(/, f);
  }
  // Klientský bundle nesmie importovať poskytovateľa.
  assert.doesNotMatch(read("../app/faktury/InvoiceDetailView.tsx"), /lib\/einvoice\/(provider|readiness-server)/);
});

console.log(`\neinvoice-ubl: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
