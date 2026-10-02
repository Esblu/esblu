import { OPERATOR_REASON_CODES, type OperatorReasonCode } from "./store.ts";

// =============================================================================
// Telo operátorských POST routes — striktný allowlist. Čistá funkcia.
// Povolené IBA: confirm_action (musí byť true) a voliteľný reason_code z
// pevného zoznamu. company_id, rola, prostredie, ID poskytovateľa, kľúče…
// = odmietnuté (nie ignorované). Žiadny voľný text do auditu.
// =============================================================================

const ALLOWED = new Set(["confirm_action", "reason_code"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OperatorBody =
  | { ok: true; reasonCode: OperatorReasonCode | null }
  | { ok: false; code: "INVALID_BODY" | "UNEXPECTED_FIELDS" | "CONFIRMATION_REQUIRED" | "INVALID_REASON_CODE" };

export function parseOperatorBody(raw: unknown): OperatorBody {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "INVALID_BODY" };
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((k) => !ALLOWED.has(k))) return { ok: false, code: "UNEXPECTED_FIELDS" };
  if (body.confirm_action !== true) return { ok: false, code: "CONFIRMATION_REQUIRED" };
  if (body.reason_code === undefined || body.reason_code === null) return { ok: true, reasonCode: null };
  if (typeof body.reason_code !== "string" || !(OPERATOR_REASON_CODES as readonly string[]).includes(body.reason_code)) {
    return { ok: false, code: "INVALID_REASON_CODE" };
  }
  return { ok: true, reasonCode: body.reason_code as OperatorReasonCode };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
