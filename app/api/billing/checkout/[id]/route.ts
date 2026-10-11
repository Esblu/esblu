import { authorizeBillingCaller, billingErrorResponse } from "@/lib/billing/server";

// -----------------------------------------------------------------------------
// GET /api/billing/checkout/[id] — serverový stav checkout zámeru vlastnej
// firmy (polling po návrate z checkoutu). Cudzí aj neexistujúci → found:false.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 400 });
  const { data, error } = await who.db.rpc("esblu_get_my_checkout_status", { p_checkout_id: id });
  if (error) return billingErrorResponse(error);
  return Response.json({ success: true, checkout: data }, { headers: { "Cache-Control": "no-store" } });
}
