// =============================================================================
// Zrušenie účtu — orchestrácia „DB najprv, Storage až po commite" (2026-10-12).
// Unit testy s fake závislosťami + Supabase deps (fallback bez migrácie).
// DB časť (skutočná transakcia, poistka, job) je v subscriptions-lifecycle-pglite
// (suite account-deletion).
//   npm run test:account-deletion-orchestration
// =============================================================================
import assert from "node:assert/strict";
import {
  nextAttemptAt,
  orchestrateAccountDeletion,
  runCleanupJob,
  type CommitResult,
  type DeletionDeps,
  type JobPatch,
} from "@/lib/account-deletion-orchestrator";
import { isMissingFunctionError, subscriptionGuardCode, supabaseDeletionDeps } from "@/lib/account-deletion-deps";
import { parseStorageTargets, type StorageTarget } from "@/lib/account-deletion-storage";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${(error as Error)?.stack?.split("\n").slice(0, 3).join("\n       ") ?? error}`);
  }
}

const NOW = new Date("2026-10-12T12:00:00Z");
const TARGETS: StorageTarget[] = [
  { bucket: "documents", path: "c/doc.pdf" },
  { bucket: "vehicle-photos", path: "c/car.jpg" },
];

function fakeDeps(commit: CommitResult, opts: { storageFails?: boolean; authFails?: boolean } = {}) {
  const log: string[] = [];
  const patches: JobPatch[] = [];
  const deps: DeletionDeps = {
    async commit() {
      log.push("commit");
      return commit;
    },
    async removeStorage(targets) {
      log.push(`storage:${targets.length}`);
      if (opts.storageFails) throw new Error("ESBLU_STORAGE_REMOVE_FAILED:documents:503 upstream");
      return targets.length;
    },
    async deleteAuthUser() {
      log.push("auth");
      return opts.authFails ? { ok: false, code: "ESBLU_AUTH_DELETE_FAILED:500" } : { ok: true };
    },
    async updateJob(_id, patch) {
      log.push("job");
      patches.push(patch);
    },
    now: () => NOW,
  };
  return { deps, log, patches };
}

await check("DB guard odmietne (súbeh s aktiváciou predplatného) → Storage ani auth sa NEZAVOLAJÚ", async () => {
  const { deps, log } = fakeDeps({ ok: false, reason: "subscription_guard", code: "ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION" });
  const r = await orchestrateAccountDeletion(deps, "owner", "u1");
  assert.equal(r.status, "blocked_subscription");
  assert.deepEqual(log, ["commit"]);
});
await check("iná DB chyba → rollback, Storage ani auth sa NEZAVOLAJÚ", async () => {
  const { deps, log } = fakeDeps({ ok: false, reason: "db_error", code: "ESBLU_NOT_ACTIVE_OWNER" });
  const r = await orchestrateAccountDeletion(deps, "owner", "u1");
  assert.equal(r.status, "db_failed");
  assert.deepEqual(log, ["commit"]);
});
await check("DB commit OK → Storage až potom, potom auth, job done + cesty vymazané", async () => {
  const { deps, log, patches } = fakeDeps({ ok: true, jobId: "j1", storageTargets: TARGETS, summary: {} });
  const r = await orchestrateAccountDeletion(deps, "owner", "u1");
  assert.deepEqual(log, ["commit", "storage:2", "auth", "job"]);
  assert.equal(r.status, "deleted");
  assert.equal((r as { cleanupPending: boolean }).cleanupPending, false);
  assert.deepEqual(patches[0].storage_targets, []);
  assert.equal(patches[0].storage_status, "done");
  assert.equal(patches[0].auth_status, "done");
  assert.equal(patches[0].completed_at, NOW.toISOString());
});
await check("Storage zlyhá → účet zrušený, auth aj tak, job pending s backoffom (retryable), cesty ostanú", async () => {
  const { deps, log, patches } = fakeDeps({ ok: true, jobId: "j1", storageTargets: TARGETS, summary: {} }, { storageFails: true });
  const r = await orchestrateAccountDeletion(deps, "member", "u1");
  assert.equal(r.status, "deleted");
  assert.equal((r as { cleanupPending: boolean }).cleanupPending, true);
  assert.deepEqual(log, ["commit", "storage:2", "auth", "job"]);
  assert.equal(patches[0].storage_status, "pending");
  assert.equal(patches[0].storage_targets, undefined, "ciele sa nemažú z jobu");
  assert.equal(patches[0].last_error_code, "ESBLU_STORAGE_REMOVE_FAILED:documents");
  assert.equal(patches[0].next_attempt_at, nextAttemptAt(NOW, 1));
  assert.equal(patches[0].completed_at, null);
});
await check("auth zlyhá → partial (DB commitnutá), job auth pending na retry", async () => {
  const { deps, patches } = fakeDeps({ ok: true, jobId: "j1", storageTargets: [], summary: {} }, { authFails: true });
  const r = await orchestrateAccountDeletion(deps, "owner", "u1");
  assert.equal(r.status, "auth_failed");
  assert.equal(patches[0].auth_status, "pending");
  assert.equal(patches[0].storage_status, "done", "bez súborov = storage hotový");
});
await check("retry jobu: idempotentné, hotový job nič nevolá, zlyhanie zápisu jobu nič nerozbije", async () => {
  const { deps, log } = fakeDeps({ ok: true, jobId: "j1", storageTargets: [], summary: {} });
  const done = await runCleanupJob(deps, { id: "j1", userId: "u1", storageTargets: [], storagePending: false, authPending: false, attempts: 3 });
  assert.equal(done.storageDone && done.authDone, true);
  assert.deepEqual(log, ["job"]);
  const broken: DeletionDeps = { ...deps, updateJob: async () => { throw new Error("db down"); } };
  const out = await runCleanupJob(broken, { id: "j1", userId: "u1", storageTargets: TARGETS, storagePending: true, authPending: true, attempts: 0 });
  assert.equal(out.storageDone && out.authDone, true, "job ostane pending a cron to zopakuje");
});
await check("backoff: 15 min → … → max 24 h", () => {
  assert.equal(nextAttemptAt(NOW, 1), new Date(NOW.getTime() + 15 * 60_000).toISOString());
  assert.equal(nextAttemptAt(NOW, 3), new Date(NOW.getTime() + 60 * 60_000).toISOString());
  assert.equal(nextAttemptAt(NOW, 30), new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString());
});
await check("parseStorageTargets: iba {bucket,path} stringy, žiadne '..'", () => {
  assert.deepEqual(parseStorageTargets([{ bucket: "a", path: "x/y" }, { bucket: "a", path: "../etc" }, { bucket: 1, path: "z" }, null]), [{ bucket: "a", path: "x/y" }]);
  assert.deepEqual(parseStorageTargets("nope"), []);
});

// ----------------------------------------------------------------------------- Supabase deps
type RpcRes = { data: unknown; error: { code?: string; message?: string } | null };
function fakeAdmin(rpc: Record<string, RpcRes>, log: string[]) {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "in", "update"]) b[m] = () => b;
    b.then = (ok: (r: unknown) => unknown) => {
      log.push(`read:${table}`);
      const rows: Record<string, unknown[]> = {
        documents: [{ storage_bucket: "documents", storage_path: "c/doc.pdf" }],
        settings: [{ logo_path: "c/logo.png" }],
      };
      return Promise.resolve({ data: rows[table] ?? [], error: null }).then(ok);
    };
    return b;
  };
  return {
    rpc: async (fn: string) => {
      log.push(`rpc:${fn}`);
      return rpc[fn] ?? { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    },
    from: builder,
    storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => (log.push(`remove:${bucket}:${paths.length}`), { data: paths, error: null }) }) },
    auth: { admin: { deleteUser: async () => (log.push("auth:delete"), { error: null }), getUserById: async () => ({ data: { user: null } }) } },
  } as never;
}

await check("deps: commit funkcia existuje → ciele z DB transakcie (TS kolektory sa nevolajú)", async () => {
  const log: string[] = [];
  const deps = supabaseDeletionDeps(fakeAdmin({ esblu_account_deletion_commit: { data: { job_id: "j9", storage_targets: TARGETS, summary: { ok: 1 } }, error: null } }, log), { companyId: "c" });
  const r = await orchestrateAccountDeletion(deps, "owner", "u1");
  assert.equal(r.status, "deleted");
  assert.deepEqual(log.filter((l) => !l.startsWith("read:account_deletion_cleanup_jobs")), ["rpc:esblu_account_deletion_commit", "remove:documents:1", "remove:vehicle-photos:1", "auth:delete"]);
});
await check("deps: migrácia ešte neaplikovaná → fallback: TS zber (read-only) → legacy RPC → AŽ POTOM Storage", async () => {
  const log: string[] = [];
  const deps = supabaseDeletionDeps(fakeAdmin({ esblu_owner_delete_company: { data: { ok: true }, error: null } }, log), { companyId: "c" });
  const r = await orchestrateAccountDeletion(deps, "owner", "u1");
  assert.equal(r.status, "deleted");
  const rpcAt = log.indexOf("rpc:esblu_owner_delete_company");
  const firstRemove = log.findIndex((l) => l.startsWith("remove:"));
  assert.ok(rpcAt > 0 && firstRemove > rpcAt, `Storage až po legacy RPC: ${log.join(",")}`);
  assert.equal((r as { jobId: string | null }).jobId, null, "fallback bez retry jobu");
});
await check("deps: fallback + legacy RPC odmietnuté poistkou → Storage sa NEZAVOLÁ", async () => {
  const log: string[] = [];
  const deps = supabaseDeletionDeps(fakeAdmin({ esblu_owner_delete_company: { data: null, error: { code: "P0001", message: "ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION" } } }, log), { companyId: "c" });
  const r = await orchestrateAccountDeletion(deps, "owner", "u1");
  assert.equal(r.status, "blocked_subscription");
  assert.ok(!log.some((l) => l.startsWith("remove:") || l === "auth:delete"), log.join(","));
});
await check("deps: commit odmietnutý poistkou / inou chybou → bez fallbacku, Storage sa NEZAVOLÁ", async () => {
  for (const [error, status] of [
    [{ code: "P0001", message: "ESBLU_CHECKOUT_IN_PROGRESS_BLOCKS_DELETION" }, "blocked_subscription"],
    [{ code: "40P01", message: "deadlock detected" }, "db_failed"],
  ] as const) {
    const log: string[] = [];
    const deps = supabaseDeletionDeps(fakeAdmin({ esblu_account_deletion_commit: { data: null, error } }, log), { companyId: "c" });
    const r = await orchestrateAccountDeletion(deps, "owner", "u1");
    assert.equal(r.status, status);
    assert.deepEqual(log, ["rpc:esblu_account_deletion_commit"], "žiadny fallback, žiadne čítanie, žiadny remove");
  }
  assert.equal(subscriptionGuardCode({ message: "x ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION y" }), "ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION");
  assert.equal(isMissingFunctionError({ code: "PGRST202" }), true);
  assert.equal(isMissingFunctionError({ code: "40P01", message: "deadlock" }), false);
});

console.log(`\naccount-deletion-orchestration: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
