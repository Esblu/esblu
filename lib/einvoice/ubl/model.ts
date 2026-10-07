// =============================================================================
// Vstup UBL generátora — NEMENNÝ snapshot FINALIZOVANEJ vydanej faktúry.
//
// Tvar zámerne kopíruje stĺpce tabuliek invoices / invoice_parties /
// invoice_items / invoice_tax_breakdowns (lib/invoices.ts), ale bez importu
// z lib/invoices.ts (ten ťahá Supabase klienta) — generátor je čistá funkcia.
// Snapshot VŽDY načíta server (lib/einvoice/load-finalized-invoice.ts) pod RLS
// volajúceho; nikdy nepochádza z klientského payloadu.
// =============================================================================

export type UblVatCategoryCode = "S" | "Z" | "E" | "AE" | "K" | "G" | "O";

export type UblInvoiceHeader = {
  id: string;
  company_id: string;
  direction: string;
  kind: string;
  document_status: string;
  invoice_number: string | null;
  issue_date: string;
  due_date: string | null;
  delivery_date: string | null;
  tax_point_date: string | null;
  currency: string;
  subtotal_amount: number | string;
  vat_total_amount: number | string;
  total_amount: number | string;
  rounding_amount: number | string;
  buyer_reference: string | null;
  purchase_order_reference: string | null;
  payment_means_code: string | null;
  payment_reference: string | null;
  corrects_invoice_id: string | null;
  /** 20261008100000: dôvod opravy (BT-22 Note pri dobropise / ťarchopise). */
  correction_reason?: string | null;
};

export type UblParty = {
  role: "seller" | "buyer";
  legal_name: string;
  ico: string | null;
  dic: string | null;
  ic_dph: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  iban: string | null;
  bic: string | null;
  email: string | null;
  electronic_address: string | null;
  electronic_address_scheme_id: string | null;
  legal_registration_id: string | null;
  legal_registration_scheme_id: string | null;
  vat_identifier: string | null;
};

export type UblItem = {
  position: number;
  description: string;
  quantity: number | string;
  unit_code: string | null;
  unit_price: number | string;
  price_mode: "net" | "gross";
  vat_category_code: UblVatCategoryCode;
  vat_rate: number | string;
  line_net_amount: number | string;
};

export type UblTaxBreakdown = {
  vat_category_code: UblVatCategoryCode;
  vat_rate: number | string;
  taxable_amount: number | string;
  vat_amount: number | string;
  vat_exemption_reason_code: string | null;
  vat_exemption_reason_text: string | null;
};

export type UblCorrectedInvoice = {
  invoice_number: string | null;
  issue_date: string | null;
};

export type UblInvoiceSnapshot = {
  invoice: UblInvoiceHeader;
  seller: UblParty;
  buyer: UblParty;
  items: UblItem[];
  taxBreakdowns: UblTaxBreakdown[];
  /** Iba pre dobropis / ťarchopis (BT-25 / BT-26). */
  correctedInvoice: UblCorrectedInvoice | null;
  /** Odpočet záloh (BT-113 PrepaidAmount, s DPH) — z invoice_advance_deductions. */
  prepaidAmount?: number | string | null;
  /** Zálohové faktúry odpočítané na konečnej faktúre (BG-3 BT-25/BT-26) — príjemca podľa nich páruje zálohy. */
  advanceInvoices?: UblCorrectedInvoice[];
};

/**
 * Problém, pre ktorý sa UBL NEVYGENERUJE (fail-closed).
 *
 * Strojovo čitateľné: `code` (stabilný kód → i18n `einvoice.issues.<code>`),
 * `rule` (EN16931 / Peppol / SK pravidlo alebo BT — technická referencia,
 * neprekladá sa) a voliteľné `params` (napr. číslo položky). Server nikdy
 * neposiela hotový text v konkrétnom jazyku — preklad robí klient.
 */
export type UblIssue = {
  code: string;
  /** EN16931 / Peppol pravidlo alebo BT, ktorého sa týka. */
  rule: string;
  params?: Record<string, string | number>;
};

/**
 * Upozornenie, ktoré UBL NEBLOKUJE — typicky SK FS nadstavba (SK-BT-*), ktorej
 * presné znenie verejne nepoznáme. Autoritatívne ju overí preflight
 * poskytovateľa.
 */
export type UblWarning = UblIssue;
