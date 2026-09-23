import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  computeInvoiceTotals,
  isInvoiceOverdue as vatEngineIsInvoiceOverdue,
  type VatCategoryCode,
  type VatEngineLineInput,
} from "@/lib/invoicing/vat-engine";
import { DEFAULT_PRICE_MODE, type PriceMode } from "@/lib/invoicing/price-mode";

export type { VatCategoryCode } from "@/lib/invoicing/vat-engine";
export type { PriceMode } from "@/lib/invoicing/price-mode";

// =============================================================================
// invoices — Fáza 2 fakturačné jadro, dátová vrstva.
//
// KRITICKÉ: táto vrstva je klientská DRAFT editácia a PREVIEW iba. Autorita
// je vždy DB (RLS + esblu_finalize_invoice()/esblu_add_invoice_payment()/
// esblu_remove_invoice_payment() SECURITY DEFINER RPC, migrácia
// 20260916095000_add_invoicing_core_rpc.sql). Táto vrstva NIKDY sama
// nezapisuje invoice_number/subtotal_amount/vat_total_amount/total_amount
// ani invoice_parties/invoice_tax_breakdowns — tie vznikajú výhradne v RPC.
// Priamy klientský UPDATE/DELETE je navyše RLS aj DB triggerom odrezaný na
// akúkoľvek finalizovanú faktúru (document_status='draft' vyžadovaný v
// USING/WITH CHECK), takže funkcie nižšie fungujú iba nad draftmi (okrem
// finalize/payment RPC wrapperov).
// =============================================================================

/**
 * Klient, ktorým sa zápis vykoná. Prehliadač posiela singleton, server
 * posiela klienta obliekaného tokenom prihláseného používateľa — v oboch
 * prípadoch ide o rolu `authenticated`, takže RLS platí rovnako. Nikdy sem
 * nepatrí service-role klient; ten by RLS obišiel.
 */
type SupabaseLike = SupabaseClient;

export type InvoiceDirection = "issued" | "received";
export type InvoiceKind =
  | "regular_invoice"
  | "payment_received_invoice"
  | "credit_note"
  | "debit_note";
export type DocumentStatus = "draft" | "finalized";
export type PaymentStatus = "unpaid" | "partially_paid" | "paid";
export type InvoiceSource = "manual" | "ai_inbox" | "efaktura_peppol";
export type InvoicePartyRole = "seller" | "buyer";

export type Invoice = {
  id: string;
  company_id: string;
  direction: InvoiceDirection;
  kind: InvoiceKind;
  document_status: DocumentStatus;
  payment_status: PaymentStatus;
  invoice_number: string | null;
  invoice_number_sequence_id: string | null;
  issue_date: string;
  due_date: string | null;
  delivery_date: string | null;
  tax_point_date: string | null;
  currency: string;
  subtotal_amount: number;
  vat_total_amount: number;
  total_amount: number;
  rounding_amount: number;
  variable_symbol: string | null;
  payment_terms_days: number | null;
  iban: string | null;
  customer_business_partner_id: string | null;
  /** Dodávateľ pri direction='received'. Pri 'issued' vždy NULL (DB CHECK
   *  invoices_supplier_only_when_received). Migrácia 20260920120000. */
  supplier_business_partner_id: string | null;
  /** Číslo dokladu tak, ako ho pridelil DODÁVATEĽ — kanonická externá identita
   *  prijatej faktúry. Esblu prijatej faktúre nikdy neprideľuje vlastné
   *  invoice_number (DB CHECK invoices_received_never_gets_internal_number);
   *  po finalizácii je toto pole pre direction='received' povinné
   *  (invoices_number_required_when_finalized). Pri 'issued' vždy NULL. */
  supplier_invoice_number: string | null;
  /** Dátum fyzického prijatia dokladu — nezamieňať s issue_date/tax_point_date.
   *  Pri direction='issued' vždy NULL. */
  received_at: string | null;
  /** Dedupe vrstva B — sha256 normalizovanej identity dokladu. NULL ak
   *  dodávateľ nemá spoľahlivý identifikátor (vtedy dedupe nebeží). */
  dedupe_fingerprint: string | null;
  /** Dedupe vrstva C — až s reálnou Peppol prevádzkou. */
  transport_provider: string | null;
  transport_message_id: string | null;
  /** EN16931 BT-10. */
  buyer_reference: string | null;
  /** EN16931 BT-13. */
  purchase_order_reference: string | null;
  /** EN16931 BT-81, UNTDID 4461. */
  payment_means_code: string | null;
  /** EN16931 BT-83 — canonical náprotivok variable_symbol. */
  payment_reference: string | null;
  corrects_invoice_id: string | null;
  source: InvoiceSource;
  source_document_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string | null;
  finalized_at: string | null;
  finalized_by: string | null;
};

export type InvoiceItem = {
  id: string;
  invoice_id: string;
  position: number;
  description: string;
  quantity: number;
  unit: string;
  /** Kanonický UN/ECE Recommendation 20/21 unit-of-measure kód (napr. HUR,
   *  MTQ, KGM) pre EN16931/Peppol export — FÁZA 3B P0 gap, migrácia
   *  20260917100000_add_invoicing_en16931_p0_fields. Nullable/expand-only,
   *  zámerne oddelené od `unit` (voľný textový display label) — NIKDY sa
   *  automaticky nedopĺňa z `unit`. V tejto fáze nie je zapojené do žiadneho
   *  UI/RPC — čisté schema hardening, pozri
   *  docs/invoicing-en16931-gap-analysis-2026-09.md. */
  unit_code: string | null;
  unit_price: number;
  /**
   * Ako sa má čítať `unit_price` — pozri KANONICKÝ PEŇAŽNÝ MODEL v
   * lib/invoicing/vat-engine.ts. "net" = cena bez dane (autoritatívny je
   * line_net_amount), "gross" = cena s daňou tak, ako ju človek zadal
   * (autoritatívny je line_gross_amount). Riadky spred migrácie
   * 20260923190000 majú "net", teda presne svoj doterajší význam.
   */
  price_mode: PriceMode;
  vat_category_code: VatCategoryCode;
  vat_rate: number;
  line_net_amount: number;
  line_vat_amount: number;
  line_gross_amount: number;
  created_at: string;
  updated_at: string | null;
};

export type InvoiceTaxBreakdown = {
  id: string;
  invoice_id: string;
  vat_category_code: VatCategoryCode;
  vat_rate: number;
  taxable_amount: number;
  vat_amount: number;
  /** VATEX kód dôvodu oslobodenia/prenosu daňovej povinnosti (napr.
   *  VATEX-EU-AE) pre kategórie E/AE — EN16931 BR-E-10/BR-AE-10. FÁZA 3B P0
   *  gap, migrácia 20260917100000_add_invoicing_en16931_p0_fields.
   *  Nullable/expand-only, bez hardcoded krajinovo-špecifického textu/kódu;
   *  v tejto fáze nezapojené do UI/RPC. */
  vat_exemption_reason_code: string | null;
  /** Voľný text sprevádzajúci vat_exemption_reason_code. Nullable/expand-only. */
  vat_exemption_reason_text: string | null;
};

export type InvoiceParty = {
  id: string;
  invoice_id: string;
  role: InvoicePartyRole;
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
  peppol_identifier: string | null;
  // EN16931 P1 identifikátory zo snapshotu (migrácia 20260920122000).
  // Sú súčasťou IMMUTABLE snapshotu — nikdy sa nečítajú z live
  // business_partners, aj keby sa medzitým zmenili.
  electronic_address: string | null;
  electronic_address_scheme_id: string | null;
  legal_registration_id: string | null;
  legal_registration_scheme_id: string | null;
  vat_identifier: string | null;
  generic_identifier: string | null;
  generic_identifier_scheme_id: string | null;
  source_business_partner_id: string | null;
  snapshotted_at: string;
};

export type InvoicePayment = {
  id: string;
  invoice_id: string;
  paid_amount: number;
  paid_at: string;
  payment_method: string | null;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
};

/** Odvodený (nikdy neuložený) "po splatnosti" stav. Pozri lib/invoicing/vat-engine.ts. */
export const isInvoiceOverdue = vatEngineIsInvoiceOverdue;

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export async function listInvoices(companyId: string): Promise<Invoice[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("company_id", companyId)
    .order("document_status", { ascending: true })
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data as Invoice[]) ?? [];
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return (data as Invoice) ?? null;
}

export async function listInvoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
  const { data, error } = await supabase
    .from("invoice_items")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("position", { ascending: true });

  if (error) throw error;
  return (data as InvoiceItem[]) ?? [];
}

export async function listInvoiceTaxBreakdowns(
  invoiceId: string
): Promise<InvoiceTaxBreakdown[]> {
  const { data, error } = await supabase
    .from("invoice_tax_breakdowns")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("vat_category_code", { ascending: true });

  if (error) throw error;
  return (data as InvoiceTaxBreakdown[]) ?? [];
}

export async function listInvoiceParties(invoiceId: string): Promise<InvoiceParty[]> {
  const { data, error } = await supabase
    .from("invoice_parties")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("role", { ascending: true });

  if (error) throw error;
  return (data as InvoiceParty[]) ?? [];
}

export async function listInvoicePayments(invoiceId: string): Promise<InvoicePayment[]> {
  const { data, error } = await supabase
    .from("invoice_payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("paid_at", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data as InvoicePayment[]) ?? [];
}

// -----------------------------------------------------------------------------
// Draft: hlavička faktúry
// -----------------------------------------------------------------------------

export type DraftInvoiceHeaderInput = {
  direction: InvoiceDirection;
  kind: InvoiceKind;
  currency: string;
  issue_date: string;
  due_date: string | null;
  /** Protistrana pri direction='issued'. Pre 'received' musí zostať NULL. */
  customer_business_partner_id: string | null;
  /** Protistrana pri direction='received'. Pre 'issued' musí zostať NULL.
   *  esblu_finalize_invoice() ju pri received vyžaduje (ESBLU_MISSING_SUPPLIER). */
  supplier_business_partner_id?: string | null;
  /** Číslo dokladu dodávateľa. Pri received je po finalizácii povinné
   *  (ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER). Pre 'issued' musí zostať NULL —
   *  vydané číslo prideľuje výhradne DB pri finalizácii. */
  supplier_invoice_number?: string | null;
  /** Dátum fyzického prijatia dokladu (len received). */
  received_at?: string | null;
  variable_symbol: string | null;
  payment_terms_days: number | null;
  corrects_invoice_id: string | null;
};

/**
 * `db` je voliteľný Supabase klient. Bez neho sa použije klientský
 * singleton (formulár v prehliadači); server (hlasový asistent) sem
 * odovzdá klienta obliekaného tokenom volajúceho.
 *
 * Je to jeden parameter namiesto druhej funkcie zámerne: obe cesty tak
 * posielajú DOSLOVA ten istý payload a prechádzajú tou istou RLS
 * politikou. Samostatná "serverová verzia" by sa časom rozišla a rozdiel
 * by sa našiel až na produkcii.
 */
export async function createDraftInvoice(
  companyId: string,
  userId: string,
  input: DraftInvoiceHeaderInput,
  db: SupabaseLike = supabase
): Promise<Invoice> {
  const { data, error } = await db
    .from("invoices")
    .insert({
      company_id: companyId,
      direction: input.direction,
      kind: input.kind,
      currency: input.currency,
      issue_date: input.issue_date,
      due_date: input.due_date,
      customer_business_partner_id: input.customer_business_partner_id,
      supplier_business_partner_id: input.supplier_business_partner_id ?? null,
      supplier_invoice_number: input.supplier_invoice_number ?? null,
      received_at: input.received_at ?? null,
      variable_symbol: input.variable_symbol,
      payment_terms_days: input.payment_terms_days,
      corrects_invoice_id: input.corrects_invoice_id,
      created_by: userId,
      updated_by: userId,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as Invoice;
}

export async function updateDraftInvoiceHeader(
  id: string,
  userId: string,
  input: Partial<DraftInvoiceHeaderInput>
): Promise<Invoice> {
  const { data, error } = await supabase
    .from("invoices")
    .update({ ...input, updated_by: userId, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data as Invoice;
}

/** Iba draft sa dá zmazať (RLS invoices_delete_finance_draft) — finalizovaná
 *  faktúra sa nikdy nemaže, oprava ide cez credit_note/debit_note. */
export async function deleteDraftInvoice(id: string): Promise<void> {
  const { error } = await supabase.from("invoices").delete().eq("id", id);
  if (error) throw error;
}

// -----------------------------------------------------------------------------
// Draft: riadkové položky
// -----------------------------------------------------------------------------

export type DraftInvoiceItemInput = {
  description: string;
  quantity: number;
  unit: string;
  vat_category_code: VatCategoryCode;
  vat_rate: number;
  unit_price: number;
  /**
   * Ako sa má čítať `unit_price`. Voliteľné — chýbajúca hodnota znamená
   * "net", teda doterajšie správanie každého volajúceho, ktorý o režime ceny
   * nevie. Pozri KANONICKÝ PEŇAŽNÝ MODEL v lib/invoicing/vat-engine.ts.
   */
  price_mode?: PriceMode;
};

/** Vstup pre VAT engine z draft riadku — jediný preklad medzi oboma tvarmi. */
function toEngineLine(item: DraftInvoiceItemInput): VatEngineLineInput {
  return {
    quantity: item.quantity,
    unitPrice: item.unit_price,
    vatCategoryCode: item.vat_category_code,
    vatRate: item.vat_rate,
    priceMode: item.price_mode ?? DEFAULT_PRICE_MODE,
  };
}

/**
 * Nahradí VŠETKY riadky draftu naraz (delete + insert v jednej "logickej"
 * operácii z pohľadu volajúceho). Jednoduchšie a menej krehké než
 * riadok-po-riadku diffing pre editor s voľne pridávanými/mazanými/
 * preusporadúvanými riadkami. RLS aj DB trigger aj tak povoľujú zápis iba
 * kým je rodičovská faktúra draft, takže toto je bezpečné volať ľubovoľne
 * počas editácie draftu. line_net_amount/line_vat_amount/line_gross_amount
 * sa dopočítajú cez VAT engine (iba UI preview — finalize prepočíta
 * autoritatívne nanovo v DB).
 */
export async function replaceDraftInvoiceItems(
  invoiceId: string,
  items: DraftInvoiceItemInput[],
  db: SupabaseLike = supabase
): Promise<InvoiceItem[]> {
  const { error: deleteError } = await db
    .from("invoice_items")
    .delete()
    .eq("invoice_id", invoiceId);

  if (deleteError) throw deleteError;

  if (items.length === 0) return [];

  // Riadky sa počítajú NARAZ, nie po jednom. Dopočítaná zložka (daň pri
  // cenách bez dane, základ pri cenách s daňou) sa rozdeľuje zo skupinového
  // čísla, takže riadok bez ostatných riadkov sa spočítať nedá — a keby sa
  // to skúsilo, súčty by sa rozišli o cent. Presne to bol bug 1800,01.
  const computed = computeInvoiceTotals(items.map(toEngineLine));

  const rows = items.map((item, index) => ({
    invoice_id: invoiceId,
    position: index + 1,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    price_mode: item.price_mode ?? DEFAULT_PRICE_MODE,
    vat_category_code: item.vat_category_code,
    vat_rate: item.vat_rate,
    line_net_amount: Number(computed.lines[index].lineNetAmount),
    line_vat_amount: Number(computed.lines[index].lineVatAmount),
    line_gross_amount: Number(computed.lines[index].lineGrossAmount),
  }));

  const { data, error } = await db.from("invoice_items").insert(rows).select("*");

  if (error) throw error;
  return (data as InvoiceItem[]) ?? [];
}

/** Live PREVIEW súčtov v UI editore draftu (VAT engine, decimal.js) — NIKDY
 *  autoritatívny zdroj, iba to, čo esblu_finalize_invoice() nezávisle
 *  prepočíta a naozaj zapíše. */
export function previewDraftTotals(items: DraftInvoiceItemInput[]) {
  return computeInvoiceTotals(items.map(toEngineLine));
}

// -----------------------------------------------------------------------------
// Splatnosť draftu — issue_date/payment_terms_days/due_date musia zostať
// vzájomne synchronizované (nikdy dva nezávislé zdroje pravdy, ktoré sa môžu
// rozísť). Čisté kalendárne celočíselné počítanie dní — ŽIADNA peňažná
// matematika, takže decimal.js/VAT engine sa tu zámerne nepoužíva.
// UTC-based Date konštrukcia/aritmetika (nie lokálny čas), aby sa predišlo
// posunu o deň pri DST/timezone hraniciach.
// -----------------------------------------------------------------------------

function parseIsoDateUtc(value: string): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** issue_date + payment_terms_days (celé číslo, >= 0) -> due_date (YYYY-MM-DD).
 *  null pri neplatnom/chýbajúcom vstupe. */
export function computeDueDateFromTerms(
  issueDate: string,
  paymentTermsDays: number
): string | null {
  if (!Number.isFinite(paymentTermsDays) || paymentTermsDays < 0) return null;
  const base = parseIsoDateUtc(issueDate);
  if (!base) return null;
  base.setUTCDate(base.getUTCDate() + Math.trunc(paymentTermsDays));
  return base.toISOString().slice(0, 10);
}

/** issue_date + due_date (obe YYYY-MM-DD) -> payment_terms_days (celé číslo).
 *  null ak je due_date pred issue_date alebo je vstup neplatný/chýbajúci —
 *  volajúci by v tom prípade NEMAL prepísať existujúcu hodnotu payment_terms_days
 *  (nechať pole prázdne a nech to zachytí validateDraftBeforeFinalize). */
export function computePaymentTermsDaysFromDueDate(
  issueDate: string,
  dueDate: string
): number | null {
  const start = parseIsoDateUtc(issueDate);
  const end = parseIsoDateUtc(dueDate);
  if (!start || !end) return null;
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return days >= 0 ? days : null;
}

// -----------------------------------------------------------------------------
// Validácia draftu pred finalizáciou (klientská, iba UX — DB má vlastnú,
// autoritatívnu validáciu v esblu_finalize_invoice()).
// -----------------------------------------------------------------------------

export type DraftValidationError = { field: string; messageKey: string };

// -----------------------------------------------------------------------------
// VAT default (audit, Fáza 2 pokračovanie): Esblu nesmie samo hádať DPH
// sadzbu (podľa krajiny, názvu položky, AI klasifikácie a pod.) — default
// pre novú S-kategóriu položku pochádza VÝHRADNE z
// company_billing_profile.default_vat_rate. Ak firma default nemá nastavený,
// sadzba zostáva nerozlíšená (v UI reprezentovaná ako `NaN` — číselný typ
// `number` sa preto NEMENÍ na `number | null` naprieč celým kódom, aby sa
// nezasahovalo zbytočne do DraftInvoiceItemInput/DB kontraktu) a používateľ
// ju musí zadať/potvrdiť pred uložením AJ finalizáciou draftu. Táto funkcia
// je zdieľaná oboma bránami (save aj finalize), aby sa nerozlíšená S sadzba
// nikdy nedostala do DB (invoice_items.vat_rate je NOT NULL, bez defaultu
// špecifického pre krajinu — samotný DB default 0 je neutrálny fallback pre
// stĺpec, nie "univerzálna sadzba").
// -----------------------------------------------------------------------------
export function findUnresolvedVatRateErrors(items: DraftInvoiceItemInput[]): DraftValidationError[] {
  const errors: DraftValidationError[] = [];
  items.forEach((item, index) => {
    if (item.vat_category_code === "S" && !(Number.isFinite(item.vat_rate) && item.vat_rate >= 0)) {
      errors.push({ field: `items.${index}.vat_rate`, messageKey: "itemVatRateUnresolved" });
    }
  });
  return errors;
}

export function validateDraftBeforeFinalize(
  invoice: Pick<
    Invoice,
    "issue_date" | "customer_business_partner_id" | "kind" | "corrects_invoice_id"
  > &
    Partial<
      Pick<
        Invoice,
        | "due_date"
        | "payment_terms_days"
        | "direction"
        | "supplier_business_partner_id"
        | "supplier_invoice_number"
      >
    >,
  items: DraftInvoiceItemInput[]
): DraftValidationError[] {
  const errors: DraftValidationError[] = [];

  if (!invoice.issue_date) {
    errors.push({ field: "issue_date", messageKey: "missingIssueDate" });
  }

  if (
    invoice.issue_date &&
    invoice.due_date &&
    computePaymentTermsDaysFromDueDate(invoice.issue_date, invoice.due_date) === null
  ) {
    errors.push({ field: "due_date", messageKey: "dueDateBeforeIssueDate" });
  }

  if (invoice.payment_terms_days != null && invoice.payment_terms_days < 0) {
    errors.push({ field: "payment_terms_days", messageKey: "paymentTermsDaysNegative" });
  }

  // Protistrana je direction-aware. Pri prijatej faktúre je ňou DODÁVATEĽ a
  // customer_business_partner_id je z definície NULL (DB CHECK
  // invoices_customer_only_when_issued) — kontrolovať ho by znamenalo, že
  // každý received draft by tu spadol na "missingBusinessPartner".
  // `direction` je voliteľný: staršie volania bez neho sa správajú ako issued,
  // čo je pôvodné správanie.
  if (invoice.direction === "received") {
    if (!invoice.supplier_business_partner_id) {
      errors.push({
        field: "supplier_business_partner_id",
        messageKey: "missingSupplier",
      });
    }
    if (!invoice.supplier_invoice_number?.trim()) {
      errors.push({
        field: "supplier_invoice_number",
        messageKey: "missingSupplierInvoiceNumber",
      });
    }
  } else if (!invoice.customer_business_partner_id) {
    errors.push({ field: "customer_business_partner_id", messageKey: "missingBusinessPartner" });
  }

  if (items.length === 0) {
    errors.push({ field: "items", messageKey: "missingItems" });
  }

  if (
    (invoice.kind === "credit_note" || invoice.kind === "debit_note") &&
    !invoice.corrects_invoice_id
  ) {
    errors.push({ field: "corrects_invoice_id", messageKey: "missingCorrectsInvoice" });
  }

  items.forEach((item, index) => {
    if (!item.description.trim()) {
      errors.push({ field: `items.${index}.description`, messageKey: "itemDescriptionRequired" });
    }
    if (!(item.quantity > 0)) {
      errors.push({ field: `items.${index}.quantity`, messageKey: "itemQuantityInvalid" });
    }
    if (!(item.unit_price >= 0)) {
      errors.push({ field: `items.${index}.unit_price`, messageKey: "itemUnitPriceInvalid" });
    }
  });

  errors.push(...findUnresolvedVatRateErrors(items));

  return errors;
}

// -----------------------------------------------------------------------------
// Finalize + platby — VÝHRADNE cez SECURITY DEFINER RPC (migrácia B). Nikdy
// priamy klientský UPDATE invoices.document_status/payment_status.
// -----------------------------------------------------------------------------

export type FinalizeInvoiceResult = {
  invoice_id: string;
  direction: InvoiceDirection;
  /** Interné vydané číslo Esblu. NULL pri direction='received' — prijatej
   *  faktúre sa interné číslo nikdy neprideľuje, jej identitou je
   *  supplier_invoice_number. */
  invoice_number: string | null;
  /** Číslo dokladu dodávateľa. NULL pri direction='issued'. */
  supplier_invoice_number: string | null;
  subtotal_amount: number;
  vat_total_amount: number;
  total_amount: number;
  finalized_at: string;
};

const FINALIZE_ERROR_CODES = [
  "ESBLU_NO_ACTIVE_COMPANY",
  "ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED",
  "ESBLU_INVOICE_NOT_FOUND",
  "ESBLU_INVOICE_NOT_DRAFT",
  "ESBLU_MISSING_ISSUE_DATE",
  "ESBLU_INVOICE_NO_ITEMS",
  "ESBLU_MISSING_BUSINESS_PARTNER",
  "ESBLU_BUSINESS_PARTNER_NOT_FOUND",
  "ESBLU_MISSING_BILLING_PROFILE",
  "ESBLU_CORRECTED_INVOICE_NOT_FOUND",
  "ESBLU_CORRECTED_INVOICE_FOREIGN_COMPANY",
  "ESBLU_CORRECTED_INVOICE_NOT_FINALIZED",
  // Direction-aware vetvy z migrácie 20260920140000. Sú to reálne výstupy
  // esblu_finalize_invoice() pre direction='received' — dosiahnuteľné cez
  // túto dátovú vrstvu už dnes, aj keď dedikovaný received UI ešte nie je.
  // Kód bez slovníkového záznamu by používateľovi ukázal iba generické
  // "skúste znova", preto sa pridávajú spolu s SK/DE/EN prekladom.
  "ESBLU_CORRECTED_INVOICE_DIRECTION_MISMATCH",
  "ESBLU_MISSING_SUPPLIER",
  "ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER",
  "ESBLU_SUPPLIER_NOT_FOUND",
  "ESBLU_DUPLICATE_RECEIVED_INVOICE",
] as const;
export type FinalizeErrorCode = (typeof FINALIZE_ERROR_CODES)[number];

export function parseFinalizeErrorCode(error: unknown): FinalizeErrorCode | null {
  const text = error instanceof Error ? error.message : String(error);
  return FINALIZE_ERROR_CODES.find((code) => text.includes(code)) ?? null;
}

/**
 * Jednosmerná, atomická finalizácia draftu. Volá esblu_finalize_invoice()
 * (SECURITY DEFINER) — DB si autoritatívne prepočíta VAT breakdown/súčty,
 * pridelí číslo (concurrency-safe pg_advisory_xact_lock) a vytvorí immutable
 * invoice_parties snapshot, všetko v jednej DB transakcii. Táto funkcia
 * nikdy nič sama nezapisuje, iba volá RPC a vracia jeho výsledok.
 */
export async function finalizeInvoice(invoiceId: string): Promise<FinalizeInvoiceResult> {
  const { data, error } = await supabase.rpc("esblu_finalize_invoice", {
    p_invoice_id: invoiceId,
  });

  if (error) throw error;
  return data as FinalizeInvoiceResult;
}

// -----------------------------------------------------------------------------
// AI Inbox → canonical received invoice draft
// -----------------------------------------------------------------------------

export type ReceivedDraftItemInput = {
  description: string;
  quantity: number;
  unit: string;
  /** Iba ak ho používateľ potvrdil — nikdy sa neodvodzuje z `unit`. */
  unit_code: string | null;
  unit_price: number;
  vat_category_code: VatCategoryCode;
  /** Význam má výhradne pre kategóriu S; pre Z/E/AE posielame 0. */
  vat_rate: number;
};

export type CreateReceivedDraftInput = {
  supplier_business_partner_id: string;
  supplier_invoice_number: string;
  issue_date: string;
  items: ReceivedDraftItemInput[];
  due_date?: string | null;
  delivery_date?: string | null;
  tax_point_date?: string | null;
  currency?: string | null;
  iban?: string | null;
  bic?: string | null;
  payment_reference?: string | null;
  variable_symbol?: string | null;
  buyer_reference?: string | null;
  purchase_order_reference?: string | null;
  received_at?: string | null;
  source_document_id?: string | null;
  dedupe_fingerprint?: string | null;
};

export type CreateReceivedDraftResult =
  | {
      status: "created";
      invoice_id: string;
      supplier_invoice_number: string;
      item_count: number;
    }
  | {
      status: "duplicate";
      existing_invoice_id: string;
      matched_on: "supplier_invoice_number" | "dedupe_fingerprint" | "source_document";
    };

/**
 * Vytvorí canonical received invoice DRAFT z potvrdeného Inbox review.
 *
 * Volá esblu_create_received_invoice_draft() (SECURITY DEFINER), ktorá v
 * jednej transakcii overí oprávnenia a tenant, spustí dedupe, vloží faktúru
 * aj položky a prelinkuje zdrojový dokument. Táto funkcia nikdy nič sama
 * nezapisuje.
 *
 * Duplikát NIE JE chyba — vracia sa ako `status: "duplicate"` s id existujúcej
 * faktúry, aby ju UI vedelo ponúknuť. Druhá canonical faktúra nevznikne.
 * Draft sa NIKDY automaticky nefinalizuje.
 */
export async function createReceivedInvoiceDraft(
  input: CreateReceivedDraftInput
): Promise<CreateReceivedDraftResult> {
  const { data, error } = await supabase.rpc("esblu_create_received_invoice_draft", {
    p_supplier_business_partner_id: input.supplier_business_partner_id,
    p_supplier_invoice_number: input.supplier_invoice_number,
    p_issue_date: input.issue_date,
    p_items: input.items,
    p_due_date: input.due_date ?? null,
    p_delivery_date: input.delivery_date ?? null,
    p_tax_point_date: input.tax_point_date ?? null,
    p_currency: input.currency ?? "EUR",
    p_iban: input.iban ?? null,
    p_bic: input.bic ?? null,
    p_payment_reference: input.payment_reference ?? null,
    p_variable_symbol: input.variable_symbol ?? null,
    p_buyer_reference: input.buyer_reference ?? null,
    p_purchase_order_reference: input.purchase_order_reference ?? null,
    p_received_at: input.received_at ?? null,
    p_source_document_id: input.source_document_id ?? null,
    p_dedupe_fingerprint: input.dedupe_fingerprint ?? null,
  });

  if (error) throw error;
  return data as CreateReceivedDraftResult;
}

export type AddPaymentResult = {
  payment_id: string;
  payment_status: PaymentStatus;
  total_paid: number;
};

export async function addInvoicePayment(
  invoiceId: string,
  paidAmount: number,
  paidAt: string,
  paymentMethod: string | null,
  note: string | null
): Promise<AddPaymentResult> {
  const { data, error } = await supabase.rpc("esblu_add_invoice_payment", {
    p_invoice_id: invoiceId,
    p_paid_amount: paidAmount,
    p_paid_at: paidAt,
    p_payment_method: paymentMethod,
    p_note: note,
  });

  if (error) throw error;
  return data as AddPaymentResult;
}

export type RemovePaymentResult = {
  invoice_id: string;
  payment_status: PaymentStatus;
  total_paid: number;
};

export async function removeInvoicePayment(paymentId: string): Promise<RemovePaymentResult> {
  const { data, error } = await supabase.rpc("esblu_remove_invoice_payment", {
    p_payment_id: paymentId,
  });

  if (error) throw error;
  return data as RemovePaymentResult;
}
