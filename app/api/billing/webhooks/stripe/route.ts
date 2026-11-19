import { getBillingServerMode } from "@/lib/billing/config";
import { processWebhook } from "@/lib/billing/pipeline";
import { getWebBillingProvider } from "@/lib/billing/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/webhooks/stripe — Stripe webhook (test ALEBO live podľa režimu servera, S15).
// Raw body (req.text()) → overenie Stripe-Signature (HMAC, tolerancia 300 s) secretom PRÁVE
// aktívneho prostredia → `livemode` udalosti musí zodpovedať prostrediu (test ↔ live → 400)
// → dedupe/uloženie (DB odmietne prostredie ≠ billing_runtime_config.environment)
// → refetch predplatného z API → kanonický stav → nároky. Billing vypnutý → 404.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const mode = getBillingServerMode();
  if (mode !== "stripe_test" && mode !== "stripe_live") return new Response(null, { status: 404 });
  const rawBody = await req.text();
  if (rawBody.length > 512 * 1024) return new Response(null, { status: 413 });
  const provider = getWebBillingProvider("stripe");
  if (!provider) return new Response(null, { status: 404 });
  const result = await processWebhook(provider, rawBody, req.headers, getSupabaseAdmin());
  return Response.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus });
}
