import "server-only";

import { createHash } from "node:crypto";
import { EinvoiceProviderError, type EinvoiceEnvironment, type EinvoiceProvider, type ProviderContext } from "../provider/types.ts";
import { MAX_INBOUND_XML_BYTES, parseInboundUbl } from "../ubl/parse.ts";
import { backoffMs, errorCode } from "../outbound/policy.ts";
import { dbErrorCode } from "../outbound/store.ts";
import { mapInboundDraft } from "./mapping.ts";
import { inboundXmlPath, InboundStoreError, type InboundRow, type InboundStore } from "./store.ts";

// =============================================================================
// E-Faktúra inbound — spracovanie prijatých dokladov. SERVER-ONLY.
//
//   received      → stiahnuť PRESNÉ XML od poskytovateľa (limit veľkosti,
//                   timeout, pevný host, bez redirectov — adaptér) → SHA-256 →
//                   privátny storage (nikdy neprepisuje; rovnaký hash vo firme
//                   = ten istý objekt) → stored
//   stored        → bajty zo storage (znovu SHA) → bezpečný parser (bez DTD/
//                   entít) → profil EN16931 → parsed
//   parsed        → mapovanie → RPC: dedupe (hash vo firme / transport ID /
//                   dodávateľ + číslo) + koncept prijatej faktúry → draft_created | duplicate
//   draft_created / duplicate / ack_pending → ACK poskytovateľovi → acknowledged
//
// ACK sa odošle IBA ak existuje uložené XML, hash, riadok a koncept (DB to
// vynucuje aj guardom). Chyba pred konceptom = žiadny ACK; poll to zopakuje.
// Žiadne logovanie obsahu XML, tela webhooku ani tajomstiev.
// =============================================================================

export const INBOUND_ERROR = {
  PROVIDER_FETCH_FAILED: "PROVIDER_FETCH_FAILED",
  INVALID_XML: "INVALID_XML",
  UNSUPPORTED_PROFILE: "UNSUPPORTED_PROFILE",
  DUPLICATE: "DUPLICATE",
  STORAGE_FAILED: "STORAGE_FAILED",
  DRAFT_CREATE_FAILED: "DRAFT_CREATE_FAILED",
  ACK_FAILED: "ACK_FAILED",
  UNKNOWN_ORG: "UNKNOWN_ORG",
} as const;

/** Trvalé chyby konceptu (dáta dokladu) — bez ACK, na kontrolu človekom; nič sa neopakuje. */
const PERMANENT_DRAFT_CODES = new Set([
  "ESBLU_EINVOICE_SUPPLIER_UNIDENTIFIED",
  "ESBLU_INVALID_ITEM",
  "ESBLU_INVALID_S_VAT_RATE",
  "ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER",
  "ESBLU_MISSING_ISSUE_DATE",
  "ESBLU_INVOICE_NO_ITEMS",
  // Súčty z XML nesedia s položkami / samy so sebou (DB druhá vrstva za mapovaním).
  "ESBLU_EINVOICE_TOTALS_INCONSISTENT",
]);

export type InboundDeps = {
  store: InboundStore;
  provider: EinvoiceProvider;
  environment: EinvoiceEnvironment;
  now?: () => Date;
};

export type InboundItemResult = { inboundId: string; from: string; to: string; code: string | null };
export type InboundReport = { claimed: number; results: InboundItemResult[] };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STEPS = 6;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function iso(d: Date): string {
  return d.toISOString();
}
function isRetryableProviderError(error: unknown): boolean {
  return !(error instanceof EinvoiceProviderError) || error.retryable;
}

type StepOutcome = { row: InboundRow; done: boolean; code: string | null };

async function contextFor(deps: InboundDeps, row: InboundRow): Promise<ProviderContext | null> {
  if (row.provider !== deps.provider.name || row.environment !== deps.environment) return null;
  const org = await deps.store.organizationFor(row.company_id, row.environment);
  if (!org || !org.providerOrgId) return null;
  return { environment: row.environment, providerOrgId: org.providerOrgId };
}

async function retryLater(deps: InboundDeps, row: InboundRow, code: string, providerCode: string | null, toState: string | null = null): Promise<StepOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const updated = await deps.store.transition(row.id, row.processing_status, toState, "job", providerCode ?? code, {
    last_error_code: code,
    next_retry_at: iso(new Date(now.getTime() + backoffMs(Math.max(1, row.retry_count)))),
    locked_until: null,
  });
  return { row: updated, done: true, code };
}

async function failPermanently(deps: InboundDeps, row: InboundRow, code: string, providerCode: string | null): Promise<StepOutcome> {
  const updated = await deps.store.transition(row.id, row.processing_status, "failed", "job", providerCode ?? code, {
    last_error_code: code,
    next_retry_at: null,
    locked_until: null,
  });
  return { row: updated, done: true, code };
}

async function stepFetch(deps: InboundDeps, row: InboundRow): Promise<StepOutcome> {
  if (!SAFE_ID.test(row.provider_received_id)) return failPermanently(deps, row, INBOUND_ERROR.PROVIDER_FETCH_FAILED, "INVALID_PROVIDER_ID");
  const ctx = await contextFor(deps, row);
  if (!ctx) return retryLater(deps, row, INBOUND_ERROR.UNKNOWN_ORG, null);

  let bytes: Uint8Array;
  try {
    const doc = await deps.provider.getInboundDocument(ctx, row.provider_received_id);
    bytes = doc.xml;
  } catch (error) {
    return isRetryableProviderError(error)
      ? retryLater(deps, row, INBOUND_ERROR.PROVIDER_FETCH_FAILED, errorCode(error))
      : failPermanently(deps, row, INBOUND_ERROR.PROVIDER_FETCH_FAILED, errorCode(error));
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INBOUND_XML_BYTES) {
    return failPermanently(deps, row, INBOUND_ERROR.INVALID_XML, "XML_SIZE_INVALID");
  }

  const sha = sha256Hex(bytes);
  let path: string | null;
  try {
    // Rovnaké XML už vo FIRME uložené → ten istý objekt (žiadny duplikát v storage).
    path = await deps.store.findStoredXmlPath(row.company_id, sha, row.id);
    if (!path) {
      path = inboundXmlPath(row.company_id, row.provider, row.provider_received_id, sha);
      const put = await deps.store.putXml(path, bytes);
      if (put === "exists") {
        const stored = await deps.store.getXml(path);
        if (!stored || sha256Hex(stored) !== sha) return failPermanently(deps, row, INBOUND_ERROR.STORAGE_FAILED, "STORAGE_INTEGRITY");
      }
    }
  } catch {
    return retryLater(deps, row, INBOUND_ERROR.STORAGE_FAILED, null);
  }

  const updated = await deps.store.transition(row.id, "received", "stored", "job", null, {
    xml_storage_path: path,
    xml_sha256: sha,
    xml_size_bytes: bytes.byteLength,
    last_error_code: null,
  });
  return { row: updated, done: false, code: null };
}

async function readAndParse(deps: InboundDeps, row: InboundRow) {
  if (!row.xml_storage_path || !row.xml_sha256) return { error: "STORAGE_INTEGRITY" as const };
  const bytes = await deps.store.getXml(row.xml_storage_path);
  if (!bytes || sha256Hex(bytes) !== row.xml_sha256) return { error: "STORAGE_INTEGRITY" as const };
  return { parsed: parseInboundUbl(bytes) };
}

async function stepParse(deps: InboundDeps, row: InboundRow): Promise<StepOutcome> {
  let read;
  try {
    read = await readAndParse(deps, row);
  } catch {
    return retryLater(deps, row, INBOUND_ERROR.STORAGE_FAILED, null);
  }
  if ("error" in read) return failPermanently(deps, row, INBOUND_ERROR.STORAGE_FAILED, read.error ?? null);
  const parsed = read.parsed;
  if (!parsed.ok) return failPermanently(deps, row, INBOUND_ERROR.INVALID_XML, parsed.error);

  const org = await deps.store.organizationFor(row.company_id, row.environment);
  const mapped = mapInboundDraft(parsed.document, parsed.reviewReasons, org?.participantId ?? null, { allowTestScheme: deps.environment === "sandbox" });
  if (!mapped.ok) return failPermanently(deps, row, mapped.code, mapped.detail);

  const d = parsed.document;
  const sender = d.supplier.endpointId && d.supplier.endpointScheme ? `${d.supplier.endpointScheme}:${d.supplier.endpointId}` : null;
  const updated = await deps.store.transition(row.id, "stored", "parsed", "job", null, {
    document_number: d.invoiceNumber,
    document_type: d.documentType,
    issue_date: d.issueDate,
    sender_participant_id: sender,
    sender_ico: mapped.draft.supplier.ico,
    review_reasons: mapped.reviewReasons,
    last_error_code: null,
  });
  return { row: updated, done: false, code: null };
}

async function stepDraft(deps: InboundDeps, row: InboundRow): Promise<StepOutcome> {
  let read;
  try {
    read = await readAndParse(deps, row);
  } catch {
    return retryLater(deps, row, INBOUND_ERROR.STORAGE_FAILED, null);
  }
  if ("error" in read) return failPermanently(deps, row, INBOUND_ERROR.STORAGE_FAILED, read.error ?? null);
  if (!read.parsed.ok) return failPermanently(deps, row, INBOUND_ERROR.INVALID_XML, read.parsed.error);
  const org = await deps.store.organizationFor(row.company_id, row.environment);
  const mapped = mapInboundDraft(read.parsed.document, read.parsed.reviewReasons, org?.participantId ?? null, { allowTestScheme: deps.environment === "sandbox" });
  if (!mapped.ok) return failPermanently(deps, row, mapped.code, mapped.detail);

  try {
    const result = await deps.store.createDraft(row.id, mapped.draft);
    const refreshed: InboundRow = { ...row, processing_status: result.status === "created" ? "draft_created" : "duplicate", invoice_id: result.invoiceId };
    return { row: refreshed, done: false, code: result.status === "duplicate" ? INBOUND_ERROR.DUPLICATE : null };
  } catch (error) {
    const code = error instanceof InboundStoreError ? error.code : dbErrorCode(error instanceof Error ? error.message : null);
    const providerCode = code.replace(/[^A-Z0-9_]/g, "_").slice(0, 80);
    return PERMANENT_DRAFT_CODES.has(code)
      ? failPermanently(deps, row, INBOUND_ERROR.DRAFT_CREATE_FAILED, providerCode)
      : retryLater(deps, row, INBOUND_ERROR.DRAFT_CREATE_FAILED, providerCode);
  }
}

async function stepAck(deps: InboundDeps, row: InboundRow): Promise<StepOutcome> {
  // Obranná kontrola (DB guard vynúti to isté): bez uloženého XML a konceptu žiadny ACK.
  if (!row.invoice_id || !row.xml_sha256 || !row.xml_storage_path) {
    return retryLater(deps, row, INBOUND_ERROR.ACK_FAILED, "DRAFT_REQUIRED");
  }
  const ctx = await contextFor(deps, row);
  if (!ctx) return retryLater(deps, row, INBOUND_ERROR.UNKNOWN_ORG, null, row.processing_status === "ack_pending" ? null : "ack_pending");
  try {
    await deps.provider.acknowledgeInbound(ctx, row.provider_received_id);
  } catch (error) {
    return retryLater(deps, row, INBOUND_ERROR.ACK_FAILED, errorCode(error), row.processing_status === "ack_pending" ? null : "ack_pending");
  }
  const now = (deps.now ?? (() => new Date()))();
  const updated = await deps.store.transition(row.id, row.processing_status, "acknowledged", "provider", "ACKNOWLEDGED", {
    acknowledged_at: iso(now),
    last_error_code: null,
    next_retry_at: null,
    locked_until: null,
  });
  return { row: updated, done: true, code: null };
}

/** Spracuje jeden claimnutý riadok cez všetky kroky, kým nie je hotový alebo nečaká na retry. */
export async function processInboundRow(deps: InboundDeps, row: InboundRow): Promise<InboundItemResult> {
  const from = row.processing_status;
  let current = row;
  let lastCode: string | null = null;
  for (let i = 0; i < MAX_STEPS; i++) {
    let out: StepOutcome;
    switch (current.processing_status) {
      case "received":
        out = await stepFetch(deps, current);
        break;
      case "stored":
        out = await stepParse(deps, current);
        break;
      case "parsed":
        out = await stepDraft(deps, current);
        break;
      case "draft_created":
      case "duplicate":
      case "ack_pending":
        out = await stepAck(deps, current);
        break;
      default:
        return { inboundId: row.id, from, to: current.processing_status, code: lastCode };
    }
    current = out.row;
    lastCode = out.code ?? lastCode;
    if (out.done) break;
  }
  return { inboundId: row.id, from, to: current.processing_status, code: lastCode };
}

/** Jeden beh spracovania (claim FOR UPDATE SKIP LOCKED + lease). */
export async function runInboundProcessBatch(deps: InboundDeps, options: { batchSize?: number; leaseSeconds?: number } = {}): Promise<InboundReport> {
  const rows = await deps.store.claim(options.batchSize ?? 5, options.leaseSeconds ?? 120);
  const results: InboundItemResult[] = [];
  for (const row of rows) {
    try {
      results.push(await processInboundRow(deps, row));
    } catch (error) {
      // Zápis zlyhal — lease vyprší a riadok sa zopakuje (bez ACK).
      results.push({ inboundId: row.id, from: row.processing_status, to: row.processing_status, code: error instanceof InboundStoreError ? error.code : errorCode(error) });
    }
  }
  return { claimed: rows.length, results };
}

export type SyncReport = { organizations: number; listed: number; registered: number; errors: { code: string }[] };

/**
 * Zoznam nepotvrdených dokladov u poskytovateľa → registrácia (idempotentná
 * podľa ID poskytovateľa). Firma = mapovanie organizácie v DB.
 */
export async function syncInboundList(
  deps: InboundDeps,
  organizations: { providerOrgId: string }[],
  source: "webhook" | "poll"
): Promise<SyncReport> {
  const report: SyncReport = { organizations: organizations.length, listed: 0, registered: 0, errors: [] };
  for (const org of organizations) {
    let list;
    try {
      list = await deps.provider.listUnacknowledgedInbound({ environment: deps.environment, providerOrgId: org.providerOrgId }, { limit: 50 });
    } catch (error) {
      report.errors.push({ code: `${INBOUND_ERROR.PROVIDER_FETCH_FAILED}:${errorCode(error)}` });
      continue;
    }
    report.listed += list.length;
    for (const item of list) {
      if (!SAFE_ID.test(item.providerReceivedId)) continue;
      try {
        const r = await deps.store.register({
          provider: deps.provider.name,
          environment: deps.environment,
          providerOrgId: org.providerOrgId,
          providerReceivedId: item.providerReceivedId,
          source,
          meta: {
            sender_participant_id: item.senderParticipantId,
            sender_ico: item.senderIco,
            document_number: item.documentNumber,
            document_type: item.documentType,
            is_test: item.isTest,
          },
        });
        if (r.created) report.registered++;
      } catch (error) {
        report.errors.push({ code: error instanceof InboundStoreError ? error.code : errorCode(error) });
      }
    }
  }
  return report;
}

/** Poll fallback: všetky pripravené organizácie → zoznam → spracovanie. Webhook nie je jediný mechanizmus. */
export async function runInboundPoll(deps: InboundDeps, options: { batchSize?: number; leaseSeconds?: number } = {}) {
  const orgs = (await deps.store.listOrganizations(deps.provider.name, deps.environment)).filter((o) => o.providerOrgId);
  const sync = await syncInboundList(deps, orgs.map((o) => ({ providerOrgId: o.providerOrgId! })), "poll");
  const processed = await runInboundProcessBatch(deps, options);
  return { sync, processed };
}
