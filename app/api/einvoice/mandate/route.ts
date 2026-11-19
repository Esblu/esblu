import "server-only";

import { handleMandateGet, handleMandatePost } from "@/lib/einvoice/ui/mandate-routes";

// GET  /api/einvoice/mandate — stav elektronického poverenia aktívnej firmy (finance.view).
// POST /api/einvoice/mandate — {action:"revoke", confirm_revoke:true} alebo
//      {action:"grant", confirm_mandate:true, mandate_version} (finance.manage).

export const runtime = "nodejs";
export const maxDuration = 30;

export function GET(req: Request) {
  return handleMandateGet(req);
}

export function POST(req: Request) {
  return handleMandatePost(req);
}
