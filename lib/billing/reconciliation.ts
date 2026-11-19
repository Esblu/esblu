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

import { isOpenStatus, isTerminalStatus } from "@/lib/billing/canonical-state";
import { applyProviderState, recordProviderAudit, type BillingDb } from "@/lib/billing/pipeline";
import { sha256Hex } from "@/lib/billing/signature";
import { BillingProviderError, type BillingEnvironment, type BillingProviderId, type NormalizedSubscriptionState } from "@/lib/billing/types";

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
  scheduled_end_at?: string | null;
  plan_code: string | null;
};

/**
 * Stav od providera. `providerOpen` = predplatné u providera ešte beží (aj keď kanonický stav je
 * odvodený z platby, napr. `refunded`); `followUp` = po zápise ukončiť u providera (S12).
 */
export type RemoteSubscriptionState = NormalizedSubscriptionState & { providerOpen?: boolean; followUp?: "cancel_provider_now" };

/** Zdroj autoritatívneho stavu jedného providera (Stripe/fake API, Play Developer API, App Store Server API). */
export interface ReconcileSource {
  readonly provider: BillingProviderId;
  /** S15: prostredie providera (audit, synchronizácia); chýba = "test" (obchody, fake). */
  readonly environment?: BillingEnvironment;
  fetchState(candidate: ReconcileCandidate): Promise<RemoteSubscriptionState | null>;
  /** Okamžité ukončenie u providera (Stripe/fake) — poistka pre terminálny účet s otvoreným predplatným. */
  cancelNow?(candidate: ReconcileCandidate): Promise<NormalizedSubscriptionState>;
}

export type ReconcileItemResult = {
  accountId: string;
  result: "in_sync" | "corrected" | "error" | "skipped";
  errorCode?: string;
};

const sameInstant = (a: string | null, b: string | null) =>
  (a === null && b === null) || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

/** Líši sa stav providera od lokálneho kanonického stavu (polia, ktoré menia nároky)? */
export function hasDrift(local: Pick<ReconcileCandidate, "status" | "current_period_end" | "cancel_at_period_end" | "scheduled_end_at">, remote: NormalizedSubscriptionState): boolean {
  return local.status !== remote.status || !sameInstant(local.current_period_end, remote.current_period_end) || local.cancel_at_period_end !== remote.cancel_at_period_end
    || !sameInstant(local.scheduled_end_at ?? null, remote.scheduled_end_at ?? null);
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
  // S15: účet z iného prostredia (test ↔ live) sa nikdy neoveruje tým istým providerom (iný kľúč, iný účet).
  const sourceEnv = source.environment ?? "test";
  if (candidate.provider_environment && candidate.provider_environment !== sourceEnv) {
    await record(db, candidate.account_id, "skipped", "ENVIRONMENT_MISMATCH");
    return { accountId: candidate.account_id, result: "skipped", errorCode: "ENVIRONMENT_MISMATCH" };
  }
  let remote: RemoteSubscriptionState | null;
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
  // Terminálny účet v Esblu (refunded/revoked), ale predplatné u providera stále beží → ukončiť
  // u providera (inak by firma bez prístupu platila ďalšie obdobia). Stav v Esblu ostáva terminálny.
  const providerOpen = remote.providerOpen ?? isOpenStatus(remote.status);
  if (isTerminalStatus(candidate.status) && (candidate.status === "refunded" || candidate.status === "revoked") && providerOpen) {
    if (!source.cancelNow) {
      await record(db, candidate.account_id, "error", "TERMINAL_PROVIDER_OPEN");
      return { accountId: candidate.account_id, result: "error", errorCode: "TERMINAL_PROVIDER_OPEN" };
    }
    try {
      const ended = await withTimeout(source.cancelNow(candidate), options.timeoutMs ?? 15_000);
      await recordProviderAudit(db, { id: candidate.billing_provider, environment: source.environment ?? "test" }, "terminal_cancel", ended, "PROVIDER_CANCELED");
      await record(db, candidate.account_id, "corrected", null);
      return { accountId: candidate.account_id, result: "corrected", errorCode: "PROVIDER_CANCELED" };
    } catch (error) {
      const code = errorCode(error);
      await record(db, candidate.account_id, "error", code);
      return { accountId: candidate.account_id, result: "error", errorCode: code };
    }
  }
  if (!hasDrift(candidate, remote)) {
    await record(db, candidate.account_id, "in_sync", null);
    return { accountId: candidate.account_id, result: "in_sync" };
  }
  // Oprava = syntetický event tou istou pipeline (dedupe podľa stavu + času).
  const applied = await applyProviderState(
    db,
    { id: candidate.billing_provider, environment: source.environment ?? "test" },
    "reconcile",
    remote,
    sha256Hex(JSON.stringify(remote)),
  );
  if (applied.outcome === "applied" || applied.outcome === "duplicate" || applied.outcome === "stale") {
    // S12: chýbajúci webhook o plnej refundácii / prehratom spore → po zápise terminálneho stavu
    // ukončiť predplatné aj u providera (rovnako ako webhooková cesta), aby sa ďalej neúčtovalo.
    if (remote.followUp === "cancel_provider_now" && providerOpen && source.cancelNow) {
      try {
        const ended = await withTimeout(source.cancelNow(candidate), options.timeoutMs ?? 15_000);
        await recordProviderAudit(db, { id: candidate.billing_provider, environment: source.environment ?? "test" }, "terminal_cancel", ended, "PROVIDER_CANCELED");
      } catch {
        // ďalší beh: terminálny účet + otvorené predplatné → cancelNow (vetva vyššie)
      }
    }
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
