import "server-only";

import { handleInboundList } from "@/lib/einvoice/ui/routes";

// GET /api/einvoice/inbound — prijaté e-faktúry aktívnej firmy (RLS, finance.view), najnovšie prvé.

export const runtime = "nodejs";

export function GET(req: Request) {
  return handleInboundList(req);
}
