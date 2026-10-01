import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// =============================================================================
// Overenie podpisu webhooku eFaktura.sk — podľa zdokumentovanej schémy
// (developers.efaktura.sk/en/docs/webhooks, 2026-09-29):
//   X-Webhook-Signature: t=<unix sekundy>,v1=<hex>[,v1=<hex>…]
//   podpis = HMAC-SHA256(secret, "<t>.<surové telo>"), malé hex
//   viac v1 = rotácia tajomstva, stačí zhoda jedného
//   ochrana proti opakovaniu: odmietnuť starú pečiatku (príklad: 300 s)
//
// Overuje sa SUROVÉ telo pred JSON parsovaním. Porovnanie v konštantnom čase.
// Tajomstvá dodáva server z env — nikdy z DB, nikdy sa nelogujú.
// Deduplikácia doručení (X-Webhook-Id) je samostatná vrstva: unikátny kľúč
// einvoice_webhook_events (provider, environment, delivery_id).
// =============================================================================

export type WebhookVerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "MISSING_HEADER" | "MALFORMED_HEADER" | "STALE_TIMESTAMP" | "FUTURE_TIMESTAMP" | "NO_SECRET" | "SIGNATURE_MISMATCH" };

export function verifyEfakturaWebhookSignature(input: {
  rawBody: string | Uint8Array;
  signatureHeader: string | null | undefined;
  secrets: string[];
  nowSeconds: number;
  toleranceSeconds?: number;
}): WebhookVerifyResult {
  const tolerance = input.toleranceSeconds ?? 300;
  const secrets = input.secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "NO_SECRET" };
  if (!input.signatureHeader) return { ok: false, reason: "MISSING_HEADER" };

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.signatureHeader.split(",")) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim();
    const value = rest.join("=").trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(value)) return { ok: false, reason: "MALFORMED_HEADER" };
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return { ok: false, reason: "MALFORMED_HEADER" };
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "MALFORMED_HEADER" };
  if (input.nowSeconds - timestamp > tolerance) return { ok: false, reason: "STALE_TIMESTAMP" };
  if (timestamp - input.nowSeconds > tolerance) return { ok: false, reason: "FUTURE_TIMESTAMP" };

  const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : Buffer.from(input.rawBody);
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]);

  for (const secret of secrets) {
    const expected = Buffer.from(createHmac("sha256", secret).update(signedPayload).digest("hex"), "utf8");
    for (const candidate of signatures) {
      const actual = Buffer.from(candidate, "utf8");
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return { ok: true, timestamp };
      }
    }
  }
  return { ok: false, reason: "SIGNATURE_MISMATCH" };
}
