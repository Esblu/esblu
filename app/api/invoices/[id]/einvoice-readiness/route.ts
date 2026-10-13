import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { loadEinvoiceReadiness } from "@/lib/einvoice/readiness-server";

// =============================================================================
// GET /api/invoices/[id]/einvoice-readiness — pripravenosť faktúry na
// e-faktúru. Read-only, nič neposiela, nič nezapisuje.
//
//   koncept       → režim pre_finalize (opraviť údaje, kým sa dajú opraviť)
//   finalizovaná  → režim pre_send (nemenný snapshot, plná kontrola)
//
// Identita: overený Bearer JWT; všetko ďalšie (firma, rola, nárok, dáta) cez
// user-scoped klienta pod RLS. Prostredie poskytovateľa iba zo serverového env.
// Odpoveď: { ready, mode, issues[{code, rule, params?, category}], warnings }
// — strojovo čitateľné kódy, preklad robí klient (invoices.einvoice.issues.*).
// =============================================================================

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function bearerToken(req: Request): string {
  const authorization = req.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

export async function GET(req: Request, context: RouteContext) {
  const locale = getRequestLocale(req);

  let invoiceId: string;
  try {
    ({ id: invoiceId } = await context.params);
  } catch {
    return json(404, { code: "NOT_FOUND", error: translate(locale, "invoices.errors.pdfNotFound") });
  }
  if (!UUID_RE.test(invoiceId)) {
    return json(404, { code: "NOT_FOUND", error: translate(locale, "invoices.errors.pdfNotFound") });
  }

  const accessToken = bearerToken(req);
  if (!accessToken) return json(401, { code: "UNAUTHENTICATED", error: translate(locale, "invoices.errors.pdfNotAuthenticated") });
  const { user, error: authError } = await verifyRequestUser(req, locale);
  if (authError || !user) return json(401, { code: "UNAUTHENTICATED", error: translate(locale, "invoices.errors.pdfNotAuthenticated") });

  const loaded = await loadEinvoiceReadiness(getUserScopedSupabaseClient(accessToken), invoiceId);
  if (!loaded.ok) {
    const key =
      loaded.code === "NOT_FOUND" ? "invoices.errors.pdfNotFound"
      : loaded.code === "NOT_ISSUED" ? "invoices.errors.ublReceivedNotSupported"
      : loaded.code === "NO_ACTIVE_COMPANY" ? "invoices.errors.pdfNoActiveCompany"
      : loaded.code === "FORBIDDEN" ? "invoices.errors.pdfForbidden"
      : "invoices.errors.ublGenerationFailed";
    return json(loaded.status, { code: loaded.code, error: translate(locale, key) });
  }

  return json(200, loaded.result as unknown as Record<string, unknown>);
}
