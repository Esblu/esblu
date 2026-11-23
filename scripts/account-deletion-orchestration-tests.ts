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
import { deletionAllowed, parseStorageTargets, removeStorageTargets, verifyStorageTargetsAbsent, type StorageTarget } from "@/lib/account-deletion-storage";
import { formatAccountDeletionAlert } from "@/lib/account-deletion-alert";
import { readFileSync } from "node:fs";

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
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: null, deleteAccount: true });
  assert.equal(r.status, "blocked_subscription");
  assert.deepEqual(log, ["commit"]);
});
await check("iná DB chyba → rollback, Storage ani auth sa NEZAVOLAJÚ", async () => {
  const { deps, log } = fakeDeps({ ok: false, reason: "db_error", code: "ESBLU_NOT_ACTIVE_OWNER" });
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: null, deleteAccount: true });
  assert.equal(r.status, "db_failed");
  assert.deepEqual(log, ["commit"]);
});
await check("DB commit OK → Storage až potom, potom auth, job done + cesty vymazané", async () => {
  const { deps, log, patches } = fakeDeps({ ok: true, jobId: "j1", storageTargets: TARGETS, summary: {}, deleteAccount: true });
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: null, deleteAccount: true });
  assert.deepEqual(log, ["commit", "storage:2", "auth", "job"]);
  assert.equal(r.status, "deleted");
  assert.equal((r as { cleanupPending: boolean }).cleanupPending, false);
  assert.deepEqual(patches[0].storage_targets, []);
  assert.equal(patches[0].storage_status, "done");
  assert.equal(patches[0].auth_status, "done");
  assert.equal(patches[0].completed_at, NOW.toISOString());
});
await check("Storage zlyhá → účet zrušený, auth aj tak, job pending s backoffom (retryable), cesty ostanú", async () => {
  const { deps, log, patches } = fakeDeps({ ok: true, jobId: "j1", storageTargets: TARGETS, summary: {}, deleteAccount: true }, { storageFails: true });
  const r = await orchestrateAccountDeletion(deps, { kind: "member", userId: "u1", companyId: null, deleteAccount: true });
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
  const { deps, patches } = fakeDeps({ ok: true, jobId: "j1", storageTargets: [], summary: {}, deleteAccount: true }, { authFails: true });
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: null, deleteAccount: true });
  assert.equal(r.status, "auth_failed");
  assert.equal(patches[0].auth_status, "pending");
  assert.equal(patches[0].storage_status, "done", "bez súborov = storage hotový");
});
await check("retry jobu: idempotentné, hotový job nič nevolá, zlyhanie zápisu jobu nič nerozbije", async () => {
  const { deps, log } = fakeDeps({ ok: true, jobId: "j1", storageTargets: [], summary: {}, deleteAccount: true });
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
await check("parseStorageTargets: účtovné kópie Esblu (billing-documents) ani e-faktúry nikdy nie sú cieľom výmazu", () => {
  assert.deepEqual(parseStorageTargets([
    { bucket: "billing-documents", path: "live/2026/11/invoice/in_x.pdf" },
    { bucket: "einvoice-documents", path: "c/x.xml" },
    { bucket: "documents", path: "c/a.pdf" },
  ]), [{ bucket: "documents", path: "c/a.pdf" }]);
});
await check("removeStorageTargets: billing-documents sa nezmaže ani pri priamom volaní (obrana do hĺbky)", async () => {
  const removed: string[] = [];
  const fake = { storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => { removed.push(...paths.map((p) => `${bucket}/${p}`)); return { data: paths, error: null }; } }) } } as never;
  await removeStorageTargets(fake, [{ bucket: "billing-documents", path: "live/2026/11/invoice/in_x.pdf" }, { bucket: "documents", path: "c/a.pdf" }]);
  assert.deepEqual(removed, ["documents/c/a.pdf"]);
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
  const deps = supabaseDeletionDeps(fakeAdmin({ esblu_account_deletion_commit: { data: { job_id: "j9", storage_targets: TARGETS, summary: { ok: 1 }, delete_account: true }, error: null } }, log));
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: "c", deleteAccount: true });
  assert.equal(r.status, "deleted");
  assert.deepEqual(log.filter((l) => !l.startsWith("read:account_deletion_cleanup_jobs")), ["rpc:esblu_account_deletion_commit", "remove:documents:1", "remove:vehicle-photos:1", "auth:delete"]);
});
await check("deps: migrácia ešte neaplikovaná → fallback: TS zber (read-only) → legacy RPC → AŽ POTOM Storage", async () => {
  const log: string[] = [];
  const deps = supabaseDeletionDeps(fakeAdmin({ esblu_owner_delete_company: { data: { ok: true }, error: null } }, log));
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: "c", deleteAccount: true });
  assert.equal(r.status, "deleted");
  const rpcAt = log.indexOf("rpc:esblu_owner_delete_company");
  const firstRemove = log.findIndex((l) => l.startsWith("remove:"));
  assert.ok(rpcAt > 0 && firstRemove > rpcAt, `Storage až po legacy RPC: ${log.join(",")}`);
  assert.equal((r as { jobId: string | null }).jobId, null, "fallback bez retry jobu");
});
await check("deps: fallback + legacy RPC odmietnuté poistkou → Storage sa NEZAVOLÁ", async () => {
  const log: string[] = [];
  const deps = supabaseDeletionDeps(fakeAdmin({ esblu_owner_delete_company: { data: null, error: { code: "P0001", message: "ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION" } } }, log));
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: "c", deleteAccount: true });
  assert.equal(r.status, "blocked_subscription");
  assert.ok(!log.some((l) => l.startsWith("remove:") || l === "auth:delete"), log.join(","));
});
await check("deps: commit odmietnutý poistkou / inou chybou → bez fallbacku, Storage sa NEZAVOLÁ", async () => {
  for (const [error, status] of [
    [{ code: "P0001", message: "ESBLU_CHECKOUT_IN_PROGRESS_BLOCKS_DELETION" }, "blocked_subscription"],
    [{ code: "40P01", message: "deadlock detected" }, "db_failed"],
  ] as const) {
    const log: string[] = [];
    const deps = supabaseDeletionDeps(fakeAdmin({ esblu_account_deletion_commit: { data: null, error } }, log));
    const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: "c", deleteAccount: true });
    assert.equal(r.status, status);
    assert.deepEqual(log, ["rpc:esblu_account_deletion_commit"], "žiadny fallback, žiadne čítanie, žiadny remove");
  }
  assert.equal(subscriptionGuardCode({ message: "x ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION y" }), "ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION");
  assert.equal(isMissingFunctionError({ code: "PGRST202" }), true);
  assert.equal(isMissingFunctionError({ code: "40P01", message: "deadlock" }), false);
});

await check("multi-company: odchod z firmy / zrušenie firmy pri ďalších firmách → login sa NEZRUŠÍ (žiadne auth volanie)", async () => {
  const log: string[] = [];
  const deps: DeletionDeps = {
    async commit(req) {
      log.push(`commit:${req.kind}:${req.companyId}:${req.deleteAccount}`);
      return { ok: true, jobId: "j2", storageTargets: [], summary: {}, deleteAccount: false };
    },
    async removeStorage() { log.push("storage"); return 0; },
    async deleteAuthUser() { log.push("auth"); return { ok: true }; },
    async updateJob() { log.push("job"); },
    now: () => NOW,
  };
  const r = await orchestrateAccountDeletion(deps, { kind: "member", userId: "u1", companyId: "c1", deleteAccount: false });
  assert.equal(r.status, "deleted");
  assert.equal((r as { accountDeleted: boolean }).accountDeleted, false);
  assert.deepEqual(log, ["commit:member:c1:false", "job"], "žiadny storage ani auth");
});
await check("multi-company: globálne zrušenie loginu = auth sa ruší až po commite", async () => {
  const log: string[] = [];
  const deps: DeletionDeps = {
    async commit(req) {
      log.push(`commit:${req.kind}`);
      return { ok: true, jobId: "j3", storageTargets: [{ bucket: "company-logos", path: "u/logo.png" }], summary: {}, deleteAccount: true };
    },
    async removeStorage() { log.push("storage"); return 1; },
    async deleteAuthUser() { log.push("auth"); return { ok: true }; },
    async updateJob() { log.push("job"); },
    now: () => NOW,
  };
  const r = await orchestrateAccountDeletion(deps, { kind: "global", userId: "u1", companyId: null, deleteAccount: true });
  assert.equal((r as { accountDeleted: boolean }).accountDeleted, true);
  assert.deepEqual(log, ["commit:global", "storage", "auth", "job"]);
});
await check("deps: bez multi-company migrácie sa „iba opustiť firmu“ / globálne zrušenie NEvykoná (fail closed)", async () => {
  for (const req of [
    { kind: "member" as const, userId: "u1", companyId: "c", deleteAccount: false },
    { kind: "global" as const, userId: "u1", companyId: null, deleteAccount: true },
  ]) {
    const log: string[] = [];
    const deps = supabaseDeletionDeps(fakeAdmin({}, log));
    const r = await orchestrateAccountDeletion(deps, req);
    assert.equal(r.status, "db_failed");
    assert.equal((r as { code: string }).code, "ESBLU_MULTI_COMPANY_NOT_MIGRATED");
    assert.ok(!log.some((l) => l.startsWith("remove:") || l === "auth:delete"));
  }
});

// ----------------------------------------------------------------------------- P1-5: ukončenie firmy — overený výmaz
const CO = "e7000000-0000-4000-8000-00000000000a";
const OTHER = "e7000000-0000-4000-8000-00000000000b";
await check("P1-5 rozsah výmazu: e-faktúry iba v jobe ukončenia a pod prefixom firmy; billing-documents nikdy", () => {
  const t = (bucket: string, path: string) => ({ bucket, path });
  assert.equal(deletionAllowed(t("einvoice-documents", `${CO}/inbound/x.xml`)), false, "bez ukončenia");
  assert.equal(deletionAllowed(t("einvoice-documents", `${CO}/inbound/x.xml`), { terminationCompanyId: CO }), true);
  assert.equal(deletionAllowed(t("einvoice-documents", `${OTHER}/inbound/x.xml`), { terminationCompanyId: CO }), false, "cudzí prefix");
  assert.equal(deletionAllowed(t("einvoice-documents", `${CO}x/a.xml`), { terminationCompanyId: CO }), false, "prefix bez lomky");
  assert.equal(deletionAllowed(t("billing-documents", `${CO}/a.pdf`), { terminationCompanyId: CO }), false);
  assert.equal(deletionAllowed(t("einvoice-documents", `${CO}/a.xml`), { terminationCompanyId: "not-a-uuid" }), false);
  assert.deepEqual(parseStorageTargets([t("einvoice-documents", `${CO}/a.xml`), t("einvoice-documents", `${OTHER}/b.xml`), t("einvoice-documents", `${CO}/../${OTHER}/c.xml`)], { terminationCompanyId: CO }),
    [t("einvoice-documents", `${CO}/a.xml`)]);
});
await check("P1-5 verifyStorageTargetsAbsent: objekt stále existuje / neoveriteľný stav = chyba (nie úspech)", async () => {
  const admin = (state: Record<string, boolean | "error">) => ({ storage: { from: (b: string) => ({ exists: async (p: string) => {
    const v = state[`${b}/${p}`];
    if (v === "error") throw new Error("503");
    return { data: v ?? false, error: null };
  } }) } }) as never;
  const targets = [{ bucket: "einvoice-documents", path: `${CO}/a.xml` }, { bucket: "documents", path: "c/d.pdf" }];
  await verifyStorageTargetsAbsent(admin({}), targets);
  await assert.rejects(verifyStorageTargetsAbsent(admin({ [`einvoice-documents/${CO}/a.xml`]: true }), targets), /ESBLU_STORAGE_NOT_PURGED:1/);
  await assert.rejects(verifyStorageTargetsAbsent(admin({ "documents/c/d.pdf": "error" }), targets), /ESBLU_STORAGE_VERIFY_FAILED/);
});
function terminationDeps(confirm: Array<{ done: boolean; remaining: number } | null | "throw">, opts: { storageFails?: boolean } = {}) {
  const log: string[] = [];
  const patches: JobPatch[] = [];
  const deps: DeletionDeps = {
    async commit() { return { ok: true, jobId: "job-1", storageTargets: [{ bucket: "einvoice-documents", path: `${CO}/a.xml` }], summary: null, deleteAccount: false, terminationCompanyId: CO }; },
    async removeStorage(targets, scope) {
      log.push(`storage:${targets.length}:${scope?.terminationCompanyId ?? "-"}`);
      if (opts.storageFails) throw new Error("ESBLU_STORAGE_NOT_PURGED:1");
      return targets.length;
    },
    async confirmStorage() {
      const next = confirm.shift() ?? null;
      log.push("confirm");
      if (next === "throw") throw new Error("ESBLU_STORAGE_CONFIRM_FAILED:500");
      return next;
    },
    async deleteAuthUser() { return { ok: true }; },
    async updateJob(_id, patch) { log.push("job"); patches.push(patch); },
    now: () => NOW,
  };
  return { deps, log, patches };
}
await check("P1-5 ukončenie: hotovo iba po DB overení; job sa nezapíše ako hotový z aplikácie", async () => {
  const { deps, log, patches } = terminationDeps([{ done: true, remaining: 0 }]);
  const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: CO, deleteAccount: false });
  assert.equal(r.status, "deleted");
  assert.equal((r as { cleanupPending: boolean }).cleanupPending, false);
  assert.deepEqual(log, [`storage:1:${CO}`, "confirm", "job"]);
  assert.equal(patches[0].storage_status, undefined, "stav Storage zapisuje iba DB overenie");
  assert.equal(patches[0].storage_targets, undefined);
});
await check("P1-5 ukončenie: neúplný výmaz / zlyhanie overenia / chýbajúce RPC / zlyhaný výmaz = pending a retry", async () => {
  for (const [confirm, code] of [
    [{ done: false, remaining: 2 }, "ESBLU_STORAGE_NOT_PURGED"],
    ["throw", "ESBLU_STORAGE_CONFIRM_FAILED:500"],
    [null, "ESBLU_STORAGE_CONFIRM_UNAVAILABLE"],
  ] as const) {
    const { deps, patches } = terminationDeps([confirm as never]);
    const r = await orchestrateAccountDeletion(deps, { kind: "owner", userId: "u1", companyId: CO, deleteAccount: false });
    assert.equal((r as { cleanupPending: boolean }).cleanupPending, true, String(code));
    assert.equal(patches[0].last_error_code, code);
    assert.equal(patches[0].storage_status, undefined);
    assert.ok(patches[0].next_attempt_at && new Date(patches[0].next_attempt_at).getTime() > NOW.getTime(), "backoff");
  }
  const failing = terminationDeps([{ done: true, remaining: 0 }], { storageFails: true });
  const r = await orchestrateAccountDeletion(failing.deps, { kind: "owner", userId: "u1", companyId: CO, deleteAccount: false });
  assert.equal((r as { cleanupPending: boolean }).cleanupPending, true);
  assert.ok(!failing.log.includes("confirm"), "bez úspešného výmazu sa neoveruje");
  assert.match(String(failing.patches[0].last_error_code), /ESBLU_STORAGE_NOT_PURGED/);
});
await check("P1-5 ukončenie bez confirmStorage v závislostiach = nikdy hotovo (fail closed)", async () => {
  const { deps, patches } = terminationDeps([]);
  delete (deps as { confirmStorage?: unknown }).confirmStorage;
  const r = await runCleanupJob(deps, { id: "job-1", userId: "u1", storageTargets: [], storagePending: true, authPending: false, attempts: 3, terminationCompanyId: CO });
  assert.equal(r.storageDone, false);
  assert.equal(patches[0].last_error_code, "ESBLU_STORAGE_CONFIRM_UNAVAILABLE");
  assert.equal(patches[0].attempts, 4);
});
await check("P1-5 cron: job ukončenia s prefixom firmy, monitoring vyčerpaných pokusov a neoverených výmazov (alert + 503)", () => {
  const cron = readFileSync("app/api/cron/account-deletion-cleanup/route.ts", "utf8");
  assert.match(cron, /termination_id/);
  assert.match(cron, /parseStorageTargets\(row\.storage_targets, \{ terminationCompanyId \}\)/);
  assert.match(cron, /esblu_cleanup_health/);
  assert.match(cron, /status: 503/);
  const line = formatAccountDeletionAlert({ code: "ACCOUNT_CLEANUP_RETRY_EXHAUSTED", exhausted: 2, unpurged: 1 });
  assert.match(line, /^\[account-deletion-alert\] \{"code":"ACCOUNT_CLEANUP_RETRY_EXHAUSTED","severity":"critical","exhausted":2,"termination_unpurged":1\}$/);
  const deps = readFileSync("lib/account-deletion-deps.ts", "utf8");
  assert.match(deps, /verifyStorageTargetsAbsent\(admin/);
  assert.match(deps, /esblu_cleanup_job_confirm_storage/);
  assert.match(deps, /terminationCompanyId: companyId/);
});

console.log(`\naccount-deletion-orchestration: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
