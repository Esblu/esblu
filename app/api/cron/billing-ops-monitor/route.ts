import { timingSafeEqual } from "node:crypto";
import { billingEnvironmentForMode, getBillingServerMode } from "@/lib/billing/config";
import { recordHeartbeat, resendMailerFromEnv, runOpsMonitor } from "@/lib/billing/ops-alerts";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/cron/billing-ops-monitor — P4: billing ops alerty (každých 15 min).
// Vyhodnotí stav DB (zlyhané / dead-letter udalosti, oneskorenie doťahovania, reconciliation,
// heartbeat cronov, refundácie bez dobropisu, archív PDF), uloží deduplikované alerty
// (billing_ops_alerts) a nové otvorené pošle e-mailom, ak je nastavené RESEND_API_KEY +
// ESBLU_OPS_ALERT_EMAIL_TO + ESBLU_OPS_ALERT_EMAIL_FROM. Otvorený KRITICKÝ alert → HTTP 503
// (beh cronu sa vo Vercel monitoringu prejaví ako zlyhanie — rovnaký vzor ako einvoice-maintenance).
// Chránené CRON_SECRET. Billing vypnutý → configured:false bez prístupu k DB.
// Odpoveď: iba kódy a počty (žiadne identifikátory, sumy, e-maily ani tajomstvá).
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
  const environment = billingEnvironmentForMode(mode);
  if ((mode !== "stripe_test" && mode !== "stripe_live") || !environment) return Response.json({ success: true, configured: false });
  const admin = getSupabaseAdmin();
  const { data: config, error } = await admin.from("billing_runtime_config").select("environment").maybeSingle();
  if (error) return Response.json({ success: false, code: "CONFIG_READ_FAILED" }, { status: 500 });
  if (config?.environment !== environment) {
    return Response.json({ success: false, configured: true, code: "ENVIRONMENT_MISMATCH" }, { status: 503 });
  }
  try {
    const result = await runOpsMonitor(admin, environment, resendMailerFromEnv());
    await recordHeartbeat(admin, "ops_monitor", environment, true);
    const status = result.open.critical > 0 ? 503 : 200;
    return Response.json({ success: status === 200, configured: true, ...result }, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    await recordHeartbeat(admin, "ops_monitor", environment, false, "OPS_MONITOR_FAILED");
    return Response.json({ success: false, configured: true, code: "OPS_MONITOR_FAILED" }, { status: 500 });
  }
}
