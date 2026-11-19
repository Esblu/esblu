// =============================================================================
// E-Faktúra — ukončenie registrácie firmy u poskytovateľa (offboarding) ako
// idempotentný job s retry a stavovým automatom (DB: 20261122110000). Bez I/O
// závislostí: store (service_role RPC) a poskytovateľ sa injektujú.
//
//   request  → job `requested` (idempotentne; odvolá mandáty → nič nové sa neodošle)
//   claim    → `in_progress` (SKIP LOCKED + lease, iba provider + prostredie nasadenia)
//   deactivate u poskytovateľa:
//     2xx                         → completed (DB uloží snapshot mapovania a zmaže ho)
//     409 rozbehnuté prenosy, 429, 5xx, sieť, timeout, 402, 401/403
//                                 → retry_wait (backoff v DB; 402/401/403 aj alert)
//     404 / iné 4xx               → failed (permanentné, alert; operátor overí a requeue)
//   Vyčerpané pokusy → failed + alert. Nikdy sa nepredpokladá úspech bez 2xx.
// =============================================================================

import { EinvoiceProviderError, type EinvoiceDeregistrationProvider, type EinvoiceEnvironment } from "./provider/types.ts";
import { alertForProviderError, type OpsAlertSink } from "./ops/alert-sink.ts";

export type DeregistrationReason = "company_termination" | "owner_request" | "operator";
export type DeregistrationState = "requested" | "in_progress" | "retry_wait" | "completed" | "failed";

export type DeregistrationJob = {
  id: string;
  company_id: string;
  provider: string;
  environment: EinvoiceEnvironment;
  provider_org_id: string;
  state: DeregistrationState;
  attempts: number;
  max_attempts: number;
  last_error_code: string | null;
};

export type DeregistrationStatus = {
  registered: boolean;
  job: { id: string; state: DeregistrationState; attempts: number; last_error_code: string | null } | null;
};

export interface DeregistrationStore {
  request(input: { companyId: string; environment: EinvoiceEnvironment; reason: DeregistrationReason; actorUserId: string | null; operator?: string | null }): Promise<{ jobId: string | null; state: string; created: boolean }>;
  claim(provider: string, environment: EinvoiceEnvironment, limit: number, leaseSeconds: number, jobId?: string | null): Promise<DeregistrationJob[]>;
  finish(input: { jobId: string; outcome: "completed" | "retry" | "failed"; errorCode: string | null; providerOutcome: string | null; providerResponseSha256: string | null; retryAfterSeconds?: number | null }): Promise<DeregistrationJob>;
  status(companyId: string, environment: EinvoiceEnvironment): Promise<DeregistrationStatus>;
}

export type DeregistrationDeps = {
  store: DeregistrationStore;
  provider: EinvoiceDeregistrationProvider;
  environment: EinvoiceEnvironment;
  alerts?: OpsAlertSink;
};

const RETRYABLE_CODES = new Set([
  "EINVOICE_PROVIDER_CONFLICT", // 409: rozbehnuté prenosy (docs) → počkať
  "EINVOICE_PROVIDER_INSUFFICIENT_CREDIT",
  "EINVOICE_PROVIDER_UNAUTHORIZED",
  "EINVOICE_PROVIDER_FORBIDDEN",
]);

export function classifyDeactivateError(error: unknown): { outcome: "retry" | "failed"; code: string; retryAfterSeconds: number | null } {
  if (error instanceof EinvoiceProviderError) {
    const m = /Retry-After (\d+) s/.exec(error.message);
    const retryAfterSeconds = m ? Number(m[1]) : null;
    if (error.retryable || RETRYABLE_CODES.has(error.code)) return { outcome: "retry", code: error.code, retryAfterSeconds };
    return { outcome: "failed", code: error.code, retryAfterSeconds: null };
  }
  return { outcome: "retry", code: "EINVOICE_DEREGISTRATION_INTERNAL_ERROR", retryAfterSeconds: null };
}

const SAFE = (code: string) => (/^[A-Z0-9_]{1,80}$/.test(code) ? code : "EINVOICE_DEREGISTRATION_ERROR");

/** Jeden už claimnutý job (lease drží volajúci). */
export async function runDeregistrationJob(deps: DeregistrationDeps, job: DeregistrationJob): Promise<DeregistrationJob> {
  if (job.provider !== deps.provider.name || job.environment !== deps.environment) {
    return deps.store.finish({ jobId: job.id, outcome: "retry", errorCode: "EINVOICE_PROVIDER_MISMATCH", providerOutcome: null, providerResponseSha256: null });
  }
  let finished: DeregistrationJob;
  try {
    const res = await deps.provider.deactivatePeppol({ environment: job.environment, providerOrgId: job.provider_org_id });
    const outcome = res.peppolStatus && /^[A-Za-z0-9_:.-]{1,80}$/.test(res.peppolStatus) ? res.peppolStatus : "deactivated";
    finished = await deps.store.finish({ jobId: job.id, outcome: "completed", errorCode: null, providerOutcome: outcome, providerResponseSha256: res.responseSha256 });
  } catch (error) {
    const c = classifyDeactivateError(error);
    const alert = alertForProviderError(c.code);
    if (alert) await deps.alerts?.raise({ ...alert, provider: deps.provider.name, environment: job.environment, detailCode: c.code });
    finished = await deps.store.finish({ jobId: job.id, outcome: c.outcome, errorCode: SAFE(c.code), providerOutcome: null, providerResponseSha256: null, retryAfterSeconds: c.retryAfterSeconds });
  }
  if (finished.state === "failed") {
    await deps.alerts?.raise({
      code: "DEREGISTRATION_FAILED",
      severity: "critical",
      provider: deps.provider.name,
      environment: job.environment,
      companyId: job.company_id,
      detailCode: finished.last_error_code,
    });
  }
  return finished;
}

/** Dávka (cron): po jednom jobe, s termínom. Chyba pri jednom jobe nezastaví ostatné. */
export async function runDeregistrationBatch(
  deps: DeregistrationDeps,
  options: { batchSize?: number; leaseSeconds?: number; deadlineMs?: number; itemBudgetMs?: number } = {}
): Promise<{ claimed: number; results: { id: string; state: string; code: string | null }[] }> {
  const max = Math.max(1, Math.min(10, Math.floor(options.batchSize ?? 5)));
  const results: { id: string; state: string; code: string | null }[] = [];
  let claimed = 0;
  for (let i = 0; i < max; i++) {
    if (options.deadlineMs !== undefined && Date.now() + (options.itemBudgetMs ?? 0) > options.deadlineMs) break;
    const jobs = await deps.store.claim(deps.provider.name, deps.environment, 1, options.leaseSeconds ?? 120);
    if (jobs.length === 0) break;
    claimed += jobs.length;
    for (const job of jobs) {
      try {
        const r = await runDeregistrationJob(deps, job);
        results.push({ id: r.id, state: r.state, code: r.last_error_code });
      } catch {
        // zápis výsledku zlyhal — lease vyprší a job sa zoberie znova (deactivate je idempotentná operácia)
        results.push({ id: job.id, state: job.state, code: "EINVOICE_DEREGISTRATION_STORE_ERROR" });
      }
    }
  }
  return { claimed, results };
}

export type EnsureDeregisteredResult =
  | { done: true; jobId: string | null }
  | { done: false; jobId: string | null; state: string; code: string };

/**
 * Ukončenie firmy: zaradí (idempotentne) deregistráciu a hneď skúsi jeden pokus.
 * done = firma v prostredí tohto nasadenia už nie je registrovaná u poskytovateľa.
 * Inak volajúci vráti 409 (job beží ďalej z cronu s retry).
 */
export async function ensureCompanyDeregistered(
  deps: { store: DeregistrationStore; runtime: Omit<DeregistrationDeps, "store"> | null },
  input: { companyId: string; actorUserId: string; reason: Exclude<DeregistrationReason, "operator"> },
  environment: EinvoiceEnvironment | null
): Promise<EnsureDeregisteredResult> {
  if (!environment) return { done: false, jobId: null, state: "provider_not_configured", code: "EINVOICE_PROVIDER_NOT_CONFIGURED" };
  const status = await deps.store.status(input.companyId, environment);
  if (!status.registered) return { done: true, jobId: status.job?.id ?? null };
  const req = await deps.store.request({ companyId: input.companyId, environment, reason: input.reason, actorUserId: input.actorUserId });
  if (req.state === "completed" || req.state === "not_registered") return { done: true, jobId: req.jobId };
  if (!deps.runtime || deps.runtime.environment !== environment) {
    return { done: false, jobId: req.jobId, state: req.state, code: "EINVOICE_PROVIDER_NOT_CONFIGURED" };
  }
  const [job] = req.jobId ? await deps.store.claim(deps.runtime.provider.name, environment, 1, 120, req.jobId) : [];
  if (!job) return { done: false, jobId: req.jobId, state: req.state, code: "EINVOICE_DEREGISTRATION_PENDING" };
  const finished = await runDeregistrationJob({ ...deps.runtime, store: deps.store }, job);
  if (finished.state === "completed") return { done: true, jobId: finished.id };
  return { done: false, jobId: finished.id, state: finished.state, code: finished.state === "failed" ? "EINVOICE_DEREGISTRATION_FAILED" : "EINVOICE_DEREGISTRATION_PENDING" };
}
