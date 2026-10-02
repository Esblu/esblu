// =============================================================================
// E-Faktúra — operátorská / prevádzková privilegovaná vrstva (rozhranie).
// Produkčná implementácia: ops/supabase-store.ts (service_role, iba serverové RPC).
// =============================================================================

import type { EinvoiceEnvironment } from "../provider/types.ts";

export type OperatorKind = "outbound" | "inbound";
export type OperatorAction = "outbound_reconcile" | "outbound_retry" | "inbound_reprocess" | "inbound_ack_retry";

export const OPERATOR_REASON_CODES = ["OPERATOR_REQUEST", "PROVIDER_CONFIRMED", "DATA_FIXED", "CUSTOMER_REQUEST"] as const;
export type OperatorReasonCode = (typeof OPERATOR_REASON_CODES)[number];

export type OperatorBeginResult = { kind: OperatorKind; row: Record<string, unknown> };

export type WebhookRejectionReason = "INVALID_SIGNATURE" | "REPLAYED_WEBHOOK" | "PAYLOAD_TOO_LARGE" | "INVALID_PAYLOAD";

export interface OpsStore {
  operatorBegin(input: {
    actorUserId: string;
    kind: OperatorKind;
    id: string;
    action: OperatorAction;
    reasonCode: OperatorReasonCode | null;
    leaseSeconds: number;
    cooldownSeconds: number;
  }): Promise<OperatorBeginResult>;
  health(stuckMinutes: number, ackPendingMinutes: number): Promise<unknown>;
  retention(olderThanDays: number, limit: number): Promise<{ older_than_days: number; webhook_events_deleted: number; rejection_buckets_deleted: number }>;
  storageConsistency(): Promise<Record<string, number>>;
  recordWebhookRejection(provider: string, environment: EinvoiceEnvironment, reason: WebhookRejectionReason): Promise<void>;
}

export class OpsStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "OpsStoreError";
    this.code = code;
  }
}
