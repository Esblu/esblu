import "server-only";

import { createHash } from "node:crypto";
import { EinvoiceProviderError, type EinvoiceEnvironment, type EinvoiceProvider, type InboundSummary, type ProviderContext } from "../provider/types.ts";
import { MAX_INBOUND_XML_BYTES, parseInboundUbl } from "../ubl/parse.ts";
import { backoffMs, errorCode } from "../outbound/policy.ts";
import { dbErrorCode } from "../outbound/store.ts";
import { mapInboundDraft, verifyInboundRecipient } from "./mapping.ts";
import { inboundXmlPath, InboundStoreError, type InboundRow, type InboundStore, type RegisterMeta } from "./store.ts";

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
  /** Príjemca v XML ≠ overený participant organizácie (alebo chýba) — fail closed, bez konceptu a ACK. */
  RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
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
  /**
   * P1-4 (R2): potvrdenie (ACK) karantenovaného dokladu poskytovateľovi. DEFAULT VYPNUTÉ — zapína sa až po
   * overení, že originál je bezpečne uložený a doklad sprístupnený oprávnenému príjemcovi
   * (env ESBLU_EINVOICE_INBOUND_QUARANTINE_ACK=enabled, rozhodnutie vlastníka).
   */
  quarantineAck?: boolean;
};

/** P1-4: kódy, pri ktorých sa doklad s uloženým originálom presunie do karantény. RECIPIENT_MISMATCH NIKDY (R3). */
const QUARANTINE_EXCLUDED = new Set<string>(["RECIPIENT_MISMATCH"]);

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
  await quarantineFailed(deps, updated, code);
  return { row: updated, done: true, code };
}

/**
 * P1-4 karanténa: trvalo zlyhaný doklad, ktorého originál XML je uložený (cesta + SHA-256), sa označí na ručné
 * spracovanie (vidí ho firma). RECIPIENT_MISMATCH sa nikdy nekarantenuje ani nesprístupní (R3).
 * ACK poskytovateľovi iba ak je výslovne povolené (R2); inak doklad ostáva u poskytovateľa nepotvrdený.
 * Best-effort: zlyhanie karantény/ACK nemení výsledok kroku (doklad je `failed`, alert INBOUND_FAILED).
 */
async function quarantineFailed(deps: InboundDeps, row: InboundRow, code: string): Promise<void> {
  if (QUARANTINE_EXCLUDED.has(code) || !row.xml_storage_path || !row.xml_sha256 || !deps.store.quarantine) return;
  let result: "quarantined" | "already" | "not_eligible";
  try {
    result = await deps.store.quarantine(row.id, code);
  } catch {
    return;
  }
  if (result === "not_eligible" || deps.quarantineAck !== true || !deps.store.quarantineAcked) return;
  try {
    const ctx = await contextFor(deps, row);
    if (!ctx) return;
    await deps.provider.acknowledgeInbound(ctx, row.provider_received_id);
    await deps.store.quarantineAcked(row.id);
  } catch {
    // ACK zlyhal → ďalší beh (karanténa bez provider_acknowledged_at) to zopakuje; nič sa nestratí.
  }
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
  // Recipient → overená organizácia → company_id: bez zhody FAIL CLOSED (žiadny fallback).
  const recipient = verifyInboundRecipient(parsed.document, org?.participantId ?? null);
  if (!recipient.ok) return failPermanently(deps, row, recipient.code, recipient.detail);
  const mapped = mapInboundDraft(parsed.document, parsed.reviewReasons, org!.participantId, { allowTestScheme: deps.environment === "sandbox" });
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
  // Druhá kontrola tesne pred konceptom (organizácia sa medzitým mohla zmeniť).
  const recipient = verifyInboundRecipient(read.parsed.document, org?.participantId ?? null);
  if (!recipient.ok) return failPermanently(deps, row, recipient.code, recipient.detail);
  const mapped = mapInboundDraft(read.parsed.document, read.parsed.reviewReasons, org!.participantId, { allowTestScheme: deps.environment === "sandbox" });
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

export type SyncReport = {
  organizations: number;
  listed: number;
  registered: number;
  errors: { code: string }[];
  /** P1-4: počet načítaných stránok, už známe doklady, overené nápovedy z udalostí, dôvody zastavenia stránkovania. */
  pages?: number;
  alreadyKnown?: number;
  hintsRegistered?: number;
  stopped?: { code: "PAGINATION_LIMIT" | "PAGINATION_IGNORED" }[];
};

export type SyncOptions = {
  /** ID prijatých dokladov z udalosti (webhook/feed) podľa organizácie — overia sa u poskytovateľa v kontexte org. */
  hints?: Record<string, string[]>;
  maxPages?: number;
  pageSize?: number;
};

/** P1-4: strop stránok na organizáciu a beh (100 × 10 = 1 000 dokladov) — ochrana pred zahltením. */
export const INBOUND_SYNC_MAX_PAGES = 10;

/**
 * Zoznam nepotvrdených dokladov u poskytovateľa → registrácia (idempotentná
 * podľa ID poskytovateľa). Firma = mapovanie organizácie v DB.
 */
export async function syncInboundList(
  deps: InboundDeps,
  organizations: { providerOrgId: string }[],
  source: "webhook" | "poll",
  options: SyncOptions = {}
): Promise<SyncReport> {
  const report: SyncReport = { organizations: organizations.length, listed: 0, registered: 0, errors: [], pages: 0, alreadyKnown: 0, hintsRegistered: 0, stopped: [] };
  const paginated = (deps.provider.inboundPagination ?? "none") !== "none";
  const pageSize = paginated ? Math.max(1, Math.min(100, Math.floor(options.pageSize ?? 100))) : 50;
  const maxPages = paginated ? Math.max(1, Math.min(INBOUND_SYNC_MAX_PAGES, Math.floor(options.maxPages ?? INBOUND_SYNC_MAX_PAGES))) : 1;

  const registerOne = async (providerOrgId: string, providerReceivedId: string, meta: RegisterMeta): Promise<boolean | null> => {
    try {
      const r = await deps.store.register({ provider: deps.provider.name, environment: deps.environment, providerOrgId, providerReceivedId, source, meta });
      if (r.created) report.registered++;
      else report.alreadyKnown = (report.alreadyKnown ?? 0) + 1;
      return r.created;
    } catch (error) {
      report.errors.push({ code: error instanceof InboundStoreError ? error.code : errorCode(error) });
      return null;
    }
  };

  for (const org of organizations) {
    const ctx: ProviderContext = { environment: deps.environment, providerOrgId: org.providerOrgId };

    // 1) Nápovedy z udalosti: ID sa NEPOUŽIJE bez overenia — doklad musí byť stiahnuteľný v kontexte TEJTO
    //    organizácie (z mapovania v DB, nie z tela udalosti). Cudzie/podvrhnuté ID → poskytovateľ 404 → nič.
    const hints = [...new Set((options.hints?.[org.providerOrgId] ?? []).filter((id) => SAFE_ID.test(id)))].slice(0, 20);
    for (const id of hints) {
      try {
        await deps.provider.getInboundDocument(ctx, id);
      } catch {
        continue;
      }
      if ((await registerOne(org.providerOrgId, id, EMPTY_META)) === true) report.hintsRegistered = (report.hintsRegistered ?? 0) + 1;
    }

    // 2) Zoznam nepotvrdených dokladov po stránkach (iba v overenom režime; inak jedna stránka ako doteraz).
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      let list: InboundSummary[];
      try {
        list = await deps.provider.listUnacknowledgedInbound(ctx, { limit: pageSize, page });
      } catch (error) {
        report.errors.push({ code: `${INBOUND_ERROR.PROVIDER_FETCH_FAILED}:${errorCode(error)}` });
        break;
      }
      report.pages = (report.pages ?? 0) + 1;
      report.listed += list.length;
      const fresh = list.filter((item) => SAFE_ID.test(item.providerReceivedId) && !seen.has(item.providerReceivedId));
      if (page > 1 && list.length > 0 && fresh.length === 0) {
        // Poskytovateľ parameter stránkovania ignoruje (vracia tú istú stránku) → stop, žiadny nekonečný cyklus.
        report.stopped!.push({ code: "PAGINATION_IGNORED" });
        break;
      }
      for (const item of fresh) {
        seen.add(item.providerReceivedId);
        await registerOne(org.providerOrgId, item.providerReceivedId, {
          sender_participant_id: item.senderParticipantId,
          sender_ico: item.senderIco,
          document_number: item.documentNumber,
          document_type: item.documentType,
          is_test: item.isTest,
        });
      }
      if (list.length < pageSize) break;
      if (page === maxPages && paginated) report.stopped!.push({ code: "PAGINATION_LIMIT" });
    }
  }
  return report;
}

// Nápoveda nesie iba ID — metadáta doplní spracovanie z overeného XML (nič sa nepreberá z tela udalosti).
const EMPTY_META: RegisterMeta = {};

/** Poll fallback: všetky pripravené organizácie → zoznam → spracovanie. Webhook nie je jediný mechanizmus. */
export async function runInboundPoll(deps: InboundDeps, options: { batchSize?: number; leaseSeconds?: number } = {}) {
  const orgs = (await deps.store.listOrganizations(deps.provider.name, deps.environment)).filter((o) => o.providerOrgId);
  const sync = await syncInboundList(deps, orgs.map((o) => ({ providerOrgId: o.providerOrgId! })), "poll");
  const processed = await runInboundProcessBatch(deps, options);
  return { sync, processed };
}
