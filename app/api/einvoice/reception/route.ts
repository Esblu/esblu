import "server-only";

import { handleReceptionGet } from "@/lib/einvoice/ui/reception-routes";

// GET /api/einvoice/reception — stav príjmu / odosielania E-Faktúry aktívnej firmy (finance.view, RLS).

export const runtime = "nodejs";

export function GET(req: Request) {
  return handleReceptionGet(req);
}
