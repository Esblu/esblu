import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import type { Locale } from "@/lib/i18n/locales";
import { downloadBlob } from "@/lib/file-actions";

// Klient pre /api/company/export (owner). Stiahne údaje (JSON/CSV) a potom
// originálne súbory po dávkach; každý ZIP overí odtlačkom SHA-256 z hlavičky.

export class CompanyExportError extends Error {
  constructor(public code: string, message: string | null) {
    super(message ?? code);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requestPart(locale: Locale, body: { part: "data" } | { part: "files"; index: number }) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CompanyExportError("UNAUTHORIZED", null);
  const response = await fetch(apiUrl("/api/company/export"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, [REQUEST_LOCALE_HEADER]: locale },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { code?: string; error?: string } | null;
    throw new CompanyExportError(payload?.code ?? "EXPORT_FAILED", payload?.error ?? null);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = response.headers.get("x-esblu-export-sha256");
  if (expected && (await sha256Hex(bytes)) !== expected) throw new CompanyExportError("CHECKSUM_MISMATCH", null);
  const fileName = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "esblu-export.zip";
  await downloadBlob(new Blob([bytes as unknown as BlobPart], { type: "application/zip" }), fileName);
  return response.headers;
}

/** Stiahne kompletný export firmy; onProgress(hotové časti, spolu). */
export async function downloadCompanyExport(
  locale: Locale,
  onProgress?: (done: number, total: number) => void
): Promise<{ fileParts: number; missingFiles: number }> {
  const headers = await requestPart(locale, { part: "data" });
  const total = Number(headers.get("x-esblu-export-files-total") ?? "0");
  const fileParts = total > 0 ? Number(headers.get("x-esblu-export-file-parts") ?? "1") : 0;
  onProgress?.(1, fileParts + 1);
  let missingFiles = 0;
  for (let i = 0; i < fileParts; i++) {
    const h = await requestPart(locale, { part: "files", index: i });
    missingFiles += Number(h.get("x-esblu-export-missing") ?? "0");
    onProgress?.(i + 2, fileParts + 1);
  }
  return { fileParts, missingFiles };
}
