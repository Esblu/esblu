import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { EntityRef, IntentResult, ParsedIntent } from "@/lib/intents/types";
import {
  INBOX_UNASSIGNED_SELECT,
  isInboxUnassignedType,
  isUnassignedInboxDocument,
  type InboxDocumentRow,
  type InboxUnassignedType,
} from "@/lib/inbox-unassigned";

// =============================================================================
// Inbox — nepriradené bločky a faktúry: zoznam, počet, hromadné zmazanie.
//
// ČO ROBÍ UI (app/ai-evidencia/page.tsx#deleteOtherDocument)
// ---------------------------------------------------------
// Zmazanie dokladu v Inboxe je TRVALÉ: odstránia sa súbory zo Storage
// (originál + prílohy) a riadok `documents` (RLS documents_delete_finance_
// manager: owner/admin/účtovník, pri finančnom doklade finance.manage).
// Hlas robí PRESNE TO ISTÉ, nič viac.
//
// PRÍSNEJŠIE NEŽ UI (hlas nesmie byť deštruktívnejší)
// --------------------------------------------------
// Doklad, ktorý je súčasťou účtovnej stopy, hlas NEZMAŽE, aj keď by ho UI
// jednotlivo zmazať dovolilo — pri hromadnom príkaze nie je vidieť, čo
// presne odchádza:
//   - predloha faktúry (invoices.source_document_id / document_links.invoice_id),
//   - zaradený v priečinku dokladov (document_folder_items),
//   - súčasť odovzdania účtovníkovi (document_export_package_items),
//   - už stiahnutý (document_download_events).
// Tie ostanú a asistent povie, koľko ich vynechal.
//
// BEZPEČNOSŤ
// ----------
// Náhľad viaže potvrdenie na PRESNÝ zoznam ID (snapshot). Doklad pribudnutý
// po náhľade sa nikdy nezmaže; ak sa zo snapshotu niečo zmenilo, nezmaže
// sa nič. Potvrdenie je jednorazové (HMAC), oprávnenie sa overí znova.
// =============================================================================

export const INBOX_BULK_DELETE_LIMIT = 200;
export const INBOX_LARGE_DELETE_WARNING = 20;

const t = translate;

type UnassignedRow = InboxDocumentRow & {
  original_filename: string | null;
  extracted_fields: Record<string, unknown> | null;
  created_at: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

export type CreateInboxConfirmation = (
  intent: "INBOX_DELETE_UNASSIGNED",
  canonicalArgs: Record<string, unknown>,
  expectedCount: number
) => Promise<string | null>;

function typesOf(intent: ParsedIntent): InboxUnassignedType[] {
  return (intent.args.documentTypes ?? []).filter(isInboxUnassignedType);
}

/** „bločkov" / „faktúr" / „dokladov" v správnom tvare pre počet. */
function whatKey(types: InboxUnassignedType[]): string {
  if (types.length === 1 && types[0] === "receipt") return "receipts";
  if (types.length === 1 && types[0] === "invoice") return "invoices";
  return "documents";
}

function countForm(locale: Locale, types: InboxUnassignedType[], count: number): string {
  const form = count === 1 ? "one" : count >= 2 && count <= 4 ? "few" : "many";
  return t(locale, `assistant.inbox.what.${whatKey(types)}_${form}`);
}

export async function loadUnassignedDocuments(db: SupabaseClient, companyId: string, types: InboxUnassignedType[]): Promise<UnassignedRow[] | null> {
  const { data, error } = await db
    .from("documents")
    .select(INBOX_UNASSIGNED_SELECT)
    .eq("company_id", companyId)
    .in("document_type", types)
    .is("deleted_at", null)
    .is("archived_from_inbox_at", null)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) return null;
  return ((data ?? []) as unknown as UnassignedRow[]).filter(isUnassignedInboxDocument);
}

/**
 * ID dokladov, ktoré hlas nezmaže (účtovná stopa). `null` = nepodarilo sa
 * overiť → fail closed (nemaže sa nič).
 */
export async function protectedDocumentIds(db: SupabaseClient, ids: string[]): Promise<Set<string> | null> {
  if (ids.length === 0) return new Set();
  const [invoices, folders, handoff, downloads] = await Promise.all([
    db.from("invoices").select("source_document_id").in("source_document_id", ids),
    db.from("document_folder_items").select("document_id").in("document_id", ids),
    db.from("document_export_package_items").select("document_id").in("document_id", ids),
    db.from("document_download_events").select("document_id").in("document_id", ids),
  ]);
  if (invoices.error || folders.error || handoff.error || downloads.error) return null;
  const blocked = new Set<string>();
  for (const row of (invoices.data ?? []) as { source_document_id: string | null }[]) if (row.source_document_id) blocked.add(row.source_document_id);
  for (const result of [folders, handoff, downloads]) {
    for (const row of (result.data ?? []) as { document_id: string | null }[]) if (row.document_id) blocked.add(row.document_id);
  }
  return blocked;
}

function documentRef(locale: Locale, row: UnassignedRow): EntityRef {
  const fields = row.extracted_fields ?? {};
  const label = String(fields.merchant ?? fields.supplier ?? row.original_filename ?? t(locale, "assistant.inbox.untitled"));
  return { type: "document", id: row.id, label, href: `/ai-evidencia?openDocument=${row.id}` };
}

export async function handleInboxIntent(
  db: SupabaseClient,
  locale: Locale,
  intent: ParsedIntent,
  ctx: { companyId: string },
  createConfirmation: CreateInboxConfirmation
): Promise<IntentResult> {
  const requested = intent.args.documentTypes ?? [];
  const types = typesOf(intent);
  if (types.length === 0) {
    // „Nepriradené dodacie listy" — Inbox tento pojem pre dodacie listy nemá.
    return requested.includes("delivery_note")
      ? { kind: "answer", text: t(locale, "assistant.inbox.deliveryNotesUnsupported") }
      : { kind: "answer", text: t(locale, "assistant.inbox.whichType") };
  }

  const rows = await loadUnassignedDocuments(db, ctx.companyId, types);
  if (rows === null) return { kind: "error", text: t(locale, "search.errors.generic") };

  if (rows.length === 0) {
    return { kind: "answer", text: t(locale, `assistant.inbox.none.${whatKey(types)}`) };
  }

  if (intent.name === "INBOX_LIST_UNASSIGNED") {
    if (intent.args.countOnly) {
      return { kind: "answer", text: t(locale, "assistant.inbox.count", { count: rows.length, label: t(locale, `assistant.inbox.label.${whatKey(types)}`) }) };
    }
    return {
      kind: "list",
      title: t(locale, "assistant.inbox.listTitle", { count: rows.length, what: countForm(locale, types, rows.length) }),
      items: rows.slice(0, 50).map((row) => documentRef(locale, row)),
    };
  }

  // INBOX_DELETE_UNASSIGNED — iba náhľad; nič sa nemaže.
  const blocked = await protectedDocumentIds(db, rows.map((row) => row.id));
  if (blocked === null) return { kind: "error", text: t(locale, "search.errors.generic") };
  const eligible = rows.filter((row) => !blocked.has(row.id));
  const skipped = rows.length - eligible.length;
  if (eligible.length === 0) {
    return { kind: "answer", text: t(locale, "assistant.inbox.allProtected", { count: rows.length, what: countForm(locale, types, rows.length) }) };
  }
  if (eligible.length > INBOX_BULK_DELETE_LIMIT) {
    return { kind: "answer", text: t(locale, "assistant.inbox.tooMany", { count: eligible.length, limit: INBOX_BULK_DELETE_LIMIT }) };
  }

  const documentIds = eligible.map((row) => row.id).sort();
  const confirmationId = await createConfirmation("INBOX_DELETE_UNASSIGNED", { documentIds, documentTypes: types }, documentIds.length);
  if (!confirmationId) return { kind: "error", text: t(locale, "search.errors.generic") };

  const parts = [t(locale, "assistant.inbox.deleteSummary", { count: eligible.length, what: countForm(locale, types, eligible.length) })];
  if (skipped > 0) parts.push(t(locale, "assistant.inbox.deleteSkipped", { count: skipped }));
  if (eligible.length >= INBOX_LARGE_DELETE_WARNING) parts.push(t(locale, "assistant.inbox.deleteLarge", { count: eligible.length }));
  parts.push(t(locale, "assistant.inbox.deleteQuestion"));

  return {
    kind: "action_preview",
    action: "INBOX_DELETE_UNASSIGNED",
    summary: parts.join(" "),
    confirmLabel: t(locale, "assistant.inbox.deleteConfirm", { count: eligible.length }),
    cancelLabel: t(locale, "search.actions.cancelLabel"),
    confirmationId,
    affectedCount: eligible.length,
    destructive: true,
  };
}

/**
 * Vykonanie po potvrdení. Zmaže VÝHRADNE doklady zo snapshotu a iba ak sú
 * všetky stále nepriradené a mimo účtovnej stopy; inak nezmaže nič.
 */
export async function executeInboxDelete(
  db: SupabaseClient,
  locale: Locale,
  ctx: { companyId: string },
  args: Record<string, unknown>,
  expectedCount: number | null
): Promise<IntentResult> {
  const fail = (key = "search.errors.generic"): IntentResult => ({ kind: "action_result", success: false, text: t(locale, key) });
  const ids = Array.isArray(args.documentIds) ? args.documentIds.filter((id): id is string => typeof id === "string") : [];
  if (ids.length === 0 || ids.length > INBOX_BULK_DELETE_LIMIT || (expectedCount !== null && ids.length !== expectedCount)) return fail();

  const { data, error } = await db
    .from("documents")
    .select(INBOX_UNASSIGNED_SELECT)
    .eq("company_id", ctx.companyId)
    .in("id", ids)
    .is("deleted_at", null)
    .is("archived_from_inbox_at", null);
  if (error) return fail();
  const rows = ((data ?? []) as unknown as UnassignedRow[]).filter(isUnassignedInboxDocument);
  if (rows.length !== ids.length) return fail("assistant.inbox.dataChanged");
  const blocked = await protectedDocumentIds(db, ids);
  if (blocked === null) return fail();
  if (blocked.size > 0) return fail("assistant.inbox.dataChanged");

  // Rovnaké kroky ako UI: najprv súbory (originál + prílohy), potom riadky.
  const { data: attachments, error: attachmentsError } = await db
    .from("document_attachments")
    .select("storage_bucket, storage_path")
    .in("document_id", ids)
    .eq("company_id", ctx.companyId);
  if (attachmentsError) return fail();
  const byBucket = new Map<string, string[]>();
  const add = (bucket: string | null, path: string | null) => {
    if (!bucket || !path) return;
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path]);
  };
  for (const row of rows) add(row.storage_bucket, row.storage_path);
  for (const row of (attachments ?? []) as { storage_bucket: string | null; storage_path: string | null }[]) add(row.storage_bucket, row.storage_path);
  for (const [bucket, paths] of byBucket) {
    const { error: removeError } = await db.storage.from(bucket).remove(paths);
    if (removeError) return fail();
  }

  const { data: deleted, error: deleteError } = await db
    .from("documents")
    .delete()
    .in("id", ids)
    .eq("company_id", ctx.companyId)
    .select("id");
  if (deleteError) return fail(deleteError.code === "42501" ? "folders.intent.denied" : "search.errors.generic");
  const count = (deleted ?? []).length;
  return { kind: "action_result", success: count === ids.length, text: t(locale, "assistant.inbox.deleted", { count }) };
}
