// =============================================================================
// Provider event pipeline — povinné poradie:
//   1. overiť podpis (provider.verifyWebhook)
//   2. deduplikovať + 3. uložiť (esblu_billing_record_event, unique event ID)
//   4. normalizovať (provider.normalizeEvent — Stripe znova načíta stav z API)
//   5. zmeniť kanonický stav + 6. prepočítať nároky (esblu_billing_apply_event,
//      jedna DB transakcia).
// DB klient musí byť service_role (iba server). Firmu ani plán pipeline
// NEURČUJE — robí to DB z vlastných tabuliek.
// =============================================================================

import { sha256Hex } from "@/lib/billing/signature";
import {
  BillingProviderError,
  type BillingEnvironment,
  type BillingProvider,
  type BillingProviderId,
  type NormalizedSubscriptionState,
  type VerifiedProviderEvent,
} from "@/lib/billing/types";

export type BillingDb = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export type PipelineOutcome =
  | "applied"
  | "duplicate"
  | "stale"
  | "conflict"
  | "ignored"
  | "rejected"
  | "failed_permanent"
  | "retry";

export type PipelineResult = { httpStatus: number; outcome: PipelineOutcome; code?: string };

type ApplyResponse = { result?: string; error?: string };

function signatureFailure(error: unknown): PipelineResult | null {
  if (!(error instanceof BillingProviderError)) return null;
  switch (error.code) {
    case "INVALID_SIGNATURE":
    case "STALE_SIGNATURE":
    case "MALFORMED_PAYLOAD":
    case "LIVE_MODE_FORBIDDEN":
    case "TEST_MODE_FORBIDDEN":
      return { httpStatus: 400, outcome: "rejected", code: error.code };
    case "NOT_CONFIGURED":
      return { httpStatus: 503, outcome: "rejected", code: error.code };
    default:
      return null;
  }
}

/** Minimalizovaný súhrn pre audit (žiadne osobné ani platobné údaje). */
export function summarizeState(state: NormalizedSubscriptionState | null, reason?: string): Record<string, unknown> {
  if (!state) return reason ? { reason } : {};
  return {
    ...(reason ? { reason } : {}),
    status: state.status,
    subscription: state.provider_subscription_id,
    price: state.provider_price_id,
    period_end: state.current_period_end,
    cancel_at_period_end: state.cancel_at_period_end,
  };
}

async function recordEvent(db: BillingDb, event: Pick<VerifiedProviderEvent, "provider" | "environment" | "eventId" | "eventType" | "createdAt" | "payloadSha256">) {
  const { data, error } = await db.rpc("esblu_billing_record_event", {
    p_provider: event.provider,
    p_environment: event.environment,
    p_provider_event_id: event.eventId,
    p_event_type: event.eventType,
    p_provider_created_at: event.createdAt,
    p_payload_sha256: event.payloadSha256,
  });
  if (error || !data) throw new Error("RECORD_FAILED");
  return data as { event_id: string; duplicate: boolean; status?: string };
}

async function applyState(db: BillingDb, eventRowId: string, state: NormalizedSubscriptionState): Promise<PipelineResult> {
  const { data, error } = await db.rpc("esblu_billing_apply_event", { p_event_id: eventRowId, p_state: state });
  if (error || !data) return { httpStatus: 500, outcome: "retry", code: "APPLY_FAILED" };
  const result = data as ApplyResponse;
  switch (result.result) {
    case "applied":
      return { httpStatus: 200, outcome: "applied" };
    case "duplicate":
      return { httpStatus: 200, outcome: "duplicate" };
    case "stale":
      return { httpStatus: 200, outcome: "stale", code: result.error };
    case "conflict":
      // Druhé aktívne predplatné — 200 (retry nepomôže), operátor rieši z billing_events.
      return { httpStatus: 200, outcome: "conflict", code: result.error };
    default:
      // Trvalé chyby (UNKNOWN_COMPANY, UNKNOWN_PRICE, PRICE_MISMATCH, CROSS_TENANT_IDENTIFIER):
      // uložené v billing_events, 200 aby provider nezahlcoval retry.
      return { httpStatus: 200, outcome: "failed_permanent", code: result.error ?? "UNKNOWN" };
  }
}

export async function processWebhook(provider: BillingProvider, rawBody: string, headers: Headers, db: BillingDb): Promise<PipelineResult> {
  // 1) podpis
  let event: VerifiedProviderEvent;
  try {
    event = await provider.verifyWebhook(rawBody, headers);
  } catch (error) {
    return signatureFailure(error) ?? { httpStatus: 400, outcome: "rejected", code: "VERIFY_FAILED" };
  }
  return processVerifiedEvent(provider, event, db);
}

/**
 * Kroky 2–7 pre UŽ OVERENÚ udalosť: webhook (po podpise) aj doťahovanie zmeškaných udalostí
 * z API providera (S12, lib/billing/event-catchup.ts) — rovnaká deduplikácia podľa ID udalosti,
 * rovnaká normalizácia (čerstvý stav z API), rovnaká ochrana poradia a terminálnych stavov v DB.
 */
export async function processVerifiedEvent(provider: BillingProvider, event: VerifiedProviderEvent, db: BillingDb): Promise<PipelineResult> {
  // 2+3) dedupe + uloženie
  let recorded: { event_id: string; duplicate: boolean; status?: string };
  try {
    recorded = await recordEvent(db, event);
  } catch {
    return { httpStatus: 500, outcome: "retry", code: "RECORD_FAILED" };
  }
  if (recorded.duplicate) return { httpStatus: 200, outcome: "duplicate", code: recorded.status };

  // 4) normalizácia
  let normalized;
  try {
    normalized = await provider.normalizeEvent(event);
  } catch (error) {
    const permanent = error instanceof BillingProviderError && error.code === "MALFORMED_PAYLOAD";
    await db.rpc("esblu_billing_close_event", {
      p_event_id: recorded.event_id,
      p_status: "failed",
      p_error_code: permanent ? "MALFORMED_PAYLOAD" : "NORMALIZE_FAILED",
      p_summary: {},
    });
    // Technická chyba (API providera nedostupné) → 500, provider zopakuje; record_event
    // pri retry pustí 'failed' event znova.
    return permanent ? { httpStatus: 200, outcome: "failed_permanent", code: "MALFORMED_PAYLOAD" } : { httpStatus: 500, outcome: "retry", code: "NORMALIZE_FAILED" };
  }

  if (normalized.kind === "ignore") {
    await db.rpc("esblu_billing_close_event", {
      p_event_id: recorded.event_id,
      p_status: "ignored",
      p_error_code: null,
      p_summary: { reason: normalized.reason },
    });
    return { httpStatus: 200, outcome: "ignored", code: normalized.reason };
  }

  if (normalized.kind === "charge") {
    // Platba bez zmeny stavu (refund) → iba reporting obchodu.
    const { data, error } = await db.rpc("esblu_billing_apply_charge", {
      p_event_id: recorded.event_id,
      p_provider_subscription_id: normalized.providerSubscriptionId,
      p_charge: normalized.charge,
    });
    if (error || !data) return { httpStatus: 500, outcome: "retry", code: "APPLY_FAILED" };
    const result = (data as ApplyResponse).result;
    return result === "applied" || result === "duplicate"
      ? { httpStatus: 200, outcome: result === "applied" ? "applied" : "duplicate" }
      : { httpStatus: 200, outcome: "failed_permanent", code: (data as ApplyResponse).error };
  }

  // 5+6) kanonický stav + nároky
  const applied = await applyState(db, recorded.event_id, normalized.state);

  // 7) Terminálny stav v Esblu (plná refundácia aktuálneho obdobia, prehraný spor) → ukončiť
  //    predplatné U PROVIDERA, aby firma bez prístupu nebola ďalej účtovaná. Zlyhanie nevracia
  //    retry (event je zapísaný); poistkou je reconciliation (účet refunded/revoked + otvorené
  //    predplatné u providera → okamžité ukončenie).
  if (normalized.followUp === "cancel_provider_now" && (applied.outcome === "applied" || applied.outcome === "stale")) {
    const followUp = await cancelAtProvider(db, provider, normalized.state);
    return { ...applied, code: followUp };
  }
  return applied;
}

/**
 * Auditný záznam akcie u providera BEZ zmeny kanonického stavu (napr. terminálny `refunded`
 * ostáva `refunded`, hoci Stripe po ukončení hlási `canceled`). Idempotentné podľa event ID.
 */
export async function recordProviderAudit(
  db: BillingDb,
  provider: { id: BillingProviderId; environment: BillingEnvironment },
  action: string,
  state: NormalizedSubscriptionState,
  reason: string,
): Promise<void> {
  try {
    const recorded = await recordEvent(db, {
      provider: provider.id,
      environment: provider.environment,
      eventId: `audit:${action}:${state.provider_subscription_id ?? "none"}`.slice(0, 256),
      eventType: `esblu.audit.${action}`,
      createdAt: state.state_at,
      payloadSha256: sha256Hex(JSON.stringify(state)),
    });
    if (recorded.duplicate) return;
    await db.rpc("esblu_billing_close_event", {
      p_event_id: recorded.event_id,
      p_status: "ignored",
      p_error_code: null,
      p_summary: summarizeState(state, reason),
    });
  } catch {
    // audit je best-effort; stav u providera je rozhodujúci a reconciliation ho overí znova
  }
}

/** Okamžité ukončenie predplatného u providera + auditný záznam (stav ostáva terminálny). */
export async function cancelAtProvider(db: BillingDb, provider: BillingProvider, state: NormalizedSubscriptionState): Promise<string> {
  if (!provider.cancelSubscriptionNow || !state.provider_subscription_id) return "PROVIDER_CANCEL_UNSUPPORTED";
  try {
    const ended = await provider.cancelSubscriptionNow({
      providerSubscriptionId: state.provider_subscription_id,
      providerCustomerId: state.provider_customer_id,
    });
    await recordProviderAudit(db, { id: provider.id, environment: provider.environment }, "terminal_cancel", ended, "PROVIDER_CANCELED");
    return "PROVIDER_CANCELED";
  } catch {
    return "PROVIDER_CANCEL_FAILED";
  }
}

/**
 * Stav vrátený priamo z API providera po akcii používateľa (cancel/resume/
 * change) — rovnaká cesta ako webhook (record → apply), syntetické event ID.
 * Neskorší webhook toho istého stavu je duplicitný alebo `stale`.
 */
/** Overený nákup z mobilu (StoreKit / Play) — rovnaká cesta record → apply. */
export async function applyVerifiedStorePurchase(
  db: BillingDb,
  provider: { id: BillingProviderId; environment: BillingEnvironment },
  eventId: string,
  state: NormalizedSubscriptionState,
  payloadSha256: string,
): Promise<PipelineResult> {
  let recorded;
  try {
    recorded = await recordEvent(db, {
      provider: provider.id,
      environment: provider.environment,
      eventId,
      eventType: `esblu.client_purchase.${provider.id}`,
      createdAt: state.state_at,
      payloadSha256,
    });
  } catch {
    return { httpStatus: 500, outcome: "retry", code: "RECORD_FAILED" };
  }
  if (recorded.duplicate) return { httpStatus: 200, outcome: "duplicate", code: recorded.status };
  return applyState(db, recorded.event_id, state);
}

export async function applyProviderState(
  db: BillingDb,
  provider: { id: BillingProviderId; environment: BillingEnvironment },
  action: string,
  state: NormalizedSubscriptionState,
  payloadSha256: string,
): Promise<PipelineResult> {
  const stamp = Date.parse(state.state_at) || Date.now();
  let recorded;
  try {
    recorded = await recordEvent(db, {
      provider: provider.id,
      environment: provider.environment,
      eventId: `sync:${action}:${state.provider_subscription_id ?? "none"}:${stamp}`.slice(0, 256),
      eventType: `esblu.sync.${action}`,
      createdAt: state.state_at,
      payloadSha256,
    });
  } catch {
    return { httpStatus: 500, outcome: "retry", code: "RECORD_FAILED" };
  }
  if (recorded.duplicate) return { httpStatus: 200, outcome: "duplicate" };
  return applyState(db, recorded.event_id, state);
}
