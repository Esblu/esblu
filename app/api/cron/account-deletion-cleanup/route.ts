import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { parseStorageTargets } from "@/lib/account-deletion-storage";
import { CLEANUP_MAX_ATTEMPTS, runCleanupJob } from "@/lib/account-deletion-orchestrator";
import { supabaseDeletionDeps } from "@/lib/account-deletion-deps";
import { logAccountDeletionAlert } from "@/lib/account-deletion-alert";

// -----------------------------------------------------------------------------
// GET /api/cron/account-deletion-cleanup — retry post-commit cleanupu po
// zrušení účtu (Storage súbory + auth používateľ), 2026-10-12.
//
// Job vzniká IBA v DB transakcii zrušenia (esblu_account_deletion_commit), takže
// sa tu nikdy nemaže nič, čo by patrilo existujúcej firme. Idempotentné:
// remove() chýbajúcej cesty ani deleteUser neexistujúceho používateľa nie je chyba.
// Chránené CRON_SECRET. Odpoveď = iba počty (žiadne cesty ani identifikátory).
// P1-5 (20261128100000): job ukončenia firmy (termination_id) maže aj e-faktúry pod prefixom firmy; hotovo zapíše
// iba DB overenie (esblu_cleanup_job_confirm_storage). Vyčerpané pokusy a ukončenia bez overeného výmazu súborov
// = kritický alert v logu + HTTP 503 (cron monitoring).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH = 20;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type JobRow = {
  id: string;
  user_id: string;
  company_id: string | null;
  termination_id: string | null;
  storage_targets: unknown;
  storage_status: string;
  auth_status: string;
  attempts: number;
};

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ success: false }, { status: 401 });
  const admin = getSupabaseAdmin();
  const now = new Date();
  let { data, error } = await admin
    .from("account_deletion_cleanup_jobs")
    .select("id, user_id, company_id, termination_id, storage_targets, storage_status, auth_status, attempts")
    .or("storage_status.eq.pending,auth_status.eq.pending")
    .lte("next_attempt_at", now.toISOString())
    .lt("attempts", CLEANUP_MAX_ATTEMPTS)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH);

  if (error?.code === "42703") {
    // 20261128100000 ešte nie je v DB → bez termination_id (žiadne joby ukončenia s e-faktúrami).
    ({ data, error } = await admin
      .from("account_deletion_cleanup_jobs")
      .select("id, user_id, company_id, storage_targets, storage_status, auth_status, attempts")
      .or("storage_status.eq.pending,auth_status.eq.pending")
      .lte("next_attempt_at", now.toISOString())
      .lt("attempts", CLEANUP_MAX_ATTEMPTS)
      .order("next_attempt_at", { ascending: true })
      .limit(BATCH) as unknown as { data: JobRow[] | null; error: typeof error });
  }
  if (error) {
    // Migrácia 20261012130000 ešte nie je aplikovaná → nie je čo robiť.
    if (error.code === "PGRST205" || error.code === "42P01") return Response.json({ success: true, processed: 0, skipped: "no_table" });
    console.error("cron/account-deletion-cleanup: načítanie jobov zlyhalo:", error.code ?? "unknown");
    return Response.json({ success: false }, { status: 500 });
  }

  const deps = supabaseDeletionDeps(admin);
  let completed = 0;
  let pending = 0;
  for (const row of (data ?? []) as JobRow[]) {
    const terminationCompanyId = row.termination_id && row.company_id ? row.company_id : null;
    const outcome = await runCleanupJob(deps, {
      id: row.id,
      userId: row.user_id,
      terminationCompanyId,
      storageTargets: parseStorageTargets(row.storage_targets, { terminationCompanyId }),
      storagePending: row.storage_status === "pending",
      authPending: row.auth_status === "pending",
      attempts: row.attempts,
    });
    if (outcome.storageDone && outcome.authDone) completed++;
    else pending++;
  }
  // Monitoring (iba počty): vyčerpané pokusy + ukončenia firmy bez overeného výmazu súborov > 24 h.
  const health = await admin.rpc("esblu_cleanup_health", { p_max_attempts: CLEANUP_MAX_ATTEMPTS });
  const counts = (health.data ?? {}) as { exhausted?: number; termination_unpurged_24h?: number };
  const exhausted = Number(counts.exhausted ?? 0);
  const unpurged = Number(counts.termination_unpurged_24h ?? 0);
  if (!health.error && (exhausted > 0 || unpurged > 0)) {
    logAccountDeletionAlert({ code: exhausted > 0 ? "ACCOUNT_CLEANUP_RETRY_EXHAUSTED" : "TERMINATION_STORAGE_NOT_PURGED", exhausted, unpurged });
    return Response.json({ success: false, processed: (data ?? []).length, completed, pending, exhausted, termination_unpurged: unpurged }, { status: 503 });
  }
  return Response.json({ success: true, processed: (data ?? []).length, completed, pending });
}
