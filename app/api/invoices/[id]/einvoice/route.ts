import "server-only";

import { handleInvoiceEinvoiceSummary } from "@/lib/einvoice/ui/routes";

// GET /api/invoices/[id]/einvoice — prehľad E-Faktúry pre detail faktúry:
// vydaná → readiness + pokusy o doručenie + časová os + povolené akcie;
// prijatá z Peppolu → stav príjmu + časová os + povolené akcie.
// Read-only, pod RLS volajúceho (finance.view); bez ID poskytovateľa, kľúčov a UUID iných používateľov.

export const runtime = "nodejs";

export function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleInvoiceEinvoiceSummary(req, context);
}
