// =============================================================================
// E-Faktúra UI — tvary odpovedí serverových summary routes (klient aj server).
//
// Server posiela iba to, čo UI potrebuje: stavy, kategórie, časy, strojové
// kódy a povolené akcie. NIKDY: ID poskytovateľa, Idempotency-Key, cesty v
// storage, participant ID, surový dôkaz doručenia, UUID používateľov.
// =============================================================================

import type { ReadinessResult } from "../readiness.ts";

export type EinvoiceAccess = {
  financeManage: boolean;
  entitlementActive: boolean;
  providerConfigured: boolean;
};

export type EinvoiceTimelineItem = {
  at: string;
  /** transition = zmena stavu; action = operátorská akcia (reconcile / retry / …). */
  kind: "transition" | "action";
  from: string | null;
  to: string;
  source: "user" | "system" | "provider";
  /** „self" = aktuálny používateľ; „user" = iný používateľ firmy (meno sa neprenáša); null = systém. */
  actor: "self" | "user" | null;
  /** Strojový kód (OPERATOR_* alebo kód chyby/stavu poskytovateľa) — UI ho prekladá. */
  code: string | null;
};

export type OutboundEvidenceDto = {
  deliveryState: string | null;
  deliveredAt: string | null;
  transactions: number;
};

export type OutboundAttemptDto = {
  id: string;
  attempt: number;
  state: string;
  category: string;
  updatedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  lastErrorCode: string | null;
  outcomeUnknown: boolean;
  hasDocument: boolean;
  evidence: OutboundEvidenceDto | null;
};

export type OutboundAllowedActions = { send: boolean; reconcile: boolean; retry: boolean };

export type OutboundSummaryDto = {
  kind: "outbound";
  documentStatus: string;
  access: EinvoiceAccess;
  readiness: ReadinessResult | null;
  attempts: OutboundAttemptDto[];
  timeline: EinvoiceTimelineItem[];
  allowed: OutboundAllowedActions;
};

export type InboundNotice = "credit_note_unsupported" | "manual_review" | null;

export type InboundItemDto = {
  id: string;
  status: string;
  category: string;
  receivedAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  documentNumber: string | null;
  documentType: string | null;
  issueDate: string | null;
  invoiceId: string | null;
  invoiceStatus: string | null;
  supplierName: string | null;
  total: number | null;
  currency: string | null;
  lastErrorCode: string | null;
  reviewReasons: string[];
  dedupeMatchedOn: string | null;
  isTest: boolean;
  hasXml: boolean;
  notice: InboundNotice;
};

export type InboundAllowedActions = { reprocess: boolean; ackRetry: boolean };

export type InboundDetailDto = {
  kind: "inbound";
  access: EinvoiceAccess;
  item: InboundItemDto;
  timeline: EinvoiceTimelineItem[];
  allowed: InboundAllowedActions;
};

export type InboundListDto = { access: EinvoiceAccess; items: InboundItemDto[] };

export type InvoiceEinvoiceSummaryDto = OutboundSummaryDto | InboundDetailDto | { kind: "none"; access: EinvoiceAccess };
