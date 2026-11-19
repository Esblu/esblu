import { timingSafeEqual } from "node:crypto";
import { billingEnvironmentForMode, getBillingServerMode } from "@/lib/billing/config";
import { runEventCatchup } from "@/lib/billing/event-catchup";
import { runFailedEventRetry } from "@/lib/billing/event-retry";
import { recordHeartbeat } from "@/lib/billing/ops-alerts";
import { getWebBillingProvider } from "@/lib/billing/server";
import { StripeProvider } from "@/lib/billing/providers/stripe";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/cron/billing-stripe-events — S12: doťahovanie zmeškaných Stripe udalostí
// (refundácie, spory, zmeny a ukončenie predplatného) tou istou pipeline ako webhook.
// Chránené CRON_SECRET (Vercel Cron posiela `Authorization: Bearer <CRON_SECRET>`).
// Billing vypnutý (produkcia bez schváleného live režimu je tvrdo off) alebo DB web_provider = fake
// → `configured:false`, ŽIADNE volanie Stripe. Prostredie servera ≠ DB environment → 503 ENVIRONMENT_MISMATCH.
// P4: po doťahovaní opakuje zlyhané udalosti (backoff, max. pokusy, dead-letter — lib/billing/event-retry.ts)
// a zapíše heartbeat (ops alert CRON_STRIPE_EVENTS_FAILING pri opakovanom zlyhaní / výpadku).
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
  const mode = getBillingServerMode();
  if (mode !== "stripe_test" && mode !== "stripe_live") return Response.json({ success: true, configured: false });
  const admin = getSupabaseAdmin();
  const { data: config, error } = await admin.from("billing_runtime_config").select("web_provider, environment").maybeSingle();
  if (error) return Response.json({ success: false, code: "CONFIG_READ_FAILED" }, { status: 500 });
  // web_provider = PREDAJ (nové nákupy). `none` = predaj pozastavený, ale existujúce predplatné sa ďalej
  // synchronizujú (doťahovanie beží). Vypína ho iba režim servera alebo iný provider (fake).
  if (config?.web_provider !== "stripe" && config?.web_provider !== "none") return Response.json({ success: true, configured: false });
  // S15: prostredie servera (test / live) sa musí zhodovať s DB — inak nič (fail closed, prevádzkový alarm).
  if (config.environment !== billingEnvironmentForMode(mode)) {
    return Response.json({ success: false, configured: true, code: "ENVIRONMENT_MISMATCH" }, { status: 503 });
  }
  const provider = getWebBillingProvider("stripe", config.environment);
  if (!(provider instanceof StripeProvider)) return Response.json({ success: true, configured: false });

  const result = await runEventCatchup(admin, provider, provider, { maxEvents: 200, maxPages: 20, timeBudgetMs: 40_000 });
  // Retry iba ak doťahovanie neskončilo chybou účtu (cudzí Stripe účet → nič nespracovať).
  const retry = result.result === "account_mismatch" ? null : await runFailedEventRetry(admin, provider, provider, { limit: 20, timeBudgetMs: 12_000 });
  const status = result.result === "error" || result.result === "account_mismatch" ? 500 : 200;
  await recordHeartbeat(admin, "stripe_events", provider.environment, status === 200 && !retry?.errorCode, result.errorCode ?? retry?.errorCode ?? null);
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
      retry: retry ? { claimed: retry.claimed, outcomes: retry.outcomes, code: retry.errorCode ?? null } : null,
    },
    { status },
  );
}
