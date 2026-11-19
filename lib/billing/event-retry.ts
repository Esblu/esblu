// =============================================================================
// P4 (2026-11-23) — automatické opakovanie zlyhaných billing udalostí (Stripe).
//
// Udalosť, ktorá zlyhala (webhook aj doťahovanie: dočasná chyba API, DB, zápisu dokladu, alebo ostala
// rozpracovaná), má v DB plán opakovania (trigger, 20261123100000): backoff 5 min → 6 h, max. 8 pokusov,
// potom dead-letter (ops alert EVENT_DEAD_LETTER). Telo udalosti Esblu neukladá → udalosť sa znova
// načíta z API providera (`GET /v1/events/{id}`, autentický kanál) a spracuje TOU ISTOU pipeline
// (processVerifiedEvent: dedupe, čerstvý stav z API, poradie, terminálne stavy, doklady) s
// payload_sha256 = null (nález § 2.3 — iná serializácia nie je podvrh).
//   - udalosť u providera neexistuje (mimo 30-dňovej retencie) → dead-letter EVENT_UNAVAILABLE,
//   - udalosť iného prostredia (test ↔ live) → dead-letter (nikdy sa nespracuje),
//   - dočasná chyba pri načítaní → bez zmeny; lease (10 min) vyprší a ďalší beh to skúsi znova.
// Spúšťa ho cron doťahovania (app/api/cron/billing-stripe-events) po doťahovaní.
// =============================================================================

import { processVerifiedEvent, type BillingDb, type PipelineOutcome } from "@/lib/billing/pipeline";
import { BillingProviderError, type BillingProvider, type VerifiedProviderEvent } from "@/lib/billing/types";

type Obj = Record<string, unknown>;

export interface EventRetrySource {
  fetchEvent(eventId: string): Promise<Obj | null>;
  eventFromApi(event: Obj): VerifiedProviderEvent;
}

export type RetryResult = {
  claimed: number;
  outcomes: Partial<Record<PipelineOutcome | "dead_letter" | "fetch_failed", number>>;
  errorCode?: string;
};

export async function runFailedEventRetry(
  db: BillingDb,
  provider: BillingProvider,
  source: EventRetrySource,
  options: { limit?: number; timeBudgetMs?: number; now?: () => number } = {},
): Promise<RetryResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const out: RetryResult = { claimed: 0, outcomes: {} };
  const bump = (k: keyof RetryResult["outcomes"]) => { out.outcomes[k] = (out.outcomes[k] ?? 0) + 1; };

  const claim = await db.rpc("esblu_billing_event_retry_claim", {
    p_provider: provider.id,
    p_environment: provider.environment,
    p_limit: options.limit ?? 20,
  });
  if (claim.error) return { ...out, errorCode: "RETRY_CLAIM_FAILED" };
  const rows = (Array.isArray(claim.data) ? claim.data : []) as Array<{ provider_event_id: string }>;
  out.claimed = rows.length;

  const deadLetter = async (eventId: string, code: string) => {
    await db.rpc("esblu_billing_event_dead_letter", {
      p_provider: provider.id,
      p_environment: provider.environment,
      p_provider_event_id: eventId,
      p_error_code: code,
    });
    bump("dead_letter");
  };

  for (const row of rows) {
    if (now() - started > (options.timeBudgetMs ?? 15_000)) break; // zvyšok: lease vyprší, ďalší beh
    let raw: Obj | null;
    try {
      raw = await source.fetchEvent(row.provider_event_id);
    } catch {
      bump("fetch_failed");
      continue;
    }
    if (!raw) {
      await deadLetter(row.provider_event_id, "EVENT_UNAVAILABLE");
      continue;
    }
    let event: VerifiedProviderEvent;
    try {
      event = source.eventFromApi(raw);
    } catch (error) {
      const code = error instanceof BillingProviderError ? error.code : "MALFORMED_PAYLOAD";
      await deadLetter(row.provider_event_id, code === "LIVE_MODE_FORBIDDEN" || code === "TEST_MODE_FORBIDDEN" ? "ENVIRONMENT_MISMATCH" : "MALFORMED_PAYLOAD");
      continue;
    }
    if (event.eventId !== row.provider_event_id) {
      await deadLetter(row.provider_event_id, "MALFORMED_PAYLOAD");
      continue;
    }
    const result = await processVerifiedEvent(provider, event, db);
    bump(result.outcome);
  }
  return out;
}
