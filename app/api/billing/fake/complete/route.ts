import { processWebhook } from "@/lib/billing/pipeline";
import { authorizeBillingCaller, getFakeProviderForStaging } from "@/lib/billing/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/fake/complete   { checkoutId, outcome: "paid" | "failed" }
// STAGING ONLY — simulácia „hosted checkout" fake providera. Volajúci musí byť
// MANAGE rola firmy, ktorej patrí checkout zámer (overené v DB). Výsledok sa
// NEZAPISUJE priamo: vytvorí sa podpísaný fake webhook a prejde tou istou
// pipeline (podpis → dedupe → normalizácia → kanonický stav → nároky).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const provider = getFakeProviderForStaging();
  if (!provider) return new Response(null, { status: 404 });
  const who = await authorizeBillingCaller(req);
  if ("response" in who) return who.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const checkoutId = typeof body?.checkoutId === "string" && UUID_RE.test(body.checkoutId) ? body.checkoutId : null;
  if (!checkoutId) return Response.json({ success: false }, { status: 400 });

  const access = await who.db.rpc("esblu_billing_my_access");
  const companyId = (access.data as { company_id?: string; can_manage?: boolean } | null)?.company_id;
  if (access.error || (access.data as { can_manage?: boolean } | null)?.can_manage !== true || !companyId) {
    return Response.json({ success: false, code: "ESBLU_BILLING_FORBIDDEN" }, { status: 403 });
  }
  const { data: checkout } = await getSupabaseAdmin()
    .from("billing_checkout_sessions")
    .select("id, company_id, provider, provider_price_id, billing_interval, status")
    .eq("id", checkoutId)
    .maybeSingle();
  if (!checkout || checkout.company_id !== companyId || checkout.provider !== "fake") {
    return Response.json({ success: false }, { status: 404 });
  }
  if (checkout.status !== "created" && checkout.status !== "open") {
    return Response.json({ success: false, code: "ESBLU_BILLING_CHECKOUT_STATE" }, { status: 409 });
  }
  if (body?.outcome === "failed") {
    return Response.json({ success: true, outcome: "payment_failed_no_subscription" });
  }

  const state = await provider.simulateCheckoutPaid({
    checkoutId,
    providerPriceId: checkout.provider_price_id,
    interval: checkout.billing_interval,
  });
  const signed = provider.signEvent(provider.buildEvent("fake.checkout.completed", state));
  const result = await processWebhook(provider, signed.rawBody, signed.headers, getSupabaseAdmin());
  return Response.json({ success: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus < 300 ? 200 : 500 });
}
