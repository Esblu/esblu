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

/** Rezerva pod maxDuration (60 s): posledný riadok musí dobehnúť pred koncom funkcie. */
const RUN_BUDGET_MS = 50_000;
/** Jedno odoslanie = 1 volanie poskytovateľa (timeout 20 s) + zápis. */
const SEND_ITEM_BUDGET_MS = 25_000;
/** Jedna reconciliation = stav + dôkaz (2 × 20 s) + zápis. */
const RECONCILE_ITEM_BUDGET_MS = 45_000;

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

  // Phase 6: ?mode=send | reconcile (samostatné cron záznamy), predvolene oboje.
  // Odosielanie má prednosť; každý riadok sa claimne až keď sa do termínu stihne.
  const mode = new URL(req.url).searchParams.get("mode");
  const startedAt = Date.now();
  const deps = { store: createSupabaseOutboundStore(), provider: runtimeConfig.provider };
  const base = { batchSize: batchSize(), leaseSeconds: 120, reconcileAfterSeconds: 300, deadlineMs: startedAt + RUN_BUDGET_MS };
  const empty = { claimed: 0, results: [] };
  const send = mode === "reconcile" ? empty : await runOutboundSendBatch(deps, { ...base, itemBudgetMs: SEND_ITEM_BUDGET_MS });
  const reconcile = mode === "send" ? empty : await runOutboundReconcileBatch(deps, { ...base, itemBudgetMs: RECONCILE_ITEM_BUDGET_MS });

  const summarize = (r: typeof send) => ({
    claimed: r.claimed,
    results: r.results.map((x) => ({ id: x.outboundId, from: x.from, to: x.to, code: x.code })),
  });
  return Response.json(
    { success: true, configured: true, environment: runtimeConfig.environment, reconcile: summarize(reconcile), send: summarize(send) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
