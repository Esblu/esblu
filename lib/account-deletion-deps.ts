// =============================================================================
// Zrušenie účtu — Supabase implementácia závislostí orchestrácie (SERVER ONLY).
// Pozri lib/account-deletion-orchestrator.ts.
//
// commit():
//   1. esblu_account_deletion_commit (20261012130000) — DB + job v 1 transakcii.
//   2. Fallback IBA ak funkcia v DB ešte neexistuje (migrácia neaplikovaná):
//      TS zber ciest (read-only) → legacy RPC (esblu_owner_delete_company /
//      esblu_member_delete_self) → ciele sa vrátia orchestrácii, ktorá maže
//      Storage AŽ po úspešnom RPC. Bez retry jobu (jobId = null).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  collectMemberOwnStorageTargets,
  collectOwnerStorageTargets,
  parseStorageTargets,
  removeStorageTargets,
} from "@/lib/account-deletion-storage";
import type { AuthDeleteResult, CommitResult, DeletionDeps, DeletionKind, JobPatch } from "@/lib/account-deletion-orchestrator";

type PgError = { code?: string | null; message?: string | null } | null;

const GUARD_RE = /ESBLU_(ACTIVE_SUBSCRIPTION|CHECKOUT_IN_PROGRESS)_BLOCKS_DELETION/;

export function subscriptionGuardCode(error: PgError): string | null {
  return GUARD_RE.exec(error?.message ?? "")?.[0] ?? null;
}

export function isMissingFunctionError(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function/i.test(error.message ?? "");
}

function dbCode(error: PgError): string {
  const known = /ESBLU_[A-Z_]+/.exec(error?.message ?? "")?.[0];
  return known ?? `DB_${(error?.code ?? "unknown").replace(/[^A-Za-z0-9]/g, "")}`;
}

export function supabaseDeletionDeps(admin: SupabaseClient, ctx: { companyId: string | null }): DeletionDeps {
  return {
    async commit(kind: DeletionKind, userId: string): Promise<CommitResult> {
      const { data, error } = await admin.rpc("esblu_account_deletion_commit", { p_kind: kind, p_user_id: userId });
      if (!error) {
        const row = (data ?? {}) as { job_id?: string; storage_targets?: unknown; summary?: unknown };
        return { ok: true, jobId: row.job_id ?? null, storageTargets: parseStorageTargets(row.storage_targets), summary: row.summary ?? null };
      }
      const guard = subscriptionGuardCode(error);
      if (guard) return { ok: false, reason: "subscription_guard", code: guard };
      if (!isMissingFunctionError(error)) {
        console.error("account/delete: esblu_account_deletion_commit zlyhalo:", dbCode(error));
        return { ok: false, reason: "db_error", code: dbCode(error) };
      }

      // Fallback (migrácia 20261012130000 ešte nie je v DB): stále DB NAJPRV.
      let targets;
      try {
        targets = kind === "owner" && ctx.companyId
          ? await collectOwnerStorageTargets(admin, ctx.companyId, userId)
          : await collectMemberOwnStorageTargets(admin, userId);
      } catch {
        return { ok: false, reason: "db_error", code: "ESBLU_STORAGE_LOOKUP_FAILED" };
      }
      const legacy = kind === "owner"
        ? await admin.rpc("esblu_owner_delete_company", { p_owner_user_id: userId })
        : await admin.rpc("esblu_member_delete_self", { p_user_id: userId });
      if (legacy.error) {
        const legacyGuard = subscriptionGuardCode(legacy.error);
        if (legacyGuard) return { ok: false, reason: "subscription_guard", code: legacyGuard };
        console.error("account/delete: legacy delete RPC zlyhalo:", dbCode(legacy.error));
        return { ok: false, reason: "db_error", code: dbCode(legacy.error) };
      }
      return { ok: true, jobId: null, storageTargets: targets, summary: legacy.data ?? null };
    },

    removeStorage: (targets) => removeStorageTargets(admin, targets),

    async deleteAuthUser(userId: string): Promise<AuthDeleteResult> {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error && !(error.status === 404 || /not found/i.test(error.message ?? ""))) {
        console.error("account/delete: auth.admin.deleteUser zlyhalo:", JSON.stringify({ status: error.status, code: error.code }));
        return { ok: false, code: `ESBLU_AUTH_DELETE_FAILED:${error.status ?? "unknown"}` };
      }
      const { data: verify } = await admin.auth.admin.getUserById(userId);
      if (verify?.user) {
        console.error("account/delete: post-verifikácia — auth.users stále existuje");
        return { ok: false, code: "ESBLU_AUTH_VERIFY_FAILED" };
      }
      return { ok: true };
    },

    async updateJob(jobId: string, patch: JobPatch): Promise<void> {
      const { error } = await admin.from("account_deletion_cleanup_jobs").update(patch).eq("id", jobId);
      if (error) throw new Error(`ESBLU_CLEANUP_JOB_UPDATE_FAILED:${error.code ?? "unknown"}`);
    },
  };
}
