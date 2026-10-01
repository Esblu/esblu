import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getEinvoiceProvider } from "@/lib/einvoice/provider";
import { parseOutboundRequestBody } from "@/lib/einvoice/outbound/request-body";
import { requestOutboundForInvoice } from "@/lib/einvoice/outbound/request";
import { createSupabaseOutboundStore } from "@/lib/einvoice/outbound/supabase-store";

// =============================================================================
// POST /api/einvoice/outbound — požiadavka „odoslať ako e-faktúru".
//
// Telo: { "invoice_id": "<uuid>", "confirm_send": true } — NIČ iné. company_id,
// prostredie, rola, participant ID ani kľúče sa z klienta neprijímajú (iné
// polia = 400). Identita z overeného Bearer JWT; firma, oprávnenie, nárok a
// dáta pod RLS volajúceho; prostredie a poskytovateľ iba zo serverového env.
//
// Route NIČ NEODOSIELA: po readiness + overení príjemcu + preflighte vznikne
// pokus `queued` (alebo sa vráti existujúci). Odosiela worker.
// Odpoveď: { code, outbound?: {id, state}, readiness?, issues? } — strojové
// kódy, bez tajomstiev a bez surovej odpovede poskytovateľa.
// =============================================================================

export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function bearerToken(req: Request): string {
  const authorization = req.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  const accessToken = bearerToken(req);
  if (!accessToken) return json(401, { code: "UNAUTHENTICATED" });
  const { user, error: authError } = await verifyRequestUser(req, locale);
  if (authError || !user) return json(401, { code: "UNAUTHENTICATED" });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { code: "INVALID_BODY" });
  }
  const parsed = parseOutboundRequestBody(raw);
  if (!parsed.ok) return json(400, { code: parsed.code });

  let runtimeConfig = null;
  try {
    runtimeConfig = getEinvoiceProvider();
  } catch {
    runtimeConfig = null;
  }

  const result = await requestOutboundForInvoice(
    {
      userDb: getUserScopedSupabaseClient(accessToken),
      store: createSupabaseOutboundStore(),
      runtime: runtimeConfig,
    },
    { userId: user.id, invoiceId: parsed.invoiceId }
  );
  return json(result.status, result.body as unknown as Record<string, unknown>);
}
