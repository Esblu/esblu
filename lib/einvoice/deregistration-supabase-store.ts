import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { DeregistrationJob, DeregistrationStatus, DeregistrationStore } from "./deregistration.ts";

// E-Faktúra deregistrácia — PRODUKČNÁ privilegovaná vrstva (service_role, RPC z 20261122110000). SERVER-ONLY.

function dbCode(message: string | undefined): string {
  const m = /ESBLU_[A-Z0-9_]+/.exec(message ?? "");
  return m ? m[0] : "DB_ERROR";
}

export class DeregistrationStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "DeregistrationStoreError";
    this.code = code;
  }
}

export function createSupabaseDeregistrationStore(admin: SupabaseClient = getSupabaseAdmin()): DeregistrationStore {
  return {
    async request(i) {
      const { data, error } = await admin.rpc("esblu_einvoice_deregistration_request", {
        p_company_id: i.companyId,
        p_environment: i.environment,
        p_reason: i.reason,
        p_actor_user_id: i.actorUserId,
        p_operator: i.operator ?? null,
      });
      if (error) throw new DeregistrationStoreError(dbCode(error.message));
      const r = (data ?? {}) as { job_id?: string | null; state?: string; created?: boolean };
      return { jobId: r.job_id ?? null, state: String(r.state ?? "unknown"), created: r.created === true };
    },
    async claim(provider, environment, limit, leaseSeconds, jobId = null) {
      const { data, error } = await admin.rpc("esblu_einvoice_deregistration_claim", {
        p_provider: provider,
        p_environment: environment,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
        p_job_id: jobId,
      });
      if (error) throw new DeregistrationStoreError(dbCode(error.message));
      return (data as DeregistrationJob[] | null) ?? [];
    },
    async finish(i) {
      const { data, error } = await admin.rpc("esblu_einvoice_deregistration_finish", {
        p_job_id: i.jobId,
        p_outcome: i.outcome,
        p_error_code: i.errorCode,
        p_provider_outcome: i.providerOutcome,
        p_provider_response_sha256: i.providerResponseSha256,
        p_retry_after_seconds: i.retryAfterSeconds ?? null,
      });
      if (error) throw new DeregistrationStoreError(dbCode(error.message));
      return (Array.isArray(data) ? data[0] : data) as DeregistrationJob;
    },
    async status(companyId, environment) {
      const { data, error } = await admin.rpc("esblu_einvoice_deregistration_status", { p_company_id: companyId, p_environment: environment });
      if (error) throw new DeregistrationStoreError(dbCode(error.message));
      const r = (data ?? {}) as { registered?: boolean; job?: DeregistrationStatus["job"] };
      return { registered: r.registered === true, job: r.job ?? null };
    },
  };
}
