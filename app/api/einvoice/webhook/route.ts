import "server-only";

import { getEfakturaWebhookSecrets, getEinvoiceProvider } from "@/lib/einvoice/provider";
import { handleEinvoiceWebhook, WEBHOOK_MAX_BODY_BYTES } from "@/lib/einvoice/inbound/webhook";
import { createSupabaseInboundStore } from "@/lib/einvoice/inbound/supabase-store";
import { createSupabaseOutboundStore } from "@/lib/einvoice/outbound/supabase-store";

// =============================================================================
// POST /api/einvoice/webhook — webhook poskytovateľa (eFaktura.sk).
//
// Surové telo s pevným limitom (čítané po častiach, nikdy celé nad limit) →
// HMAC podpis + časové okno (konštantný čas) → dedupe doručenia → firma IBA
// z mapovania provider_org_id → dokument / stav sa vždy znova načíta od
// poskytovateľa. Webhook nie je zdroj pravdy. Telo, XML ani tajomstvá sa
// nelogujú ani neukladajú (iba SHA-256 tela).
// Odpoveď: { code } — strojový kód, nič iné.
// =============================================================================

export const runtime = "nodejs";
export const maxDuration = 60;

function json(status: number, body: { code: string }): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Prečíta telo najviac do `cap` bajtov; nad limit vráti null (zvyšok sa nečíta). */
async function readCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function POST(req: Request) {
  const rawBody = await readCapped(req, WEBHOOK_MAX_BODY_BYTES);
  if (!rawBody) return json(413, { code: "PAYLOAD_TOO_LARGE" });

  let runtimeConfig = null;
  try {
    runtimeConfig = getEinvoiceProvider();
  } catch {
    runtimeConfig = null;
  }
  const secrets = getEfakturaWebhookSecrets();
  if (!runtimeConfig || secrets.length === 0) return json(503, { code: "NOT_CONFIGURED" });

  const result = await handleEinvoiceWebhook(
    {
      inbound: createSupabaseInboundStore(),
      outbound: createSupabaseOutboundStore(),
      provider: runtimeConfig.provider,
      environment: runtimeConfig.environment,
      secrets,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    },
    {
      rawBody,
      signatureHeader: req.headers.get("x-webhook-signature"),
      deliveryIdHeader: req.headers.get("x-webhook-id"),
    }
  );
  return json(result.status, result.body);
}
