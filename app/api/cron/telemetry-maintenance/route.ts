import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/cron/telemetry-maintenance — technická údržba (cost control,
// 2026-10-25). Nič iné nemaže.
//
//   1. notification_deliveries: iba 'chat' dedupe riadky staršie ako
//      CHAT_DEDUPE_KEEP_DAYS (push na chat sa posiela len ≤ 5 min po správe,
//      takže dedupe riadok po pár minútach nemá funkciu). 'deadline' riadky sa
//      nemažú nikdy (kľúč „overdue“ bráni opakovanému upozorneniu).
//      Po dávkach, najviec MAX_BATCHES za beh.
//   2. ai_usage_monthly: mesiace staršie ako AI_USAGE_KEEP_MONTHS (DB vynúti
//      minimum 13). Technický default — OWNER/CLIA INFORMATIVE NOTE.
//
// Chránené CRON_SECRET. Odpoveď = iba počty.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHAT_DEDUPE_KEEP_DAYS = 7;
const AI_USAGE_KEEP_MONTHS = 25;
const BATCH_SIZE = 5_000;
const MAX_BATCHES = 20;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function missingFunction(code: string | undefined): boolean {
  // Migrácie 20261025100000 / 20261025110000 ešte nie sú aplikované → nie je čo robiť.
  return code === "PGRST202" || code === "42883";
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ success: false }, { status: 401 });
  const admin = getSupabaseAdmin();

  let chatDeleted = 0;
  let chatStatus: "ok" | "skipped" | "error" = "ok";
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { data, error } = await admin.rpc("esblu_purge_chat_notification_deliveries", {
      p_older_than_days: CHAT_DEDUPE_KEEP_DAYS,
      p_batch_size: BATCH_SIZE,
    });
    if (error) {
      chatStatus = missingFunction(error.code) ? "skipped" : "error";
      if (chatStatus === "error") console.error("cron/telemetry-maintenance: chat dedupe purge zlyhal:", error.code ?? "unknown");
      break;
    }
    const deleted = typeof data === "number" ? data : 0;
    chatDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
  }

  let aiUsageDeleted = 0;
  let aiUsageStatus: "ok" | "skipped" | "error" = "ok";
  const { data: purged, error: purgeError } = await admin.rpc("esblu_purge_ai_usage_monthly", { p_keep_months: AI_USAGE_KEEP_MONTHS });
  if (purgeError) {
    aiUsageStatus = missingFunction(purgeError.code) ? "skipped" : "error";
    if (aiUsageStatus === "error") console.error("cron/telemetry-maintenance: ai usage purge zlyhal:", purgeError.code ?? "unknown");
  } else {
    aiUsageDeleted = typeof purged === "number" ? purged : 0;
  }

  const ok = chatStatus !== "error" && aiUsageStatus !== "error";
  return Response.json(
    { success: ok, chatDedupeDeleted: chatDeleted, chatDedupe: chatStatus, aiUsageMonthsDeleted: aiUsageDeleted, aiUsage: aiUsageStatus },
    { status: ok ? 200 : 500 }
  );
}
