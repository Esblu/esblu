// =============================================================================
// Tvar riadku `documents` pre PRÍJEM finančného dokladu bez čítania
// (M1 authz final hardening 2026-09-28).
//
// Zrkadlí vetvu B politiky documents_insert_scoped
// (supabase/migrations/20260930130000_m1_authz_documents_insert_shape.sql):
// klient (aj zamestnanec) smie vložiť IBA faktúru/bloček v stave
// needs_review, pod vlastným user_id, s vlastným súborom a BEZ vyťažených
// polí. Vyťažené údaje dopíše server (buildIntakeExtractionPatch) až po
// overení zapečateného skenu. Čisté funkcie — testuje ich
// scripts/mobile-m1-tests.ts.
// =============================================================================

import type { IntakeExtraction } from "./intake-seal.ts";

/** Typy, ktoré smie príjem vložiť do `documents` (dodací list ide do ai_evidence). */
export const INTAKE_DOCUMENT_ROW_TYPES = ["invoice", "receipt"] as const;
export type IntakeDocumentRowType = (typeof INTAKE_DOCUMENT_ROW_TYPES)[number];

/** Stĺpce, ktoré príjem pri INSERT-e NESMIE nastaviť (RLS vetva B / základ). */
export const INTAKE_FORBIDDEN_INSERT_COLUMNS = [
  "company_id",
  "ai_model",
  "ai_raw_output",
  "extracted_fields",
  "field_confidence",
  "custom_category_id",
  "archived_from_inbox_at",
  "deleted_at",
  "created_at",
  "updated_at",
] as const;

/** Stĺpce, ktoré príjem pri INSERT-e smie poslať. Nič iné. */
export const INTAKE_ALLOWED_INSERT_COLUMNS = [
  "id",
  "user_id",
  "storage_bucket",
  "storage_path",
  "original_filename",
  "mime_type",
  "file_size",
  "content_sha256",
  "document_type",
  "status",
  "note",
] as const;

export type IntakeInsertInput = {
  documentId: string;
  userId: string;
  storagePath: string;
  documentType: IntakeDocumentRowType;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  /** SHA-256 originálu — overený serverom (pečať skenu = objekt v Storage). */
  contentSha256: string;
  note: string | null;
};

export function buildIntakeInsert(input: IntakeInsertInput) {
  return {
    id: input.documentId,
    user_id: input.userId,
    storage_bucket: "ai-inbox-documents" as const,
    storage_path: input.storagePath,
    original_filename: input.originalFilename,
    mime_type: input.mimeType,
    file_size: input.fileSize,
    content_sha256: input.contentSha256,
    document_type: input.documentType,
    status: "needs_review" as const,
    note: input.note,
  };
}

/** Serverový doplnok po INSERT-e — iba polia zo zapečateného skenu. */
export function buildIntakeExtractionPatch(documentType: IntakeDocumentRowType, extraction: IntakeExtraction | null) {
  const fields = extraction?.fields ?? null;
  return {
    ai_raw_output: extraction
      ? {
          documentType,
          confidenceScore: extraction.confidenceScore,
          reviewStatus: extraction.reviewStatus,
          documentLanguage: extraction.documentLanguage,
          fieldConfidence: extraction.fieldConfidence,
          fields,
          intake: "sealed",
        }
      : { documentType, intake: "sealed", extraction: "unavailable" },
    extracted_fields: fields ?? {},
    field_confidence: extraction?.fieldConfidence ?? null,
  };
}

/**
 * Klientské zrkadlo základu + vetvy B politiky (bez DB funkcií). Vracia
 * zoznam porušení; prázdny = riadok by RLS pustila ako príjem. Slúži testom
 * a obrane v route — autoritou ostáva RLS.
 */
export function intakeInsertViolations(row: Record<string, unknown>, callerId: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(row)) {
    if (!(INTAKE_ALLOWED_INSERT_COLUMNS as readonly string[]).includes(key)) problems.push(`column:${key}`);
  }
  if (row.user_id !== callerId) problems.push("user_id");
  if (typeof row.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.content_sha256)) problems.push("content_sha256");
  if (row.storage_bucket !== "ai-inbox-documents") problems.push("storage_bucket");
  if (typeof row.storage_path !== "string" || row.storage_path.split("/")[0] !== callerId) problems.push("storage_path");
  if (!(INTAKE_DOCUMENT_ROW_TYPES as readonly unknown[]).includes(row.document_type)) problems.push("document_type");
  if (row.status !== "needs_review") problems.push("status");
  return problems;
}

// =============================================================================
// ai_evidence — dodací list v príjme (zrkadlo vetvy I politiky
// ai_evidence_insert_scoped, 20260930135000).
// =============================================================================

/** Stĺpce, ktoré príjem dodacieho listu pri INSERT-e smie poslať. Nič iné. */
export const EVIDENCE_INTAKE_ALLOWED_INSERT_COLUMNS = [
  "id",
  "user_id",
  "evidence_kind",
  "document_type",
  "review_status",
  "photo_url",
  "content_sha256",
] as const;

/** Kľúče, ktoré smie niesť podpísaný payload (= v_allowed v SQL RPC). */
export const EVIDENCE_INTAKE_PAYLOAD_KEYS = [
  "spz",
  "supplier",
  "customer",
  "construction_site",
  "document_number",
  "material",
  "quantity",
  "unit",
  "brutto",
  "tara",
  "netto",
  "document_date",
  "document_time",
  "source_location",
  "destination_location",
  "document_language",
  "confidence_score",
  "raw_text",
] as const;

export const EVIDENCE_INTAKE_KINDS = ["delivery_note", "weigh_ticket"] as const;
export type EvidenceIntakeKind = (typeof EVIDENCE_INTAKE_KINDS)[number];

export function buildEvidenceIntakeInsert(input: {
  evidenceId: string;
  userId: string;
  photoPath: string;
  documentTypeLabel: string;
  kind?: EvidenceIntakeKind;
  /** SHA-256 originálu — overený serverom (pečať skenu = objekt v Storage). */
  contentSha256: string;
}) {
  return {
    id: input.evidenceId,
    user_id: input.userId,
    evidence_kind: input.kind ?? ("delivery_note" as EvidenceIntakeKind),
    document_type: input.documentTypeLabel,
    review_status: "needs_review" as const,
    photo_url: input.photoPath,
    content_sha256: input.contentSha256,
  };
}

function textOrNull(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Podpisovaný payload pre esblu_attach_evidence_intake_extraction. */
export function buildEvidenceIntakePatch(extraction: IntakeExtraction | null): Record<(typeof EVIDENCE_INTAKE_PAYLOAD_KEYS)[number], string | number | null> {
  const f = extraction?.fields ?? {};
  return {
    spz: textOrNull(f.spz, 20),
    supplier: textOrNull(f.supplier),
    customer: textOrNull(f.customer),
    construction_site: textOrNull(f.constructionSite),
    document_number: textOrNull(f.documentNumber, 100),
    material: textOrNull(f.material),
    quantity: numberOrNull(f.quantity),
    unit: textOrNull(f.unit, 20),
    brutto: numberOrNull(f.brutto),
    tara: numberOrNull(f.tara),
    netto: numberOrNull(f.netto),
    document_date: textOrNull(f.documentDate, 20),
    document_time: textOrNull(f.documentTime, 20),
    source_location: textOrNull(f.sourceLocation),
    destination_location: textOrNull(f.destinationLocation),
    document_language: textOrNull(extraction?.documentLanguage, 10),
    confidence_score: numberOrNull(extraction?.confidenceScore),
    raw_text: textOrNull(extraction?.rawText, 20000),
  };
}

/** Klientské zrkadlo vetvy I (príjem dodacieho listu). Prázdne = RLS by pustila. */
export function evidenceIntakeInsertViolations(row: Record<string, unknown>, callerId: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(row)) {
    if (!(EVIDENCE_INTAKE_ALLOWED_INSERT_COLUMNS as readonly string[]).includes(key)) problems.push(`column:${key}`);
  }
  if (row.user_id !== callerId) problems.push("user_id");
  if (!(EVIDENCE_INTAKE_KINDS as readonly unknown[]).includes(row.evidence_kind)) problems.push("evidence_kind");
  if (row.review_status !== "needs_review") problems.push("review_status");
  if (typeof row.photo_url !== "string" || row.photo_url.split("/")[0] !== callerId) problems.push("photo_url");
  if (typeof row.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.content_sha256)) problems.push("content_sha256");
  return problems;
}

// =============================================================================
// REVIEW uploaderom (M1 produktová korekcia): hodnoty, ktoré používateľ po
// kontrole opravil/doplnil/potvrdil. Server ich pred potvrdzovacím RPC iba
// tvarovo očistí; autoritou (vlastník, stav, firma, povolené kľúče, typy,
// vozidlo vlastnej firmy) je DB funkcia.
// =============================================================================

/** = v_text_keys + v_number_keys + document_date + vehicle_id v esblu_confirm_evidence_intake. */
export const EVIDENCE_REVIEW_TEXT_KEYS = [
  "spz",
  "supplier",
  "customer",
  "construction_site",
  "document_number",
  "material",
  "material_original",
  "material_category",
  "unit",
  "document_time",
  "source_location",
  "destination_location",
  "movement_type",
] as const;
export const EVIDENCE_REVIEW_NUMBER_KEYS = ["quantity", "brutto", "tara", "netto"] as const;
export const EVIDENCE_REVIEW_KEYS = [...EVIDENCE_REVIEW_TEXT_KEYS, ...EVIDENCE_REVIEW_NUMBER_KEYS, "document_date", "vehicle_id"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** null = neplatný vstup (route odmietne). Neznáme kľúče sa zahodia. */
export function sanitizeReviewedEvidenceValues(input: unknown): Record<string, string | number | null> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const out: Record<string, string | number | null> = {};
  for (const key of EVIDENCE_REVIEW_TEXT_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === null || value === undefined || value === "") out[key] = null;
    else if (typeof value === "string") out[key] = value.trim().slice(0, 500) || null;
    else return null;
  }
  for (const key of EVIDENCE_REVIEW_NUMBER_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === null || value === undefined || value === "") out[key] = null;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else return null;
  }
  if ("document_date" in source) {
    const value = source.document_date;
    if (value === null || value === undefined || value === "") out.document_date = null;
    else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) out.document_date = value;
    else return null;
  }
  if ("vehicle_id" in source) {
    const value = source.vehicle_id;
    if (value === null || value === undefined || value === "") out.vehicle_id = null;
    else if (typeof value === "string" && UUID_RE.test(value)) out.vehicle_id = value.toLowerCase();
    else return null;
  }
  return out;
}

/** Vyťažené polia faktúry/bločku po review. null = neplatný vstup. */
export function sanitizeReviewedDocumentFields(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.length > 200) return null;
  const text = JSON.stringify(input);
  if (text.length > 100_000) return null;
  return JSON.parse(text) as Record<string, unknown>;
}
