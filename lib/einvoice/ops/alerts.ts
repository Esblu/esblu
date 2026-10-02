// =============================================================================
// E-Faktúra — neutrálna detekcia alert kandidátov (bez externého providera).
//
// Vstup: agregované počty z esblu_einvoice_health (žiadne firmy, IČO, čísla
// dokladov, XML ani identifikátory). Výstup: strojovo čitateľné kandidáty —
// napojenie na alerting službu je samostatný krok (Phase 6).
// =============================================================================

export type EinvoiceHealth = {
  generated_at: string;
  outbound: {
    queued: number;
    sending: number;
    sent: number;
    deferred: number;
    delivered: number;
    rejected: number;
    failed: number;
    retryable: number;
    reconciliation_required: number;
    retry_exhausted_unknown: number;
    unknown_send_outcome: number;
    stuck: number;
    oldest_stuck_age_seconds: number;
  };
  inbound: {
    received: number;
    stored: number;
    parsed: number;
    draft_created: number;
    duplicate: number;
    ack_pending: number;
    acknowledged: number;
    failed: number;
    ack_pending_too_long: number;
    stuck: number;
    oldest_stuck_age_seconds: number;
  };
  webhook: {
    failures_24h: number;
    rejected_24h: number;
    unprocessed_older_15m: number;
    signature_failures_1h: number;
    replays_1h: number;
  };
};

export type AlertSeverity = "warning" | "critical";

export type AlertCandidate = {
  code:
    | "OUTBOUND_STUCK"
    | "OUTBOUND_RETRY_EXHAUSTED_UNKNOWN"
    | "OUTBOUND_UNKNOWN_SEND_OUTCOME"
    | "OUTBOUND_PERMANENT_FAILURES"
    | "INBOUND_STUCK"
    | "INBOUND_ACK_PENDING_TOO_LONG"
    | "INBOUND_FAILED"
    | "WEBHOOK_SIGNATURE_FAILURES"
    | "WEBHOOK_REPLAYS"
    | "WEBHOOK_PROCESSING_FAILURES";
  severity: AlertSeverity;
  value: number;
  threshold: number;
};

export type AlertThresholds = {
  signatureFailuresPerHour: number;
  replaysPerHour: number;
  webhookFailures24h: number;
};

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  signatureFailuresPerHour: 10,
  replaysPerHour: 5,
  webhookFailures24h: 5,
};

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
}

/** Iba čísla — čokoľvek iné z health odpovede sa zahodí. */
export function sanitizeHealth(raw: unknown): EinvoiceHealth {
  const r = (raw ?? {}) as Record<string, Record<string, unknown>>;
  const pick = <K extends string>(group: Record<string, unknown> | undefined, keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, num(group?.[k])])) as Record<K, number>;
  return {
    generated_at: typeof (raw as Record<string, unknown>)?.generated_at === "string" ? ((raw as Record<string, unknown>).generated_at as string) : new Date(0).toISOString(),
    outbound: pick(r.outbound, ["queued", "sending", "sent", "deferred", "delivered", "rejected", "failed", "retryable", "reconciliation_required", "retry_exhausted_unknown", "unknown_send_outcome", "stuck", "oldest_stuck_age_seconds"] as const),
    inbound: pick(r.inbound, ["received", "stored", "parsed", "draft_created", "duplicate", "ack_pending", "acknowledged", "failed", "ack_pending_too_long", "stuck", "oldest_stuck_age_seconds"] as const),
    webhook: pick(r.webhook, ["failures_24h", "rejected_24h", "unprocessed_older_15m", "signature_failures_1h", "replays_1h"] as const),
  };
}

export function evaluateAlerts(health: EinvoiceHealth, thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const add = (code: AlertCandidate["code"], severity: AlertSeverity, value: number, threshold: number) => {
    if (value >= threshold && value > 0) out.push({ code, severity, value, threshold });
  };
  add("OUTBOUND_RETRY_EXHAUSTED_UNKNOWN", "critical", health.outbound.retry_exhausted_unknown, 1);
  add("OUTBOUND_UNKNOWN_SEND_OUTCOME", "warning", health.outbound.unknown_send_outcome, 1);
  add("OUTBOUND_STUCK", "warning", health.outbound.stuck, 1);
  add("OUTBOUND_PERMANENT_FAILURES", "warning", health.outbound.failed + health.outbound.rejected, 1);
  add("INBOUND_ACK_PENDING_TOO_LONG", "critical", health.inbound.ack_pending_too_long, 1);
  add("INBOUND_STUCK", "warning", health.inbound.stuck, 1);
  add("INBOUND_FAILED", "warning", health.inbound.failed, 1);
  add("WEBHOOK_SIGNATURE_FAILURES", "critical", health.webhook.signature_failures_1h, thresholds.signatureFailuresPerHour);
  add("WEBHOOK_REPLAYS", "warning", health.webhook.replays_1h, thresholds.replaysPerHour);
  add("WEBHOOK_PROCESSING_FAILURES", "warning", health.webhook.failures_24h + health.webhook.unprocessed_older_15m, thresholds.webhookFailures24h);
  return out;
}
