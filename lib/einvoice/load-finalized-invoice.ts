import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UblInvoiceSnapshot, UblItem, UblParty, UblTaxBreakdown, UblInvoiceHeader } from "./ubl/model.ts";

// =============================================================================
// Server-side načítanie NEMENNÉHO snapshotu finalizovanej vydanej faktúry.
//
// Volá sa s user-scoped klientom (Bearer JWT používateľa) — RLS na invoices /
// invoice_parties / invoice_items / invoice_tax_breakdowns vynucuje aktívnu
// firmu a finance.view. Navyše sa explicitne overí company_id (druhá vrstva).
// Nikdy nepracuje s klientským payloadom.
// =============================================================================

export type LoadSnapshotResult =
  | { ok: true; snapshot: UblInvoiceSnapshot }
  | { ok: false; reason: "NOT_FOUND" | "NOT_FINALIZED" | "NOT_ISSUED" | "INCOMPLETE" | "QUERY_FAILED" };

const HEADER_COLUMNS =
  "id, company_id, direction, kind, document_status, invoice_number, issue_date, due_date, delivery_date, " +
  "tax_point_date, currency, subtotal_amount, vat_total_amount, total_amount, rounding_amount, buyer_reference, " +
  "purchase_order_reference, payment_means_code, payment_reference, corrects_invoice_id, correction_reason, untaxed_prepaid_amount";

const PARTY_COLUMNS =
  "role, legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code, country_code, iban, bic, " +
  "email, electronic_address, electronic_address_scheme_id, legal_registration_id, legal_registration_scheme_id, vat_identifier";

const ITEM_COLUMNS =
  "position, description, quantity, unit_code, unit_price, price_mode, vat_category_code, vat_rate, line_net_amount, is_advance_deduction, advance_invoice_id";

const TAX_COLUMNS =
  "vat_category_code, vat_rate, taxable_amount, vat_amount, vat_exemption_reason_code, vat_exemption_reason_text";

export async function loadFinalizedIssuedInvoiceSnapshot(
  db: SupabaseClient,
  invoiceId: string,
  activeCompanyId: string
): Promise<LoadSnapshotResult> {
  const { data: invoice, error } = await db
    .from("invoices")
    .select(HEADER_COLUMNS)
    .eq("id", invoiceId)
    .maybeSingle<UblInvoiceHeader>();
  if (error) return { ok: false, reason: "QUERY_FAILED" };
  if (!invoice || invoice.company_id !== activeCompanyId) return { ok: false, reason: "NOT_FOUND" };
  if (invoice.document_status !== "finalized") return { ok: false, reason: "NOT_FINALIZED" };
  if (invoice.direction !== "issued") return { ok: false, reason: "NOT_ISSUED" };

  const [partiesRes, itemsRes, taxRes] = await Promise.all([
    db.from("invoice_parties").select(PARTY_COLUMNS).eq("invoice_id", invoice.id).returns<UblParty[]>(),
    db.from("invoice_items").select(ITEM_COLUMNS).eq("invoice_id", invoice.id).order("position", { ascending: true }).returns<UblItem[]>(),
    db.from("invoice_tax_breakdowns").select(TAX_COLUMNS).eq("invoice_id", invoice.id).returns<UblTaxBreakdown[]>(),
  ]);
  if (partiesRes.error || itemsRes.error || taxRes.error) return { ok: false, reason: "QUERY_FAILED" };

  const parties = partiesRes.data ?? [];
  const seller = parties.find((p) => p.role === "seller");
  const buyer = parties.find((p) => p.role === "buyer");
  if (!seller || !buyer || (itemsRes.data ?? []).length === 0) return { ok: false, reason: "INCOMPLETE" };

  let correctedInvoice: UblInvoiceSnapshot["correctedInvoice"] = null;
  if (invoice.corrects_invoice_id) {
    const { data: corrected, error: correctedError } = await db
      .from("invoices")
      .select("invoice_number, issue_date, company_id")
      .eq("id", invoice.corrects_invoice_id)
      .maybeSingle<{ invoice_number: string | null; issue_date: string | null; company_id: string }>();
    if (correctedError) return { ok: false, reason: "QUERY_FAILED" };
    if (corrected && corrected.company_id === activeCompanyId) {
      correctedInvoice = { invoice_number: corrected.invoice_number, issue_date: corrected.issue_date };
    }
  }

  // Odpočet záloh (konečná faktúra): suma s DPH → BT-113.
  const { data: deductions, error: dedError } = await db
    .from("invoice_advance_deductions")
    .select("taxable_amount, vat_amount, advance_invoice_id")
    .eq("invoice_id", invoice.id)
    .returns<{ taxable_amount: number | string; vat_amount: number | string; advance_invoice_id: string }[]>();
  if (dedError) return { ok: false, reason: "QUERY_FAILED" };
  // 20261008100009: zdanené zálohy sú mínusové riadky; BT-113 = iba nezdanená záloha.
  const prepaidAmount = Number((invoice as UblInvoiceHeader & { untaxed_prepaid_amount?: number | string | null }).untaxed_prepaid_amount ?? 0);
  const legacyAdvanceDeduction = (deductions ?? []).length > 0 && !(itemsRes.data ?? []).some((i) => i.is_advance_deduction);

  // BG-3 pre každú odpočítanú zálohu (číslo + dátum) — iba doklady tej istej firmy.
  const advanceIds = Array.from(new Set([
    ...(deductions ?? []).map((d) => d.advance_invoice_id),
    ...(itemsRes.data ?? []).map((i) => i.advance_invoice_id).filter((x): x is string => Boolean(x)),
  ]));
  let advanceInvoices: UblInvoiceSnapshot["advanceInvoices"] = [];
  if (advanceIds.length > 0) {
    const { data: advances, error: advError } = await db
      .from("invoices")
      .select("id, invoice_number, issue_date, company_id")
      .in("id", advanceIds)
      .returns<{ id: string; invoice_number: string | null; issue_date: string | null; company_id: string }[]>();
    if (advError) return { ok: false, reason: "QUERY_FAILED" };
    advanceInvoices = (advances ?? [])
      .filter((a) => a.company_id === activeCompanyId && a.invoice_number)
      .sort((a, b) => String(a.invoice_number).localeCompare(String(b.invoice_number)))
      .map((a) => ({ id: a.id, invoice_number: a.invoice_number, issue_date: a.issue_date }));
  }

  return {
    ok: true,
    snapshot: {
      prepaidAmount,
      advanceInvoices,
      legacyAdvanceDeduction,
      invoice,
      seller,
      buyer,
      items: itemsRes.data ?? [],
      taxBreakdowns: taxRes.data ?? [],
      correctedInvoice,
    },
  };
}
