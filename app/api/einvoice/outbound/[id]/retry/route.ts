import "server-only";

import { handleOperatorPost } from "@/lib/einvoice/ops/routes";

// POST /api/einvoice/outbound/[id]/retry — nový pokus (NOVÝ Idempotency-Key)
// IBA po rejected / potvrdenom failed; pri neistom výsledku najprv povinná
// reconciliation (vynútené v DB). Vyžaduje finance.manage + nárok einvoice.
// Telo: { "confirm_action": true, "reason_code"?: "<kód>" }.

export const runtime = "nodejs";
export const maxDuration = 30;

export function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleOperatorPost(req, context, "outbound", "outbound_retry");
}
