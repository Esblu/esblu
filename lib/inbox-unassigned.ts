// =============================================================================
// „Nepriradené" doklady v Inboxe — JEDNA definícia pre UI aj hlas.
//
// Zrkadlí app/ai-evidencia/page.tsx (zložky Bločky / Faktúry na spracovanie):
//   - doklad nie je zmazaný ani archivovaný z Inboxu (deleted_at,
//     archived_from_inbox_at — filter v dopyte),
//   - nemá väzbu na vozidlo ani stroj (document_links),
//   - nie je vo vlastnej zložke (custom_category_id),
//   - faktúra navyše: nevznikla z nej ešte riadna faktúra (document_links.invoice_id).
//
// Hlas nič nedefinuje po svojom — iba volá túto funkciu.
// =============================================================================

export type InboxDocumentLink = { vehicle_id?: string | null; machine_id?: string | null; invoice_id?: string | null };

export type InboxDocumentRow = {
  id: string;
  document_type: string | null;
  custom_category_id?: string | null;
  document_links?: InboxDocumentLink[] | null;
};

/** Stĺpce potrebné pre filter (a pre popis v zozname). */
export const INBOX_UNASSIGNED_SELECT =
  "id, document_type, custom_category_id, original_filename, extracted_fields, created_at, storage_bucket, storage_path, document_links(vehicle_id, machine_id, invoice_id)";

/** Typy, pre ktoré má Inbox pojem „nepriradený". */
export const INBOX_UNASSIGNED_TYPES = ["receipt", "invoice"] as const;
export type InboxUnassignedType = (typeof INBOX_UNASSIGNED_TYPES)[number];

export function isInboxUnassignedType(value: string): value is InboxUnassignedType {
  return (INBOX_UNASSIGNED_TYPES as readonly string[]).includes(value);
}

export function isUnassignedInboxDocument(doc: InboxDocumentRow): boolean {
  if (!doc.document_type || !isInboxUnassignedType(doc.document_type)) return false;
  if (doc.custom_category_id) return false;
  const links = Array.isArray(doc.document_links) ? doc.document_links : [];
  // UI: isDocumentAssigned() — väzba na vozidlo/stroj.
  const first = links[0];
  if (first && (first.vehicle_id || first.machine_id)) return false;
  if (doc.document_type === "invoice" && links.some((link) => link?.invoice_id)) return false;
  return true;
}
