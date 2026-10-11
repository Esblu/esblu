// =============================================================================
// Reconciliation (self-healing) — webhooky NIE sú jediný zdroj synchronizácie.
//
//   1. esblu_billing_reconcile_candidates  → predplatné, ktoré treba overiť
//   2. ReconcileSource.fetchState          → autoritatívny stav od providera
//   3. porovnanie s lokálnym kanonickým stavom
//   4. drift → oprava TOU ISTOU pipeline (record → apply_event; poradie aj
//      idempotencia platia rovnako ako pri webhooku)
//   5. esblu_billing_reconcile_record      → výsledok, backoff, dead-letter
//
// Loguje sa iba technické metadata (kódy chýb) — nikdy secrets, tokeny ani
// osobné údaje. Spúšťa ho iba explicitný cron/operátor (žiadny production cron).
// =============================================================================

import { applyProviderState, type BillingDb } from "@/lib/billing/pipeline";
import { sha256Hex } from "@/lib/billing/signature";
import { BillingProviderError, type BillingProviderId, type NormalizedSubscriptionState } from "@/lib/billing/types";

export type ReconcileCandidate = {
  account_id: string;
  company_id: string;
  billing_provider: BillingProviderId;
  provider_environment: string | null;
  provider_subscription_id: string;
  provider_customer_id: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  plan_code: string | null;
};

/** Zdroj autoritatívneho stavu jedného providera (Stripe/fake API, Play Developer API, App Store Server API). */
export interface ReconcileSource {
  readonly provider: BillingProviderId;
  fetchState(candidate: ReconcileCandidate): Promise<NormalizedSubscriptionState | null>;
}

export type ReconcileItemResult = {
  accountId: string;
  result: "in_sync" | "corrected" | "error" | "skipped";
  errorCode?: string;
};

const sameInstant = (a: string | null, b: string | null) =>
  (a === null && b === null) || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

/** Líši sa stav providera od lokálneho kanonického stavu (polia, ktoré menia nároky)? */
export function hasDrift(local: Pick<ReconcileCandidate, "status" | "current_period_end" | "cancel_at_period_end">, remote: NormalizedSubscriptionState): boolean {
  return local.status !== remote.status || !sameInstant(local.current_period_end, remote.current_period_end) || local.cancel_at_period_end !== remote.cancel_at_period_end;
}

function errorCode(error: unknown): string {
  if (error instanceof BillingProviderError) return error.code;
  if (error instanceof Error && error.message === "PROVIDER_TIMEOUT") return "PROVIDER_TIMEOUT";
  return "RECONCILE_FAILED";
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PROVIDER_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function record(db: BillingDb, accountId: string, result: ReconcileItemResult["result"], code: string | null) {
  await db.rpc("esblu_billing_reconcile_record", { p_account_id: accountId, p_result: result, p_error_code: code });
}

export async function reconcileOne(
  db: BillingDb,
  sources: Partial<Record<BillingProviderId, ReconcileSource>>,
  candidate: ReconcileCandidate,
  options: { timeoutMs?: number } = {},
): Promise<ReconcileItemResult> {
  const source = sources[candidate.billing_provider];
  if (!source) {
    await record(db, candidate.account_id, "skipped", "PROVIDER_NOT_CONFIGURED");
    return { accountId: candidate.account_id, result: "skipped", errorCode: "PROVIDER_NOT_CONFIGURED" };
  }
  let remote: NormalizedSubscriptionState | null;
  try {
    remote = await withTimeout(source.fetchState(candidate), options.timeoutMs ?? 15_000);
  } catch (error) {
    const code = errorCode(error);
    if (code === "NOT_CONFIGURED") {
      await record(db, candidate.account_id, "skipped", code);
      return { accountId: candidate.account_id, result: "skipped", errorCode: code };
    }
    await record(db, candidate.account_id, "error", code);
    return { accountId: candidate.account_id, result: "error", errorCode: code };
  }
  if (!remote) {
    await record(db, candidate.account_id, "error", "PROVIDER_NO_STATE");
    return { accountId: candidate.account_id, result: "error", errorCode: "PROVIDER_NO_STATE" };
  }
  if (!hasDrift(candidate, remote)) {
    await record(db, candidate.account_id, "in_sync", null);
    return { accountId: candidate.account_id, result: "in_sync" };
  }
  // Oprava = syntetický event tou istou pipeline (dedupe podľa stavu + času).
  const applied = await applyProviderState(
    db,
    { id: candidate.billing_provider, environment: "test" },
    "reconcile",
    remote,
    sha256Hex(JSON.stringify(remote)),
  );
  if (applied.outcome === "applied" || applied.outcome === "duplicate" || applied.outcome === "stale") {
    await record(db, candidate.account_id, applied.outcome === "applied" ? "corrected" : "in_sync", null);
    return { accountId: candidate.account_id, result: applied.outcome === "applied" ? "corrected" : "in_sync" };
  }
  const code = applied.code && /^[A-Z0-9_]{1,80}$/.test(applied.code) ? applied.code : "APPLY_FAILED";
  await record(db, candidate.account_id, "error", code);
  return { accountId: candidate.account_id, result: "error", errorCode: code };
}

/** Jeden beh: max `limit` kandidátov, sekvenčne (bez paralelného tlaku na API providerov). */
export async function runReconciliation(
  db: BillingDb,
  sources: Partial<Record<BillingProviderId, ReconcileSource>>,
  options: { limit?: number; timeoutMs?: number } = {},
): Promise<{ checked: number; results: ReconcileItemResult[] }> {
  const { data, error } = await db.rpc("esblu_billing_reconcile_candidates", { p_limit: options.limit ?? 50 });
  if (error) throw new Error("RECONCILE_CANDIDATES_FAILED");
  const candidates = (Array.isArray(data) ? data : []) as ReconcileCandidate[];
  const results: ReconcileItemResult[] = [];
  for (const candidate of candidates) {
    results.push(await reconcileOne(db, sources, candidate, options));
  }
  return { checked: candidates.length, results };
}
