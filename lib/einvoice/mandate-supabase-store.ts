import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { MandateStoreError, type MandateStore } from "./mandate.ts";

// =============================================================================
// E-Faktúra mandát — PRODUKČNÁ privilegovaná vrstva (service_role). SERVER-ONLY.
// Iba RPC z 20261122100000 (grant / confirm / revoke); aktér a firma sa v RPC
// overia znova (finance.manage pre danú firmu).
// =============================================================================

function dbCode(message: string | undefined): string {
  const m = /ESBLU_[A-Z0-9_]+|NOT_AUTHENTICATED/.exec(message ?? "");
  return m ? m[0] : "DB_ERROR";
}

export function createSupabaseMandateStore(admin: SupabaseClient = getSupabaseAdmin()): MandateStore {
  return {
    async grant(i) {
      const { data, error } = await admin.rpc("esblu_einvoice_mandate_grant", {
        p_actor_user_id: i.actorUserId,
        p_company_id: i.companyId,
        p_environment: i.environment,
        p_scope: i.scope,
        p_statement_version: i.statement.version,
        p_statement_sha256: i.statement.sha256,
        p_statement_locale: i.statement.locale,
        p_authority_confirmed: true,
        p_grant_channel: i.channel,
        p_request_id: i.evidence.requestId,
        p_ip_sha256: i.evidence.ipSha256,
        p_user_agent_sha256: i.evidence.userAgentSha256,
      });
      if (error || typeof data !== "string") throw new MandateStoreError(dbCode(error?.message));
      return data;
    },
    async confirm(i) {
      const { error } = await admin.rpc("esblu_einvoice_mandate_confirm", {
        p_mandate_id: i.mandateId,
        p_effective_scope: i.scope,
        p_provider_outcome: i.providerOutcome,
        p_provider_response_sha256: i.providerResponseSha256,
        p_participant_id: i.participantId,
      });
      if (error) throw new MandateStoreError(dbCode(error.message));
    },
    async revoke(i) {
      const { data, error } = await admin.rpc("esblu_einvoice_mandate_revoke", {
        p_company_id: i.companyId,
        p_environment: i.environment,
        p_kind: i.kind,
        p_actor_user_id: i.actorUserId,
        p_reason_code: i.reasonCode,
        p_mandate_id: i.mandateId ?? null,
      });
      if (error) throw new MandateStoreError(dbCode(error.message));
      return Number(data ?? 0);
    },
  };
}
