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
  /**
   * eFaktura.sk: `document_id` z connector/send = DEFINITÍVNY identifikátor podania
   * (stav cez GET /v1/agent/peppol/submissions/{document_id}). Ukladá sa hneď pri odoslaní.
   */
  providerDocumentId?: string | null;
};

/** Dohľadanie podania podľa definitívneho document_id (z neho invoice_id pre status/evidence). */
export type SubmissionByDocument = {
  invoiceId: string | null;
  state: OutboundState | null;
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

/** P1-4: stránkovanie zoznamu prijatých dokladov. "offset" overené v sandboxe (R1); "none" = iba prvá stránka. */
export type InboundPaginationMode = "none" | "offset";

/** P1-4: jedna stránka zoznamu; `hasMore` z `meta.has_more` (null = poskytovateľ ho neuviedol), `rawCount` = riadky pred filtrom. */
export type InboundPage = { items: InboundSummary[]; hasMore: boolean | null; rawCount: number };

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
  /** GET /v1/agent/peppol/submissions/{document_id}; null = poskytovateľ podanie (zatiaľ) nevie vrátiť. */
  getSubmissionByDocumentId?(ctx: ProviderContext, documentId: string): Promise<SubmissionByDocument | null>;
  /**
   * Nepotvrdené prijaté doklady. `page` (1 = prvá) sa prevedie na `offset` IBA ak `inboundPagination` = "offset";
   * pri "none" vráti poskytovateľ pre page > 1 prázdny zoznam.
   */
  listUnacknowledgedInbound(ctx: ProviderContext, options?: { limit?: number; page?: number }): Promise<InboundSummary[]>;
  /** P1-4: režim stránkovania GET /received (overený v sandboxe, R1). Chýba = "none" (iba prvá stránka). */
  readonly inboundPagination?: InboundPaginationMode;
  /** P1-4: stránka vrátane `meta.has_more`. Voliteľné — bez nej sa koniec určí podľa počtu riadkov. */
  listUnacknowledgedInboundPage?(ctx: ProviderContext, options?: { limit?: number; page?: number }): Promise<InboundPage>;
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
  /** SHA-256 surových bajtov odpovede enroll (dôkaz potvrdenia v einvoice_mandates). Telo sa neukladá. */
  responseSha256?: string | null;
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

/** Výsledok POST /v1/agent/organizations/{id}/peppol/deactivate (ukončenie registrácie). */
export type DeactivateResult = {
  peppolStatus: string | null;
  /** SHA-256 surových bajtov odpovede (dôkaz v einvoice_deregistrations). */
  responseSha256: string | null;
};

/** Offboarding firmy u poskytovateľa (20261122110000). Samostatné rozhranie — existujúce fakes ostávajú platné. */
export interface EinvoiceDeregistrationProvider {
  readonly name: string;
  deactivatePeppol(ctx: ProviderContext): Promise<DeactivateResult>;
}

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
