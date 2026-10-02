// =============================================================================
// E-Faktúra outbound — rozhranie privilegovanej (serverovej) vrstvy.
//
// Produkčná implementácia (supabase-store.ts) beží so service_role a volá
// VÝHRADNE serverové RPC (esblu_einvoice_request_outbound / _claim_outbound /
// _outbound_transition) a privátny bucket einvoice-documents. Testy používajú
// implementáciu nad PGlite s tými istými RPC. Route ani klient service_role
// nikdy priamo nedrží — iba cez tento kontrakt.
// =============================================================================

import type { EinvoiceEnvironment } from "../provider/types.ts";
import type { EinvoiceEvidenceRecord } from "../evidence.ts";

export type OutboundRow = {
  id: string;
  company_id: string;
  invoice_id: string;
  provider: string;
  environment: EinvoiceEnvironment;
  attempt: number;
  idempotency_key: string;
  state: string;
  ubl_sha256: string | null;
  ubl_storage_path: string | null;
  ubl_size_bytes: number | null;
  receiver_participant_id: string | null;
  provider_submission_id: string | null;
  retry_count: number;
  next_retry_at: string | null;
  locked_until: string | null;
  last_error_code: string | null;
  send_in_flight: boolean;
  send_outcome_unknown: boolean;
  updated_at: string;
};

export type RequestOutboundArgs = {
  actorUserId: string;
  invoiceId: string;
  environment: EinvoiceEnvironment;
  ublSha256: string;
  ublStoragePath: string;
  ublSizeBytes: number;
  receiverParticipantId: string;
};

export type RequestOutboundResult = {
  outboundId: string;
  created: boolean;
  state: string;
  ublSha256: string | null;
  idempotencyKey: string;
};

/** Iba allowlistované polia (zrkadlo esblu_einvoice_outbound_transition). */
export type TransitionFields = Partial<{
  provider_submission_id: string;
  provider_staged_id: string | null;
  reject_reason: string | null;
  error_message: string | null;
  last_error_code: string | null;
  next_retry_at: string | null;
  receiver_identifier: string | null;
  document_id: string | null;
  evidence: EinvoiceEvidenceRecord | null;
  sent_at: string | null;
  delivered_at: string | null;
  send_in_flight: boolean;
  send_outcome_unknown: boolean;
  locked_until: string | null;
  provider_status: string | null;
  status_checked_at: string | null;
  /** Phase 4: reconciliation autoritatívne potvrdila absenciu podania (iba bez ID poskytovateľa). */
  reconciled_absent_at: string | null;
}>;

export type TransitionSource = "job" | "provider" | "reconcile" | "webhook" | "poll" | "system";

export type OrganizationRef = { provider: string; providerOrgId: string | null; participantId: string | null; peppolEligible: boolean };

export class OutboundStoreError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "OutboundStoreError";
    this.code = code;
  }
}

export interface OutboundStore {
  requestOutbound(args: RequestOutboundArgs): Promise<RequestOutboundResult>;
  claim(mode: "send" | "reconcile", limit: number, leaseSeconds: number, reconcileAfterSeconds?: number): Promise<OutboundRow[]>;
  transition(id: string, expectedState: string, toState: string | null, source: TransitionSource, providerCode: string | null, fields: TransitionFields): Promise<OutboundRow>;
  organizationFor(companyId: string, environment: EinvoiceEnvironment): Promise<OrganizationRef | null>;
  /** Zapíše bajty iba ak objekt neexistuje (nikdy neprepisuje). */
  putUbl(path: string, bytes: Uint8Array): Promise<"created" | "exists">;
  getUbl(path: string): Promise<Uint8Array | null>;
}

/** Deterministická cesta v privátnom buckete: firma / faktúra / hash obsahu. */
export function outboundUblPath(companyId: string, invoiceId: string, sha256: string): string {
  return `${companyId}/outbound/${invoiceId}/${sha256}.xml`;
}

/** Kód z chyby DB/RPC (ESBLU_…, ENTITLEMENT_DENIED:…) bez ďalšieho textu. */
export function dbErrorCode(message: string | null | undefined): string {
  const text = message ?? "";
  const entitlement = /ENTITLEMENT_DENIED:[A-Z_]+:[a-z_]+/.exec(text);
  if (entitlement) return entitlement[0];
  const esblu = /\b(ESBLU_[A-Z0-9_]+|NOT_AUTHENTICATED)\b/.exec(text);
  return esblu ? esblu[1] : "DB_ERROR";
}
