import type { SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// Odstránenie dokumentu z aktívneho zobrazenia — bezpečne pre účtovné doklady.
//
// PREČO
// -----
// Audit 2026-09-26: owner mohol účtovný doklad (faktúru, bloček, dodací
// list) natrvalo zmazať cez obyčajné confirm() a súbor v Storage sa mazal
// PRED DB riadkom — zlyhanie DB nechalo záznam ukazovať na neexistujúci
// súbor a doklad naviazaný na faktúru zmizol z účtovníctva.
//
// MODEL (uzavretá beta)
// ---------------------
//   - účtovný doklad (invoice, receipt, delivery_note) sa NEMAŽE: dostane
//     deleted_at (archív) a zmizne z aktívnych zoznamov; riadok aj súbor
//     ostávajú. DB trigger esblu_retain_finance_documents tvrdé zmazanie z
//     klienta odmietne aj vtedy, keby ho niekto poslal priamo cez API,
//   - ostatné dokumenty (PZP, technický preukaz, servisný doklad …) sa mažú,
//     ale NAJPRV DB riadok a až potom súbor — pri zlyhaní DB ostane všetko,
//     pri zlyhaní Storage ostane iba neškodný osirelý súbor (nikdy nie DB
//     odkaz na chýbajúci súbor),
//   - oprávnenie rozhoduje RLS (documents UPDATE/DELETE: finance.manage pre
//     účtovné doklady) — zamestnanec ani admin bez financií nič nezíska.
//
// Tvrdé zmazanie na zákonné výmazy / syntetické dáta nie je súčasťou
// bežného produktu (iba operátor cez service_role).
// Nejde o tvrdenie zákonnej archivácie — iba o to, že Esblu doklad sám
// nezničí.
// =============================================================================

export const RETAINED_DOCUMENT_TYPES = ["invoice", "receipt", "delivery_note"] as const;

export function isRetainedDocumentType(documentType: string | null | undefined): boolean {
  return (RETAINED_DOCUMENT_TYPES as readonly string[]).includes(documentType ?? "");
}

/** Zrkadlo DB esblu_evidence_is_delivery_note (ai_evidence). */
export function isDeliveryNoteEvidence(kind: string | null | undefined, label: string | null | undefined): boolean {
  if (kind) return kind === "delivery_note";
  return ["delivery_note", "dodací list", "dodaci list", "lieferschein", "delivery note"].includes((label ?? "").toLowerCase());
}

export function isRetentionError(error: unknown): boolean {
  const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : String(error ?? "");
  return message.includes("ESBLU_FINANCE_DOCUMENT_RETAINED");
}

export class DocumentRemovalError extends Error {
  readonly reason: "denied" | "failed";
  constructor(reason: "denied" | "failed", message: string) {
    super(message);
    this.reason = reason;
  }
}

export type RemovableDocument = {
  id: string;
  document_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

async function archive(db: SupabaseClient, id: string, companyId: string): Promise<void> {
  const { data, error } = await db
    .from("documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw new DocumentRemovalError(error.code === "42501" ? "denied" : "failed", error.message);
  // RLS bez oprávnenia vráti 0 riadkov bez chyby — nie je to úspech.
  if ((data ?? []).length !== 1) throw new DocumentRemovalError("denied", "no row archived");
}

/**
 * Odstráni dokument z aktívneho zobrazenia. Vracia "archived" pre účtovné
 * doklady (alebo doklady naviazané na faktúru), inak "deleted".
 */
export async function removeDocumentFromActiveView(
  db: SupabaseClient,
  doc: RemovableDocument,
  companyId: string
): Promise<"archived" | "deleted"> {
  if (isRetainedDocumentType(doc.document_type)) {
    await archive(db, doc.id, companyId);
    return "archived";
  }

  // Súbory sa zistia PRED zmazaním riadku (prílohy sa kaskádovo zmažú s ním).
  const { data: attachments, error: attachmentsError } = await db
    .from("document_attachments")
    .select("storage_bucket, storage_path")
    .eq("document_id", doc.id)
    .eq("company_id", companyId);
  if (attachmentsError) throw new DocumentRemovalError("failed", attachmentsError.message);

  const { data: deleted, error: deleteError } = await db
    .from("documents")
    .delete()
    .eq("id", doc.id)
    .eq("company_id", companyId)
    .select("id");

  if (deleteError) {
    // Doklad naviazaný na faktúru DB nedovolí zmazať → archív.
    if (isRetentionError(deleteError)) {
      await archive(db, doc.id, companyId);
      return "archived";
    }
    throw new DocumentRemovalError(deleteError.code === "42501" ? "denied" : "failed", deleteError.message);
  }
  if ((deleted ?? []).length !== 1) throw new DocumentRemovalError("denied", "no row deleted");

  // DB je už konzistentná; súbor sa uprace až teraz. Zlyhanie nechá iba
  // osirelý súbor (bez odkazu), nikdy DB záznam bez súboru.
  const byBucket = new Map<string, string[]>();
  const add = (bucket: string | null, path: string | null) => {
    if (bucket && path) byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path]);
  };
  add(doc.storage_bucket, doc.storage_path);
  for (const row of (attachments ?? []) as { storage_bucket: string | null; storage_path: string | null }[]) add(row.storage_bucket, row.storage_path);
  for (const [bucket, paths] of byBucket) {
    const { error } = await db.storage.from(bucket).remove(paths);
    if (error) console.error("Súbor dokumentu sa nepodarilo upratať (DB záznam je už zmazaný):", error.message);
  }
  return "deleted";
}
