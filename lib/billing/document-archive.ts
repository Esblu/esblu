// =============================================================================
// P4 (2026-11-23) — archív PDF Stripe faktúr a dobropisov (účtovná kópia Esblu, retencia 10 rokov).
//
// Job (cron billing-documents): kandidáti z DB s lease (esblu_billing_document_archive_claim) →
// stiahnuť PDF: prvá URL IBA *.stripe.com; presmerovanie na *.stripe.com, alebo (S17-5, 2026-11-22) na PRESNÝ
// hostiteľ úložiska Stripe `stripe-upload-api.s3.us-west-1.amazonaws.com` IBA ak presmeroval hostiteľ *.stripe.com
// (z S3 ďalej nikam). HTTPS, port 443, bez prihlasovacích údajov v URL, max 3 skoky, max 15 MB, musí začínať
// `%PDF-`. Spojenie: node:https s kontrolou SKUTOČNE použitej IP pri pripojení (lookup → iba verejné adresy,
// IP literály zakázané, bez keep-alive/poolu = ochrana aj proti DNS rebindingu), bez cookies a autentifikačných
// hlavičiek → SHA-256 → nahrať do privátneho bucketu `billing-documents` bez prepisu
// (`<env>/<YYYY>/<MM>/<kind>/<stripe_id>.pdf`) → zapísať hash + cestu (v DB potom nemenné).
// Chyba = backoff v DB (30 min → 24 h, max 10 pokusov; od 5. pokusu ops alert DOCUMENT_ARCHIVE_FAILED).
// URL dokladu ani obsah PDF sa nelogujú.
// =============================================================================

import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
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

/**
 * S17-5: Stripe presmeruje `pay.stripe.com/invoice/…/pdf` (302) na podpísanú URL vo vlastnom S3 úložisku.
 * Povolený je IBA tento presný hostiteľ (nie *.amazonaws.com ani iné S3) a IBA ako cieľ presmerovania z *.stripe.com.
 */
export const STRIPE_PDF_STORAGE_HOSTS: ReadonlySet<string> = new Set(["stripe-upload-api.s3.us-west-1.amazonaws.com"]);

function isSafeHttpsUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && host.length > 0 && isIP(host) === 0;
}

/** Cieľ presmerovania pri sťahovaní PDF: *.stripe.com, alebo presný hostiteľ úložiska Stripe iba z hostiteľa *.stripe.com. */
export function isAllowedPdfRedirect(rawNext: string, rawFrom: string): boolean {
  try {
    const next = new URL(rawNext);
    const from = new URL(rawFrom);
    if (!isSafeHttpsUrl(next) || !isAllowedStripeUrl(from.toString())) return false;
    return STRIPE_HOST_RE.test(next.hostname) || STRIPE_PDF_STORAGE_HOSTS.has(next.hostname);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------- SSRF: kontrola skutočnej IP
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, prefix, "ipv6");

/** true = adresa nie je verejná (privátna, loopback, link-local, CGNAT, multicast, rezervovaná, mapovaná/tunelovaná). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  // IPv4-mapované / kompatibilné IPv6 (::ffff:a.b.c.d, ::a.b.c.d) sa neprijímajú vôbec. Pozn.: BlockList by pri
  // pravidle ::ffff:0:0/96 blokoval aj všetky IPv4 adresy, preto explicitne tu.
  if (family === 6) return /^::(ffff:)?[0-9a-f.:]*$/i.test(address) && address !== "::" ? true : BLOCKED.check(address, "ipv6");
  return true;
}

type LookupFn = (hostname: string, options: { all: true; family?: number }, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/** lookup pre node:https: odmietne hostiteľa, ak ČOKOĽVEK z jeho adries nie je verejné; pripojí sa presne na overenú adresu. */
export function guardedLookup(resolve: LookupFn = dnsLookup as unknown as LookupFn) {
  return (hostname: string, options: unknown, callback: LookupCallback) => {
    const opts = (typeof options === "object" && options ? options : { family: typeof options === "number" ? options : 0 }) as { all?: boolean; family?: number };
    resolve(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
        return callback(Object.assign(new Error("ADDRESS_NOT_ALLOWED"), { code: "ADDRESS_NOT_ALLOWED" }) as NodeJS.ErrnoException);
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/** Jediné hlavičky požiadavky na PDF: žiadne Authorization, apikey, Cookie ani iné tajomstvá. */
export const PDF_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ accept: "application/pdf", "user-agent": "esblu-billing-archive/1" });

export function buildPdfRequestOptions(url: URL, lookupFn = guardedLookup()): RequestOptions {
  return {
    protocol: "https:", hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: "GET",
    headers: { ...PDF_REQUEST_HEADERS }, agent: false, lookup: lookupFn as unknown as RequestOptions["lookup"],
    rejectUnauthorized: true, servername: url.hostname, timeout: 20_000,
  };
}

/**
 * Predvolený klient archívu (namiesto globálneho fetch): nikdy nesleduje presmerovania (rieši ich fetchStripePdf),
 * pripája sa iba na verejné IP overené pri pripojení, číta max. ARCHIVE_MAX_BYTES, nič neukladá mimo pamäte.
 */
export async function safePdfFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  // obrana do hĺbky: aj samotný klient pozná iba Stripe hostiteľov (politiku presmerovaní rieši fetchStripePdf)
  if (!isSafeHttpsUrl(url) || !(STRIPE_HOST_RE.test(url.hostname) || STRIPE_PDF_STORAGE_HOSTS.has(url.hostname))) {
    throw Object.assign(new Error("URL_NOT_ALLOWED"), { code: "URL_NOT_ALLOWED" });
  }
  return await new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(buildPdfRequestOptions(url), (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > ARCHIVE_MAX_BYTES) { req.destroy(Object.assign(new Error("PDF_TOO_LARGE"), { code: "PDF_TOO_LARGE" })); return; }
        chunks.push(c);
      });
      res.on("error", reject);
      res.on("end", () => {
        const headers = new Headers();
        for (const name of ["location", "content-length", "content-type"]) {
          const v = res.headers[name];
          if (typeof v === "string") headers.set(name, v);
        }
        const status = res.statusCode ?? 0;
        const body = chunks.length && ![204, 205, 304].includes(status) ? new Uint8Array(Buffer.concat(chunks)) : null;
        try { resolve(new Response(body, { status, headers })); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("FETCH_TIMEOUT"), { code: "FETCH_TIMEOUT" })));
    req.on("error", reject);
    req.end();
  });
}

const FETCH_ERROR_CODES = new Set(["ADDRESS_NOT_ALLOWED", "PDF_TOO_LARGE", "URL_NOT_ALLOWED"]);

export function archivePath(environment: string, kind: string, documentId: string, issuedAt: string | null): string | null {
  const at = issuedAt && Number.isFinite(Date.parse(issuedAt)) ? new Date(issuedAt) : null;
  if (!at || !/^(test|live)$/.test(environment) || !/^(invoice|credit_note)$/.test(kind)) return null;
  if (!(kind === "invoice" ? /^in_[A-Za-z0-9_]+$/ : /^cn_[A-Za-z0-9_]+$/).test(documentId)) return null;
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${environment}/${at.getUTCFullYear()}/${mm}/${kind}/${documentId}.pdf`;
}

export async function fetchStripePdf(url: string, fetchImpl: typeof fetch): Promise<Uint8Array | string> {
  let current = url;
  let previous: string | null = null;
  for (let hop = 0; hop < 4; hop++) {
    // prvá URL (z dokladu Stripe) iba *.stripe.com; ďalšie iba povolené presmerovanie z predchádzajúceho hostiteľa
    if (previous === null ? !isAllowedStripeUrl(current) : !isAllowedPdfRedirect(current, previous)) return "URL_NOT_ALLOWED";
    let response: Response;
    try {
      response = await fetchImpl(current, { method: "GET", redirect: "manual", cache: "no-store", credentials: "omit" });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return typeof code === "string" && FETCH_ERROR_CODES.has(code) ? code : "FETCH_FAILED";
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return "FETCH_FAILED";
      try {
        previous = current;
        current = new URL(location, current).toString();
      } catch {
        return "URL_NOT_ALLOWED";
      }
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
  const fetchImpl = options.fetchImpl ?? (safePdfFetch as typeof fetch);
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
