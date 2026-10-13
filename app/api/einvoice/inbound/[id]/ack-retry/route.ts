import "server-only";

import { handleOperatorPost } from "@/lib/einvoice/ops/routes";

// POST /api/einvoice/inbound/[id]/ack-retry — opakovanie ACK poskytovateľovi
// IBA s existujúcim konceptom a overeným uloženým XML (idempotentné).
// Dokončenie transportu — nárok einvoice sa nevyžaduje. Telo: { "confirm_action": true }.

export const runtime = "nodejs";
export const maxDuration = 30;

export function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleOperatorPost(req, context, "inbound", "inbound_ack_retry");
}
