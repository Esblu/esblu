import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasEntitlement, parseCompanyEntitlements } from "@/lib/entitlements";
import { loadAccessFlags } from "./access.ts";
import { getEinvoiceProvider } from "../provider/index.ts";
import { loadEinvoiceReadiness } from "../readiness-server.ts";
import { inboundCategory, outboundCategory } from "../ops/categories.ts";
import { inboundAllowedActions, outboundAllowedActions } from "../ops/allowed-actions.ts";
import type {
  EinvoiceAccess,
  EinvoiceTimelineItem,
  InboundDetailDto,
  InboundItemDto,
  InboundListDto,
  InvoiceEinvoiceSummaryDto,
  OutboundAttemptDto,
} from "./types.ts";

// =============================================================================
// E-Faktúra UI — serverové zostavenie prehľadov. SERVER-ONLY.
//
// VŠETKO cez user-scoped klienta (JWT volajúceho): RLS rozhoduje, čo
// používateľ vidí (finance.view v aktívnej firme; employee / admin bez
// financií / iná firma = nič). Bez service_role. Do odpovede ide iba allowlist
// polí — žiadne ID poskytovateľa, kľúče, cesty v storage, participant ID,
// surové dôkazy ani UUID iných používateľov.
// =============================================================================

export type SummaryResult<T> = { ok: true; data: T } | { ok: false; status: 401 | 403 | 404 | 500 | 503; code: string };

const OUTBOUND_COLS =
  "id, attempt, state, updated_at, sent_at, delivered_at, last_error_code, provider_submission_id, next_retry_at, " +
  "send_outcome_unknown, reconciled_absent_at, ubl_storage_path, evidence, requested_by";
const INBOUND_COLS =
  "id, processing_status, received_at, updated_at, acknowledged_at, document_number, document_type, issue_date, invoice_id, " +
  "last_error_code, review_reasons, dedupe_matched_on, is_test, xml_storage_path, xml_sha256";
const EVENT_COLS = "from_state, to_state, source, provider_code, metadata, created_at";

type OutboundRowLite = {
  id: string; attempt: number; state: string; updated_at: string; sent_at: string | null; delivered_at: string | null;
  last_error_code: string | null; provider_submission_id: string | null; next_retry_at: string | null;
  send_outcome_unknown: boolean; reconciled_absent_at: string | null; ubl_storage_path: string | null;
  evidence: Record<string, unknown> | null; requested_by: string | null;
};
type InboundRowLite = {
  id: string; processing_status: string; received_at: string; updated_at: string; acknowledged_at: string | null;
  document_number: string | null; document_type: string | null; issue_date: string | null; invoice_id: string | null;
  last_error_code: string | null; review_reasons: string[] | null; dedupe_matched_on: string | null; is_test: boolean;
  xml_storage_path: string | null; xml_sha256: string | null;
};
type EventRow = { from_state: string | null; to_state: string; source: string; provider_code: string | null; metadata: Record<string, unknown> | null; created_at: string };

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

function providerConfigured(env: Record<string, string | undefined>): boolean {
  try {
    return getEinvoiceProvider(env) !== null;
  } catch {
    return false;
  }
}

export type AccessResult =
  | { ok: true; financeView: boolean; access: EinvoiceAccess }
  | { ok: false; kind: "unauthenticated" | "forbidden" | "temporary" };

/**
 * Prístup volajúceho (RLS/RPC pod jeho JWT). Chyby sú klasifikované (lib/einvoice/ui/access.ts):
 * expirovaný JWT → unauthenticated, odmietnutie → forbidden, inak temporary. Clock skew
 * čerstvého JWT (PGRST303 „issued at future“) sa ohraničene zopakuje.
 */
export async function loadAccessResult(db: SupabaseClient, env: Record<string, string | undefined>, sleep?: (ms: number) => Promise<void>): Promise<AccessResult> {
  const configured = providerConfigured(env);
  const res = await loadAccessFlags((fn, args) => db.rpc(fn, args), {
    rolloutEnvironment: configured ? env.ESBLU_EINVOICE_ENVIRONMENT?.trim() || null : null,
    sleep,
  });
  if (!res.ok) return res;
  const entitlements = parseCompanyEntitlements(res.flags.entitlements);
  return {
    ok: true,
    financeView: res.flags.financeView,
    access: {
      financeManage: res.flags.financeManage,
      entitlementActive: hasEntitlement(entitlements, "einvoice"),
      providerConfigured: configured,
      // Phase 6: rollout allowlist pre serverové prostredie (fail-closed).
      rolloutEnabled: res.flags.rollout === true,
    },
  };
}

/** Spätná kompatibilita: null = akákoľvek chyba (nové volania používajú loadAccessResult). */
export async function loadAccess(db: SupabaseClient, env: Record<string, string | undefined>): Promise<{ financeView: boolean; access: EinvoiceAccess } | null> {
  const r = await loadAccessResult(db, env);
  return r.ok ? { financeView: r.financeView, access: r.access } : null;
}

/** Klasifikovaná chyba prístupu → HTTP (nikdy nemaskuje 401/403 ako dočasnú chybu). */
export function accessFailure(kind: "unauthenticated" | "forbidden" | "temporary"): { ok: false; status: 401 | 403 | 503; code: string } {
  if (kind === "unauthenticated") return { ok: false, status: 401, code: "SESSION_EXPIRED" };
  if (kind === "forbidden") return { ok: false, status: 403, code: "FORBIDDEN" };
  return { ok: false, status: 503, code: "TEMPORARILY_UNAVAILABLE" };
}

function toTimeline(rows: EventRow[], requesterId: string, requestedBy: string | null): EinvoiceTimelineItem[] {
  return rows
    .map((e) => {
      const action = e.from_state !== null && e.from_state === e.to_state && (e.provider_code ?? "").startsWith("OPERATOR_");
      const source: EinvoiceTimelineItem["source"] = e.source === "user" ? "user" : e.source === "provider" ? "provider" : "system";
      const actorId = typeof e.metadata?.actor_user_id === "string" ? (e.metadata.actor_user_id as string) : e.from_state === null && source === "user" ? requestedBy : null;
      return {
        at: e.created_at,
        kind: action ? ("action" as const) : ("transition" as const),
        from: e.from_state,
        to: e.to_state,
        source,
        actor: source === "user" ? (actorId && actorId === requesterId ? ("self" as const) : ("user" as const)) : null,
        code: e.provider_code && SAFE_CODE.test(e.provider_code) ? e.provider_code : null,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

function evidenceDto(evidence: Record<string, unknown> | null): OutboundAttemptDto["evidence"] {
  if (!evidence) return null;
  return {
    deliveryState: typeof evidence.delivery_state === "string" ? evidence.delivery_state : null,
    deliveredAt: typeof evidence.delivered_at === "string" ? evidence.delivered_at : null,
    transactions: Array.isArray(evidence.transactions) ? evidence.transactions.length : 0,
  };
}

async function events(db: SupabaseClient, column: "outbound_id" | "inbound_id", id: string): Promise<EventRow[] | null> {
  const { data, error } = await db.from("einvoice_events").select(EVENT_COLS).eq(column, id).returns<EventRow[]>();
  return error ? null : data ?? [];
}

// ----------------------------------------------------------------------------- outbound

async function outboundSummary(
  db: SupabaseClient,
  invoiceId: string,
  documentStatus: string,
  requesterId: string,
  access: EinvoiceAccess,
  env: Record<string, string | undefined>
): Promise<SummaryResult<InvoiceEinvoiceSummaryDto>> {
  const readinessLoad = await loadEinvoiceReadiness(db, invoiceId, env);
  const readiness = readinessLoad.ok ? readinessLoad.result : null;

  const { data: rows, error } = await db.from("einvoice_outbound").select(OUTBOUND_COLS).eq("invoice_id", invoiceId).returns<OutboundRowLite[]>();
  if (error) return { ok: false, status: 500, code: "QUERY_FAILED" };
  const attempts = [...(rows ?? [])].sort((a, b) => b.attempt - a.attempt);

  const timeline: EinvoiceTimelineItem[] = [];
  for (const a of attempts) {
    const ev = await events(db, "outbound_id", a.id);
    if (ev === null) return { ok: false, status: 500, code: "QUERY_FAILED" };
    timeline.push(...toTimeline(ev, requesterId, a.requested_by));
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  return {
    ok: true,
    data: {
      kind: "outbound",
      documentStatus,
      access,
      readiness,
      attempts: attempts.map((a) => ({
        id: a.id,
        attempt: a.attempt,
        state: a.state,
        category: outboundCategory(a),
        updatedAt: a.updated_at,
        sentAt: a.sent_at,
        deliveredAt: a.delivered_at,
        lastErrorCode: a.last_error_code && SAFE_CODE.test(a.last_error_code) ? a.last_error_code : null,
        outcomeUnknown: a.send_outcome_unknown && a.provider_submission_id === null,
        hasDocument: a.ubl_storage_path !== null,
        evidence: evidenceDto(a.evidence),
      })),
      timeline,
      allowed: outboundAllowedActions({ access, readinessReady: readiness?.ready === true, attempts }),
    },
  };
}

// ----------------------------------------------------------------------------- inbound

async function enrich(db: SupabaseClient, rows: InboundRowLite[]): Promise<InboundItemDto[] | null> {
  const invoiceIds = [...new Set(rows.map((r) => r.invoice_id).filter((x): x is string => x !== null))];
  const invoices = new Map<string, { document_status: string; total_amount: number | string | null; currency: string | null; supplier_business_partner_id: string | null }>();
  if (invoiceIds.length > 0) {
    const { data, error } = await db
      .from("invoices")
      .select("id, document_status, total_amount, currency, supplier_business_partner_id")
      .in("id", invoiceIds)
      .returns<{ id: string; document_status: string; total_amount: number | string | null; currency: string | null; supplier_business_partner_id: string | null }[]>();
    if (error) return null;
    for (const i of data ?? []) invoices.set(i.id, i);
  }
  const partnerIds = [...new Set([...invoices.values()].map((i) => i.supplier_business_partner_id).filter((x): x is string => x !== null))];
  const partners = new Map<string, string>();
  if (partnerIds.length > 0) {
    const { data, error } = await db.from("business_partners").select("id, legal_name").in("id", partnerIds).returns<{ id: string; legal_name: string }[]>();
    if (error) return null;
    for (const p of data ?? []) partners.set(p.id, p.legal_name);
  }

  const out: InboundItemDto[] = [];
  for (const r of rows) {
    const inv = r.invoice_id ? invoices.get(r.invoice_id) ?? null : null;
    let notice: InboundItemDto["notice"] = null;
    if (r.processing_status === "failed") {
      notice = "manual_review";
      if (r.last_error_code === "UNSUPPORTED_PROFILE") {
        const ev = await events(db, "inbound_id", r.id);
        if (ev === null) return null;
        if (ev.some((e) => e.to_state === "failed" && e.provider_code === "CREDIT_NOTE_NOT_SUPPORTED")) notice = "credit_note_unsupported";
      }
    }
    out.push({
      id: r.id,
      status: r.processing_status,
      category: inboundCategory(r),
      receivedAt: r.received_at,
      updatedAt: r.updated_at,
      acknowledgedAt: r.acknowledged_at,
      documentNumber: r.document_number,
      documentType: r.document_type,
      issueDate: r.issue_date,
      invoiceId: r.invoice_id,
      invoiceStatus: inv?.document_status ?? null,
      supplierName: inv?.supplier_business_partner_id ? partners.get(inv.supplier_business_partner_id) ?? null : null,
      total: inv?.total_amount === null || inv?.total_amount === undefined ? null : Number(inv.total_amount),
      currency: inv?.currency ?? null,
      lastErrorCode: r.last_error_code && SAFE_CODE.test(r.last_error_code) ? r.last_error_code : null,
      reviewReasons: (r.review_reasons ?? []).filter((x) => /^[A-Z0-9_]{1,60}$/.test(x)),
      dedupeMatchedOn: r.dedupe_matched_on,
      isTest: r.is_test === true,
      hasXml: r.xml_storage_path !== null && r.xml_sha256 !== null,
      notice,
    });
  }
  return out;
}

async function inboundDetail(db: SupabaseClient, row: InboundRowLite, requesterId: string, access: EinvoiceAccess): Promise<SummaryResult<InboundDetailDto>> {
  const [items, ev] = await Promise.all([enrich(db, [row]), events(db, "inbound_id", row.id)]);
  if (!items || ev === null) return { ok: false, status: 500, code: "QUERY_FAILED" };
  const item = items[0];
  return {
    ok: true,
    data: {
      kind: "inbound",
      access,
      item,
      timeline: toTimeline(ev, requesterId, null),
      allowed: inboundAllowedActions({ access, status: item.status, invoiceId: item.invoiceId, hasXml: item.hasXml, lastErrorCode: item.lastErrorCode }),
    },
  };
}

// ----------------------------------------------------------------------------- verejné funkcie

/** Prehľad E-Faktúry pre detail faktúry (vydaná → outbound, prijatá z Peppolu → inbound). */
export async function loadInvoiceEinvoiceSummary(
  db: SupabaseClient,
  invoiceId: string,
  requesterId: string,
  env: Record<string, string | undefined> = process.env
): Promise<SummaryResult<InvoiceEinvoiceSummaryDto>> {
  const acc = await loadAccessResult(db, env);
  if (!acc.ok) return accessFailure(acc.kind);
  if (!acc.financeView) return { ok: false, status: 403, code: "FORBIDDEN" };

  const { data: invoice, error } = await db
    .from("invoices")
    .select("id, direction, document_status, source")
    .eq("id", invoiceId)
    .maybeSingle<{ id: string; direction: string; document_status: string; source: string }>();
  if (error) return { ok: false, status: 500, code: "QUERY_FAILED" };
  if (!invoice) return { ok: false, status: 404, code: "NOT_FOUND" };

  if (invoice.direction === "issued") {
    return outboundSummary(db, invoiceId, invoice.document_status, requesterId, acc.access, env);
  }
  const { data: rows, error: inErr } = await db.from("einvoice_inbound").select(INBOUND_COLS).eq("invoice_id", invoiceId).returns<InboundRowLite[]>();
  if (inErr) return { ok: false, status: 500, code: "QUERY_FAILED" };
  const row = [...(rows ?? [])].sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
  if (!row) return { ok: true, data: { kind: "none", access: acc.access } };
  return inboundDetail(db, row, requesterId, acc.access);
}

export async function loadInboundList(db: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<SummaryResult<InboundListDto>> {
  const acc = await loadAccessResult(db, env);
  if (!acc.ok) return accessFailure(acc.kind);
  if (!acc.financeView) return { ok: false, status: 403, code: "FORBIDDEN" };
  const { data, error } = await db
    .from("einvoice_inbound")
    .select(INBOUND_COLS)
    .order("received_at", { ascending: false })
    .limit(200)
    .returns<InboundRowLite[]>();
  if (error) return { ok: false, status: 500, code: "QUERY_FAILED" };
  const items = await enrich(db, data ?? []);
  if (!items) return { ok: false, status: 500, code: "QUERY_FAILED" };
  return { ok: true, data: { access: acc.access, items } };
}

export async function loadInboundDetail(
  db: SupabaseClient,
  inboundId: string,
  requesterId: string,
  env: Record<string, string | undefined> = process.env
): Promise<SummaryResult<InboundDetailDto>> {
  const acc = await loadAccessResult(db, env);
  if (!acc.ok) return accessFailure(acc.kind);
  if (!acc.financeView) return { ok: false, status: 403, code: "FORBIDDEN" };
  const { data, error } = await db.from("einvoice_inbound").select(INBOUND_COLS).eq("id", inboundId).maybeSingle<InboundRowLite>();
  if (error) return { ok: false, status: 500, code: "QUERY_FAILED" };
  if (!data) return { ok: false, status: 404, code: "NOT_FOUND" };
  return inboundDetail(db, data, requesterId, acc.access);
}
