import "server-only";

import { handleOperatorPost } from "@/lib/einvoice/ops/routes";

// POST /api/einvoice/inbound/[id]/reprocess — opätovné spracovanie prijatého
// dokladu (bez prepisu XML/hashu, s dedupe, nikdy druhý koncept).
// Vyžaduje finance.manage + nárok einvoice. Telo: { "confirm_action": true, "reason_code"?: "<kód>" }.

export const runtime = "nodejs";
export const maxDuration = 30;

export function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleOperatorPost(req, context, "inbound", "inbound_reprocess");
}
