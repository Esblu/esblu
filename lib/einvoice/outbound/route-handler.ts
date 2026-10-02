import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EinvoiceEnvironment, EinvoiceProvider } from "../provider/types.ts";
import { parseOutboundRequestBody } from "./request-body.ts";
import { requestOutboundForInvoice } from "./request.ts";
import type { OutboundStore } from "./store.ts";

// =============================================================================
// POST /api/einvoice/outbound — celá serverová cesta okrem napojenia na
// Supabase/env (to dodáva route). SERVER-ONLY.
//
// Poradie je bezpečnostný invariant:
//   1. Bearer token → overený používateľ (inak 401),
//   2. telo: presne {invoice_id, confirm_send: true} (inak 400) — PRED
//      akýmkoľvek čítaním faktúry, volaním poskytovateľa alebo zápisom,
//   3. až potom orchestrácia (readiness → recipient → preflight → queue).
// Route aj sandbox E2E volajú TÚTO funkciu → test ide rovnakou cestou ako produkcia.
// =============================================================================

export type OutboundRouteDeps = {
  /** Overenie Bearer tokenu (produkcia: verifyRequestUser). null = neplatný. */
  authenticate: (req: Request, accessToken: string) => Promise<{ userId: string } | null>;
  /** User-scoped klient pre daný token (RLS). */
  userDbFor: (accessToken: string) => SupabaseClient;
  /** Privilegovaná vrstva — vytvorí sa až PO overení identity a tela (lenivo). */
  store: () => OutboundStore;
  /** Poskytovateľ zo serverového env (null = nenakonfigurované) — tiež lenivo. */
  runtime: () => { provider: EinvoiceProvider; environment: EinvoiceEnvironment } | null;
  env?: Record<string, string | undefined>;
};

export type OutboundRouteResult = { status: number; body: Record<string, unknown> };

function bearerToken(req: Request): string {
  const authorization = req.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

export async function handleOutboundSendRequest(req: Request, deps: OutboundRouteDeps): Promise<OutboundRouteResult> {
  const accessToken = bearerToken(req);
  if (!accessToken) return { status: 401, body: { code: "UNAUTHENTICATED" } };
  const user = await deps.authenticate(req, accessToken);
  if (!user || !user.userId) return { status: 401, body: { code: "UNAUTHENTICATED" } };

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { status: 400, body: { code: "INVALID_BODY" } };
  }
  const parsed = parseOutboundRequestBody(raw);
  if (!parsed.ok) return { status: 400, body: { code: parsed.code } };

  const result = await requestOutboundForInvoice(
    { userDb: deps.userDbFor(accessToken), store: deps.store(), runtime: deps.runtime(), env: deps.env },
    { userId: user.userId, invoiceId: parsed.invoiceId, confirmation: "user_confirm_send" }
  );
  return { status: result.status, body: result.body as unknown as Record<string, unknown> };
}
