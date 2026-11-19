import { timingSafeEqual } from "node:crypto";
import { billingEnvironmentForMode, getBillingServerMode } from "@/lib/billing/config";
import { runDocumentArchive } from "@/lib/billing/document-archive";
import { recordHeartbeat } from "@/lib/billing/ops-alerts";
import { supabaseArchiveStorage } from "@/lib/billing/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/cron/billing-documents — P4: archív PDF Stripe faktúr a dobropisov do privátneho bucketu
// `billing-documents` (SHA-256 + cesta v billing_invoice_documents; účtovná kópia Esblu).
// Sťahuje IBA z *.stripe.com, bez prepisu existujúcich objektov; chyby = backoff v DB a ops alert.
// Chránené CRON_SECRET. Billing vypnutý → configured:false (žiadne volanie Stripe ani DB).
// Odpoveď: iba počty a kód.
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
  const result = await runDocumentArchive(admin, environment, supabaseArchiveStorage(admin), { limit: 20 });
  const ok = !result.errorCode;
  await recordHeartbeat(admin, "documents", environment, ok, result.errorCode ?? null);
  return Response.json({ success: ok, configured: true, ...result }, { status: ok ? 200 : 500, headers: { "Cache-Control": "no-store" } });
}
