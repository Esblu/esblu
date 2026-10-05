import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { EinvoiceEnvironment } from "./provider/types.ts";
import type { BillingIdentity, OnboardingStore, OrganizationState, ReceptionStatus } from "./onboarding.ts";
import type { EnrollAttemptLimiter } from "./ui/reception-server.ts";

// =============================================================================
// E-Faktúra onboarding — PRODUKČNÁ privilegovaná vrstva (service_role). SERVER-ONLY.
// Zápisy výhradne cez RPC z migrácie 20261005100000 (firma iba z mapovania).
// =============================================================================

export class OnboardingStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "OnboardingStoreError";
    this.code = code;
  }
}

function dbCode(message: string | undefined): string {
  const m = /ESBLU_[A-Z0-9_]+/.exec(message ?? "");
  return m ? m[0] : "DB_ERROR";
}

export function createSupabaseOnboardingStore(admin: SupabaseClient = getSupabaseAdmin()): OnboardingStore {
  const first = <T>(data: unknown): T => (Array.isArray(data) ? data[0] : data) as T;
  return {
    async billingIdentity(companyId) {
      const { data, error } = await admin
        .from("company_billing_profile")
        .select("legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code")
        .eq("company_id", companyId)
        .maybeSingle<{ legal_name: string | null; ico: string | null; dic: string | null; ic_dph: string | null; address_line1: string | null; city: string | null; postal_code: string | null; country_code: string | null }>();
      if (error) throw new OnboardingStoreError("DB_ERROR");
      if (!data) return null;
      const b: BillingIdentity = { legal_name: data.legal_name, ico: data.ico, dic: data.dic, ic_dph: data.ic_dph, street: data.address_line1, city: data.city, postal_code: data.postal_code, country_code: data.country_code };
      return b;
    },
    async organization(companyId, environment: EinvoiceEnvironment) {
      const { data, error } = await admin
        .from("einvoice_organizations")
        .select("provider_org_id, participant_id, peppol_eligible, reception_status, reception_error_code")
        .eq("company_id", companyId)
        .eq("environment", environment)
        .maybeSingle<{ provider_org_id: string | null; participant_id: string | null; peppol_eligible: boolean; reception_status: string | null; reception_error_code: string | null }>();
      if (error) throw new OnboardingStoreError("DB_ERROR");
      if (!data) return null;
      const o: OrganizationState = {
        providerOrgId: data.provider_org_id,
        participantId: data.participant_id,
        peppolEligible: data.peppol_eligible === true,
        receptionStatus: (data.reception_status as ReceptionStatus | null) ?? null,
        receptionErrorCode: data.reception_error_code,
      };
      return o;
    },
    async upsertProvisioned(i) {
      const { data, error } = await admin.rpc("esblu_einvoice_org_upsert_provisioned", {
        p_company_id: i.companyId,
        p_provider: i.provider,
        p_environment: i.environment,
        p_provider_org_id: i.providerOrgId,
        p_participant_id: i.participantId,
        p_org_status: i.orgStatus,
        p_peppol_status: i.peppolStatus,
        p_claim_status: i.claimStatus,
        p_peppol_eligible: i.peppolEligible,
        p_snapshot: i.snapshot,
      });
      if (error) throw new OnboardingStoreError(dbCode(error.message));
      const r = first<{ created: boolean; reception_status: string | null }>(data);
      return { created: r?.created === true, receptionStatus: r?.reception_status ?? null };
    },
    async applyEnroll(i) {
      const { data, error } = await admin.rpc("esblu_einvoice_org_apply_enroll", {
        p_provider: i.provider,
        p_environment: i.environment,
        p_provider_org_id: i.providerOrgId,
        p_outcome: i.outcome,
        p_participant_id: i.participantId,
        p_held_by: i.heldBy,
        p_error_code: i.errorCode,
      });
      if (error) throw new OnboardingStoreError(dbCode(error.message));
      const r = first<{ reception_status: string; peppol_eligible: boolean }>(data);
      return { receptionStatus: r.reception_status, peppolEligible: r.peppol_eligible === true };
    },
  };
}

/** Limit pokusov o aktiváciu príjmu (RPC z 20261007100000). FS kód sa sem nikdy nedostane. */
export function createSupabaseEnrollLimiter(admin: SupabaseClient = getSupabaseAdmin()): EnrollAttemptLimiter {
  return {
    async begin(companyId, userId) {
      const { data, error } = await admin.rpc("esblu_einvoice_enroll_attempt_begin", { p_company_id: companyId, p_user_id: userId });
      if (error) throw new OnboardingStoreError(dbCode(error.message));
      const r = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; attempt_id: string | null; retry_after_seconds: number; reason: string | null } | null;
      return { allowed: r?.allowed === true, attemptId: r?.attempt_id ?? null, retryAfterSeconds: Number(r?.retry_after_seconds ?? 0), reason: r?.reason ?? null };
    },
    async finish(attemptId, outcome) {
      const { error } = await admin.rpc("esblu_einvoice_enroll_attempt_finish", { p_attempt_id: attemptId, p_outcome: outcome.slice(0, 60) });
      if (error) throw new OnboardingStoreError(dbCode(error.message));
    },
  };
}
