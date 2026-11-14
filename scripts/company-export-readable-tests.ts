// =============================================================================
// Čitateľná vrstva exportu firmy (CITATELNY_EXPORT/) — unit + statické testy.
//   npm run test:company-export-readable
// Overuje: iba datasety technického exportu, žiadne interné/bezpečnostné logy,
// žiadne cross-tenant dáta, prázdne datasety, manifest s oboma typmi exportu,
// evidencia exportu a owner-only bez zmeny, PDF sa dajú vyrenderovať.
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANY_EXPORT_EXCLUDED, COMPANY_EXPORT_TABLES, buildEinvoiceLifecycle } from "@/lib/company-export";
import {
  buildReadableCsvFiles,
  companyOverview,
  issuedInvoiceBundles,
  issuedInvoicePdfNames,
  readableCsv,
  README_TEXT,
  READABLE_ROOT,
  READABLE_SOURCE_DATASETS,
  skDate,
  skNumber,
  type ReadableDatasets,
} from "@/lib/company-export-readable";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n       ") : String(error)}`);
  }
}

const SECRET = "SENTINEL_SHOULD_NEVER_APPEAR";
const C = "c0000000-0000-4000-8000-00000000000a";
function sample(): ReadableDatasets {
  return {
    companies: [{ id: C, name: "Firma A s.r.o.", owner_id: SECRET, plan: SECRET }],
    company_billing_profile: [{ company_id: C, legal_name: "Firma A s.r.o.", ico: "12345678", dic: "2020000000", ic_dph: "SK2020000000", address_line1: "Hlavná 1", city: "Bratislava", postal_code: "81101", country_code: "SK", contact_email: "info@firma-a.example", logo_path: SECRET }],
    company_legal_identities: [{ company_id: C, registration_id: "12345678", last_error: SECRET }],
    business_partners: [{ id: "p1", company_id: C, kind: "customer", legal_name: "Odberateľ; \"B\"", ico: "87654321", created_by: SECRET, client_mutation_id: SECRET, created_at: "2026-11-01T10:00:00Z" }],
    vehicles: [{ id: "v1", company_id: C, spz: "BA123AB", znacka: "Škoda", model: "Octavia", stk: "2027-05-01", user_id: SECRET, client_mutation_id: SECRET }],
    machines: [{ id: "m1", company_id: C, name: "Bager", serial_number: "SN-1", user_id: SECRET }],
    inventory_items: [{ id: "i1", company_id: C, name: "Skrutky", quantity: 1234.5, unit: "ks", user_id: SECRET }],
    documents: [
      { id: "d1", company_id: C, original_filename: "zmluva.pdf", document_type: "contract", storage_bucket: "ai-inbox-documents", storage_path: `${C}/zmluva.pdf`, ai_raw_output: SECRET, extracted_fields: { x: SECRET }, field_confidence: SECRET, user_id: SECRET, created_at: "2026-11-02T08:00:00Z" },
      { id: "d2", company_id: C, original_filename: "zmazany.pdf", deleted_at: "2026-11-03T00:00:00Z" },
    ],
    invoices: [
      { id: "inv1", company_id: C, direction: "issued", kind: "regular_invoice", document_status: "finalized", payment_status: "unpaid", invoice_number: "FA2026/001", issue_date: "2026-11-01", total_amount: 123, subtotal_amount: 100, vat_total_amount: 23, currency: "EUR", customer_business_partner_id: "p1", created_by: SECRET, dedupe_fingerprint: SECRET },
      { id: "inv2", company_id: C, direction: "received", kind: "regular_invoice", document_status: "draft", supplier_invoice_number: "DOD-9", issue_date: "2026-11-05", total_amount: 50, currency: "EUR" },
    ],
    invoice_parties: [{ invoice_id: "inv1", role: "seller", legal_name: "Firma A s.r.o." }, { invoice_id: "inv1", role: "buyer", legal_name: "Odberateľ" }],
    invoice_items: [{ invoice_id: "inv1", position: 1, description: "Služba", quantity: 1, unit_price: 100, vat_category_code: "S", vat_rate: 23, line_net_amount: 100 }],
    invoice_tax_breakdowns: [{ invoice_id: "inv1", vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23 }],
    invoice_advance_deductions: [],
    einvoice_inbound: [{ id: "in1", company_id: C, invoice_id: "inv2", xml_storage_path: `${C}/inbound/x.xml`, error_message: SECRET }],
    einvoice_outbound: [{ id: "out1", company_id: C, invoice_id: "inv1", ubl_storage_path: `${C}/outbound/y.xml`, idempotency_key: SECRET }],
    einvoice_lifecycle: buildEinvoiceLifecycle({
      inbound: [{ id: "in1", provider_received_id: "rcv-1", processing_status: "acknowledged", xml_sha256: "a".repeat(64), xml_storage_path: `${C}/inbound/x.xml`, received_at: "2026-11-13T19:40:28Z" }],
      outbound: [],
      events: [{ id: "e1", inbound_id: "in1", from_state: null, to_state: "received", source: "webhook", created_at: "2026-11-13T19:40:28Z" }],
      invoices: [],
    }),
  };
}
const allText = (files: { content: string | Uint8Array }[]) => files.map((f) => (typeof f.content === "string" ? f.content : "")).join("\n");

await check("zdroje: iba datasety technického exportu (každý READABLE zdroj je v COMPANY_EXPORT_TABLES alebo je einvoice_lifecycle)", () => {
  const exported = new Set(COMPANY_EXPORT_TABLES.map((t) => t.table).concat("einvoice_lifecycle"));
  for (const k of READABLE_SOURCE_DATASETS) assert.ok(exported.has(k), k);
  for (const bad of ["einvoice_webhook_events", "einvoice_webhook_rejections", "einvoice_ops_audit", "einvoice_organizations", "chat_messages", "company_members", "ai_evidence"])
    assert.ok(!(READABLE_SOURCE_DATASETS as readonly string[]).includes(bad), bad);
});

await check("čitateľná vrstva číta iba povolené datasety (Proxy) a nikdy nevypíše interné polia ani logy", () => {
  const accessed = new Set<string>();
  const d = { ...sample(), einvoice_webhook_events: [{ delivery_id: SECRET, body_sha256: SECRET }], einvoice_ops_audit: [{ actor: SECRET }], chat_messages: [{ body: SECRET }] } as Record<string, unknown>;
  const proxy = new Proxy(d, { get: (t, k) => { if (typeof k === "string") accessed.add(k); return t[k as string]; } }) as ReadableDatasets;
  const files = buildReadableCsvFiles(proxy);
  issuedInvoiceBundles(proxy);
  companyOverview(proxy, "2026-11-14T10:00:00Z", {});
  for (const k of accessed) assert.ok((READABLE_SOURCE_DATASETS as readonly string[]).includes(k), `čítaný dataset mimo zoznamu: ${k}`);
  assert.ok(!allText(files).includes(SECRET), "interné polia / logy / AI výstupy sa nesmú dostať do čitateľných súborov");
  const ov = JSON.stringify(companyOverview(sample(), "2026-11-14T10:00:00Z", {}));
  assert.ok(!ov.includes(SECRET));
});

await check("CSV: pevné SK stĺpce, oddeľovač ;, BOM, úvodzovky; dokumenty bez zmazaných a s odkazom na originál (bez kópie)", () => {
  const files = buildReadableCsvFiles(sample());
  const by = Object.fromEntries(files.map((f) => [f.path.replace(`${READABLE_ROOT}/`, ""), String(f.content)]));
  assert.deepEqual(Object.keys(by).sort(), ["Dokumenty.csv", "Faktury/Zoznam_faktur.csv", "Obchodni_partneri.csv", "Sklad.csv", "Stroje.csv", "Vozidla.csv", "eFaktury_historia.csv"]);
  assert.ok(by["Vozidla.csv"].startsWith("﻿ŠPZ;VIN;Značka"));
  assert.match(by["Obchodni_partneri.csv"], /"Odberateľ; ""B"""/);
  assert.match(by["Sklad.csv"], /Skrutky;;1 234,50;ks/);
  assert.match(by["Dokumenty.csv"], /files\/ai-inbox-documents\/c0000000-0000-4000-8000-00000000000a\/zmluva\.pdf/);
  assert.doesNotMatch(by["Dokumenty.csv"], /zmazany\.pdf/);
  assert.match(by["Faktury/Zoznam_faktur.csv"], /FA2026\/001;vydaná;faktúra;finalizovaná;neuhradená;"Odberateľ; ""B""";1\. 11\. 2026/);
  assert.match(by["Faktury/Zoznam_faktur.csv"], /CITATELNY_EXPORT\/Faktury\/FA2026_001\.pdf/);
  assert.match(by["Faktury/Zoznam_faktur.csv"], /files\/einvoice-documents\/.*\/inbound\/x\.xml/);
  assert.match(by["eFaktury_historia.csv"], /prijatá;;acknowledged;rcv-1/);
  assert.match(by["eFaktury_historia.csv"], /13\. 11\. 2026 19:40 ∅→received/);
});

await check("prázdne datasety → CSV iba s hlavičkou, prehľad s nulami, žiadne PDF faktúr", () => {
  const files = buildReadableCsvFiles({});
  assert.equal(files.length, 7);
  for (const f of files) assert.equal(String(f.content).split("\r\n").filter(Boolean).length, 1, f.path);
  assert.deepEqual(issuedInvoiceBundles({}), []);
  const o = companyOverview({}, "2026-11-14T10:00:00Z", {});
  assert.ok(o.areas.every(([, n]) => n === 0));
  assert.equal(o.name, "");
});

await check("PDF vizualizácie: iba finalizované vydané faktúry, podklady iba z exportovaných riadkov, unikátne bezpečné názvy", () => {
  const b = issuedInvoiceBundles(sample());
  assert.equal(b.length, 1);
  assert.equal(b[0].invoice.id, "inv1");
  assert.equal(b[0].seller?.role, "seller");
  assert.equal(b[0].items.length, 1);
  const names = issuedInvoicePdfNames([
    { id: "a", direction: "issued", document_status: "finalized", invoice_number: "FA/1" },
    { id: "b", direction: "issued", document_status: "finalized", invoice_number: "FA:1" },
    { id: "c", direction: "issued", document_status: "draft", invoice_number: "X" },
    { id: "d", direction: "received", document_status: "finalized", invoice_number: "Y" },
  ]).map((x) => x.path);
  assert.deepEqual(names, ["CITATELNY_EXPORT/Faktury/FA_1.pdf", "CITATELNY_EXPORT/Faktury/FA_1_2.pdf"]);
});

await check("formátovanie: dátum, číslo, CSV", () => {
  assert.equal(skDate("2026-11-14"), "14. 11. 2026");
  assert.equal(skDate("2026-11-14T09:05:00Z"), "14. 11. 2026 09:05");
  assert.equal(skNumber(-1234567.5), "-1 234 567,50");
  assert.equal(skNumber(null), "");
  assert.equal(readableCsv(["A", "B"], [["x;y", "z"]]), '﻿A;B\r\n"x;y";z\r\n');
  assert.match(README_TEXT, /nie je to nový právny originál/);
  assert.match(README_TEXT, /Export nie je zákonný archív/);
});

await check("route: čitateľná vrstva iba z `exported` (filter firmy), manifest technical + human_readable, owner-only a evidencia bez zmeny", () => {
  const route = read("app/api/company/export/route.ts");
  assert.match(route, /READABLE_SOURCE_DATASETS\.map\(\(k\) => \[k, exported\[k\] \?\? \[\]\]\)/, "vstup iba z exportovaných riadkov");
  assert.doesNotMatch(route.slice(route.indexOf("async function buildHumanReadable")), /admin\.|from\(|storage/, "čitateľná vrstva nič nedotazuje ani nesťahuje");
  assert.match(route, /technical_export: \{/);
  assert.match(route, /human_readable_export: \{/);
  assert.match(route, /derived_from_technical_export_only: true/);
  assert.match(route, /if \(active\.role !== "owner"\) return fail\(403, "OWNER_ONLY"\)/);
  assert.ok(route.indexOf("buildHumanReadable(") < route.indexOf("generateAsync"), "čitateľné súbory sú v data ZIP pred výpočtom SHA");
  assert.ok(route.indexOf("generateAsync") < route.indexOf("esblu_company_export_begin"), "evidencia exportu až po vygenerovaní");
  assert.match(route, /COMPANY_EXPORT_SCHEMA_VERSION = "2026-11-13\.einvoice-lifecycle"/, "schéma technického exportu sa nemení");
  assert.ok(COMPANY_EXPORT_EXCLUDED.some((x) => x.includes("einvoice_webhook_events")));
  assert.match(read("next.config.ts"), /"\/api\/company\/export": \["\.\/assets\/fonts\/\*\*"\]/);
  // žiadne trvalé uloženie čitateľnej vrstvy
  assert.doesNotMatch(route, /storage\.from\([^)]*\)\.upload/);
});

await check("UX: mailto žiadosti majú ikonu e-mailu a odlišný text (SK/EN/DE); export hlási čitateľnú vrstvu", async () => {
  const page = read("app/nastavenia/page.tsx");
  assert.match(page, /href=\{exportRequestMailto\} title=\{t\("settings\.privacy\.requestExport"\)\} leading=\{<MailIcon/);
  const sk = read("lib/i18n/dictionaries/sk.ts");
  assert.match(sk, /requestExport: "Napísať žiadosť o export osobných údajov \(e-mail\)"/);
  assert.match(sk, /done: "Export bol stiahnutý\. Obsahuje technický archív aj čitateľné PDF\/CSV súbory/);
  assert.match(read("lib/i18n/dictionaries/en.ts"), /requestExport: "Write a request to export personal data \(email\)"/);
  assert.match(read("lib/i18n/dictionaries/de.ts"), /requestExport: "Antrag auf Export personenbezogener Daten schreiben \(E-Mail\)"/);
});

await check("PDF: Prehlad_firmy.pdf a vizualizácia faktúry sa vyrenderujú (aj pri prázdnych údajoch)", async () => {
  const { renderCompanyOverviewPdf } = await import("@/lib/company-export-readable-pdf");
  const empty = await renderCompanyOverviewPdf(companyOverview({}, "2026-11-14T10:00:00Z", {}));
  assert.equal(Buffer.from(empty).subarray(0, 5).toString(), "%PDF-");
  const full = await renderCompanyOverviewPdf(companyOverview(sample(), "2026-11-14T10:00:00Z", { invoices: 2 }));
  assert.ok(full.byteLength > 1000);
  const { renderInvoicePdfBuffer } = await import("@/lib/invoicing/pdf-renderer");
  const [b] = issuedInvoiceBundles(sample());
  const inv = await renderInvoicePdfBuffer({
    invoice: { ...b.invoice, rounding_amount: 0, kind: "regular_invoice" } as never, seller: b.seller as never, buyer: b.buyer as never,
    items: b.items as never, taxBreakdowns: b.taxBreakdowns as never, locale: "sk", correctedInvoiceNumber: null, advanceDeductions: [],
  });
  assert.equal(Buffer.from(inv).subarray(0, 5).toString(), "%PDF-");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
