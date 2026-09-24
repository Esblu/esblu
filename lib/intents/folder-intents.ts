import type { SupabaseClient } from "@supabase/supabase-js";
import { INBOX_UNASSIGNED_SELECT, isInboxUnassignedType, isUnassignedInboxDocument, type InboxDocumentRow } from "@/lib/inbox-unassigned";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import { formatDate, formatMoney } from "@/lib/i18n/format";
import type { EntityRef, IntentArgs, IntentName, IntentResult, ParsedIntent } from "@/lib/intents/types";
import {
  addItemsToFolder,
  createDocumentFolder,
  deleteDocumentFolder,
  folderNameKey,
  folderSpokenKey,
  listDocumentFolders,
  listFolderItemViews,
  matchFolderByName,
  normalizeFolderName,
  removeItemsFromFolder,
  type DocumentFolder,
  type FolderRef,
} from "@/lib/document-folders";
import {
  buildDownloadStateMap,
  documentDate,
  downloadStateOf,
  isFolderDocumentType,
  DOCUMENT_PACKAGE_MAX_ENTRIES,
} from "@/lib/invoicing/document-package";

// =============================================================================
// Intent Engine — priečinky dokladov a stav stiahnutia.
//
// OPRÁVNENIA
// ----------
// Volajúci (app/api/assistant/intent/route.ts) overí finance.manage
// (priečinky) alebo finance.view (stav stiahnutia) cez tie isté RPC ako RLS
// EŠTE PRED zavolaním čohokoľvek odtiaľto. Tu sa oprávnenia nerozhodujú —
// všetky dotazy bežia cez user-scoped klienta a RLS má posledné slovo.
//
// ZÁPISY
// ------
// Vytvorenie, pridanie a odobratie vracajú iba náhľad (`action_preview`) s
// počtom a menom priečinka. Zapíše sa až po potvrdení cez
// /api/assistant/action/execute (HMAC potvrdenie, jednorazové). Do potvrdenia
// sa ukladá PRESNÝ zoznam dokladov, ktorý používateľ videl — nie filter,
// ktorý by sa medzitým mohol vyhodnotiť inak.
//
// „TENTO DOKLAD" NA NÁSTENKE
// --------------------------
// Nástenka nemá otvorený doklad ani výber. „Tieto doklady" bez výberu sa
// NIKDY nenahrádza posledným otvoreným záznamom — asistent sa spýta.
// =============================================================================

export const FOLDER_WRITE_INTENTS = ["FOLDER_CREATE", "FOLDER_ADD_ITEMS", "FOLDER_REMOVE_ITEMS", "FOLDER_DELETE"] as const;
export type FolderWriteIntent = (typeof FOLDER_WRITE_INTENTS)[number];

const FOLDER_FAMILY: readonly IntentName[] = [
  "FOLDER_CREATE",
  "FOLDER_OPEN",
  "FOLDER_ADD_ITEMS",
  "FOLDER_REMOVE_ITEMS",
  "FOLDER_LIST_ITEMS",
  "FOLDER_EXPORT",
  "DOCUMENTS_EXPORT",
  "DOCUMENTS_LIST_UNDOWNLOADED",
  "DOCUMENTS_DOWNLOAD_STATUS",
  "FOLDER_DELETE",
];

export function isFolderFamilyIntent(name: string): name is IntentName {
  return (FOLDER_FAMILY as readonly string[]).includes(name);
}

export function isFolderWriteIntent(name: string): name is FolderWriteIntent {
  return (FOLDER_WRITE_INTENTS as readonly string[]).includes(name);
}

/**
 * Aké finančné oprávnenie intent potrebuje. Priečinky a sťahovanie sú
 * správa (manage); prehľad o stave stiahnutia stačí čítať (view).
 */
export function folderIntentPermission(name: IntentName): "manage" | "view" {
  return name === "DOCUMENTS_LIST_UNDOWNLOADED" || name === "DOCUMENTS_DOWNLOAD_STATUS" ? "view" : "manage";
}

export type FolderIntentContext = {
  companyId: string;
  userId: string;
  /** Výber z obrazovky (Faktúry, Inbox, priečinok). Na nástenke `null`. */
  selection: FolderRef[] | null;
  /** Priečinok, z ktorého výber pochádza (pre „presuň"). */
  sourceFolderId: string | null;
  /** Naposledy použitý priečinok v tomto rozhovore („daj TAM …"). */
  folderContextId: string | null;
};

export type CreateConfirmation = (
  intent: FolderWriteIntent,
  canonicalArgs: Record<string, unknown>,
  expectedCount: number | null
) => Promise<string | null>;

/** Nad touto hranicou náhľad výslovne upozorní, že ide o veľa dokladov. */
export const LARGE_BULK_THRESHOLD = 50;

type LabeledRef = FolderRef & {
  kind: "receipt" | "received_invoice" | "issued_invoice" | "other_document";
  label: string;
  date: string | null;
  amount: number | null;
  currency: string | null;
  finalized: boolean;
};

const t = translate;

function answer(text: string): IntentResult {
  return { kind: "answer", text };
}

function actionResult(success: boolean, text: string, folder?: { id: string; name: string }): IntentResult {
  return folder ? { kind: "action_result", success, text, folder } : { kind: "action_result", success, text };
}

function folderEntity(folder: { id: string; name: string }): EntityRef {
  return { type: "folder", id: folder.id, label: folder.name, href: `/priecinky/${folder.id}` };
}

function periodSuffix(locale: Locale, args: IntentArgs): string {
  if (!args.dateFrom || !args.dateTo) return "";
  return t(locale, "folders.intent.periodSuffix", {
    from: formatDate(args.dateFrom, locale),
    to: formatDate(args.dateTo, locale),
  });
}

function inRange(date: string | null, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (!date) return false;
  const day = date.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Rozlíšenie priečinka
// -----------------------------------------------------------------------------

type FolderResolution = { folder: DocumentFolder } | { result: IntentResult };

async function resolveFolder(
  db: SupabaseClient,
  locale: Locale,
  spokenName: string | undefined,
  contextId: string | null
): Promise<FolderResolution> {
  const folders = await listDocumentFolders(db);

  if (spokenName) {
    const match = matchFolderByName(folders, spokenName);
    if (match && "folder" in match) return { folder: match.folder };
    if (match && "ambiguous" in match) {
      return {
        result: { kind: "list", title: t(locale, "folders.intent.whichFolderList"), items: match.ambiguous.map(folderEntity), awaiting: { slot: "folder" } },
      };
    }
    return { result: { kind: "not_found", text: t(locale, "folders.intent.notFound", { name: spokenName }), awaiting: { slot: "folder" } } };
  }

  // Bez mena: priečinok z tohto rozhovoru (overený pod RLS — je v zozname),
  // alebo jediný existujúci. Inak sa pýtame — nikdy nevyberáme sami.
  const fromContext = contextId ? folders.find((f) => f.id === contextId) : undefined;
  if (fromContext) return { folder: fromContext };
  if (folders.length === 1) return { folder: folders[0] };
  if (folders.length === 0) return { result: answer(t(locale, "folders.empty")) };
  // Otázka „Do ktorého priečinka?" — odpoveď (napr. „August 2026") doplní
  // meno a pokračuje sa pôvodným príkazom (lib/intents/pending-clarification.ts).
  return {
    result: { kind: "list", title: t(locale, "folders.intent.whichFolder"), items: folders.slice(0, 12).map(folderEntity), awaiting: { slot: "folder" } },
  };
}

// -----------------------------------------------------------------------------
// Doklady podľa filtra alebo výberu
// -----------------------------------------------------------------------------

async function collectByFilter(db: SupabaseClient, args: IntentArgs): Promise<LabeledRef[]> {
  if (args.unassignedOnly) return collectUnassigned(db, args);
  const types = args.documentTypes ?? [];
  const wantsInvoices = types.length === 0 || types.includes("invoice");
  const documentTypes = types.length === 0 ? ["receipt"] : types.filter((type) => type !== "invoice" && isFolderDocumentType(type));

  const refs: LabeledRef[] = [];

  if (wantsInvoices) {
    let query = db
      .from("invoices")
      .select("id, direction, document_status, invoice_number, supplier_invoice_number, issue_date, total_amount, currency")
      .order("issue_date", { ascending: true })
      .limit(1000);
    if (args.invoiceDirection) query = query.eq("direction", args.invoiceDirection);
    if (args.dateFrom) query = query.gte("issue_date", args.dateFrom);
    if (args.dateTo) query = query.lte("issue_date", args.dateTo);
    const { data } = await query;
    for (const row of (data ?? []) as {
      id: string; direction: string; document_status: string; invoice_number: string | null;
      supplier_invoice_number: string | null; issue_date: string | null; total_amount: number | null; currency: string | null;
    }[]) {
      const received = row.direction === "received";
      refs.push({
        type: "invoice",
        id: row.id,
        kind: received ? "received_invoice" : "issued_invoice",
        label: (received ? row.supplier_invoice_number : row.invoice_number) ?? "",
        date: row.issue_date,
        amount: row.total_amount === null ? null : Number(row.total_amount),
        currency: row.currency,
        finalized: row.document_status === "finalized",
      });
    }
  }

  if (documentTypes.length > 0) {
    const { data } = await db
      .from("documents")
      .select("id, document_type, extracted_fields, original_filename, created_at")
      .in("document_type", documentTypes)
      .is("deleted_at", null)
      .limit(1000);
    for (const row of (data ?? []) as {
      id: string; document_type: string; extracted_fields: Record<string, unknown> | null;
      original_filename: string | null; created_at: string | null;
    }[]) {
      const date = documentDate(row.extracted_fields) ?? row.created_at;
      if (!inRange(date, args.dateFrom, args.dateTo)) continue;
      const fields = row.extracted_fields ?? {};
      const amount = Number(String(fields.totalAmount ?? "").replace(",", "."));
      refs.push({
        type: "document",
        id: row.id,
        kind: row.document_type === "receipt" ? "receipt" : "other_document",
        label: String(fields.merchant ?? fields.supplier ?? row.original_filename ?? ""),
        date,
        amount: String(fields.totalAmount ?? "") !== "" && Number.isFinite(amount) ? amount : null,
        currency: typeof fields.currency === "string" ? fields.currency : null,
        finalized: true,
      });
    }
  }

  return refs;
}

/**
 * „Nepriradené bločky / faktúry" — presne tie doklady, ktoré Inbox ukazuje
 * v zložkách Bločky a Faktúry (lib/inbox-unassigned.ts). Riadne faktúry
 * z modulu Faktúry sem nepatria.
 */
async function collectUnassigned(db: SupabaseClient, args: IntentArgs): Promise<LabeledRef[]> {
  const types = (args.documentTypes ?? []).filter(isInboxUnassignedType);
  if (types.length === 0) return [];
  const { data } = await db
    .from("documents")
    .select(INBOX_UNASSIGNED_SELECT)
    .in("document_type", types)
    .is("deleted_at", null)
    .is("archived_from_inbox_at", null)
    .limit(1000);
  const refs: LabeledRef[] = [];
  for (const row of ((data ?? []) as unknown as (InboxDocumentRow & {
    extracted_fields: Record<string, unknown> | null; original_filename: string | null; created_at: string | null;
  })[]).filter(isUnassignedInboxDocument)) {
    const date = documentDate(row.extracted_fields) ?? row.created_at;
    if (!inRange(date, args.dateFrom, args.dateTo)) continue;
    const fields = row.extracted_fields ?? {};
    const amount = Number(String(fields.totalAmount ?? "").replace(",", "."));
    refs.push({
      type: "document",
      id: row.id,
      kind: row.document_type === "receipt" ? "receipt" : "other_document",
      label: String(fields.merchant ?? fields.supplier ?? row.original_filename ?? ""),
      date,
      amount: String(fields.totalAmount ?? "") !== "" && Number.isFinite(amount) ? amount : null,
      currency: typeof fields.currency === "string" ? fields.currency : null,
      finalized: true,
    });
  }
  return refs;
}

/** Výber z obrazovky, overený pod RLS — cudzí či neexistujúci doklad vypadne. */
async function collectSelection(db: SupabaseClient, selection: FolderRef[]): Promise<LabeledRef[]> {
  const invoiceIds = selection.filter((r) => r.type === "invoice").map((r) => r.id);
  const documentIds = selection.filter((r) => r.type === "document").map((r) => r.id);
  const refs: LabeledRef[] = [];
  if (invoiceIds.length) {
    const { data } = await db
      .from("invoices")
      .select("id, direction, document_status, invoice_number, supplier_invoice_number, issue_date, total_amount, currency")
      .in("id", invoiceIds);
    for (const row of (data ?? []) as {
      id: string; direction: string; document_status: string; invoice_number: string | null;
      supplier_invoice_number: string | null; issue_date: string | null; total_amount: number | null; currency: string | null;
    }[]) {
      const received = row.direction === "received";
      refs.push({
        type: "invoice", id: row.id, kind: received ? "received_invoice" : "issued_invoice",
        label: (received ? row.supplier_invoice_number : row.invoice_number) ?? "", date: row.issue_date,
        amount: row.total_amount === null ? null : Number(row.total_amount), currency: row.currency,
        finalized: row.document_status === "finalized",
      });
    }
  }
  if (documentIds.length) {
    const { data } = await db
      .from("documents")
      .select("id, document_type, extracted_fields, original_filename, created_at, deleted_at")
      .in("id", documentIds);
    for (const row of (data ?? []) as {
      id: string; document_type: string; extracted_fields: Record<string, unknown> | null;
      original_filename: string | null; created_at: string | null; deleted_at: string | null;
    }[]) {
      if (row.deleted_at || !isFolderDocumentType(row.document_type)) continue;
      const fields = row.extracted_fields ?? {};
      refs.push({
        type: "document", id: row.id, kind: row.document_type === "receipt" ? "receipt" : "other_document",
        label: String(fields.merchant ?? fields.supplier ?? row.original_filename ?? ""),
        date: documentDate(row.extracted_fields) ?? row.created_at, amount: null, currency: null, finalized: true,
      });
    }
  }
  return refs;
}

function typesSummary(locale: Locale, refs: readonly LabeledRef[]): string {
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1);
  const labels: Record<LabeledRef["kind"], string> = {
    receipt: t(locale, "folders.intent.typeReceipts"),
    received_invoice: t(locale, "folders.intent.typeReceivedInvoices"),
    issued_invoice: t(locale, "folders.intent.typeIssuedInvoices"),
    other_document: t(locale, "folders.intent.typeOther"),
  };
  return Array.from(counts.entries())
    .map(([kind, count]) => `${labels[kind as LabeledRef["kind"]]}: ${count}`)
    .join(", ");
}

function hasFilter(args: IntentArgs): boolean {
  return Boolean(args.documentTypes?.length || args.dateFrom || args.dateTo || args.invoiceDirection);
}

async function folderMembers(db: SupabaseClient, folderId: string): Promise<Set<string>> {
  const { data } = await db.from("document_folder_items").select("invoice_id, document_id").eq("folder_id", folderId);
  const set = new Set<string>();
  for (const row of (data ?? []) as { invoice_id: string | null; document_id: string | null }[]) {
    if (row.invoice_id) set.add(`invoice:${row.invoice_id}`);
    if (row.document_id) set.add(`document:${row.document_id}`);
  }
  return set;
}

function refLine(locale: Locale, ref: LabeledRef): string {
  return [
    ref.label || t(locale, `folders.kind.${ref.kind}`),
    t(locale, `folders.kind.${ref.kind}`),
    ref.date ? formatDate(ref.date, locale) : "",
    ref.amount !== null && Number.isFinite(ref.amount) ? formatMoney(ref.amount, ref.currency, locale) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function refHref(ref: FolderRef): string {
  return ref.type === "invoice" ? `/faktury/${ref.id}` : `/ai-evidencia?openDocument=${ref.id}`;
}

// -----------------------------------------------------------------------------
// Vstupný bod z route
// -----------------------------------------------------------------------------

export async function handleFolderIntent(
  db: SupabaseClient,
  locale: Locale,
  intent: ParsedIntent,
  ctx: FolderIntentContext,
  createConfirmation: CreateConfirmation
): Promise<IntentResult> {
  const args = intent.args;

  switch (intent.name) {
    case "FOLDER_CREATE": {
      const name = normalizeFolderName(args.folderName);
      if (!name) return answer(t(locale, "folders.intent.invalidName"));
      const folders = await listDocumentFolders(db);
      const existing = folders.find((f) => folderNameKey(f.name) === folderNameKey(name));
      if (existing) {
        return actionResult(false, t(locale, "folders.intent.alreadyExists", { name: existing.name }), existing);
      }
      const confirmationId = await createConfirmation("FOLDER_CREATE", { name }, null);
      if (!confirmationId) return { kind: "error", text: t(locale, "search.errors.generic") };
      return {
        kind: "action_preview",
        action: "FOLDER_CREATE",
        summary: t(locale, "folders.intent.createSummary", { name }),
        confirmLabel: t(locale, "folders.intent.createConfirm"),
        cancelLabel: t(locale, "search.actions.cancelLabel"),
        confirmationId,
      };
    }

    case "FOLDER_OPEN": {
      const resolved = await resolveFolder(db, locale, args.folderName, ctx.folderContextId);
      if ("result" in resolved) {
        // Bez mena a bez kontextu: zoznam všetkých priečinkov je užitočnejší než otázka.
        if (!args.folderName) {
          const folders = await listDocumentFolders(db);
          if (folders.length > 0) {
            return { kind: "list", title: t(locale, "folders.intent.foldersTitle"), items: folders.map(folderEntity) };
          }
        }
        return resolved.result;
      }
      return { kind: "navigate", entity: folderEntity(resolved.folder) };
    }

    case "FOLDER_LIST_ITEMS": {
      const resolved = await resolveFolder(db, locale, args.folderName, ctx.folderContextId);
      if ("result" in resolved) return resolved.result;
      const views = await listFolderItemViews(db, resolved.folder.id);
      return {
        kind: "list",
        title: t(locale, "folders.intent.listTitle", { name: resolved.folder.name, count: views.length }),
        items: [
          folderEntity(resolved.folder),
          ...views.slice(0, 50).map((view) => ({
            type: view.type,
            id: view.id,
            label: [
              view.label || t(locale, `folders.kind.${view.kind}`),
              t(locale, `folders.kind.${view.kind}`),
              view.date ? formatDate(view.date, locale) : "",
            ].filter(Boolean).join(" · "),
            href: view.href ?? `/priecinky/${resolved.folder.id}`,
          })),
        ],
      };
    }

    case "FOLDER_ADD_ITEMS": {
      const resolved = await resolveFolder(db, locale, args.folderName, ctx.folderContextId);
      if ("result" in resolved) return resolved.result;
      const folder = resolved.folder;

      let refs: LabeledRef[];
      if (args.useSelection) {
        if (!ctx.selection || ctx.selection.length === 0) return answer(t(locale, "folders.intent.noSelection"));
        refs = await collectSelection(db, ctx.selection);
      } else {
        if (!hasFilter(args)) return answer(t(locale, "folders.intent.missingFilter"));
        refs = await collectByFilter(db, args);
      }
      if (refs.length === 0) return { kind: "not_found", text: t(locale, "folders.intent.noMatches") };

      const members = await folderMembers(db, folder.id);
      const fresh = refs.filter((ref) => !members.has(`${ref.type}:${ref.id}`));
      if (fresh.length === 0) {
        return actionResult(true, t(locale, "folders.intent.addNothingNew", { name: folder.name }), folder);
      }
      if (fresh.length > DOCUMENT_PACKAGE_MAX_ENTRIES) {
        return answer(t(locale, "folders.package.errors.TOO_MANY_DOCUMENTS", { max: DOCUMENT_PACKAGE_MAX_ENTRIES }));
      }

      const move = Boolean(args.move && args.useSelection && ctx.sourceFolderId && ctx.sourceFolderId !== folder.id);
      const canonicalRefs = fresh.map((ref) => ({ type: ref.type, id: ref.id }));
      const confirmationId = await createConfirmation(
        "FOLDER_ADD_ITEMS",
        { folderId: folder.id, refs: canonicalRefs, sourceFolderId: move ? ctx.sourceFolderId : null },
        canonicalRefs.length
      );
      if (!confirmationId) return { kind: "error", text: t(locale, "search.errors.generic") };

      const vars = { count: fresh.length, name: folder.name, types: typesSummary(locale, fresh) };
      return {
        kind: "action_preview",
        action: "FOLDER_ADD_ITEMS",
        summary:
          fresh.length > LARGE_BULK_THRESHOLD
            ? t(locale, "folders.intent.addSummaryLarge", vars)
            : t(locale, "folders.intent.addSummary", vars),
        confirmLabel: t(locale, "folders.intent.addConfirm"),
        cancelLabel: t(locale, "search.actions.cancelLabel"),
        confirmationId,
        affectedCount: fresh.length,
      };
    }

    case "FOLDER_REMOVE_ITEMS": {
      const resolved = await resolveFolder(db, locale, args.folderName, ctx.folderContextId ?? ctx.sourceFolderId);
      if ("result" in resolved) return resolved.result;
      const folder = resolved.folder;
      const members = await folderMembers(db, folder.id);

      let refs: LabeledRef[];
      if (args.useSelection) {
        if (!ctx.selection || ctx.selection.length === 0) return answer(t(locale, "folders.intent.noSelection"));
        refs = await collectSelection(db, ctx.selection);
      } else {
        if (!hasFilter(args)) return answer(t(locale, "folders.intent.missingFilter"));
        refs = await collectByFilter(db, args);
      }
      const inFolder = refs.filter((ref) => members.has(`${ref.type}:${ref.id}`));
      if (inFolder.length === 0) return { kind: "not_found", text: t(locale, "folders.intent.noMatches") };

      const canonicalRefs = inFolder.map((ref) => ({ type: ref.type, id: ref.id }));
      const confirmationId = await createConfirmation(
        "FOLDER_REMOVE_ITEMS",
        { folderId: folder.id, refs: canonicalRefs },
        canonicalRefs.length
      );
      if (!confirmationId) return { kind: "error", text: t(locale, "search.errors.generic") };
      return {
        kind: "action_preview",
        action: "FOLDER_REMOVE_ITEMS",
        summary: t(locale, "folders.intent.removeSummary", { count: inFolder.length, name: folder.name }),
        confirmLabel: t(locale, "folders.intent.removeConfirm"),
        cancelLabel: t(locale, "search.actions.cancelLabel"),
        confirmationId,
        affectedCount: inFolder.length,
      };
    }

    case "FOLDER_EXPORT": {
      const resolved = await resolveFolder(db, locale, args.folderName, ctx.folderContextId);
      if ("result" in resolved) return resolved.result;
      const folder = resolved.folder;
      if (folder.itemCount === 0) return answer(t(locale, "folders.intent.exportEmpty", { name: folder.name }));
      return {
        kind: "action_preview",
        action: "FOLDER_EXPORT",
        summary: t(locale, "folders.intent.exportSummary", { name: folder.name, count: folder.itemCount }),
        confirmLabel: t(locale, "folders.intent.exportConfirm"),
        cancelLabel: t(locale, "search.actions.cancelLabel"),
        affectedCount: folder.itemCount,
        packageRequest: { kind: "folder", folderId: folder.id, folderName: folder.name },
      };
    }

    case "DOCUMENTS_EXPORT": {
      const refs = args.useSelection && ctx.selection?.length
        ? await collectSelection(db, ctx.selection)
        : await collectByFilter(db, args);
      const packable = refs.filter((ref) => ref.finalized);
      if (packable.length === 0) return { kind: "not_found", text: t(locale, "folders.intent.noMatches") };
      if (packable.length > DOCUMENT_PACKAGE_MAX_ENTRIES) {
        return answer(t(locale, "folders.package.errors.TOO_MANY_DOCUMENTS", { max: DOCUMENT_PACKAGE_MAX_ENTRIES }));
      }
      return {
        kind: "action_preview",
        action: "DOCUMENTS_EXPORT",
        summary: `${t(locale, "folders.downloadSelected")}: ${typesSummary(locale, packable)}${periodSuffix(locale, args)}`,
        confirmLabel: t(locale, "folders.downloadSelected"),
        cancelLabel: t(locale, "search.actions.cancelLabel"),
        affectedCount: packable.length,
        packageRequest: { kind: "selection", items: packable.map((ref) => ({ type: ref.type, id: ref.id })) },
      };
    }

    case "DOCUMENTS_LIST_UNDOWNLOADED":
    case "DOCUMENTS_DOWNLOAD_STATUS": {
      const refs = (await collectByFilter(db, args)).filter((ref) => ref.finalized);
      const { data } = await db.rpc("esblu_document_download_summary");
      const states = buildDownloadStateMap((data as unknown[]) ?? []);
      const pending = refs.filter((ref) => {
        const state = downloadStateOf(states, ref.type, ref.id);
        return args.byAccountant ? state.accountantCount === 0 : !state.downloaded;
      });
      const period = periodSuffix(locale, args);

      if (intent.name === "DOCUMENTS_LIST_UNDOWNLOADED") {
        if (pending.length === 0) return answer(t(locale, "folders.intent.undownloadedNone", { period }));
        return {
          kind: "list",
          title: t(locale, "folders.intent.undownloadedTitle", { period, count: pending.length }),
          items: pending.slice(0, 50).map((ref) => ({
            type: ref.type === "invoice" ? "invoice" : "document",
            id: ref.id,
            label: refLine(locale, ref),
            href: refHref(ref),
          })),
        };
      }

      const onlyInvoices = (args.documentTypes ?? []).length > 0 && (args.documentTypes ?? []).every((x) => x === "invoice");
      const what = t(locale, onlyInvoices ? "folders.intent.whatInvoices" : "folders.intent.whatDocuments");
      if (refs.length === 0) return answer(t(locale, "folders.intent.statusNone", { what, period }));
      const vars = { pending: pending.length, total: refs.length, what, period };
      if (pending.length === 0) {
        return answer(t(locale, args.byAccountant ? "folders.intent.statusAllAccountant" : "folders.intent.statusAllAnyone", vars));
      }
      return answer(
        t(locale, args.byAccountant ? "folders.intent.statusPendingAccountant" : "folders.intent.statusPendingAnyone", vars)
      );
    }

    case "FOLDER_DELETE": {
      // Nebezpečné: iba PRESNÉ meno. Približná zhoda = otázka, nikdy tichý výber.
      const folders = await listDocumentFolders(db);
      // Potvrdený kandidát („Myslíte priečinok X? — Áno") — ID zo zapečatenej
      // otázky servera, overené znova v zozname pod RLS.
      const confirmed = args.entityId ? folders.find((f) => f.id === args.entityId) : undefined;
      if (args.entityId && !confirmed) return { kind: "not_found", text: t(locale, "folders.intent.notFound", { name: args.folderName ?? "" }) };
      if (!confirmed && !args.folderName) {
        return folders.length
          ? { kind: "list", title: t(locale, "folders.intent.whichFolderList"), items: folders.slice(0, 12).map(folderEntity), awaiting: { slot: "folder" } }
          : answer(t(locale, "folders.empty"));
      }
      // Presná totožnosť mena; hlasový prepis „test1" = „Test 1" (medzery,
      // pomlčky, číslovky). Stále žiadna približná zhoda — tá vedie na otázku.
      const spokenKey = folderSpokenKey(args.folderName ?? "");
      const exact = confirmed ? [confirmed] : spokenKey ? folders.filter((f) => folderSpokenKey(f.name) === spokenKey) : [];
      if (exact.length !== 1) {
        const match = matchFolderByName(folders, args.folderName ?? "");
        if (!match) return { kind: "not_found", text: t(locale, "folders.intent.notFound", { name: args.folderName ?? "" }), awaiting: { slot: "folder" } };
        if ("folder" in match) {
          const ref = folderEntity(match.folder);
          return {
            kind: "answer",
            text: t(locale, "folders.intent.confirmCandidate", { name: match.folder.name }),
            entity: ref,
            awaiting: { slot: "folder", candidate: { id: match.folder.id, label: match.folder.name } },
          };
        }
        return { kind: "list", title: t(locale, "folders.intent.whichFolderList"), items: match.ambiguous.map(folderEntity), awaiting: { slot: "folder" } };
      }
      const folder = exact[0];
      const confirmationId = await createConfirmation("FOLDER_DELETE", { folderId: folder.id, name: folder.name }, folder.itemCount);
      if (!confirmationId) return { kind: "error", text: t(locale, "search.errors.generic") };
      return {
        kind: "action_preview",
        action: "FOLDER_DELETE",
        summary: t(locale, "folders.intent.deleteSummary", { name: folder.name, count: folder.itemCount }),
        confirmLabel: t(locale, "folders.intent.deleteConfirm"),
        cancelLabel: t(locale, "search.actions.cancelLabel"),
        confirmationId,
        affectedCount: folder.itemCount,
        destructive: true,
      };
    }

    default:
      return { kind: "error", text: t(locale, "search.errors.generic") };
  }
}

// -----------------------------------------------------------------------------
// Vykonanie po potvrdení (volá lib/intents/actions.ts#executeAction)
// -----------------------------------------------------------------------------

function readRefs(value: unknown): FolderRef[] {
  if (!Array.isArray(value)) return [];
  const refs: FolderRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const { type, id } = raw as { type?: unknown; id?: unknown };
    if ((type === "invoice" || type === "document") && typeof id === "string") refs.push({ type, id });
  }
  return refs;
}

export async function executeFolderAction(
  db: SupabaseClient,
  locale: Locale,
  ctx: { companyId: string; userId: string },
  intent: FolderWriteIntent,
  args: Record<string, unknown>,
  expectedCount: number | null
): Promise<IntentResult> {
  const fail = (key = "search.errors.generic") => actionResult(false, t(locale, key));

  if (intent === "FOLDER_CREATE") {
    const created = await createDocumentFolder(db, ctx.companyId, ctx.userId, String(args.name ?? ""));
    if (!created.ok) {
      if (created.error === "DUPLICATE_NAME") {
        return actionResult(false, t(locale, "folders.intent.alreadyExists", { name: String(args.name ?? "") }));
      }
      if (created.error === "FORBIDDEN") return fail("folders.intent.denied");
      return fail();
    }
    return actionResult(true, t(locale, "folders.intent.created", { name: created.folder.name }), created.folder);
  }

  const folderId = typeof args.folderId === "string" ? args.folderId : "";
  const { data: folderRow } = await db.from("document_folders").select("id, name").eq("id", folderId).maybeSingle();
  if (!folderRow) return fail("folders.errors.notFound");
  const folder = folderRow as { id: string; name: string };

  if (intent === "FOLDER_DELETE") {
    // Zmaže sa priečinok a jeho členstvá (CASCADE). Faktúry, doklady,
    // originály, udalosti stiahnutia ani evidencia odovzdania sa netýkajú.
    const deleted = await deleteDocumentFolder(db, folder.id);
    if (!deleted.ok) return fail(deleted.error === "FORBIDDEN" ? "folders.intent.denied" : "search.errors.generic");
    return actionResult(true, t(locale, "folders.intent.deleted", { name: folder.name }));
  }
  const refs = readRefs(args.refs);
  if (expectedCount !== null && refs.length !== expectedCount) return fail("folders.intent.dataChanged");

  if (intent === "FOLDER_ADD_ITEMS") {
    const added = await addItemsToFolder(db, ctx.companyId, ctx.userId, folder.id, refs);
    if (!added.ok) return fail(added.error === "FORBIDDEN" ? "folders.intent.denied" : "search.errors.generic");
    const sourceFolderId = typeof args.sourceFolderId === "string" ? args.sourceFolderId : null;
    if (sourceFolderId && sourceFolderId !== folder.id) {
      await removeItemsFromFolder(db, sourceFolderId, refs);
    }
    return actionResult(true, t(locale, "folders.intent.added", { name: folder.name, count: added.affected }), folder);
  }

  const removed = await removeItemsFromFolder(db, folder.id, refs);
  if (!removed.ok) return fail();
  return actionResult(true, t(locale, "folders.intent.removed", { name: folder.name, count: removed.affected }), folder);
}
