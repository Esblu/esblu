// =============================================================================
// E-Faktúra — prevádzkové alerty: perzistencia s deduplikáciou (einvoice_ops_alerts,
// 20261122120000) + notifikácia. Bez I/O závislostí (store a notifier sa injektujú).
//
// Notifikácia: Esblu nemá e-mailový ani operátorský notifikačný kanál (push je iba pre
// používateľov firiem). Preto: (1) záznam v DB (dedupe, počítadlo, renotifikácia po 6 h),
// (2) notifier — produkčne lib/ops-alert-log.ts: jeden štruktúrovaný riadok v serverovom logu
// `[einvoice-ops-alert]` iba pri novom alerte / renotifikácii (vhodné pre log alert / drain;
// zámerne mimo lib/einvoice, ktorý nikdy nelogovuje), (3) otvorené kritické alerty
// prepnú /api/cron/einvoice-maintenance na 503 (monitoring cronu). Žiadna nová platená služba.
// Obsah: IBA strojové kódy a prostredie — nikdy firma, IČO, doklad, telo webhooku.
// Alert nikdy nesmie zhodiť volajúci tok (všetko best effort).
// =============================================================================

import type { EinvoiceEnvironment } from "../provider/types.ts";

export type OpsAlertCode =
  | "PROVIDER_INSUFFICIENT_CREDIT"
  | "PROVIDER_USAGE_LIMIT_EXCEEDED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_CONFIG_INVALID"
  | "DEREGISTRATION_FAILED"
  | "MAINTENANCE_CRITICAL";

export type OpsAlertSeverity = "warning" | "critical";

export type OpsAlertInput = {
  code: OpsAlertCode;
  severity: OpsAlertSeverity;
  provider: string | null;
  environment: EinvoiceEnvironment | null;
  companyId?: string | null;
  detailCode?: string | null;
};

export type OpsAlertRaiseResult = { alertId: string; created: boolean; notify: boolean; occurrences: number };

export interface OpsAlertStore {
  raise(input: OpsAlertInput): Promise<OpsAlertRaiseResult>;
  resolve(code: OpsAlertCode, environment: EinvoiceEnvironment | null, companyId: string | null, resolvedBy: string): Promise<number>;
  openSummary(): Promise<{ critical: number; warning: number; codes: string[] }>;
}

export type OpsAlertNotification = OpsAlertInput & { occurrences: number; created: boolean };
export type OpsAlertNotifier = (n: OpsAlertNotification) => void | Promise<void>;

/** Sink pre workery / webhook — nikdy nehádže. */
export interface OpsAlertSink {
  raise(input: OpsAlertInput): Promise<void>;
  resolve(code: OpsAlertCode, environment: EinvoiceEnvironment | null, companyId?: string | null): Promise<void>;
}

export function createOpsAlertSink(store: OpsAlertStore | null, notify: OpsAlertNotifier): OpsAlertSink {
  return {
    async raise(input) {
      let result: OpsAlertRaiseResult | null = null;
      try {
        result = store ? await store.raise(input) : null;
      } catch {
        result = null;
      }
      // Bez DB záznamu (výpadok / rollback tabuľky) sa notifikuje vždy — radšej duplicita než ticho.
      if (!result || result.notify) {
        try {
          await notify({ ...input, occurrences: result?.occurrences ?? 1, created: result?.created ?? true });
        } catch {
          // notifikácia je best effort
        }
      }
    },
    async resolve(code, environment, companyId = null) {
      try {
        await store?.resolve(code, environment, companyId, "system:auto");
      } catch {
        // best effort
      }
    },
  };
}

/** Chyba poskytovateľa → alert (alebo null). */
export function alertForProviderError(errorCode: string | null | undefined): { code: OpsAlertCode; severity: OpsAlertSeverity } | null {
  switch (errorCode) {
    case "EINVOICE_PROVIDER_INSUFFICIENT_CREDIT":
      return { code: "PROVIDER_INSUFFICIENT_CREDIT", severity: "critical" };
    case "EINVOICE_PROVIDER_UNAUTHORIZED":
    case "EINVOICE_PROVIDER_FORBIDDEN":
      return { code: "PROVIDER_AUTH_FAILED", severity: "critical" };
    case "EINVOICE_KEY_ENVIRONMENT_MISMATCH":
    case "EINVOICE_ENVIRONMENT_MISMATCH":
    case "EINVOICE_BASE_URL_NOT_ALLOWED":
      return { code: "PROVIDER_CONFIG_INVALID", severity: "critical" };
    default:
      return null;
  }
}
