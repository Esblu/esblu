import { createClient } from "@supabase/supabase-js";
import { verifyRequestUser } from "@/lib/server-auth";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { sanitizeFileName } from "@/lib/sanitize-filename";
import { renderInvoicePdfBuffer } from "@/lib/invoicing/pdf-renderer";
import type { Invoice, InvoiceItem, InvoiceParty, InvoiceTaxBreakdown } from "@/lib/invoices";

// =============================================================================
// GET /api/invoices/[id]/pdf — FÁZA 3A, PDF finalizovanej faktúry.
//
// Node.js runtime (NIE Edge) — @react-pdf/renderer potrebuje Node Buffer/fs
// (fonty sa čítajú zo súborového systému, pozri lib/invoicing/pdf-renderer.tsx
// a next.config.ts outputFileTracingIncludes).
//
// AUTORIZÁCIA — ZÁMERNE user-scoped Supabase klient (Bearer token
// prihláseného používateľa), NIE service_role + manuálny filter
// (existujúci vzor v app/api/account/delete/route.ts je tu vedome
// nepoužitý — pozri zadanie bod 3). RLS politiky na invoices/
// invoice_parties/invoice_items/invoice_tax_breakdowns (migrácia
// 20260916... "..._finance_gated") už samé o sebe vynucujú:
//   - company_id = esblu_my_active_company_id()
//   - esblu_my_finance_view()
// pre každý SELECT. Explicitné RPC volania nižšie (esblu_my_active_company_id
// / esblu_my_finance_view) NIE sú náhrada za RLS — sú DRUHÁ, nezávislá
// vrstva (fail-closed, aj keby RLS politika niekedy zlyhala/zmizla), a
// zároveň umožňujú vrátiť presnejšiu chybovú hlášku (401/403 s dôvodom)
// namiesto jedného univerzálneho "not found" pre všetky prípady.
//
// Cross-company / cudzia faktúra / neexistujúce UUID / draft / chýbajúce
// finance.view — VŠETKY tieto prípady musia zlyhať fail-closed (pozri test
// matrix v zadaní, bod 16).
// =============================================================================

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function GET(req: Request, context: RouteContext) {
  const locale = getRequestLocale(req);

  let invoiceId: string;
  try {
    ({ id: invoiceId } = await context.params);
  } catch {
    return errorResponse(400, translate(locale, "invoices.errors.pdfNotFound"));
  }

  // Fail-closed na vstupe — nedôveryhodný path segment sa nikdy nedostane
  // ďalej do SQL/logov ako "nejaký string".
  if (!UUID_RE.test(invoiceId)) {
    return errorResponse(404, translate(locale, "invoices.errors.pdfNotFound"));
  }

  // 1. Overenie session/auth (rovnaký vzor ako lib/server-auth.ts — anon-key
  // klient VÝHRADNE na auth.getUser(), nikdy service_role).
  const authorization = req.headers.get("authorization");
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (!accessToken) {
    return errorResponse(401, translate(locale, "invoices.errors.pdfNotAuthenticated"));
  }

  const { user, error: authError } = await verifyRequestUser(req, locale);

  if (authError || !user) {
    return errorResponse(401, translate(locale, "invoices.errors.pdfNotAuthenticated"));
  }

  // User-scoped klient — všetky query nižšie bežia POD RLS ako tento
  // konkrétny auth.uid(), nie service_role. Toto je jediný Supabase klient
  // použitý v tejto route.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("invoices/pdf: chýba NEXT_PUBLIC_SUPABASE_URL/ANON_KEY v server prostredí.");
    return errorResponse(500, translate(locale, "invoices.errors.pdfGenerationFailed"));
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  // 2. Resolve active company (druhá, explicitná vrstva popri RLS — pozri
  // komentár na začiatku súboru).
  const { data: activeCompanyId, error: companyError } = await userClient.rpc(
    "esblu_my_active_company_id"
  );

  if (companyError) {
    console.error("invoices/pdf: esblu_my_active_company_id zlyhalo:", companyError.code, companyError.message);
    return errorResponse(500, translate(locale, "invoices.errors.pdfGenerationFailed"));
  }

  if (!activeCompanyId) {
    return errorResponse(403, translate(locale, "invoices.errors.pdfNoActiveCompany"));
  }

  // 3. Overenie finance.view (druhá, explicitná vrstva popri RLS).
  const { data: hasFinanceView, error: financeViewError } = await userClient.rpc(
    "esblu_my_finance_view"
  );

  if (financeViewError) {
    console.error("invoices/pdf: esblu_my_finance_view zlyhalo:", financeViewError.code, financeViewError.message);
    return errorResponse(500, translate(locale, "invoices.errors.pdfGenerationFailed"));
  }

  if (!hasFinanceView) {
    return errorResponse(403, translate(locale, "invoices.errors.pdfForbidden"));
  }

  // 4. Načítanie invoice IBA z aktívnej firmy (RLS + explicitný company_id
  // recheck nižšie). Cudzia firma / neexistujúce UUID → identická "not
  // found" odpoveď (nikdy neprezradiť existenciu cudzej faktúry).
  const { data: invoice, error: invoiceError } = await userClient
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle<Invoice>();

  if (invoiceError) {
    console.error("invoices/pdf: načítanie invoice zlyhalo:", invoiceError.code, invoiceError.message);
    return errorResponse(500, translate(locale, "invoices.errors.pdfGenerationFailed"));
  }

  if (!invoice || invoice.company_id !== activeCompanyId) {
    return errorResponse(404, translate(locale, "invoices.errors.pdfNotFound"));
  }

  // 5. Iba finalized (bod 2 zadania — draft PDF v tejto fáze nepovolené).
  if (invoice.document_status !== "finalized") {
    return errorResponse(409, translate(locale, "invoices.errors.pdfNotFinalized"));
  }

  // 5b. PDF generujeme VÝHRADNE pre vlastné vydané doklady.
  //
  // Prijatá faktúra je dokument, ktorý vystavil dodávateľ. Vyrobiť z našich
  // canonical dát jeho PDF náhradu by znamenalo vydávať prerozprávanie
  // cudzieho dokladu za doklad — a keďže canonical model zachytáva len to,
  // čo sme pri review potvrdili, výsledok by sa od originálu mohol líšiť.
  // Originál žije v documents/document_attachments a je na faktúru
  // prelinkovaný cez document_links.invoice_id; UI naň odkazuje namiesto
  // tohto endpointu. Fail-closed, nie tichý prázdny doklad.
  if (invoice.direction !== "issued") {
    return errorResponse(409, translate(locale, "invoices.errors.pdfReceivedNotSupported"));
  }

  // 6. Parties/items/tax breakdowns — scoped VÝHRADNE na túto invoice_id
  // (RLS navyše nezávisle re-overuje company_id + finance.view pre každú
  // z týchto tabuliek zvlášť).
  const [partiesRes, itemsRes, taxRes] = await Promise.all([
    userClient
      .from("invoice_parties")
      .select("*")
      .eq("invoice_id", invoice.id)
      .returns<InvoiceParty[]>(),
    userClient
      .from("invoice_items")
      .select("*")
      .eq("invoice_id", invoice.id)
      .order("position", { ascending: true })
      .returns<InvoiceItem[]>(),
    userClient
      .from("invoice_tax_breakdowns")
      .select("*")
      .eq("invoice_id", invoice.id)
      .order("vat_category_code", { ascending: true })
      .returns<InvoiceTaxBreakdown[]>(),
  ]);

  if (partiesRes.error || itemsRes.error || taxRes.error) {
    console.error(
      "invoices/pdf: načítanie parties/items/tax_breakdowns zlyhalo:",
      partiesRes.error?.message,
      itemsRes.error?.message,
      taxRes.error?.message
    );
    return errorResponse(500, translate(locale, "invoices.errors.pdfGenerationFailed"));
  }

  const parties = partiesRes.data ?? [];
  const items = itemsRes.data ?? [];
  const taxBreakdowns = taxRes.data ?? [];
  const seller = parties.find((p) => p.role === "seller") ?? null;
  const buyer = parties.find((p) => p.role === "buyer") ?? null;

  // Defenzívny fail-closed check — finalizovaná faktúra MUSÍ mať seller
  // snapshot a aspoň jednu položku (invariant esblu_finalize_invoice()).
  // Ak toto niekedy neplatí, ide o dátovú anomáliu — radšej zlyhať nahlas
  // ako vygenerovať neúplné/zavádzajúce PDF.
  if (!seller || items.length === 0) {
    console.error("invoices/pdf: finalizovaná faktúra bez seller snapshotu alebo bez položiek:", invoice.id);
    return errorResponse(500, translate(locale, "invoices.errors.pdfGenerationFailed"));
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInvoicePdfBuffer({
      invoice,
      seller,
      buyer,
      items,
      taxBreakdowns,
      locale,
    });
  } catch (renderError) {
    console.error(
      "invoices/pdf: renderInvoicePdfBuffer zlyhalo:",
      renderError instanceof Error ? renderError.message : renderError
    );
    return errorResponse(500, translate(locale, "invoices.errors.pdfGenerationFailed"));
  }

  const fileName = sanitizeFileName(
    `${invoice.invoice_number ?? invoice.id}.pdf`
  );

  return new Response(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(pdfBuffer.byteLength),
      // GDPR (bod 20 zadania) — PDF obsahuje osobné/fakturačné údaje,
      // generuje sa on-demand, nikde sa neukladá → nesmie sa cachovať ani
      // zdieľanou, ani súkromnou cache naprieč požiadavkami.
      "Cache-Control": "private, no-store",
    },
  });
}
