// =============================================================================
// Rozhranie transportnej / Peppol vrstvy — nezávislé od poskytovateľa.
//
// SERVER-ONLY. Implementácie držia tajomstvo poskytovateľa (API kľúč) iba v
// pamäti servera. Nikdy do DB, do klientského bundlu, do NEXT_PUBLIC_* ani do
// logov. Organizáciu (ProviderContext.providerOrgId) vždy určí server z
// einvoice_organizations podľa overenej aktívnej firmy — nikdy klient.
// =============================================================================

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
  /** Surové dáta dôkazu (bez tajomstiev) na uloženie do einvoice_outbound.evidence. */
  raw: Record<string, unknown>;
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

export interface EinvoiceProvider {
  readonly name: string;
  provisionOrganization(input: OrganizationProvisionInput): Promise<OrganizationInfo>;
  getOrganization(ctx: ProviderContext): Promise<OrganizationInfo>;
  verifyRecipient(ctx: ProviderContext, participantId: string): Promise<RecipientLookup>;
  preflight(ctx: ProviderContext, input: { ubl: Uint8Array; receiverParticipantId?: string }): Promise<PreflightResult>;
  sendUbl(ctx: ProviderContext, input: SendUblInput): Promise<SendResult>;
  getOutboundStatus(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<OutboundStatus>;
  getDeliveryEvidence(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<DeliveryEvidence | null>;
  listUnacknowledgedInbound(ctx: ProviderContext, options?: { limit?: number }): Promise<InboundSummary[]>;
  getInboundDocument(ctx: ProviderContext, providerReceivedId: string): Promise<InboundDocument>;
  acknowledgeInbound(ctx: ProviderContext, providerReceivedId: string): Promise<void>;
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
