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
    console.log(`  ✗ ${label}\n    ${error instanceof Error ? (process.env.FULL_ERR ? error.message : error.message.split("\n")[0]) : error}`);
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
function ubl(o: { root: "Invoice" | "CreditNote"; type: string; id: string; date: string; lines: Line[]; ref?: { id: string; date?: string }; refs?: { id: string; date?: string }[]; note?: string; supplier?: typeof SUPPLIER; customerEndpoint?: string; prepaid?: number; taxPoint?: string; vatOverride?: Record<string, number> }): string {
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
    const raw = g.taxable * g.rate;
    const v = g.cat === "S" ? (o.vatOverride?.[`${g.cat}|${g.rate}`] ?? Math.sign(raw) * Math.round(Math.abs(raw)) / 100) : 0;
    taxable += g.taxable; vat += v;
    return `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${g.taxable.toFixed(2)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${v.toFixed(2)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${g.cat}</cbc:ID><cbc:Percent>${g.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  }).join("");
  taxable = Math.round(taxable * 100) / 100; vat = Math.round(vat * 100) / 100;
  const ns = isCn ? "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" : "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
  return `<?xml version="1.0" encoding="UTF-8"?><${o.root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID><cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
<cbc:ID>${o.id}</cbc:ID><cbc:IssueDate>${o.date}</cbc:IssueDate><cbc:${isCn ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>${o.type}</cbc:${isCn ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>${o.note ? `<cbc:Note>${o.note}</cbc:Note>` : ""}${o.taxPoint ? `<cbc:TaxPointDate>${o.taxPoint}</cbc:TaxPointDate>` : ""}<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cbc:BuyerReference>REF</cbc:BuyerReference>
${[...(o.ref ? [o.ref] : []), ...(o.refs ?? [])].map((r) => `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${r.id}</cbc:ID>${r.date ? `<cbc:IssueDate>${r.date}</cbc:IssueDate>` : ""}</cac:InvoiceDocumentReference></cac:BillingReference>`).join("")}
<cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="0245">${s.endpoint}</cbc:EndpointID><cac:PostalAddress><cbc:StreetName>Hlavná 1</cbc:StreetName><cbc:CityName>Nitra</cbc:CityName><cbc:PostalZone>94901</cbc:PostalZone><cac:Country><cbc:IdentificationCode>SK</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${s.vat}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${s.name}</cbc:RegistrationName><cbc:CompanyID>${s.ico}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cbc:EndpointID schemeID="0245">${o.customerEndpoint ?? "2021111111"}</cbc:EndpointID><cac:PostalAddress><cbc:CityName>Bratislava</cbc:CityName><cac:Country><cbc:IdentificationCode>SK</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyLegalEntity><cbc:RegistrationName>Odberateľ</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>SK3112000000198742637541</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${vat.toFixed(2)}</cbc:TaxAmount>${sub}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${taxable.toFixed(2)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${taxable.toFixed(2)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${(taxable + vat).toFixed(2)}</cbc:TaxInclusiveAmount>${o.prepaid ? `<cbc:PrepaidAmount currencyID="EUR">${o.prepaid.toFixed(2)}</cbc:PrepaidAmount>` : ""}<cbc:PayableAmount currencyID="EUR">${(Math.round((taxable + vat - (o.prepaid ?? 0)) * 100) / 100).toFixed(2)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
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
await check("oprava spracovaná PRED originálom → po príchode originálu sa sama prepojí (stále review, nie prijatá)", async () => {
  const cn = await receive(CO.A, "org-a", ubl({ root: "CreditNote", type: "381", id: "DO-S-9", date: "2026-09-28", lines: [{ qty: 1, price: 4 }], ref: { id: "FA-S-9", date: "2026-09-27" }, note: "Zľava" }));
  const before = await inv(cn.result!.invoiceId);
  assert.deepEqual([before.corrects_invoice_id, before.correction_review_reasons], [null, ["ORIGINAL_NOT_FOUND"]]);
  const orig = await receive(CO.A, "org-a", ubl({ root: "Invoice", type: "380", id: "FA-S-9", date: "2026-09-27", lines: [{ qty: 1, price: 40 }] }));
  const after = await inv(cn.result!.invoiceId);
  assert.deepEqual([after.corrects_invoice_id, after.correction_review_status, after.correction_review_reasons], [orig.result!.invoiceId, "review", ["ORIGINAL_NOT_FINALIZED"]]);
  const ev = (await h.sql<{ n: number }>("select count(*)::int n from public.invoice_events where invoice_id = $1 and event_type = 'correction_reviewed' and payload->>'action' = 'auto_linked'", [after.id])).rows[0].n;
  assert.equal(ev, 1);
  const otherDate = await receive(CO.A, "org-a", ubl({ root: "CreditNote", type: "381", id: "DO-S-10", date: "2026-09-28", lines: [{ qty: 1, price: 1 }], ref: { id: "FA-S-10", date: "2026-01-01" }, note: "Zľava" }));
  await receive(CO.A, "org-a", ubl({ root: "Invoice", type: "380", id: "FA-S-10", date: "2026-09-27", lines: [{ qty: 1, price: 40 }] }));
  assert.equal((await inv(otherDate.result!.invoiceId)).corrects_invoice_id, null, "iný dátum BT-26 → bez automatického prepojenia");
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
  // 20261008100009: zdanená záloha = mínusový riadok → total už po odpočte, nič sa neodpočítava druhýkrát.
  assert.deepEqual([n(s.items_total), n(s.advances_taxed), n(s.original_total), n(s.advances_deducted), n(s.amount_due), s.payment_status], [246, 123, 123, 0, 123, "unpaid"]);
  assert.equal((await rpc(U.owner, "select * from public.esblu_available_advances($1)", [await issued()])).length, 0, "vyčerpaná záloha sa už neponúka");
  const second = await issued("regular_invoice", { items: [{ price: 300 }] });
  assert.match(await errOf(rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [second, JSON.stringify([{ advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }])])), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS/, "duplicitný odpočet");
  assert.notEqual(await errOf(rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [second, JSON.stringify([
    { advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 1, vat_amount: 0.23 },
    { advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 1, vat_amount: 0.23 }])])), "OK", "dvakrát v jednom zozname");
  await pay(FIN, 123);
  assert.equal((await inv(FIN)).payment_status, "paid");
});
await check("e-faktúra: faktúra k prijatej platbe (386) sa smie odoslať, proforma nie (20261008100006)", async () => {
  await h.exec(`insert into public.company_entitlements (company_id, entitlement_key, source, note) values ('${CO.A}', 'einvoice', 'manual', 'test') on conflict do nothing`);
  const req = (id: string) => errOf(svc("select * from public.esblu_einvoice_request_outbound($1, $2, 'sandbox', $3, 'p', 10, '0245:2044444444')", [U.owner, id, "a".repeat(64)]));
  assert.doesNotMatch(await req(ADV), /ESBLU_EINVOICE_KIND_UNSUPPORTED/);
  const pf = (await h.sql<{ id: string }>("select id from public.invoices where kind = 'proforma' and document_status = 'finalized' limit 1")).rows[0].id;
  assert.match(await req(pf), /ESBLU_EINVOICE_KIND_UNSUPPORTED/);
});
await check("odpočty nesmú prevýšiť konečnú faktúru ani DPH zálohy", async () => {
  const adv2 = await issued("payment_received_invoice", { items: [{ price: 500 }], header: { tax_point_date: "2026-10-02", delivery_date: null } });
  await finalize(U.owner, adv2);
  const small = await issued("regular_invoice", { items: [{ price: 50 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [small, JSON.stringify([{ advance_invoice_id: adv2, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }])]);
  assert.match(await errOf(finalize(U.owner, small)), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS_TOTAL/);
  const vatHeavy = await issued("regular_invoice", { items: [{ price: 1000 }] });
  assert.match(await errOf(rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [vatHeavy, JSON.stringify([{ advance_invoice_id: adv2, vat_category_code: "S", vat_rate: 23, taxable_amount: 10, vat_amount: 200 }])])), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS/);
});

// =============================================================================
// 20261008100009 — ZDANENÁ záloha = mínusový riadok (FS SR, FAQ k eFaktúre 15. 9. 2026, tech. príklad 38).
// Referencia: pravidlo z príkladu 38 (text FAQ sa nekopíruje); fixtúry sú SYNTETICKÉ, postavené podľa neho:
//   mínusový InvoiceLine (množstvo -1), základ + DPH, rovnaká sadzba ako zálohová faktúra, BT-25 na zálohu,
//   PrepaidAmount (BT-113) iba pre nezdanené zálohy.
// =============================================================================
const NEW = { generate: (await import("../lib/einvoice/ubl/generate.ts")) as typeof import("../lib/einvoice/ubl/generate.ts") };
const setDed = (id: string, rows: Record<string, unknown>[], uid = U.owner) =>
  rpc(uid, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [id, JSON.stringify(rows)]);
const itemsOf = (id: string) => h.sql<Row>(`select position, description, quantity::float8 q, unit_price::float8 p, vat_category_code c, vat_rate::float8 r,
  line_net_amount::float8 net, line_vat_amount::float8 vat, line_gross_amount::float8 gross, is_advance_deduction d, advance_invoice_id a
  from public.invoice_items where invoice_id = $1 order by position`, [id]).then((r) => r.rows);
const breakdownOf = (id: string) => h.sql<Row>("select vat_category_code c, vat_rate::float8 r, taxable_amount::float8 t, vat_amount::float8 v from public.invoice_tax_breakdowns where invoice_id = $1 order by vat_category_code, vat_rate desc", [id]).then((r) => r.rows.map((b) => [b.c, b.r, b.t, b.v]));
async function issuedAdvance(items: { price: number; rate?: number }[], taxPoint = "2026-10-01") {
  const id = await issued("payment_received_invoice", { items, header: { tax_point_date: taxPoint, delivery_date: null } });
  await finalize(U.owner, id);
  return id;
}
/** Snapshot rovnako ako lib/einvoice/load-finalized-invoice.ts (bez Supabase klienta). */
async function snapshotOf(id: string) {
  const head = (await h.sql<Row>(`select id, company_id, direction, kind, document_status, invoice_number, issue_date::text issue_date, due_date::text due_date,
    delivery_date::text delivery_date, tax_point_date::text tax_point_date, currency, subtotal_amount, vat_total_amount, total_amount, rounding_amount,
    buyer_reference, purchase_order_reference, payment_means_code, payment_reference, corrects_invoice_id, correction_reason, untaxed_prepaid_amount
    from public.invoices where id = $1`, [id])).rows[0];
  const parties = (await h.sql<Row>("select * from public.invoice_parties where invoice_id = $1", [id])).rows;
  const items = (await h.sql<Row>(`select position, description, quantity, unit_code, unit_price, price_mode, vat_category_code, vat_rate, line_net_amount,
    is_advance_deduction, advance_invoice_id from public.invoice_items where invoice_id = $1 order by position`, [id])).rows;
  const tax = (await h.sql<Row>("select vat_category_code, vat_rate, taxable_amount, vat_amount, vat_exemption_reason_code, vat_exemption_reason_text from public.invoice_tax_breakdowns where invoice_id = $1", [id])).rows;
  const ded = (await h.sql<Row>("select advance_invoice_id from public.invoice_advance_deductions where invoice_id = $1", [id])).rows;
  const advIds = [...new Set([...ded.map((d) => d.advance_invoice_id as string), ...items.map((i) => i.advance_invoice_id as string | null).filter((x): x is string => Boolean(x))])];
  const adv = advIds.length ? (await h.sql<Row>("select id, invoice_number, issue_date::text issue_date from public.invoices where id = any($1::uuid[]) order by invoice_number", [advIds])).rows : [];
  const fix = (p: Row) => ({ ...p, electronic_address: p.electronic_address ?? (p.role === "seller" ? "2021111111" : "2044444444"), electronic_address_scheme_id: p.electronic_address_scheme_id ?? "0245" });
  return {
    invoice: { ...head, payment_means_code: head.payment_means_code ?? "30", buyer_reference: head.buyer_reference ?? "E2E-REF" },
    seller: fix(parties.find((p) => p.role === "seller")!), buyer: fix(parties.find((p) => p.role === "buyer")!),
    items: items.map((i) => ({ ...i, unit_code: i.unit_code ?? "H87" })), taxBreakdowns: tax, correctedInvoice: null,
    prepaidAmount: Number(head.untaxed_prepaid_amount ?? 0),
    advanceInvoices: adv.map((a) => ({ id: a.id as string, invoice_number: a.invoice_number as string, issue_date: a.issue_date as string })),
    legacyAdvanceDeduction: ded.length > 0 && !items.some((i) => i.is_advance_deduction),
  } as unknown as import("../lib/einvoice/ubl/model.ts").UblInvoiceSnapshot;
}
const xmlAll = (xml: string, local: string) => [...xml.matchAll(new RegExp(`<cbc:${local}[^>]*>([^<]*)</cbc:${local}>`, "g"))].map((m) => m[1]);

let TADV1 = "", TFIN1 = "";
await check("zdanená záloha → mínusový riadok (základ + DPH zálohy, rovnaká sadzba, odkaz na 386); rozpis DPH a hlavička po odpočte", async () => {
  TADV1 = await issuedAdvance([{ price: 100 }]);
  TFIN1 = await issued("regular_invoice", { items: [{ price: 300 }] });
  await setDed(TFIN1, [{ advance_invoice_id: TADV1, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }]);
  await finalize(U.owner, TFIN1);
  const its = await itemsOf(TFIN1);
  const d = its.find((i) => i.d)!;
  const advNo = (await inv(TADV1)).invoice_number as string;
  assert.deepEqual([d.q, d.p, d.c, d.r, d.net, d.vat, d.gross, d.a], [1, -100, "S", 23, -100, -23, -123, TADV1]);
  assert.ok(String(d.description).includes(advNo), "popis odkazuje na faktúru k prijatej platbe");
  assert.deepEqual(await breakdownOf(TFIN1), [["S", 23, 200, 46]]);
  const f = await inv(TFIN1);
  assert.deepEqual([n(f.subtotal_amount), n(f.vat_total_amount), n(f.total_amount)], [200, 46, 246]);
});
await check("zdanená záloha NEPOUŽÍVA PrepaidAmount; UBL: InvoicedQuantity -1, kladná cena, BT-25, súčty sedia; príjemca XML prijme", async () => {
  const r = NEW.generate.generateUbl(await snapshotOf(TFIN1));
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
  if (!r.ok) return;
  assert.deepEqual(xmlAll(r.xml, "PrepaidAmount"), [], "bez BT-113");
  assert.deepEqual(xmlAll(r.xml, "InvoicedQuantity"), ["1", "-1"]);
  assert.deepEqual(xmlAll(r.xml, "LineExtensionAmount"), ["200.00", "300.00", "-100.00"]);
  assert.deepEqual(xmlAll(r.xml, "PriceAmount"), ["300", "100"]);
  assert.deepEqual(xmlAll(r.xml, "TaxableAmount"), ["200.00"]);
  assert.deepEqual(xmlAll(r.xml, "PayableAmount"), ["246.00"]);
  assert.ok(r.xml.includes(`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${(await inv(TADV1)).invoice_number}</cbc:ID>`));
  // EN 16931 aritmetika a pravidlá cez parser + mapovanie príjemcu (BR-CO-10/13/15/16/17, BR-27, BR-S-08).
  const parsed = parseInboundUbl(new TextEncoder().encode(r.xml));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const m = mapInboundDraft(parsed.document, parsed.reviewReasons, null);
  assert.ok(m.ok, JSON.stringify(m));
  if (!m.ok) return;
  assert.deepEqual(m.draft.items.map((i) => [i.unit_price, Boolean(i.advance_deduction)]), [["300", false], ["-100.00", true]]);
  assert.deepEqual(m.draft.advance?.references.map((x) => x.number), [(await inv(TADV1)).invoice_number]);
  assert.equal(m.draft.totals.prepaid, "0.00");
});
await check("saldo: zdanená záloha sa nezapočíta dvakrát; úhrada zvyšku → uhradená (nie preplatená)", async () => {
  const s = await settlement(U.owner, TFIN1);
  assert.deepEqual([n(s.items_total), n(s.advances_taxed), n(s.original_total), n(s.advances_deducted), n(s.amount_due)], [369, 123, 246, 0, 246]);
  await pay(TFIN1, 246);
  assert.equal((await inv(TFIN1)).payment_status, "paid");
  const sa = await settlement(U.owner, TADV1);
  assert.deepEqual([n(sa.advance_consumed), n(sa.advance_remaining)], [123, 0]);
});
await check("viac zdanených záloh s rovnakou sadzbou → riadok za každú zálohu, každý s vlastným BT-25", async () => {
  const a1 = await issuedAdvance([{ price: 50 }]);
  const a2 = await issuedAdvance([{ price: 20 }]);
  const fin = await issued("regular_invoice", { items: [{ price: 400 }] });
  await setDed(fin, [{ advance_invoice_id: a1, vat_category_code: "S", vat_rate: 23, taxable_amount: 50, vat_amount: 11.5 },
                     { advance_invoice_id: a2, vat_category_code: "S", vat_rate: 23, taxable_amount: 20, vat_amount: 4.6 }]);
  await finalize(U.owner, fin);
  const ded = (await itemsOf(fin)).filter((i) => i.d);
  assert.deepEqual(ded.map((i) => [i.a, i.net, i.vat]).sort((x, y) => n(x[1]) - n(y[1])), [[a1, -50, -11.5], [a2, -20, -4.6]]);
  assert.deepEqual(await breakdownOf(fin), [["S", 23, 330, 75.9]]);
  const r = NEW.generate.generateUbl(await snapshotOf(fin));
  assert.ok(r.ok);
  if (r.ok) {
    const refs = [...r.xml.matchAll(/<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>([^<]+)<\/cbc:ID>/g)].map((m) => m[1]).sort();
    assert.deepEqual(refs, [(await inv(a1)).invoice_number, (await inv(a2)).invoice_number].sort());
    assert.deepEqual(xmlAll(r.xml, "PayableAmount"), ["405.90"]);
  }
});
await check("rôzne sadzby: záloha 23 % aj 19 % → mínusové riadky po sadzbách; rozpis DPH sedí po každej sadzbe", async () => {
  const a = await issuedAdvance([{ price: 100, rate: 23 }, { price: 50, rate: 19 }]);
  const fin = await issued("regular_invoice", { items: [{ price: 300, rate: 23 }, { price: 200, rate: 19 }] });
  await setDed(fin, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 },
                     { advance_invoice_id: a, vat_category_code: "S", vat_rate: 19, taxable_amount: 50, vat_amount: 9.5 }]);
  await finalize(U.owner, fin);
  assert.deepEqual(await breakdownOf(fin), [["S", 23, 200, 46], ["S", 19, 150, 28.5]]);
  const f = await inv(fin);
  assert.deepEqual([n(f.subtotal_amount), n(f.vat_total_amount), n(f.total_amount)], [350, 74.5, 424.5]);
  const r = NEW.generate.generateUbl(await snapshotOf(fin));
  assert.ok(r.ok);
  if (r.ok) {
    const parsed = parseInboundUbl(new TextEncoder().encode(r.xml));
    assert.ok(parsed.ok && mapInboundDraft(parsed.document, parsed.reviewReasons, null).ok, "rozpis po sadzbách prejde kontrolou príjemcu");
  }
});
await check("čiastočná záloha: odpočet 40 zo 100 (DPH pomerne), zvyšok na ďalšej faktúre; ďalší odpočet nad zostatok → odmietnutý", async () => {
  const a = await issuedAdvance([{ price: 100 }]);
  const f1 = await issued("regular_invoice", { items: [{ price: 300 }] });
  await setDed(f1, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 40, vat_amount: 9.2 }]);
  await finalize(U.owner, f1);
  const f2 = await issued("regular_invoice", { items: [{ price: 300 }] });
  assert.match(await errOf(setDed(f2, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 61, vat_amount: 14.03 }])), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS/);
  await setDed(f2, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 60, vat_amount: 13.8 }]);
  await finalize(U.owner, f2);
  assert.deepEqual([n((await settlement(U.owner, f1)).amount_due), n((await settlement(U.owner, f2)).amount_due)], [319.8, 295.2]);
  assert.deepEqual([n((await settlement(U.owner, a)).advance_consumed), n((await settlement(U.owner, a)).advance_remaining)], [123, 0]);
});
await check("konečná faktúra s doplatkom 0: celá suma pokrytá zálohou → na úhradu 0, stav uhradená, žiadny preplatok", async () => {
  const a = await issuedAdvance([{ price: 100 }]);
  const fin = await issued("regular_invoice", { items: [{ price: 100 }] });
  await setDed(fin, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }]);
  await finalize(U.owner, fin);
  const f = await inv(fin);
  assert.deepEqual([n(f.subtotal_amount), n(f.vat_total_amount), n(f.total_amount), f.payment_status], [0, 0, 0, "paid"]);
  const s = await settlement(U.owner, fin);
  assert.deepEqual([n(s.amount_due), n(s.balance), s.payment_status], [0, 0, "paid"]);
  const r = NEW.generate.generateUbl(await snapshotOf(fin));
  assert.ok(r.ok && xmlAll(r.xml, "PayableAmount")[0] === "0.00");
});
await check("zlá sadzba voči zálohe → odmietnutá (ESBLU_ADVANCE_DEDUCTION_RATE_MISMATCH); cudzia/iná záloha → INVALID", async () => {
  const a = await issuedAdvance([{ price: 100, rate: 23 }]);
  const fin = await issued("regular_invoice", { items: [{ price: 300, rate: 19 }] });
  assert.match(await errOf(setDed(fin, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 19, taxable_amount: 100, vat_amount: 19 }])), /ESBLU_ADVANCE_DEDUCTION_RATE_MISMATCH/);
  const other = await issued("regular_invoice", { partner: P.other });
  assert.match(await errOf(setDed(other, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 1, vat_amount: 0.23 }])), /ESBLU_ADVANCE_DEDUCTION_INVALID/, "záloha iného odberateľa");
  assert.match(await errOf(setDed(fin, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 1, vat_amount: 0.23 }], U.ownerB)), /NOT_FOUND|FORBIDDEN/, "cudzia firma");
});
await check("nezdanená záloha → PrepaidAmount, rozpis DPH nemení; spolu so zdanenou; nad sumu faktúry → odmietnutá", async () => {
  const fin = await issued("regular_invoice", { items: [{ price: 300 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_compliance_fields($1, $2::jsonb)", [fin, JSON.stringify({ untaxed_prepaid_amount: 50, untaxed_prepaid_reference: "PF20260001" })]);
  const a = await issuedAdvance([{ price: 100 }]);
  await setDed(fin, [{ advance_invoice_id: a, vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }]);
  await finalize(U.owner, fin);
  assert.deepEqual(await breakdownOf(fin), [["S", 23, 200, 46]], "nezdanená záloha nemení DPH");
  const s = await settlement(U.owner, fin);
  assert.deepEqual([n(s.original_total), n(s.prepaid_untaxed), n(s.advances_taxed), n(s.amount_due)], [246, 50, 123, 196]);
  const r = NEW.generate.generateUbl(await snapshotOf(fin));
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(xmlAll(r.xml, "PrepaidAmount"), ["50.00"]);
    assert.deepEqual(xmlAll(r.xml, "PayableAmount"), ["196.00"]);
  }
  const big = await issued("regular_invoice", { items: [{ price: 10 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_compliance_fields($1, $2::jsonb)", [big, JSON.stringify({ untaxed_prepaid_amount: 100 })]);
  assert.match(await errOf(finalize(U.owner, big)), /ESBLU_UNTAXED_PREPAID_EXCEEDS_TOTAL/);
  const adv = await issued("payment_received_invoice", { header: { tax_point_date: "2026-10-01", delivery_date: null } });
  assert.match(await errOf(rpc(U.owner, "select public.esblu_set_invoice_compliance_fields($1, $2::jsonb)", [adv, JSON.stringify({ untaxed_prepaid_amount: 1 })])), /ESBLU_UNTAXED_PREPAID_KIND/);
});
await check("chýbajúca BillingReference (BT-25) alebo staršia faktúra s odpočtom mimo riadkov → e-faktúra sa nevygeneruje", async () => {
  const s = await snapshotOf(TFIN1);
  const noRef = { ...s, advanceInvoices: [] };
  const r = NEW.generate.generateUbl(noRef);
  assert.ok(!r.ok && r.issues.some((i) => i.code === "ADVANCE_REFERENCE_MISSING"));
  const legacy = { ...s, items: s.items.filter((i) => !i.is_advance_deduction), legacyAdvanceDeduction: true };
  const l = NEW.generate.generateUbl(legacy);
  assert.ok(!l.ok && l.issues.some((i) => i.code === "ADVANCE_DEDUCTION_EINVOICE_UNSUPPORTED"));
});
await check("klient nemôže vložiť ani zmeniť riadok odpočtu ani nezdanenú zálohu priamo (iba DB/RPC)", async () => {
  const fin = await issued("regular_invoice");
  assert.match(await errOf(rpc(U.owner, `insert into public.invoice_items (invoice_id, position, description, quantity, unit, unit_price, vat_category_code, vat_rate, is_advance_deduction)
    values ($1, 99, 'x', 1, 'ks', -10, 'S', 23, true)`, [fin])), /ESBLU_ADVANCE_LINE_PROTECTED/);
  assert.notEqual(await errOf(rpc(U.owner, `insert into public.invoice_items (invoice_id, position, description, quantity, unit, unit_price, vat_category_code, vat_rate)
    values ($1, 98, 'x', 1, 'ks', -10, 'S', 23)`, [fin])), "OK", "záporná cena bežnej položky");
  assert.match(await errOf(rpc(U.owner, "update public.invoices set untaxed_prepaid_amount = 5 where id = $1", [fin])), /ESBLU_ADVANCE_REVIEW_FIELDS_PROTECTED/);
  assert.match(await errOf(svc("delete from public.invoice_items where invoice_id = $1 and is_advance_deduction", [TFIN1])), /ESBLU_INVOICE_ITEMS_FINALIZED_IMMUTABLE/);
});
await check("PDF súčty: položky − mínusové riadky = spolu; na úhradu = spolu − nezdanená záloha (advanceSummary použitý v PDF)", async () => {
  const { advanceSummary } = await import("../lib/invoicing/advance-summary.ts");
  const fin = (await h.sql<{ id: string }>("select id from public.invoices where untaxed_prepaid_amount = 50 and document_status = 'finalized' limit 1")).rows[0].id;
  const f = await inv(fin);
  const its = (await h.sql<Row>("select description, is_advance_deduction, line_net_amount, line_vat_amount, line_gross_amount from public.invoice_items where invoice_id = $1", [fin])).rows;
  const sum = advanceSummary({ totalAmount: f.total_amount as string, untaxedPrepaidAmount: f.untaxed_prepaid_amount as string, items: its as never });
  assert.deepEqual([sum.itemsTotal, sum.taxedDeductions.map((d) => [d.taxable, d.vat, d.gross]), sum.total, sum.untaxedPrepaid, sum.payable],
    [369, [[100, 23, 123]], 246, 50, 196]);
  assert.equal(sum.itemsTotal - sum.taxedDeductions.reduce((s, d) => s + d.gross, 0), sum.total);
  const pdf = readFileSync(new URL("../lib/invoicing/pdf-renderer.tsx", import.meta.url), "utf8");
  assert.match(pdf, /advanceSummary\(\{ totalAmount: invoice\.total_amount, untaxedPrepaidAmount/);
  assert.match(pdf, /invoices\.pdf\.advanceLineDetail/);
});

// =============================================================================
// 20261008100008 — prijatá faktúra k prijatej platbe (386) a prijatá konečná faktúra so zálohami (BT-113).
// SYNTETICKÉ UBL (označené) — reálny tok poskytovateľa pokrýva sandbox E2E (docs/einvoice-accounting-flow-e2e-2026-10.md).
// =============================================================================
const SUPPLIER2 = { name: "Iný dodávateľ s.r.o.", ico: "31411802", vat: "SK2024444440", endpoint: "2024444440" };
const advXml = (id: string, net: number, o: { date?: string; taxPoint?: string; supplier?: typeof SUPPLIER; note?: string; customerEndpoint?: string } = {}) =>
  ubl({ root: "Invoice", type: "386", id, date: o.date ?? "2026-09-01", taxPoint: o.taxPoint ?? "2026-08-30", lines: [{ qty: 1, price: net }], supplier: o.supplier, note: o.note, customerEndpoint: o.customerEndpoint });

let RADV1 = "", RADV1_INBOUND = "", RADV1_SHA = "", RFIN1 = "", RFIN1_INBOUND = "", RFIN1_SHA = "";
await check("386 prijatá: samostatný druh payment_received_invoice, dodávateľ, sumy, rozpis DPH, BT-7; XML nemenné", async () => {
  const xml = advXml("ZF-ADV-1", 100);
  const parsed = parseInboundUbl(new TextEncoder().encode(xml));
  assert.ok(parsed.ok);
  const m = mapInboundDraft(parsed.ok ? parsed.document : (null as never), [], null);
  assert.ok(m.ok && m.draft.document_kind === "payment_received_invoice" && !m.reviewReasons.includes("INVOICE_TYPE_CODE_UNUSUAL"));
  const r = await receive(CO.A, "org-a", xml);
  assert.equal(r.result?.status, "created");
  RADV1 = r.result!.invoiceId; RADV1_INBOUND = r.inboundId; RADV1_SHA = r.sha!;
  const a = await inv(RADV1);
  const tp = (await h.sql<{ d: string }>("select tax_point_date::text d from public.invoices where id = $1", [RADV1])).rows[0].d;
  assert.deepEqual([a.kind, a.direction, a.document_status, a.supplier_invoice_number, tp],
    ["payment_received_invoice", "received", "draft", "ZF-ADV-1", "2026-08-30"]);
  assert.ok(a.supplier_business_partner_id, "dodávateľ priradený");
  assert.equal(a.company_id, CO.A);
  assert.deepEqual([n(a.subtotal_amount), n(a.vat_total_amount), n(a.total_amount), a.prepaid_amount], [100, 23, 123, null]);
  const b = (await h.sql<Row>("select vat_category_code c, vat_rate::float8 r, taxable_amount::float8 t, vat_amount::float8 v from public.invoice_tax_breakdowns where invoice_id = $1", [RADV1])).rows;
  assert.deepEqual(b.map((x) => [x.c, x.r, x.t, x.v]), [["S", 23, 100, 23]]);
  await finalize(U.owner, RADV1);
  assert.equal((await inv(RADV1)).document_status, "finalized");
  const row = (await h.sql<Row>("select xml_sha256 from public.einvoice_inbound where id = $1", [RADV1_INBOUND])).rows[0];
  assert.equal(row.xml_sha256, RADV1_SHA);
  assert.notEqual(await errOf(svc("update public.einvoice_inbound set xml_sha256 = $2 where id = $1", [RADV1_INBOUND, "1".repeat(64)])), "OK");
  // Žiadne automatické rozhodnutie o odpočte DPH: záloha nemá žiadny stav odpočtu, iba evidenciu.
  assert.equal(a.advance_review_status, null);
});
await check("duplicitná 386 (rovnaké XML aj iné XML s rovnakým číslom) → žiadna druhá záloha", async () => {
  const before = (await h.sql<{ n: number }>("select count(*)::int n from public.invoices where kind = 'payment_received_invoice' and direction = 'received' and company_id = $1", [CO.A])).rows[0].n;
  const same = await receive(CO.A, "org-a", advXml("ZF-ADV-1", 100));
  assert.equal(same.result?.status, "duplicate");
  assert.equal(same.result?.invoiceId, RADV1);
  const other = await receive(CO.A, "org-a", advXml("ZF-ADV-1", 100, { note: "replay s inou poznámkou" }));
  assert.equal(other.result?.status, "duplicate");
  assert.equal(other.result?.invoiceId, RADV1);
  const after = (await h.sql<{ n: number }>("select count(*)::int n from public.invoices where kind = 'payment_received_invoice' and direction = 'received' and company_id = $1", [CO.A])).rows[0].n;
  assert.equal(after, before);
});
// --- Prijatá konečná faktúra podľa FS (príklad 38): mínusový riadok zálohy + BT-25 (SYNTETICKÉ UBL) --------
const finFs = (id: string, items: Line[], deductions: { price: number; rate?: number }[], refs: { id: string; date?: string }[],
  o: { prepaid?: number; supplier?: typeof SUPPLIER; vatOverride?: Record<string, number>; customerEndpoint?: string } = {}) =>
  ubl({ root: "Invoice", type: "380", id, date: "2026-09-25", lines: [...items, ...deductions.map((d) => ({ qty: -1, price: d.price, rate: d.rate }))],
    refs, prepaid: o.prepaid, supplier: o.supplier, vatOverride: o.vatOverride, customerEndpoint: o.customerEndpoint });
const rlinks = (id: string) => h.sql<Row>(`select advance_invoice_id, vat_category_code c, vat_rate::float8 r, amount::float8 amount, taxable_amount::float8 t,
  vat_amount::float8 v, source from public.received_advance_links where invoice_id = $1 order by taxable_amount desc`, [id]).then((r) => r.rows);
const recvAdv = async (no: string, net: number, o: Parameters<typeof advXml>[2] = {}, finalizeIt = true) => {
  const id = (await receive(o.customerEndpoint ? CO.B : CO.A, o.customerEndpoint ? "org-b" : "org-a", advXml(no, net, o))).result!.invoiceId;
  if (finalizeIt) await finalize(o.customerEndpoint ? U.ownerB : U.owner, id);
  return id;
};

await check("prijatá konečná faktúra s mínusovým riadkom zálohy → riadok odpočtu, návrh väzby po sadzbe; saldo bez dvojitého odpočtu", async () => {
  const r = await receive(CO.A, "org-a", finFs("ZF-FIN-1", [{ qty: 1, price: 300 }], [{ price: 100 }], [{ id: "ZF-ADV-1", date: "2026-09-01" }]));
  assert.equal(r.result?.status, "created", JSON.stringify(r.mapped));
  RFIN1 = r.result!.invoiceId; RFIN1_INBOUND = r.inboundId; RFIN1_SHA = r.sha!;
  const f = await inv(RFIN1);
  assert.deepEqual([n(f.subtotal_amount), n(f.vat_total_amount), n(f.total_amount), f.prepaid_amount, f.advance_review_status], [200, 46, 246, null, "proposed"]);
  const ded = (await h.sql<Row>("select quantity::float8 q, unit_price::float8 p, line_net_amount::float8 net, line_vat_amount::float8 vat from public.invoice_items where invoice_id = $1 and is_advance_deduction", [RFIN1])).rows;
  assert.deepEqual(ded.map((d) => [d.q, d.p, d.net, d.vat]), [[1, -100, -100, -23]]);
  assert.deepEqual(await rlinks(RFIN1), [{ advance_invoice_id: RADV1, c: "S", r: 23, amount: 123, t: 100, v: 23, source: "auto" }]);
  await finalize(U.owner, RFIN1);
  const g = await inv(RFIN1);
  assert.deepEqual([g.document_status, g.advance_review_status], ["finalized", "linked"]);
  const s = await settlement(U.owner, RFIN1);
  assert.deepEqual([n(s.items_total), n(s.advances_taxed), n(s.original_total), n(s.advances_deducted), n(s.amount_due)], [369, 123, 246, 0, 246]);
  const sa = await settlement(U.owner, RADV1);
  assert.deepEqual([n(sa.advance_consumed), n(sa.advance_remaining)], [123, 0]);
});
await check("zostatok po odpočte: úhrada 246 → uhradená; ďalších 10 → preplatená; vrátenie → uhradená", async () => {
  await pay(RFIN1, 246);
  assert.equal((await inv(RFIN1)).payment_status, "paid");
  await pay(RFIN1, 10);
  assert.equal((await inv(RFIN1)).payment_status, "overpaid");
  await refund(RFIN1, 10);
  assert.equal(n((await settlement(U.owner, RFIN1)).balance), 0);
});
await check("prijatá konečná faktúra s viacerými zálohami → každý mínusový riadok priradený jednoznačne (presný zostatok)", async () => {
  const a2 = await recvAdv("ZF-ADV-2", 100);
  const a3 = await recvAdv("ZF-ADV-3", 50);
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-2", [{ qty: 1, price: 400 }], [{ price: 100 }, { price: 50 }], [{ id: "ZF-ADV-2" }, { id: "ZF ADV 3" }]))).result!.invoiceId;
  assert.equal((await inv(fin)).advance_review_status, "proposed");
  assert.deepEqual((await rlinks(fin)).map((l) => [l.advance_invoice_id, l.t, l.v]), [[a2, 100, 23], [a3, 50, 11.5]]);
  await finalize(U.owner, fin);
  assert.equal(n((await settlement(U.owner, fin)).amount_due), 492 - 184.5);
});
let RMISS = "";
await check("záloha nenájdená → review ADVANCE_NOT_FOUND, finalizácia zablokovaná; po príchode zálohy sa spáruje; bez BT-25 → review", async () => {
  RMISS = (await receive(CO.A, "org-a", finFs("ZF-FIN-3", [{ qty: 1, price: 200 }], [{ price: 50 }], [{ id: "ZF-ADV-LATE" }]))).result!.invoiceId;
  assert.deepEqual([(await inv(RMISS)).advance_review_status, (await inv(RMISS)).advance_review_reasons], ["review", ["ADVANCE_NOT_FOUND"]]);
  assert.match(await errOf(finalize(U.owner, RMISS)), /ESBLU_RECEIVED_ADVANCE_REVIEW_REQUIRED/);
  const late = await recvAdv("ZF-ADV-LATE", 50, {}, false);
  assert.equal((await inv(RMISS)).advance_review_status, "proposed");
  assert.deepEqual((await rlinks(RMISS)).map((l) => l.advance_invoice_id), [late]);
  assert.match(await errOf(finalize(U.owner, RMISS)), /ESBLU_RECEIVED_ADVANCE_NOT_FINALIZED/, "záloha ešte koncept");
  await finalize(U.owner, late);
  await finalize(U.owner, RMISS);
  assert.equal((await inv(RMISS)).advance_review_status, "linked");
  const noRef = (await receive(CO.A, "org-a", finFs("ZF-FIN-4", [{ qty: 1, price: 200 }], [{ price: 10 }], []))).result!.invoiceId;
  assert.deepEqual((await inv(noRef)).advance_review_reasons, ["ADVANCE_REFERENCE_MISSING"]);
});
await check("nejednoznačná záloha (2 zálohy s rovnakým číslom, rôzne dátumy; syntetický stav DB) → ADVANCE_AMBIGUOUS; s BT-26 jednoznačná", async () => {
  const a = await recvAdv("ZF-ADV-AMB", 100, { date: "2026-01-10" });
  await svc(`insert into public.invoices (company_id, direction, kind, document_status, issue_date, tax_point_date, currency, supplier_business_partner_id, supplier_invoice_number, received_at, source, subtotal_amount, vat_total_amount, total_amount)
             select company_id, direction, kind, 'draft', '2026-05-10', tax_point_date, currency, supplier_business_partner_id, supplier_invoice_number, received_at, 'manual', subtotal_amount, vat_total_amount, total_amount from public.invoices where id = $1`, [a]);
  const amb = (await receive(CO.A, "org-a", finFs("ZF-FIN-5", [{ qty: 1, price: 200 }], [{ price: 100 }], [{ id: "ZF-ADV-AMB" }]))).result!.invoiceId;
  assert.deepEqual([(await inv(amb)).advance_review_status, (await inv(amb)).advance_review_reasons], ["review", ["ADVANCE_AMBIGUOUS"]]);
  const dated = (await receive(CO.A, "org-a", finFs("ZF-FIN-6", [{ qty: 1, price: 200 }], [{ price: 100 }], [{ id: "ZF-ADV-AMB", date: "2026-01-10" }]))).result!.invoiceId;
  assert.equal((await inv(dated)).advance_review_status, "proposed");
  assert.deepEqual((await rlinks(dated)).map((l) => l.advance_invoice_id), [a]);
});
await check("zlý dodávateľ: záloha od iného dodávateľa → ADVANCE_SUPPLIER_MISMATCH; ručné priradenie odmietnuté", async () => {
  const w = await recvAdv("ZF-ADV-W", 100, { supplier: SUPPLIER2 });
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-7", [{ qty: 1, price: 200 }], [{ price: 100 }], [{ id: "ZF-ADV-W" }]))).result!.invoiceId;
  assert.deepEqual((await inv(fin)).advance_review_reasons, ["ADVANCE_SUPPLIER_MISMATCH"]);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_link($1, $2, 100)", [fin, w])), /ESBLU_RECEIVED_ADVANCE_SUPPLIER_MISMATCH/);
  assert.ok(!(await rpc<Row>(U.owner, "select advance_invoice_id from public.esblu_received_advance_candidates($1)", [fin])).some((c) => c.advance_invoice_id === w));
});
await check("cross-tenant: záloha firmy B sa na faktúru A nenaviaže (ani automaticky, ani ručne); B nevidí väzby A", async () => {
  const bAdv = await recvAdv("ZF-ADV-X", 100, { customerEndpoint: "2022222220" });
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-8", [{ qty: 1, price: 200 }], [{ price: 100 }], [{ id: "ZF-ADV-X" }]))).result!.invoiceId;
  assert.deepEqual((await inv(fin)).advance_review_reasons, ["ADVANCE_NOT_FOUND"], "cudzí doklad = neexistuje (žiadny únik)");
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_link($1, $2, 100)", [fin, bAdv])), /ESBLU_RECEIVED_ADVANCE_NOT_FOUND/);
  assert.match(await errOf(rpc(U.ownerB, "select public.esblu_received_advance_link($1, $2, 100)", [fin, bAdv])), /ESBLU_INVOICE_NOT_FOUND/);
  assert.match(await errOf(rpc(U.ownerB, "select public.esblu_received_advance_confirm($1)", [RFIN1])), /ESBLU_INVOICE_NOT_FOUND/);
  assert.equal((await rpc(U.ownerB, "select * from public.received_advance_links")).length, 0);
  assert.notEqual(await errOf(svc("insert into public.received_advance_links (company_id, invoice_id, advance_invoice_id, vat_category_code, vat_rate, amount, taxable_amount, vat_amount, source) values ($1, $2, $3, 'S', 23, 0, 1, null, 'manual')", [CO.A, fin, bAdv])), "OK", "ani service_role cez guard");
});
await check("dvojitý odpočet: spotrebovaná záloha → ADVANCE_ALREADY_DEDUCTED; ručne → ESBLU_RECEIVED_ADVANCE_EXCEEDS", async () => {
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-9", [{ qty: 1, price: 200 }], [{ price: 100 }], [{ id: "ZF-ADV-1" }]))).result!.invoiceId;
  assert.deepEqual((await inv(fin)).advance_review_reasons, ["ADVANCE_ALREADY_DEDUCTED"]);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_link($1, $2, 1)", [fin, RADV1])), /ESBLU_RECEIVED_ADVANCE_EXCEEDS/);
  const a = await recvAdv("ZF-ADV-HOLD", 100);
  const f1 = (await receive(CO.A, "org-a", finFs("ZF-FIN-10", [{ qty: 1, price: 200 }], [{ price: 100 }], [{ id: "ZF-ADV-HOLD" }]))).result!.invoiceId;
  const f2 = (await receive(CO.A, "org-a", finFs("ZF-FIN-11", [{ qty: 1, price: 200 }], [{ price: 100 }], [{ id: "ZF-ADV-HOLD" }]))).result!.invoiceId;
  assert.equal((await inv(f1)).advance_review_status, "proposed");
  assert.deepEqual((await inv(f2)).advance_review_reasons, ["ADVANCE_ALREADY_DEDUCTED"], "návrh na koncepte drží zálohu");
  assert.ok(a);
  assert.match(await errOf(svc("update public.received_advance_links set amount = 1 where invoice_id = $1", [f1])), /ESBLU_RECEIVED_ADVANCE_LINK_LOCKED/);
});
await check("sadzba mínusového riadku ≠ sadzba zálohy → ADVANCE_RATE_MISMATCH; ručne → ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH", async () => {
  const a = await recvAdv("ZF-ADV-R23", 100);
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-12", [{ qty: 1, price: 200, rate: 19 }], [{ price: 100, rate: 19 }], [{ id: "ZF-ADV-R23" }]))).result!.invoiceId;
  assert.deepEqual((await inv(fin)).advance_review_reasons, ["ADVANCE_RATE_MISMATCH"]);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_link($1, $2)", [fin, a])), /ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH/);
});
await check("DPH mínusového riadku nesedí s DPH zálohy → review ADVANCE_VAT_MISMATCH (žiadna automatická interpretácia)", async () => {
  await recvAdv("ZF-ADV-V", 10.01);
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-13", [{ qty: 1, price: 10.02 }], [{ price: 10.01 }], [{ id: "ZF-ADV-V" }]))).result!.invoiceId;
  assert.deepEqual((await inv(fin)).advance_review_reasons, ["ADVANCE_VAT_MISMATCH"]);
  assert.equal((await rlinks(fin)).length, 0);
});
await check("rekapitulácia podľa FS (DPH položiek − DPH zálohy, odchýlka 0,01 od základ × sadzba) → prijatá, spárovaná, finalizovateľná", async () => {
  await recvAdv("ZF-ADV-T", 0.03);
  const xml = finFs("ZF-FIN-14", [{ qty: 1, price: 10.02 }], [{ price: 0.03 }], [{ id: "ZF-ADV-T" }], { vatOverride: { "S|23": 2.29 } });
  const r = await receive(CO.A, "org-a", xml);
  assert.equal(r.result?.status, "created", JSON.stringify(r.mapped));
  const fin = r.result!.invoiceId;
  assert.deepEqual([n((await inv(fin)).vat_total_amount), (await inv(fin)).advance_review_status], [2.29, "proposed"]);
  assert.deepEqual((await rlinks(fin)).map((l) => [l.t, l.v]), [[0.03, 0.01]]);
  await finalize(U.owner, fin);
  assert.equal(n((await inv(fin)).vat_total_amount), 2.29, "finalizácia drží DPH z XML");
});
await check("ručné párovanie: kandidáti, čiastočné priradenie → review, odobratie, plné → linked; zamietnutie návrhu s dôvodom; potvrdenie účtovníkom", async () => {
  const a = await recvAdv("ZF-ADV-M", 200);
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-15", [{ qty: 1, price: 500 }], [{ price: 200 }], [{ id: "ZF-ADV-UNKNOWN" }]))).result!.invoiceId;
  const cands = await rpc<Row>(U.owner, "select advance_invoice_id, remaining_amount::float8 r from public.esblu_received_advance_candidates($1)", [fin]);
  assert.ok(cands.some((c) => c.advance_invoice_id === a && c.r === 246));
  assert.ok(!cands.some((c) => c.advance_invoice_id === RADV1), "spotrebovaná záloha sa neponúka");
  assert.equal((await rpc<{ s: string }>(U.owner, "select public.esblu_received_advance_link($1, $2, 80) s", [fin, a]))[0].s, "review");
  assert.deepEqual((await inv(fin)).advance_review_reasons, ["ADVANCE_PARTIALLY_ASSIGNED"]);
  assert.match(await errOf(finalize(U.owner, fin)), /ESBLU_RECEIVED_ADVANCE_REVIEW_REQUIRED/);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_link($1, $2, 120)", [fin, a])), /ESBLU_RECEIVED_ADVANCE_ALREADY_LINKED/);
  await rpc(U.owner, "select public.esblu_received_advance_unlink($1, $2)", [fin, a]);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_link($1, $2, 250)", [fin, a])), /ESBLU_RECEIVED_ADVANCE_EXCEEDS/);
  assert.equal((await rpc<{ s: string }>(U.owner, "select public.esblu_received_advance_link($1, $2) s", [fin, a]))[0].s, "linked", "predvolene = zvyšok");
  const l = await rlinks(fin);
  assert.deepEqual([l[0].t, l[0].v, l[0].c, l[0].r, l[0].source], [200, 46, "S", 23, "manual"]);
  const b = await recvAdv("ZF-ADV-RJ", 10);
  const fr = (await receive(CO.A, "org-a", finFs("ZF-FIN-16", [{ qty: 1, price: 100 }], [{ price: 10 }], [{ id: "ZF-ADV-RJ" }]))).result!.invoiceId;
  assert.equal((await inv(fr)).advance_review_status, "proposed");
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_reject($1, '')", [fr])), /ESBLU_ADVANCE_REVIEW_NOTE_REQUIRED/);
  await rpc(U.owner, "select public.esblu_received_advance_reject($1, 'Záloha patrí k inej zákazke')", [fr]);
  const rj = await inv(fr);
  assert.deepEqual([rj.advance_review_status, rj.advance_review_reasons, rj.advance_review_note], ["review", ["ADVANCE_LINK_REJECTED"], "Záloha patrí k inej zákazke"]);
  assert.equal((await rlinks(fr)).length, 0);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_confirm($1)", [fr])), /ESBLU_RECEIVED_ADVANCE_NOT_PROPOSED/);
  await rpc(U.owner, "select public.esblu_received_advance_link($1, $2)", [fr, b]);
  assert.equal((await inv(fr)).advance_review_status, "linked");
  await recvAdv("ZF-ADV-C", 10);
  const fc = (await receive(CO.A, "org-a", finFs("ZF-FIN-17", [{ qty: 1, price: 100 }], [{ price: 10 }], [{ id: "ZF-ADV-C" }]))).result!.invoiceId;
  assert.equal((await rpc<{ s: string }>(U.accountant, "select public.esblu_received_advance_confirm($1) s", [fc]))[0].s, "linked", "účtovník potvrdí návrh");
});
await check("BT-113 = nezdanená záloha: bez mínusových riadkov sa nič nepáruje, finalizácia bez review, na úhradu = celkom − BT-113", async () => {
  const fin = (await receive(CO.A, "org-a", finFs("ZF-FIN-18", [{ qty: 1, price: 200 }], [], [], { prepaid: 50 }))).result!.invoiceId;
  const f = await inv(fin);
  assert.deepEqual([n(f.total_amount), n(f.prepaid_amount), f.advance_review_status], [246, 50, null]);
  await finalize(U.owner, fin);
  const s = await settlement(U.owner, fin);
  assert.deepEqual([n(s.prepaid_untaxed), n(s.advances_taxed), n(s.amount_due)], [50, 0, 196]);
});
await check("role: employee bez financií nič nevidí ani nemení; klient nemení polia review, riadky odpočtu ani väzby priamo", async () => {
  assert.match(await errOf(rpc(U.employee, "select public.esblu_received_advance_confirm($1)", [RFIN1])), /FORBIDDEN/);
  assert.match(await errOf(rpc(U.employee, "select public.esblu_received_advance_link($1, $2, 1)", [RFIN1, RADV1])), /FORBIDDEN/);
  assert.match(await errOf(rpc(U.employee, "select * from public.esblu_received_advance_candidates($1)", [RFIN1])), /FORBIDDEN/);
  assert.equal((await rpc(U.employee, "select * from public.received_advance_links")).length, 0);
  assert.ok((await rpc(U.accountant, "select * from public.received_advance_links")).length > 0, "účtovník vidí väzby");
  const draftFin = (await receive(CO.A, "org-a", finFs("ZF-FIN-19", [{ qty: 1, price: 100 }], [{ price: 5 }], [{ id: "ZF-NOTHING" }]))).result!.invoiceId;
  assert.match(await errOf(rpc(U.owner, "update public.invoices set advance_review_status = 'linked' where id = $1", [draftFin])), /ESBLU_ADVANCE_REVIEW_FIELDS_PROTECTED/);
  assert.match(await errOf(rpc(U.owner, "update public.invoice_items set unit_price = -1 where invoice_id = $1 and is_advance_deduction", [draftFin])), /ESBLU_ADVANCE_LINE_PROTECTED/);
  assert.notEqual(await errOf(rpc(U.owner, "insert into public.received_advance_links (company_id, invoice_id, advance_invoice_id, vat_category_code, vat_rate, amount, taxable_amount, source) values ($1, $2, $3, 'S', 23, 0, 1, 'manual')", [CO.A, draftFin, RADV1])), "OK");
});
await check("nemenné XML a väzby: hash zálohy aj konečnej faktúry sedí; väzby a riadky odpočtu finalizovanej faktúry sa nedajú zmeniť", async () => {
  for (const [id, sha] of [[RADV1_INBOUND, RADV1_SHA], [RFIN1_INBOUND, RFIN1_SHA]]) {
    const row = (await h.sql<Row>("select xml_sha256 from public.einvoice_inbound where id = $1", [id])).rows[0];
    assert.equal(row.xml_sha256, sha);
    assert.notEqual(await errOf(svc("update public.einvoice_inbound set xml_storage_path = 'x' where id = $1", [id])), "OK");
  }
  assert.match(await errOf(svc("delete from public.received_advance_links where invoice_id = $1", [RFIN1])), /ESBLU_RECEIVED_ADVANCE_LINK_LOCKED/);
  assert.match(await errOf(svc("delete from public.invoice_items where invoice_id = $1 and is_advance_deduction", [RFIN1])), /ESBLU_INVOICE_ITEMS_FINALIZED_IMMUTABLE/);
  assert.match(await errOf(rpc(U.owner, "select public.esblu_received_advance_unlink($1, $2)", [RFIN1, RADV1])), /ESBLU_RECEIVED_ADVANCE_LINK_LOCKED/);
});
await check("DB druhá vrstva: BT-113 na 386 alebo oprave → odmietnuté; BT-113 > celkom → odmietnuté", async () => {
  const r = await receive(CO.A, "org-a", advXml("ZF-ADV-DB", 10));
  const draft = { ...(r.mapped as { ok: true; draft: Record<string, unknown> }).draft, invoice_number: "ZF-ADV-DB2" } as Record<string, unknown>;
  const totals = { ...(draft.totals as Record<string, unknown>), prepaid: "1.00", payable: "11.30" };
  const reg = await h.inbound.register({ provider: "efaktura_sk", environment: "sandbox", providerOrgId: "org-a", providerReceivedId: "rcv-db-prepaid", source: "poll",
    meta: { sender_participant_id: null, sender_ico: null, document_number: null, document_type: null, is_test: true } });
  const bytes = new TextEncoder().encode(advXml("ZF-ADV-DB2", 10));
  const sha = createHash("sha256").update(bytes).digest("hex");
  await h.inbound.putXml(`${CO.A}/efaktura_sk/rcv-db-prepaid/${sha}.xml`, bytes);
  await h.inbound.transition(reg.inboundId, "received", "stored", "job", null, { xml_sha256: sha, xml_storage_path: `${CO.A}/efaktura_sk/rcv-db-prepaid/${sha}.xml`, xml_size_bytes: bytes.byteLength });
  await h.inbound.transition(reg.inboundId, "stored", "parsed", "job", null, { document_number: "ZF-ADV-DB2", document_type: "Invoice", review_reasons: [] });
  assert.match(await errOf(h.inbound.createDraft(reg.inboundId, { ...draft, totals } as never)), /ESBLU_EINVOICE_TOTALS_INCONSISTENT/);
  const over = { ...draft, document_kind: "regular_invoice", totals: { ...(draft.totals as Record<string, unknown>), prepaid: "20.00", payable: "-7.70" } };
  assert.match(await errOf(h.inbound.createDraft(reg.inboundId, over as never)), /ESBLU_EINVOICE_TOTALS_INCONSISTENT/);
});
await check("export: typ odpočtu (zdanený riadok / nezdanená BT-113 / staršie), odkaz na 386, základ a DPH; 386 ako samostatný druh; originálne XML", async () => {
  const src = readFileSync(new URL("../app/api/accounting-handoff/package/route.ts", import.meta.url), "utf8");
  for (const re of [/"deduction_type"/, /"taxed_line"/, /"untaxed_prepaid"/, /"legacy_outside_lines"/, /received-advance-links\.csv/, /advance_invoice_number/, /"untaxed_prepaid_amount"\]/, /from\("received_advance_links"\)/]) {
    assert.match(src, re);
  }
  const rec = await rpc<Row>(U.owner, `select f.supplier_invoice_number fin, a.supplier_invoice_number adv, a.kind, l.vat_category_code c, l.vat_rate::float8 r,
    l.taxable_amount::float8 t, l.vat_amount::float8 v from public.received_advance_links l join public.invoices f on f.id = l.invoice_id
    join public.invoices a on a.id = l.advance_invoice_id where f.id = $1`, [RFIN1]);
  assert.deepEqual(rec.map((x) => [x.fin, x.adv, x.kind, x.c, x.r, x.t, x.v]), [["ZF-FIN-1", "ZF-ADV-1", "payment_received_invoice", "S", 23, 100, 23]]);
  const iss = await rpc<Row>(U.owner, `select d.taxable_amount::float8 t, d.vat_amount::float8 v, a.invoice_number adv,
    exists (select 1 from public.invoice_items it where it.invoice_id = d.invoice_id and it.is_advance_deduction) as taxed_line
    from public.invoice_advance_deductions d join public.invoices a on a.id = d.advance_invoice_id where d.invoice_id = $1`, [TFIN1]);
  assert.deepEqual(iss.map((x) => [x.t, x.v, x.taxed_line]), [[100, 23, true]]);
  assert.equal((await rpc(U.ownerB, `select 1 from public.received_advance_links l where l.company_id = $1`, [CO.A])).length, 0);
  const xmls = await rpc<Row>(U.owner, "select i.invoice_id from public.einvoice_inbound i where i.invoice_id = any($1::uuid[])", [[RADV1, RFIN1]]);
  assert.ok(xmls.length >= 2, "XML zálohy aj konečnej faktúry dostupné pre balík (pod RLS)");
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

// =============================================================================
// Pre-production audit (10/2026): doručenie / prijatie e-faktúry NIKDY neznamená úhradu.
// payment_status mení iba ručná evidencia úhrad (RPC) a prepočet skupiny; žiadna udalosť poskytovateľa.
// =============================================================================
await check("doručenie ≠ úhrada: žiadna eFaktúra funkcia/trigger ani kód poskytovateľa nemení payment_status", async () => {
  const fns = (await h.sql<{ proname: string; src: string }>(`
    select p.proname, p.prosrc src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'esblu_einvoice%' or p.proname like 'esblu_received_advance%')`)).rows;
  assert.ok(fns.length > 20, "eFaktúra funkcie načítané");
  for (const f of fns) {
    assert.doesNotMatch(f.src, /payment_status|esblu_add_invoice_payment|esblu_recalc_invoice_group_status|invoice_payments/, f.proname);
  }
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string): string[] => readdirSync(new URL(`../${dir}`, import.meta.url)).flatMap((e) => {
    const rel = `${dir}/${e}`;
    return statSync(new URL(`../${rel}`, import.meta.url)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e) ? [rel] : [];
  });
  const files = [...walk("lib/einvoice"), ...walk("app/api/einvoice"), ...["einvoice-outbound", "einvoice-inbound", "einvoice-events", "einvoice-maintenance"].flatMap((c) => walk(`app/api/cron/${c}`))]
    .filter((f) => !f.startsWith("app/api/einvoice/staging-e2e/"));
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /payment_status|esblu_add_invoice_payment|invoice_payments|esblu_recalc_invoice_group_status/, f);
  }
});
await check("doručenie ≠ úhrada: prijatá a finalizovaná e-faktúra je neuhradená, kým sa úhrada neeviduje ručne", async () => {
  const r = await receive(CO.A, "org-a", ubl({ root: "Invoice", type: "380", id: "PAY-SEP-1", date: "2026-10-01", lines: [{ qty: 1, price: 10 }] }));
  const id = r.result!.invoiceId;
  await finalize(U.owner, id);
  assert.equal((await inv(id)).payment_status, "unpaid");
  await h.exec(`update public.einvoice_inbound set processing_status = 'acknowledged' where invoice_id = '${id}'`).catch(() => undefined);
  assert.equal((await inv(id)).payment_status, "unpaid", "ACK poskytovateľovi nemení úhradu");
  await pay(id, 12.3);
  assert.equal((await inv(id)).payment_status, "paid", "až ručná evidencia");
  const sk = readFileSync(new URL("../lib/i18n/dictionaries/sk.ts", import.meta.url), "utf8");
  assert.match(sk, /delivered: "E-faktúra bola doručená odberateľovi\. Doručenie neznamená úhradu/);
});

await check("zrušenie firmy s účtovnými dokladmi: DB zmazanie zlyhá → route to odmietne PRED mazaním Storage (žiadne čiastočné zmazanie)", async () => {
  // DB fakt: finalizovanú faktúru nemožno zmazať ani kaskádou z companies.
  assert.match(await errOf(h.exec(`delete from public.company_members where company_id = '${CO.A}'; delete from public.companies where id = '${CO.A}';`)), /ESBLU_INVOICE_FINALIZED_NO_DELETE|violates foreign key/);
  assert.equal((await h.sql<{ n: number }>("select count(*)::int n from public.companies where id = $1", [CO.A])).rows[0].n, 1, "nič sa nezmazalo");
  const src = readFileSync(new URL("../app/api/account/delete/route.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const owner = src.slice(src.indexOf('if (membership.role === "owner")'));
  const pre = owner.indexOf("countCompanyAccountingRecords(admin, membership.company_id)");
  const storage = owner.indexOf("collectOwnerStorageTargets(");
  const remove = owner.indexOf("removeStorageTargets(");
  assert.ok(pre > 0 && pre < storage && storage < remove, "kontrola účtovných záznamov beží pred zberom aj mazaním Storage");
  assert.match(owner, /COMPANY_HAS_ACCOUNTING_RECORDS[\s\S]*status: 409/);
  assert.match(src, /\{ table: "invoices", finalizedOnly: true \}/);
  assert.match(src, /\{ table: "einvoice_inbound", finalizedOnly: false \}/);
  assert.match(src, /\{ table: "einvoice_outbound", finalizedOnly: false \}/);
});

console.log(`\ninvoicing-flow: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
