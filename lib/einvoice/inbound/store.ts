// =============================================================================
// E-Faktúra inbound — rozhranie privilegovanej (serverovej) vrstvy.
//
// Produkčná implementácia (supabase-store.ts) beží so service_role a volá iba
// serverové RPC (esblu_einvoice_webhook_* / _inbound_* / _claim_*) a privátny
// bucket einvoice-documents. Testy používajú implementáciu nad PGlite s tými
// istými RPC. Firma sa NIKDY neberie z obsahu webhooku — iba z mapovania
// provider_org_id → einvoice_organizations v DB.
// =============================================================================

import type { EinvoiceEnvironment } from "../provider/types.ts";
import type { OrganizationRef, OutboundRow } from "../outbound/store.ts";
import type { InboundDraftPayload } from "./mapping.ts";

export type InboundRow = {
  id: string;
  company_id: string;
  provider: string;
  environment: EinvoiceEnvironment;
  provider_received_id: string;
  processing_status: string;
  xml_storage_path: string | null;
  xml_sha256: string | null;
  xml_size_bytes: number | null;
  invoice_id: string | null;
  retry_count: number;
  next_retry_at: string | null;
  locked_until: string | null;
  last_error_code: string | null;
  received_at: string;
};

export type InboundTransitionFields = Partial<{
  xml_storage_path: string;
  xml_sha256: string;
  xml_size_bytes: number;
  document_number: string | null;
  document_type: string | null;
  sender_participant_id: string | null;
  sender_ico: string | null;
  issue_date: string | null;
  review_reasons: string[];
  error_message: string | null;
  last_error_code: string | null;
  next_retry_at: string | null;
  locked_until: string | null;
  acknowledged_at: string | null;
}>;

export type InboundSource = "job" | "provider" | "webhook" | "poll" | "system";

export type WebhookRecordResult = {
  webhookEventId: string;
  inserted: boolean;
  bodyMatches: boolean;
  companyId: string | null;
  processingStatus: string;
};

export type RegisterMeta = Partial<{
  sender_participant_id: string | null;
  sender_ico: string | null;
  document_number: string | null;
  document_type: string | null;
  is_test: boolean;
}>;

export type OrganizationWithCompany = OrganizationRef & { companyId: string; environment: EinvoiceEnvironment };

export interface InboundStore {
  webhookRecord(input: { provider: string; environment: EinvoiceEnvironment; deliveryId: string; providerOrgId: string | null; event: string; bodySha256: string }): Promise<WebhookRecordResult>;
  webhookComplete(webhookEventId: string, status: "processed" | "ignored" | "failed" | "rejected", code: string | null): Promise<void>;
  /**
   * Zlyhané spracovanie toho istého doručenia (rovnaké ID aj telo) → znova „received“,
   * najviac 5 pokusov (RPC esblu_einvoice_webhook_retry). true = smie sa spracovať znova.
   * Voliteľné: bez metódy sa opakované doručenie berie ako DUPLICATE (pôvodné správanie).
   */
  webhookRetry?(webhookEventId: string): Promise<boolean>;
  register(input: { provider: string; environment: EinvoiceEnvironment; providerOrgId: string; providerReceivedId: string; source: "webhook" | "poll"; meta: RegisterMeta }): Promise<{ inboundId: string; created: boolean; processingStatus: string; companyId: string }>;
  claim(limit: number, leaseSeconds: number): Promise<InboundRow[]>;
  transition(id: string, expectedState: string, toState: string | null, source: InboundSource, providerCode: string | null, fields: InboundTransitionFields): Promise<InboundRow>;
  createDraft(inboundId: string, draft: InboundDraftPayload): Promise<{ status: "created" | "duplicate"; invoiceId: string; matchedOn: string | null }>;
  /** Uložené XML s rovnakým hashom v TEJ ISTEJ firme (iný tenant sa nikdy nehľadá). */
  findStoredXmlPath(companyId: string, sha256: string, exceptInboundId: string): Promise<string | null>;
  organizationFor(companyId: string, environment: EinvoiceEnvironment): Promise<OrganizationRef | null>;
  /** Organizácie pripravené na príjem pre daného poskytovateľa a prostredie (poll). */
  listOrganizations(provider: string, environment: EinvoiceEnvironment): Promise<OrganizationWithCompany[]>;
  /** Firma podľa provider_org_id (iba mapovanie v DB). */
  companyForOrg(provider: string, environment: EinvoiceEnvironment, providerOrgId: string): Promise<string | null>;
  claimOutboundBySubmission(companyId: string, providerSubmissionId: string, leaseSeconds: number): Promise<OutboundRow | null>;
  /**
   * Stav pokusu podľa ID podania (iba v rámci firmy) — rozlíšenie „už terminálne / práve
   * spracúvané / neexistuje“, keď claim nič nevráti (opakované delivered/sent udalosti).
   * Voliteľné: bez metódy sa správa ako predtým (SUBMISSION_NOT_FOUND).
   */
  outboundStateBySubmission?(companyId: string, providerSubmissionId: string): Promise<string | null>;
  /**
   * Webhook / feed participant.* → stav PRÍJMU organizácie (RPC esblu_einvoice_org_participant_event).
   * Voliteľné: store bez tejto metódy participant udalosti ignoruje (EVENT_NOT_HANDLED).
   */
  participantEvent?(input: {
    provider: string;
    environment: EinvoiceEnvironment;
    providerOrgId: string;
    event: "participant.activated" | "participant.failed" | "participant.deactivated";
    participantId: string | null;
    code: string | null;
    occurredAt: string | null;
  }): Promise<{ companyId: string | null; applied: boolean; receptionStatus: string | null }>;
  /** Zapíše bajty iba ak objekt neexistuje (nikdy neprepisuje). */
  putXml(path: string, bytes: Uint8Array): Promise<"created" | "exists">;
  getXml(path: string): Promise<Uint8Array | null>;
}

export class InboundStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "InboundStoreError";
    this.code = code;
  }
}

/** Cesta v privátnom buckete: firma / inbound / poskytovateľ / ID dokladu u poskytovateľa / hash. */
export function inboundXmlPath(companyId: string, provider: string, providerReceivedId: string, sha256: string): string {
  return `${companyId}/inbound/${provider}/${providerReceivedId}/${sha256}.xml`;
}
