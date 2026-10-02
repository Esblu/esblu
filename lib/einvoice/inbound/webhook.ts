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
const EVENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

type EventKind = "inbound" | "outbound" | "other";

/** Typ udalosti → druh (presné názvy udalostí poskytovateľa TO CONFIRM v sandboxe; neznáme = ignorované). */
export function classifyWebhookEvent(event: string): EventKind {
  const e = event.toLowerCase();
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
  const data = obj(payload.data);

  const deliveryId = str(input.deliveryIdHeader) ?? str(payload.id) ?? str(payload.delivery_id);
  const event = str(payload.event) ?? str(payload.type);
  // Docs (developers.efaktura.sk/docs/webhooks, 2026-10): obálka {event, timestamp, data},
  // `data.orgId` je VŽDY prítomné. snake_case varianty ostávajú ako fallback.
  const providerOrgId =
    str(data?.orgId) ?? str(payload.organization_id) ?? str(payload.org_id) ?? str(data?.organization_id) ?? str(data?.org_id);
  if (!deliveryId || !DELIVERY_ID.test(deliveryId) || !event || !EVENT.test(event)) {
    return { status: 400, body: { code: "INVALID_PAYLOAD" } };
  }
  const orgId = providerOrgId && ORG_ID.test(providerOrgId) ? providerOrgId : null;
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");

  const record = await deps.inbound.webhookRecord({
    provider: deps.provider.name,
    environment: deps.environment,
    deliveryId,
    providerOrgId: orgId,
    event,
    bodySha256,
  });
  if (!record.inserted) {
    // To isté doručenie znova: rovnaké telo = idempotentné OK; iné telo pod tým istým ID = replay.
    return record.bodyMatches ? { status: 200, body: { code: "DUPLICATE" } } : { status: 409, body: { code: "REPLAYED_WEBHOOK" } };
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
      const row = await deps.inbound.claimOutboundBySubmission(record.companyId, submissionId, 120);
      if (row) await reconcileOutboundRow({ store: deps.outbound, provider: deps.provider }, row);
      await deps.inbound.webhookComplete(record.webhookEventId, row ? "processed" : "ignored", row ? null : "SUBMISSION_NOT_FOUND");
      return { status: 200, body: { code: row ? "RECONCILED" : "IGNORED" } };
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
