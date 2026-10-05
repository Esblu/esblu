import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { EinvoiceEnvironment } from "../provider/types.ts";
import { dbErrorCode, type OutboundRow } from "../outbound/store.ts";
import { EINVOICE_BUCKET } from "../outbound/supabase-store.ts";
import { InboundStoreError, type InboundRow, type InboundStore } from "./store.ts";
import type { EventCursorStore } from "./feed.ts";

// =============================================================================
// E-Faktúra inbound — PRODUKČNÁ privilegovaná vrstva. SERVER-ONLY.
// Spolu s outbound/supabase-store.ts jediné miesto E-Faktúry so service_role.
// Volá iba serverové RPC, čítanie einvoice_organizations / einvoice_inbound
// (hash v rámci firmy) a privátny bucket einvoice-documents.
// =============================================================================

export function createSupabaseInboundStore(admin: SupabaseClient = getSupabaseAdmin()): InboundStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new InboundStoreError(dbErrorCode(error.message));
    return data as T;
  };
  const first = <T>(data: unknown): T => (Array.isArray(data) ? data[0] : data) as T;

  return {
    async webhookRecord(i) {
      const row = first<{ webhook_event_id: string; inserted: boolean; body_matches: boolean; company_id: string | null; processing_status: string }>(
        await rpc("esblu_einvoice_webhook_record", {
          p_provider: i.provider,
          p_environment: i.environment,
          p_delivery_id: i.deliveryId,
          p_provider_org_id: i.providerOrgId,
          p_event: i.event,
          p_body_sha256: i.bodySha256,
        })
      );
      return { webhookEventId: row.webhook_event_id, inserted: row.inserted, bodyMatches: row.body_matches, companyId: row.company_id, processingStatus: row.processing_status };
    },
    async webhookComplete(id, status, code) {
      await rpc("esblu_einvoice_webhook_complete", { p_webhook_event_id: id, p_status: status, p_code: code });
    },
    async register(i) {
      const row = first<{ inbound_id: string; created: boolean; processing_status: string; company_id: string }>(
        await rpc("esblu_einvoice_inbound_register", {
          p_provider: i.provider,
          p_environment: i.environment,
          p_provider_org_id: i.providerOrgId,
          p_provider_received_id: i.providerReceivedId,
          p_source: i.source,
          p_meta: i.meta,
        })
      );
      return { inboundId: row.inbound_id, created: row.created, processingStatus: row.processing_status, companyId: row.company_id };
    },
    async claim(limit, leaseSeconds) {
      return ((await rpc<InboundRow[] | null>("esblu_einvoice_claim_inbound", { p_limit: limit, p_lease_seconds: leaseSeconds })) ?? []);
    },
    async transition(id, expected, to, source, code, fields) {
      return rpc<InboundRow>("esblu_einvoice_inbound_transition", {
        p_inbound_id: id,
        p_expected_state: expected,
        p_to_state: to,
        p_source: source,
        p_provider_code: code,
        p_fields: fields,
      });
    },
    async createDraft(inboundId, draft) {
      const r = await rpc<{ status: "created" | "duplicate"; invoice_id: string; matched_on: string | null }>("esblu_einvoice_inbound_create_draft", {
        p_inbound_id: inboundId,
        p_draft: draft,
      });
      return { status: r.status, invoiceId: r.invoice_id, matchedOn: r.matched_on };
    },
    async findStoredXmlPath(companyId, sha256, exceptInboundId) {
      const { data, error } = await admin
        .from("einvoice_inbound")
        .select("xml_storage_path")
        .eq("company_id", companyId)
        .eq("xml_sha256", sha256)
        .neq("id", exceptInboundId)
        .not("xml_storage_path", "is", null)
        .limit(1);
      if (error) throw new InboundStoreError("DB_ERROR");
      return (data as { xml_storage_path: string }[] | null)?.[0]?.xml_storage_path ?? null;
    },
    async organizationFor(companyId, environment: EinvoiceEnvironment) {
      const { data, error } = await admin
        .from("einvoice_organizations")
        .select("provider, provider_org_id, participant_id, peppol_eligible")
        .eq("company_id", companyId)
        .eq("environment", environment)
        .maybeSingle<{ provider: string; provider_org_id: string | null; participant_id: string | null; peppol_eligible: boolean }>();
      if (error) throw new InboundStoreError("DB_ERROR");
      return data ? { provider: data.provider, providerOrgId: data.provider_org_id, participantId: data.participant_id, peppolEligible: data.peppol_eligible === true } : null;
    },
    async listOrganizations(provider, environment) {
      const { data, error } = await admin
        .from("einvoice_organizations")
        .select("company_id, provider, provider_org_id, participant_id, peppol_eligible, environment")
        .eq("provider", provider)
        .eq("environment", environment)
        .eq("peppol_eligible", true)
        .not("provider_org_id", "is", null)
        // Príjem: iba aktívny (alebo legacy NULL). send_only / failed / pending / deactivated sa nepolluje.
        .or("reception_status.is.null,reception_status.eq.active");
      if (error) throw new InboundStoreError("DB_ERROR");
      return ((data as { company_id: string; provider: string; provider_org_id: string; participant_id: string | null; peppol_eligible: boolean; environment: EinvoiceEnvironment }[] | null) ?? []).map((o) => ({
        companyId: o.company_id,
        environment: o.environment,
        provider: o.provider,
        providerOrgId: o.provider_org_id,
        participantId: o.participant_id,
        peppolEligible: o.peppol_eligible,
      }));
    },
    async companyForOrg(provider, environment, providerOrgId) {
      const { data, error } = await admin
        .from("einvoice_organizations")
        .select("company_id")
        .eq("provider", provider)
        .eq("environment", environment)
        .eq("provider_org_id", providerOrgId)
        .maybeSingle<{ company_id: string }>();
      if (error) throw new InboundStoreError("DB_ERROR");
      return data?.company_id ?? null;
    },
    async claimOutboundBySubmission(companyId, submissionId, leaseSeconds) {
      const rows = await rpc<OutboundRow[] | null>("esblu_einvoice_claim_outbound_by_submission", {
        p_company_id: companyId,
        p_provider_submission_id: submissionId,
        p_lease_seconds: leaseSeconds,
      });
      return rows?.[0] ?? null;
    },
    async webhookRetry(id) {
      return (await rpc<boolean>("esblu_einvoice_webhook_retry", { p_webhook_event_id: id, p_max: 5 })) === true;
    },
    async outboundStateBySubmission(companyId, submissionId) {
      const { data, error } = await admin
        .from("einvoice_outbound")
        .select("state")
        .eq("company_id", companyId)
        .eq("provider_submission_id", submissionId)
        .order("attempt", { ascending: false })
        .limit(1)
        .maybeSingle<{ state: string }>();
      if (error) throw new InboundStoreError("DB_ERROR");
      return data?.state ?? null;
    },
    async participantEvent(i) {
      const row = first<{ company_id: string | null; applied: boolean; reception_status: string | null }>(
        await rpc("esblu_einvoice_org_participant_event", {
          p_provider: i.provider,
          p_environment: i.environment,
          p_provider_org_id: i.providerOrgId,
          p_event: i.event,
          p_participant_id: i.participantId,
          p_code: i.code,
          p_occurred_at: i.occurredAt,
        })
      );
      return { companyId: row?.company_id ?? null, applied: row?.applied === true, receptionStatus: row?.reception_status ?? null };
    },
    async putXml(path, bytes) {
      const { error } = await admin.storage.from(EINVOICE_BUCKET).upload(path, bytes, {
        contentType: "application/xml",
        upsert: false,
        cacheControl: "no-store",
      });
      if (!error) return "created";
      const status = (error as { statusCode?: string | number }).statusCode;
      if (String(status) === "409" || /exists|duplicate/i.test(error.message)) return "exists";
      throw new InboundStoreError("STORAGE_FAILED");
    },
    async getXml(path) {
      const { data, error } = await admin.storage.from(EINVOICE_BUCKET).download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

/** Kurzor partnerského feedu (RPC z 20261006100000, iba service_role). */
export function createSupabaseEventCursorStore(admin: SupabaseClient = getSupabaseAdmin()): EventCursorStore {
  return {
    async claim(provider, environment, leaseSeconds) {
      const { data, error } = await admin.rpc("esblu_einvoice_event_cursor_claim", { p_provider: provider, p_environment: environment, p_lease_seconds: leaseSeconds });
      if (error) throw new InboundStoreError(dbErrorCode(error.message));
      const row = (Array.isArray(data) ? data[0] : data) as { last_event_id: number | string; lock_token: string } | null | undefined;
      return row?.lock_token ? { lastEventId: Number(row.last_event_id), lockToken: row.lock_token } : null;
    },
    async advance(provider, environment, lockToken, lastEventId, release, errorCode = null) {
      const { data, error } = await admin.rpc("esblu_einvoice_event_cursor_advance", {
        p_provider: provider, p_environment: environment, p_lock_token: lockToken, p_last_event_id: lastEventId, p_release: release, p_error_code: errorCode,
      });
      if (error) throw new InboundStoreError(dbErrorCode(error.message));
      return Number(data);
    },
  };
}
