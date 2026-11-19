import "server-only";

import { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts, sanitizeHealth, type AlertCandidate, type EinvoiceHealth } from "./alerts.ts";
import type { OpsStore } from "./store.ts";
import { evaluateEventAlerts, sanitizeEventOps, type EventAlert, type EventOpsSummary } from "./event-ops.ts";
import type { OpsAlertSink, OpsAlertStore } from "./alert-sink.ts";

// =============================================================================
// E-Faktúra — interná údržba: health, alert kandidáti, retencia, konzistencia
// storage. SERVER-ONLY. Výstup obsahuje iba čísla a strojové kódy.
// =============================================================================

export const WEBHOOK_RETENTION_DAYS = 90;
export const RETENTION_BATCH = 1000;
export const STUCK_MINUTES = 60;
export const ACK_PENDING_MINUTES = 60;

export type MaintenanceReport = {
  health: EinvoiceHealth;
  alerts: AlertCandidate[];
  retention: { older_than_days: number; webhook_events_deleted: number; rejection_buckets_deleted: number } | null;
  storage: Record<string, number>;
  /** 20261007100000: udalosti webhook/feed (null = store bez podpory). */
  events: EventOpsSummary | null;
  eventAlerts: EventAlert[];
  /** 20261122120000: otvorené perzistentné alerty (kredit, kľúč, deregistrácia…). null = bez store. */
  opsAlerts?: { critical: number; warning: number; codes: string[] } | null;
};

function onlyNumbers(raw: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : 0]));
}

export async function runEinvoiceMaintenance(
  ops: OpsStore,
  options: { retention: boolean },
  persistent: { store: OpsAlertStore; sink: OpsAlertSink; environment: "sandbox" | "live" | null } | null = null
): Promise<MaintenanceReport> {
  const health = sanitizeHealth(await ops.health(STUCK_MINUTES, ACK_PENDING_MINUTES), await ops.outcomes24h());
  const alerts = evaluateAlerts(health, DEFAULT_ALERT_THRESHOLDS);
  const retention = options.retention ? await ops.retention(WEBHOOK_RETENTION_DAYS, RETENTION_BATCH) : null;
  const storage = onlyNumbers(await ops.storageConsistency());
  const events = ops.eventOps ? sanitizeEventOps(await ops.eventOps()) : null;
  const eventAlerts = events ? evaluateEventAlerts(events) : [];
  let opsAlerts: MaintenanceReport["opsAlerts"] = null;
  if (persistent) {
    // Kritické health kandidáty → jeden deduplikovaný alert (notifikácia iba pri vzniku / po 6 h).
    const critical = [...alerts, ...eventAlerts].filter((a) => a.severity === "critical");
    if (critical.length > 0) {
      await persistent.sink.raise({ code: "MAINTENANCE_CRITICAL", severity: "critical", provider: null, environment: persistent.environment, detailCode: critical[0].code });
    } else {
      await persistent.sink.resolve("MAINTENANCE_CRITICAL", persistent.environment);
    }
    try {
      opsAlerts = await persistent.store.openSummary();
    } catch {
      opsAlerts = null;
    }
  }
  return { health, alerts, retention, storage, events, eventAlerts, opsAlerts };
}

/**
 * HTTP stav behu údržby pre monitoring (pre-production audit 10/2026): pri kritickom alerte 503, inak 200.
 * Vercel Cron / log monitoring tak vidí zlyhanie behu bez logovania obsahu (telo = iba kódy a čísla).
 */
export function maintenanceHttpStatus(report: Pick<MaintenanceReport, "alerts" | "eventAlerts" | "opsAlerts">): 200 | 503 {
  if ((report.opsAlerts?.critical ?? 0) > 0) return 503;
  return [...report.alerts, ...report.eventAlerts].some((a) => a.severity === "critical") ? 503 : 200;
}
