import { processWebhook } from "@/lib/billing/pipeline";
import { getFakeProviderForStaging } from "@/lib/billing/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/webhooks/fake — webhook FAKE providera (iba staging,
// ESBLU_BILLING_MODE=fake, nikdy VERCEL_ENV=production). Rovnaká pipeline a
// rovnaká podpisová schéma ako Stripe → overuje podpis, replay, dedupe, poradie.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const provider = getFakeProviderForStaging();
  if (!provider) return new Response(null, { status: 404 });
  const rawBody = await req.text();
  if (rawBody.length > 64 * 1024) return new Response(null, { status: 413 });
  const result = await processWebhook(provider, rawBody, req.headers, getSupabaseAdmin());
  return Response.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus });
}
