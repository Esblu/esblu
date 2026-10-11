import { timingSafeEqual } from "node:crypto";
import { getBillingServerMode } from "@/lib/billing/config";
import { runReconciliation, type ReconcileSource } from "@/lib/billing/reconciliation";
import { appleReconcileSource, googleReconcileSource, providerReconcileSource } from "@/lib/billing/reconcile-sources";
import { getWebBillingProvider } from "@/lib/billing/server";
import { getAppleStoreApi, getAppleVerifier, getGooglePlayApi, getStoreMode } from "@/lib/billing/stores/store-config";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { BillingProviderId } from "@/lib/billing/types";

// -----------------------------------------------------------------------------
// GET /api/cron/billing-reconcile — self-healing: overí otvorené predplatné
// u providera a opraví drift tou istou pipeline ako webhook.
// Chránené CRON_SECRET. ZÁMERNE nie je vo vercel.json (žiadny produkčný cron) —
// zapína sa až po schválení (docs/subscriptions-production-readiness-2026-10-11.md).
// Odpoveď obsahuje iba počty a kódy výsledkov (žiadne identifikátory).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  try {
    const { checked, results } = await runReconciliation(getSupabaseAdmin(), sources, { limit: 50 });
    const summary: Record<string, number> = {};
    for (const r of results) summary[r.result] = (summary[r.result] ?? 0) + 1;
    return Response.json({ success: true, checked, summary });
  } catch {
    return Response.json({ success: false, code: "RECONCILE_FAILED" }, { status: 500 });
  }
}
