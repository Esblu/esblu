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
    /** Phase 6: výsledky za posledných 24 h (esblu_einvoice_outcomes_24h). */
    sent_24h: number;
    delivered_24h: number;
    rejected_24h: number;
    failed_24h: number;
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
    /** P1-4 (migrácia 20261125100000; bez nej 0). */
    quarantined: number;
    quarantined_unacked: number;
    recipient_mismatch: number;
    ack_pending_too_long: number;
    stuck: number;
    oldest_stuck_age_seconds: number;
    /** P1-4 stav skenu zoznamu (migrácia 20261125100000; bez nej 0). */
    scan_overdue: number;
    scan_incomplete: number;
    /** P1-4: zamietnuté požiadavky príjmu zdieľaným limiterom za poslednú hodinu. */
    rate_limited_1h: number;
  };
  /** 20261126100000: spoločný limit partnerského kľúča (bez migrácie 0). */
  provider: {
    rate_denied_1h: number;
    rate_denied_outbound_1h: number;
    rate_denied_interactive_1h: number;
    cooldown_active: number;
    provider_429_24h: number;
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
    | "OUTBOUND_REJECT_RATE_HIGH"
    | "INBOUND_STUCK"
    | "INBOUND_ACK_PENDING_TOO_LONG"
    | "INBOUND_FAILED"
    | "INBOUND_RECIPIENT_MISMATCH"
    | "INBOUND_QUARANTINED"
    | "INBOUND_SCAN_OVERDUE"
    | "INBOUND_SCAN_INCOMPLETE"
    | "INBOUND_BACKLOG_AGING"
    | "INBOUND_RATE_LIMITED"
    | "PROVIDER_RATE_COOLDOWN"
    | "PROVIDER_429_REPEATED"
    | "OUTBOUND_RATE_LIMITED"
    | "WEBHOOK_SIGNATURE_FAILURES"
    | "WEBHOOK_REPLAYS"
    | "WEBHOOK_PROCESSING_FAILURES";
  severity: AlertSeverity;
  value: number;
  threshold: number;
};

export type AlertThresholds = {
  /** Phase 6: min. počet odmietnutí/zlyhaní za 24 h a ich podiel, od ktorého je to „neobvykle vysoké". */
  rejectRateMinCount: number;
  rejectRateRatio: number;
  signatureFailuresPerHour: number;
  replaysPerHour: number;
  webhookFailures24h: number;
  /** P1-4: najstarší nespracovaný prijatý doklad (s) — backlog sa dlhodobo neznižuje. */
  inboundBacklogAgeSeconds: number;
  /** P1-4: zamietnutia limiterom za hodinu, od ktorých je to varovanie (krátke špičky sú normálne). */
  inboundRateLimited1h: number;
};

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  rejectRateMinCount: 3,
  rejectRateRatio: 0.2,
  signatureFailuresPerHour: 10,
  replaysPerHour: 5,
  webhookFailures24h: 5,
  inboundBacklogAgeSeconds: 7200,
  inboundRateLimited1h: 20,
};

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
}

/** Iba čísla — čokoľvek iné z health odpovede sa zahodí. `outcomes` = esblu_einvoice_outcomes_24h. */
export function sanitizeHealth(raw: unknown, outcomes: unknown = null): EinvoiceHealth {
  const r = (raw ?? {}) as Record<string, Record<string, unknown>>;
  const pick = <K extends string>(group: Record<string, unknown> | undefined, keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, num(group?.[k])])) as Record<K, number>;
  return {
    generated_at: typeof (raw as Record<string, unknown>)?.generated_at === "string" ? ((raw as Record<string, unknown>).generated_at as string) : new Date(0).toISOString(),
    outbound: {
      ...pick(r.outbound, ["queued", "sending", "sent", "deferred", "delivered", "rejected", "failed", "retryable", "reconciliation_required", "retry_exhausted_unknown", "unknown_send_outcome", "stuck", "oldest_stuck_age_seconds"] as const),
      ...pick((outcomes ?? {}) as Record<string, unknown>, ["sent_24h", "delivered_24h", "rejected_24h", "failed_24h"] as const),
    },
    inbound: pick(r.inbound, ["received", "stored", "parsed", "draft_created", "duplicate", "ack_pending", "acknowledged", "failed", "quarantined", "quarantined_unacked", "recipient_mismatch", "ack_pending_too_long", "stuck", "oldest_stuck_age_seconds", "scan_overdue", "scan_incomplete", "rate_limited_1h"] as const),
    provider: pick(r.provider, ["rate_denied_1h", "rate_denied_outbound_1h", "rate_denied_interactive_1h", "cooldown_active", "provider_429_24h"] as const),
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
  // Phase 6: iba posledných 24 h (kumulatívny počet by alertoval navždy po prvom odmietnutí).
  const bad24h = health.outbound.failed_24h + health.outbound.rejected_24h;
  add("OUTBOUND_PERMANENT_FAILURES", "warning", bad24h, 1);
  const total24h = bad24h + health.outbound.sent_24h + health.outbound.delivered_24h;
  if (bad24h >= thresholds.rejectRateMinCount && total24h > 0 && bad24h / total24h >= thresholds.rejectRateRatio) {
    out.push({ code: "OUTBOUND_REJECT_RATE_HIGH", severity: "critical", value: bad24h, threshold: thresholds.rejectRateMinCount });
  }
  add("INBOUND_ACK_PENDING_TOO_LONG", "critical", health.inbound.ack_pending_too_long, 1);
  add("INBOUND_STUCK", "warning", health.inbound.stuck, 1);
  add("INBOUND_FAILED", "warning", health.inbound.failed, 1);
  // R3: doklad adresovaný inému účastníkovi v schránke organizácie = prevádzkový incident (postup v runbooku).
  add("INBOUND_RECIPIENT_MISMATCH", "critical", health.inbound.recipient_mismatch, 1);
  add("INBOUND_QUARANTINED", "warning", health.inbound.quarantined_unacked, 1);
  // P1-4: sken zoznamu — organizácia s aktívnym príjmom bez úplného skenu > 2 h (strop stránok / rozpočet / posun)
  add("INBOUND_SCAN_OVERDUE", "critical", health.inbound.scan_overdue, 1);
  add("INBOUND_SCAN_INCOMPLETE", "warning", health.inbound.scan_incomplete, 1);
  // P1-4: nespracované doklady sa dlhodobo neznižujú (najstarší čaká ≥ 2 h)
  add("INBOUND_BACKLOG_AGING", "critical", health.inbound.oldest_stuck_age_seconds, thresholds.inboundBacklogAgeSeconds);
  add("INBOUND_RATE_LIMITED", "warning", health.inbound.rate_limited_1h, thresholds.inboundRateLimited1h);
  // 20261126100000: poskytovateľ vrátil 429 → všetky triedy čakajú; opakované 429 = kvóty sú nad skutočným limitom
  add("PROVIDER_RATE_COOLDOWN", "warning", health.provider.cooldown_active, 1);
  add("PROVIDER_429_REPEATED", "critical", health.provider.provider_429_24h, 5);
  // odosielanie zamietnuté vlastným limitom (rezerva nestačí) — oneskorenie odoslania faktúr
  add("OUTBOUND_RATE_LIMITED", "warning", health.provider.rate_denied_outbound_1h, 5);
  add("WEBHOOK_SIGNATURE_FAILURES", "critical", health.webhook.signature_failures_1h, thresholds.signatureFailuresPerHour);
  add("WEBHOOK_REPLAYS", "warning", health.webhook.replays_1h, thresholds.replaysPerHour);
  add("WEBHOOK_PROCESSING_FAILURES", "warning", health.webhook.failures_24h + health.webhook.unprocessed_older_15m, thresholds.webhookFailures24h);
  return out;
}
