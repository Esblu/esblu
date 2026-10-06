import { supabase } from "@/lib/supabase";

// =============================================================================
// Saldo, vrátenia, zálohy a review prijatých opráv (20261008100005). Klientske volania iba
// cez RPC pod JWT používateľa (RLS + finance oprávnenie v DB); žiadny service_role.
// =============================================================================

export type InvoiceSettlement = {
  root_invoice_id: string;
  currency: string;
  original_total: number;
  advances_deducted: number;
  credit_notes_total: number;
  debit_notes_total: number;
  amount_due: number;
  paid: number;
  refunded: number;
  balance: number;
  payment_status: "unpaid" | "partially_paid" | "paid" | "overpaid";
};

export type AvailableAdvance = {
  advance_invoice_id: string;
  invoice_number: string | null;
  tax_point_date: string | null;
  vat_category_code: string;
  vat_rate: number;
  taxable_total: number;
  vat_total: number;
  taxable_remaining: number;
  vat_remaining: number;
};

export type AdvanceDeduction = {
  advance_invoice_id: string;
  vat_category_code: string;
  vat_rate: number;
  taxable_amount: number;
  vat_amount: number;
};

const num = (v: unknown) => Number(v ?? 0);

/** Kód ESBLU_* z chyby RPC (bez surového textu DB) — UI ho preloží cez invoices.errors.<kód>. */
export function esbluErrorCode(error: unknown): string | null {
  const text = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error ?? "");
  return text.match(/ESBLU_[A-Z0-9_]+/)?.[0] ?? null;
}

export async function getInvoiceSettlement(invoiceId: string): Promise<InvoiceSettlement | null> {
  const { data, error } = await supabase.rpc("esblu_invoice_settlement", { p_invoice_id: invoiceId });
  if (error) throw error;
  if (!data) return null;
  const d = data as Record<string, unknown>;
  return {
    root_invoice_id: String(d.root_invoice_id),
    currency: String(d.currency),
    original_total: num(d.original_total),
    advances_deducted: num(d.advances_deducted),
    credit_notes_total: num(d.credit_notes_total),
    debit_notes_total: num(d.debit_notes_total),
    amount_due: num(d.amount_due),
    paid: num(d.paid),
    refunded: num(d.refunded),
    balance: num(d.balance),
    payment_status: d.payment_status as InvoiceSettlement["payment_status"],
  };
}

export async function addInvoiceRefund(invoiceId: string, amount: number, refundedAt: string, method: string | null, note: string | null): Promise<void> {
  const { error } = await supabase.rpc("esblu_add_invoice_refund", {
    p_invoice_id: invoiceId, p_amount: amount, p_refunded_at: refundedAt, p_payment_method: method, p_note: note,
  });
  if (error) throw error;
}

export async function listAvailableAdvances(invoiceId: string): Promise<AvailableAdvance[]> {
  const { data, error } = await supabase.rpc("esblu_available_advances", { p_invoice_id: invoiceId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    advance_invoice_id: String(r.advance_invoice_id),
    invoice_number: (r.invoice_number as string | null) ?? null,
    tax_point_date: (r.tax_point_date as string | null) ?? null,
    vat_category_code: String(r.vat_category_code),
    vat_rate: num(r.vat_rate),
    taxable_total: num(r.taxable_total),
    vat_total: num(r.vat_total),
    taxable_remaining: num(r.taxable_remaining),
    vat_remaining: num(r.vat_remaining),
  }));
}

export async function listAdvanceDeductions(invoiceId: string): Promise<AdvanceDeduction[]> {
  const { data, error } = await supabase
    .from("invoice_advance_deductions")
    .select("advance_invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount")
    .eq("invoice_id", invoiceId);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    advance_invoice_id: String(r.advance_invoice_id),
    vat_category_code: String(r.vat_category_code),
    vat_rate: num(r.vat_rate),
    taxable_amount: num(r.taxable_amount),
    vat_amount: num(r.vat_amount),
  }));
}

export async function setAdvanceDeductions(invoiceId: string, rows: AdvanceDeduction[]): Promise<void> {
  const { error } = await supabase.rpc("esblu_set_invoice_advance_deductions", { p_invoice_id: invoiceId, p_rows: rows });
  if (error) throw error;
}

/** DPH zálohy úmerne k odpočítanému základu (2 desatinné miesta); celý zostatok = celé DPH. */
export function proportionalVat(a: Pick<AvailableAdvance, "taxable_remaining" | "vat_remaining">, taxable: number): number {
  if (taxable >= a.taxable_remaining) return a.vat_remaining;
  if (a.taxable_remaining <= 0) return 0;
  return Math.round(((a.vat_remaining * taxable) / a.taxable_remaining) * 100) / 100;
}

export async function linkReceivedCorrection(invoiceId: string, originalId: string): Promise<void> {
  const { error } = await supabase.rpc("esblu_received_correction_link", { p_invoice_id: invoiceId, p_original_id: originalId });
  if (error) throw error;
}

export async function rejectReceivedCorrection(invoiceId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc("esblu_received_correction_reject", { p_invoice_id: invoiceId, p_note: note });
  if (error) throw error;
}

export type CorrectionCandidate = { id: string; supplier_invoice_number: string | null; issue_date: string; total_amount: number; currency: string };

/** Kandidáti na originál prijatej opravy: finalizované prijaté faktúry TOHO ISTÉHO dodávateľa (RLS = aktívna firma). */
export async function listCorrectionCandidates(supplierId: string): Promise<CorrectionCandidate[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, supplier_invoice_number, issue_date, total_amount, currency")
    .eq("direction", "received")
    .eq("supplier_business_partner_id", supplierId)
    .eq("document_status", "finalized")
    .in("kind", ["regular_invoice", "payment_received_invoice"])
    .order("issue_date", { ascending: false })
    .limit(50);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    supplier_invoice_number: (r.supplier_invoice_number as string | null) ?? null,
    issue_date: String(r.issue_date),
    total_amount: num(r.total_amount),
    currency: String(r.currency),
  }));
}
