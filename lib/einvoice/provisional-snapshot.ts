import { computeInvoiceTotals } from "../invoicing/vat-engine.ts";
import type { VatCategoryCode } from "../invoicing/vat-categories.ts";
import type { UblInvoiceHeader, UblInvoiceSnapshot, UblItem, UblParty } from "./ubl/model.ts";

// =============================================================================
// PREDBEŽNÝ snapshot KONCEPTU vydanej faktúry — iba pre readiness kontrolu
// pred finalizáciou (lib/einvoice/readiness.ts, režim pre_finalize).
//
// Zrkadlí, čo esblu_finalize_invoice zachytí do invoice_parties pri vydanej
// faktúre (20260923190000_canonical_price_mode): predávajúci = profil firmy
// (company_billing_profile, e-mail = contact_email), kupujúci = obchodný
// partner (business_partners). Sumy počíta ten istý VAT engine ako UI.
//
// NIKDY sa z neho negeneruje odosielané UBL — to vzniká výhradne z
// nemenného snapshotu finalizovanej faktúry (load-finalized-invoice.ts).
// Čistá funkcia, vstup načíta server pod RLS volajúceho.
// =============================================================================

export type DraftHeaderRow = Omit<UblInvoiceHeader, "subtotal_amount" | "vat_total_amount" | "total_amount" | "invoice_number"> & {
  invoice_number: string | null;
};

export type DraftItemRow = {
  position: number;
  description: string;
  quantity: number | string;
  unit_code: string | null;
  unit_price: number | string;
  price_mode: "net" | "gross";
  vat_category_code: VatCategoryCode;
  vat_rate: number | string;
};

export type BillingProfileRow = {
  legal_name: string | null;
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
  contact_email: string | null;
  electronic_address: string | null;
  electronic_address_scheme_id: string | null;
  legal_registration_id: string | null;
  legal_registration_scheme_id: string | null;
  vat_identifier: string | null;
};

export type PartnerRow = Omit<BillingProfileRow, "iban" | "bic" | "contact_email"> & { email: string | null };

function sellerFromProfile(p: BillingProfileRow | null): UblParty {
  return {
    role: "seller",
    legal_name: p?.legal_name ?? "",
    ico: p?.ico ?? null,
    dic: p?.dic ?? null,
    ic_dph: p?.ic_dph ?? null,
    address_line1: p?.address_line1 ?? null,
    address_line2: p?.address_line2 ?? null,
    city: p?.city ?? null,
    postal_code: p?.postal_code ?? null,
    country_code: p?.country_code ?? null,
    iban: p?.iban ?? null,
    bic: p?.bic ?? null,
    email: p?.contact_email ?? null,
    electronic_address: p?.electronic_address ?? null,
    electronic_address_scheme_id: p?.electronic_address_scheme_id ?? null,
    legal_registration_id: p?.legal_registration_id ?? null,
    legal_registration_scheme_id: p?.legal_registration_scheme_id ?? null,
    vat_identifier: p?.vat_identifier ?? null,
  };
}

function buyerFromPartner(p: PartnerRow | null): UblParty {
  return {
    role: "buyer",
    legal_name: p?.legal_name ?? "",
    ico: p?.ico ?? null,
    dic: p?.dic ?? null,
    ic_dph: p?.ic_dph ?? null,
    address_line1: p?.address_line1 ?? null,
    address_line2: p?.address_line2 ?? null,
    city: p?.city ?? null,
    postal_code: p?.postal_code ?? null,
    country_code: p?.country_code ?? null,
    iban: null,
    bic: null,
    email: p?.email ?? null,
    electronic_address: p?.electronic_address ?? null,
    electronic_address_scheme_id: p?.electronic_address_scheme_id ?? null,
    legal_registration_id: p?.legal_registration_id ?? null,
    legal_registration_scheme_id: p?.legal_registration_scheme_id ?? null,
    vat_identifier: p?.vat_identifier ?? null,
  };
}

export function buildProvisionalSnapshot(input: {
  invoice: DraftHeaderRow;
  items: DraftItemRow[];
  profile: BillingProfileRow | null;
  partner: PartnerRow | null;
}): UblInvoiceSnapshot {
  const items = [...input.items].sort((a, b) => a.position - b.position);
  const totals = computeInvoiceTotals(
    items.map((i) => ({
      quantity: i.quantity,
      unitPrice: i.unit_price,
      vatCategoryCode: i.vat_category_code,
      vatRate: i.vat_rate,
      priceMode: i.price_mode,
    })),
    input.invoice.rounding_amount ?? 0
  );

  const ublItems: UblItem[] = items.map((item, index) => ({
    position: item.position,
    description: item.description,
    quantity: item.quantity,
    unit_code: item.unit_code,
    unit_price: item.unit_price,
    price_mode: item.price_mode,
    vat_category_code: item.vat_category_code,
    vat_rate: item.vat_rate,
    line_net_amount: totals.lines[index]?.lineNetAmount ?? "0",
  }));

  return {
    invoice: {
      ...input.invoice,
      subtotal_amount: totals.subtotalAmount,
      vat_total_amount: totals.vatTotalAmount,
      total_amount: totals.totalAmount,
    },
    seller: sellerFromProfile(input.profile),
    buyer: buyerFromPartner(input.partner),
    items: ublItems,
    taxBreakdowns: totals.breakdown.map((b) => ({
      vat_category_code: b.vatCategoryCode,
      vat_rate: b.vatRate,
      taxable_amount: b.taxableAmount,
      vat_amount: b.vatAmount,
      vat_exemption_reason_code: null,
      vat_exemption_reason_text: null,
    })),
    // Väzba na opravovaný doklad sa v pre_finalize kontroluje cez corrects_invoice_id
    // (readiness-server doplní číslo, ak ho RLS dovolí prečítať).
    correctedInvoice: null,
  };
}
