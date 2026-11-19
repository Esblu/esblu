import { timingSafeEqual } from "node:crypto";
import { getBillingServerMode } from "@/lib/billing/config";
import { runEventCatchup } from "@/lib/billing/event-catchup";
import { getWebBillingProvider } from "@/lib/billing/server";
import { StripeTestProvider } from "@/lib/billing/providers/stripe";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/cron/billing-stripe-events — S12: doťahovanie zmeškaných Stripe udalostí
// (refundácie, spory, zmeny a ukončenie predplatného) tou istou pipeline ako webhook.
// Chránené CRON_SECRET (Vercel Cron posiela `Authorization: Bearer <CRON_SECRET>`).
// Billing vypnutý (vrátane VERCEL_ENV=production, kde je billing tvrdo off) alebo DB
// web_provider ≠ stripe → `configured:false`, ŽIADNE volanie Stripe.
// Odpoveď obsahuje iba počty a kódy (žiadne identifikátory ani osobné údaje).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ success: false }, { status: 401 });
  if (getBillingServerMode() !== "stripe_test") return Response.json({ success: true, configured: false });
  const admin = getSupabaseAdmin();
  const { data: config, error } = await admin.from("billing_runtime_config").select("web_provider").maybeSingle();
  if (error) return Response.json({ success: false, code: "CONFIG_READ_FAILED" }, { status: 500 });
  if (config?.web_provider !== "stripe") return Response.json({ success: true, configured: false });
  const provider = getWebBillingProvider("stripe");
  if (!(provider instanceof StripeTestProvider)) return Response.json({ success: true, configured: false });

  const result = await runEventCatchup(admin, provider, provider, { maxEvents: 200, maxPages: 20, timeBudgetMs: 45_000 });
  const status = result.result === "error" || result.result === "account_mismatch" ? 500 : 200;
  return Response.json(
    {
      success: status === 200,
      configured: true,
      result: result.result,
      processed: result.processed,
      outcomes: result.outcomes,
      bootstrap: result.bootstrap,
      cursorExpired: result.cursorExpired,
      code: result.errorCode ?? null,
    },
    { status },
  );
}
