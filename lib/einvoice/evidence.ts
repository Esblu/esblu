// =============================================================================
// Dôkaz doručenia (delivery evidence) — ALLOWLIST polí na uloženie.
//
// Do einvoice_outbound.evidence sa NIKDY neukladá surová odpoveď
// poskytovateľa. Iba tento minimálny záznam: ID dokladu/správy, časové
// pečiatky, stav prenosu a hash/participant referencie. Žiadne hlavičky,
// tokeny, tajomstvá, telá požiadaviek/odpovedí ani neznáme polia.
//
// Rovnaký zoznam kľúčov vynucuje aj DB CHECK na einvoice_outbound.evidence
// (migrácia 20261002100000_einvoice_foundation) — dve nezávislé vrstvy.
// Čistá funkcia bez závislostí (testovaná v scripts/einvoice-efaktura-adapter-tests.ts).
// =============================================================================

export const EVIDENCE_SCHEMA = "esblu.einvoice.evidence.v1" as const;

/** Kľúče najvyššej úrovne povolené v einvoice_outbound.evidence (zrkadlo DB CHECK). */
export const EVIDENCE_TOP_LEVEL_KEYS = [
  "schema",
  "provider_invoice_id",
  "document_id",
  "ubl_sha256",
  "delivery_state",
  "delivered_at",
  "transactions",
] as const;

/** Kľúče jednej transportnej transakcie (AS4 / Peppol prenos). */
export const EVIDENCE_TRANSACTION_KEYS = [
  "message_id",
  "status",
  "at",
  "sender_participant_id",
  "receiver_participant_id",
] as const;

export type EvidenceTransaction = Partial<Record<(typeof EVIDENCE_TRANSACTION_KEYS)[number], string>>;

export type EinvoiceEvidenceRecord = {
  schema: typeof EVIDENCE_SCHEMA;
  provider_invoice_id: string | null;
  document_id: string | null;
  ubl_sha256: string | null;
  delivery_state: string | null;
  delivered_at: string | null;
  transactions: EvidenceTransaction[];
};

const MAX_TRANSACTIONS = 10;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9@._:/+-]{0,199}$/;
const SAFE_STATE = /^[A-Za-z_]{1,40}$/;
const PARTICIPANT = /^[0-9]{4}:[^\s:]{1,200}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pick(record: Record<string, unknown> | null, keys: readonly string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function safeState(value: unknown): string | null {
  return typeof value === "string" && SAFE_STATE.test(value) ? value.toLowerCase() : null;
}

function safeParticipant(value: unknown): string | null {
  return typeof value === "string" && PARTICIPANT.test(value) ? value : null;
}

/** ISO 8601 časová pečiatka → normalizovaný UTC ISO reťazec, inak null. */
function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeTransaction(raw: unknown): EvidenceTransaction | null {
  const t = obj(raw);
  if (!t) return null;
  const out: EvidenceTransaction = {};
  const messageId = safeId(pick(t, ["message_id", "as4_message_id", "messageId"]));
  const status = safeState(pick(t, ["status", "state"]));
  const at = safeTimestamp(pick(t, ["at", "timestamp", "created_at"]));
  const sender = safeParticipant(pick(t, ["sender_participant_id", "sender"]));
  const receiver = safeParticipant(pick(t, ["receiver_participant_id", "receiver"]));
  if (messageId) out.message_id = messageId;
  if (status) out.status = status;
  if (at) out.at = at;
  if (sender) out.sender_participant_id = sender;
  if (receiver) out.receiver_participant_id = receiver;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Odpoveď poskytovateľa (už rozbalená z `data`) → allowlistovaný záznam.
 * Čokoľvek mimo allowlistu (layers, headers, raw, tokeny, …) sa zahodí.
 */
export function sanitizeDeliveryEvidence(body: unknown): EinvoiceEvidenceRecord {
  const root = obj(body);
  const delivery = obj(root?.delivery_status);
  const sha = pick(root, ["ubl_sha256"]);
  const transactions = Array.isArray(root?.transactions)
    ? (root!.transactions as unknown[])
        .slice(0, MAX_TRANSACTIONS)
        .map(sanitizeTransaction)
        .filter((t): t is EvidenceTransaction => t !== null)
    : [];
  const state = safeState(delivery?.state);
  return {
    schema: EVIDENCE_SCHEMA,
    provider_invoice_id: safeId(pick(root, ["invoice_id"])),
    document_id: safeId(pick(root, ["document_id"])),
    ubl_sha256: typeof sha === "string" && SHA256.test(sha) ? sha.toLowerCase() : null,
    delivery_state: state,
    delivered_at: state === "delivered" ? safeTimestamp(delivery?.at) : null,
    transactions,
  };
}
