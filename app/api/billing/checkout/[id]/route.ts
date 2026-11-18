import { authorizeBillingCaller, billingErrorResponse, getWebBillingProvider } from "@/lib/billing/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/billing/checkout/[id] — serverový stav checkout zámeru vlastnej
// firmy (polling po návrate z checkoutu). Cudzí aj neexistujúci → found:false.
//
// POST /api/billing/checkout/[id]  { action: "cancel" } — zrušenie rozpracovanej
// platby (návrat z checkoutu s ?checkout=canceled alebo tlačidlo). Poradie:
// 1) DB overí vlastníka a firmu (esblu_billing_checkout_for_cancel),
// 2) server expiruje reláciu U PROVIDERA (Stripe /expire) — až potom
// 3) uzavrie zámer v DB (service_role). Ak medzitým platba prebehla
//    (`complete`), zámer sa neuzatvára — dokončí ho webhook.
// Provider identifikátory sa do prehliadača neposielajú.
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

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!UUID_RE.test(id) || body?.action !== "cancel") {
    return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 400 });
  }

  const info = await who.db.rpc("esblu_billing_checkout_for_cancel", { p_checkout_id: id });
  if (info.error) return billingErrorResponse(info.error);
  const row = info.data as { found: boolean; provider?: string; provider_session_id?: string | null; status?: string } | null;
  if (!row?.found) return Response.json({ success: false, code: "ESBLU_BILLING_INVALID_REQUEST" }, { status: 404 });
  if (row.status !== "created" && row.status !== "open") {
    return Response.json({ success: true, status: row.status }, { headers: { "Cache-Control": "no-store" } });
  }

  if (row.provider_session_id) {
    const provider = getWebBillingProvider(row.provider ?? "");
    if (!provider?.expireCheckout) return Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 503 });
    let remote: Awaited<ReturnType<NonNullable<typeof provider.expireCheckout>>>;
    try {
      remote = await provider.expireCheckout(row.provider_session_id);
    } catch {
      return Response.json({ success: false, code: "ESBLU_BILLING_PROVIDER_ERROR" }, { status: 502 });
    }
    if (remote === "complete") {
      // Platba prebehla — zámer dokončí webhook, nič sa neuzatvára.
      return Response.json({ success: true, status: "completing" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (remote !== "expired") return Response.json({ success: false, code: "ESBLU_BILLING_PROVIDER_ERROR" }, { status: 502 });
  }

  const marked = await getSupabaseAdmin().rpc("esblu_billing_mark_checkout_expired", { p_checkout_id: id });
  if (marked.error) return billingErrorResponse(marked.error);
  return Response.json({ success: true, status: marked.data }, { headers: { "Cache-Control": "no-store" } });
}
