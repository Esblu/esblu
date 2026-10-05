import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { dbErrorCode } from "../outbound/store.ts";
import { OpsStoreError, type OperatorBeginResult, type OpsStore } from "./store.ts";

// =============================================================================
// E-Faktúra — PRODUKČNÁ operátorská / prevádzková vrstva. SERVER-ONLY.
// service_role iba na serverové RPC: esblu_einvoice_operator_begin,
// _health, _webhook_retention, _storage_consistency, _webhook_rejection_record.
// =============================================================================

export function createSupabaseOpsStore(admin: SupabaseClient = getSupabaseAdmin()): OpsStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new OpsStoreError(dbErrorCode(error.message));
    return data as T;
  };
  return {
    async operatorBegin(i) {
      return rpc<OperatorBeginResult>("esblu_einvoice_operator_begin", {
        p_actor_user_id: i.actorUserId,
        p_kind: i.kind,
        p_id: i.id,
        p_action: i.action,
        p_reason_code: i.reasonCode,
        p_lease_seconds: i.leaseSeconds,
        p_cooldown_seconds: i.cooldownSeconds,
      });
    },
    async outcomes24h() {
      return rpc<unknown>("esblu_einvoice_outcomes_24h", {});
    },
    async eventOps() {
      return rpc<unknown>("esblu_einvoice_event_ops", {});
    },
    async health(stuckMinutes, ackPendingMinutes) {
      return rpc<unknown>("esblu_einvoice_health", { p_stuck_minutes: stuckMinutes, p_ack_pending_minutes: ackPendingMinutes });
    },
    async retention(days, limit) {
      return rpc("esblu_einvoice_webhook_retention", { p_older_than_days: days, p_limit: limit });
    },
    async storageConsistency() {
      return rpc<Record<string, number>>("esblu_einvoice_storage_consistency", {});
    },
    async recordWebhookRejection(provider, environment, reason) {
      await rpc("esblu_einvoice_webhook_rejection_record", { p_provider: provider, p_environment: environment, p_reason: reason });
    },
  };
}
