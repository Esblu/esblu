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
  COMPANY_EXPORT_FILES_PER_PART,
  COMPANY_EXPORT_TABLES,
  exportCountMismatches,
  exportFilePartCount,
  normalizeExportFiles,
  rowsToCsv,
  sliceExportFiles,
  zipSafePath,
} from "@/lib/company-export";
import { legalConfig } from "@/lib/legal-config";
import { filterCompanyVisibleEinvoice, visibleToCompany } from "@/lib/einvoice/visibility";
import { buildTerminationAck, terminationAuthorityStatement } from "@/lib/company-termination-ack";
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

check("export evidence: dôkaz vzniká iba na serveri po vygenerovaní; dávky viazané na beh; ukončenie mapuje NOT_VERIFIED", () => {
  const route = read("app/api/company/export/route.ts");
  assert.match(route, /esblu_company_export_begin/);
  assert.match(route, /esblu_company_export_part/);
  assert.ok(route.indexOf("generateAsync") < route.indexOf("esblu_company_export_begin"), "dôkaz až po vygenerovaní data ZIP");
  assert.match(route, /exportId = typeof body\.export_id === "string" && UUID_RE\.test/);
  assert.match(route, /if \(!exportId\) return fail\(400, "BAD_REQUEST"\)/);
  assert.doesNotMatch(route, /status:\s*"completed"|p_status/, "klient nikdy neposiela stav behu");
  assert.match(route, /p_user_id: user\.id/);
  assert.match(route, /p_company_id: companyId/);
  const client = read("lib/company-export-client.ts");
  assert.match(client, /export_id: exportId/);
  assert.match(client, /completed: status === "completed"/);
  assert.match(read("app/components/CompanyExportButton.tsx"), /if \(result\.completed\) onDone\?\.\(\)/);
  assert.match(read("app/api/account/delete/route.ts"), /\.\.\.TERMINATION_GATE_ERROR_KEYS/);
  assert.match(read("lib/company-termination-ack.ts"), /ESBLU_TERMINATION_EXPORT_NOT_VERIFIED: "settings\.errors\.terminationExportNotVerified"/);
  const mig = read("supabase/migrations/20261113110000_company_export_evidence.sql");
  assert.match(mig, /revoke all on table public\.company_export_runs from public, anon, authenticated/);
  assert.match(mig, /before insert on public\.company_terminations/);
  for (const [name, d] of [["sk", sk], ["en", en], ["de", de]] as const) {
    const dict = d as unknown as { settings: { errors: Record<string, string>; companyExport: { errors: Record<string, string> } } };
    for (const k of ["terminationExportNotVerified", "terminationExportStale", "terminationExportRequired", "terminationAckRequired", "terminationReauthRequired"]) {
      assert.ok(dict.settings.errors[k], `${name} ${k}`);
    }
    assert.ok(dict.settings.companyExport.errors.EXPORT_RUN_INVALID, `${name} EXPORT_RUN_INVALID`);
  }
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

check("termination: iba pri účtovnom bloku, s exportom, potvrdením oprávnenej osoby a preflightom PRED deregistráciou", () => {
  const r = read("app/api/account/delete/route.ts");
  assert.match(r, /blocker === "FINALIZED_ACCOUNTING_DOCUMENTS" \|\| blocker === "EINVOICE_RECORDS"/);
  assert.match(r, /body\.termination\?\.confirmed === true/);
  assert.match(r, /supabaseTerminationDeps\(admin, terminationMode, terminationAck\)/);
  assert.match(r, /authorityConfirmed: body\.termination\?\.authorityConfirmed/);
  // preflight (rovnaká DB brána) musí byť pred deregistráciou u poskytovateľa a pred orchestráciou výmazu
  const pre = r.indexOf("await terminationPreflight(");
  assert.ok(pre > 0 && pre < r.indexOf("await ensureCompanyDeregistered(") && pre < r.indexOf("const ownerResult = await orchestrateAccountDeletion("), "preflight pred nevratnými krokmi");
  assert.match(r, /if \(body\.confirmPhrase !== "ZRUŠIŤ FIRMU"\)/);
  const d = read("lib/account-deletion-deps.ts");
  assert.match(d, /esblu_company_termination_execute/);
  assert.match(d, /p_ack: ack/);
  assert.match(d, /esblu_company_termination_preflight/);
  assert.doesNotMatch(d, /rpc\("esblu_company_termination_commit"/);
  assert.match(d, /esblu_company_termination_record_failure/);
  const m = read("supabase/migrations/20261112110000_company_termination_workflow.sql");
  assert.match(m, /ESBLU_EINVOICE_PROVIDER_ENROLLED/);
  assert.match(m, /grant execute on function public\.esblu_company_termination_commit\(uuid, uuid, boolean, text\) to service_role/);
  assert.doesNotMatch(m, /esblu_company_termination_commit\(uuid, uuid, boolean, text\) to authenticated/);
  const ui = read("app/nastavenia/page.tsx");
  assert.match(ui, /!terminationExportMode \|\|\s*!terminationAcknowledged \|\|\s*!terminationAuthority/);
  assert.doesNotMatch(ui, /setTerminationExportMode\("waived"\)/, "pri dokladoch sa výmaz bez exportu neponúka");
  const ack = read("lib/company-termination-ack.ts");
  assert.match(ack, /if \(input\.authorityConfirmed !== true\) return null/);
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

check("potvrdenie oprávnenej osoby: iba výslovné true; SHA-256 zobrazeného textu podľa jazyka; IP/UA iba hash", () => {
  const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "QA" });
  for (const v of [undefined, false, "true", 1, {}]) {
    assert.equal(buildTerminationAck({ authorityConfirmed: v, locale: "sk", companyId: "c", headers: h }), null, String(v));
  }
  const now = new Date("2026-11-23T10:00:00Z");
  const a = buildTerminationAck({ authorityConfirmed: true, locale: "en", companyId: "c1", headers: h, now })!;
  assert.equal(a.authority_confirmed, true);
  assert.equal(a.confirmed_at, "2026-11-23T10:00:00.000Z");
  assert.match(a.text_version, /^[A-Za-z0-9_.:-]{1,60}$/);
  assert.match(a.text_sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.text_sha256, terminationAuthorityStatement("en").sha256);
  assert.notEqual(terminationAuthorityStatement("sk").sha256, terminationAuthorityStatement("en").sha256);
  assert.match(a.ip_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(buildTerminationAck({ authorityConfirmed: true, locale: "en", companyId: "c2", headers: h, now })!.ip_sha256, a.ip_sha256, "soľ viazaná na firmu");
  assert.ok(!JSON.stringify(a).includes("203.0.113.7") && !JSON.stringify(a).includes("QA\""));
});

check("P1-5 R3: export/balík/UI nevracajú doklad RECIPIENT_MISMATCH ani jeho udalosti a súbory (service role obchádza RLS)", () => {
  const inbound = [
    { id: "ok", last_error_code: null, xml_storage_path: "c/ok.xml", pdf_storage_path: "c/ok.pdf" },
    { id: "mm", last_error_code: "RECIPIENT_MISMATCH", xml_storage_path: "c/mm.xml" },
    { id: "bad", last_error_code: "INVALID_XML", xml_storage_path: "c/bad.xml" },
  ];
  const events = [{ id: "e1", inbound_id: "ok" }, { id: "e2", inbound_id: "mm" }, { id: "e3", outbound_id: "o1", inbound_id: null }, { id: "e4", inbound_id: "bad" }];
  const v = filterCompanyVisibleEinvoice({ inbound, events });
  assert.deepEqual(v.inbound.map((r) => r.id), ["ok", "bad"]);
  assert.deepEqual(v.events.map((r) => r.id), ["e1", "e3", "e4"]);
  assert.deepEqual(v.hidden, { einvoice_inbound: 1, einvoice_events: 1 });
  assert.equal(visibleToCompany({ last_error_code: "RECIPIENT_MISMATCH" }), false);
  const life = buildEinvoiceLifecycle({ inbound: v.inbound, outbound: [], events: v.events, invoices: [] });
  assert.ok(!life.some((x) => x.einvoice_id === "mm"));
  // súbory: všetky zdroje einvoice_inbound sú companyVisibleOnly; PDF prijatej e-faktúry je v exporte
  const inboundSources = COMPANY_EXPORT_FILE_SOURCES.filter((x) => x.table === "einvoice_inbound");
  assert.deepEqual(inboundSources.map((x) => x.pathColumn).sort(), ["pdf_storage_path", "xml_storage_path"]);
  assert.ok(inboundSources.every((x) => x.companyVisibleOnly === true));
  const route = read("app/api/company/export/route.ts");
  assert.match(route, /if \(src\.companyVisibleOnly && !visibleToCompany\(/);
  assert.ok(route.indexOf("filterCompanyVisibleEinvoice(") < route.indexOf("zip.file(`data/${spec.table}.json`"), "filter pred zápisom do ZIP");
  assert.match(route, /excluded_counts: visible\.hidden/);
  assert.ok(COMPANY_EXPORT_EXCLUDED.some((x) => x.includes("RECIPIENT_MISMATCH")));
  assert.match(read("app/api/accounting-handoff/package/route.ts"), /visibleToCompany\(r\)/);
  assert.match(read("lib/einvoice/ui/summary-server.ts"), /from "\.\.\/visibility\.ts"/);
  assert.match(read("lib/einvoice/ui/summary-server.ts"), /\.filter\(visibleToCompany\)\.sort/);
  assert.match(read("lib/einvoice/ops/download.ts"), /RECIPIENT_MISMATCH/);
});

check("P1-5 export úplnosť: denník účtovného stavu, mandáty, odtlačok DB = exportované počty, zmena počas exportu = chyba", () => {
  const tables = COMPANY_EXPORT_TABLES.map((t) => t.table);
  for (const t of ["invoice_accounting_state_log", "einvoice_mandates", "einvoice_events", "invoice_accounting_state"]) assert.ok(tables.includes(t), t);
  // každá tabuľka odtlačku (DB) je v exporte — inak by kontrola úplnosti nemohla prejsť
  const mig = read("supabase/migrations/20261127100000_company_termination_customer_delete.sql");
  const fpTables = [...mig.matchAll(/\(\d+, '([a-z_]+)', '(?:company|invoice|inbound|events)'\)/g)].map((m) => m[1]);
  assert.equal(fpTables.length, 16);
  for (const t of fpTables) assert.ok(tables.includes(t), `odtlačok ${t} chýba v exporte`);
  assert.deepEqual(exportCountMismatches({ invoices: 2, einvoice_inbound: 1, x: "n/a" }, { invoices: 2, einvoice_inbound: 1 }), []);
  assert.deepEqual(exportCountMismatches({ invoices: 2, einvoice_mandates: 1, documents: 0 }, { invoices: 1 }), ["documents", "einvoice_mandates", "invoices"], "chýbajúca tabuľka v exporte = neúplný");
  const route = read("app/api/company/export/route.ts");
  assert.ok(route.indexOf("await loadExportFingerprint(") < route.indexOf('await fetchTable(admin, "invoices"'), "odtlačok pred čítaním");
  assert.match(route, /exportCountMismatches\(fingerprint\.counts, exportedCounts\)/);
  assert.match(route, /p_expected_fingerprint: fingerprint\.fingerprint/);
  assert.match(route, /p_manifest_sha256: sha256\(manifestJson\)/);
  assert.match(route, /ESBLU_EXPORT_DATA_CHANGED/);
});

check("P1-5 (20261128100000): odtlačok = všetky tabuľky exportu; zoznam súborov v DB = zdroje exportu; súbory viazané na beh", () => {
  const mig = read("supabase/migrations/20261128100000_termination_purge_export_integrity.sql");
  const block = mig.slice(mig.indexOf("create or replace function public.esblu_company_export_fingerprint"), mig.indexOf("-- ----------------------------------------------------------------------------- 4."));
  const sqlTables = [...block.matchAll(/\(\d+, '([a-z_]+)', '[a-z]+'\)/g)].map((m) => m[1]);
  assert.deepEqual(sqlTables, COMPANY_EXPORT_TABLES.map((t) => t.table), "SQL odtlačok == COMPANY_EXPORT_TABLES (poradie aj obsah)");
  const list = mig.slice(mig.indexOf("create or replace function public.esblu_company_export_file_list"), mig.indexOf("-- Odtlačok stavu Storage"));
  for (const src of COMPANY_EXPORT_FILE_SOURCES) {
    assert.ok(list.includes(`public.${src.table} `), `file_list: ${src.table}`);
    assert.ok(list.includes(src.pathColumn), `file_list: ${src.table}.${src.pathColumn}`);
    if (src.bucket) assert.ok(list.includes(`'${src.bucket}'`), `file_list: ${src.bucket}`);
  }
  assert.equal(COMPANY_EXPORT_FILES_PER_PART, 100, "DB delí dávky po 100");
  const route = read("app/api/company/export/route.ts");
  assert.match(route, /p_files: files\.map\(\(f\) => \(\{ bucket: f\.bucket, path: f\.path \}\)\)/);
  assert.match(route, /esblu_company_export_part_files/);
  assert.match(route, /fileEvidence\.push\(\{ bucket: f\.bucket, path: f\.path, sha256: digest, bytes: bytes\.byteLength \}\)/);
  assert.match(mig, /error_code = 'FILES_CORRUPT'/);
  assert.match(mig, /v_run\.storage_fingerprint <> public\.esblu_company_export_storage_fingerprint\(new\.company_id\)/);
});

check("i18n: termination + companyExport kľúče v SK/EN/DE", () => {
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
  const pick = (d: typeof sk) => (d as unknown as { settings: { termination: object; companyExport: object } }).settings;
  for (const d of [en, de]) {
    assert.deepEqual(keys(pick(d).termination), keys(pick(sk).termination));
    assert.deepEqual(keys(pick(d).companyExport), keys(pick(sk).companyExport));
  }
});

check("O3: firma s dokladmi sa nedá ukončiť bez exportu — waived odmietnutý PRED akýmkoľvek zásahom; UI možnosť neponúka; texty SK/EN/DE", () => {
  const r = read("app/api/account/delete/route.ts");
  const guard = r.indexOf('if (blocker && terminationMode === "waived")');
  assert.ok(guard > 0, "guard existuje");
  assert.match(r.slice(guard, guard + 400), /ESBLU_TERMINATION_EXPORT_REQUIRED/);
  assert.match(r.slice(guard, guard + 400), /status: 409/);
  for (const sideEffect of ["ensureCompanyDeregistered(", "const ownerResult = await orchestrateAccountDeletion(", "supabaseTerminationDeps(admin, terminationMode)"]) {
    const at = r.indexOf(sideEffect);
    assert.ok(at > guard, `${sideEffect} až po guarde`);
  }
  assert.ok(r.indexOf("const terminationMode") < guard && r.indexOf("const terminationAllowed") < guard);
  const ui = read("app/nastavenia/page.tsx");
  assert.doesNotMatch(ui, /setTerminationExportMode\("waived"\)/, "UI neponúka ukončenie bez exportu");
  for (const d of [sk, en, de]) {
    const e = (d as unknown as { settings: { errors: Record<string, string> } }).settings.errors;
    assert.ok(e.terminationExportRequired && e.terminationExportRequired.length > 40);
    assert.doesNotMatch(e.terminationExportNotVerified, /bez exportu|without export|ohne Export/);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
