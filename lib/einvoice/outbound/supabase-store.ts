import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { EinvoiceEnvironment } from "../provider/types.ts";
import {
  dbErrorCode,
  OutboundStoreError,
  type OrganizationRef,
  type OutboundRow,
  type OutboundStore,
  type RequestOutboundArgs,
  type RequestOutboundResult,
  type TransitionFields,
  type TransitionSource,
} from "./store.ts";

// =============================================================================
// E-Faktúra outbound — PRODUKČNÁ privilegovaná vrstva. SERVER-ONLY.
//
// JEDINÉ miesto E-Faktúry, ktoré drží service_role klienta. Volá iba:
//   - RPC esblu_einvoice_request_outbound / _claim_outbound / _outbound_transition
//     (EXECUTE iba pre service_role; autorizácia aktéra je v RPC),
//   - čítanie einvoice_organizations (ID organizácie u poskytovateľa),
//   - privátny bucket einvoice-documents (bez klientskych politík).
// Žiadne ďalšie tabuľky, žiadne priame UPDATE einvoice_outbound.
// =============================================================================

export const EINVOICE_BUCKET = "einvoice-documents";

export function createSupabaseOutboundStore(admin: SupabaseClient = getSupabaseAdmin()): OutboundStore {
  return {
    async requestOutbound(args: RequestOutboundArgs): Promise<RequestOutboundResult> {
      const { data, error } = await admin.rpc("esblu_einvoice_request_outbound", {
        p_actor_user_id: args.actorUserId,
        p_invoice_id: args.invoiceId,
        p_environment: args.environment,
        p_ubl_sha256: args.ublSha256,
        p_ubl_storage_path: args.ublStoragePath,
        p_ubl_size_bytes: args.ublSizeBytes,
        p_receiver_participant_id: args.receiverParticipantId,
      });
      if (error) throw new OutboundStoreError(dbErrorCode(error.message));
      const row = (Array.isArray(data) ? data[0] : data) as
        | { outbound_id: string; created: boolean; state: string; ubl_sha256: string | null; idempotency_key: string }
        | undefined;
      if (!row) throw new OutboundStoreError("DB_ERROR");
      return { outboundId: row.outbound_id, created: row.created, state: row.state, ublSha256: row.ubl_sha256, idempotencyKey: row.idempotency_key };
    },

    async claim(mode, limit, leaseSeconds, reconcileAfterSeconds): Promise<OutboundRow[]> {
      const { data, error } = await admin.rpc("esblu_einvoice_claim_outbound", {
        p_mode: mode,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
        p_reconcile_after_seconds: reconcileAfterSeconds ?? 300,
      });
      if (error) throw new OutboundStoreError(dbErrorCode(error.message));
      return (data as OutboundRow[] | null) ?? [];
    },

    async transition(id, expectedState, toState, source: TransitionSource, providerCode, fields: TransitionFields): Promise<OutboundRow> {
      const { data, error } = await admin.rpc("esblu_einvoice_outbound_transition", {
        p_outbound_id: id,
        p_expected_state: expectedState,
        p_to_state: toState,
        p_source: source,
        p_provider_code: providerCode,
        p_fields: fields,
      });
      if (error) throw new OutboundStoreError(dbErrorCode(error.message));
      return data as OutboundRow;
    },

    async organizationFor(companyId: string, environment: EinvoiceEnvironment): Promise<OrganizationRef | null> {
      const { data, error } = await admin
        .from("einvoice_organizations")
        .select("provider, provider_org_id, participant_id, peppol_eligible")
        .eq("company_id", companyId)
        .eq("environment", environment)
        .maybeSingle<{ provider: string; provider_org_id: string | null; participant_id: string | null; peppol_eligible: boolean }>();
      if (error) throw new OutboundStoreError("DB_ERROR");
      return data
        ? { provider: data.provider, providerOrgId: data.provider_org_id, participantId: data.participant_id, peppolEligible: data.peppol_eligible === true }
        : null;
    },

    async putUbl(path: string, bytes: Uint8Array): Promise<"created" | "exists"> {
      const { error } = await admin.storage.from(EINVOICE_BUCKET).upload(path, bytes, {
        contentType: "application/xml",
        upsert: false,
        cacheControl: "no-store",
      });
      if (!error) return "created";
      const status = (error as { statusCode?: string | number }).statusCode;
      if (String(status) === "409" || /exists|duplicate/i.test(error.message)) return "exists";
      throw new OutboundStoreError("STORAGE_WRITE_FAILED");
    },

    async getUbl(path: string): Promise<Uint8Array | null> {
      const { data, error } = await admin.storage.from(EINVOICE_BUCKET).download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
