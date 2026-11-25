// =============================================================================
// P1-5 skupina D — priebeh jedného výmazu (jedna firma z allowlistu na jeden beh). Závislosti sú injektované:
// v ostrom behu skutočný kód appky (lib/account-deletion-deps, lib/account-deletion-orchestrator) + supabase-js
// cez deletionGuardedFetch; v offline testoch falošné implementácie.
// =============================================================================
import { Stop } from "./runner-core.ts";
import {
  assertFreshOwnerAuth,
  gateCheck,
  isoSnapshot,
  postcheck,
  precheckIdentity,
  resolveDeletionTarget,
  validateExport,
  type ReauthResult,
  sameSnapshot,
  type DeleteScope,
  type ListObjects,
  type Read,
  type Rpc,
  type Target,
} from "./groupD-core.ts";

export type CommitResultLike = { ok: true; jobId: string | null; storageTargets: unknown[]; terminationCompanyId?: string | null } | { ok: false; reason: string; code: string };
export type OrchestrationLike =
  | { status: "deleted"; jobId: string | null; storageRemoved: number; cleanupPending: boolean; accountDeleted: boolean }
  | { status: "auth_failed"; jobId: string | null; code: string }
  | { status: "db_failed" | "blocked_subscription"; code: string };
export type CleanupOutcomeLike = { storageDone: boolean; authDone: boolean; errorCode: string | null };

export type DDeps = {
  scope: DeleteScope;
  read: Read;
  rpc: Rpc;
  list: ListObjects;
  /** Nový export (runner-core Runner.runExport) — evidencia ≤ 24 h pre bránu. */
  exportRefresh(t: Target): Promise<{ status: string; runId: string | null }>;
  /** Skutočné prihlásenie vlastníka (groupD-core realReauth: magic link bez e-mailu, overenie tokenu, odhlásenie). */
  reauth(t: Target): Promise<ReauthResult>;
  /** lib/company-termination-ack buildTerminationAck (text + SHA-256 z i18n). */
  buildAck(t: Target): Record<string, unknown> | null;
  /** lib orchestrateAccountDeletion(supabaseTerminationDeps(...)) — commit zachytí jobId do scope. */
  terminate(t: Target, ack: Record<string, unknown>): Promise<OrchestrationLike>;
  /** lib runCleanupJob so supabaseDeletionDeps — presne ako /api/cron/account-deletion-cleanup. */
  retryJob(job: Record<string, unknown>, t: Target): Promise<CleanupOutcomeLike>;
  now(): Date;
  log(line: string): void;
};

export type StepResult = { id: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
export type TargetOptions = { injectStorageFailureBucket?: "einvoice-documents" | "ai-inbox-documents" };

/**
 * Iba dočistenie už commitnutého ukončenia (žiadny nový výmaz v DB): job ukončenia cieľa → runCleanupJob (ako cron)
 * → kontrola. Použitie: PERF po výmaze v DB mimo API limitu 8 s (samostatné schválenie) alebo opakovanie po výpadku.
 */
export async function runCleanupOnly(d: DDeps, key: string): Promise<{ exitCode: number; results: StepResult[] }> {
  const results: StepResult[] = [];
  const rec = (id: string, ok: boolean, detail: string) => { results.push({ id, status: ok ? "PASS" : "FAIL", detail }); d.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`); };
  let t: Target;
  try { t = resolveDeletionTarget(key); } catch (error) { rec("C1.allowlist", false, error instanceof Error ? error.message : "allowlist"); return { exitCode: 2, results }; }
  d.scope.target = t;
  try {
    const isoBefore = await isoSnapshot(d.read, d.list);
    const terms = await d.read("company_terminations", { company_id: `eq.${t.companyId}`, status: "eq.completed" }, "id,termination_mode,cleanup_job_id,storage_purged_at");
    if (terms.length !== 1 || terms[0].termination_mode !== "customer_delete" || typeof terms[0].cleanup_job_id !== "string") throw new Stop("cleanup: pre cieľ nie je presne 1 dokončené ukončenie customer_delete");
    if ((await d.read("companies", { id: `eq.${t.companyId}` }, "id")).length) throw new Stop("cleanup: firma ešte existuje (DB výmaz neprebehol)");
    d.scope.jobId = terms[0].cleanup_job_id as string;
    const jobs = await d.read("account_deletion_cleanup_jobs", { id: `eq.${d.scope.jobId}` }, "id,user_id,company_id,termination_id,storage_targets,storage_status,auth_status,attempts,last_error_code");
    if (jobs.length !== 1 || jobs[0].company_id !== t.companyId || jobs[0].termination_id !== terms[0].id) throw new Stop("cleanup: job nepatrí ukončeniu cieľa");
    const out = await d.retryJob(jobs[0], t);
    rec("C2.cleanup", out.storageDone && out.authDone, `storageDone=${out.storageDone} authDone=${out.authDone} ${out.errorCode ?? ""}`);
    const r3 = (await d.read("einvoice_misdelivery_incidents", { termination_id: `eq.${terms[0].id}` }, "id")).length;
    const issues = await postcheck(t, d.read, d.list, { r3 });
    rec("C3.postcheck", issues.length === 0, issues.join("; ") || "OK");
    rec("C4.iso_unchanged", sameSnapshot(isoBefore, await isoSnapshot(d.read, d.list)), "ISO");
    const denied = d.scope.log.filter((l) => l.startsWith("DENY"));
    rec("C5.network_guard", denied.length === 0, denied[0] ?? "OK");
  } catch (error) {
    rec("ABORT", false, error instanceof Error ? error.message.slice(0, 240) : String(error));
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  d.log(`p15-groupD cleanup ${t.key}: ${failed ? "FAIL" : "PASS"}`);
  return { exitCode: failed ? 1 : 0, results };
}

/**
 * Samostatný test autentifikácie (bez exportu, bez RPC, bez Storage, bez výmazu): allowlist → identita (čítanie) →
 * skutočné prihlásenie vlastníka → overenie. Sieťová poistka v režime authOnly zablokuje všetko okrem čítania REST
 * a Auth. Vedľajšie účinky iba v Auth (záznam prihlásenia, relácia hneď odhlásená, prípadne doplnená identita).
 */
export async function runAuthTest(d: DDeps, key: string): Promise<{ exitCode: number; results: StepResult[]; auth: ReauthResult | null }> {
  const results: StepResult[] = [];
  const rec = (id: string, ok: boolean, detail: string) => { results.push({ id, status: ok ? "PASS" : "FAIL", detail }); d.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`); };
  let t: Target;
  try { t = resolveDeletionTarget(key); } catch (error) { rec("A1.allowlist", false, error instanceof Error ? error.message : "allowlist"); return { exitCode: 2, results, auth: null }; }
  d.scope.target = t;
  d.scope.authOnly = true;
  let auth: ReauthResult | null = null;
  try {
    rec("A1.allowlist", true, `${t.name}`);
    await precheckIdentity(t, d.read);
    rec("A2.identity", true, "firma, vlastník, členstvo (iba čítanie)");
    auth = await d.reauth(t);
    assertFreshOwnerAuth(t, auth, d.now());
    rec("A3.reauth", true, `prihlásenie vlastníka cez Supabase Auth overené; identity po teste: ${auth.identities ?? "?"}`);
    const denied = d.scope.log.filter((l) => l.startsWith("DENY"));
    rec("A4.network_guard", denied.length === 0, denied[0] ?? "iba čítanie REST + Auth");
  } catch (error) {
    rec("ABORT", false, error instanceof Error ? error.message.slice(0, 240) : String(error));
  } finally {
    d.scope.authOnly = false;
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  d.log(`p15-groupD auth-test ${t.key}: ${failed ? "FAIL" : "PASS"} — žiadny export, žiadny výmaz`);
  return { exitCode: failed ? 1 : 0, results, auth };
}

export async function runDeletionTarget(d: DDeps, key: string, opts: TargetOptions = {}): Promise<{ exitCode: number; results: StepResult[] }> {
  const results: StepResult[] = [];
  const rec = (id: string, ok: boolean | "SKIP", detail: string) => {
    const status = ok === "SKIP" ? "SKIP" : ok ? "PASS" : "FAIL";
    results.push({ id, status, detail });
    d.log(`${status} ${id} ${detail}`);
  };
  let t: Target;
  try {
    t = resolveDeletionTarget(key); // D-1: ISO / pôvodné firmy / neznáme = STOP pred sieťou
  } catch (error) {
    rec("D1.allowlist", false, error instanceof Error ? error.message : "allowlist");
    return { exitCode: 2, results };
  }
  d.scope.target = t;
  d.scope.jobId = null;
  let deleted = false;
  try {
    rec("D1.allowlist", true, `${t.name} (${t.companyId})`);
    const isoBefore = await isoSnapshot(d.read, d.list);

    // Poradie (2026-11-25): identita → prihlásenie → oprávnenie → export → validácia exportu → brána → výmaz.
    // Zlyhanie prihlásenia = žiadny export, žiadne RPC, žiadny výmaz.
    await precheckIdentity(t, d.read);
    rec("D2.identity", true, "firma, vlastník, jediné aktívne členstvo vlastníka, bez e-Faktúry/billing, cesty pod prefixom");

    const auth = await d.reauth(t);
    assertFreshOwnerAuth(t, auth, d.now());
    rec("D3.reauth", true, `skutočné prihlásenie vlastníka overené (token cez /auth/v1/user, last_sign_in_at < 5 min, identity ${auth.identities ?? "?"}), relácia odhlásená`);

    const pre = await precheckIdentity(t, d.read);
    rec("D4.authorization", true, `oprávnenie po prihlásení: aktívny vlastník, ${pre.storagePaths} ciest pod prefixom, R3=${pre.r3}`);

    const exp = await d.exportRefresh(t);
    if (exp.status !== "completed") throw new Stop(`D-5: export ${t.key} nie je completed (${exp.status}) — výmaz sa nespustí`);
    const ev = await validateExport(t, d.read, exp.runId, d.now());
    rec("D5.export", true, `nový export ${exp.runId} completed, ${ev.files} súborov so SHA-256, čerstvý`);

    const ack = d.buildAck(t);
    if (!ack || ack.authority_confirmed !== true || typeof ack.text_sha256 !== "string") throw new Stop("D-4: vyhlásenie oprávnenej osoby chýba");
    await gateCheck(t, d.rpc, ack);
    rec("D6.gate", true, "databázová brána (preflight bez zmeny údajov) = OK");

    if (opts.injectStorageFailureBucket) d.scope.injectStorageFailure = opts.injectStorageFailureBucket;
    const res = await d.terminate(t, ack);
    if (res.status !== "deleted") {
      rec("D7.termination", false, `${res.status} ${"code" in res ? res.code : ""} — DB transakcia vrátená, nič sa nezmazalo`);
      return { exitCode: 1, results };
    }
    deleted = true;
    rec("D7.termination", true, `DB výmaz commitnutý, súbory zmazané ${res.storageRemoved}, účet zrušený=${res.accountDeleted}, cleanupPending=${res.cleanupPending}`);

    if (opts.injectStorageFailureBucket) {
      if (!res.cleanupPending) throw new Stop("D-8: simulovaný výpadok Storage sa neprejavil");
      const jobs = await d.read("account_deletion_cleanup_jobs", { id: `eq.${d.scope.jobId}` }, "id,user_id,company_id,termination_id,storage_targets,storage_status,auth_status,attempts,last_error_code");
      const job = jobs[0];
      const pendingOk = job && job.storage_status === "pending" && job.attempts === 1 && typeof job.last_error_code === "string";
      rec("D8.failure_recorded", Boolean(pendingOk), `job ${job?.storage_status}/${job?.auth_status}, pokusy ${job?.attempts}, kód ${job?.last_error_code}`);
      const terms = await d.read("company_terminations", { company_id: `eq.${t.companyId}`, status: "eq.completed" }, "storage_purged_at");
      rec("D8.not_marked_purged", terms.length === 1 && !terms[0].storage_purged_at, "storage_purged_at = null kým DB neoverí výmaz");
      const health = await d.rpc("esblu_cleanup_health", { p_max_attempts: 30 });
      const h = (health.data ?? {}) as { exhausted?: number; termination_unpurged_24h?: number };
      rec("D8.health_before_retry", !health.error && Number(h.exhausted) === 0 && Number(h.termination_unpurged_24h) === 0, JSON.stringify(h));
      const retry = await d.retryJob(job as Record<string, unknown>, t);
      rec("D9.retry_cleanup", retry.storageDone && retry.authDone, `storageDone=${retry.storageDone} authDone=${retry.authDone} ${retry.errorCode ?? ""}`);
    }

    const issues = await postcheck(t, d.read, d.list, { r3: pre.r3 });
    rec("D10.postcheck", issues.length === 0, issues.length ? issues.join("; ") : "firma, doklady, e-faktúry, členstvá, súbory preč; completed + storage_purged_at; job done; incidenty R3");
    const isoAfter = await isoSnapshot(d.read, d.list);
    rec("D11.iso_unchanged", sameSnapshot(isoBefore, isoAfter), JSON.stringify(isoAfter.counts));
    const denied = d.scope.log.filter((l) => l.startsWith("DENY"));
    rec("D12.network_guard", denied.length === 0, denied.length ? `zablokované požiadavky: ${denied.length} (${denied[0]})` : "žiadna požiadavka mimo povoleného rozsahu");
  } catch (error) {
    rec("ABORT", false, error instanceof Error ? error.message.slice(0, 240) : String(error));
    if (deleted) d.log("POZOR: výmaz bol commitnutý — nedokončený cleanup dočistí retry; nespúšťať ďalšiu firmu, kontaktovať Claude.");
  } finally {
    d.scope.injectStorageFailure = null;
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  d.log(`p15-groupD ${t.key}: ${failed ? "FAIL" : "PASS"} (${results.length} krokov)`);
  return { exitCode: failed ? 1 : 0, results };
}
