import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { gdprRetentionPurgeEnabled } from "@/lib/retention/gdpr-purge-flag";

// -----------------------------------------------------------------------------
// GET /api/cron/telemetry-maintenance — technická údržba (cost control,
// 2026-10-25; J10 CLIA retencia 2026-11-10). Nič iné nemaže.
//
//   1. notification_deliveries: iba 'chat' dedupe riadky staršie ako
//      CHAT_DEDUPE_KEEP_DAYS (push na chat sa posiela len ≤ 5 min po správe,
//      takže dedupe riadok po pár minútach nemá funkciu). 'deadline' riadky sa
//      nemažú nikdy (kľúč „overdue“ bráni opakovanému upozorneniu).
//      Po dávkach, najviec MAX_BATCHES za beh.
//   2. ai_usage_monthly: mesiace staršie ako AI_USAGE_KEEP_MONTHS (DB vynúti
//      minimum 13). Technický default — OWNER/CLIA INFORMATIVE NOTE.
//   3. J10 CLIA (09.11.2026) technická retencia — esblu_purge_gdpr_technical_retention
//      (migrácia 20261110100000): revoked push identifikátory > 30 d, doručenia
//      notifikácií > 90 d, neprijaté pozvánky > 30 d po expirácii/zrušení,
//      dokončené deletion joby > 90 d, expirované asistent záznamy > 1 d,
//      dokončená media fronta > 90 d.
//   4. J10 CLIA: neúspešné registrácie — nepotvrdené auth účty bez členstva
//      a bez firmy staršie ako 30 dní (esblu_list_stale_unconfirmed_auth_users)
//      → auth.admin.deleteUser, najviac STALE_USERS_PER_RUN za beh.
//
//   Body 3 a 4 bežia IBA ak ESBLU_GDPR_RETENTION_PURGE_ENABLED === "true"
//   (OWNER APPROVAL — prvý produkčný beh zmaže historické riadky nad maximom
//   CLIA, pozri read-only precheck scripts/sql/prod-gdpr-retention-precheck.sql).
//   Bez flagu = "disabled", nič sa nemaže (fail safe).
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
const FAILED_REGISTRATION_KEEP_DAYS = 30;
const STALE_USERS_PER_RUN = 50;

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

  const gdprEnabled = gdprRetentionPurgeEnabled();
  let gdprRetention: Record<string, number> = {};
  let gdprStatus: "ok" | "skipped" | "error" | "disabled" = gdprEnabled ? "ok" : "disabled";
  for (let batch = 0; gdprEnabled && batch < MAX_BATCHES; batch++) {
    const { data, error } = await admin.rpc("esblu_purge_gdpr_technical_retention", { p_batch_size: BATCH_SIZE });
    if (error) {
      gdprStatus = missingFunction(error.code) ? "skipped" : "error";
      if (gdprStatus === "error") console.error("cron/telemetry-maintenance: gdpr retention purge zlyhal:", error.code ?? "unknown");
      break;
    }
    const counts = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    let maxInBatch = 0;
    for (const [key, value] of Object.entries(counts)) {
      const n = typeof value === "number" ? value : 0;
      gdprRetention[key] = (gdprRetention[key] ?? 0) + n;
      maxInBatch = Math.max(maxInBatch, n);
    }
    if (maxInBatch < BATCH_SIZE) break;
  }
  if (gdprStatus !== "ok") gdprRetention = {};

  let staleUsersDeleted = 0;
  let staleUsersStatus: "ok" | "skipped" | "error" | "disabled" = gdprEnabled ? "ok" : "disabled";
  const { data: staleIds, error: staleError } = gdprEnabled
    ? await admin.rpc("esblu_list_stale_unconfirmed_auth_users", {
        p_older_than_days: FAILED_REGISTRATION_KEEP_DAYS,
        p_limit: STALE_USERS_PER_RUN,
      })
    : { data: [] as unknown[], error: null };
  if (staleError) {
    staleUsersStatus = missingFunction(staleError.code) ? "skipped" : "error";
    if (staleUsersStatus === "error") console.error("cron/telemetry-maintenance: stale registrations list zlyhal:", staleError.code ?? "unknown");
  } else {
    for (const id of ((staleIds as unknown[] | null) ?? []).filter((v): v is string => typeof v === "string")) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (!error) staleUsersDeleted += 1;
      else console.error("cron/telemetry-maintenance: stale registration delete zlyhal:", error.status ?? "unknown");
    }
  }

  const ok = chatStatus !== "error" && aiUsageStatus !== "error" && gdprStatus !== "error" && staleUsersStatus !== "error";
  return Response.json(
    {
      success: ok,
      chatDedupeDeleted: chatDeleted,
      chatDedupe: chatStatus,
      aiUsageMonthsDeleted: aiUsageDeleted,
      aiUsage: aiUsageStatus,
      gdprRetention,
      gdprRetentionStatus: gdprStatus,
      failedRegistrationsDeleted: staleUsersDeleted,
      failedRegistrations: staleUsersStatus,
    },
    { status: ok ? 200 : 500 }
  );
}
