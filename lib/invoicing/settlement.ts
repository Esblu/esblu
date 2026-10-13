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
  /** 20261008100009: položky bez mínusových riadkov záloh (s DPH). */
  items_total: number;
  /** Mínusové riadky zdanených záloh (s DPH) — už sú v original_total. */
  advances_taxed: number;
  /** Nezdanená záloha (BT-113) — znižuje sumu na úhradu. */
  prepaid_untaxed: number;
  /** Prijatá konečná faktúra: súčet priradených prijatých záloh (20261008100008). */
  advances_linked: number;
  /** Záloha (faktúra k prijatej platbe): spotrebované vo finalizovaných konečných faktúrach; inak null. */
  advance_consumed: number | null;
  advance_remaining: number | null;
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
    items_total: num(d.items_total ?? d.original_total),
    advances_taxed: num(d.advances_taxed),
    prepaid_untaxed: num(d.prepaid_untaxed),
    advances_linked: num(d.advances_linked),
    advance_consumed: d.advance_consumed == null ? null : num(d.advance_consumed),
    advance_remaining: d.advance_remaining == null ? null : num(d.advance_remaining),
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

// =============================================================================
// 20261008100008 — prijaté zálohy (UBL 386) odpočítané na prijatej konečnej faktúre (BT-113).
// Review iba cez RPC (finance.manage v DB); čítanie väzieb pod RLS (finance.view, aktívna firma).
// =============================================================================

export type ReceivedAdvanceLink = {
  invoice_id: string;
  advance_invoice_id: string;
  amount: number;
  taxable_amount: number;
  vat_amount: number;
  source: "auto" | "manual";
  /** Číslo dokladu dodávateľa (zálohy alebo konečnej faktúry podľa smeru dotazu). */
  number: string | null;
};

export type ReceivedAdvanceCandidate = {
  advance_invoice_id: string;
  supplier_invoice_number: string | null;
  issue_date: string;
  tax_point_date: string | null;
  currency: string;
  total_amount: number;
  remaining_amount: number;
  document_status: string;
};

async function numbersOf(ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("invoices").select("id, supplier_invoice_number, invoice_number").in("id", ids);
  if (error) throw error;
  return new Map(((data ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), ((r.supplier_invoice_number ?? r.invoice_number) as string | null) ?? null]));
}

/** Väzby z pohľadu konečnej faktúry (`by: "invoice"`) alebo zálohy (`by: "advance"`). */
export async function listReceivedAdvanceLinks(invoiceId: string, by: "invoice" | "advance"): Promise<ReceivedAdvanceLink[]> {
  const { data, error } = await supabase
    .from("received_advance_links")
    .select("invoice_id, advance_invoice_id, amount, taxable_amount, vat_amount, source")
    .eq(by === "invoice" ? "invoice_id" : "advance_invoice_id", invoiceId);
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  const other = (r: Record<string, unknown>) => String(by === "invoice" ? r.advance_invoice_id : r.invoice_id);
  const numbers = await numbersOf(Array.from(new Set(rows.map(other))));
  return rows.map((r) => ({
    invoice_id: String(r.invoice_id),
    advance_invoice_id: String(r.advance_invoice_id),
    amount: num(r.amount),
    taxable_amount: num(r.taxable_amount),
    vat_amount: num(r.vat_amount),
    source: r.source === "manual" ? "manual" : "auto",
    number: numbers.get(other(r)) ?? null,
  }));
}

export async function listReceivedAdvanceCandidates(invoiceId: string): Promise<ReceivedAdvanceCandidate[]> {
  const { data, error } = await supabase.rpc("esblu_received_advance_candidates", { p_invoice_id: invoiceId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    advance_invoice_id: String(r.advance_invoice_id),
    supplier_invoice_number: (r.supplier_invoice_number as string | null) ?? null,
    issue_date: String(r.issue_date),
    tax_point_date: (r.tax_point_date as string | null) ?? null,
    currency: String(r.currency),
    total_amount: num(r.total_amount),
    remaining_amount: num(r.remaining_amount),
    document_status: String(r.document_status),
  }));
}

export async function confirmReceivedAdvances(invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc("esblu_received_advance_confirm", { p_invoice_id: invoiceId });
  if (error) throw error;
}

export async function linkReceivedAdvance(invoiceId: string, advanceId: string, amount: number | null): Promise<void> {
  const { error } = await supabase.rpc("esblu_received_advance_link", { p_invoice_id: invoiceId, p_advance_invoice_id: advanceId, p_amount: amount });
  if (error) throw error;
}

export async function unlinkReceivedAdvance(invoiceId: string, advanceId: string): Promise<void> {
  const { error } = await supabase.rpc("esblu_received_advance_unlink", { p_invoice_id: invoiceId, p_advance_invoice_id: advanceId });
  if (error) throw error;
}

export async function rejectReceivedAdvances(invoiceId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc("esblu_received_advance_reject", { p_invoice_id: invoiceId, p_note: note });
  if (error) throw error;
}
