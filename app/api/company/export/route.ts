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
  try {
    const body = (await req.json()) as { part?: unknown; index?: unknown };
    if (body.part === "files") {
      part = "files";
      index = typeof body.index === "number" && Number.isInteger(body.index) && body.index >= 0 ? body.index : -1;
      if (index < 0) return fail(400, "BAD_REQUEST");
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
      const files = await collectFiles(admin, companyId);
      const manifest = {
        kind: "esblu_company_export",
        part: "data",
        company_id: companyId,
        generated_at: generatedAt,
        formats: ["JSON", "CSV (UTF-8, čiarka)"],
        counts,
        sha256: hashes,
        files_total: files.length,
        files_parts: exportFilePartCount(files.length),
        files_per_part: COMPANY_EXPORT_FILES_PER_PART,
        excluded: COMPANY_EXPORT_EXCLUDED,
        note: "Export nie je zákonný archív. Za uchovávanie účtovných dokladov zodpovedá Zákazník (VOP čl. 19.4, 21.3). Účtovné balíky s PDF faktúr: Faktúry → Balík pre účtovníka.",
      };
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
      return zipResponse(bytes, `esblu-export-udaje-${generatedAt.slice(0, 10)}.zip`, {
        "X-Esblu-Export-Files-Total": String(files.length),
        "X-Esblu-Export-File-Parts": String(exportFilePartCount(files.length)),
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
    return zipResponse(bytes, `esblu-export-subory-${index + 1}-z-${parts}.zip`, {
      "X-Esblu-Export-File-Parts": String(parts),
      "X-Esblu-Export-Missing": String(missing.length),
    });
  } catch (error) {
    const code = error instanceof Error && /^EXPORT_READ_FAILED:[a-z_]+:[A-Za-z0-9]+$/.test(error.message) ? error.message : "EXPORT_FAILED";
    console.error("company/export zlyhal:", code);
    return fail(500, "EXPORT_FAILED");
  }
}
