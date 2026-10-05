import "server-only";

import { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts, sanitizeHealth, type AlertCandidate, type EinvoiceHealth } from "./alerts.ts";
import type { OpsStore } from "./store.ts";
import { evaluateEventAlerts, sanitizeEventOps, type EventAlert, type EventOpsSummary } from "./event-ops.ts";

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
};

function onlyNumbers(raw: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : 0]));
}

export async function runEinvoiceMaintenance(ops: OpsStore, options: { retention: boolean }): Promise<MaintenanceReport> {
  const health = sanitizeHealth(await ops.health(STUCK_MINUTES, ACK_PENDING_MINUTES), await ops.outcomes24h());
  const alerts = evaluateAlerts(health, DEFAULT_ALERT_THRESHOLDS);
  const retention = options.retention ? await ops.retention(WEBHOOK_RETENTION_DAYS, RETENTION_BATCH) : null;
  const storage = onlyNumbers(await ops.storageConsistency());
  const events = ops.eventOps ? sanitizeEventOps(await ops.eventOps()) : null;
  const eventAlerts = events ? evaluateEventAlerts(events) : [];
  return { health, alerts, retention, storage, events, eventAlerts };
}
