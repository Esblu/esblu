import "server-only";

import { handleOperatorPost } from "@/lib/einvoice/ops/routes";

// POST /api/einvoice/outbound/[id]/reconcile — manuálna reconciliation jedného
// podania (lease, iba dotaz u poskytovateľa, NIKDY neodosiela, idempotentné).
// Telo: { "confirm_action": true, "reason_code"?: "<kód>" }. Pravidlá rozhoduje DB.

export const runtime = "nodejs";
export const maxDuration = 30;

export function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleOperatorPost(req, context, "outbound", "outbound_reconcile");
}
