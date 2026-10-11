import { timingSafeEqual } from "node:crypto";
import { sendStoreReport, StoreReportError, type StoreReportRow } from "@/lib/billing/stores/store-reporting";
import { getAppleStoreApi, getGooglePlayApi, getStoreMode } from "@/lib/billing/stores/store-config";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/cron/billing-store-reports — odošle splatné reporty obchodom:
//   Google External Transactions (do 24 h), Apple External Purchase (mesačne).
// Chránené CRON_SECRET. ZÁMERNE nie je vo vercel.json (žiadny produkčný cron).
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
  if (getStoreMode() === "off") return Response.json({ success: true, configured: false, sent: 0 });
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc("esblu_billing_claim_store_reports", { p_limit: 50 });
  if (error) return Response.json({ success: false }, { status: 500 });
  const apis = { google: getGooglePlayApi(), apple: getAppleStoreApi() };
  let sent = 0;
  let failed = 0;
  for (const row of (data as StoreReportRow[] | null) ?? []) {
    try {
      await sendStoreReport(row, apis);
      await admin.rpc("esblu_billing_complete_store_report", { p_id: row.id, p_ok: true, p_error: null });
      sent++;
    } catch (e) {
      const code = e instanceof StoreReportError ? e.code : "STORE_API_ERROR";
      await admin.rpc("esblu_billing_complete_store_report", { p_id: row.id, p_ok: false, p_error: code });
      failed++;
    }
  }
  return Response.json({ success: true, sent, failed });
}
