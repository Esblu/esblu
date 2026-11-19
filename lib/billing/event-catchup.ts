// =============================================================================
// S12 (2026-11-19) — doťahovanie zmeškaných udalostí providera (Stripe `GET /v1/events`).
//
// Prečo: webhook je primárna cesta, ale úplne chýbajúca udalosť (endpoint dlhšie nedostupný,
// chybná konfigurácia) by inak ostala neodhalená — hlavne plná refundácia a prehraný spor, pri
// ktorých predplatné u Stripe ostáva `active`. Toto je druhá, nezávislá cesta:
//
//   1. kontrola účtu: Stripe účet kľúča (`/v1/account`) musí byť ten istý, pre ktorý vznikol kurzor
//      (iný účet / sandbox → ACCOUNT_MISMATCH, nič sa nespracuje; reset iba operátor),
//   2. lease v DB (esblu_billing_event_cursor_claim) — súbežné behy sa vylúčia,
//   3. udalosti OD kurzora dopredu (`ending_before` = stránka bezprostredne novšia ako kurzor),
//      spracované od najstaršej po najnovšiu tou istou pipeline ako webhook
//      (processVerifiedEvent: dedupe podľa ID udalosti, čerstvý stav z API, poradie, terminálne stavy),
//   4. kurzor sa posúva po KAŽDEJ spracovanej udalosti → prerušenie / timeout pokračuje presne tam,
//   5. dočasná chyba (API providera, DB) = stop BEZ posunu kurzora; udalosť sa zopakuje v ďalšom behu,
//   6. limity: max udalostí a strán na beh + časový rozpočet (rate limit Stripe, trvanie funkcie).
//
// Kurzor mimo retencie Stripe (30 dní) → bootstrap od max(posledná udalosť − 1 h, teraz − 30 dní)
// a výsledok `cursor_expired` (prevádzkový signál). Spoľahlivosť po dlhšom výpadku NEZÁVISÍ iba od
// okna: reconciliation (getReconcileState) overuje predplatné aj platbu aktuálnej faktúry priamo.
// Billing vypnutý → volajúci route nič nespustí (žiadne volanie Stripe).
// =============================================================================

import { randomUUID } from "node:crypto";
import { processVerifiedEvent, type BillingDb, type PipelineOutcome } from "@/lib/billing/pipeline";
import { BillingProviderError, type BillingProvider, type VerifiedProviderEvent } from "@/lib/billing/types";

type Obj = Record<string, unknown>;

/** Provider so schopnosťou čítať udalosti (Stripe). */
export interface EventCatchupSource {
  accountRef(): Promise<string>;
  listEvents(params: { endingBefore?: string; startingAfter?: string; createdGte?: number; limit?: number }): Promise<{ events: Obj[]; hasMore: boolean } | "cursor_missing">;
  eventFromApi(event: Obj): VerifiedProviderEvent;
}

export type CatchupOptions = {
  maxEvents?: number;
  maxPages?: number;
  timeBudgetMs?: number;
  lookbackDays?: number;
  leaseSeconds?: number;
  now?: () => number;
};

export type CatchupResult = {
  result: "ok" | "partial" | "busy" | "account_mismatch" | "error";
  processed: number;
  outcomes: Partial<Record<PipelineOutcome, number>>;
  cursorExpired: boolean;
  bootstrap: boolean;
  errorCode?: string;
};

const DAY = 86_400;

function safeCode(error: unknown): string {
  if (error instanceof BillingProviderError) return error.code;
  if (error instanceof Error && /^[A-Z0-9_]{1,60}$/.test(error.message)) return error.message;
  return "CATCHUP_FAILED";
}

export async function runEventCatchup(
  db: BillingDb,
  provider: BillingProvider,
  source: EventCatchupSource,
  options: CatchupOptions = {},
): Promise<CatchupResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const maxEvents = options.maxEvents ?? 200;
  const maxPages = options.maxPages ?? 20;
  const budget = options.timeBudgetMs ?? 45_000;
  const lookbackDays = options.lookbackDays ?? 30;
  const owner = randomUUID();
  const out: CatchupResult = { result: "ok", processed: 0, outcomes: {}, cursorExpired: false, bootstrap: false };

  // 1) správny účet
  let accountRef: string;
  try {
    accountRef = await source.accountRef();
  } catch (error) {
    return { ...out, result: "error", errorCode: `ACCOUNT_CHECK_${safeCode(error)}`.slice(0, 60) };
  }

  // 2) lease
  const claim = await db.rpc("esblu_billing_event_cursor_claim", {
    p_provider: provider.id,
    p_environment: provider.environment,
    p_account_ref: accountRef,
    p_owner: owner,
    p_lease_seconds: options.leaseSeconds ?? 240,
  });
  if (claim.error || !claim.data) return { ...out, result: "error", errorCode: "CURSOR_CLAIM_FAILED" };
  const c = claim.data as { result: string; last_event_id?: string | null; last_event_created?: string | null };
  if (c.result === "busy") return { ...out, result: "busy" };
  if (c.result === "account_mismatch") return { ...out, result: "account_mismatch", errorCode: "ACCOUNT_MISMATCH" };
  if (c.result !== "claimed") return { ...out, result: "error", errorCode: "CURSOR_CLAIM_FAILED" };

  let stopCode: string | undefined;
  let exhausted = false; // limit / čas — pokračuje ďalší beh

  const handle = async (raw: Obj): Promise<boolean> => {
    if (out.processed >= maxEvents || now() - started > budget) {
      exhausted = true;
      return false;
    }
    let event: VerifiedProviderEvent;
    try {
      event = source.eventFromApi(raw);
    } catch (error) {
      // live / poškodená udalosť sa NIKDY nespracuje; preskočiť a posunúť kurzor (trvalá chyba)
      out.outcomes.rejected = (out.outcomes.rejected ?? 0) + 1;
      const code = safeCode(error);
      stopCode = code === "LIVE_MODE_FORBIDDEN" ? "LIVE_EVENT_SKIPPED" : code === "TEST_MODE_FORBIDDEN" ? "TEST_EVENT_SKIPPED" : stopCode;
      return advance(raw);
    }
    const res = await processVerifiedEvent(provider, event, db);
    out.outcomes[res.outcome] = (out.outcomes[res.outcome] ?? 0) + 1;
    if (res.outcome === "retry") {
      stopCode = res.code ?? "RETRY";
      return false; // kurzor sa NEposúva — udalosť sa zopakuje
    }
    out.processed++;
    return advance(raw);
  };

  const advance = async (raw: Obj): Promise<boolean> => {
    const id = typeof raw.id === "string" ? raw.id : null;
    const created = typeof raw.created === "number" ? new Date(raw.created * 1000).toISOString() : null;
    if (!id || !created) return true;
    const r = await db.rpc("esblu_billing_event_cursor_advance", {
      p_provider: provider.id,
      p_environment: provider.environment,
      p_owner: owner,
      p_event_id: id,
      p_event_created: created,
    });
    if (r.error || r.data !== true) {
      stopCode = "LEASE_LOST";
      return false;
    }
    return true;
  };

  try {
    let cursor = c.last_event_id ?? null;
    let pages = 0;
    if (cursor) {
      // 3) dopredu od kurzora
      for (;;) {
        if (pages >= maxPages || now() - started > budget) { exhausted = true; break; }
        const page = await source.listEvents({ endingBefore: cursor, limit: 100 });
        pages++;
        if (page === "cursor_missing") {
          out.cursorExpired = true;
          cursor = null;
          break;
        }
        const ascending = [...page.events].reverse();
        let ok = true;
        for (const raw of ascending) {
          if (!(await handle(raw))) { ok = false; break; }
          cursor = String(raw.id);
        }
        if (!ok || !page.hasMore || ascending.length === 0) break;
      }
    }
    if (!cursor && !stopCode && !exhausted) {
      // Bootstrap: prvý beh alebo kurzor mimo retencie → celé okno odzadu, potom od najstaršej.
      out.bootstrap = true;
      const lastCreated = c.last_event_created ? Math.floor(Date.parse(c.last_event_created) / 1000) - 3600 : 0;
      const createdGte = Math.max(lastCreated, Math.floor(now() / 1000) - lookbackDays * DAY);
      const collected: Obj[] = [];
      let startingAfter: string | undefined;
      for (;;) {
        if (pages >= maxPages) throw new Error("BOOTSTRAP_TOO_LARGE");
        const page = await source.listEvents({ startingAfter, createdGte, limit: 100 });
        pages++;
        if (page === "cursor_missing") throw new Error("BOOTSTRAP_LIST_FAILED");
        collected.push(...page.events);
        if (!page.hasMore || page.events.length === 0) break;
        startingAfter = String(page.events[page.events.length - 1].id);
      }
      for (const raw of collected.reverse()) {
        if (!(await handle(raw))) break;
      }
    }
  } catch (error) {
    stopCode = safeCode(error);
  }

  const ok = !stopCode || stopCode === "LIVE_EVENT_SKIPPED" || stopCode === "TEST_EVENT_SKIPPED";
  await db.rpc("esblu_billing_event_cursor_release", {
    p_provider: provider.id,
    p_environment: provider.environment,
    p_owner: owner,
    p_ok: ok,
    p_error_code: ok ? (out.cursorExpired ? "CURSOR_EXPIRED" : null) : stopCode,
  });
  if (!ok) return { ...out, result: "error", errorCode: stopCode };
  return { ...out, result: exhausted ? "partial" : "ok", errorCode: stopCode };
}
