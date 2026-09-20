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

  // Platobné identifikátory (migrácia 20260921160000). EN16931 BT-84 / BT-86.
  // Kmeňové dáta — finalizovaná faktúra si nesie vlastný snapshot a zmena
  // tu ju nikdy spätne neovplyvní.
  iban?: string | null;
  bic?: string | null;

  // EN16931 P1 identifikátory (migrácia 20260920122000). Používajú sa pri
  // deterministickom supplier matchingu (lib/invoicing/supplier-matching.ts)
  // a snapshotuje ich esblu_finalize_invoice().
  // Voliteľné v TS zámerne: staršie volajúce cesty ich nemusia vypĺňať.
  /** EN16931 BT-31/BT-48. */
  vat_identifier?: string | null;
  /** EN16931 BT-30/BT-47 + ICD scheme. */
  legal_registration_id?: string | null;
  legal_registration_scheme_id?: string | null;
  /** EN16931 BT-34/BT-49 + EAS scheme. */
  electronic_address?: string | null;
  electronic_address_scheme_id?: string | null;
  generic_identifier?: string | null;
  generic_identifier_scheme_id?: string | null;
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

  // Platobné údaje (EN16931 BT-84 / BT-86).
  iban: "",
  bic: "",

  // eFaktúra — adresácia a registračné identifikátory.
  // Schémy sú VOĽNÉ TEXTOVÉ POLIA, nie výber z jednej krajiny: EAS (BT-49)
  // aj ICD (BT-47) sú medzinárodné číselníky a Esblu nesmie predpokladať
  // jednu schému ani jeden štát (§14 zadania).
  vat_identifier: "",
  legal_registration_id: "",
  legal_registration_scheme_id: "",
  electronic_address: "",
  electronic_address_scheme_id: "",
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
    iban: partner.iban ?? "",
    bic: partner.bic ?? "",
    vat_identifier: partner.vat_identifier ?? "",
    legal_registration_id: partner.legal_registration_id ?? "",
    legal_registration_scheme_id: partner.legal_registration_scheme_id ?? "",
    electronic_address: partner.electronic_address ?? "",
    electronic_address_scheme_id: partner.electronic_address_scheme_id ?? "",
  };
}

/**
 * Kanonický tvar IBAN/BIC podľa ISO 13616 / ISO 9362: bez medzier a
 * oddeľovačov, veľkými písmenami. Kontrolné číslice sa ZÁMERNE neoverujú a
 * existencia účtu sa neoveruje — to je vec platobnej vrstvy, nie evidencie.
 * Rovnaká normalizácia ako CHECK v migrácii 20260921160000.
 */
function normalizePaymentIdentifier(value: string): string | null {
  const normalized = value.replace(/[\s\-]/g, "").toUpperCase();
  return normalized.length > 0 ? normalized : null;
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

  // Formát presne ako DB CHECK — klient chybu iba vysvetlí skôr. Autoritou
  // ostáva databáza (§15 zadania: redesign nemení security/validation
  // authority).
  const iban = normalizePaymentIdentifier(form.iban);
  if (iban !== null && !/^[A-Z0-9]{5,34}$/.test(iban)) {
    errors.push({ field: "iban", messageKey: "invalidIban" });
  }

  const bic = normalizePaymentIdentifier(form.bic);
  if (bic !== null && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic)) {
    errors.push({ field: "bic", messageKey: "invalidBic" });
  }

  // Elektronická adresa a jej schéma majú zmysel iba spolu: samotné "SK12345"
  // bez EAS kódu nie je adresovateľné a samotná schéma bez hodnoty neznamená
  // nič. Preto sa vyžadujú obe, alebo žiadna.
  const electronicAddress = emptyToNull(form.electronic_address);
  const electronicAddressScheme = emptyToNull(form.electronic_address_scheme_id);
  if (electronicAddress !== null && electronicAddressScheme === null) {
    errors.push({
      field: "electronic_address_scheme_id",
      messageKey: "schemeRequiredWithValue",
    });
  }
  if (electronicAddressScheme !== null && electronicAddress === null) {
    errors.push({ field: "electronic_address", messageKey: "valueRequiredWithScheme" });
  }

  const legalRegistrationId = emptyToNull(form.legal_registration_id);
  const legalRegistrationScheme = emptyToNull(form.legal_registration_scheme_id);
  if (legalRegistrationId !== null && legalRegistrationScheme === null) {
    errors.push({
      field: "legal_registration_scheme_id",
      messageKey: "schemeRequiredWithValue",
    });
  }
  if (legalRegistrationScheme !== null && legalRegistrationId === null) {
    errors.push({ field: "legal_registration_id", messageKey: "valueRequiredWithScheme" });
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
      iban,
      bic,
      vat_identifier: emptyToNull(form.vat_identifier),
      legal_registration_id: legalRegistrationId,
      legal_registration_scheme_id: legalRegistrationScheme,
      electronic_address: electronicAddress,
      electronic_address_scheme_id: electronicAddressScheme,
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

/**
 * Polia, ktoré smie priniesť Inbox review pri zakladaní nového dodávateľa.
 * Zámerne užší set než celý partner form — ide VÝHRADNE o hodnoty, ktoré
 * používateľ v review obrazovke videl a potvrdil. Nič iné sa nedopĺňa.
 */
export type SupplierFromReviewInput = {
  legal_name: string;
  ico: string | null;
  dic: string | null;
  ic_dph: string | null;
  vat_identifier: string | null;
  address_line1: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  email: string | null;
};

/**
 * Založí dodávateľa z potvrdeného review.
 *
 * `kind` je 'supplier'. Ak partner s rovnakým IČO už existuje, DB unique
 * constraint to zachytí a funkcia vyhodí BUSINESS_PARTNER_DUPLICATE_ICO_ERROR
 * — volajúci to MUSÍ ošetriť tak, že ponúkne existujúceho partnera, nikdy nie
 * tichým vytvorením druhého záznamu. Deterministický pre-check robí
 * findDeterministicDuplicate() v lib/invoicing/supplier-matching.ts; tento
 * constraint je druhá, nezávislá poistka proti race condition.
 */
export async function createSupplierFromReview(
  companyId: string,
  userId: string,
  input: SupplierFromReviewInput
): Promise<BusinessPartner> {
  const { data, error } = await supabase
    .from("business_partners")
    .insert({
      company_id: companyId,
      kind: "supplier" as BusinessPartnerKind,
      legal_name: input.legal_name.trim(),
      ico: emptyToNull(input.ico ?? ""),
      dic: emptyToNull(input.dic ?? ""),
      ic_dph: emptyToNull(input.ic_dph ?? ""),
      vat_identifier: emptyToNull(input.vat_identifier ?? input.ic_dph ?? ""),
      address_line1: emptyToNull(input.address_line1 ?? ""),
      city: emptyToNull(input.city ?? ""),
      postal_code: emptyToNull(input.postal_code ?? ""),
      country_code: emptyToNull(input.country_code ?? ""),
      email: emptyToNull(input.email ?? ""),
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

export async function deleteBusinessPartner(id: string): Promise<void> {
  const { error } = await supabase.from("business_partners").delete().eq("id", id);

  if (error) {
    throw error;
  }
}
