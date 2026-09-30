import { createClient } from "@supabase/supabase-js";
import { verifyRequestUser } from "@/lib/server-auth";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { loadFinalizedIssuedInvoiceSnapshot } from "@/lib/einvoice/load-finalized-invoice";
import { buildIssuedInvoiceUblExport } from "@/lib/einvoice/export";

// =============================================================================
// GET /api/invoices/[id]/ubl — export UBL 2.1 (Peppol BIS Billing 3.0) XML
// finalizovanej vydanej faktúry. Nezávislé od poskytovateľa, nič neposiela.
//
// Autorizácia rovnaká ako PDF route: user-scoped klient (RLS) + explicitná
// kontrola aktívnej firmy a finance.view. Employee / admin bez financií /
// cudzia firma → odmietnuté. XML sa generuje on-demand zo serverom
// načítaného nemenného snapshotu, nikde sa neukladá, necachuje sa.
// Pri chýbajúcich údajoch vráti 422 so zoznamom problémov — nič neopravuje.
// =============================================================================

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(req: Request, context: RouteContext) {
  const locale = getRequestLocale(req);

  let invoiceId: string;
  try {
    ({ id: invoiceId } = await context.params);
  } catch {
    return json(404, { error: translate(locale, "invoices.errors.pdfNotFound") });
  }
  if (!UUID_RE.test(invoiceId)) {
    return json(404, { error: translate(locale, "invoices.errors.pdfNotFound") });
  }

  const authorization = req.headers.get("authorization");
  const accessToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!accessToken) return json(401, { error: translate(locale, "invoices.errors.pdfNotAuthenticated") });

  const { user, error: authError } = await verifyRequestUser(req, locale);
  if (authError || !user) return json(401, { error: translate(locale, "invoices.errors.pdfNotAuthenticated") });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return json(500, { error: translate(locale, "invoices.errors.ublGenerationFailed") });
  }
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: activeCompanyId, error: companyError } = await userClient.rpc("esblu_my_active_company_id");
  if (companyError) return json(500, { error: translate(locale, "invoices.errors.ublGenerationFailed") });
  if (!activeCompanyId) return json(403, { error: translate(locale, "invoices.errors.pdfNoActiveCompany") });

  const { data: hasFinanceView, error: financeError } = await userClient.rpc("esblu_my_finance_view");
  if (financeError) return json(500, { error: translate(locale, "invoices.errors.ublGenerationFailed") });
  if (!hasFinanceView) return json(403, { error: translate(locale, "invoices.errors.pdfForbidden") });

  const loaded = await loadFinalizedIssuedInvoiceSnapshot(userClient, invoiceId, activeCompanyId as string);
  if (!loaded.ok) {
    switch (loaded.reason) {
      case "NOT_FOUND":
        return json(404, { error: translate(locale, "invoices.errors.pdfNotFound") });
      case "NOT_FINALIZED":
        return json(409, { error: translate(locale, "invoices.errors.pdfNotFinalized") });
      case "NOT_ISSUED":
        return json(409, { error: translate(locale, "invoices.errors.ublReceivedNotSupported") });
      default:
        return json(500, { error: translate(locale, "invoices.errors.ublGenerationFailed") });
    }
  }

  const exported = buildIssuedInvoiceUblExport(loaded.snapshot);
  if (!exported.ok) {
    return json(422, {
      error: translate(locale, "invoices.errors.ublNotReady"),
      issues: exported.issues.map((i) => ({ code: i.code, rule: i.rule, message: i.message })),
      warnings: exported.warnings.map((w) => ({ code: w.code, rule: w.rule, message: w.message })),
    });
  }

  return new Response(exported.file.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exported.file.fileName}"`,
      "Content-Length": String(exported.file.bytes.byteLength),
      "X-Esblu-Ubl-Sha256": exported.file.sha256,
      "Cache-Control": "private, no-store",
    },
  });
}
