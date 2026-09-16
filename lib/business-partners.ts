import { supabase } from "@/lib/supabase";
import {
  normalizeCountryCode,
  normalizeCurrencyCode,
  validateEmailFormat,
} from "@/lib/company-billing-profile";

// =============================================================================
// business_partners — company-scoped master data (zákazníci/dodávatelia).
// Fáza 1B (20260916120000_...). Mutable master data — NIE právny snapshot
// faktúry (Fáza 2 si tieto údaje nasnapshotuje do invoice_parties).
//
// GDPR: partner môže byť SZČO/fyzická osoba (osobné údaje) — zbierajú sa
// VÝHRADNE fakturačne/obchodne potrebné polia. Žiadne dátumy narodenia,
// rodné čísla, osobné poznámky. Viď report pre CLIA (GDPR impact).
// =============================================================================

export type BusinessPartnerKind = "customer" | "supplier" | "both";

export type BusinessPartner = {
  id: string;
  company_id: string;
  kind: BusinessPartnerKind;
  legal_name: string;
  ico: string | null;
  dic: string | null;
  ic_dph: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  email: string | null;
  phone: string | null;
  peppol_identifier: string | null;
  default_payment_terms_days: number | null;
  default_currency: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string | null;
};

export const EMPTY_BUSINESS_PARTNER_FORM = {
  kind: "customer" as BusinessPartnerKind,
  legal_name: "",
  ico: "",
  dic: "",
  ic_dph: "",
  address_line1: "",
  address_line2: "",
  city: "",
  postal_code: "",
  country_code: "",
  email: "",
  phone: "",
  peppol_identifier: "",
  default_payment_terms_days: "",
  default_currency: "",
};

export type BusinessPartnerForm = typeof EMPTY_BUSINESS_PARTNER_FORM;

export function businessPartnerToForm(partner: BusinessPartner): BusinessPartnerForm {
  return {
    kind: partner.kind,
    legal_name: partner.legal_name,
    ico: partner.ico ?? "",
    dic: partner.dic ?? "",
    ic_dph: partner.ic_dph ?? "",
    address_line1: partner.address_line1 ?? "",
    address_line2: partner.address_line2 ?? "",
    city: partner.city ?? "",
    postal_code: partner.postal_code ?? "",
    country_code: partner.country_code ?? "",
    email: partner.email ?? "",
    phone: partner.phone ?? "",
    peppol_identifier: partner.peppol_identifier ?? "",
    default_payment_terms_days:
      partner.default_payment_terms_days === null
        ? ""
        : String(partner.default_payment_terms_days),
    default_currency: partner.default_currency ?? "",
  };
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalInt(rawValue: string): number | null | "invalid" {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  return Number(trimmed);
}

export type BusinessPartnerValidationError = {
  field: keyof BusinessPartnerForm;
  messageKey: string;
};

export function validateBusinessPartnerForm(
  form: BusinessPartnerForm
):
  | { errors: BusinessPartnerValidationError[]; payload: null }
  | {
      errors: [];
      payload: Omit<
        BusinessPartner,
        "id" | "company_id" | "created_at" | "updated_at" | "created_by" | "updated_by"
      >;
    } {
  const errors: BusinessPartnerValidationError[] = [];

  const legalName = emptyToNull(form.legal_name);
  if (!legalName) {
    errors.push({ field: "legal_name", messageKey: "required" });
  }

  const countryCode = normalizeCountryCode(form.country_code);
  if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
    errors.push({ field: "country_code", messageKey: "invalidCountryCode" });
  }

  const currency = normalizeCurrencyCode(form.default_currency);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    errors.push({ field: "default_currency", messageKey: "invalidCurrency" });
  }

  const paymentTermsDays = parseOptionalInt(form.default_payment_terms_days);
  if (
    paymentTermsDays === "invalid" ||
    (typeof paymentTermsDays === "number" && (paymentTermsDays < 0 || paymentTermsDays > 365))
  ) {
    errors.push({ field: "default_payment_terms_days", messageKey: "invalidPaymentTerms" });
  }

  if (!validateEmailFormat(form.email)) {
    errors.push({ field: "email", messageKey: "invalidEmail" });
  }

  if (errors.length > 0) {
    return { errors, payload: null };
  }

  return {
    errors: [],
    payload: {
      kind: form.kind,
      legal_name: legalName as string,
      ico: emptyToNull(form.ico),
      dic: emptyToNull(form.dic),
      ic_dph: emptyToNull(form.ic_dph),
      address_line1: emptyToNull(form.address_line1),
      address_line2: emptyToNull(form.address_line2),
      city: emptyToNull(form.city),
      postal_code: emptyToNull(form.postal_code),
      country_code: countryCode,
      email: emptyToNull(form.email),
      phone: emptyToNull(form.phone),
      peppol_identifier: emptyToNull(form.peppol_identifier),
      default_payment_terms_days: paymentTermsDays === "invalid" ? null : paymentTermsDays,
      default_currency: currency,
    },
  };
}

export async function listBusinessPartners(companyId: string): Promise<BusinessPartner[]> {
  const { data, error } = await supabase
    .from("business_partners")
    .select("*")
    .eq("company_id", companyId)
    .order("legal_name", { ascending: true });

  if (error) {
    throw error;
  }

  return (data as BusinessPartner[]) ?? [];
}

export async function getBusinessPartner(id: string): Promise<BusinessPartner | null> {
  const { data, error } = await supabase
    .from("business_partners")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as BusinessPartner) ?? null;
}

export const BUSINESS_PARTNER_DUPLICATE_ICO_ERROR = "ESBLU_DUPLICATE_ICO";

function normalizeUpsertError(error: { code?: string; message: string }): never {
  // 23505 = unique_violation. Rozlišujeme IČO duplicitu (jediná, ktorú
  // appka dnes cielene vysvetľuje) od peppol duplicity (zriedkavé, necháme
  // padnúť na generickú chybu — pozri zadanie bod 11: "Pri duplicite:
  // nezmaž dáta, v UI ukáž jasnú chybu").
  if (error.code === "23505" && error.message.includes("business_partners_company_ico_unique")) {
    throw new Error(BUSINESS_PARTNER_DUPLICATE_ICO_ERROR);
  }

  throw new Error(error.message);
}

export async function createBusinessPartner(
  companyId: string,
  userId: string,
  payload: Omit<
    BusinessPartner,
    "id" | "company_id" | "created_at" | "updated_at" | "created_by" | "updated_by"
  >
): Promise<BusinessPartner> {
  const { data, error } = await supabase
    .from("business_partners")
    .insert({
      ...payload,
      company_id: companyId,
      created_by: userId,
      updated_by: userId,
    })
    .select("*")
    .single();

  if (error) {
    normalizeUpsertError(error);
  }

  return data as BusinessPartner;
}

export async function updateBusinessPartner(
  id: string,
  userId: string,
  payload: Omit<
    BusinessPartner,
    "id" | "company_id" | "created_at" | "updated_at" | "created_by" | "updated_by"
  >
): Promise<BusinessPartner> {
  const { data, error } = await supabase
    .from("business_partners")
    .update({
      ...payload,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    normalizeUpsertError(error);
  }

  return data as BusinessPartner;
}

export async function deleteBusinessPartner(id: string): Promise<void> {
  const { error } = await supabase.from("business_partners").delete().eq("id", id);

  if (error) {
    throw error;
  }
}
