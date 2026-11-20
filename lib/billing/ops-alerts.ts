// =============================================================================
// P4 (2026-11-23) — billing ops alerty: perzistencia (DB, deduplikované) + doručenie.
//
// Zdroj alertov:
//   - signály z webhooku (WEBHOOK_SIGNATURE_FAILURES ≥ 10 / h, WEBHOOK_API_VERSION_MISMATCH) → esblu_billing_ops_raise,
//   - vyhodnotenie stavu DB každých 15 min (esblu_billing_ops_collect): zlyhané / dead-letter udalosti,
//     oneskorenie doťahovania, nezhody a dead-letter reconciliation, zlyhávajúce crony (heartbeat),
//     refundácie bez dobropisu, zlyhávajúci archív PDF.
// Deduplikácia: 1 riadok na (kód, prostredie, časové okno) → najviac 1 notifikácia na okno.
//
// Doručenie (existujúce mechanizmy, bez novej platenej služby):
//   1. vždy: riadok v billing_ops_alerts + HTTP 503 cronu billing-ops-monitor pri otvorenom kritickom
//      alerte (rovnaký vzor ako einvoice-maintenance → Vercel cron monitoring / log drain),
//   2. voliteľne e-mail cez Resend REST API (bez npm balíka), ak sú nastavené IBA tieto premenné:
//      RESEND_API_KEY, ESBLU_OPS_ALERT_EMAIL_TO, ESBLU_OPS_ALERT_EMAIL_FROM. Bez nich sa e-mail neposiela.
// Obsah notifikácie: kód, závažnosť, prostredie, počet výskytov, časy a sanitizované čísla/kódy.
// NIKDY: telo udalosti, ID firiem/zákazníkov/predplatných, e-maily, sumy, podpisy ani tajomstvá.
// =============================================================================

import type { BillingDb, OpsSignalCode, OpsSignalSink } from "@/lib/billing/pipeline";
import type { BillingEnvironment } from "@/lib/billing/types";

export type OpsSeverity = "warning" | "critical";

/** Parametre signálov z webhooku: prah v okne (minúty) a závažnosť. */
export const OPS_SIGNAL_RULES: Record<OpsSignalCode, { severity: OpsSeverity; bucketMinutes: number; threshold: number }> = {
  WEBHOOK_SIGNATURE_FAILURES: { severity: "warning", bucketMinutes: 60, threshold: 10 },
  WEBHOOK_API_VERSION_MISMATCH: { severity: "warning", bucketMinutes: 1440, threshold: 1 },
};

export function dbOpsSignals(db: BillingDb, environment: BillingEnvironment): OpsSignalSink {
  return {
    async signal(code) {
      const rule = OPS_SIGNAL_RULES[code];
      await db.rpc("esblu_billing_ops_raise", {
        p_environment: environment,
        p_code: code,
        p_severity: rule.severity,
        p_bucket_minutes: rule.bucketMinutes,
        p_threshold: rule.threshold,
        p_details: {},
      });
    },
  };
}

export type OpsJob = "stripe_events" | "reconcile" | "documents" | "ops_monitor";

/** Heartbeat cronu (best-effort; chyba DB sa prejaví ako chýbajúci úspech → alert). */
export async function recordHeartbeat(db: BillingDb, job: OpsJob, environment: BillingEnvironment, ok: boolean, errorCode?: string | null): Promise<void> {
  try {
    await db.rpc("esblu_billing_ops_heartbeat", {
      p_job: job,
      p_environment: environment,
      p_ok: ok,
      p_error_code: errorCode && /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : ok ? null : "CRON_FAILED",
    });
  } catch {
    // monitoring nesmie zhodiť cron
  }
}

export type PendingAlert = {
  id: string;
  environment: BillingEnvironment;
  code: string;
  severity: OpsSeverity;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  details: Record<string, unknown>;
};

/** Iba kódy a čísla — obrana do hĺbky (DB detail už sanitizuje). */
export function safeDetails(details: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) return out;
  for (const [key, value] of Object.entries(details as Record<string, unknown>).slice(0, 12)) {
    if (!/^[a-z_]{1,40}$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && /^[A-Z0-9_]{0,60}$/.test(value)) out[key] = value;
  }
  return out;
}

const RUNBOOK = "docs/billing-live-rollout-2026-11-19.md (§ Monitoring a alerty)";

/** Text notifikácie — bez PII a tajomstiev (testované). */
export function formatAlertEmail(alert: PendingAlert): { subject: string; text: string } {
  const code = /^[A-Z0-9_]{1,60}$/.test(alert.code) ? alert.code : "UNKNOWN";
  const env = alert.environment === "live" ? "live" : "test";
  const severity = alert.severity === "critical" ? "CRITICAL" : "WARNING";
  const details = Object.entries(safeDetails(alert.details)).map(([k, v]) => `  ${k}: ${String(v)}`);
  const iso = (v: string) => (Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : "-");
  return {
    subject: `[Esblu billing][${env}] ${severity}: ${code}`,
    text: [
      `Kód: ${code}`,
      `Závažnosť: ${severity}`,
      `Prostredie: ${env}`,
      `Výskyty v okne: ${Number.isFinite(alert.occurrences) ? alert.occurrences : 0}`,
      `Prvý výskyt: ${iso(alert.first_seen_at)}`,
      `Posledný výskyt: ${iso(alert.last_seen_at)}`,
      ...(details.length ? ["Detail:", ...details] : []),
      "",
      `Postup: ${RUNBOOK}. Detail v DB: public.billing_ops_alerts (service_role / SQL editor).`,
    ].join("\n"),
  };
}

export type AlertMailer = { send(message: { subject: string; text: string }): Promise<"sent" | "failed"> };

/** Resend REST API (https://api.resend.com/emails) — iba ak sú nastavené všetky tri premenné. */
export function resendMailerFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): AlertMailer | null {
  const key = (env.RESEND_API_KEY ?? "").trim();
  const to = (env.ESBLU_OPS_ALERT_EMAIL_TO ?? "").trim();
  const from = (env.ESBLU_OPS_ALERT_EMAIL_FROM ?? "").trim();
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(key) || !/^[^@\s,]+@[^@\s,]+\.[a-z]{2,}$/i.test(to) || !from) return null;
  return {
    async send(message) {
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject: message.subject, text: message.text }),
          cache: "no-store",
        });
        return response.ok ? "sent" : "failed";
      } catch {
        return "failed";
      }
    },
  };
}

export type OpsMonitorResult = {
  raised: string[];
  resolved: number;
  notified: number;
  notifyFailed: number;
  channel: "email" | "none";
  open: { critical: number; warning: number; codes: string[] };
};

/** PostgREST / Postgres: RPC funkcia neexistuje (migrácia ešte nie je nasadená). */
function isMissingFunction(error: { message?: string; code?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? "");
}

/** Jeden beh monitoru: vyhodnotiť stav DB, doručiť nové otvorené alerty, vrátiť súhrn (iba kódy a počty). */
export async function runOpsMonitor(db: BillingDb, environment: BillingEnvironment, mailer: AlertMailer | null): Promise<OpsMonitorResult> {
  const collected = await db.rpc("esblu_billing_ops_collect", { p_environment: environment });
  if (collected.error) throw new Error("OPS_COLLECT_FAILED");
  const c = (collected.data ?? {}) as { raised?: unknown; resolved?: unknown };
  const out: OpsMonitorResult = {
    raised: Array.isArray(c.raised) ? c.raised.filter((x): x is string => typeof x === "string") : [],
    resolved: typeof c.resolved === "number" ? c.resolved : 0,
    notified: 0,
    notifyFailed: 0,
    channel: mailer ? "email" : "none",
    open: { critical: 0, warning: 0, codes: [] },
  };
  // S17-4: účtovná kópia bez firmy aj bez snapshotu odberateľa (> 60 min) → DOCUMENT_WITHOUT_COMPANY.
  // Funkcia z migrácie 20261124100000; pred jej nasadením chýba → monitor beží ďalej bez tejto kontroly.
  const docs = await db.rpc("esblu_billing_ops_collect_documents", { p_environment: environment });
  if (docs.error) {
    if (!isMissingFunction(docs.error)) throw new Error("OPS_COLLECT_FAILED");
  } else {
    const d = (docs.data ?? {}) as { raised?: unknown; resolved?: unknown };
    if (Array.isArray(d.raised)) out.raised.push(...d.raised.filter((x): x is string => typeof x === "string"));
    if (typeof d.resolved === "number") out.resolved += d.resolved;
  }
  if (mailer) {
    const pending = await db.rpc("esblu_billing_ops_pending", { p_environment: environment, p_limit: 20 });
    const alerts = (Array.isArray(pending.data) ? pending.data : []) as PendingAlert[];
    for (const alert of alerts) {
      const result = await mailer.send(formatAlertEmail(alert));
      await db.rpc("esblu_billing_ops_mark_notified", {
        p_id: alert.id,
        p_ok: result === "sent",
        p_channel: "email",
        p_error_code: result === "sent" ? null : "EMAIL_SEND_FAILED",
      });
      if (result === "sent") out.notified++;
      else out.notifyFailed++;
    }
  }
  const summary = await db.rpc("esblu_billing_ops_open_summary", { p_environment: environment });
  const s = (summary.data ?? {}) as { critical?: unknown; warning?: unknown; codes?: unknown };
  out.open = {
    critical: Number(s.critical ?? 0) || 0,
    warning: Number(s.warning ?? 0) || 0,
    codes: Array.isArray(s.codes) ? s.codes.filter((x): x is string => typeof x === "string" && /^[A-Z0-9_]{1,60}$/.test(x)) : [],
  };
  return out;
}
