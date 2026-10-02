import "server-only";

import { handleInboundDetail } from "@/lib/einvoice/ui/routes";

// GET /api/einvoice/inbound/[id] — detail prijatej e-faktúry (stav, časová os, povolené akcie). RLS, finance.view.

export const runtime = "nodejs";

export function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleInboundDetail(req, context);
}
