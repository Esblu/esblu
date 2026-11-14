import JSZip from "jszip";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyRequestUser } from "@/lib/server-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { resolveActiveMembershipForUser } from "@/lib/active-membership-server";
import { requestSessionId } from "@/lib/request-session";
import {
  COMPANY_EXPORT_EXCLUDED,
  COMPANY_EXPORT_FILE_SOURCES,
  COMPANY_EXPORT_FILES_PER_PART,
  COMPANY_EXPORT_TABLES,
  buildEinvoiceLifecycle,
  exportFilePartCount,
  normalizeExportFiles,
  rowsToCsv,
  sliceExportFiles,
  zipSafePath,
  type StorageFileRef,
} from "@/lib/company-export";
import {
  buildReadableCsvFiles,
  companyOverview,
  HUMAN_READABLE_VERSION,
  INVOICE_PREVIEW_NOTICE,
  issuedInvoiceBundles,
  README_TEXT,
  READABLE_ROOT,
  READABLE_SOURCE_DATASETS,
  type ReadableDatasets,
  type ReadableFile,
} from "@/lib/company-export-readable";

// =============================================================================
// POST /api/company/export — export údajov AKTÍVNEJ firmy (iba owner).
//   { part: "data" }               → ZIP: data/<tabuľka>.json + .csv, manifest
//   { part: "files", index: n }    → ZIP: n-tá dávka originálnych súborov
// VOP 1.2 čl. 19 / 20.6, DPA (vrátenie údajov). Firma sa neberie z klienta.
// Logy iba kódy (žiadne cesty súborov ani obsah).
// =============================================================================

export const runtime = "nodejs";
export const maxDuration = 300;

const PAGE = 1000;
/** Verzia schémy exportu (manifest + server-side dôkaz company_export_runs). */
const COMPANY_EXPORT_SCHEMA_VERSION = "2026-11-13.einvoice-lifecycle";
/** Čitateľná vrstva: max. počet PDF vizualizácií faktúr a časový rozpočet (zvyšok iba v Zoznam_faktur.csv). */
const READABLE_INVOICE_PDF_CAP = 200;
const READABLE_PDF_BUDGET_MS = 90_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_CHUNK = 200;

type Row = Record<string, unknown>;

async function fetchAll(admin: SupabaseClient, table: string, column: string, values: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < values.length; i += INVOICE_CHUNK) {
    const chunk = values.slice(i, i + INVOICE_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const base = () => (chunk.length === 1
        ? admin.from(table).select("*").eq(column, chunk[0])
        : admin.from(table).select("*").in(column, chunk));
      // Stabilné stránkovanie podľa id; tabuľka bez stĺpca id (42703) → bez poradia.
      let { data, error } = await base().order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error?.code === "42703") ({ data, error } = await base().range(from, from + PAGE - 1));
      if (error) {
        // Tabuľka ešte neexistuje v staršom prostredí → prázdna.
        if (error.code === "42P01" || error.code === "PGRST205") return out;
        throw new Error(`EXPORT_READ_FAILED:${table}:${error.code ?? "unknown"}`);
      }
      out.push(...((data ?? []) as Row[]));
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

async function fetchTable(admin: SupabaseClient, table: string, scope: "company" | "invoice" | "self", companyId: string, invoiceIds: string[]): Promise<Row[]> {
  if (scope === "self") return fetchAll(admin, table, "id", [companyId]);
  if (scope === "company") return fetchAll(admin, table, "company_id", [companyId]);
  return invoiceIds.length ? fetchAll(admin, table, "invoice_id", invoiceIds) : [];
}

async function collectFiles(admin: SupabaseClient, companyId: string): Promise<StorageFileRef[]> {
  const files: StorageFileRef[] = [];
  for (const src of COMPANY_EXPORT_FILE_SOURCES) {
    const rows = await fetchAll(admin, src.table, "company_id", [companyId]);
    for (const row of rows) {
      const bucket = src.bucket ?? (src.bucketColumn ? String(row[src.bucketColumn] ?? "") : "");
      const path = String(row[src.pathColumn] ?? "");
      if (bucket && path) files.push({ bucket, path });
    }
  }
  return normalizeExportFiles(files);
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function zipResponse(bytes: Uint8Array, filename: string, headers: Record<string, string>): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Esblu-Export-Sha256": sha256(bytes),
      ...headers,
    },
  });
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  const fail = (status: number, code: string) =>
    Response.json({ code, error: translate(locale, `settings.companyExport.errors.${code}`) }, { status, headers: { "Cache-Control": "private, no-store" } });

  let part: "data" | "files" = "data";
  let index = 0;
  let exportId = "";
  try {
    const body = (await req.json()) as { part?: unknown; index?: unknown; export_id?: unknown };
    if (body.part === "files") {
      part = "files";
      index = typeof body.index === "number" && Number.isInteger(body.index) && body.index >= 0 ? body.index : -1;
      if (index < 0) return fail(400, "BAD_REQUEST");
      // Dávka súborov patrí k behu exportu založenému serverom pri data ZIP (dôkaz pre ukončenie firmy).
      exportId = typeof body.export_id === "string" && UUID_RE.test(body.export_id) ? body.export_id : "";
      if (!exportId) return fail(400, "BAD_REQUEST");
    } else if (body.part !== undefined && body.part !== "data") {
      return fail(400, "BAD_REQUEST");
    }
  } catch {
    part = "data";
  }

  const { user, error: authError } = await verifyRequestUser(req, locale);
  if (authError || !user) return fail(401, "UNAUTHORIZED");

  const admin = getSupabaseAdmin();
  const { data: active, error: membershipError } = await resolveActiveMembershipForUser(admin, user.id, requestSessionId(req, user.id));
  if (membershipError) return fail(500, "EXPORT_FAILED");
  if (!active?.companyId) return fail(403, "NO_ACTIVE_COMPANY");
  // Owner-only: vrátenie údajov podľa DPA je úkon za Zákazníka (VOP 6.2).
  if (active.role !== "owner") return fail(403, "OWNER_ONLY");
  const companyId = active.companyId;
  const generatedAt = new Date().toISOString();

  try {
    if (part === "data") {
      const zip = new JSZip();
      const counts: Record<string, number> = {};
      const hashes: Record<string, string> = {};
      const invoices = await fetchTable(admin, "invoices", "company", companyId, []);
      const invoiceIds = invoices.map((r) => String(r.id));
      const exported: Record<string, Row[]> = {};
      for (const spec of COMPANY_EXPORT_TABLES) {
        const rows = spec.table === "invoices" ? invoices : await fetchTable(admin, spec.table, spec.scope, companyId, invoiceIds);
        exported[spec.table] = rows;
        counts[spec.table] = rows.length;
        const json = JSON.stringify(rows, null, 2);
        const csv = rowsToCsv(rows);
        zip.file(`data/${spec.table}.json`, json);
        zip.file(`data/${spec.table}.csv`, csv);
        hashes[`data/${spec.table}.json`] = sha256(json);
        hashes[`data/${spec.table}.csv`] = sha256(csv);
      }
      // eFaktúra: kanonický životný cyklus dokladu (odvodený iba z exportovaných tabuliek).
      const lifecycle = buildEinvoiceLifecycle({
        inbound: exported.einvoice_inbound ?? [],
        outbound: exported.einvoice_outbound ?? [],
        events: exported.einvoice_events ?? [],
        invoices,
      });
      {
        const json = JSON.stringify(lifecycle, null, 2);
        const csv = rowsToCsv(lifecycle as unknown as Row[]);
        zip.file("data/einvoice_lifecycle.json", json);
        zip.file("data/einvoice_lifecycle.csv", csv);
        counts.einvoice_lifecycle = lifecycle.length;
        hashes["data/einvoice_lifecycle.json"] = sha256(json);
        hashes["data/einvoice_lifecycle.csv"] = sha256(csv);
      }
      // Čitateľná vrstva (CITATELNY_EXPORT/) — iba z už exportovaných riadkov, v pamäti, bez uloženia.
      const humanReadable = await buildHumanReadable(
        { ...(Object.fromEntries(READABLE_SOURCE_DATASETS.map((k) => [k, exported[k] ?? []])) as ReadableDatasets), einvoice_lifecycle: lifecycle },
        generatedAt,
        counts
      );
      for (const file of humanReadable.files) {
        zip.file(file.path, file.content);
        hashes[file.path] = sha256(file.content);
      }
      const files = await collectFiles(admin, companyId);
      const manifest = {
        kind: "esblu_company_export",
        part: "data",
        schema_version: COMPANY_EXPORT_SCHEMA_VERSION,
        company_id: companyId,
        generated_at: generatedAt,
        formats: ["JSON", "CSV (UTF-8, čiarka)"],
        counts,
        sha256: hashes,
        files_total: files.length,
        files_parts: exportFilePartCount(files.length),
        files_per_part: COMPANY_EXPORT_FILES_PER_PART,
        excluded: COMPANY_EXPORT_EXCLUDED,
        technical_export: {
          description: "Úplný strojovo spracovateľný export: data/<tabuľka>.json + .csv, data/einvoice_lifecycle.*, originálne súbory v dávkach files/…",
          datasets: COMPANY_EXPORT_TABLES.map((t) => t.table).concat("einvoice_lifecycle"),
          formats: ["JSON", "CSV (UTF-8, čiarka)", "originálne súbory (XML/PDF/obrázky) v dávkach"],
        },
        human_readable_export: {
          version: HUMAN_READABLE_VERSION,
          root: `${READABLE_ROOT}/`,
          derived_from_technical_export_only: true,
          note: "Prezentačná vrstva tých istých údajov ako technický export; nepridáva údaje ani kategórie osobných údajov. PDF faktúr sú vizualizácie, nie právne originály. Originály súborov sa neduplikujú — zoznamy odkazujú na cesty files/… v dávkach.",
          status: humanReadable.status,
          files: humanReadable.files.map((f) => ({ path: f.path, kind: f.kind, sources: f.sources, sha256: hashes[f.path] })),
          invoice_pdfs: humanReadable.invoicePdfs,
        },
        note: "Export nie je zákonný archív. Za uchovávanie účtovných dokladov zodpovedá Zákazník (VOP čl. 19.4, 21.3). Účtovné balíky s PDF faktúr: Faktúry → Balík pre účtovníka.",
      };
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
      // Server-side dôkaz (company_export_runs): vzniká IBA tu, po vygenerovaní ZIP; klient ho nevie vytvoriť.
      const fileParts = files.length > 0 ? exportFilePartCount(files.length) : 0;
      const { data: runId, error: runError } = await admin.rpc("esblu_company_export_begin", {
        p_user_id: user.id,
        p_company_id: companyId,
        p_schema_version: COMPANY_EXPORT_SCHEMA_VERSION,
        p_files_total: files.length,
        p_file_parts: fileParts,
        p_data_sha256: sha256(bytes),
      });
      if (runError || typeof runId !== "string") {
        console.error("company/export: evidencia exportu zlyhala:", runError?.code ?? "unknown");
        return fail(500, "EXPORT_FAILED");
      }
      return zipResponse(bytes, `esblu-export-udaje-${generatedAt.slice(0, 10)}.zip`, {
        "X-Esblu-Export-Files-Total": String(files.length),
        "X-Esblu-Export-File-Parts": String(exportFilePartCount(files.length)),
        "X-Esblu-Export-Id": runId,
        "X-Esblu-Export-Status": fileParts === 0 ? "completed" : "in_progress",
      });
    }

    const files = await collectFiles(admin, companyId);
    const parts = exportFilePartCount(files.length);
    if (index >= parts) return fail(400, "BAD_REQUEST");
    const batch = sliceExportFiles(files, index);
    const zip = new JSZip();
    const included: Array<{ path: string; sha256: string; bytes: number }> = [];
    const missing: string[] = [];
    for (const f of batch) {
      const { data, error } = await admin.storage.from(f.bucket).download(f.path);
      const zipPath = zipSafePath(f.bucket, f.path);
      if (error || !data) {
        missing.push(zipPath);
        continue;
      }
      const bytes = new Uint8Array(await data.arrayBuffer());
      zip.file(zipPath, bytes);
      included.push({ path: zipPath, sha256: sha256(bytes), bytes: bytes.byteLength });
    }
    zip.file("manifest.json", JSON.stringify({
      kind: "esblu_company_export",
      part: "files",
      index,
      parts,
      company_id: companyId,
      generated_at: generatedAt,
      files: included,
      missing,
    }, null, 2));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    // Dávka zapísaná k behu exportu; posledná dávka bez chýbajúcich súborov = completed.
    const { data: runStatus, error: partError } = await admin.rpc("esblu_company_export_part", {
      p_export_id: exportId,
      p_user_id: user.id,
      p_company_id: companyId,
      p_index: index,
      p_files_total: files.length,
      p_part_sha256: sha256(bytes),
      p_missing: missing.length,
    });
    if (partError || typeof runStatus !== "string") {
      const code = partError?.message?.match(/ESBLU_EXPORT_[A-Z_]+/)?.[0] ?? "EXPORT_FAILED";
      console.error("company/export: evidencia dávky zlyhala:", code);
      return fail(409, "EXPORT_RUN_INVALID");
    }
    return zipResponse(bytes, `esblu-export-subory-${index + 1}-z-${parts}.zip`, {
      "X-Esblu-Export-File-Parts": String(parts),
      "X-Esblu-Export-Missing": String(missing.length),
      "X-Esblu-Export-Id": exportId,
      "X-Esblu-Export-Status": runStatus,
    });
  } catch (error) {
    const code = error instanceof Error && /^EXPORT_READ_FAILED:[a-z_]+:[A-Za-z0-9]+$/.test(error.message) ? error.message : "EXPORT_FAILED";
    console.error("company/export zlyhal:", code);
    // Rozpracovaný beh sa označí failed — nikdy sa nepočíta ako dôkaz pre ukončenie firmy.
    if (part === "files" && exportId) {
      await admin.rpc("esblu_company_export_fail", { p_export_id: exportId, p_company_id: companyId, p_error_code: "EXPORT_FAILED" }).then(() => undefined, () => undefined);
    }
    return fail(500, "EXPORT_FAILED");
  }
}

/**
 * Čitateľná vrstva exportu. Vstup = iba datasety technického exportu (READABLE_SOURCE_DATASETS).
 * Zlyhanie PDF nikdy nezastaví technický export (status „partial“ v manifeste).
 */
async function buildHumanReadable(
  datasets: ReadableDatasets,
  generatedAt: string,
  counts: Record<string, number>
): Promise<{ files: ReadableFile[]; status: "complete" | "partial"; invoicePdfs: { eligible: number; rendered: number; skipped: number; cap: number } }> {
  const files: ReadableFile[] = [{ path: `${READABLE_ROOT}/CITAJ_MA.txt`, content: README_TEXT, sources: [], kind: "txt" }];
  files.push(...buildReadableCsvFiles(datasets));
  let status: "complete" | "partial" = "complete";
  const { renderCompanyOverviewPdf } = await import("@/lib/company-export-readable-pdf");
  try {
    const pdf = await renderCompanyOverviewPdf(companyOverview(datasets, generatedAt, counts));
    files.push({ path: `${READABLE_ROOT}/Prehlad_firmy.pdf`, content: new Uint8Array(pdf), sources: ["companies", "company_billing_profile", "company_legal_identities"], kind: "pdf" });
  } catch (error) {
    console.error("company/export: Prehlad_firmy.pdf zlyhal:", error instanceof Error ? error.name : "unknown");
    status = "partial";
  }
  const bundles = issuedInvoiceBundles(datasets);
  const started = Date.now();
  let rendered = 0;
  if (bundles.length > 0) {
    const { renderInvoicePdfBuffer } = await import("@/lib/invoicing/pdf-renderer");
    for (const b of bundles.slice(0, READABLE_INVOICE_PDF_CAP)) {
      if (Date.now() - started > READABLE_PDF_BUDGET_MS) break;
      if (!b.seller || b.items.length === 0) continue;
      try {
        const pdf = await renderInvoicePdfBuffer({
          invoice: b.invoice as never, seller: b.seller as never, buyer: b.buyer as never, items: b.items as never,
          taxBreakdowns: b.taxBreakdowns as never, locale: "sk", correctedInvoiceNumber: b.correctedInvoiceNumber, advanceDeductions: b.advanceDeductions,
          previewNotice: INVOICE_PREVIEW_NOTICE,
        });
        files.push({ path: b.path, content: new Uint8Array(pdf), sources: ["invoices", "invoice_parties", "invoice_items", "invoice_tax_breakdowns", "invoice_advance_deductions"], kind: "pdf" });
        rendered++;
      } catch (error) {
        console.error("company/export: PDF vizualizácia faktúry zlyhala:", error instanceof Error ? error.name : "unknown");
      }
    }
  }
  if (rendered < bundles.length) status = "partial";
  return { files, status, invoicePdfs: { eligible: bundles.length, rendered, skipped: bundles.length - rendered, cap: READABLE_INVOICE_PDF_CAP } };
}
