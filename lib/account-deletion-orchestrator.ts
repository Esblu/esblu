// =============================================================================
// Zrušenie účtu — orchestrácia „DB NAJPRV, súbory AŽ PO COMMITE" (2026-10-12).
//
//   A. route: auth + archivácia + owner_id + predplatné (fail closed)
//   B+C. deps.commit(): JEDNA DB transakcia (esblu_account_deletion_commit):
//        zámok firmy, zber Storage ciest, zrušenie v DB, cleanup job → commit.
//        Odmietnutie (poistka predplatného, archivácia, iná chyba) = rollback
//        a ŽIADNY Storage delete (removeStorage sa vôbec nezavolá).
//   D. removeStorage(ciele z jobu)
//   E. deleteAuthUser
//   F. čo zlyhá v D/E, ostane v jobe pending → runCleanupJob z cronu
//      (/api/cron/account-deletion-cleanup), idempotentne.
//
// Závislosti sú injektované (testovateľné bez Supabase). Nikdy nevolá
// provider API. Logy iba kódy (žiadne cesty súborov, e-maily ani tokeny).
// =============================================================================

import type { StorageTarget } from "@/lib/account-deletion-storage";

export type DeletionKind = "owner" | "member";

export type CommitResult =
  | { ok: true; jobId: string | null; storageTargets: StorageTarget[]; summary: unknown }
  | { ok: false; reason: "subscription_guard" | "db_error"; code: string };

export type AuthDeleteResult = { ok: true } | { ok: false; code: string };

export type JobPatch = {
  storage_status?: "pending" | "done";
  auth_status?: "pending" | "done";
  storage_targets?: StorageTarget[];
  attempts?: number;
  last_error_code?: string | null;
  next_attempt_at?: string;
  completed_at?: string | null;
  updated_at?: string;
};

export type DeletionDeps = {
  commit(kind: DeletionKind, userId: string): Promise<CommitResult>;
  /** Vyhodí pri zlyhaní; chýbajúca cesta nie je chyba. */
  removeStorage(targets: StorageTarget[]): Promise<number>;
  /** Neexistujúci používateľ = ok (idempotentné). */
  deleteAuthUser(userId: string): Promise<AuthDeleteResult>;
  updateJob(jobId: string, patch: JobPatch): Promise<void>;
  now?: () => Date;
};

export type CleanupJob = {
  id: string | null;
  userId: string;
  storageTargets: StorageTarget[];
  storagePending: boolean;
  authPending: boolean;
  attempts: number;
};

export type CleanupOutcome = {
  storageRemoved: number;
  storageDone: boolean;
  authDone: boolean;
  errorCode: string | null;
};

export type OrchestrationResult =
  | { status: "blocked_subscription"; code: string }
  | { status: "db_failed"; code: string }
  | { status: "deleted"; jobId: string | null; storageRemoved: number; cleanupPending: boolean; summary: unknown }
  | { status: "auth_failed"; jobId: string | null; storageRemoved: number; cleanupPending: true; code: string; summary: unknown };

export const CLEANUP_MAX_ATTEMPTS = 30;

/** Exponenciálny backoff: 15 min, 30 min, 1 h … max 24 h. */
export function nextAttemptAt(now: Date, attempts: number): string {
  const minutes = Math.min(15 * 2 ** Math.max(0, attempts - 1), 24 * 60);
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function safeCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = raw.split(":").slice(0, 2).join(":");
  return /^[A-Za-z0-9_:.-]{1,120}$/.test(code) ? code : fallback;
}

/** D + E (+ zápis stavu jobu). Rovnaká funkcia pre route aj retry cron. */
export async function runCleanupJob(deps: DeletionDeps, job: CleanupJob): Promise<CleanupOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  let storageRemoved = 0;
  let storageDone = !job.storagePending || job.storageTargets.length === 0;
  let authDone = !job.authPending;
  let errorCode: string | null = null;

  if (!storageDone) {
    try {
      storageRemoved = await deps.removeStorage(job.storageTargets);
      storageDone = true;
    } catch (error) {
      errorCode = safeCode(error, "ESBLU_STORAGE_REMOVE_FAILED");
    }
  }

  // Auth sa ruší aj keď Storage zlyhal: DB je už commitnutá (účet zrušený),
  // súbory dočistí retry. Opačné poradie by nechalo platné prihlásenie.
  if (!authDone) {
    const auth = await deps.deleteAuthUser(job.userId);
    if (auth.ok) authDone = true;
    else errorCode = errorCode ?? auth.code;
  }

  if (job.id) {
    const attempts = job.attempts + 1;
    const done = storageDone && authDone;
    try {
      await deps.updateJob(job.id, {
        storage_status: storageDone ? "done" : "pending",
        auth_status: authDone ? "done" : "pending",
        // Minimalizácia: po vyčistení sa cesty v jobe nedržia.
        ...(storageDone ? { storage_targets: [] } : {}),
        attempts,
        last_error_code: done ? null : errorCode,
        next_attempt_at: done ? now.toISOString() : nextAttemptAt(now, attempts),
        completed_at: done ? now.toISOString() : null,
        updated_at: now.toISOString(),
      });
    } catch {
      // Stav jobu sa nezapísal → ostáva pending a cron to zopakuje (idempotentné).
    }
  }
  return { storageRemoved, storageDone, authDone, errorCode };
}

export async function orchestrateAccountDeletion(deps: DeletionDeps, kind: DeletionKind, userId: string): Promise<OrchestrationResult> {
  const commit = await deps.commit(kind, userId);
  if (!commit.ok) {
    // Nič sa nezmenilo: DB rollback, Storage sa NEDOTKOL.
    return commit.reason === "subscription_guard"
      ? { status: "blocked_subscription", code: commit.code }
      : { status: "db_failed", code: commit.code };
  }

  const outcome = await runCleanupJob(deps, {
    id: commit.jobId,
    userId,
    storageTargets: commit.storageTargets,
    storagePending: commit.storageTargets.length > 0,
    authPending: true,
    attempts: 0,
  });

  if (!outcome.authDone) {
    return {
      status: "auth_failed",
      jobId: commit.jobId,
      storageRemoved: outcome.storageRemoved,
      cleanupPending: true,
      code: outcome.errorCode ?? "ESBLU_AUTH_DELETE_FAILED",
      summary: commit.summary,
    };
  }
  return {
    status: "deleted",
    jobId: commit.jobId,
    storageRemoved: outcome.storageRemoved,
    cleanupPending: !outcome.storageDone,
    summary: commit.summary,
  };
}
