import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { OpsAlertStore } from "./alert-sink.ts";

// E-Faktúra — perzistencia prevádzkových alertov (service_role, RPC z 20261122120000). SERVER-ONLY.
export function createSupabaseOpsAlertStore(admin: SupabaseClient = getSupabaseAdmin()): OpsAlertStore {
  return {
    async raise(i) {
      const { data, error } = await admin.rpc("esblu_einvoice_ops_alert_raise", {
        p_code: i.code,
        p_severity: i.severity,
        p_provider: i.provider,
        p_environment: i.environment,
        p_company_id: i.companyId ?? null,
        p_detail_code: i.detailCode ?? null,
      });
      if (error) throw new Error("ESBLU_EINVOICE_OPS_ALERT_FAILED");
      const r = (Array.isArray(data) ? data[0] : data) as { alert_id: string; created: boolean; notify: boolean; occurrences: number };
      return { alertId: r.alert_id, created: r.created === true, notify: r.notify === true, occurrences: Number(r.occurrences ?? 1) };
    },
    async resolve(code, environment, companyId, resolvedBy) {
      const { data, error } = await admin.rpc("esblu_einvoice_ops_alert_resolve", {
        p_code: code,
        p_environment: environment,
        p_company_id: companyId,
        p_resolved_by: resolvedBy,
      });
      if (error) throw new Error("ESBLU_EINVOICE_OPS_ALERT_FAILED");
      return Number(data ?? 0);
    },
    async openSummary() {
      const { data, error } = await admin.rpc("esblu_einvoice_ops_alerts_open", {});
      if (error) throw new Error("ESBLU_EINVOICE_OPS_ALERT_FAILED");
      const r = (data ?? {}) as { critical?: number; warning?: number; codes?: unknown };
      return {
        critical: Number(r.critical ?? 0),
        warning: Number(r.warning ?? 0),
        codes: Array.isArray(r.codes) ? r.codes.filter((c): c is string => typeof c === "string" && /^[A-Z0-9_]{1,80}$/.test(c)) : [],
      };
    },
  };
}
