// =============================================================================
// Fakturácia — end-to-end tok po audite (20261008100005), offline PGlite so všetkými migráciami.
// Prijaté opravné doklady (Peppol UBL → mapovanie → DB review), úhrady a saldo, zálohy.
// SYNTETICKÉ UBL doklady (nie od poskytovateľa) — reálny tok poskytovateľa pokrýva sandbox E2E.
// npm run test:invoicing-flow
// =============================================================================
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPartnerHarness, type Row } from "./einvoice-partner-harness.ts";
import { parseInboundUbl } from "../lib/einvoice/ubl/parse.ts";
import { mapInboundDraft } from "../lib/einvoice/inbound/mapping.ts";

let passed = 0;
const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  ✗ ${label}\n    ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
}

const h = await createPartnerHarness();
const CO = { A: "c6a00000-0000-4000-8000-00000000000a", B: "c6a00000-0000-4000-8000-00000000000b" };
const U = {
  owner: "a6a00000-0000-4000-8000-000000000001", employee: "a6a00000-0000-4000-8000-000000000002",
  ownerB: "a6a00000-0000-4000-8000-000000000003", accountant: "a6a00000-0000-4000-8000-000000000004",
};
const P = { cust: "b6a00000-0000-4000-8000-000000000001", other: "b6a00000-0000-4000-8000-000000000002", custB: "b6a00000-0000-4000-8000-000000000003" };
await h.exec(`
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into public.companies (id, name) values ('${CO.A}', 'A'), ('${CO.B}', 'B');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CO.A}', '${U.owner}', 'owner', '{}'), ('${CO.A}', '${U.employee}', 'employee', '{"finance":{"view":true,"manage":true}}'),
    ('${CO.A}', '${U.accountant}', 'accountant', '{}'), ('${CO.B}', '${U.ownerB}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code, iban, vat_payer_status)
    values ('${CO.A}', 'Odberateľ A s.r.o.', '35759500', '2021111111', 'SK2021111111', 'Ulica 1', 'Bratislava', '81101', 'SK', 'SK3112000000198742637541', 'vat_payer'),
           ('${CO.B}', 'Odberateľ B s.r.o.', '36421928', '2022222220', 'SK2022222220', 'Ulica 2', 'Košice', '04001', 'SK', null, 'vat_payer');
  insert into public.business_partners (id, company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code) values
    ('${P.cust}', '${CO.A}', 'customer', 'Zákazník s.r.o.', '44444444', '2044444444', 'SK2044444444', 'Ulica 4', 'Žilina', '01001', 'SK'),
    ('${P.other}', '${CO.A}', 'customer', 'Iný zákazník s.r.o.', '45555555', '2045555555', 'SK2045555555', 'Ulica 5', 'Trnava', '91701', 'SK'),
    ('${P.custB}', '${CO.B}', 'customer', 'Zákazník B s.r.o.', '46666666', '2046666666', 'SK2046666666', 'Ulica 6', 'Nitra', '94901', 'SK');
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, peppol_eligible)
    values ('${CO.A}', 'efaktura_sk', 'sandbox', 'org-a', '0245:2021111111', true), ('${CO.B}', 'efaktura_sk', 'sandbox', 'org-b', '0245:2022222220', true);
`);

const rpc = <T = Row>(uid: string, q: string, p: unknown[] = []) => h.as(uid, () => h.db.query<T>(q, p)).then((r) => r.rows);
const errOf = (p: Promise<unknown>) => p.then(() => "OK", (e) => String((e as Error).message));
const svc = (q: string, p: unknown[] = []) => h.asService(() => h.db.query(q, p));
const inv = async (id: string) => (await h.sql<Row>("select * from public.invoices where id = $1", [id])).rows[0];
const finalize = (uid: string, id: string) => rpc(uid, "select public.esblu_finalize_invoice($1)", [id]);
const settlement = async (uid: string, id: string) =>
  (await rpc<{ s: Record<string, string | number> }>(uid, "select public.esblu_invoice_settlement($1) s", [id]))[0].s;
const n = (v: unknown) => Number(v);

// --- Syntetické UBL (EN 16931 / Peppol BIS 3.0) ---------------------------------------------------
type Line = { qty: number; price: number; rate?: number; cat?: string };
const SUPPLIER = { name: "Dodávateľ S s.r.o.", ico: "31411801", vat: "SK2023333330", endpoint: "2023333330" };
function ubl(o: { root: "Invoice" | "CreditNote"; type: string; id: string; date: string; lines: Line[]; ref?: { id: string; date?: string }; note?: string; supplier?: typeof SUPPLIER; customerEndpoint?: string }): string {
  const s = o.supplier ?? SUPPLIER;
  const isCn = o.root === "CreditNote";
  const groups = new Map<string, { cat: string; rate: number; taxable: number }>();
  const lineXml = o.lines.map((l, i) => {
    const cat = l.cat ?? "S", rate = cat === "S" ? (l.rate ?? 23) : 0;
    const net = Math.round(l.qty * l.price * 100) / 100;
    const g = groups.get(`${cat}|${rate}`) ?? { cat, rate, taxable: 0 };
    g.taxable = Math.round((g.taxable + net) * 100) / 100;
    groups.set(`${cat}|${rate}`, g);
    return `<cac:${isCn ? "CreditNoteLine" : "InvoiceLine"}><cbc:ID>${i + 1}</cbc:ID><cbc:${isCn ? "CreditedQuantity" : "InvoicedQuantity"} unitCode="H87">${l.qty}</cbc:${isCn ? "CreditedQuantity" : "InvoicedQuantity"}><cbc:LineExtensionAmount currencyID="EUR">${net.toFixed(2)}</cbc:LineExtensionAmount><cac:Item><cbc:Name>Položka ${i + 1}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${cat}</cbc:ID><cbc:Percent>${rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${l.price}</cbc:PriceAmount></cac:Price></cac:${isCn ? "CreditNoteLine" : "InvoiceLine"}>`;
  }).join("");
  let taxable = 0, vat = 0;
  const sub = [...groups.values()].map((g) => {
    const v = g.cat === "S" ? Math.round(g.taxable * g.rate) / 100 : 0;
    taxable += g.taxable; vat += v;
    return `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${g.taxable.toFixed(2)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${v.toFixed(2)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${g.cat}</cbc:ID><cbc:Percent>${g.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  }).join("");
  taxable = Math.round(taxable * 100) / 100; vat = Math.round(vat * 100) / 100;
  const ns = isCn ? "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" : "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
  return `<?xml version="1.0" encoding="UTF-8"?><${o.root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID><cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
<cbc:ID>${o.id}</cbc:ID><cbc:IssueDate>${o.date}</cbc:IssueDate><cbc:${isCn ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>${o.type}</cbc:${isCn ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>${o.note ? `<cbc:Note>${o.note}</cbc:Note>` : ""}<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cbc:BuyerReference>REF</cbc:BuyerReference>
${o.ref ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${o.ref.id}</cbc:ID>${o.ref.date ? `<cbc:IssueDate>${o.ref.date}</cbc:IssueDate>` : ""}</cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
<cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="0245">${s.endpoint}</cbc:EndpointID><cac:PostalAddress><cbc:StreetName>Hlavná 1</cbc:StreetName><cbc:CityName>Nitra</cbc:CityName><cbc:PostalZone>94901</cbc:PostalZone><cac:Country><cbc:IdentificationCode>SK</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${s.vat}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${s.name}</cbc:RegistrationName><cbc:CompanyID>${s.ico}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cbc:EndpointID schemeID="0245">${o.customerEndpoint ?? "2021111111"}</cbc:EndpointID><cac:PostalAddress><cbc:CityName>Bratislava</cbc:CityName><cac:Country><cbc:IdentificationCode>SK</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyLegalEntity><cbc:RegistrationName>Odberateľ</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>SK3112000000198742637541</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${vat.toFixed(2)}</cbc:TaxAmount>${sub}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${taxable.toFixed(2)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${taxable.toFixed(2)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${(taxable + vat).toFixed(2)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">${(taxable + vat).toFixed(2)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lineXml}</${o.root}>`;
}

let seq = 0;
/** Prijatie XML do firmy: register → stored (hash, cesta) → parsed → mapovanie → create_draft (rovnaké RPC ako processor). */
async function receive(company: string, org: string, xml: string, providerId?: string) {
  const pid = providerId ?? `rcv-${++seq}`;
  const reg = await h.inbound.register({ provider: "efaktura_sk", environment: "sandbox", providerOrgId: org, providerReceivedId: pid, source: "poll",
    meta: { sender_participant_id: null, sender_ico: null, document_number: null, document_type: null, is_test: true } });
  const bytes = new TextEncoder().encode(xml);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = `${company}/efaktura_sk/${pid}/${sha}.xml`;
  await h.inbound.putXml(path, bytes);
  await h.inbound.transition(reg.inboundId, "received", "stored", "job", null, { xml_sha256: sha, xml_storage_path: path, xml_size_bytes: bytes.byteLength });
  const parsed = parseInboundUbl(bytes);
  if (!parsed.ok) throw new Error(`parse ${parsed.error}`);
  const mapped = mapInboundDraft(parsed.document, parsed.reviewReasons, null);
  if (!mapped.ok) return { inboundId: reg.inboundId, mapped, result: null as null | { status: string; invoiceId: string } };
  await h.inbound.transition(reg.inboundId, "stored", "parsed", "job", null, { document_number: parsed.document.invoiceNumber, document_type: parsed.document.documentType, review_reasons: mapped.reviewReasons });
  const result = await h.inbound.createDraft(reg.inboundId, mapped.draft);
  return { inboundId: reg.inboundId, mapped, result, sha };
}

// =============================================================================
// P1 — prijaté opravné doklady
// =============================================================================
let FA1 = "", CN1 = "";
await check("prijatá faktúra FA-S-1 → koncept → finalizácia (originál pre opravy)", async () => {
  const r = await receive(CO.A, "org-a", ubl({ root: "Invoice", type: "380", id: "FA-S-1", date: "2026-09-10", lines: [{ qty: 2, price: 50 }] }));
  assert.equal(r.result?.status, "created");
  FA1 = r.result!.invoiceId;
  await finalize(U.owner, FA1);
  assert.equal((await inv(FA1)).document_status, "finalized");
  assert.equal(n((await inv(FA1)).total_amount), 123);
});
await check("prijatý dobropis (CreditNote 381) → koncept v review, viazaný na originál; XML nemenné s hashom", async () => {
  const r = await receive(CO.A, "org-a", ubl({ root: "CreditNote", type: "381", id: "DO-S-1", date: "2026-09-20", lines: [{ qty: 1, price: 20 }], ref: { id: "FA-S-1", date: "2026-09-10" }, note: "Zľava za oneskorenie" }));
  assert.equal(r.result?.status, "created");
  CN1 = r.result!.invoiceId;
  const c = await inv(CN1);
  assert.deepEqual([c.kind, c.direction, c.document_status, c.correction_review_status, c.corrects_invoice_id, c.correction_reason, c.corrected_document_reference],
    ["credit_note", "received", "draft", "review", FA1, "Zľava za oneskorenie", "FA-S-1"]);
  assert.deepEqual([n(c.subtotal_amount), n(c.vat_total_amount), n(c.total_amount)], [20, 4.6, 24.6], "sumy a DPH presne z XML (kladné; znamienko určuje druh)");
  const row = (await h.sql<Row>("select xml_sha256, invoice_id from public.einvoice_inbound where id = $1", [r.inboundId])).rows[0];
  assert.equal(row.xml_sha256, r.sha);
  assert.notEqual(await errOf(svc("update public.einvoice_inbound set xml_sha256 = $2 where id = $1", [r.inboundId, "0".repeat(64)])), "OK", "hash originálu je nemenný");
  assert.equal((await inv(FA1)).payment_status, "unpaid", "koncept opravy saldo nemení");
});
await check("prijatie dobropisu (finalizácia) → accepted, udalosť na origináli, saldo originálu sa zníži", async () => {
  assert.match(await errOf(finalize(U.employee, CN1)), /FORBIDDEN|NOT_FOUND/, "employee bez financií neprijme");
  await finalize(U.owner, CN1);
  const c = await inv(CN1);
  assert.equal(c.correction_review_status, "accepted");
  assert.equal(c.correction_reviewed_by, U.owner);
  const ev = (await h.sql<{ n: number }>("select count(*)::int n from public.invoice_events where invoice_id = $1 and event_type = 'correction_created'", [FA1])).rows[0].n;
  assert.equal(ev, 1);
  const s = await settlement(U.owner, FA1);
  assert.deepEqual([n(s.original_total), n(s.credit_notes_total), n(s.amount_due), s.payment_status], [123, 24.6, 98.4, "unpaid"]);
});
await check("duplicate webhook/feed: to isté XML aj iné XML s rovnakým číslom dobropisu → žiadna druhá oprava", async () => {
  const xml = ubl({ root: "CreditNote", type: "381", id: "DO-S-1", date: "2026-09-20", lines: [{ qty: 1, price: 20 }], ref: { id: "FA-S-1", date: "2026-09-10" }, note: "Zľava za oneskorenie" });
  const again = await receive(CO.A, "org-a", xml);
  assert.equal(again.result?.status, "duplicate");
  assert.equal(again.result?.invoiceId, CN1);
  const variant = await receive(CO.A, "org-a", xml.replace("<cbc:BuyerReference>REF</cbc:BuyerReference>", "<cbc:BuyerReference>REF2</cbc:BuyerReference>"));
  assert.equal(variant.result?.status, "duplicate", "iný hash, rovnaký dodávateľ + druh + číslo");
  const reg = await h.inbound.register({ provider: "efaktura_sk", environment: "sandbox", providerOrgId: "org-a", providerReceivedId: "rcv-2", source: "webhook",
    meta: { sender_participant_id: null, sender_ico: null, document_number: null, document_type: null, is_test: true } });
  assert.equal(reg.created, false, "replay toho istého ID poskytovateľa nevytvorí nový riadok");
  const count = (await h.sql<{ n: number }>("select count(*)::int n from public.invoices where company_id = $1 and kind = 'credit_note'", [CO.A])).rows[0].n;
  assert.equal(count, 1);
});
let DEB = "";
await check("prijatý ťarchopis (Invoice 383) → review, viazaný; po prijatí zvýši saldo", async () => {
  const r = await receive(CO.A, "org-a", ubl({ root: "Invoice", type: "383", id: "TV-S-1", date: "2026-09-25", lines: [{ qty: 1, price: 10 }], ref: { id: "FA-S-1" }, note: "Doúčtovanie dopravy" }));
  DEB = r.result!.invoiceId;
  const d = await inv(DEB);
  assert.deepEqual([d.kind, d.correction_review_status, d.corrects_invoice_id], ["debit_note", "review", FA1]);
  await finalize(U.owner, DEB);
  const s = await settlement(U.owner, FA1);
  assert.deepEqual([n(s.debit_notes_total), n(s.amount_due)], [12.3, 110.7]);
});
let ORPHAN = "";
await check("oprava bez nájdeného originálu → koncept bez väzby (ORIGINAL_NOT_FOUND), nedá sa prijať; manuálne prepojenie", async () => {
  const r = await receive(CO.A, "org-a", ubl({ root: "CreditNote", type: "381", id: "DO-S-2", date: "2026-09-21", lines: [{ qty: 1, price: 5 }], ref: { id: "FA-NEEXISTUJE" }, note: "Reklamácia" }));
  ORPHAN = r.result!.invoiceId;
  const o = await inv(ORPHAN);
  assert.equal(o.corrects_invoice_id, null);
  assert.deepEqual(o.correction_review_reasons, ["ORIGINAL_NOT_FOUND"]);
  assert.match(await errOf(finalize(U.owner, ORPHAN)), /ESBLU_CORRECTED_INVOICE_NOT_FOUND|ESBLU_CORRECTION_ORIGINAL_REQUIRED/);
  await rpc(U.owner, "select public.esblu_received_correction_link($1, $2)", [ORPHAN, FA1]);
  const linked = await inv(ORPHAN);
  assert.equal(linked.corrects_invoice_id, FA1);
  assert.deepEqual(linked.correction_review_reasons, []);
  await finalize(U.owner, ORPHAN);
  assert.equal((await inv(ORPHAN)).correction_review_status, "accepted");
});
await check("chýbajúci BT-25 a dôvod → review dôvody; zamietnutie → nedá sa prijať", async () => {
  const r = await receive(CO.A, "org-a", ubl({ root: "CreditNote", type: "83", id: "DO-S-3", date: "2026-09-22", lines: [{ qty: 1, price: 3 }] }));
  const c = await inv(r.result!.invoiceId);
  assert.deepEqual([...(c.correction_review_reasons as string[])].sort(), ["CORRECTION_REASON_MISSING", "CORRECTION_TYPE_REVIEW", "ORIGINAL_REFERENCE_MISSING"]);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_correction_reject($1, $2)", [c.id, "x"])), /ESBLU_CORRECTION_REVIEW_NOTE_REQUIRED/);
  await rpc(U.owner, "select public.esblu_received_correction_reject($1, $2)", [c.id, "Dodávateľ poslal omylom"]);
  assert.equal((await inv(c.id as string)).correction_review_status, "rejected");
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_correction_link($1, $2)", [c.id, FA1])), /ESBLU_CORRECTION_NOT_IN_REVIEW/);
});
await check("nepodporované typy opráv (CreditNote 396, Invoice 384) → žiadny koncept (manuálne spracovanie)", async () => {
  const a = await receive(CO.A, "org-a", ubl({ root: "CreditNote", type: "396", id: "DO-F-1", date: "2026-09-22", lines: [{ qty: 1, price: 3 }], ref: { id: "FA-S-1" } }));
  assert.deepEqual(a.mapped, { ok: false, code: "UNSUPPORTED_PROFILE", detail: "CREDIT_NOTE_TYPE_UNSUPPORTED" });
  const b = await receive(CO.A, "org-a", ubl({ root: "Invoice", type: "384", id: "FA-C-1", date: "2026-09-22", lines: [{ qty: 1, price: 3 }], ref: { id: "FA-S-1" } }));
  assert.deepEqual(b.mapped, { ok: false, code: "UNSUPPORTED_PROFILE", detail: "CORRECTED_INVOICE_UNSUPPORTED" });
});
await check("cross-tenant: firma B s BT-25 = číslo faktúry firmy A sa nenaviaže; ručné prepojenie na cudzí doklad nie je možné", async () => {
  const r = await receive(CO.B, "org-b", ubl({ root: "CreditNote", type: "381", id: "DO-S-1", date: "2026-09-20", lines: [{ qty: 1, price: 20 }], ref: { id: "FA-S-1" }, note: "Zľava", customerEndpoint: "2022222220" }));
  const c = await inv(r.result!.invoiceId);
  assert.equal(c.company_id, CO.B);
  assert.equal(c.corrects_invoice_id, null);
  assert.deepEqual(c.correction_review_reasons, ["ORIGINAL_NOT_FOUND"]);
  assert.match(await errOf(rpc(U.ownerB, "select public.esblu_received_correction_link($1, $2)", [c.id, FA1])), /ESBLU_CORRECTED_INVOICE_NOT_FOUND/);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_correction_link($1, $2)", [c.id, FA1])), /ESBLU_INVOICE_NOT_FOUND/, "A nevidí koncept B");
  assert.notEqual(await errOf(svc("update public.invoices set corrects_invoice_id = $2 where id = $1", [c.id, FA1])), "OK", "ani service_role nespojí doklady dvoch firiem");
});
await check("väzba iba na faktúru TOHO ISTÉHO dodávateľa; review polia klient nemení priamo", async () => {
  const other = await receive(CO.A, "org-a", ubl({ root: "Invoice", type: "380", id: "FA-X-1", date: "2026-09-10", lines: [{ qty: 1, price: 10 }],
    supplier: { name: "Iný dodávateľ s.r.o.", ico: "36421928", vat: "SK2022222220", endpoint: "2022222220" } }));
  await finalize(U.owner, other.result!.invoiceId);
  const r = await receive(CO.A, "org-a", ubl({ root: "CreditNote", type: "381", id: "DO-S-4", date: "2026-09-23", lines: [{ qty: 1, price: 1 }], ref: { id: "FA-X-1" }, note: "Zľava" }));
  const c = await inv(r.result!.invoiceId);
  assert.equal(c.corrects_invoice_id, null, "číslo existuje, ale u iného dodávateľa");
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_correction_link($1, $2)", [c.id, other.result!.invoiceId])), /ESBLU_CORRECTION_SUPPLIER_MISMATCH/);
  assert.match(await errOf(rpc(U.owner, "update public.invoices set correction_review_status = 'accepted' where id = $1", [c.id])), /ESBLU_CORRECTION_REVIEW_FIELDS_PROTECTED/);
  assert.match(await errOf(rpc(U.owner, "update public.invoices set corrects_invoice_id = $2 where id = $1", [c.id, FA1])), /ESBLU_CORRECTION_REVIEW_FIELDS_PROTECTED/);
});

// =============================================================================
// P3 — úhrady a saldo (vydané)
// =============================================================================
async function issued(kind = "regular_invoice", opts: { corrects?: string; header?: Record<string, unknown>; items?: { price: number; rate?: number }[]; partner?: string } = {}) {
  const [r] = await rpc<{ id: string }>(U.owner,
    "insert into public.invoices (company_id, direction, kind, issue_date, currency, customer_business_partner_id, source, corrects_invoice_id) values ($1, 'issued', $2, '2026-10-06', 'EUR', $3, 'manual', $4) returning id",
    [CO.A, kind, opts.partner ?? P.cust, opts.corrects ?? null]);
  const items = (opts.items ?? [{ price: 100 }]).map((i, k) => {
    const rate = i.rate ?? 23, net = i.price, vat = Math.round(net * rate) / 100;
    return { description: `Služba ${k + 1}`, quantity: 1, unit: "ks", unit_code: "H87", unit_price: i.price, price_mode: "net", vat_category_code: "S", vat_rate: rate, line_net_amount: net, line_vat_amount: vat, line_gross_amount: Math.round((net + vat) * 100) / 100 };
  });
  const header = { issue_date: "2026-10-06", due_date: "2026-10-20", delivery_date: "2026-10-05", currency: "EUR", customer_business_partner_id: opts.partner ?? P.cust, ...(opts.header ?? {}) };
  await rpc(U.owner, "select id from public.esblu_save_invoice_draft($1, $2::jsonb, $3::jsonb, null)", [r.id, JSON.stringify(header), JSON.stringify(items)]);
  const fields: Record<string, unknown> = {};
  if (kind === "credit_note" || kind === "debit_note") fields.correction_reason = "Oprava ceny";
  if (opts.header?.tax_point_date) fields.tax_point_date = opts.header.tax_point_date;
  if (Object.keys(fields).length) await rpc(U.owner, "select public.esblu_set_invoice_compliance_fields($1, $2::jsonb)", [r.id, JSON.stringify(fields)]);
  return r.id;
}
const pay = (id: string, amt: number, uid = U.owner) => rpc(uid, "select public.esblu_add_invoice_payment($1, $2, '2026-10-07', 'bank_transfer', null)", [id, amt]);
const refund = (id: string, amt: number, uid = U.owner) => rpc(uid, "select public.esblu_add_invoice_refund($1, $2, '2026-10-08', 'bank_transfer', 'vrátenie')", [id, amt]);

let INV = "";
await check("úhrady: neuhradená → čiastočná → uhradená → preplatená → vrátenie → uhradená; obsah faktúry sa nemení", async () => {
  INV = await issued();
  await finalize(U.owner, INV);
  const before = await inv(INV);
  assert.equal(before.payment_status, "unpaid");
  await pay(INV, 50);
  assert.equal((await inv(INV)).payment_status, "partially_paid");
  await pay(INV, 73);
  assert.equal((await inv(INV)).payment_status, "paid");
  await pay(INV, 10);
  assert.equal((await inv(INV)).payment_status, "overpaid");
  assert.match(await errOf(refund(INV, 500)), /ESBLU_REFUND_EXCEEDS_PAID/);
  await refund(INV, 10);
  assert.equal((await inv(INV)).payment_status, "paid");
  const s = await settlement(U.owner, INV);
  assert.deepEqual([n(s.paid), n(s.refunded), n(s.balance)], [133, 10, 0]);
  const after = await inv(INV);
  for (const k of ["total_amount", "subtotal_amount", "vat_total_amount", "invoice_number", "issue_date"]) assert.equal(String(after[k]), String(before[k]), k);
  const ev = (await h.sql<{ t: string }>("select event_type t from public.invoice_events where invoice_id = $1 and event_type like 'payment%' order by created_at", [INV])).rows.map((r) => r.t);
  assert.deepEqual(ev, ["payment_recorded", "payment_recorded", "payment_recorded", "payment_refunded"]);
});
await check("dobropis zníži a ťarchopis zvýši saldo originálu; stav sa prepočíta pri finalizácii opravy", async () => {
  const cn = await issued("credit_note", { corrects: INV, items: [{ price: 10 }] });
  await finalize(U.owner, cn);
  assert.equal((await inv(INV)).payment_status, "overpaid", "po dobropise 12,30 je zaplatené viac než dlžná suma");
  assert.equal((await inv(cn)).payment_status, "overpaid", "dobropis zdieľa stav skupiny");
  const dn = await issued("debit_note", { corrects: INV, items: [{ price: 20 }] });
  await finalize(U.owner, dn);
  const s = await settlement(U.owner, INV);
  assert.deepEqual([n(s.credit_notes_total), n(s.debit_notes_total), n(s.amount_due), n(s.balance), s.payment_status], [12.3, 24.6, 135.3, 12.3, "partially_paid"]);
  await pay(dn, 12.3);
  assert.equal((await inv(INV)).payment_status, "paid", "platba ťarchopisu sa započíta do skupiny");
  assert.match(await errOf(pay(cn, 1)), /ESBLU_PAYMENT_ON_CREDIT_NOTE/);
});
await check("úhrady: role — employee bez financií ani cudzia firma platbu, vrátenie ani saldo nevidí", async () => {
  assert.match(await errOf(pay(INV, 1, U.employee)), /FORBIDDEN/);
  assert.match(await errOf(refund(INV, 1, U.employee)), /FORBIDDEN/);
  assert.match(await errOf(pay(INV, 1, U.ownerB)), /NOT_FOUND/);
  assert.match(await errOf(settlement(U.ownerB, INV)), /NOT_FOUND/);
  assert.match(await errOf(settlement(U.employee, INV)), /NOT_FOUND/);
  assert.equal(n((await settlement(U.accountant, INV)).balance), 0, "účtovník vidí saldo");
});

// =============================================================================
// P2 — zálohy
// =============================================================================
let ADV = "", FIN = "";
await check("proforma: nedaňový doklad, séria PF, úhrada sa na ňu neeviduje", async () => {
  const pf = await issued("proforma");
  await finalize(U.owner, pf);
  const p = await inv(pf);
  assert.match(String(p.invoice_number), /^PF/);
  assert.match(await errOf(pay(pf, 10)), /ESBLU_PAYMENT_ON_PROFORMA/);
});
await check("faktúra k prijatej platbe (záloha) → dostupná na odpočet so zostatkom podľa sadzby", async () => {
  ADV = await issued("payment_received_invoice", { header: { tax_point_date: "2026-10-01", delivery_date: null } });
  await finalize(U.owner, ADV);
  await pay(ADV, 123);
  assert.equal((await inv(ADV)).payment_status, "paid");
  FIN = await issued("regular_invoice", { items: [{ price: 200 }] });
  const av = await rpc<Row>(U.owner, "select advance_invoice_id, vat_category_code, vat_rate::float8 vat_rate, taxable_remaining::float8 t, vat_remaining::float8 v from public.esblu_available_advances($1)", [FIN]);
  assert.deepEqual(av.map((a) => [a.advance_invoice_id, a.vat_category_code, a.vat_rate, a.t, a.v]), [[ADV, "S", 23, 100, 23]]);
  const other = await issued("regular_invoice", { partner: P.other });
  assert.equal((await rpc(U.owner, "select * from public.esblu_available_advances($1)", [other])).length, 0, "záloha iného odberateľa sa neponúkne");
  assert.match(await errOf(rpc(U.employee, "select * from public.esblu_available_advances($1)", [FIN])), /FORBIDDEN|NOT_FOUND/);
});
await check("konečná faktúra: odpočet zálohy → saldo = celkom − záloha; tú istú zálohu nemožno odpočítať druhýkrát", async () => {
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [FIN, JSON.stringify([{ advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }])]);
  await finalize(U.owner, FIN);
  const s = await settlement(U.owner, FIN);
  assert.deepEqual([n(s.original_total), n(s.advances_deducted), n(s.amount_due), s.payment_status], [246, 123, 123, "unpaid"]);
  assert.equal((await rpc(U.owner, "select * from public.esblu_available_advances($1)", [await issued()])).length, 0, "vyčerpaná záloha sa už neponúka");
  const second = await issued("regular_invoice", { items: [{ price: 300 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [second, JSON.stringify([{ advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }])]);
  assert.match(await errOf(finalize(U.owner, second)), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS/, "duplicitný odpočet");
  assert.notEqual(await errOf(rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [second, JSON.stringify([
    { advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 1, vat_amount: 0.23 },
    { advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 1, vat_amount: 0.23 }])])), "OK", "dvakrát v jednom zozname");
  await pay(FIN, 123);
  assert.equal((await inv(FIN)).payment_status, "paid");
});
await check("odpočty nesmú prevýšiť konečnú faktúru ani DPH zálohy", async () => {
  const adv2 = await issued("payment_received_invoice", { items: [{ price: 500 }], header: { tax_point_date: "2026-10-02", delivery_date: null } });
  await finalize(U.owner, adv2);
  const small = await issued("regular_invoice", { items: [{ price: 50 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [small, JSON.stringify([{ advance_invoice_id: adv2, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }])]);
  assert.match(await errOf(finalize(U.owner, small)), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS_TOTAL/);
  const vatHeavy = await issued("regular_invoice", { items: [{ price: 1000 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [vatHeavy, JSON.stringify([{ advance_invoice_id: adv2, vat_category_code: "S", vat_rate: 23, taxable_amount: 10, vat_amount: 200 }])]);
  assert.match(await errOf(finalize(U.owner, vatHeavy)), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS/);
});

// =============================================================================
// P4 — hromadný export: tenant izolácia a role (dotaz exportu pod RLS + statická kontrola route)
// =============================================================================
const periodQuery = (uid: string) => rpc<{ id: string; company_id: string; kind: string }>(uid,
  "select id, company_id, kind from public.invoices where document_status = 'finalized' and issue_date between '2026-01-01' and '2026-12-31'");
await check("export za obdobie: owner A vidí iba doklady A (aj bez filtra firmy), B iba svoje, employee bez financií nič", async () => {
  const a = await periodQuery(U.owner);
  assert.ok(a.length > 5 && a.every((r) => r.company_id === CO.A), "iba firma A");
  assert.ok(a.some((r) => r.kind === "proforma") && a.some((r) => r.kind === "credit_note") && a.some((r) => r.kind === "payment_received_invoice"));
  const b = await periodQuery(U.ownerB);
  assert.ok(b.every((r) => r.company_id === CO.B), "B nevidí A");
  assert.equal((await periodQuery(U.employee)).length, 0, "employee bez financií nevidí doklady");
  const ev = await rpc<{ n: number }>(U.ownerB, "select count(*)::int n from public.invoice_events e join public.invoices i on i.id = e.invoice_id where i.company_id = $1", [CO.A]);
  assert.equal(ev[0].n, 0, "audit A nie je pre B viditeľný");
  const pays = await rpc<{ n: number }>(U.ownerB, "select count(*)::int n from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.company_id = $1", [CO.A]);
  assert.equal(pays[0].n, 0);
});
await check("export route: user-scoped klient, finance.manage, explicitný filter firmy, žiadny service_role na klientovi, nič sa neukladá", async () => {
  const src = readFileSync(new URL("../app/api/accounting-handoff/package/route.ts", import.meta.url), "utf8");
  assert.match(src, /db\.rpc\("esblu_my_finance_manage"\)/);
  assert.match(src, /if \(!canManage\) return errorResponse\(locale, 403, "FORBIDDEN"\)/);
  assert.match(src, /\.eq\("company_id", companyId\)\s*\.eq\("document_status", "finalized"\)/);
  assert.match(src, /createClient\(supabaseUrl, supabaseAnonKey/);
  assert.doesNotMatch(src, /getSupabaseAdmin|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(src, /storage\.from\([^)]*\)\.upload/);
  assert.match(src, /"Content-Disposition": `attachment;/);
});

console.log(`\ninvoicing-flow: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
