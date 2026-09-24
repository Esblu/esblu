import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import { formatDate } from "@/lib/i18n/format";
import type { InvoicePdfBundle } from "@/lib/invoicing/pdf-renderer";
import { safeExtension, safeSegment, isSafeZipPath } from "@/lib/invoicing/handoff-package";
import {
  buildFolderManifest,
  categoryOf,
  documentDate,
  documentPackageFileName,
  documentPackageRoot,
  entryDirectory,
  entryLabel,
  folderPackageProblems,
  planEntry,
  FOLDER_MANIFEST_SCHEMA_VERSION,
  DOCUMENT_PACKAGE_MAX_ENTRIES,
  type DocumentPackageKind,
  type FolderManifest,
  type FolderManifestEntry,
  type FolderManifestExcluded,
  type FolderManifestFile,
  type PackageDocumentInput,
  type PackageEntityType,
  type PackageEntryInput,
  type PackageInvoiceInput,
} from "@/lib/invoicing/document-package";
import type { Invoice, InvoiceItem, InvoiceParty, InvoiceTaxBreakdown } from "@/lib/invoices";

// =============================================================================
// Zloženie balíka dokladov s originálmi — serverová časť.
//
// Pravidlá obsahu sú v lib/invoicing/document-package.ts (bez importov,
// odskúšané testom). Tu je iba zber, sťahovanie, zbalenie a overenie.
//
// AUTORIZÁCIA
// -----------
// Všetko beží cez user-scoped klienta, nikdy cez service_role. RLS na
// invoices, documents, document_links, document_attachments, priečinkoch aj
// Storage rozhoduje o každom riadku a každom objekte. Route navyše vopred
// overí finance.manage — druhá nezávislá vrstva.
//
// PORADIE
// -------
//   zozbieraj → rozhodni (zahrnúť / vynechať) → stiahni → zabal →
//   znova otvor a porovnaj odtlačky → zapíš balík a jeho položky → vráť
//
// Do databázy sa zapisuje iba „balík vznikol a obsahuje tieto doklady".
// Stiahnutie zapisuje až klient po prijatí celých bajtov.
// =============================================================================

export type PackageRef = { type: PackageEntityType; id: string };

export type BuildDocumentPackageInput = {
  db: SupabaseClient;
  locale: Locale;
  companyId: string;
  userId: string;
  kind: DocumentPackageKind;
  folderId: string | null;
  refs: PackageRef[];
  /**
   * Renderer PDF vydanej faktúry. Predvolene ten istý ako pri úplnom balíku
   * a /api/invoices/[id]/pdf; test ho nahrádza, aby nemusel ťahať React PDF.
   */
  renderPdf?: (bundle: InvoicePdfBundle) => Promise<Uint8Array>;
};

async function defaultRenderPdf(bundle: InvoicePdfBundle): Promise<Uint8Array> {
  const { renderInvoicePdfBuffer } = await import("@/lib/invoicing/pdf-renderer");
  return new Uint8Array(await renderInvoicePdfBuffer(bundle));
}

export type BuildDocumentPackageResult =
  | {
      ok: true;
      packageId: string;
      fileName: string;
      zipBytes: Uint8Array;
      packageSha256: string;
      manifestSha256: string;
      manifest: FolderManifest;
    }
  | { ok: false; status: number; code: DocumentPackageErrorCode; excluded?: FolderManifestExcluded[] };

export const DOCUMENT_PACKAGE_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NO_ACTIVE_COMPANY",
  "NO_DOCUMENTS_SELECTED",
  "TOO_MANY_DOCUMENTS",
  "FOLDER_NOT_FOUND",
  "NOTHING_TO_PACKAGE",
  "PACKAGE_TOO_LARGE",
  "INTEGRITY_FAILED",
  "PDF_FAILED",
  "RECORD_FAILED",
  "INTERNAL_ERROR",
] as const;

export type DocumentPackageErrorCode = (typeof DOCUMENT_PACKAGE_ERROR_CODES)[number];

export function isDocumentPackageErrorCode(value: unknown): value is DocumentPackageErrorCode {
  return typeof value === "string" && (DOCUMENT_PACKAGE_ERROR_CODES as readonly string[]).includes(value);
}

/** Prevádzkové prílohy (fotky vozidiel a pod.) do účtovného balíka nepatria. */
const ACCOUNTING_BUCKETS = new Set(["ai-inbox-documents", "ai-evidence-documents"]);

type DocumentRow = {
  id: string;
  company_id: string;
  document_type: string | null;
  status: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  original_filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  content_sha256: string | null;
  deleted_at: string | null;
  extracted_fields: Record<string, unknown> | null;
  note: string | null;
  created_at: string | null;
};

type AttachmentRow = {
  id: string;
  document_id: string;
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
};

class PackageFailure extends Error {
  readonly code: DocumentPackageErrorCode;
  readonly detail: string;
  constructor(code: DocumentPackageErrorCode, detail: string) {
    super(detail);
    this.name = "PackageFailure";
    this.code = code;
    this.detail = detail;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    map.set(k, [...(map.get(k) ?? []), row]);
  }
  return map;
}

const DOCUMENT_COLUMNS =
  "id, company_id, document_type, status, storage_bucket, storage_path, original_filename, mime_type, file_size, content_sha256, deleted_at, extracted_fields, note, created_at";

/** Zoznam odkazov priečinka. `null` = priečinok neexistuje alebo nie je dostupný. */
export async function loadFolderRefs(
  db: SupabaseClient,
  folderId: string
): Promise<{ name: string; refs: PackageRef[] } | null> {
  const { data: folder, error } = await db
    .from("document_folders")
    .select("id, name")
    .eq("id", folderId)
    .maybeSingle();
  if (error || !folder) return null;

  const { data: items, error: itemsError } = await db
    .from("document_folder_items")
    .select("entity_type, invoice_id, document_id")
    .eq("folder_id", folderId)
    .order("created_at", { ascending: true });
  if (itemsError) return null;

  const refs: PackageRef[] = [];
  for (const item of (items ?? []) as { entity_type: string; invoice_id: string | null; document_id: string | null }[]) {
    if (item.entity_type === "invoice" && item.invoice_id) refs.push({ type: "invoice", id: item.invoice_id });
    if (item.entity_type === "document" && item.document_id) refs.push({ type: "document", id: item.document_id });
  }
  return { name: (folder as { name: string }).name, refs };
}

export async function buildDocumentPackage(
  input: BuildDocumentPackageInput
): Promise<BuildDocumentPackageResult> {
  const { db, locale, companyId, userId, kind, folderId } = input;
  const renderPdf = input.renderPdf ?? defaultRenderPdf;

  // Deduplikácia: rovnaký doklad dvakrát vo výbere je jeden doklad.
  const seen = new Set<string>();
  const refs = input.refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (refs.length === 0) return { ok: false, status: 400, code: "NO_DOCUMENTS_SELECTED" };
  if (refs.length > DOCUMENT_PACKAGE_MAX_ENTRIES) return { ok: false, status: 422, code: "TOO_MANY_DOCUMENTS" };

  let folderName: string | null = null;
  if (folderId) {
    const { data: folder } = await db.from("document_folders").select("name").eq("id", folderId).maybeSingle();
    if (!folder) return { ok: false, status: 404, code: "FOLDER_NOT_FOUND" };
    folderName = (folder as { name: string }).name;
  }

  const invoiceIds = refs.filter((r) => r.type === "invoice").map((r) => r.id);
  const documentIds = refs.filter((r) => r.type === "document").map((r) => r.id);

  // -------------------------------------------------------------------------
  // 1. Zber pod RLS
  // -------------------------------------------------------------------------
  let invoices: Invoice[] = [];
  if (invoiceIds.length > 0) {
    const { data, error } = await db.from("invoices").select("*").in("id", invoiceIds).returns<Invoice[]>();
    if (error) return { ok: false, status: 500, code: "INTERNAL_ERROR" };
    invoices = (data ?? []).filter((invoice) => invoice.company_id === companyId);
  }
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const ids = invoices.map((invoice) => invoice.id);

  const [itemsRes, partiesRes, taxRes, linksRes] = ids.length
    ? await Promise.all([
        db.from("invoice_items").select("*").in("invoice_id", ids).order("position", { ascending: true }).returns<InvoiceItem[]>(),
        db.from("invoice_parties").select("*").in("invoice_id", ids).returns<InvoiceParty[]>(),
        db.from("invoice_tax_breakdowns").select("*").in("invoice_id", ids).returns<InvoiceTaxBreakdown[]>(),
        db.from("document_links").select("document_id, invoice_id").in("invoice_id", ids)
          .returns<{ document_id: string; invoice_id: string }[]>(),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

  if (itemsRes.error || partiesRes.error || taxRes.error || linksRes.error) {
    return { ok: false, status: 500, code: "INTERNAL_ERROR" };
  }

  const itemsByInvoice = groupBy((itemsRes.data ?? []) as InvoiceItem[], (x) => x.invoice_id);
  const partiesByInvoice = groupBy((partiesRes.data ?? []) as InvoiceParty[], (x) => x.invoice_id);
  const taxByInvoice = groupBy((taxRes.data ?? []) as InvoiceTaxBreakdown[], (x) => x.invoice_id);

  // Sprievodné dokumenty prijatých faktúr (nie originál).
  const supportingByInvoice = new Map<string, string[]>();
  for (const link of (linksRes.data ?? []) as { document_id: string; invoice_id: string }[]) {
    const invoice = invoiceById.get(link.invoice_id);
    if (!invoice || invoice.source_document_id === link.document_id) continue;
    supportingByInvoice.set(link.invoice_id, [...(supportingByInvoice.get(link.invoice_id) ?? []), link.document_id]);
  }

  const allDocIds = Array.from(
    new Set([
      ...documentIds,
      ...invoices.map((i) => i.source_document_id).filter((id): id is string => Boolean(id)),
      ...Array.from(supportingByInvoice.values()).flat(),
    ])
  );

  let documents: DocumentRow[] = [];
  let attachments: AttachmentRow[] = [];
  if (allDocIds.length > 0) {
    const [docRes, attRes] = await Promise.all([
      db.from("documents").select(DOCUMENT_COLUMNS).in("id", allDocIds).returns<DocumentRow[]>(),
      db.from("document_attachments")
        .select("id, document_id, storage_bucket, storage_path, original_filename, mime_type")
        .in("document_id", allDocIds).returns<AttachmentRow[]>(),
    ]);
    if (docRes.error || attRes.error) return { ok: false, status: 500, code: "INTERNAL_ERROR" };
    documents = (docRes.data ?? []).filter((d) => d.company_id === companyId);
    attachments = attRes.data ?? [];
  }
  const documentById = new Map(documents.map((d) => [d.id, d]));
  const attachmentsByDoc = groupBy(attachments, (a) => a.document_id);

  // Partneri pre prehľad. Chyba tu balík nezastaví — meno je iba pohodlie.
  const partnerIds = Array.from(
    new Set(
      invoices
        .map((i) => (i.direction === "received" ? i.supplier_business_partner_id : i.customer_business_partner_id))
        .filter((id): id is string => Boolean(id))
    )
  );
  const partnerNames = new Map<string, string>();
  if (partnerIds.length > 0) {
    const { data } = await db.from("business_partners").select("id, legal_name").in("id", partnerIds);
    for (const row of (data ?? []) as { id: string; legal_name: string | null }[]) {
      if (row.legal_name) partnerNames.set(row.id, row.legal_name);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Rozhodnutie: čo sa zahrnie, čo sa vynechá a prečo
  // -------------------------------------------------------------------------
  type Planned = { entry: PackageEntryInput; ref: PackageRef };
  const planned: Planned[] = [];
  const excluded: FolderManifestExcluded[] = [];

  for (const ref of refs) {
    if (ref.type === "invoice") {
      const invoice = invoiceById.get(ref.id);
      if (!invoice) {
        excluded.push({ entity_type: "invoice", entity_id: ref.id, label: ref.id.slice(0, 8), reason: "not_accessible" });
        continue;
      }
      const entry: PackageInvoiceInput = {
        entityType: "invoice",
        id: invoice.id,
        direction: invoice.direction,
        document_status: invoice.document_status,
        invoice_number: invoice.invoice_number,
        supplier_invoice_number: invoice.supplier_invoice_number,
        issue_date: invoice.issue_date,
        source_document_id: invoice.source_document_id,
      };
      const source = invoice.source_document_id ? documentById.get(invoice.source_document_id) : undefined;
      const plan = planEntry(entry, {
        sourceDocumentAvailable: Boolean(source && !source.deleted_at && source.storage_path),
      });
      if (!plan.included) {
        excluded.push({ entity_type: "invoice", entity_id: invoice.id, label: entryLabel(entry), reason: plan.reason });
        continue;
      }
      planned.push({ entry, ref });
    } else {
      const doc = documentById.get(ref.id);
      if (!doc) {
        excluded.push({ entity_type: "document", entity_id: ref.id, label: ref.id.slice(0, 8), reason: "not_accessible" });
        continue;
      }
      const entry: PackageDocumentInput = {
        entityType: "document",
        id: doc.id,
        document_type: doc.document_type,
        storage_path: doc.storage_path,
        deleted_at: doc.deleted_at,
        original_filename: doc.original_filename,
        extracted_fields: doc.extracted_fields,
        created_at: doc.created_at,
      };
      const plan = planEntry(entry);
      if (!plan.included) {
        excluded.push({ entity_type: "document", entity_id: doc.id, label: entryLabel(entry), reason: plan.reason });
        continue;
      }
      planned.push({ entry, ref });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Artefakty
  // -------------------------------------------------------------------------
  const packageId = crypto.randomUUID();
  const generatedAt = new Date();
  const root = documentPackageRoot(folderName, generatedAt);
  const fileName = documentPackageFileName(root);

  const files: FolderManifestFile[] = [];
  const payloads = new Map<string, Uint8Array>();
  const entries: FolderManifestEntry[] = [];

  const addFile = (file: Omit<FolderManifestFile, "sha256" | "bytes">, bytes: Uint8Array) => {
    files.push({ ...file, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
    payloads.set(file.path, bytes);
  };

  const fetchObject = async (bucket: string | null, path: string | null): Promise<Uint8Array | null> => {
    if (!bucket || !path || !ACCOUNTING_BUCKETS.has(bucket)) return null;
    const { data, error } = await db.storage.from(bucket).download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  };

  /** Stiahne a overí originál. Nesedí odtlačok → celý balík sa zastaví. */
  const fetchVerified = async (doc: DocumentRow): Promise<Uint8Array | null> => {
    const bytes = await fetchObject(doc.storage_bucket, doc.storage_path);
    if (!bytes) return null;
    if (doc.content_sha256 && doc.content_sha256 !== sha256Hex(bytes)) {
      throw new PackageFailure("INTEGRITY_FAILED", `hash_mismatch:${doc.id}`);
    }
    return bytes;
  };

  const overviewRows: OverviewRow[] = [];

  try {
    for (const { entry } of planned) {
      const dir = entryDirectory(entry);
      let artifactCount = 0;
      let missingSupporting = 0;
      let originalKind: FolderManifestEntry["original"];

      if (entry.entityType === "invoice") {
        const invoice = invoiceById.get(entry.id)!;
        const items = itemsByInvoice.get(invoice.id) ?? [];
        const parties = partiesByInvoice.get(invoice.id) ?? [];
        const breakdown = taxByInvoice.get(invoice.id) ?? [];

        if (invoice.direction === "issued") {
          const seller = parties.find((p) => p.role === "seller") ?? null;
          if (!seller) {
            excluded.push({ entity_type: "invoice", entity_id: invoice.id, label: entryLabel(entry), reason: "missing_original" });
            continue;
          }
          let pdf: Uint8Array;
          try {
            pdf = await renderPdf({
              invoice, seller, buyer: parties.find((p) => p.role === "buyer") ?? null,
              items, taxBreakdowns: breakdown, locale,
            });
          } catch (renderError) {
            console.error("document-package: PDF zlyhalo:", invoice.id,
              renderError instanceof Error ? renderError.message : renderError);
            throw new PackageFailure("PDF_FAILED", `pdf:${invoice.id}`);
          }
          addFile({
            path: `${dir}/invoice.pdf`, kind: "generated_pdf", entity_type: "invoice", entity_id: invoice.id,
            source_document_id: null, provenance: "generated", mime_type: "application/pdf", original_filename: null,
          }, pdf);
          artifactCount++;
          originalKind = "generated_pdf";
        } else {
          const source = documentById.get(invoice.source_document_id ?? "")!;
          const bytes = await fetchVerified(source);
          if (!bytes) {
            // Originál sa v Storage nenašiel. Nenahrádza sa ničím.
            excluded.push({ entity_type: "invoice", entity_id: invoice.id, label: entryLabel(entry), reason: "missing_original" });
            continue;
          }
          addFile({
            path: `${dir}/original.${safeExtension(source.original_filename, source.mime_type)}`,
            kind: "original", entity_type: "invoice", entity_id: invoice.id, source_document_id: source.id,
            provenance: "original", mime_type: source.mime_type, original_filename: source.original_filename,
          }, bytes);
          artifactCount++;
          originalKind = "supplier_original";

          for (const [index, supportingId] of (supportingByInvoice.get(invoice.id) ?? []).entries()) {
            const doc = documentById.get(supportingId);
            const supportingBytes = doc && !doc.deleted_at ? await fetchVerified(doc) : null;
            if (!doc || !supportingBytes) {
              missingSupporting++;
              continue;
            }
            const base = safeSegment((doc.original_filename ?? doc.id).replace(/\.[A-Za-z0-9]{1,8}$/, ""), `dokument-${index + 1}`);
            addFile({
              path: `${dir}/supporting/${base}__${doc.id.slice(0, 8)}.${safeExtension(doc.original_filename, doc.mime_type)}`,
              kind: "supporting", entity_type: "invoice", entity_id: invoice.id, source_document_id: doc.id,
              provenance: "original", mime_type: doc.mime_type, original_filename: doc.original_filename,
            }, supportingBytes);
            artifactCount++;
          }
        }

        const metadata = {
          entity_type: "invoice",
          invoice: {
            id: invoice.id, direction: invoice.direction, kind: invoice.kind,
            document_status: invoice.document_status, payment_status: invoice.payment_status,
            invoice_number: invoice.invoice_number, supplier_invoice_number: invoice.supplier_invoice_number,
            issue_date: invoice.issue_date, delivery_date: invoice.delivery_date,
            tax_point_date: invoice.tax_point_date, due_date: invoice.due_date, currency: invoice.currency,
            variable_symbol: invoice.variable_symbol, subtotal_amount: invoice.subtotal_amount,
            vat_total_amount: invoice.vat_total_amount, rounding_amount: invoice.rounding_amount,
            total_amount: invoice.total_amount, finalized_at: invoice.finalized_at,
            source_document_id: invoice.source_document_id,
          },
          parties: parties.map((p) => ({
            role: p.role, legal_name: p.legal_name, ico: p.ico, dic: p.dic, ic_dph: p.ic_dph,
            address_line1: p.address_line1, city: p.city, postal_code: p.postal_code, country_code: p.country_code,
          })),
          items: items.map((i) => ({
            position: i.position, description: i.description, quantity: i.quantity, unit: i.unit,
            unit_price: i.unit_price, price_mode: i.price_mode, vat_category_code: i.vat_category_code,
            vat_rate: i.vat_rate, line_net_amount: i.line_net_amount, line_vat_amount: i.line_vat_amount,
            line_gross_amount: i.line_gross_amount,
          })),
          vat_breakdown: breakdown.map((b) => ({
            vat_category_code: b.vat_category_code, vat_rate: b.vat_rate,
            taxable_amount: b.taxable_amount, vat_amount: b.vat_amount,
          })),
          original: originalKind,
          missing_supporting_count: missingSupporting,
        };
        addFile({
          path: `${dir}/metadata.json`, kind: "metadata", entity_type: "invoice", entity_id: invoice.id,
          source_document_id: null, provenance: "generated", mime_type: "application/json", original_filename: null,
        }, new TextEncoder().encode(JSON.stringify(metadata, null, 2)));
        artifactCount++;

        const partnerId = invoice.direction === "received" ? invoice.supplier_business_partner_id : invoice.customer_business_partner_id;
        overviewRows.push({
          category: categoryOf(entry), label: entryLabel(entry), date: invoice.issue_date,
          partner: partnerId ? partnerNames.get(partnerId) ?? "" : "",
          amount: invoice.total_amount, currency: invoice.currency, original: originalKind,
          folder: dir, excludedReason: null,
        });
      } else {
        const doc = documentById.get(entry.id)!;
        const bytes = await fetchVerified(doc);
        if (!bytes) {
          excluded.push({ entity_type: "document", entity_id: doc.id, label: entryLabel(entry), reason: "missing_original" });
          continue;
        }
        addFile({
          path: `${dir}/original.${safeExtension(doc.original_filename, doc.mime_type)}`,
          kind: "original", entity_type: "document", entity_id: doc.id, source_document_id: doc.id,
          provenance: "original", mime_type: doc.mime_type, original_filename: doc.original_filename,
        }, bytes);
        artifactCount++;
        originalKind = "uploaded_original";

        for (const att of attachmentsByDoc.get(doc.id) ?? []) {
          const attBytes = await fetchObject(att.storage_bucket, att.storage_path);
          if (!attBytes) {
            missingSupporting++;
            continue;
          }
          const base = safeSegment((att.original_filename ?? att.id).replace(/\.[A-Za-z0-9]{1,8}$/, ""), att.id.slice(0, 8));
          addFile({
            path: `${dir}/attachments/${base}__${att.id.slice(0, 8)}.${safeExtension(att.original_filename, att.mime_type)}`,
            kind: "attachment", entity_type: "document", entity_id: doc.id, source_document_id: doc.id,
            provenance: "original", mime_type: att.mime_type, original_filename: att.original_filename,
          }, attBytes);
          artifactCount++;
        }

        const fields = doc.extracted_fields ?? {};
        const pick = (key: string) => (fields[key] === undefined ? null : fields[key]);
        const metadata = {
          entity_type: "document",
          document: {
            id: doc.id, document_type: doc.document_type, status: doc.status,
            original_filename: doc.original_filename, mime_type: doc.mime_type,
            content_sha256: doc.content_sha256, created_at: doc.created_at, note: doc.note,
          },
          // Iba účtovne podstatné polia — nie celý výstup AI.
          extracted: {
            merchant: pick("merchant"), supplier: pick("supplier"), customer: pick("customer"),
            invoiceNumber: pick("invoiceNumber"), purchaseDate: pick("purchaseDate"),
            issueDate: pick("issueDate"), dueDate: pick("dueDate"), totalAmount: pick("totalAmount"),
            vatAmount: pick("vatAmount"), currency: pick("currency"), paymentMethod: pick("paymentMethod"),
          },
          original: originalKind,
          missing_attachment_count: missingSupporting,
        };
        addFile({
          path: `${dir}/metadata.json`, kind: "metadata", entity_type: "document", entity_id: doc.id,
          source_document_id: null, provenance: "generated", mime_type: "application/json", original_filename: null,
        }, new TextEncoder().encode(JSON.stringify(metadata, null, 2)));
        artifactCount++;

        const amount = Number(String(fields.totalAmount ?? "").replace(",", "."));
        overviewRows.push({
          category: categoryOf(entry), label: entryLabel(entry),
          date: documentDate(doc.extracted_fields) ?? (doc.created_at ? doc.created_at.slice(0, 10) : null),
          partner: String(fields.merchant ?? fields.supplier ?? ""),
          amount: Number.isFinite(amount) && String(fields.totalAmount ?? "") !== "" ? amount : null,
          currency: typeof fields.currency === "string" ? fields.currency : null,
          original: originalKind, folder: dir, excludedReason: null,
        });
      }

      entries.push({
        entity_type: entry.entityType, entity_id: entry.id, category: categoryOf(entry),
        label: entryLabel(entry), folder: dir, original: originalKind,
        artifact_count: artifactCount, missing_supporting_count: missingSupporting,
      });
    }

    if (entries.length === 0) {
      return { ok: false, status: 422, code: "NOTHING_TO_PACKAGE", excluded };
    }

    for (const item of excluded) {
      overviewRows.push({
        category: null, label: item.label, date: null, partner: "", amount: null, currency: null,
        original: null, folder: null, excludedReason: item.reason,
      });
    }

    addFile({
      path: "prehlad.xlsx", kind: "overview", entity_type: null, entity_id: null, source_document_id: null,
      provenance: "generated",
      mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", original_filename: null,
    }, await buildOverviewWorkbook(locale, overviewRows));

    addFile({
      path: "README.txt", kind: "readme", entity_type: null, entity_id: null, source_document_id: null,
      provenance: "generated", mime_type: "text/plain", original_filename: null,
    }, new TextEncoder().encode(readmeText(locale, entries.length, excluded.length)));

    // -----------------------------------------------------------------------
    // 4. Kontrola, manifest, ZIP, overenie
    // -----------------------------------------------------------------------
    const problems = folderPackageProblems(files, entries.length);
    if (problems.length > 0) {
      const first = problems[0];
      throw new PackageFailure(
        first.code === "package_too_large" || first.code === "file_too_large" || first.code === "too_many_files"
          ? "PACKAGE_TOO_LARGE"
          : "INTEGRITY_FAILED",
        first.code
      );
    }

    const manifest = buildFolderManifest({
      package_id: packageId,
      package_kind: kind,
      folder_id: folderId,
      folder_name: folderName,
      company_id: companyId,
      generated_at: generatedAt.toISOString(),
      generated_by: userId,
      app_commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      entries,
      excluded,
      files,
    });

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    const manifestSha256 = sha256Hex(manifestBytes);

    const zip = new JSZip();
    zip.file(`${root}/manifest.json`, manifestBytes);
    for (const [path, bytes] of payloads) {
      if (!isSafeZipPath(path)) throw new PackageFailure("INTEGRITY_FAILED", "unsafe_path");
      zip.file(`${root}/${path}`, bytes);
    }
    const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const packageSha256 = sha256Hex(zipBytes);

    const reopened = await JSZip.loadAsync(zipBytes);
    for (const file of manifest.files) {
      const zipEntry = reopened.file(`${root}/${file.path}`);
      if (!zipEntry) throw new PackageFailure("INTEGRITY_FAILED", "verification_missing_file");
      if (sha256Hex(await zipEntry.async("uint8array")) !== file.sha256) {
        throw new PackageFailure("INTEGRITY_FAILED", "verification_hash_mismatch");
      }
    }
    if (!reopened.file(`${root}/manifest.json`)) throw new PackageFailure("INTEGRITY_FAILED", "verification_missing_manifest");

    // -----------------------------------------------------------------------
    // 5. Záznam o balíku. Stiahnutie sa tu NEZAPISUJE.
    // -----------------------------------------------------------------------
    const { error: packageError } = await db.from("document_export_packages").insert({
      id: packageId,
      company_id: companyId,
      created_by: userId,
      export_kind: kind,
      folder_id: folderId,
      folder_name_snapshot: folderName,
      item_count: entries.length,
      file_count: manifest.file_count,
      package_bytes: zipBytes.byteLength,
      package_sha256: packageSha256,
      manifest_sha256: manifestSha256,
      package_filename: fileName,
      manifest_schema_version: FOLDER_MANIFEST_SCHEMA_VERSION,
      app_commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    });
    if (packageError) {
      console.error("document-package: zápis balíka zlyhal:", packageError.code, packageError.message);
      return { ok: false, status: 500, code: "RECORD_FAILED" };
    }

    const { error: itemsError } = await db.from("document_export_package_items").insert(
      entries.map((entry) => ({
        package_id: packageId,
        company_id: companyId,
        entity_type: entry.entity_type,
        entity_ref: entry.entity_id,
        invoice_id: entry.entity_type === "invoice" ? entry.entity_id : null,
        document_id: entry.entity_type === "document" ? entry.entity_id : null,
        label_snapshot: entry.label.slice(0, 200),
      }))
    );
    if (itemsError) {
      console.error("document-package: zápis položiek zlyhal:", itemsError.code, itemsError.message);
      return { ok: false, status: 500, code: "RECORD_FAILED" };
    }

    return { ok: true, packageId, fileName, zipBytes, packageSha256, manifestSha256, manifest };
  } catch (error) {
    if (error instanceof PackageFailure) {
      console.error("document-package: balík sa nedokončil:", error.code, error.detail);
      return { ok: false, status: 422, code: error.code };
    }
    console.error("document-package: neočakávaná chyba:", error instanceof Error ? error.message : error);
    return { ok: false, status: 500, code: "INTERNAL_ERROR" };
  }
}

// -----------------------------------------------------------------------------
// Prehľad (xlsx) a README
// -----------------------------------------------------------------------------

type OverviewRow = {
  category: ReturnType<typeof categoryOf> | null;
  label: string;
  date: string | null;
  partner: string;
  amount: number | null;
  currency: string | null;
  original: FolderManifestEntry["original"] | null;
  folder: string | null;
  excludedReason: FolderManifestExcluded["reason"] | null;
};

async function buildOverviewWorkbook(locale: Locale, rows: OverviewRow[]): Promise<Uint8Array> {
  const excelJsModule = await import("exceljs");
  const ExcelJS = (excelJsModule as unknown as { default?: typeof excelJsModule }).default ?? excelJsModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Esblu";
  const sheet = workbook.addWorksheet(translate(locale, "folders.package.sheetName"));

  sheet.columns = [
    { header: translate(locale, "folders.package.colType"), key: "type", width: 20 },
    { header: translate(locale, "folders.package.colLabel"), key: "label", width: 34 },
    { header: translate(locale, "folders.package.colDate"), key: "date", width: 14 },
    { header: translate(locale, "folders.package.colPartner"), key: "partner", width: 30 },
    { header: translate(locale, "folders.package.colAmount"), key: "amount", width: 14 },
    { header: translate(locale, "folders.package.colCurrency"), key: "currency", width: 8 },
    { header: translate(locale, "folders.package.colOriginal"), key: "original", width: 26 },
    { header: translate(locale, "folders.package.colStatus"), key: "status", width: 30 },
    { header: translate(locale, "folders.package.colPath"), key: "path", width: 50 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({
      type: row.category ? translate(locale, `folders.category.${row.category}`) : "—",
      label: row.label,
      date: row.date ? formatDate(row.date, locale) : "",
      partner: row.partner,
      amount: row.amount,
      currency: row.currency ?? "",
      original: row.original ? translate(locale, `folders.package.original.${row.original}`) : "—",
      status: row.excludedReason
        ? `${translate(locale, "folders.package.statusExcluded")}: ${translate(locale, `folders.excludedReason.${row.excludedReason}`)}`
        : translate(locale, "folders.package.statusIncluded"),
      path: row.folder ?? "",
    });
  }
  sheet.getColumn("amount").numFmt = "#,##0.00";

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function readmeText(locale: Locale, count: number, excludedCount: number): string {
  return [
    translate(locale, "folders.package.readmeTitle"),
    "",
    translate(locale, "folders.package.readmeIntro", { count, excluded: excludedCount }),
    "",
    translate(locale, "folders.package.readmeStructure"),
    "",
    translate(locale, "folders.package.readmeIntegrity"),
    "",
    translate(locale, "folders.package.readmeDownloaded"),
    "",
  ].join("\n");
}
