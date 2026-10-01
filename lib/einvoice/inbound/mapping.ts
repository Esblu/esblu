import Decimal from "decimal.js";
import type { ParsedInboundUbl } from "../ubl/parse.ts";

// =============================================================================
// E-Faktúra inbound — validácia profilu a mapovanie rozparsovaného UBL na
// vstup konceptu prijatej faktúry (esblu_einvoice_inbound_create_draft →
// esblu_received_invoice_draft_core). Čistá funkcia, žiadne AI, žiadne
// hádanie: čo nevieme spoľahlivo namapovať, buď zablokuje koncept (kód), alebo
// sa zapíše ako review reason pre človeka.
// =============================================================================

/** EN16931 (vrátane Peppol BIS Billing 3.0 a jeho CIUS/extensions) — CustomizationID začína týmto URN. */
export const EN16931_CUSTOMIZATION_PREFIX = "urn:cen.eu:en16931:2017";

const SUPPORTED_VAT = new Set(["S", "Z", "E", "AE", "K", "G", "O"]);

export type InboundDraftSupplier = {
  legal_name: string | null;
  ico: string | null;
  vat_id: string | null;
  country_code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  endpoint_id: string | null;
  endpoint_scheme: string | null;
};

export type InboundDraftItem = {
  description: string;
  quantity: string;
  unit_price: string;
  vat_category_code: string;
  vat_rate: string;
  unit_code: string | null;
};

export type InboundDraftPayload = {
  supplier: InboundDraftSupplier;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  delivery_date: string | null;
  currency: string;
  iban: string | null;
  bic: string | null;
  payment_reference: string | null;
  buyer_reference: string | null;
  purchase_order_reference: string | null;
  items: InboundDraftItem[];
};

export type MappingResult =
  | { ok: true; draft: InboundDraftPayload; reviewReasons: string[] }
  /** code = verejný kód chyby (UNSUPPORTED_PROFILE / INVALID_XML), detail = strojový podkód. */
  | { ok: false; code: "UNSUPPORTED_PROFILE" | "INVALID_XML"; detail: string };

function blank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === "";
}

/** Profil / typ dokladu, ktorý vieme prijať ako koncept prijatej faktúry. */
export function checkInboundProfile(doc: ParsedInboundUbl): { ok: true } | { ok: false; detail: string } {
  if (blank(doc.customizationId) || !doc.customizationId!.trim().startsWith(EN16931_CUSTOMIZATION_PREFIX)) {
    return { ok: false, detail: "CUSTOMIZATION_NOT_EN16931" };
  }
  // Koncept prijatej faktúry (esblu_received_invoice_draft_core) vytvára iba kind regular_invoice.
  if (doc.documentType !== "Invoice") return { ok: false, detail: "CREDIT_NOTE_NOT_SUPPORTED" };
  return { ok: true };
}

export function mapInboundDraft(doc: ParsedInboundUbl, parserReviewReasons: string[], recipientParticipantId: string | null): MappingResult {
  const profile = checkInboundProfile(doc);
  if (!profile.ok) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: profile.detail };

  if (blank(doc.invoiceNumber)) return { ok: false, code: "INVALID_XML", detail: "MISSING_INVOICE_NUMBER" };
  if (blank(doc.issueDate) || parserReviewReasons.includes("INVALID_ISSUE_DATE")) return { ok: false, code: "INVALID_XML", detail: "INVALID_ISSUE_DATE" };
  if (blank(doc.currency) || !/^[A-Z]{3}$/.test(doc.currency!.trim())) return { ok: false, code: "INVALID_XML", detail: "MISSING_CURRENCY" };
  if (doc.lines.length === 0) return { ok: false, code: "INVALID_XML", detail: "NO_LINES" };
  if (blank(doc.supplier.name)) return { ok: false, code: "INVALID_XML", detail: "MISSING_SUPPLIER_NAME" };

  const reasons = new Set(parserReviewReasons.filter((r) => /^[A-Z0-9_]{1,60}$/.test(r)));
  if (doc.typeCode && doc.typeCode !== "380") reasons.add("INVOICE_TYPE_CODE_UNUSUAL");

  // Príjemca musí byť naša organizácia (Peppol to zaručuje; ak nesedí, iba na kontrolu).
  if (recipientParticipantId) {
    const customer = doc.customer.endpointId && doc.customer.endpointScheme ? `${doc.customer.endpointScheme}:${doc.customer.endpointId}` : null;
    if (customer !== recipientParticipantId) reasons.add("RECIPIENT_ENDPOINT_MISMATCH");
  }

  const items: InboundDraftItem[] = [];
  for (const line of doc.lines) {
    const category = (line.vatCategory ?? "").trim().toUpperCase();
    if (!SUPPORTED_VAT.has(category)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "VAT_CATEGORY_UNSUPPORTED" };
    if (line.quantity === null || line.lineNetAmount === null) return { ok: false, code: "INVALID_XML", detail: "LINE_INCOMPLETE" };
    const qty = new Decimal(line.quantity);
    if (qty.lte(0)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "NON_POSITIVE_QUANTITY" };
    const lineNet = new Decimal(line.lineNetAmount);
    const unitPrice = line.netUnitPrice !== null ? new Decimal(line.netUnitPrice) : lineNet.div(qty).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
    if (unitPrice.lt(0)) return { ok: false, code: "UNSUPPORTED_PROFILE", detail: "NEGATIVE_UNIT_PRICE" };
    if (!qty.times(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).eq(lineNet)) reasons.add("LINE_AMOUNT_MISMATCH");
    if (category === "S" && (line.vatPercent === null || new Decimal(line.vatPercent).lte(0))) {
      return { ok: false, code: "INVALID_XML", detail: "S_RATE_MISSING" };
    }
    let description = (line.name ?? "").trim();
    if (!description) {
      reasons.add("LINE_NAME_MISSING");
      description = `#${(line.id ?? String(items.length + 1)).slice(0, 40)}`;
    }
    items.push({
      description: description.slice(0, 500),
      quantity: qty.toFixed(),
      unit_price: unitPrice.toFixed(),
      vat_category_code: category,
      vat_rate: category === "S" ? new Decimal(line.vatPercent!).toFixed() : "0",
      unit_code: line.unitCode && /^[A-Z0-9]{1,3}$/.test(line.unitCode) ? line.unitCode : null,
    });
  }

  const s = doc.supplier;
  const legalId = (s.legalId ?? "").replace(/\s+/g, "");
  const country = (s.countryCode ?? "").trim().toUpperCase() || null;
  const ico = /^[0-9]{8}$/.test(legalId) && (s.legalIdScheme === "0158" || (!s.legalIdScheme && country === "SK")) ? legalId : null;

  return {
    ok: true,
    reviewReasons: [...reasons].slice(0, 30),
    draft: {
      supplier: {
        legal_name: s.name!.trim(),
        ico,
        vat_id: s.vatId?.trim() || null,
        country_code: country,
        address_line1: s.street,
        address_line2: s.additionalStreet,
        city: s.city,
        postal_code: s.postalCode,
        endpoint_id: s.endpointId,
        endpoint_scheme: s.endpointScheme,
      },
      invoice_number: doc.invoiceNumber!.trim(),
      issue_date: doc.issueDate!.trim(),
      due_date: doc.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.dueDate) ? doc.dueDate : null,
      delivery_date: doc.deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.deliveryDate) ? doc.deliveryDate : null,
      currency: doc.currency!.trim(),
      iban: doc.payeeIban ? doc.payeeIban.replace(/\s+/g, "").toUpperCase() : null,
      bic: doc.payeeBic ? doc.payeeBic.trim().toUpperCase() : null,
      payment_reference: doc.paymentId,
      buyer_reference: doc.buyerReference,
      purchase_order_reference: doc.orderReference,
      items,
    },
  };
}
