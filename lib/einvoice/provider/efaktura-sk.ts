import {
  EinvoiceProviderError,
  EinvoiceProviderNotImplementedError,
  type DeliveryEvidence,
  type EinvoiceEnvironment,
  type EinvoiceProvider,
  type InboundDocument,
  type InboundSummary,
  type OrganizationInfo,
  type OutboundState,
  type OutboundStatus,
  type PreflightResult,
  type RecipientLookup,
  type SendResult,
} from "./types.ts";

// =============================================================================
// eFaktura.sk Agent API — SKELETON (Connector cesta, vlastný UBL).
//
// ZÁMERNE BEZ SIEŤOVÝCH VOLANÍ. Každá metóda hodí
// EinvoiceProviderNotImplementedError, kým nemáme sandbox kľúč a OpenAPI
// špecifikáciu (verejná reference sa nedala načítať). Pripravené sú iba
// čisté, zdokumentované časti, ktoré vieme overiť testom:
//   - hlavičky požiadavky (X-API-Key, X-Organization-Id, Idempotency-Key),
//   - mapovanie zdokumentovaných stavov na neutrálny OutboundState.
//
// Zdokumentované endpointy (developers.efaktura.sk/en/docs, 2026-09-29) —
// na doplnenie po overení voči OpenAPI:
//   POST /v1/agent/organizations                 (org:provision, idempotentné podľa IČO)
//   GET  /v1/agent/organizations/{id}
//   GET  /v1/agent/peppol/recipient?peppolId=
//   POST /v1/agent/peppol/preflight
//   POST /v1/agent/peppol/connector/send         (Idempotency-Key povinný)
//   GET  /v1/agent/peppol/status/{invoiceId}
//   GET  /v1/agent/peppol/sent/{invoiceId}/evidence
//   GET  /v1/agent/peppol/received?acknowledged=false
//   GET  /v1/agent/peppol/received/{id}/xml | /pdf
//   POST /v1/agent/peppol/received/{id}/acknowledge
//
// NEPOUŽÍVA sa POST /v1/agent/invoices — Esblu je source of truth faktúry.
// =============================================================================

export const EFAKTURA_BASE_URL = "https://api.efaktura.sk/v1";

export type EfakturaConfig = {
  /** Partnerský kľúč — iba server, iba z env. Nikdy do DB/logov/klienta. */
  apiKey: string;
  environment: EinvoiceEnvironment;
};

/** Kľúč musí zodpovedať prostrediu (zdokumentované prefixy partnerských kľúčov). */
export function assertEfakturaKeyMatchesEnvironment(apiKey: string, environment: EinvoiceEnvironment): void {
  const expected = environment === "sandbox" ? "efk_pk_test_" : "efk_pk_live_";
  if (!apiKey.startsWith(expected)) {
    throw new EinvoiceProviderError("EINVOICE_KEY_ENVIRONMENT_MISMATCH", "API kľúč nezodpovedá prostrediu");
  }
}

/**
 * Hlavičky požiadavky. `providerOrgId` MUSÍ pochádzať z einvoice_organizations
 * pre firmu overenú na serveri — funkcia ho nikdy neberie z tela požiadavky.
 */
export function buildEfakturaHeaders(input: {
  apiKey: string;
  providerOrgId?: string;
  idempotencyKey?: string;
  contentType?: string;
}): Record<string, string> {
  const headers: Record<string, string> = { "X-API-Key": input.apiKey, Accept: "application/json" };
  if (input.providerOrgId) headers["X-Organization-Id"] = input.providerOrgId;
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
  if (input.contentType) headers["Content-Type"] = input.contentType;
  return headers;
}

/**
 * Zdokumentované stavy doručenia → neutrálny stav. Neznámy stav vráti null
 * (docs: klient má neznáme hodnoty ignorovať) — volajúci ho NESMIE hádať.
 */
export function mapEfakturaSendState(state: string | null | undefined): OutboundState | null {
  switch (state) {
    case "not_sent": return "pending";
    case "scheduled": return "staged";
    case "QUEUED": return "queued";
    case "SENDING": return "sending";
    case "SENT": return "sent";
    case "DEFERRED": return "deferred";
    case "DELIVERED": return "delivered";
    case "ERROR": return "failed";
    default: return null;
  }
}

/** Zdokumentované výsledky Connector odoslania → neutrálny stav. */
export function mapEfakturaConnectorStatus(status: string | null | undefined): OutboundState | null {
  switch (status) {
    case "queued": return "queued";
    case "rejected": return "rejected";
    case "validated": return "validated";
    case "staged": return "staged";
    default: return null;
  }
}

export class EfakturaSkProvider implements EinvoiceProvider {
  readonly name = "efaktura_sk";

  private readonly config: EfakturaConfig;

  constructor(config: EfakturaConfig) {
    this.config = config;
    if (!config.apiKey) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_CONFIGURED");
    assertEfakturaKeyMatchesEnvironment(config.apiKey, config.environment);
  }

  /** Nikdy neprezradí kľúč pri logovaní / serializácii objektu. */
  toJSON() {
    return { name: this.name, environment: this.config.environment };
  }

  async provisionOrganization(): Promise<OrganizationInfo> {
    throw new EinvoiceProviderNotImplementedError("provisionOrganization");
  }
  async getOrganization(): Promise<OrganizationInfo> {
    throw new EinvoiceProviderNotImplementedError("getOrganization");
  }
  async verifyRecipient(): Promise<RecipientLookup> {
    throw new EinvoiceProviderNotImplementedError("verifyRecipient");
  }
  async preflight(): Promise<PreflightResult> {
    throw new EinvoiceProviderNotImplementedError("preflight");
  }
  async sendUbl(): Promise<SendResult> {
    throw new EinvoiceProviderNotImplementedError("sendUbl");
  }
  async getOutboundStatus(): Promise<OutboundStatus> {
    throw new EinvoiceProviderNotImplementedError("getOutboundStatus");
  }
  async getDeliveryEvidence(): Promise<DeliveryEvidence | null> {
    throw new EinvoiceProviderNotImplementedError("getDeliveryEvidence");
  }
  async listUnacknowledgedInbound(): Promise<InboundSummary[]> {
    throw new EinvoiceProviderNotImplementedError("listUnacknowledgedInbound");
  }
  async getInboundDocument(): Promise<InboundDocument> {
    throw new EinvoiceProviderNotImplementedError("getInboundDocument");
  }
  async acknowledgeInbound(): Promise<void> {
    throw new EinvoiceProviderNotImplementedError("acknowledgeInbound");
  }
}
