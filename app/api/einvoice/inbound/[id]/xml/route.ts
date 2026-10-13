import "server-only";

import { handleStoredDocumentGet } from "@/lib/einvoice/ops/routes";

// GET /api/einvoice/inbound/[id]/xml — PRESNE prijaté XML (overený SHA-256).
// Prístup podľa RLS (finance.view v aktívnej firme); nárok einvoice sa
// nevyžaduje — história ostáva dostupná aj po zrušení modulu.

export const runtime = "nodejs";

export function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleStoredDocumentGet(req, context, "inbound");
}
