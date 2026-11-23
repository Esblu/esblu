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

import type { StorageDeleteScope, StorageTarget } from "@/lib/account-deletion-storage";

/** owner = zrušiť firmu, member = opustiť firmu, global = zrušiť login (multi-company 2026-10-12). */
export type DeletionKind = "owner" | "member" | "global";

export type DeletionRequest = {
  kind: DeletionKind;
  userId: string;
  /** Firma, ktorej sa akcia týka (owner/member). Pri global null. */
  companyId: string | null;
  /** Zrušiť aj login: global, alebo posledná firma používateľa (pôvodné „Zrušiť účet"). */
  deleteAccount: boolean;
};

export type CommitResult =
  | {
      ok: true;
      jobId: string | null;
      storageTargets: StorageTarget[];
      summary: unknown;
      deleteAccount: boolean;
      /** P1-5: job ukončenia firmy — oprávňuje výmaz e-faktúr pod prefixom tejto firmy a vyžaduje overenie v DB. */
      terminationCompanyId?: string | null;
    }
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
  commit(request: DeletionRequest): Promise<CommitResult>;
  /** Vyhodí pri zlyhaní alebo ak cieľ po výmaze stále existuje; chýbajúca cesta nie je chyba. */
  removeStorage(targets: StorageTarget[], scope?: StorageDeleteScope): Promise<number>;
  /**
   * P1-5 (20261128100000): DB overí neprítomnosť každého cieľa v storage.objects a až potom zapíše hotovo
   * (a pri ukončení storage_purged_at). null = RPC v DB ešte nie je (pôvodné správanie, nie pre ukončenie).
   */
  confirmStorage?(jobId: string): Promise<{ done: boolean; remaining: number } | null>;
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
  /** Job ukončenia firmy (DB termination_id) → ID firmy pre prefix e-faktúr. */
  terminationCompanyId?: string | null;
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
  | { status: "deleted"; jobId: string | null; storageRemoved: number; cleanupPending: boolean; summary: unknown; accountDeleted: boolean }
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

  const termination = typeof job.terminationCompanyId === "string" && job.terminationCompanyId.length > 0;
  // Ukončenie firmy: hotovo rozhoduje IBA overenie v DB (aj pri prázdnom zozname — sweep prefixu firmy).
  if (termination && job.storagePending) storageDone = false;
  let storageConfirmedInDb = false;

  if (!storageDone) {
    try {
      if (job.storageTargets.length > 0) {
        storageRemoved = await deps.removeStorage(job.storageTargets, { terminationCompanyId: job.terminationCompanyId ?? null });
      }
      storageDone = true;
    } catch (error) {
      errorCode = safeCode(error, "ESBLU_STORAGE_REMOVE_FAILED");
    }
    if (storageDone && job.id && (deps.confirmStorage || termination)) {
      try {
        const confirmed = deps.confirmStorage ? await deps.confirmStorage(job.id) : null;
        if (confirmed === null) {
          // DB overenie nie je k dispozícii: bežné zrušenie po starom, ukončenie firmy NIKDY (fail closed).
          if (termination) {
            storageDone = false;
            errorCode = "ESBLU_STORAGE_CONFIRM_UNAVAILABLE";
          }
        } else {
          storageConfirmedInDb = true;
          storageDone = confirmed.done;
          if (!confirmed.done) errorCode = "ESBLU_STORAGE_NOT_PURGED";
        }
      } catch (error) {
        storageDone = false;
        errorCode = safeCode(error, "ESBLU_STORAGE_CONFIRM_FAILED");
      }
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
      // Stav Storage zapisuje DB overenie (storageConfirmedInDb) alebo — pri ukončení firmy — nikto iný;
      // inak pôvodné správanie.
      const storagePatch: JobPatch = storageConfirmedInDb || termination
        ? {}
        : {
            storage_status: storageDone ? "done" : "pending",
            // Minimalizácia: po vyčistení sa cesty v jobe nedržia.
            ...(storageDone ? { storage_targets: [] } : {}),
          };
      await deps.updateJob(job.id, {
        ...storagePatch,
        auth_status: authDone ? "done" : "pending",
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

export async function orchestrateAccountDeletion(deps: DeletionDeps, request: DeletionRequest): Promise<OrchestrationResult> {
  const commit = await deps.commit(request);
  if (!commit.ok) {
    // Nič sa nezmenilo: DB rollback, Storage sa NEDOTKOL.
    return commit.reason === "subscription_guard"
      ? { status: "blocked_subscription", code: commit.code }
      : { status: "db_failed", code: commit.code };
  }

  const outcome = await runCleanupJob(deps, {
    id: commit.jobId,
    userId: request.userId,
    storageTargets: commit.storageTargets,
    storagePending: commit.storageTargets.length > 0 || Boolean(commit.terminationCompanyId),
    // Login sa ruší IBA keď to DB commit potvrdil (global / posledná firma).
    authPending: commit.deleteAccount,
    attempts: 0,
    terminationCompanyId: commit.terminationCompanyId ?? null,
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
    accountDeleted: commit.deleteAccount,
  };
}
