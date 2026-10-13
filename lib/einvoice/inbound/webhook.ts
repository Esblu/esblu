import "server-only";

import { createHash } from "node:crypto";
import { verifyEfakturaWebhookSignature } from "../provider/efaktura-sk-webhook.ts";
import type { EinvoiceEnvironment, EinvoiceProvider } from "../provider/types.ts";
import { reconcileOutboundRow } from "../outbound/worker.ts";
import type { OutboundStore } from "../outbound/store.ts";
import { errorCode } from "../outbound/policy.ts";
import { runInboundProcessBatch, syncInboundList } from "./processor.ts";
import type { InboundStore } from "./store.ts";

// =============================================================================
// E-Faktúra webhook — overenie, dedupe a spustenie spracovania. SERVER-ONLY.
//
//   1. surové telo (limit veľkosti) → HMAC podpis + časové okno (existujúci
//      helper, porovnanie v konštantnom čase) — PRED JSON parsovaním,
//   2. z tela sa po overení použije IBA: ID doručenia, typ udalosti,
//      provider_org_id a (pri outbound udalosti) ID podania ako kľúč na dotaz,
//   3. dedupe doručenia (einvoice_webhook_events: ID + SHA-256 tela; telo sa
//      neukladá), firma IBA z mapovania organizácie,
//   4. inbound udalosť → zoznam nepotvrdených dokladov a dokument sa NAČÍTAJÚ
//      ZNOVA od poskytovateľa; outbound udalosť → iba reconciliation daného
//      podania (stav sa potvrdí dotazom u poskytovateľa, nikdy z webhooku).
// Nič z tela webhooku sa neloguje.
// =============================================================================

export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export type WebhookDeps = {
  inbound: InboundStore;
  outbound: OutboundStore;
  provider: EinvoiceProvider;
  environment: EinvoiceEnvironment;
  secrets: string[];
  nowSeconds: () => number;
  /** Phase 4: ohraničené počítadlo odmietnutí (bez tela/hlavičiek) — best effort. */
  recordRejection?: (reason: "INVALID_SIGNATURE" | "REPLAYED_WEBHOOK" | "PAYLOAD_TOO_LARGE" | "INVALID_PAYLOAD") => Promise<void>;
};

export type WebhookResponse = { status: number; body: { code: string } };

const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Identifikátor prenosu z webhooku (AS4 message id / SBDH InstanceIdentifier): tlačiteľné ASCII, max 200. */
function transportId(value: unknown): string | null {
  return typeof value === "string" && /^[\x21-\x7e]{1,200}$/.test(value) ? value : null;
}
const EVENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/** Terminálne stavy pokusu (DB trigger ich už nedovolí zmeniť). */
const TERMINAL_OUTBOUND = new Set(["delivered", "failed", "rejected"]);

type EventKind = "inbound" | "outbound" | "participant" | "other";

export const PARTICIPANT_EVENTS = ["participant.activated", "participant.failed", "participant.deactivated"] as const;
export type ParticipantEvent = (typeof PARTICIPANT_EVENTS)[number];

/**
 * Typ udalosti → druh. participant.* sa kontroluje PRVÉ (inak by „participant.failed"
 * spadol do outbound kvôli slovu „failed"). Neznáme = ignorované.
 * Partnerské udalosti (docs/webhooks, 2026-10): peppol.document.{sent,delivered,failed,received},
 * participant.{activated,failed,deactivated}, usage.limit_exceeded.
 */
export function classifyWebhookEvent(event: string): EventKind {
  const e = event.toLowerCase();
  if ((PARTICIPANT_EVENTS as readonly string[]).includes(e)) return "participant";
  if (e.startsWith("participant.") || e.startsWith("usage.") || e.startsWith("webhook.")) return "other";
  if (/(^|[._:])(received|inbound|incoming)([._:]|$)/.test(e)) return "inbound";
  if (/(^|[._:])(sent|delivered|deferred|failed|error|status|outbound|transmission)([._:]|$)/.test(e)) return "outbound";
  return "other";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export async function handleEinvoiceWebhook(
  deps: WebhookDeps,
  input: { rawBody: Uint8Array; signatureHeader: string | null; deliveryIdHeader: string | null }
): Promise<WebhookResponse> {
  const result = await handleVerified(deps, input);
  const code = result.body.code;
  if (deps.recordRejection && (code === "INVALID_SIGNATURE" || code === "REPLAYED_WEBHOOK" || code === "PAYLOAD_TOO_LARGE" || code === "INVALID_PAYLOAD")) {
    try {
      await deps.recordRejection(code);
    } catch {
      // počítadlo nesmie ovplyvniť odpoveď
    }
  }
  return result;
}

async function handleVerified(
  deps: WebhookDeps,
  input: { rawBody: Uint8Array; signatureHeader: string | null; deliveryIdHeader: string | null }
): Promise<WebhookResponse> {
  if (deps.secrets.length === 0) return { status: 503, body: { code: "NOT_CONFIGURED" } };
  if (input.rawBody.byteLength > WEBHOOK_MAX_BODY_BYTES) return { status: 413, body: { code: "PAYLOAD_TOO_LARGE" } };

  const verified = verifyEfakturaWebhookSignature({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    secrets: deps.secrets,
    nowSeconds: deps.nowSeconds(),
  });
  if (!verified.ok) {
    if (verified.reason === "STALE_TIMESTAMP" || verified.reason === "FUTURE_TIMESTAMP") {
      return { status: 401, body: { code: "REPLAYED_WEBHOOK" } };
    }
    return { status: 401, body: { code: "INVALID_SIGNATURE" } };
  }

  // Až teraz (podpis platný) sa telo parsuje — a použijú sa iba identifikátory.
  let payload: Record<string, unknown> | null = null;
  try {
    payload = obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody)));
  } catch {
    payload = null;
  }
  if (!payload) return { status: 400, body: { code: "INVALID_PAYLOAD" } };
  const deliveryId = str(input.deliveryIdHeader) ?? str(payload.id) ?? str(payload.delivery_id);
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  return processProviderEvent(deps, { deliveryId, payload, bodySha256 });
}

/**
 * Spracovanie UŽ OVERENEJ udalosti (webhook po HMAC, alebo partnerský feed
 * GET /v1/agent/events cez autentifikovaný API kľúč). Spoločné pre oba zdroje.
 */
export async function processProviderEvent(
  deps: WebhookDeps,
  input: { deliveryId: string | null; payload: Record<string, unknown>; bodySha256: string }
): Promise<WebhookResponse> {
  const { deliveryId, payload, bodySha256 } = input;
  const data = obj(payload.data);
  const event = str(payload.event) ?? str(payload.type);
  // Docs (developers.efaktura.sk/docs/webhooks, 2026-10): obálka {event, timestamp, data},
  // `data.orgId` je VŽDY prítomné. snake_case varianty ostávajú ako fallback.
  const providerOrgId =
    str(data?.orgId) ?? str(payload.organization_id) ?? str(payload.org_id) ?? str(data?.organization_id) ?? str(data?.org_id);
  if (!deliveryId || !DELIVERY_ID.test(deliveryId) || !event || !EVENT.test(event)) {
    return { status: 400, body: { code: "INVALID_PAYLOAD" } };
  }
  const orgId = providerOrgId && ORG_ID.test(providerOrgId) ? providerOrgId : null;

  const record = await deps.inbound.webhookRecord({
    provider: deps.provider.name,
    environment: deps.environment,
    deliveryId,
    providerOrgId: orgId,
    event,
    bodySha256,
  });
  if (!record.inserted) {
    // To isté doručenie znova: iné telo pod tým istým ID = replay (409). Rovnaké telo =
    // idempotentné OK — okrem predošlého ZLYHANÉHO spracovania, ktoré sa smie zopakovať
    // (ohraničený počet pokusov v DB; webhook aj feed kurzor).
    if (!record.bodyMatches) return { status: 409, body: { code: "REPLAYED_WEBHOOK" } };
    const retry = record.processingStatus === "failed" && deps.inbound.webhookRetry ? await deps.inbound.webhookRetry(record.webhookEventId) : false;
    if (!retry) return { status: 200, body: { code: "DUPLICATE" } };
  }
  if (!record.companyId || !orgId) {
    // Zaznamenané ako rejected/UNKNOWN_ORG; 200 = poskytovateľ to neopakuje donekonečna.
    return { status: 200, body: { code: "UNKNOWN_ORG" } };
  }

  // `data.mode` = "test" pri sandbox (test) odosielaní. Udalosť z inej siete,
  // než je serverové prostredie, sa nespracuje (ochrana proti zámene prostredí).
  const mode = str(data?.mode);
  if (mode && ((mode === "test") !== (deps.environment === "sandbox"))) {
    await deps.inbound.webhookComplete(record.webhookEventId, "ignored", "ENVIRONMENT_MISMATCH");
    return { status: 200, body: { code: "IGNORED" } };
  }

  const kind = classifyWebhookEvent(event);
  try {
    if (kind === "participant") {
      if (!deps.inbound.participantEvent) {
        await deps.inbound.webhookComplete(record.webhookEventId, "ignored", "EVENT_NOT_HANDLED");
        return { status: 200, body: { code: "IGNORED" } };
      }
      // Z tela iba: participantId (formát overí DB), kód chyby (A-Z0-9_), čas udalosti.
      const participantId = str(data?.participantId);
      const code = str(data?.code);
      const occurredAt =
        str(data?.activatedAt) ?? str(data?.failedAt) ?? str(data?.deactivatedAt) ?? str(payload.timestamp);
      const iso = occurredAt && !Number.isNaN(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : null;
      const res = await deps.inbound.participantEvent({
        provider: deps.provider.name,
        environment: deps.environment,
        providerOrgId: orgId,
        event: event.toLowerCase() as ParticipantEvent,
        participantId: participantId && /^[0-9]{4}:[^\s:]{1,200}$/.test(participantId) ? participantId : null,
        code: code && /^[A-Z0-9_]{1,80}$/.test(code) ? code : null,
        occurredAt: iso,
      });
      await deps.inbound.webhookComplete(record.webhookEventId, res.applied ? "processed" : "ignored", res.applied ? null : "STALE_PARTICIPANT_EVENT");
      return { status: 200, body: { code: res.applied ? "PARTICIPANT_UPDATED" : "IGNORED" } };
    }
    if (kind === "inbound") {
      const sync = await syncInboundList(
        { store: deps.inbound, provider: deps.provider, environment: deps.environment },
        [{ providerOrgId: orgId }],
        "webhook"
      );
      await runInboundProcessBatch({ store: deps.inbound, provider: deps.provider, environment: deps.environment }, { batchSize: 5 });
      const failed = sync.errors.length > 0;
      await deps.inbound.webhookComplete(record.webhookEventId, failed ? "failed" : "processed", failed ? "PROVIDER_FETCH_FAILED" : null);
      return { status: 200, body: { code: failed ? "ACCEPTED_RETRY_LATER" : "PROCESSED" } };
    }
    if (kind === "outbound") {
      // Docs: data.invoiceId (camelCase) = invoice_id z connector/send (náš provider_submission_id).
      const submissionId = str(data?.invoiceId) ?? str(data?.invoice_id) ?? str(payload.invoice_id);
      if (!submissionId || !ORG_ID.test(submissionId)) {
        await deps.inbound.webhookComplete(record.webhookEventId, "ignored", "MISSING_SUBMISSION_ID");
        return { status: 200, body: { code: "IGNORED" } };
      }
      // Korelácia pre podporu (eFaktura.sk): messageId = AS4, transactionId = SBDH InstanceIdentifier.
      // Iba identifikátory (tlačiteľné ASCII ≤ 200), write-once, aj k už ukončenému podaniu; best-effort.
      const as4MessageId = transportId(data?.messageId);
      const sbdhInstanceIdentifier = transportId(data?.transactionId);
      if ((as4MessageId || sbdhInstanceIdentifier) && deps.inbound.recordOutboundTransport) {
        try {
          await deps.inbound.recordOutboundTransport(record.companyId, submissionId, { as4MessageId, sbdhInstanceIdentifier });
        } catch {
          // nezastaví reconciliation; identifikátory sú aj v exporte GET /v1/agent/peppol/events
        }
      }
      const row = await deps.inbound.claimOutboundBySubmission(record.companyId, submissionId, 120);
      if (row) {
        await reconcileOutboundRow({ store: deps.outbound, provider: deps.provider }, row);
        await deps.inbound.webhookComplete(record.webhookEventId, "processed", null);
        return { status: 200, body: { code: "RECONCILED" } };
      }
      // Claim nič nevrátil: opakovaná udalosť k už ukončenému podaniu (idempotentné, nič sa
      // nemení), súbežne spracúvané podanie (reconcile worker ho dokončí), alebo naozaj neznáme.
      const state = deps.inbound.outboundStateBySubmission ? await deps.inbound.outboundStateBySubmission(record.companyId, submissionId) : null;
      const outcome =
        state && TERMINAL_OUTBOUND.has(state) ? "ALREADY_FINAL" : state ? "RECONCILE_IN_PROGRESS" : "SUBMISSION_NOT_FOUND";
      await deps.inbound.webhookComplete(record.webhookEventId, "ignored", outcome);
      return { status: 200, body: { code: outcome === "SUBMISSION_NOT_FOUND" ? "IGNORED" : outcome } };
    }
    await deps.inbound.webhookComplete(record.webhookEventId, "ignored", "EVENT_NOT_HANDLED");
    return { status: 200, body: { code: "IGNORED" } };
  } catch (error) {
    // Spracovanie zlyhalo — doručenie je zaznamenané, poll fallback to dobehne.
    const code = errorCode(error);
    try {
      await deps.inbound.webhookComplete(record.webhookEventId, "failed", code);
    } catch {
      // ignorované — stav ostáva "received"
    }
    return { status: 200, body: { code: "ACCEPTED_RETRY_LATER" } };
  }
}

/**
 * Partnerský feed GET /v1/agent/events → tie isté spracovanie ako webhook
 * (fallback za firewallom / po výpadku dlhšom než opakovania webhookov).
 * Autenticita = náš API kľúč (TLS na povolený host), nie HMAC. Dedupe: `feed:<event_id|id>`.
 * Kurzor si drží volajúci (vráti sa `nextAfter`).
 */
export async function processPartnerEventPage(
  deps: WebhookDeps,
  page: { events: { id: string; eventId: string | null; payload: Record<string, unknown> }[] }
): Promise<{ processed: number; results: { id: string; code: string }[] }> {
  const results: { id: string; code: string }[] = [];
  for (const e of page.events) {
    const raw = JSON.stringify(e.payload);
    const deliveryId = `feed:${e.eventId ?? e.id}`.slice(0, 200);
    const res = await processProviderEvent(deps, {
      deliveryId,
      payload: e.payload,
      bodySha256: createHash("sha256").update(raw).digest("hex"),
    });
    results.push({ id: e.id, code: res.body.code });
  }
  return { processed: results.length, results };
}
