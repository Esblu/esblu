import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EinvoiceEnvironment, EinvoiceProvider } from "../provider/types.ts";
import { errorCode, providerStatusCode } from "../outbound/policy.ts";
import { reconcileOutboundRow } from "../outbound/worker.ts";
import { requestOutboundForInvoice } from "../outbound/request.ts";
import type { OutboundRow, OutboundStore } from "../outbound/store.ts";
import { processInboundRow } from "../inbound/processor.ts";
import type { InboundRow, InboundStore } from "../inbound/store.ts";
import { inboundCategory, outboundCategory } from "./categories.ts";
import { OpsStoreError, type OperatorAction, type OperatorKind, type OperatorReasonCode, type OpsStore } from "./store.ts";

// =============================================================================
// E-Faktúra — manuálne operátorské akcie. SERVER-ONLY.
//
// Každá akcia začína esblu_einvoice_operator_begin (DB): autorizácia aktéra z
// overeného JWT, aktívna firma + izolácia, pravidlo stavu, nárok pre NOVÉ
// operácie, lease na riadok, cooldown (rate limit) a audit udalosť (source=user).
// Až potom sa volá poskytovateľ. Pravidlá sú v DB — UI ich nemôže obísť.
//
//   outbound_reconcile : iba dotaz u poskytovateľa, NIKDY neodosiela. Pri
//                        neistom výsledku bez ID podania dohľadá podanie podľa
//                        Idempotency-Key: found → pokračuje sa s pôvodným;
//                        absent (autoritatívne) → failed + reconciled_absent_at
//                        (až potom je povolený nový pokus); unknown → bez zmeny.
//   outbound_retry     : nový pokus s NOVÝM kľúčom iba cez štandardnú požiadavku
//                        (readiness, príjemca, preflight) — DB ho odmietne pri
//                        neistom výsledku bez potvrdenej absencie.
//   inbound_reprocess  : opätovné spracovanie (bez prepisu XML, s dedupe).
//   inbound_ack_retry  : ACK iba s konceptom a overeným uloženým XML.
// =============================================================================

export type OperatorActionDeps = {
  ops: OpsStore;
  outbound: OutboundStore;
  inbound: InboundStore;
  runtime: { provider: EinvoiceProvider; environment: EinvoiceEnvironment } | null;
  /** User-scoped klient (JWT volajúceho) — potrebný pre nový pokus (readiness pod RLS). */
  userDb: SupabaseClient;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export type OperatorActionResult = {
  status: number;
  body: { code: string; kind?: OperatorKind; id?: string; state?: string; category?: string; outbound?: { id: string; state: string } };
};

export const OPERATOR_LEASE_SECONDS = 120;
export const OPERATOR_COOLDOWN_SECONDS = 60;

function statusForCode(code: string): number {
  if (code === "NOT_AUTHENTICATED") return 401;
  if (code.startsWith("ENTITLEMENT_DENIED") || code === "ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED" || code === "ESBLU_NO_ACTIVE_COMPANY") return 403;
  if (code === "ESBLU_EINVOICE_NOT_FOUND") return 404;
  if (code === "ESBLU_EINVOICE_ACTION_RATE_LIMITED") return 429;
  if (code === "ESBLU_EINVOICE_ACTION_INVALID" || code === "ESBLU_EINVOICE_REASON_INVALID") return 400;
  if (code.startsWith("ESBLU_EINVOICE_")) return 409;
  return 500;
}

function iso(d: Date): string {
  return d.toISOString();
}

export async function runOperatorAction(
  deps: OperatorActionDeps,
  input: { userId: string; kind: OperatorKind; id: string; action: OperatorAction; reasonCode: OperatorReasonCode | null }
): Promise<OperatorActionResult> {
  const runtime = deps.runtime;
  // Bez poskytovateľa sa akcia ani nezačne (nespotrebuje cooldown, nevznikne audit).
  if (!runtime) return { status: 503, body: { code: "PROVIDER_NOT_CONFIGURED" } };

  let begun;
  try {
    begun = await deps.ops.operatorBegin({
      actorUserId: input.userId,
      kind: input.kind,
      id: input.id,
      action: input.action,
      reasonCode: input.reasonCode,
      leaseSeconds: OPERATOR_LEASE_SECONDS,
      cooldownSeconds: OPERATOR_COOLDOWN_SECONDS,
    });
  } catch (error) {
    const code = error instanceof OpsStoreError ? error.code : errorCode(error);
    return { status: statusForCode(code), body: { code } };
  }

  const now = (deps.now ?? (() => new Date()))();

  if (begun.kind === "outbound") {
    const row = begun.row as unknown as OutboundRow & { reconciled_absent_at: string | null };
    const respond = (code: string, r: OutboundRow, status = 200): OperatorActionResult => ({
      status,
      body: { code, kind: "outbound", id: r.id, state: r.state, category: outboundCategory(r) },
    });

    if (input.action === "outbound_retry") {
      // Nový pokus = štandardná požiadavka (readiness pod RLS, príjemca, preflight, RPC).
      const result = await requestOutboundForInvoice(
        { userDb: deps.userDb, store: deps.outbound, runtime, env: deps.env },
        { userId: input.userId, invoiceId: row.invoice_id }
      );
      return {
        status: result.status,
        body: { code: result.body.code, kind: "outbound", id: row.id, ...(result.body.outbound ? { outbound: result.body.outbound } : {}) },
      };
    }

    // outbound_reconcile — NIKDY neodosiela.
    if (row.provider !== runtime.provider.name || row.environment !== runtime.environment) {
      await deps.outbound.transition(row.id, row.state, null, "reconcile", "EINVOICE_PROVIDER_MISMATCH", { locked_until: null });
      return respond("PROVIDER_MISMATCH", row, 409);
    }
    if (row.provider_submission_id) {
      const r = await reconcileOutboundRow({ store: deps.outbound, provider: runtime.provider, now: deps.now }, row);
      return { status: 200, body: { code: "RECONCILED", kind: "outbound", id: row.id, state: r.to } };
    }

    const org = await deps.outbound.organizationFor(row.company_id, row.environment);
    if (!org?.providerOrgId) {
      const r = await deps.outbound.transition(row.id, row.state, null, "reconcile", "EINVOICE_ORGANIZATION_NOT_READY", { locked_until: null });
      return respond("ORGANIZATION_NOT_READY", r, 409);
    }
    let lookup;
    try {
      lookup = await runtime.provider.findSubmissionByIdempotencyKey({ environment: row.environment, providerOrgId: org.providerOrgId }, row.idempotency_key);
    } catch (error) {
      const code = errorCode(error);
      const r = await deps.outbound.transition(row.id, row.state, null, "reconcile", code, { locked_until: null, status_checked_at: iso(now) });
      return respond(code, r, 502);
    }

    if (lookup.kind === "found") {
      // Pôvodné podanie existuje → pokračuje sa s ním (žiadne nové odoslanie).
      const r = await deps.outbound.transition(row.id, row.state, "sent", "reconcile", "RECONCILE_FOUND", {
        provider_submission_id: lookup.providerSubmissionId,
        provider_status: providerStatusCode(lookup.state),
        sent_at: iso(now),
        status_checked_at: iso(now),
        last_error_code: null,
        next_retry_at: null,
        send_in_flight: false,
        locked_until: null,
      });
      return respond("ORIGINAL_FOUND", r);
    }
    if (lookup.kind === "absent" && row.next_retry_at === null) {
      // Autoritatívne potvrdené: pôvodné podanie neexistuje a ďalší automatický
      // pokus nie je naplánovaný → uzavrieť; až teraz smie vzniknúť nový pokus.
      const r = await deps.outbound.transition(row.id, row.state, "failed", "reconcile", "EINVOICE_RECONCILED_ABSENT", {
        reconciled_absent_at: iso(now),
        last_error_code: "EINVOICE_RECONCILED_ABSENT",
        status_checked_at: iso(now),
        send_in_flight: false,
        locked_until: null,
      });
      return respond("ABSENT_CONFIRMED", r);
    }
    const code = lookup.kind === "absent" ? "ABSENT_RETRY_CONTINUES" : "RECONCILE_INCONCLUSIVE";
    const r = await deps.outbound.transition(row.id, row.state, null, "reconcile", code, { locked_until: null, status_checked_at: iso(now) });
    return respond(code, r);
  }

  // ---------------------------------------------------------------- inbound
  const row = begun.row as unknown as InboundRow & { dedupe_matched_on: string | null };
  const inboundDeps = { store: deps.inbound, provider: runtime.provider, environment: runtime.environment, now: deps.now };
  if (row.provider !== runtime.provider.name || row.environment !== runtime.environment) {
    return { status: 409, body: { code: "PROVIDER_MISMATCH", kind: "inbound", id: row.id, state: row.processing_status } };
  }

  if (input.action === "inbound_ack_retry") {
    // ACK iba s konceptom a overeným uloženým XML (DB to vynúti aj guardom).
    const bytes = row.xml_storage_path ? await deps.inbound.getXml(row.xml_storage_path) : null;
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== row.xml_sha256) {
      return { status: 409, body: { code: "STORAGE_INTEGRITY", kind: "inbound", id: row.id, state: row.processing_status } };
    }
  }

  const result = await processInboundRow(inboundDeps, row);
  return {
    status: 200,
    body: {
      code: result.code ?? (result.to === "acknowledged" ? "ACKNOWLEDGED" : "PROCESSED"),
      kind: "inbound",
      id: row.id,
      state: result.to,
      category: inboundCategory({ processing_status: result.to, dedupe_matched_on: row.dedupe_matched_on ?? null }),
    },
  };
}
