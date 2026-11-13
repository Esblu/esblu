// =============================================================================
// Export údajov firmy (VOP 1.2 čl. 19, 20.6; DPA — vrátenie údajov po skončení)
//
// Owner-only. Dve časti:
//   - "data": všetky zákaznícke záznamy firmy ako JSON + CSV (jeden ZIP),
//   - "files": originálne súbory zo Storage po dávkach (ZIP na dávku).
// Firma sa NIKDY neberie z klienta (aktívna firma servera). Každý dotaz má
// explicitný filter na firmu (company_id alebo id faktúr tejto firmy).
// Technické / billing / Esblu-interné tabuľky sa neexportujú (nie sú to
// údaje, ktoré Esblu spracúva ako sprostredkovateľ) — zoznam nižšie.
// =============================================================================

export type ExportTableSpec = {
  table: string;
  /** company = filter company_id; invoice = filter invoice_id ∈ faktúry firmy; self = companies.id */
  scope: "company" | "invoice" | "self";
};

/** Zákaznícky obsah (Esblu = sprostredkovateľ) + firemné nastavenia. */
export const COMPANY_EXPORT_TABLES: ExportTableSpec[] = [
  { table: "companies", scope: "self" },
  { table: "company_billing_profile", scope: "company" },
  { table: "company_legal_identities", scope: "company" },
  { table: "company_members", scope: "company" },
  { table: "company_member_permissions", scope: "company" },
  { table: "company_dpa_acceptances", scope: "company" },
  { table: "custom_document_categories", scope: "company" },
  { table: "business_partners", scope: "company" },
  { table: "vehicles", scope: "company" },
  { table: "vehicle_services", scope: "company" },
  { table: "vehicle_vignettes", scope: "company" },
  { table: "vehicle_photos", scope: "company" },
  { table: "machines", scope: "company" },
  { table: "machine_services", scope: "company" },
  { table: "machine_photos", scope: "company" },
  { table: "inventory_items", scope: "company" },
  { table: "inventory_photos", scope: "company" },
  { table: "documents", scope: "company" },
  { table: "document_attachments", scope: "company" },
  { table: "document_links", scope: "company" },
  { table: "document_folders", scope: "company" },
  { table: "document_folder_items", scope: "company" },
  { table: "document_review_log", scope: "company" },
  { table: "ai_evidence", scope: "company" },
  { table: "ai_evidence_review_log", scope: "company" },
  { table: "chat_conversations", scope: "company" },
  { table: "chat_conversation_members", scope: "company" },
  { table: "chat_messages", scope: "company" },
  { table: "chat_message_references", scope: "company" },
  { table: "chat_attachments", scope: "company" },
  { table: "invoices", scope: "company" },
  { table: "invoice_number_sequences", scope: "company" },
  { table: "invoice_accounting_state", scope: "company" },
  { table: "received_advance_links", scope: "company" },
  { table: "einvoice_inbound", scope: "company" },
  { table: "einvoice_outbound", scope: "company" },
  // Kanonická história stavov e-faktúry (append-only, firma z mapovania) — preukázanie životného cyklu/doručenia.
  { table: "einvoice_events", scope: "company" },
  { table: "invoice_items", scope: "invoice" },
  { table: "invoice_parties", scope: "invoice" },
  { table: "invoice_tax_breakdowns", scope: "invoice" },
  { table: "invoice_payments", scope: "invoice" },
  { table: "invoice_events", scope: "invoice" },
  { table: "invoice_advance_deductions", scope: "invoice" },
];

/**
 * Neexportuje sa (technické záznamy, billing Esblu, kvóty, tokeny, prevádzkové
 * logy, súkromné nastavenia používateľov). Uvedené v manifeste exportu.
 */
export const COMPANY_EXPORT_EXCLUDED = [
  "company_invites (hash tokenov pozvánok)",
  "company_entitlements, company_plan_selection, company_usage_counters, subscription_accounts, billing_* (vlastné záznamy Esblu o predplatnom)",
  "ai_processing_usage, ai_scan_usage, ai_usage_monthly (kvóty a ochrana pred zneužitím)",
  "assistant_action_confirmations, assistant_conversation_contexts (krátkodobý technický kontext, hlasové nahrávky sa neuchovávajú)",
  "notification_*, push_* (technické doručovanie upozornení)",
  "einvoice_webhook_events, einvoice_webhook_rejections, einvoice_enroll_attempts, einvoice_organizations, einvoice_rollout, einvoice_event_cursors, einvoice_ops_audit (interné technické a bezpečnostné záznamy prenosu; kanonická história dokladu je v einvoice_events a einvoice_lifecycle)",
  "document_download_events, document_export_*, accounting_handoff_* (evidencia sťahovaní)",
  "session_active_company, user_active_company, media_deletion_queue (technické)",
];

export type StorageFileRef = { bucket: string; path: string };

/** Zdroje súborov firmy v Storage (rovnaké ako zber pri výmaze firmy + XML e-faktúr). */
export const COMPANY_EXPORT_FILE_SOURCES: Array<{ table: string; bucketColumn?: string; bucket?: string; pathColumn: string }> = [
  { table: "documents", bucketColumn: "storage_bucket", pathColumn: "storage_path" },
  { table: "document_attachments", bucketColumn: "storage_bucket", pathColumn: "storage_path" },
  { table: "chat_attachments", bucketColumn: "storage_bucket", pathColumn: "storage_path" },
  { table: "ai_evidence", bucket: "ai-evidence-documents", pathColumn: "photo_url" },
  { table: "machine_photos", bucket: "machine-photos", pathColumn: "file_path" },
  { table: "inventory_photos", bucket: "inventory-photos", pathColumn: "file_path" },
  { table: "vehicle_photos", bucket: "vehicle-photos", pathColumn: "storage_path" },
  { table: "company_billing_profile", bucket: "company-logos", pathColumn: "logo_path" },
  { table: "einvoice_inbound", bucket: "einvoice-documents", pathColumn: "xml_storage_path" },
  { table: "einvoice_outbound", bucket: "einvoice-documents", pathColumn: "ubl_storage_path" },
];

/** Max. súborov v jednej dávke (ZIP) — limit pamäte a času serverless funkcie. */
export const COMPANY_EXPORT_FILES_PER_PART = 100;

export function exportFilePartCount(total: number, perPart = COMPANY_EXPORT_FILES_PER_PART): number {
  return Math.max(1, Math.ceil(total / perPart));
}

export function sliceExportFiles(files: StorageFileRef[], index: number, perPart = COMPANY_EXPORT_FILES_PER_PART): StorageFileRef[] {
  if (!Number.isInteger(index) || index < 0) return [];
  return files.slice(index * perPart, (index + 1) * perPart);
}

/** Deterministické, deduplikované poradie súborov (stabilné dávky medzi volaniami). */
export function normalizeExportFiles(files: StorageFileRef[]): StorageFileRef[] {
  const seen = new Set<string>();
  const out: StorageFileRef[] = [];
  for (const f of files) {
    if (!f.bucket || !f.path) continue;
    const key = `${f.bucket}\u0000${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort((a, b) => (a.bucket === b.bucket ? a.path.localeCompare(b.path) : a.bucket.localeCompare(b.bucket)));
}

/** Bezpečná cesta v ZIP (bez „..“, bez absolútnych ciest). */
export function zipSafePath(bucket: string, path: string): string {
  const clean = path
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  return `files/${bucket}/${clean}`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV (UTF-8 s BOM, oddeľovač čiarka) zo zoznamu riadkov; stĺpce = zjednotenie kľúčov. */
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

// -----------------------------------------------------------------------------
// eFaktúra — kanonický životný cyklus dokladu (odvodený súhrn pre zákazníka).
// Jeden riadok na prijatý doklad / pokus o odoslanie: identifikátory poskytovateľa,
// SHA-256 originálu, cesta k originálu v exporte súborov, časy a história stavov.
// Iba z už exportovaných tabuliek (einvoice_inbound / einvoice_outbound /
// einvoice_events / invoices) — žiadne webhook ani bezpečnostné logy.
// -----------------------------------------------------------------------------

type ExportRow = Record<string, unknown>;

export type EinvoiceLifecycleEntry = {
  direction: "inbound" | "outbound";
  einvoice_id: string;
  invoice_id: string | null;
  document_number: string | null;
  document_type: string | null;
  state: string | null;
  provider: string | null;
  environment: string | null;
  /** inbound: ID prijatého dokladu u poskytovateľa; outbound: ID podania (connector/send invoice_id). */
  provider_reference: string | null;
  /** outbound: document_id poskytovateľa (ak ho vrátil). */
  provider_document_id: string | null;
  counterparty_participant_id: string | null;
  /** outbound: SBDH InstanceIdentifier; inbound: je súčasťou exportovaného originálu (SBDH obálka). */
  sbdh_instance_identifier: string | null;
  as4_message_id: string | null;
  sha256: string | null;
  size_bytes: number | null;
  original_file: string | null;
  attempt: number | null;
  received_at: string | null;
  acknowledged_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  last_error_code: string | null;
  delivery_evidence: unknown;
  history: Array<{ at: string | null; from: string | null; to: string | null; source: string | null; provider_code: string | null }>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

export function buildEinvoiceLifecycle(input: {
  inbound: ExportRow[];
  outbound: ExportRow[];
  events: ExportRow[];
  invoices: ExportRow[];
}): EinvoiceLifecycleEntry[] {
  const byInbound = new Map<string, ExportRow[]>();
  const byOutbound = new Map<string, ExportRow[]>();
  for (const e of input.events) {
    const key = str(e.inbound_id) ?? str(e.outbound_id);
    if (!key) continue;
    const map = str(e.inbound_id) ? byInbound : byOutbound;
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  }
  const history = (rows: ExportRow[] | undefined) =>
    [...(rows ?? [])]
      .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id ?? "").localeCompare(String(b.id ?? "")))
      .map((e) => ({ at: str(e.created_at), from: str(e.from_state), to: str(e.to_state), source: str(e.source), provider_code: str(e.provider_code) }));
  const failedAt = (h: EinvoiceLifecycleEntry["history"]) => h.find((x) => x.to === "failed" || x.to === "rejected")?.at ?? null;
  const invoiceNumber = new Map(input.invoices.map((i) => [String(i.id), str(i.invoice_number) ?? str(i.supplier_invoice_number)]));
  const file = (path: unknown) => (str(path) ? zipSafePath("einvoice-documents", String(path)) : null);

  const out: EinvoiceLifecycleEntry[] = [];
  for (const r of input.inbound) {
    const h = history(byInbound.get(String(r.id)));
    out.push({
      direction: "inbound", einvoice_id: String(r.id), invoice_id: str(r.invoice_id),
      document_number: str(r.document_number), document_type: str(r.document_type), state: str(r.processing_status),
      provider: str(r.provider), environment: str(r.environment),
      provider_reference: str(r.provider_received_id), provider_document_id: null,
      counterparty_participant_id: str(r.sender_participant_id), sbdh_instance_identifier: null, as4_message_id: null,
      sha256: str(r.xml_sha256), size_bytes: num(r.xml_size_bytes), original_file: file(r.xml_storage_path), attempt: null,
      received_at: str(r.received_at), acknowledged_at: str(r.acknowledged_at), sent_at: null, delivered_at: null,
      failed_at: failedAt(h), last_error_code: str(r.last_error_code), delivery_evidence: null, history: h,
    });
  }
  for (const r of input.outbound) {
    const h = history(byOutbound.get(String(r.id)));
    out.push({
      direction: "outbound", einvoice_id: String(r.id), invoice_id: str(r.invoice_id),
      document_number: r.invoice_id ? invoiceNumber.get(String(r.invoice_id)) ?? null : null, document_type: null, state: str(r.state),
      provider: str(r.provider), environment: str(r.environment),
      provider_reference: str(r.provider_submission_id), provider_document_id: str(r.document_id),
      counterparty_participant_id: str(r.receiver_participant_id), sbdh_instance_identifier: str(r.sbdh_instance_identifier),
      as4_message_id: str(r.as4_message_id), sha256: str(r.ubl_sha256), size_bytes: num(r.ubl_size_bytes),
      original_file: file(r.ubl_storage_path), attempt: num(r.attempt),
      received_at: null, acknowledged_at: null, sent_at: str(r.sent_at), delivered_at: str(r.delivered_at),
      failed_at: failedAt(h), last_error_code: str(r.last_error_code), delivery_evidence: r.evidence ?? null, history: h,
    });
  }
  return out.sort((a, b) => (a.direction === b.direction ? a.einvoice_id.localeCompare(b.einvoice_id) : a.direction.localeCompare(b.direction)));
}
