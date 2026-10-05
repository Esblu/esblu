// =============================================================================
// Rozhranie transportnej / Peppol vrstvy — nezávislé od poskytovateľa.
//
// SERVER-ONLY. Implementácie držia tajomstvo poskytovateľa (API kľúč) iba v
// pamäti servera. Nikdy do DB, do klientského bundlu, do NEXT_PUBLIC_* ani do
// logov. Organizáciu (ProviderContext.providerOrgId) vždy určí server z
// einvoice_organizations podľa overenej aktívnej firmy — nikdy klient.
// =============================================================================

import type { EinvoiceEvidenceRecord } from "../evidence.ts";

export type EinvoiceEnvironment = "sandbox" | "live";

/** Neutrálny stav pokusu o doručenie (zhodný s einvoice_outbound.state). */
export type OutboundState =
  | "pending" | "validated" | "staged" | "queued" | "sending"
  | "sent" | "deferred" | "delivered" | "rejected" | "failed";

export type ProviderContext = {
  environment: EinvoiceEnvironment;
  /** Organizácia u poskytovateľa — vyriešená serverom pre overenú firmu. */
  providerOrgId: string;
};

export type OrganizationProvisionInput = {
  environment: EinvoiceEnvironment;
  legalName: string;
  ico: string;
  dic: string | null;
  icDph: string | null;
  address: { street: string; city: string; postalCode: string; countryCode: string };
};

export type OrganizationInfo = {
  providerOrgId: string;
  participantId: string | null;
  orgStatus: string | null;
  peppolStatus: string | null;
  claimStatus: string | null;
  peppolEligible: boolean;
  /** true = poskytovateľ vrátil existujúcu organizáciu (idempotencia). */
  reused: boolean;
};

export type RecipientLookup = {
  participantId: string;
  found: boolean;
  /** Vyhľadanie zlyhalo technicky — nie je to „nenájdený". */
  lookupUnavailable: boolean;
};

export type PreflightIssue = { code: string; message: string; severity: "error" | "warning"; field?: string };

export type PreflightResult = {
  sendReady: boolean;
  validatorUnavailable: boolean;
  issues: PreflightIssue[];
};

export type SendUblInput = {
  ubl: Uint8Array;
  ublSha256: string;
  /** Musí byť stabilný pre ten istý pokus (einvoice_outbound.idempotency_key). */
  idempotencyKey: string;
  receiverParticipantId?: string;
};

export type SendResult = {
  state: OutboundState;
  providerSubmissionId: string | null;
  providerStagedId: string | null;
  rejectReason: string | null;
};

export type OutboundStatus = {
  state: OutboundState;
  receiverIdentifier: string | null;
  documentId: string | null;
  errorMessage: string | null;
  updatedAt: string | null;
};

export type DeliveryEvidence = {
  documentId: string | null;
  ublSha256: string | null;
  deliveredAt: string | null;
  /**
   * JEDINÉ, čo sa smie uložiť do einvoice_outbound.evidence — allowlistovaný
   * záznam (lib/einvoice/evidence.ts). Surová odpoveď poskytovateľa sa nikdy
   * neukladá ani nevracia.
   */
  record: EinvoiceEvidenceRecord;
};

export type InboundSummary = {
  providerReceivedId: string;
  senderParticipantId: string | null;
  senderIco: string | null;
  documentNumber: string | null;
  documentType: string | null;
  receivedAt: string | null;
  isTest: boolean;
};

export type InboundDocument = {
  providerReceivedId: string;
  xml: Uint8Array;
  pdf: Uint8Array | null;
};

/**
 * Dohľadanie podania podľa Idempotency-Key (reconciliation neistého výsledku).
 *   found   — poskytovateľ podanie s týmto kľúčom má → pokračuje sa s PÔVODNÝM,
 *   absent  — poskytovateľ AUTORITATÍVNE potvrdil, že podanie neexistuje,
 *   unknown — poskytovateľ to nevie potvrdiť (nič sa nesmie rozhodnúť).
 */
export type SubmissionLookup =
  | { kind: "found"; providerSubmissionId: string; state: OutboundState }
  | { kind: "absent" }
  | { kind: "unknown" };

export interface EinvoiceProvider {
  readonly name: string;
  provisionOrganization(input: OrganizationProvisionInput): Promise<OrganizationInfo>;
  getOrganization(ctx: ProviderContext): Promise<OrganizationInfo>;
  verifyRecipient(ctx: ProviderContext, participantId: string): Promise<RecipientLookup>;
  preflight(ctx: ProviderContext, input: { ubl: Uint8Array; receiverParticipantId?: string }): Promise<PreflightResult>;
  sendUbl(ctx: ProviderContext, input: SendUblInput): Promise<SendResult>;
  getOutboundStatus(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<OutboundStatus>;
  getDeliveryEvidence(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<DeliveryEvidence | null>;
  findSubmissionByIdempotencyKey(ctx: ProviderContext, idempotencyKey: string): Promise<SubmissionLookup>;
  listUnacknowledgedInbound(ctx: ProviderContext, options?: { limit?: number }): Promise<InboundSummary[]>;
  getInboundDocument(ctx: ProviderContext, providerReceivedId: string): Promise<InboundDocument>;
  acknowledgeInbound(ctx: ProviderContext, providerReceivedId: string): Promise<void>;
}

// -----------------------------------------------------------------------------
// API partner onboarding (enroll príjmu + partnerský feed udalostí).
// Samostatné rozhranie, aby existujúce test fakes EinvoiceProvider ostali platné.
// -----------------------------------------------------------------------------

/** Výsledok POST /peppol/enroll. `send_only` = príjem drží iný poskytovateľ, odosielanie funguje. */
export type EnrollStatus = "enrolled" | "skipped" | "send_only";

export type EnrollResult = {
  status: EnrollStatus;
  participantId: string | null;
  registrationId: string | null;
  claim: string | null;
  /** Iba pri send_only: AP host a subjekt certifikátu aktuálneho držiteľa príjmu (firemné údaje). */
  receptionHeldBy: { apHost: string | null; certOrg: string | null } | null;
  /** Kódy varovaní poskytovateľa (napr. SANDBOX_TOKEN_MISSING) — nikdy text s údajmi. */
  warnings: string[];
};

export type EnrollInput = {
  /** FS verifikačný token (hex). NIKDY sa neukladá ani neloguje. */
  verificationTokenHex: string;
  /** SML migračný kód od aktuálneho držiteľa príjmu (iba live). NIKDY sa neukladá ani neloguje. */
  migrationCode?: string;
};

/** Jedna udalosť z partnerského feedu GET /v1/agent/events (telo = presne telo webhooku). */
export type PartnerEvent = {
  id: string;
  event: string;
  eventId: string | null;
  orgId: string | null;
  createdAt: string | null;
  /** Obálka {event, timestamp, data}. Spracúva sa iba allowlist identifikátorov; neloguje sa. */
  payload: Record<string, unknown>;
};

export type PartnerEventPage = { events: PartnerEvent[]; nextAfter: string | null; hasMore: boolean };

export interface EinvoiceOnboardingProvider {
  readonly name: string;
  enrollPeppol(ctx: ProviderContext, input: EnrollInput): Promise<EnrollResult>;
  listPartnerEvents(input?: { after?: string; limit?: number }): Promise<PartnerEventPage>;
}

export class EinvoiceProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message?: string, retryable = false) {
    super(message ?? code);
    this.name = "EinvoiceProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class EinvoiceProviderNotImplementedError extends EinvoiceProviderError {
  constructor(operation: string) {
    super("EINVOICE_PROVIDER_NOT_IMPLEMENTED", `${operation}: čaká na sandbox kľúč / OpenAPI poskytovateľa`);
    this.name = "EinvoiceProviderNotImplementedError";
  }
}

export function assertServerOnly(): void {
  if (typeof window !== "undefined") {
    throw new Error("EINVOICE_SERVER_ONLY");
  }
}
