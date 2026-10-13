// =============================================================================
// E-Faktúra — partnerský feed udalostí GET /v1/agent/events s perzistentným kurzorom.
//
// Fallback k webhookom (výpadok dlhší než opakovania, firewall). Pravidlá:
//   - jeden kurzor na (provider, environment) — feed je partnerský (všetky org);
//     tenant izolácia je v spracovaní (firma IBA z mapovania org, processProviderEvent),
//   - lease proti súbežnému behu (claim), kurzor sa posúva iba dopredu a iba za
//     úspešne spracované udalosti (advance po každej stránke),
//   - udalosť, ktorej spracovanie zlyhalo (ACCEPTED_RETRY_LATER), zastaví posun —
//     ďalší beh ju zopakuje; DB obmedzí počet pokusov (esblu_einvoice_webhook_retry),
//     potom sa berie ako DUPLICATE a kurzor pokračuje (žiadne nekonečné opakovanie,
//     žiadne tiché preskočenie — udalosť ostáva `failed` pre operátora),
//   - dedupe s webhookom: rovnaká udalosť z feedu má ID `feed:<event_id|id>`;
//     spracovanie je idempotentné (participant RPC so stale kontrolou, inbound
//     registrácia podľa ID poskytovateľa, outbound claim podľa podania).
// =============================================================================

import type { EinvoiceEnvironment, PartnerEventPage } from "../provider/types.ts";
import { processPartnerEventPage, type WebhookDeps } from "./webhook.ts";

export interface EventCursorStore {
  /** null = beží iný beh (lease). */
  claim(provider: string, environment: EinvoiceEnvironment, leaseSeconds: number): Promise<{ lastEventId: number; lockToken: string } | null>;
  /** Monotónny posun (greatest); release uvoľní lease. Stratený lease → chyba. */
  advance(provider: string, environment: EinvoiceEnvironment, lockToken: string, lastEventId: number, release: boolean, errorCode?: string | null): Promise<number>;
}

export type FeedDeps = {
  cursor: EventCursorStore;
  listEvents: (input: { after?: string; limit?: number }) => Promise<PartnerEventPage>;
  webhook: WebhookDeps;
};

export type FeedSyncResult =
  | { code: "LOCKED" }
  | { code: "OK" | "STOPPED_ON_FAILURE" | "LIST_FAILED"; from: number; to: number; processed: number; pages: number; results: Record<string, number> };

export async function runPartnerFeedSync(
  deps: FeedDeps,
  options: { maxPages?: number; pageSize?: number; leaseSeconds?: number } = {}
): Promise<FeedSyncResult> {
  const provider = deps.webhook.provider.name;
  const env = deps.webhook.environment;
  const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 5));
  const pageSize = Math.max(1, Math.min(500, options.pageSize ?? 100));
  const claim = await deps.cursor.claim(provider, env, options.leaseSeconds ?? 120);
  if (!claim) return { code: "LOCKED" };

  const from = claim.lastEventId;
  let last = from;
  let pages = 0;
  let processed = 0;
  let code: "OK" | "STOPPED_ON_FAILURE" | "LIST_FAILED" = "OK";
  const results: Record<string, number> = {};
  try {
    outer: while (pages < maxPages) {
      let page: PartnerEventPage;
      try {
        page = await deps.listEvents({ after: last > 0 ? String(last) : undefined, limit: pageSize });
      } catch {
        code = "LIST_FAILED";
        break;
      }
      pages++;
      const events = page.events
        .filter((e) => /^[0-9]{1,15}$/.test(e.id) && Number(e.id) > last)
        .sort((a, b) => Number(a.id) - Number(b.id));
      for (const e of events) {
        const res = await processPartnerEventPage(deps.webhook, { events: [e] });
        const r = res.results[0]?.code ?? "UNKNOWN";
        results[r] = (results[r] ?? 0) + 1;
        if (r === "ACCEPTED_RETRY_LATER") {
          code = "STOPPED_ON_FAILURE";
          break outer;
        }
        last = Number(e.id);
        processed++;
      }
      if (last > from) await deps.cursor.advance(provider, env, claim.lockToken, last, false);
      if (!page.hasMore || events.length === 0) break;
    }
  } finally {
    await deps.cursor.advance(provider, env, claim.lockToken, last, true, code === "OK" ? null : code);
  }
  return { code, from, to: last, processed, pages, results };
}
