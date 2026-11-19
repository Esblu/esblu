import { timingSafeEqual } from "node:crypto";
import { getBillingServerMode } from "@/lib/billing/config";
import { recordHeartbeat } from "@/lib/billing/ops-alerts";
import { runReconciliation, type ReconcileSource } from "@/lib/billing/reconciliation";
import { appleReconcileSource, googleReconcileSource, providerReconcileSource } from "@/lib/billing/reconcile-sources";
import { getWebBillingProvider } from "@/lib/billing/server";
import { getAppleStoreApi, getAppleVerifier, getGooglePlayApi, getStoreMode } from "@/lib/billing/stores/store-config";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { BillingProviderId } from "@/lib/billing/types";

// -----------------------------------------------------------------------------
// GET /api/cron/billing-reconcile — self-healing: overí otvorené predplatné
// u providera a opraví drift tou istou pipeline ako webhook.
// Chránené CRON_SECRET. Vo vercel.json od 2026-11-19 (S12, schválené vlastníkom): každých 6 h.
// Vercel Cron beží iba na produkčnom nasadení, kde je billing tvrdo vypnutý (VERCEL_ENV=production
// → režim off) → `configured:false`, žiadne volanie providera, kým sa billing výslovne nezapne.
// Odpoveď obsahuje iba počty a kódy výsledkov (žiadne identifikátory).
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
  const sources: Partial<Record<BillingProviderId, ReconcileSource>> = {};
  if (getBillingServerMode() !== "off") {
    const web = getWebBillingProvider();
    if (web) sources[web.id] = providerReconcileSource(web);
  }
  if (getStoreMode() !== "off") {
    const google = getGooglePlayApi();
    if (google) sources.google = googleReconcileSource(google);
    const apple = getAppleStoreApi();
    const verifier = getAppleVerifier();
    if (apple && verifier) sources.apple = appleReconcileSource(apple, verifier);
  }
  if (Object.keys(sources).length === 0) return Response.json({ success: true, configured: false, checked: 0 });
  const admin = getSupabaseAdmin();
  // P4: heartbeat pre ops alert CRON_RECONCILE_FAILING (prostredie webového providera; obchody sú vždy test).
  const heartbeatEnv = sources.stripe?.environment ?? sources.fake?.environment ?? "test";
  try {
    const { checked, results } = await runReconciliation(admin, sources, { limit: 50 });
    const summary: Record<string, number> = {};
    for (const r of results) summary[r.result] = (summary[r.result] ?? 0) + 1;
    await recordHeartbeat(admin, "reconcile", heartbeatEnv, true);
    return Response.json({ success: true, checked, summary });
  } catch {
    await recordHeartbeat(admin, "reconcile", heartbeatEnv, false, "RECONCILE_FAILED");
    return Response.json({ success: false, code: "RECONCILE_FAILED" }, { status: 500 });
  }
}
