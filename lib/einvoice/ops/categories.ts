// =============================================================================
// E-Faktúra — operátorské kategórie (ODVODENÉ, bez nových stavov).
//
// Zrkadlo DB funkcií esblu_einvoice_outbound_category / _inbound_category
// (migrácia 20261002140000_einvoice_operations) — test overuje zhodu.
// Primárny transportný state machine sa nemení.
// =============================================================================

export type OutboundCategory =
  | "retryable"
  | "reconciliation_required"
  | "retry_exhausted_unknown"
  | "permanent_failure"
  | "rejected"
  | "delivered";

export type InboundCategory = "retryable" | "ack_pending" | "failed" | "duplicate" | "acknowledged";

export function outboundCategory(row: {
  state: string;
  provider_submission_id: string | null;
  next_retry_at: string | null;
  last_error_code: string | null;
}): OutboundCategory {
  if (row.state === "delivered") return "delivered";
  if (row.state === "rejected") return "rejected";
  if (row.state === "failed") return "permanent_failure";
  if (row.state === "sending" && row.provider_submission_id === null && row.last_error_code === "EINVOICE_RETRY_EXHAUSTED_UNKNOWN") {
    return "retry_exhausted_unknown";
  }
  if (row.provider_submission_id !== null || (row.state === "sending" && row.next_retry_at === null)) return "reconciliation_required";
  return "retryable";
}

export function inboundCategory(row: { processing_status: string; dedupe_matched_on: string | null }): InboundCategory {
  if (row.processing_status === "duplicate" || (row.processing_status === "acknowledged" && row.dedupe_matched_on !== null)) return "duplicate";
  if (row.processing_status === "acknowledged") return "acknowledged";
  if (row.processing_status === "ack_pending" || row.processing_status === "draft_created") return "ack_pending";
  if (row.processing_status === "failed") return "failed";
  return "retryable";
}
