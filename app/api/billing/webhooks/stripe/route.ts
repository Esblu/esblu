import { getBillingServerMode } from "@/lib/billing/config";
import { processWebhook } from "@/lib/billing/pipeline";
import { StripeTestProvider } from "@/lib/billing/providers/stripe";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/webhooks/stripe — Stripe TEST MODE webhook.
// Raw body (req.text()) → overenie Stripe-Signature (HMAC, tolerancia 300 s)
// → dedupe/uloženie → refetch predplatného z API → kanonický stav → nároky.
// livemode=true alebo live kľúč → 400. Mimo režimu stripe_test → 404.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (getBillingServerMode() !== "stripe_test") return new Response(null, { status: 404 });
  const rawBody = await req.text();
  if (rawBody.length > 512 * 1024) return new Response(null, { status: 413 });
  const provider = new StripeTestProvider({
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    apiVersion: process.env.STRIPE_API_VERSION || undefined,
  });
  const result = await processWebhook(provider, rawBody, req.headers, getSupabaseAdmin());
  return Response.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus });
}
