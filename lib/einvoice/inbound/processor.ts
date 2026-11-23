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

export type SyncStopCode =
  | "RATE_LIMITED"
  | "PAGINATION_LIMIT"
  | "PAGINATION_IGNORED"
  | "SCAN_SHIFTED"
  | "SCAN_INCOMPLETE"
  | "REQUEST_BUDGET"
  | "ANCHOR_UNAVAILABLE"
  | "LIST_FAILED";

export type SyncReport = {
  organizations: number;
  listed: number;
  registered: number;
  errors: { code: string }[];
  /** P1-4: požiadavky na zoznam, už známe doklady, overené nápovedy z udalostí, dôvody zastavenia stránkovania. */
  pages?: number;
  alreadyKnown?: number;
  hintsRegistered?: number;
  stopped?: { code: SyncStopCode }[];
  /** P1-4: počet prechodov od začiatku (reštart po posune zoznamu), úplné / neúplné / preskočené organizácie. */
  passes?: number;
  orgsComplete?: number;
  orgsIncomplete?: number;
  orgsSkipped?: number;
};

export type SyncOptions = {
  /** ID prijatých dokladov z udalosti (webhook/feed) podľa organizácie — overia sa u poskytovateľa v kontexte org. */
  hints?: Record<string, string[]>;
  maxPages?: number;
  pageSize?: number;
  /** Strop požiadaviek na zoznam za beh (všetky organizácie spolu). */
  requestBudget?: number;
  /** Strop prechodov od začiatku na organizáciu (reštart po zistenom posune). */
  maxPasses?: number;
  /** Zapísať stav skenu (poll áno; udalosť robí iba lacný sken 1 stránky → nezapisuje neúplný stav). */
  recordScan?: boolean;
};

/** P1-4: strop stránok na prechod a organizáciu (100 × 10 = 1 000 dokladov). */
export const INBOUND_SYNC_MAX_PAGES = 10;
/**
 * P1-4: strop požiadaviek na zoznam za jeden beh pre všetky organizácie. Partnerský kľúč má podľa dokumentácie
 * poskytovateľa ≥ 100 req/min a zdieľa ho aj odosielanie a feed → zoznam si berie najviac 30 za beh.
 */
export const INBOUND_SYNC_REQUEST_BUDGET = 30;
/** P1-4: najviac 3 prechody od začiatku na organizáciu (reštart po posune zoznamu). */
export const INBOUND_SYNC_MAX_PASSES = 3;

/**
 * Zoznam nepotvrdených dokladov u poskytovateľa → registrácia (idempotentná podľa ID poskytovateľa).
 * Firma = mapovanie organizácie v DB.
 *
 * P1-4 — skenovanie meniaceho sa zoznamu (limit + offset, najnovšie prvé, R1):
 *   - každá ďalšia stránka sa prekrýva s predchádzajúcou o 1 doklad (KOTVA = posledný doklad predchádzajúcej
 *     stránky; offset_k = offset_{k-1} + limit − 1);
 *   - kotva nájdená na indexe j ≥ 0 → medzi stránkami NIČ nechýba (nové doklady pribúdajú iba navrchu, ich
 *     opakovanie je neškodné — registrácia je idempotentná);
 *   - kotva chýba → pred ňou ubudli doklady (súbežný ACK iným procesom) a mohli by sa preskočiť → celý prechod
 *     sa ZAČNE ZNOVA od offsetu 0 (SCAN_SHIFTED), najviac INBOUND_SYNC_MAX_PASSES-krát;
 *   - prechod je ÚPLNÝ, iba ak dobehne na koniec zoznamu (meta.has_more = false, inak menej riadkov ako limit)
 *     bez chýbajúcej kotvy. Úplný prechod garantuje, že každý doklad nepotvrdený počas celého prechodu bol videný.
 *   - strop stránok / požiadaviek / prechodov → organizácia je NEÚPLNÁ (kód + záznam stavu skenu pre monitoring);
 *     ďalší beh začne znova od začiatku. Nič sa nepreskočí potichu.
 */
export async function syncInboundList(
  deps: InboundDeps,
  organizations: { providerOrgId: string }[],
  source: "webhook" | "poll",
  options: SyncOptions = {}
): Promise<SyncReport> {
  const report: SyncReport = {
    organizations: organizations.length, listed: 0, registered: 0, errors: [], pages: 0, alreadyKnown: 0, hintsRegistered: 0,
    stopped: [], passes: 0, orgsComplete: 0, orgsIncomplete: 0, orgsSkipped: 0,
  };
  const paginated = (deps.provider.inboundPagination ?? "none") !== "none";
  const pageSize = paginated ? Math.max(2, Math.min(100, Math.floor(options.pageSize ?? 100))) : 50;
  const maxPages = paginated ? Math.max(1, Math.min(INBOUND_SYNC_MAX_PAGES, Math.floor(options.maxPages ?? INBOUND_SYNC_MAX_PAGES))) : 1;
  const maxPasses = paginated ? Math.max(1, Math.min(5, Math.floor(options.maxPasses ?? INBOUND_SYNC_MAX_PASSES))) : 1;
  let budget = Math.max(1, Math.floor(options.requestBudget ?? INBOUND_SYNC_REQUEST_BUDGET));
  const stop = (code: SyncStopCode) => report.stopped!.push({ code });

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

  const fetchPage = async (ctx: ProviderContext, offset: number, page: number) => {
    budget--;
    report.pages = (report.pages ?? 0) + 1;
    if (deps.provider.listUnacknowledgedInboundPage) {
      return await deps.provider.listUnacknowledgedInboundPage(ctx, { limit: pageSize, page, offset });
    }
    const items = await deps.provider.listUnacknowledgedInbound(ctx, { limit: pageSize, page, offset });
    return { items, hasMore: null, rawCount: items.length };
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

    // 2) Sken zoznamu nepotvrdených dokladov (kotva + reštart, ohraničené požiadavky).
    if (budget <= 0) {
      report.orgsSkipped = (report.orgsSkipped ?? 0) + 1;
      continue;
    }
    const seen = new Set<string>();
    let complete = false;
    let orgCode: SyncStopCode | null = null;
    passes: for (let pass = 1; pass <= maxPasses; pass++) {
      report.passes = (report.passes ?? 0) + 1;
      let offset = 0;
      let anchor: string | null = null;
      let prevIds: string[] | null = null;
      for (let page = 1; page <= maxPages; page++) {
        if (budget <= 0) { orgCode = "REQUEST_BUDGET"; break passes; }
        let p: { items: InboundSummary[]; hasMore: boolean | null; rawCount: number };
        try {
          p = await fetchPage(ctx, offset, page);
        } catch (error) {
          report.errors.push({ code: `${INBOUND_ERROR.PROVIDER_FETCH_FAILED}:${errorCode(error)}` });
          if (errorCode(error) === "EINVOICE_PROVIDER_RATE_LIMITED") {
            // 429 / lokálny limit: ďalšie požiadavky v tomto behu by zlyhali tiež → zvyšok organizácií sa vynechá
            orgCode = "RATE_LIMITED";
            budget = 0;
          } else {
            orgCode = "LIST_FAILED";
          }
          break passes;
        }
        const ids = p.items.map((i) => i.providerReceivedId);
        report.listed += p.items.length;
        if (page > 1) {
          if (prevIds && ids.length > 0 && ids.length === prevIds.length && ids.every((id, i) => id === prevIds![i])) {
            orgCode = "PAGINATION_IGNORED"; // poskytovateľ offset ignoruje → žiadny nekonečný cyklus
            break passes;
          }
          if (anchor === null) { orgCode = "ANCHOR_UNAVAILABLE"; break passes; }
          if (!ids.includes(anchor)) {
            // pred kotvou ubudli doklady → riziko preskočenia → nový prechod od začiatku
            orgCode = "SCAN_SHIFTED";
            continue passes;
          }
        }
        for (const item of p.items) {
          if (!SAFE_ID.test(item.providerReceivedId) || seen.has(item.providerReceivedId)) continue;
          seen.add(item.providerReceivedId);
          await registerOne(org.providerOrgId, item.providerReceivedId, {
            sender_participant_id: item.senderParticipantId,
            sender_ico: item.senderIco,
            document_number: item.documentNumber,
            document_type: item.documentType,
            is_test: item.isTest,
          });
        }
        // Koniec zoznamu: meta.has_more = false (autoritatívne), inak menej riadkov ako limit (pred filtrom).
        if (p.hasMore === false || (p.hasMore === null && p.rawCount < pageSize)) {
          complete = true;
          orgCode = null;
          break passes;
        }
        if (!paginated) { orgCode = "SCAN_INCOMPLETE"; break passes; } // kill-switch: iba prvá stránka
        if (page === maxPages) { orgCode = "PAGINATION_LIMIT"; break passes; }
        anchor = ids.length > 0 ? ids[ids.length - 1] : null;
        prevIds = ids;
        offset = offset + pageSize - 1; // 1 doklad prekryv = kotva
      }
    }
    if (!complete && orgCode === null) orgCode = "SCAN_INCOMPLETE";
    if (complete) report.orgsComplete = (report.orgsComplete ?? 0) + 1;
    else {
      report.orgsIncomplete = (report.orgsIncomplete ?? 0) + 1;
      stop(orgCode === "SCAN_SHIFTED" ? "SCAN_SHIFTED" : orgCode!);
    }
    if (deps.store.recordInboundScan && (options.recordScan ?? true)) {
      try {
        await deps.store.recordInboundScan({ provider: deps.provider.name, environment: deps.environment, providerOrgId: org.providerOrgId, complete, code: complete ? null : orgCode });
      } catch {
        // bez migrácie 20261125100000 / zlyhanie zápisu: výsledok ostáva v reporte cronu
      }
    }
  }
  if ((report.orgsSkipped ?? 0) > 0) stop("REQUEST_BUDGET");
  return report;
}

// =============================================================================
// P1-4: zdieľaný limit požiadaviek na poskytovateľa pre príjem (všetky inštancie, okno 1 min v DB).
// Partnerský kľúč eFaktura.sk: ≥ 100 req/min spolu pre odosielanie, feed, príjem aj údržbu. Príjem smie spolu
// najviac INBOUND_RATE_LIMITS.event za minútu, poll iba INBOUND_RATE_LIMITS.poll (zvyšok ostáva udalostiam);
// ≥ 40 req/min ostáva odosielaniu, feedu a údržbe (tie limiter nepoužívajú, ich strop je daný dávkami cronov).
// Zamietnutie = lokálne EINVOICE_PROVIDER_RATE_LIMITED (retryable) → beh sa zastaví ako pri 429, nič sa nestratí.
// Bez migrácie 20261125100000 / pri chybe DB: fail-open (platia stropy jednotlivých behov).
// =============================================================================
/** Mení sa iba v testoch. */
export const INBOUND_RATE_LIMITS: { poll: number; event: number } = { poll: 40, event: 60 };
const RATE_LIMITED_METHODS = new Set(["listUnacknowledgedInbound", "listUnacknowledgedInboundPage", "getInboundDocument", "acknowledgeInbound"]);

export function withInboundRateLimit(deps: InboundDeps, cls: "poll" | "event"): InboundDeps {
  const store = deps.store;
  if (!store.acquireProviderBudget) return deps;
  const provider = new Proxy(deps.provider, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      if (!RATE_LIMITED_METHODS.has(String(key))) return value.bind(target);
      return async (...args: unknown[]) => {
        let ok = true;
        try {
          ok = await store.acquireProviderBudget!(target.name, deps.environment, 1, INBOUND_RATE_LIMITS[cls]);
        } catch {
          ok = true; // fail-open: výpadok DB funkcie limitera nesmie zastaviť príjem (stropy behov platia)
        }
        if (!ok) throw new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", "Lokálny limit požiadaviek na poskytovateľa", true);
        return await value.apply(target, args);
      };
    },
  });
  return { ...deps, provider };
}

/**
 * P1-4: príjem z udalosti (webhook aj feed). Lacný a ohraničený: overenie nápovedy (≤ 1), 1 stránka zoznamu,
 * spracovanie max. 3 dokladov (≤ 6 požiadaviek) → ≤ 8 požiadaviek na udalosť, všetko cez limiter `event`.
 * Úplný sken robí iba poll (cron); udalosť stav skenu nezapisuje.
 */
export async function runInboundEvent(deps: InboundDeps, providerOrgId: string, hint: string | null) {
  const limited = withInboundRateLimit(deps, "event");
  const sync = await syncInboundList(limited, [{ providerOrgId }], "webhook", {
    ...(hint ? { hints: { [providerOrgId]: [hint] } } : {}),
    requestBudget: 1,
    maxPages: 1,
    recordScan: false,
  });
  const processed = await runInboundProcessBudget(limited, { maxItems: 3, batchSize: 3, deadlineMs: Date.now() + 20_000 });
  return { sync, processed };
}

// Nápoveda nesie iba ID — metadáta doplní spracovanie z overeného XML (nič sa nepreberá z tela udalosti).
const EMPTY_META: RegisterMeta = {};

/**
 * P1-4 priepustnosť: spracovanie s rozpočtom namiesto jednej dávky 5 dokladov.
 *   - najviac `maxItems` dokladov za beh (každý = stiahnutie XML + ACK = 2 požiadavky na poskytovateľa),
 *   - termín `deadlineMs` (rezerva pod maxDuration cronu 60 s),
 *   - claim po malých dávkach (FOR UPDATE SKIP LOCKED + lease) → súbežné webhooky / behy sa neprekrývajú,
 *   - výpadok poskytovateľa: 429 hneď zastaví beh; `maxConsecutiveProviderFailures` po sebe idúcich chýb
 *     poskytovateľa (sieť / 5xx / timeout) zastaví beh (doklady čakajú na retry s backoffom, nič sa nestratí).
 */
export const INBOUND_POLL_MAX_ITEMS = 30;
export const INBOUND_POLL_RUN_MS = 40_000;

export type InboundBudgetReport = InboundReport & { stoppedCode: "MAX_ITEMS" | "DEADLINE" | "PROVIDER_RATE_LIMITED" | "PROVIDER_DEGRADED" | null };

export async function runInboundProcessBudget(
  deps: InboundDeps,
  options: { maxItems?: number; deadlineMs?: number; batchSize?: number; leaseSeconds?: number; maxConsecutiveProviderFailures?: number } = {}
): Promise<InboundBudgetReport> {
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? INBOUND_POLL_MAX_ITEMS));
  const deadline = options.deadlineMs ?? Date.now() + INBOUND_POLL_RUN_MS;
  const batchSize = Math.max(1, Math.min(25, Math.floor(options.batchSize ?? 10)));
  const maxFails = Math.max(1, Math.floor(options.maxConsecutiveProviderFailures ?? 3));
  // Sledovanie chýb poskytovateľa (výsledok kroku nesie iba interný kód, napr. PROVIDER_FETCH_FAILED / ACK_FAILED).
  let lastProviderError: unknown = null;
  const provider = new Proxy(deps.provider, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      if (key !== "getInboundDocument" && key !== "acknowledgeInbound") return value.bind(target);
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          lastProviderError = error;
          throw error;
        }
      };
    },
  });
  const tracked: InboundDeps = { ...deps, provider };
  const results: InboundItemResult[] = [];
  let claimed = 0;
  let consecutive = 0;
  let stoppedCode: InboundBudgetReport["stoppedCode"] = null;
  outer: while (true) {
    if (claimed >= maxItems) { stoppedCode = "MAX_ITEMS"; break; }
    if (Date.now() >= deadline) { stoppedCode = "DEADLINE"; break; }
    const rows = await deps.store.claim(Math.min(batchSize, maxItems - claimed), options.leaseSeconds ?? 120);
    if (rows.length === 0) break;
    claimed += rows.length;
    for (const row of rows) {
      // Neodštartované riadky po termíne / výpadku: lease vyprší a ďalší beh ich vezme (žiadna strata).
      if (Date.now() >= deadline) { stoppedCode = "DEADLINE"; break outer; }
      lastProviderError = null;
      let r: InboundItemResult;
      try {
        r = await processInboundRow(tracked, row);
      } catch (error) {
        r = { inboundId: row.id, from: row.processing_status, to: row.processing_status, code: error instanceof InboundStoreError ? error.code : errorCode(error) };
      }
      results.push(r);
      const err = lastProviderError;
      if (err !== null && errorCode(err) === "EINVOICE_PROVIDER_RATE_LIMITED") { stoppedCode = "PROVIDER_RATE_LIMITED"; break outer; }
      consecutive = err !== null && isRetryableProviderError(err) ? consecutive + 1 : 0;
      if (consecutive >= maxFails) { stoppedCode = "PROVIDER_DEGRADED"; break outer; }
    }
  }
  return { claimed, results, stoppedCode };
}

/** Poll fallback: pripravené organizácie (najdlhšie bez úplného skenu prvé) → sken zoznamu → spracovanie s rozpočtom. */
export async function runInboundPoll(
  rawDeps: InboundDeps,
  options: { batchSize?: number; leaseSeconds?: number; maxItems?: number; deadlineMs?: number; requestBudget?: number; pageSize?: number } = {}
) {
  const deps = withInboundRateLimit(rawDeps, "poll");
  let orgs = (await deps.store.listOrganizations(deps.provider.name, deps.environment)).filter((o) => o.providerOrgId);
  if (deps.store.inboundScanOrder) {
    try {
      const order = await deps.store.inboundScanOrder(deps.provider.name, deps.environment);
      const rank = new Map(order.map((id, i) => [id, i]));
      orgs = [...orgs].sort((a, b) => (rank.get(a.providerOrgId!) ?? -1) - (rank.get(b.providerOrgId!) ?? -1));
    } catch {
      // bez migrácie: pôvodné poradie
    }
  }
  const sync = await syncInboundList(deps, orgs.map((o) => ({ providerOrgId: o.providerOrgId! })), "poll", {
    requestBudget: options.requestBudget,
    pageSize: options.pageSize,
  });
  const processed = await runInboundProcessBudget(deps, {
    maxItems: options.maxItems ?? options.batchSize ?? INBOUND_POLL_MAX_ITEMS,
    deadlineMs: options.deadlineMs,
    leaseSeconds: options.leaseSeconds,
  });
  return { sync, processed };
}
