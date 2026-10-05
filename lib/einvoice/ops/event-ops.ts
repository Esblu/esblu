// =============================================================================
// E-Faktúra — prevádzkový súhrn udalostí webhook/feed (esblu_einvoice_event_ops).
// Iba čísla a strojové kódy: žiadny payload, firma, IČO, delivery ID ani tajomstvá.
// =============================================================================

export type EventOpsSummary = {
  failed_retryable: number;
  exhausted_unresolved: number;
  oldest_exhausted_age_seconds: number;
  exhausted_by_event: Record<string, number>;
  stuck_received_15m: number;
  cursors: { provider: string; environment: string; last_event_id: number; last_run_age_seconds: number | null; last_error_code: string | null; locked: boolean }[];
};

export type EventAlert = {
  code: "EVENTS_EXHAUSTED" | "EVENTS_STUCK_RECEIVED" | "EVENT_FEED_STALE" | "EVENT_FEED_ERROR";
  severity: "warning" | "critical";
  value: number;
  threshold: number;
};

const n = (v: unknown) => {
  const x = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : 0;
};
const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

export function sanitizeEventOps(raw: unknown): EventOpsSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const byEvent: Record<string, number> = {};
  for (const [k, v] of Object.entries((r.exhausted_by_event ?? {}) as Record<string, unknown>)) if (CODE.test(k)) byEvent[k] = n(v);
  const cursors = (Array.isArray(r.cursors) ? r.cursors : []).map((c) => {
    const x = (c ?? {}) as Record<string, unknown>;
    return {
      provider: typeof x.provider === "string" && CODE.test(x.provider) ? x.provider : "unknown",
      environment: x.environment === "live" ? "live" : "sandbox",
      last_event_id: n(x.last_event_id),
      last_run_age_seconds: x.last_run_age_seconds === null || x.last_run_age_seconds === undefined ? null : n(x.last_run_age_seconds),
      last_error_code: typeof x.last_error_code === "string" && /^[A-Z0-9_]{1,80}$/.test(x.last_error_code) ? x.last_error_code : null,
      locked: x.locked === true,
    };
  });
  return {
    failed_retryable: n(r.failed_retryable),
    exhausted_unresolved: n(r.exhausted_unresolved),
    oldest_exhausted_age_seconds: n(r.oldest_exhausted_age_seconds),
    exhausted_by_event: byEvent,
    stuck_received_15m: n(r.stuck_received_15m),
    cursors,
  };
}

/** Feed beží (cron) každých ~15 min; viac ako 2 h bez behu = stale. */
export const FEED_STALE_SECONDS = 2 * 3600;

export function evaluateEventAlerts(s: EventOpsSummary): EventAlert[] {
  const out: EventAlert[] = [];
  if (s.exhausted_unresolved > 0) out.push({ code: "EVENTS_EXHAUSTED", severity: "critical", value: s.exhausted_unresolved, threshold: 1 });
  if (s.stuck_received_15m > 0) out.push({ code: "EVENTS_STUCK_RECEIVED", severity: "warning", value: s.stuck_received_15m, threshold: 1 });
  for (const c of s.cursors) {
    if (c.last_run_age_seconds !== null && c.last_run_age_seconds > FEED_STALE_SECONDS) {
      out.push({ code: "EVENT_FEED_STALE", severity: "warning", value: c.last_run_age_seconds, threshold: FEED_STALE_SECONDS });
    }
    if (c.last_error_code) out.push({ code: "EVENT_FEED_ERROR", severity: "warning", value: 1, threshold: 1 });
  }
  return out;
}
