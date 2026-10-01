import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getEinvoiceProvider } from "@/lib/einvoice/provider";
import { createSupabaseOutboundStore } from "@/lib/einvoice/outbound/supabase-store";
import { runOutboundReconcileBatch, runOutboundSendBatch } from "@/lib/einvoice/outbound/worker";

// =============================================================================
// GET /api/cron/einvoice-outbound — worker E-Faktúry (odoslanie + reconciliation).
//
// Chránené CRON_SECRET (Authorization: Bearer …), rovnaký vzor ako
// /api/cron/deadline-notifications. Bez nakonfigurovaného poskytovateľa
// (ESBLU_EINVOICE_*) nič nerobí. Plánovanie (vercel.json) sa ZATIAĽ
// nepridáva — aktivuje sa až pri produkčnom spustení (Phase 6).
//
// Paralelizmus: jeden beh spracuje najviac `batch` riadkov sekvenčne (DB strop
// 10, claim FOR UPDATE SKIP LOCKED + lease) — súbežné behy si riadky nezoberú.
// Odpoveď: iba počty a strojové kódy, nič o obsahu dokladov ani poskytovateľovi.
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

function batchSize(): number {
  const value = Number(process.env.ESBLU_EINVOICE_WORKER_BATCH);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 5;
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ success: false }, { status: 401 });

  let runtimeConfig = null;
  try {
    runtimeConfig = getEinvoiceProvider();
  } catch {
    runtimeConfig = null;
  }
  if (!runtimeConfig) return Response.json({ success: true, configured: false });

  const deps = { store: createSupabaseOutboundStore(), provider: runtimeConfig.provider };
  const options = { batchSize: batchSize(), leaseSeconds: 120, reconcileAfterSeconds: 300 };
  const reconcile = await runOutboundReconcileBatch(deps, options);
  const send = await runOutboundSendBatch(deps, options);

  const summarize = (r: typeof send) => ({
    claimed: r.claimed,
    results: r.results.map((x) => ({ id: x.outboundId, from: x.from, to: x.to, code: x.code })),
  });
  return Response.json(
    { success: true, configured: true, environment: runtimeConfig.environment, reconcile: summarize(reconcile), send: summarize(send) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
