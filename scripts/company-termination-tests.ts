// =============================================================================
// Ukončenie firmy + export údajov + kontakt — unit/statické testy (bez DB).
//   npm run test:company-termination
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEinvoiceLifecycle,
  COMPANY_EXPORT_EXCLUDED,
  COMPANY_EXPORT_FILE_SOURCES,
  COMPANY_EXPORT_TABLES,
  exportFilePartCount,
  normalizeExportFiles,
  rowsToCsv,
  sliceExportFiles,
  zipSafePath,
} from "@/lib/company-export";
import { legalConfig } from "@/lib/legal-config";
import sk from "@/lib/i18n/dictionaries/sk";
import en from "@/lib/i18n/dictionaries/en";
import de from "@/lib/i18n/dictionaries/de";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n       ") : String(error)}`);
  }
}

check("export pokrýva všetky kategórie zákazníckych údajov (DPA vrátenie)", () => {
  const tables = COMPANY_EXPORT_TABLES.map((t) => t.table);
  for (const t of ["companies", "company_billing_profile", "company_members", "business_partners", "vehicles", "vehicle_photos",
    "vehicle_services", "vehicle_vignettes", "machines", "machine_photos", "machine_services", "inventory_items", "inventory_photos",
    "documents", "document_attachments", "document_folders", "document_folder_items", "ai_evidence", "chat_conversations",
    "chat_messages", "chat_attachments", "invoices", "invoice_items", "invoice_parties", "invoice_tax_breakdowns",
    "invoice_payments", "einvoice_inbound", "einvoice_outbound", "einvoice_events"]) assert.ok(tables.includes(t), t);
  for (const t of ["company_invites", "billing_events", "subscription_accounts", "push_devices", "einvoice_organizations",
    "einvoice_webhook_events", "einvoice_webhook_rejections", "einvoice_enroll_attempts", "einvoice_rollout", "einvoice_event_cursors", "einvoice_ops_audit"])
    assert.ok(!tables.includes(t), `${t} sa neexportuje`);
  const buckets = new Set(COMPANY_EXPORT_FILE_SOURCES.map((s) => s.bucket ?? s.bucketColumn));
  for (const b of ["ai-evidence-documents", "machine-photos", "inventory-photos", "vehicle-photos", "company-logos", "einvoice-documents", "storage_bucket"])
    assert.ok(buckets.has(b), b);
});

check("export eFaktúry (G1): einvoice_events v exporte, interné webhook/bezpečnostné logy nie; manifest to uvádza", () => {
  const ex = COMPANY_EXPORT_EXCLUDED.join(" | ");
  assert.ok(!/(^|[ ,(])einvoice_events[ ,]/.test(ex.replace("v einvoice_events a", "")), "einvoice_events už nie je vylúčené");
  for (const t of ["einvoice_webhook_events", "einvoice_webhook_rejections", "einvoice_ops_audit"]) assert.ok(ex.includes(t), t);
  const route = read("app/api/company/export/route.ts");
  assert.match(route, /buildEinvoiceLifecycle\(/);
  assert.match(route, /data\/einvoice_lifecycle\.json/);
  assert.match(route, /data\/einvoice_lifecycle\.csv/);
  assert.doesNotMatch(route, /einvoice_webhook_events|einvoice_webhook_rejections/, "route nečíta webhook logy");
});

check("export eFaktúry (G1): životný cyklus — ID poskytovateľa, SBDH/AS4, SHA-256, časy, história, súbor originálu", () => {
  const inbound = [{ id: "in-1", company_id: "c", provider: "efaktura_sk", environment: "sandbox", provider_received_id: "rcv-1", sender_participant_id: "9915:2054825695",
    document_number: "FA-1", document_type: "invoice", xml_storage_path: "c/inbound/efaktura_sk/rcv-1/abc.xml", xml_sha256: "a".repeat(64), xml_size_bytes: 5101,
    acknowledged_at: "2026-11-13T19:40:31Z", invoice_id: "inv-in", processing_status: "acknowledged", received_at: "2026-11-13T19:40:28Z", last_error_code: null }];
  const outbound = [{ id: "out-1", company_id: "c", invoice_id: "inv-out", provider: "efaktura_sk", environment: "sandbox", attempt: 1, ubl_sha256: "b".repeat(64),
    ubl_storage_path: "c/outbound/out-1/b.xml", ubl_size_bytes: "4000", provider_submission_id: "sub-1", document_id: "doc-1", state: "delivered",
    receiver_participant_id: "9915:2020147507", sent_at: "2026-11-13T19:40:27Z", delivered_at: "2026-11-13T19:40:38Z", evidence: { delivery_state: "DELIVERED" },
    sbdh_instance_identifier: "sbdh-1", as4_message_id: "as4-1@ap", last_error_code: null }];
  const events = [
    { id: "e2", company_id: "c", inbound_id: "in-1", from_state: "received", to_state: "stored", source: "job", provider_code: null, created_at: "2026-11-13T19:40:29Z" },
    { id: "e1", company_id: "c", inbound_id: "in-1", from_state: null, to_state: "received", source: "webhook", provider_code: null, created_at: "2026-11-13T19:40:28Z" },
    { id: "e3", company_id: "c", outbound_id: "out-1", from_state: "sending", to_state: "failed", source: "provider", provider_code: "X", created_at: "2026-11-13T19:40:30Z" },
    { id: "e4", company_id: "c", outbound_id: "out-1", from_state: "failed", to_state: "delivered", source: "provider", provider_code: null, created_at: "2026-11-13T19:40:38Z" },
  ];
  const l = buildEinvoiceLifecycle({ inbound, outbound, events, invoices: [{ id: "inv-out", invoice_number: "FA2026001" }] });
  assert.equal(l.length, 2);
  const i = l.find((x) => x.direction === "inbound")!;
  assert.equal(i.provider_reference, "rcv-1");
  assert.equal(i.sha256, "a".repeat(64));
  assert.equal(i.original_file, "files/einvoice-documents/c/inbound/efaktura_sk/rcv-1/abc.xml");
  assert.deepEqual(i.history.map((h) => h.to), ["received", "stored"], "história zoradená podľa času");
  assert.equal(i.acknowledged_at, "2026-11-13T19:40:31Z");
  const o = l.find((x) => x.direction === "outbound")!;
  assert.equal(o.document_number, "FA2026001");
  assert.equal(o.provider_reference, "sub-1");
  assert.equal(o.provider_document_id, "doc-1");
  assert.equal(o.sbdh_instance_identifier, "sbdh-1");
  assert.equal(o.as4_message_id, "as4-1@ap");
  assert.equal(o.size_bytes, 4000);
  assert.equal(o.failed_at, "2026-11-13T19:40:30Z");
  assert.equal(o.delivered_at, "2026-11-13T19:40:38Z");
  assert.deepEqual(o.delivery_evidence, { delivery_state: "DELIVERED" });
  // CSV sa dá vygenerovať (história ako JSON v bunke)
  assert.match(rowsToCsv(l as unknown as Record<string, unknown>[]), /history/);
  // žiadne interné technické polia
  for (const e of l) for (const k of ["locked_until", "next_retry_at", "idempotency_key", "body_sha256", "delivery_id"]) assert.ok(!(k in e), k);
});

check("export: dávky, deduplikácia, bezpečné cesty, CSV", () => {
  assert.equal(exportFilePartCount(0), 1);
  assert.equal(exportFilePartCount(250, 100), 3);
  const files = normalizeExportFiles([{ bucket: "b", path: "2" }, { bucket: "a", path: "1" }, { bucket: "b", path: "2" }, { bucket: "", path: "x" }]);
  assert.deepEqual(files, [{ bucket: "a", path: "1" }, { bucket: "b", path: "2" }]);
  assert.deepEqual(sliceExportFiles(files, 1, 1), [{ bucket: "b", path: "2" }]);
  assert.deepEqual(sliceExportFiles(files, -1, 1), []);
  assert.equal(zipSafePath("vehicle-photos", "../../etc/x/./y.jpg"), "files/vehicle-photos/etc/x/y.jpg");
  assert.equal(rowsToCsv([{ a: 1, b: "x,y" }, { a: null, c: { k: "v" } }]), '﻿a,b,c\r\n1,"x,y",\r\n,,"{""k"":""v""}"\r\n');
});

check("export route: iba owner aktívnej firmy, firma zo servera, SHA-256, logy bez obsahu", () => {
  const r = read("app/api/company/export/route.ts");
  assert.match(r, /if \(active\.role !== "owner"\) return fail\(403, "OWNER_ONLY"\)/);
  assert.match(r, /resolveActiveMembershipForUser\(admin, user\.id/);
  assert.doesNotMatch(r, /body\.companyId|companyId: body/);
  assert.match(r, /"X-Esblu-Export-Sha256": sha256\(bytes\)/);
  assert.match(r, /console\.error\("company\/export zlyhal:", code\)/);
  assert.match(read("app/nastavenia/page.tsx"), /companyId && myRole === "owner" && \(/);
});

check("termination: iba pri účtovnom bloku, s exportom/vzdaním sa a potvrdením; provider registrácia blokuje", () => {
  const r = read("app/api/account/delete/route.ts");
  assert.match(r, /blocker === "FINALIZED_ACCOUNTING_DOCUMENTS" \|\| blocker === "EINVOICE_RECORDS"/);
  assert.match(r, /body\.termination\?\.confirmed === true/);
  assert.match(r, /supabaseTerminationDeps\(admin, terminationMode\)/);
  assert.match(r, /if \(body\.confirmPhrase !== "ZRUŠIŤ FIRMU"\)/);
  const d = read("lib/account-deletion-deps.ts");
  assert.match(d, /esblu_company_termination_commit/);
  assert.match(d, /esblu_company_termination_record_failure/);
  const m = read("supabase/migrations/20261112110000_company_termination_workflow.sql");
  assert.match(m, /ESBLU_EINVOICE_PROVIDER_ENROLLED/);
  assert.match(m, /grant execute on function public\.esblu_company_termination_commit\(uuid, uuid, boolean, text\) to service_role/);
  assert.doesNotMatch(m, /esblu_company_termination_commit\(uuid, uuid, boolean, text\) to authenticated/);
  const ui = read("app/nastavenia/page.tsx");
  assert.match(ui, /!terminationExportMode \|\|\s*!terminationAcknowledged/);
});

check("guardy: všetkých 7 upravených funkcií povoľuje iba DELETE počas termination; rollback ich vracia", () => {
  const m = read("supabase/migrations/20261112110000_company_termination_workflow.sql");
  for (const fn of ["esblu_block_finalized_invoice_delete", "esblu_block_finalized_invoice_items_mutation", "esblu_block_invoice_snapshot_mutation",
    "esblu_block_finalized_advance_deductions", "esblu_invoice_events_append_only", "esblu_einvoice_events_guard", "esblu_received_advance_link_guard"])
    assert.match(m, new RegExp(`create or replace function public\\.${fn}\\(\\)`), fn);
  const rb = read("supabase/rollback/20261112110000_company_termination_workflow_rollback.sql");
  assert.doesNotMatch(rb, /esblu_company_termination_in_progress\(\) then/);
});

check("kontakt: telefón z jedného configu, dostupnosť a rozsah bez prísľubu SLA (SK/EN/DE)", () => {
  assert.equal(legalConfig.publicPhone, "0903 464 006");
  assert.deepEqual(legalConfig.publicPhoneHours, { days: "mon-fri", from: "10:00", to: "15:00" });
  const page = read("app/kontakt/ContactPageClient.tsx");
  assert.match(page, /legalConfig\.publicPhone/);
  assert.match(page, /legal\.contactPage\.phoneHours/);
  assert.match(page, /legal\.contactPage\.phoneScope/);
  for (const d of [sk, en, de]) {
    const c = (d as unknown as { legal: { contactPage: Record<string, string> } }).legal.contactPage;
    assert.match(c.phoneHours, /10:00 – 15:00/);
    assert.ok(c.phoneScope.length > 100);
    assert.doesNotMatch(c.phoneScope, /24\/7|nonstop|SLA/i);
  }
  for (const f of ["legal/terms/1.2.md", "legal/terms/1.2.en.md", "legal/terms/1.2.de.md"])
    assert.ok(!read(f).includes("0903"), `${f}: číslo nie je natvrdo vo VOP`);
});

check("i18n: termination + companyExport kľúče v SK/EN/DE", () => {
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
  const pick = (d: typeof sk) => (d as unknown as { settings: { termination: object; companyExport: object } }).settings;
  for (const d of [en, de]) {
    assert.deepEqual(keys(pick(d).termination), keys(pick(sk).termination));
    assert.deepEqual(keys(pick(d).companyExport), keys(pick(sk).companyExport));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
