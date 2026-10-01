// =============================================================================
// Telo POST /api/einvoice/outbound — striktný allowlist. Čistá funkcia.
//
// Povolené IBA: invoice_id (UUID) a confirm_send (musí byť true — výslovný
// úmysel používateľa). Čokoľvek iné (company_id, environment, role,
// participant_id, kľúče…) = odmietnuté, nie ignorované.
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = new Set(["invoice_id", "confirm_send"]);

export type OutboundRequestBody =
  | { ok: true; invoiceId: string }
  | { ok: false; code: "INVALID_BODY" | "UNEXPECTED_FIELDS" | "INVALID_INVOICE_ID" | "CONFIRMATION_REQUIRED" };

export function parseOutboundRequestBody(raw: unknown): OutboundRequestBody {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "INVALID_BODY" };
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !ALLOWED.has(key))) return { ok: false, code: "UNEXPECTED_FIELDS" };
  if (typeof body.invoice_id !== "string" || !UUID_RE.test(body.invoice_id)) return { ok: false, code: "INVALID_INVOICE_ID" };
  if (body.confirm_send !== true) return { ok: false, code: "CONFIRMATION_REQUIRED" };
  return { ok: true, invoiceId: body.invoice_id.toLowerCase() };
}
