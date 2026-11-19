// =============================================================================
// P4 (2026-11-23) — archív PDF Stripe faktúr a dobropisov (účtovná kópia Esblu, retencia 10 rokov).
//
// Job (cron billing-documents): kandidáti z DB s lease (esblu_billing_document_archive_claim) →
// stiahnuť PDF IBA z hostiteľov *.stripe.com (aj pri presmerovaní; max 3 skoky, max 15 MB, musí začínať
// `%PDF-`) → SHA-256 → nahrať do privátneho bucketu `billing-documents` bez prepisu
// (`<env>/<YYYY>/<MM>/<kind>/<stripe_id>.pdf`) → zapísať hash + cestu (v DB potom nemenné).
// Chyba = backoff v DB (30 min → 24 h, max 10 pokusov; od 5. pokusu ops alert DOCUMENT_ARCHIVE_FAILED).
// URL dokladu ani obsah PDF sa nelogujú.
// =============================================================================

import { createHash } from "node:crypto";
import type { BillingDb } from "@/lib/billing/pipeline";

export type ArchiveStorage = {
  /** Nahrá objekt bez prepisu. `exists` = objekt už existuje (predchádzajúci beh spadol po nahratí). */
  upload(path: string, bytes: Uint8Array): Promise<"ok" | "exists" | "error">;
  /** Stiahne existujúci objekt (overenie hashu pri `exists`). */
  download(path: string): Promise<Uint8Array | null>;
};

export const ARCHIVE_MAX_BYTES = 15 * 1024 * 1024;
const STRIPE_HOST_RE = /^([a-z0-9-]+\.)*stripe\.com$/;

export function isAllowedStripeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && STRIPE_HOST_RE.test(url.hostname) && !url.username && !url.password && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

export function archivePath(environment: string, kind: string, documentId: string, issuedAt: string | null): string | null {
  const at = issuedAt && Number.isFinite(Date.parse(issuedAt)) ? new Date(issuedAt) : null;
  if (!at || !/^(test|live)$/.test(environment) || !/^(invoice|credit_note)$/.test(kind)) return null;
  if (!(kind === "invoice" ? /^in_[A-Za-z0-9_]+$/ : /^cn_[A-Za-z0-9_]+$/).test(documentId)) return null;
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${environment}/${at.getUTCFullYear()}/${mm}/${kind}/${documentId}.pdf`;
}

export async function fetchStripePdf(url: string, fetchImpl: typeof fetch): Promise<Uint8Array | string> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!isAllowedStripeUrl(current)) return "URL_NOT_ALLOWED";
    let response: Response;
    try {
      response = await fetchImpl(current, { method: "GET", redirect: "manual", cache: "no-store" });
    } catch {
      return "FETCH_FAILED";
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return "FETCH_FAILED";
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) return `HTTP_${response.status >= 500 ? "5XX" : "4XX"}`;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > ARCHIVE_MAX_BYTES) return "PDF_TOO_LARGE";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > ARCHIVE_MAX_BYTES) return "PDF_TOO_LARGE";
    if (bytes.byteLength < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") return "NOT_A_PDF";
    return bytes;
  }
  return "TOO_MANY_REDIRECTS";
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type ArchiveRunResult = { claimed: number; archived: number; failed: number; errorCode?: string };

export async function runDocumentArchive(
  db: BillingDb,
  environment: "test" | "live",
  storage: ArchiveStorage,
  options: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<ArchiveRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const out: ArchiveRunResult = { claimed: 0, archived: 0, failed: 0 };
  const claim = await db.rpc("esblu_billing_document_archive_claim", { p_environment: environment, p_limit: options.limit ?? 20 });
  if (claim.error) return { ...out, errorCode: "ARCHIVE_CLAIM_FAILED" };
  const rows = (Array.isArray(claim.data) ? claim.data : []) as Array<{ id: string; environment: string; kind: string; provider_document_id: string; pdf_url: string; issued_at: string | null }>;
  out.claimed = rows.length;
  const fail = async (id: string, code: string) => {
    out.failed++;
    await db.rpc("esblu_billing_document_archive_result", { p_id: id, p_ok: false, p_sha256: null, p_storage_path: null, p_error_code: code });
  };
  for (const row of rows) {
    const path = archivePath(row.environment, row.kind, row.provider_document_id, row.issued_at);
    if (!path) { await fail(row.id, "ARCHIVE_PATH_INVALID"); continue; }
    const pdf = await fetchStripePdf(row.pdf_url, fetchImpl);
    if (typeof pdf === "string") { await fail(row.id, pdf); continue; }
    const hash = sha256(pdf);
    let stored = await storage.upload(path, pdf);
    if (stored === "exists") {
      // Objekt už existuje (spadnutý beh) → prijať iba ak je bajtovo rovnaký; nikdy neprepisovať.
      const existing = await storage.download(path);
      stored = existing && sha256(existing) === hash ? "ok" : "error";
      if (stored === "error") { await fail(row.id, "ARCHIVE_CONFLICT"); continue; }
    }
    if (stored !== "ok") { await fail(row.id, "STORAGE_UPLOAD_FAILED"); continue; }
    const done = await db.rpc("esblu_billing_document_archive_result", { p_id: row.id, p_ok: true, p_sha256: hash, p_storage_path: path, p_error_code: null });
    if (done.error) { out.failed++; continue; }
    out.archived++;
  }
  return out;
}
