import type { SupabaseClient } from "@supabase/supabase-js";
import type { PackageEntityType } from "@/lib/invoicing/document-package";

// =============================================================================
// Priečinky dokladov — prístup k dátam (klient aj server, vždy pod RLS).
//
// Priečinok drží iba ODKAZY. Pridanie, presun ani odobratie sa nedotkne
// faktúry, dokumentu, jeho väzieb (document_links), source_document_id ani
// súboru v Storage. Presun = odobratie odkazu z jedného priečinka a pridanie
// do druhého; doklad sám sa nehýbe.
//
// Oprávnenia drží databáza (esblu_my_finance_manage na každej tabuľke).
// Tu sa nič nerozhoduje — funkcie iba vracajú, čo RLS pustila, a počty,
// ktoré databáza NAOZAJ potvrdila.
// =============================================================================

export type DocumentFolder = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  itemCount: number;
};

export type FolderRef = { type: PackageEntityType; id: string };

export type FolderMutationResult =
  | { ok: true; affected: number }
  | { ok: false; error: "DUPLICATE_NAME" | "INVALID_NAME" | "FORBIDDEN" | "NOT_FOUND" | "FAILED" };

export const FOLDER_NAME_MAX = 120;

/** Meno priečinka: orezané, bez riadiacich znakov, 1–120 znakov. */
export function normalizeFolderName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e]", "g"), "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > FOLDER_NAME_MAX) return null;
  return cleaned;
}

/** Porovnanie mien bez ohľadu na veľkosť písmen a diakritiku. */
export function folderNameKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const SPOKEN_NUMBERS: Record<string, string> = {
  nula: "0", jeden: "1", jedna: "1", jedno: "1", dva: "2", dve: "2", tri: "3", styri: "4", pat: "5",
  sest: "6", sedem: "7", osem: "8", devat: "9", desat: "10",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  null: "0", eins: "1", zwei: "2", drei: "3", vier: "4", funf: "5", fuenf: "5", sechs: "6", sieben: "7", acht: "8", neun: "9", zehn: "10",
};

/**
 * Totožnosť mena pre HLAS: prepis reči nerozlišuje medzery, pomlčky ani
 * číslovky („test1", „Test 1", „test-1", „test jedna" sú to isté meno).
 * Nie je to približná zhoda — odlišné písmená či čísla sa nikdy nezhodujú;
 * dva priečinky s rovnakým kľúčom sú nejednoznačné a asistent sa spýta.
 */
export function folderSpokenKey(name: string): string {
  return folderNameKey(name)
    .split(/[\s\-_.,/]+/)
    .map((token) => SPOKEN_NUMBERS[token] ?? token)
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Nájde priečinok podľa vysloveného mena. Presná zhoda má prednosť; inak
 * jediný priečinok, ktorého meno vyslovený text obsahuje alebo naopak.
 * Viac kandidátov = `ambiguous`, nikdy tichý výber.
 */
export function matchFolderByName<T extends { name: string }>(
  folders: readonly T[],
  spoken: string
): { folder: T } | { ambiguous: T[] } | null {
  const key = folderNameKey(spoken);
  if (!key) return null;
  const exact = folders.filter((f) => folderNameKey(f.name) === key);
  if (exact.length === 1) return { folder: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const spokenKey = folderSpokenKey(spoken);
  const spokenExact = spokenKey ? folders.filter((f) => folderSpokenKey(f.name) === spokenKey) : [];
  if (spokenExact.length === 1) return { folder: spokenExact[0] };
  if (spokenExact.length > 1) return { ambiguous: spokenExact };

  const partial = folders.filter((f) => {
    const fk = folderNameKey(f.name);
    return fk.startsWith(key) || key.startsWith(fk) || fk.includes(key);
  });
  if (partial.length === 1) return { folder: partial[0] };
  if (partial.length > 1) return { ambiguous: partial };
  return null;
}

function mapError(error: { code?: string } | null): FolderMutationResult {
  if (error?.code === "23505") return { ok: false, error: "DUPLICATE_NAME" };
  if (error?.code === "42501") return { ok: false, error: "FORBIDDEN" };
  return { ok: false, error: "FAILED" };
}

export async function listDocumentFolders(db: SupabaseClient): Promise<DocumentFolder[]> {
  const { data, error } = await db
    .from("document_folders")
    .select("id, name, description, created_at, updated_at, created_by, document_folder_items(count)")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("listDocumentFolders zlyhalo:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as (Omit<DocumentFolder, "itemCount"> & {
    document_folder_items: { count: number }[] | null;
  })[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    itemCount: row.document_folder_items?.[0]?.count ?? 0,
  }));
}

export async function createDocumentFolder(
  db: SupabaseClient,
  companyId: string,
  userId: string,
  rawName: string
): Promise<{ ok: true; folder: { id: string; name: string } } | { ok: false; error: "DUPLICATE_NAME" | "INVALID_NAME" | "FORBIDDEN" | "FAILED" }> {
  const name = normalizeFolderName(rawName);
  if (!name) return { ok: false, error: "INVALID_NAME" };

  const { data, error } = await db
    .from("document_folders")
    .insert({ company_id: companyId, name, created_by: userId })
    .select("id, name")
    .maybeSingle();

  if (error || !data) {
    const mapped = mapError(error);
    return { ok: false, error: mapped.ok ? "FAILED" : (mapped.error as "DUPLICATE_NAME" | "FORBIDDEN" | "FAILED") };
  }
  return { ok: true, folder: data as { id: string; name: string } };
}

export async function renameDocumentFolder(
  db: SupabaseClient,
  folderId: string,
  rawName: string
): Promise<FolderMutationResult> {
  const name = normalizeFolderName(rawName);
  if (!name) return { ok: false, error: "INVALID_NAME" };
  const { data, error } = await db.from("document_folders").update({ name }).eq("id", folderId).select("id");
  if (error) return mapError(error);
  const affected = (data ?? []).length;
  return affected === 1 ? { ok: true, affected } : { ok: false, error: "NOT_FOUND" };
}

/**
 * Zmaže PRIEČINOK. Faktúry, dokumenty ani súbory sa nemažú — FK smerujú z
 * členstva na doklad a CASCADE ide iba z priečinka na jeho členstvá.
 */
export async function deleteDocumentFolder(db: SupabaseClient, folderId: string): Promise<FolderMutationResult> {
  const { data, error } = await db.from("document_folders").delete().eq("id", folderId).select("id");
  if (error) return mapError(error);
  const affected = (data ?? []).length;
  return affected === 1 ? { ok: true, affected } : { ok: false, error: "NOT_FOUND" };
}

/**
 * Pridá odkazy do priečinka. Doklady, ktoré tam už sú, sa preskočia (nie
 * sú chybou). Vráti počet NOVO pridaných podľa toho, čo databáza potvrdila.
 */
export async function addItemsToFolder(
  db: SupabaseClient,
  companyId: string,
  userId: string,
  folderId: string,
  refs: readonly FolderRef[]
): Promise<FolderMutationResult & { skipped?: number }> {
  if (refs.length === 0) return { ok: true, affected: 0 };

  const { data: existing, error: existingError } = await db
    .from("document_folder_items")
    .select("invoice_id, document_id")
    .eq("folder_id", folderId);
  if (existingError) return mapError(existingError);

  const present = new Set<string>();
  for (const row of (existing ?? []) as { invoice_id: string | null; document_id: string | null }[]) {
    if (row.invoice_id) present.add(`invoice:${row.invoice_id}`);
    if (row.document_id) present.add(`document:${row.document_id}`);
  }

  const unique = new Map<string, FolderRef>();
  for (const ref of refs) unique.set(`${ref.type}:${ref.id}`, ref);
  const toInsert = Array.from(unique.values()).filter((ref) => !present.has(`${ref.type}:${ref.id}`));
  const skipped = unique.size - toInsert.length;
  if (toInsert.length === 0) return { ok: true, affected: 0, skipped };

  const { data, error } = await db
    .from("document_folder_items")
    .insert(
      toInsert.map((ref) => ({
        folder_id: folderId,
        company_id: companyId,
        entity_type: ref.type,
        invoice_id: ref.type === "invoice" ? ref.id : null,
        document_id: ref.type === "document" ? ref.id : null,
        created_by: userId,
      }))
    )
    .select("id");

  if (error) return mapError(error);
  return { ok: true, affected: (data ?? []).length, skipped };
}

/** Odoberie odkazy z priečinka. Doklad zostáva tam, kde bol. */
export async function removeItemsFromFolder(
  db: SupabaseClient,
  folderId: string,
  refs: readonly FolderRef[]
): Promise<FolderMutationResult> {
  const invoiceIds = refs.filter((r) => r.type === "invoice").map((r) => r.id);
  const documentIds = refs.filter((r) => r.type === "document").map((r) => r.id);
  let affected = 0;

  if (invoiceIds.length > 0) {
    const { data, error } = await db
      .from("document_folder_items").delete()
      .eq("folder_id", folderId).in("invoice_id", invoiceIds).select("id");
    if (error) return mapError(error);
    affected += (data ?? []).length;
  }
  if (documentIds.length > 0) {
    const { data, error } = await db
      .from("document_folder_items").delete()
      .eq("folder_id", folderId).in("document_id", documentIds).select("id");
    if (error) return mapError(error);
    affected += (data ?? []).length;
  }
  return { ok: true, affected };
}

/** Presun = pridať do cieľa, potom odobrať zo zdroja. Pri chybe pridania sa nič neodoberá. */
export async function moveItemsBetweenFolders(
  db: SupabaseClient,
  companyId: string,
  userId: string,
  sourceFolderId: string,
  targetFolderId: string,
  refs: readonly FolderRef[]
): Promise<FolderMutationResult> {
  if (sourceFolderId === targetFolderId) return { ok: true, affected: 0 };
  const added = await addItemsToFolder(db, companyId, userId, targetFolderId, refs);
  if (!added.ok) return added;
  const removed = await removeItemsFromFolder(db, sourceFolderId, refs);
  if (!removed.ok) return removed;
  return { ok: true, affected: refs.length };
}

// -----------------------------------------------------------------------------
// Obsah priečinka s detailmi na zobrazenie
// -----------------------------------------------------------------------------

export type FolderItemView = {
  type: PackageEntityType;
  id: string;
  addedAt: string;
  /** Kanonický druh: vydaná/prijatá faktúra, bloček, … */
  kind: "issued_invoice" | "received_invoice" | "receipt" | "inbox_invoice" | "other_document" | "missing";
  label: string;
  date: string | null;
  partner: string | null;
  amount: number | null;
  currency: string | null;
  draft: boolean;
  /** Existuje originál/podklad, ktorý pôjde do balíka? */
  originalAvailable: boolean;
  href: string | null;
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function listFolderItemViews(db: SupabaseClient, folderId: string): Promise<FolderItemView[]> {
  const { data: items, error } = await db
    .from("document_folder_items")
    .select("entity_type, invoice_id, document_id, created_at")
    .eq("folder_id", folderId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("listFolderItemViews zlyhalo:", error.message);
    return [];
  }

  const rows = (items ?? []) as { entity_type: string; invoice_id: string | null; document_id: string | null; created_at: string }[];
  const invoiceIds = rows.map((r) => r.invoice_id).filter((id): id is string => Boolean(id));
  const documentIds = rows.map((r) => r.document_id).filter((id): id is string => Boolean(id));

  type InvoiceRow = {
    id: string; direction: string; document_status: string; invoice_number: string | null;
    supplier_invoice_number: string | null; issue_date: string | null; total_amount: number | null;
    currency: string | null; source_document_id: string | null;
    supplier_business_partner_id: string | null; customer_business_partner_id: string | null;
  };
  type DocumentRow = {
    id: string; document_type: string | null; storage_path: string | null; deleted_at: string | null;
    original_filename: string | null; extracted_fields: Record<string, unknown> | null; created_at: string | null;
  };

  const [invoiceRes, documentRes] = await Promise.all([
    invoiceIds.length
      ? db.from("invoices").select(
          "id, direction, document_status, invoice_number, supplier_invoice_number, issue_date, total_amount, currency, source_document_id, supplier_business_partner_id, customer_business_partner_id"
        ).in("id", invoiceIds)
      : Promise.resolve({ data: [], error: null }),
    documentIds.length
      ? db.from("documents").select("id, document_type, storage_path, deleted_at, original_filename, extracted_fields, created_at").in("id", documentIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const invoices = new Map(((invoiceRes.data ?? []) as InvoiceRow[]).map((row) => [row.id, row]));
  const documents = new Map(((documentRes.data ?? []) as DocumentRow[]).map((row) => [row.id, row]));

  // Zdrojové dokumenty prijatých faktúr — existuje originál?
  const sourceIds = Array.from(invoices.values()).map((i) => i.source_document_id).filter((id): id is string => Boolean(id));
  const availableSources = new Set<string>();
  if (sourceIds.length) {
    const { data } = await db.from("documents").select("id, storage_path, deleted_at").in("id", sourceIds);
    for (const row of (data ?? []) as { id: string; storage_path: string | null; deleted_at: string | null }[]) {
      if (row.storage_path && !row.deleted_at) availableSources.add(row.id);
    }
  }

  const partnerIds = Array.from(invoices.values())
    .map((i) => (i.direction === "received" ? i.supplier_business_partner_id : i.customer_business_partner_id))
    .filter((id): id is string => Boolean(id));
  const partners = new Map<string, string>();
  if (partnerIds.length) {
    const { data } = await db.from("business_partners").select("id, legal_name").in("id", Array.from(new Set(partnerIds)));
    for (const row of (data ?? []) as { id: string; legal_name: string | null }[]) {
      if (row.legal_name) partners.set(row.id, row.legal_name);
    }
  }

  const views: FolderItemView[] = [];
  for (const row of rows) {
    if (row.entity_type === "invoice" && row.invoice_id) {
      const inv = invoices.get(row.invoice_id);
      if (!inv) {
        views.push({ type: "invoice", id: row.invoice_id, addedAt: row.created_at, kind: "missing", label: "—", date: null,
          partner: null, amount: null, currency: null, draft: false, originalAvailable: false, href: null });
        continue;
      }
      const received = inv.direction === "received";
      const partnerId = received ? inv.supplier_business_partner_id : inv.customer_business_partner_id;
      views.push({
        type: "invoice",
        id: inv.id,
        addedAt: row.created_at,
        kind: received ? "received_invoice" : "issued_invoice",
        label: (received ? inv.supplier_invoice_number : inv.invoice_number) ?? "",
        date: inv.issue_date,
        partner: partnerId ? partners.get(partnerId) ?? null : null,
        amount: typeof inv.total_amount === "number" ? inv.total_amount : Number(inv.total_amount ?? NaN),
        currency: inv.currency,
        draft: inv.document_status !== "finalized",
        originalAvailable: received
          ? Boolean(inv.source_document_id && availableSources.has(inv.source_document_id))
          : inv.document_status === "finalized",
        href: `/faktury/${inv.id}`,
      });
    } else if (row.entity_type === "document" && row.document_id) {
      const doc = documents.get(row.document_id);
      if (!doc) {
        views.push({ type: "document", id: row.document_id, addedAt: row.created_at, kind: "missing", label: "—", date: null,
          partner: null, amount: null, currency: null, draft: false, originalAvailable: false, href: null });
        continue;
      }
      const fields = doc.extracted_fields ?? {};
      const amount = Number(String(fields.totalAmount ?? "").replace(",", "."));
      views.push({
        type: "document",
        id: doc.id,
        addedAt: row.created_at,
        kind: doc.document_type === "receipt" ? "receipt" : doc.document_type === "invoice" ? "inbox_invoice" : "other_document",
        label: textOf(fields.merchant) || textOf(fields.supplier) || textOf(doc.original_filename),
        date: textOf(fields.purchaseDate) || textOf(fields.issueDate) || (doc.created_at ? doc.created_at.slice(0, 10) : null),
        partner: textOf(fields.merchant) || textOf(fields.supplier) || null,
        amount: String(fields.totalAmount ?? "") !== "" && Number.isFinite(amount) ? amount : null,
        currency: textOf(fields.currency) || null,
        draft: false,
        originalAvailable: Boolean(doc.storage_path && !doc.deleted_at),
        href: `/ai-evidencia?openDocument=${doc.id}`,
      });
    }
  }
  return views;
}
