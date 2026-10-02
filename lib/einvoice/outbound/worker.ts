import "server-only";

import { createHash } from "node:crypto";
import type { EinvoiceProvider, ProviderContext } from "../provider/types.ts";
import {
  classifySendError,
  errorCode,
  outboundStateFromProvider,
  planAfterError,
  providerStatusCode,
  type SendDisposition,
} from "./policy.ts";
import { OutboundStoreError, type OutboundRow, type OutboundStore, type TransitionFields } from "./store.ts";

// =============================================================================
// E-Faktúra outbound — worker (odoslanie) a reconciliation. SERVER-ONLY logika
// bez vlastného I/O: privilegovaný prístup ide cez OutboundStore (service_role
// v supabase-store.ts), sieť cez EinvoiceProvider. Volá ju iba cron route.
//
//   send:      claim (SKIP LOCKED + lease) → uložené bajty → znovu SHA-256 →
//              sendUbl s TÝM ISTÝM Idempotency-Key → zápis výsledku.
//   reconcile: podania s ID poskytovateľa → GET status → deterministický
//              prechod; pri doručení iba allowlistovaný dôkaz.
// Žiadny výsledok tu nevytvára nový pokus (nový kľúč) — to je výhradne ručná
// akcia po terminálnom failed/rejected.
// =============================================================================

export type WorkerDeps = {
  store: OutboundStore;
  provider: EinvoiceProvider;
  now?: () => Date;
};

export type WorkerOptions = {
  /** Max. riadkov na jeden beh (DB strop 10). Spracúvajú sa sekvenčne — šetrné k limitom poskytovateľa. */
  batchSize?: number;
  leaseSeconds?: number;
  reconcileAfterSeconds?: number;
  /**
   * Phase 6: absolútny termín behu (epoch ms). Riadky sa claimujú PO JEDNOM a
   * ďalší sa nezoberie, ak by sa do termínu nestihol (itemBudgetMs). Tým sa
   * nikdy neoznačí ako „in flight" riadok, ktorý sa v tomto behu neodošle
   * (pád serverless funkcie na maxDuration by inak zanechal falošne neistý výsledok).
   */
  deadlineMs?: number;
  /** Odhad najhoršieho trvania jedného riadku (timeouty volaní poskytovateľa). */
  itemBudgetMs?: number;
};

export type WorkerItemResult = { outboundId: string; from: string; to: string; code: string | null };
export type WorkerReport = { claimed: number; results: WorkerItemResult[] };

const DEFAULT_BATCH = 5;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_RECONCILE_AFTER_SECONDS = 300;

function iso(d: Date): string {
  return d.toISOString();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function contextFor(deps: WorkerDeps, row: OutboundRow): Promise<ProviderContext | { error: string }> {
  if (row.provider !== deps.provider.name) return { error: "EINVOICE_PROVIDER_MISMATCH" };
  const org = await deps.store.organizationFor(row.company_id, row.environment);
  if (!org || !org.providerOrgId || !org.peppolEligible) return { error: "EINVOICE_ORGANIZATION_NOT_READY" };
  return { environment: row.environment, providerOrgId: org.providerOrgId };
}

/** Zapíše výsledok neúspešného pokusu podľa politiky (retry / fail / reject / hold). */
async function recordFailure(deps: WorkerDeps, row: OutboundRow, disposition: SendDisposition): Promise<WorkerItemResult> {
  const now = (deps.now ?? (() => new Date()))();
  const plan = planAfterError({
    disposition,
    attemptsMade: row.retry_count,
    priorOutcomeUnknown: row.send_outcome_unknown,
    now,
  });
  const base: TransitionFields = { send_in_flight: false, locked_until: null };
  let updated: OutboundRow;
  switch (plan.action) {
    case "retry":
      updated = await deps.store.transition(row.id, row.state, null, "job", plan.code, {
        ...base,
        last_error_code: plan.code,
        next_retry_at: iso(plan.nextRetryAt),
        ...(plan.outcomeUnknown ? { send_outcome_unknown: true } : {}),
      });
      break;
    case "hold":
      updated = await deps.store.transition(row.id, row.state, null, "job", plan.code, {
        ...base,
        last_error_code: plan.code,
        next_retry_at: null,
        ...(plan.outcomeUnknown ? { send_outcome_unknown: true } : {}),
      });
      break;
    case "reject":
      updated = await deps.store.transition(row.id, row.state, "rejected", "provider", plan.code, {
        ...base, last_error_code: plan.code, next_retry_at: null,
      });
      break;
    case "fail":
      updated = await deps.store.transition(row.id, row.state, "failed", "job", plan.code, {
        ...base, last_error_code: plan.code, next_retry_at: null,
      });
      break;
  }
  return { outboundId: row.id, from: row.state, to: updated.state, code: plan.code };
}

async function sendOne(deps: WorkerDeps, row: OutboundRow): Promise<WorkerItemResult> {
  // 1) presné uložené bajty + nemenný hash
  if (!row.ubl_storage_path || !row.ubl_sha256) {
    return recordFailure(deps, row, { kind: "fail", code: "EINVOICE_UBL_MISSING" });
  }
  const bytes = await deps.store.getUbl(row.ubl_storage_path);
  if (!bytes) return recordFailure(deps, row, { kind: "fail", code: "EINVOICE_UBL_MISSING" });
  if (sha256Hex(bytes) !== row.ubl_sha256 || (row.ubl_size_bytes !== null && bytes.byteLength !== row.ubl_size_bytes)) {
    // Bajty sa nezhodujú s nemennou väzbou → NIKDY neodoslať.
    return recordFailure(deps, row, { kind: "fail", code: "EINVOICE_UBL_HASH_MISMATCH" });
  }
  if (!row.receiver_participant_id) {
    return recordFailure(deps, row, { kind: "fail", code: "EINVOICE_RECEIVER_NOT_VERIFIED" });
  }

  // 2) organizácia u poskytovateľa — iba zo servera
  const ctx = await contextFor(deps, row);
  if ("error" in ctx) return recordFailure(deps, row, { kind: "retry", code: ctx.error, outcomeUnknown: false });

  // 3) odoslanie s TÝM ISTÝM kľúčom
  let result;
  try {
    result = await deps.provider.sendUbl(ctx, {
      ubl: bytes,
      ublSha256: row.ubl_sha256,
      idempotencyKey: row.idempotency_key,
      receiverParticipantId: row.receiver_participant_id,
    });
  } catch (error) {
    return recordFailure(deps, row, classifySendError(error));
  }

  const now = (deps.now ?? (() => new Date()))();
  if (result.state === "queued" && result.providerSubmissionId) {
    const updated = await deps.store.transition(row.id, row.state, "sent", "provider", providerStatusCode(result.state), {
      provider_submission_id: result.providerSubmissionId,
      provider_staged_id: result.providerStagedId,
      provider_status: providerStatusCode(result.state),
      sent_at: iso(now),
      status_checked_at: iso(now),
      last_error_code: null,
      next_retry_at: null,
      send_in_flight: false,
      locked_until: null,
    });
    return { outboundId: row.id, from: row.state, to: updated.state, code: null };
  }
  if (result.state === "rejected") {
    const updated = await deps.store.transition(row.id, row.state, "rejected", "provider", "EINVOICE_PROVIDER_REJECTED_PAYLOAD", {
      reject_reason: result.rejectReason,
      last_error_code: "EINVOICE_PROVIDER_REJECTED_PAYLOAD",
      next_retry_at: null,
      send_in_flight: false,
      locked_until: null,
    });
    return { outboundId: row.id, from: row.state, to: updated.state, code: "EINVOICE_PROVIDER_REJECTED_PAYLOAD" };
  }
  // validated / staged bez ID = neočakávané pri dispatch:"now" → neistý výsledok, opakovať tým istým kľúčom.
  return recordFailure(deps, row, { kind: "retry", code: "EINVOICE_PROVIDER_UNEXPECTED_RESULT", outcomeUnknown: true });
}

/**
 * Claim po jednom riadku s termínom (Phase 6). `claim(…, 1, …)` označí in-flight
 * iba riadok, ktorý sa hneď spracuje.
 */
async function runClaimLoop(
  options: WorkerOptions,
  claimOne: () => Promise<OutboundRow[]>,
  handle: (row: OutboundRow) => Promise<WorkerItemResult>
): Promise<WorkerReport> {
  const max = Math.max(1, Math.min(10, Math.floor(options.batchSize ?? DEFAULT_BATCH)));
  const results: WorkerItemResult[] = [];
  let claimed = 0;
  for (let i = 0; i < max; i++) {
    if (options.deadlineMs !== undefined && Date.now() + (options.itemBudgetMs ?? 0) > options.deadlineMs) break;
    const rows = await claimOne();
    if (rows.length === 0) break;
    claimed += rows.length;
    for (const row of rows) {
      try {
        results.push(await handle(row));
      } catch (error) {
        // Zápis výsledku zlyhal (napr. STALE) — lease vyprší, send_in_flight ostane
        // → ďalší claim to vyhodnotí ako neistý výsledok a zopakuje TEN ISTÝ kľúč.
        results.push({ outboundId: row.id, from: row.state, to: row.state, code: error instanceof OutboundStoreError ? error.code : errorCode(error) });
      }
    }
  }
  return { claimed, results };
}

/** Jeden beh odosielania. Chyba pri jednom riadku nezastaví ostatné. */
export async function runOutboundSendBatch(deps: WorkerDeps, options: WorkerOptions = {}): Promise<WorkerReport> {
  return runClaimLoop(
    options,
    () => deps.store.claim("send", 1, options.leaseSeconds ?? DEFAULT_LEASE_SECONDS),
    (row) => sendOne(deps, row)
  );
}

/**
 * Reconciliation JEDNÉHO už claimnutého podania (lease drží volajúci). Používa ju
 * aj webhook: udalosť poskytovateľa iba spustí toto overenie — stav sa vždy
 * potvrdí dotazom u poskytovateľa, nikdy sa nepreberá z webhooku.
 */
export async function reconcileOutboundRow(deps: WorkerDeps, row: OutboundRow): Promise<WorkerItemResult> {
  return reconcileOne(deps, row);
}

async function reconcileOne(deps: WorkerDeps, row: OutboundRow): Promise<WorkerItemResult> {
  const now = (deps.now ?? (() => new Date()))();
  const release: TransitionFields = { locked_until: null, status_checked_at: iso(now) };

  // a) Vyčerpané pokusy bez ID poskytovateľa a neistý posledný pokus (pád workera):
  //    nič neodoslať, nič neuzatvárať — operátor / ďalšia reconciliation.
  if (!row.provider_submission_id) {
    const updated = await deps.store.transition(row.id, row.state, null, "reconcile", "EINVOICE_RETRY_EXHAUSTED_UNKNOWN", {
      ...release,
      send_in_flight: false,
      send_outcome_unknown: true,
      next_retry_at: null,
      last_error_code: "EINVOICE_RETRY_EXHAUSTED_UNKNOWN",
    });
    return { outboundId: row.id, from: row.state, to: updated.state, code: "EINVOICE_RETRY_EXHAUSTED_UNKNOWN" };
  }

  const ctx = await contextFor(deps, row);
  if ("error" in ctx) {
    await deps.store.transition(row.id, row.state, null, "reconcile", ctx.error, { ...release, last_error_code: ctx.error });
    return { outboundId: row.id, from: row.state, to: row.state, code: ctx.error };
  }

  let status;
  try {
    status = await deps.provider.getOutboundStatus(ctx, { providerSubmissionId: row.provider_submission_id });
  } catch (error) {
    const code = errorCode(error);
    await deps.store.transition(row.id, row.state, null, "reconcile", code, { ...release, last_error_code: code });
    return { outboundId: row.id, from: row.state, to: row.state, code };
  }

  const target = outboundStateFromProvider(status.state);
  const providerCode = providerStatusCode(status.state);
  const common: TransitionFields = {
    ...release,
    provider_status: providerCode,
    receiver_identifier: status.receiverIdentifier,
    ...(status.documentId ? { document_id: status.documentId } : {}),
  };

  if (target === "failed") {
    const updated = await deps.store.transition(row.id, row.state, "failed", "reconcile", "EINVOICE_PROVIDER_TRANSPORT_ERROR", {
      ...common,
      last_error_code: "EINVOICE_PROVIDER_TRANSPORT_ERROR",
      error_message: status.errorMessage,
    });
    return { outboundId: row.id, from: row.state, to: updated.state, code: "EINVOICE_PROVIDER_TRANSPORT_ERROR" };
  }

  // Dôkaz doručenia (iba allowlist — DeliveryEvidence.record) pri sent / deferred / delivered.
  let evidence = null;
  try {
    evidence = await deps.provider.getDeliveryEvidence(ctx, { providerSubmissionId: row.provider_submission_id });
  } catch (error) {
    if (target === "delivered") {
      const code = errorCode(error);
      await deps.store.transition(row.id, row.state, null, "reconcile", code, { ...release, last_error_code: code });
      return { outboundId: row.id, from: row.state, to: row.state, code };
    }
  }
  if (evidence?.ublSha256 && row.ubl_sha256 && evidence.ublSha256 !== row.ubl_sha256) {
    // Poskytovateľ hlási iný dokument než Esblu uložilo → nič neoznačiť ako doručené.
    await deps.store.transition(row.id, row.state, null, "reconcile", "EINVOICE_EVIDENCE_HASH_MISMATCH", {
      ...release,
      last_error_code: "EINVOICE_EVIDENCE_HASH_MISMATCH",
    });
    return { outboundId: row.id, from: row.state, to: row.state, code: "EINVOICE_EVIDENCE_HASH_MISMATCH" };
  }

  // eFaktura.sk: /peppol/status končí pri SENT (AS4); doručenie príjemcovi (MLS)
  // nesie IBA dôkaz `delivery_status.state = delivered` (docs receiving/evidence).
  // Bez tohto pravidla by sa stav `delivered` v produkcii nikdy nedosiahol.
  // Hash dôkazu (ak je) už bol overený vyššie.
  const deliveredByEvidence = target === "sent" && evidence?.record.delivery_state === "delivered";
  if (target === "delivered" || deliveredByEvidence) {
    if (!evidence) {
      // Stav hovorí doručené, dôkaz ešte nie je — skúsiť pri ďalšej reconciliation.
      const toState = row.state === "sending" ? "sent" : null;
      const updated = await deps.store.transition(row.id, row.state, toState, "reconcile", providerCode, {
        ...common,
        last_error_code: "EINVOICE_EVIDENCE_PENDING",
      });
      return { outboundId: row.id, from: row.state, to: updated.state, code: "EINVOICE_EVIDENCE_PENDING" };
    }
    const updated = await deps.store.transition(row.id, row.state, "delivered", "reconcile", providerCode, {
      ...common,
      evidence: evidence.record,
      document_id: evidence.documentId ?? status.documentId ?? null,
      delivered_at: evidence.deliveredAt ?? iso(now),
      last_error_code: null,
    });
    return { outboundId: row.id, from: row.state, to: updated.state, code: null };
  }

  const toState = target === row.state ? null : target;
  const updated = await deps.store.transition(row.id, row.state, toState, "reconcile", providerCode, {
    ...common,
    ...(evidence ? { evidence: evidence.record } : {}),
    last_error_code: null,
  });
  return { outboundId: row.id, from: row.state, to: updated.state, code: null };
}

/** Jeden beh reconciliation (sending/sent/deferred s ID poskytovateľa staršie než prah). */
export async function runOutboundReconcileBatch(deps: WorkerDeps, options: WorkerOptions = {}): Promise<WorkerReport> {
  return runClaimLoop(
    options,
    () =>
      deps.store.claim(
        "reconcile",
        1,
        options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
        options.reconcileAfterSeconds ?? DEFAULT_RECONCILE_AFTER_SECONDS
      ),
    (row) => reconcileOne(deps, row)
  );
}
