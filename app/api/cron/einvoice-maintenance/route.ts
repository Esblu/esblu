import "server-only";

import { timingSafeEqual } from "node:crypto";
import { maintenanceHttpStatus, runEinvoiceMaintenance } from "@/lib/einvoice/ops/maintenance";
import { createSupabaseOpsStore } from "@/lib/einvoice/ops/supabase-store";
import { createOpsAlertSink } from "@/lib/einvoice/ops/alert-sink";
import { logOpsAlert } from "@/lib/ops-alert-log";
import { createSupabaseOpsAlertStore } from "@/lib/einvoice/ops/alert-supabase-store";
import { getEinvoiceProvider } from "@/lib/einvoice/provider";
import { EfakturaSkProvider } from "@/lib/einvoice/provider/efaktura-sk";
import { runDeregistrationBatch } from "@/lib/einvoice/deregistration";
import { createSupabaseDeregistrationStore } from "@/lib/einvoice/deregistration-supabase-store";

// =============================================================================
// GET /api/cron/einvoice-maintenance — interný health, alert kandidáti,
// retencia technických webhook dát (90 dní) a kontrola konzistencie storage.
//
// Chránené CRON_SECRET (Authorization: Bearer …) — nie bežný prihlásený
// klient. Výstup iba agregované počty a strojové kódy: žiadne firmy, IČO,
// čísla dokladov, XML, participant ID ani tajomstvá. Nič sa nemaže okrem
// uzavretých webhook metadát po retencii. Plánovanie (vercel.json) ZATIAĽ nie.
// =============================================================================

export const runtime = "nodejs";
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
  let runtimeConfig: ReturnType<typeof getEinvoiceProvider> = null;
  try {
    runtimeConfig = getEinvoiceProvider();
  } catch {
    runtimeConfig = null;
  }
  const alertStore = createSupabaseOpsAlertStore();
  const sink = createOpsAlertSink(alertStore, logOpsAlert);
  // 20261122110000: deregistračné joby (retry s backoffom) — iba s nakonfigurovaným poskytovateľom.
  const deregistration =
    runtimeConfig && runtimeConfig.provider instanceof EfakturaSkProvider
      ? await runDeregistrationBatch(
          { store: createSupabaseDeregistrationStore(), provider: runtimeConfig.provider, environment: runtimeConfig.environment, alerts: sink },
          { batchSize: 5, leaseSeconds: 120, deadlineMs: Date.now() + 30_000, itemBudgetMs: 25_000 }
        ).catch(() => ({ claimed: 0, results: [], error: "DEREGISTRATION_BATCH_FAILED" }))
      : null;
  const report = await runEinvoiceMaintenance(createSupabaseOpsStore(), { retention: true }, { store: alertStore, sink, environment: runtimeConfig?.environment ?? null });
  // Kritický alert → 503 (beh cronu sa v monitoringu prejaví ako zlyhanie); telo stále iba čísla a kódy.
  return Response.json({ success: true, ...report, deregistration }, { status: maintenanceHttpStatus(report), headers: { "Cache-Control": "no-store" } });
}
