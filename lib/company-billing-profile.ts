import { supabase } from "@/lib/supabase";

// =============================================================================
// company_billing_profile — jediný living source-of-truth pre firemné/
// fakturačné údaje (Fáza 1B, 20260916120000_add_company_billing_profile_and_
// business_partners.sql). NAHRÁDZA settings.company_name/settings.logo_path
// ako zdroj brandingu — appka tie stĺpce od tejto fázy ďalej nečíta ani
// nezapisuje (zostávajú v DB ako legacy/historické, viď report).
//
// Mutable master data — NIE právny snapshot faktúry. Právny status firmy
// (napr. platiteľ DPH) sa z týchto polí NIKDY neodvodzuje — ic_dph je presne
// to, čo používateľ sám zadal, nič viac.
// =============================================================================

export type CompanyBillingProfile = {
  company_id: string;
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
  default_due_days: number | null;
  default_currency: string | null;
  default_vat_rate: number | null;
  invoice_numbering_prefix: string | null;
  logo_path: string | null;
  // EN16931 / Peppol (20260920122000 + 20261001110000). Scheme ID sa
  // NIKDY nedopĺňa automaticky — zadáva ho používateľ podľa poskytovateľa.
  electronic_address: string | null;
  electronic_address_scheme_id: string | null;
  legal_registration_id: string | null;
  legal_registration_scheme_id: string | null;
  vat_identifier: string | null;
  vat_payer_status: "vat_payer" | "non_vat_payer" | null;
  created_at: string;
  updated_at: string | null;
  updated_by: string | null;
};

export const EMPTY_COMPANY_BILLING_PROFILE_FORM = {
  legal_name: "",
  ico: "",
  dic: "",
  ic_dph: "",
  address_line1: "",
  address_line2: "",
  city: "",
  postal_code: "",
  country_code: "",
  iban: "",
  bic: "",
  contact_email: "",
  default_due_days: "",
  default_currency: "",
  default_vat_rate: "",
  invoice_numbering_prefix: "",
  electronic_address: "",
  electronic_address_scheme_id: "",
  legal_registration_id: "",
  legal_registration_scheme_id: "",
  vat_identifier: "",
  vat_payer_status: "" as "" | "vat_payer" | "non_vat_payer",
};

export type CompanyBillingProfileForm = typeof EMPTY_COMPANY_BILLING_PROFILE_FORM;

export function billingProfileToForm(
  profile: CompanyBillingProfile | null
): CompanyBillingProfileForm {
  if (!profile) {
    return { ...EMPTY_COMPANY_BILLING_PROFILE_FORM };
  }

  return {
    legal_name: profile.legal_name ?? "",
    ico: profile.ico ?? "",
    dic: profile.dic ?? "",
    ic_dph: profile.ic_dph ?? "",
    address_line1: profile.address_line1 ?? "",
    address_line2: profile.address_line2 ?? "",
    city: profile.city ?? "",
    postal_code: profile.postal_code ?? "",
    country_code: profile.country_code ?? "",
    iban: profile.iban ?? "",
    bic: profile.bic ?? "",
    contact_email: profile.contact_email ?? "",
    default_due_days:
      profile.default_due_days === null ? "" : String(profile.default_due_days),
    default_currency: profile.default_currency ?? "",
    default_vat_rate:
      profile.default_vat_rate === null ? "" : String(profile.default_vat_rate),
    invoice_numbering_prefix: profile.invoice_numbering_prefix ?? "",
    electronic_address: profile.electronic_address ?? "",
    electronic_address_scheme_id: profile.electronic_address_scheme_id ?? "",
    legal_registration_id: profile.legal_registration_id ?? "",
    legal_registration_scheme_id: profile.legal_registration_scheme_id ?? "",
    vat_identifier: profile.vat_identifier ?? "",
    vat_payer_status: profile.vat_payer_status ?? "",
  };
}

/**
 * Načíta company_billing_profile riadok AKTÍVNEJ firmy prihláseného
 * používateľa. RLS (company_billing_profile_select_company) povoľuje
 * ktoréhokoľvek aktívneho člena firmy — owner/admin/employee rovnako.
 * Vracia null, ak riadok ešte neexistuje (nemalo by nastať pre firmu
 * založenú po tejto migrácii — bootstrap aj backfill ho vytvárajú vždy —
 * ale appka sa musí správať bezpečne aj v tomto hraničnom prípade).
 */
export async function getCompanyBillingProfile(
  companyId: string
): Promise<CompanyBillingProfile | null> {
  const { data, error } = await supabase
    .from("company_billing_profile")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as CompanyBillingProfile) ?? null;
}

// Prázdny string vo formulári => null v DB ("prázdna hodnota = null",
// zadanie bod 3/9). Trim je tu iba posledná poistka — normalizácia
// jednotlivých polí (ico/dic/ic_dph/iban/bic/krajina/mena) prebieha vo
// validate*/normalize* funkciách nižšie PRED zavolaním tejto funkcie.
function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type CompanyBillingProfileValidationError = {
  field: keyof CompanyBillingProfileForm;
  messageKey: string;
};

const IBAN_FORMAT = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/;
const BIC_FORMAT = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCHEME_ID_FORMAT = /^[0-9]{4}$/;

/**
 * IBAN mod-97 kontrolný súčet (ISO 13616 / ECBS). Spracováva string po
 * znakoch namiesto BigInt-u nad celým prevedeným číslom (IBAN po prevode
 * písmen na čísla môže mať vyše 30 číslic — bežné number by stratilo
 * presnosť, BigInt by fungoval tiež, ale znakový mod-97 je rovnako presný
 * a nevyžaduje BigInt polyfill).
 */
function ibanMod97(rearranged: string): number {
  let remainder = 0;

  for (const char of rearranged) {
    const digitValue = /[0-9]/.test(char)
      ? char
      : String(char.charCodeAt(0) - 55); // A=10 ... Z=35

    for (const digitChar of digitValue) {
      remainder = (remainder * 10 + Number(digitChar)) % 97;
    }
  }

  return remainder;
}

export function normalizeAndValidateIban(
  rawValue: string
): { value: string | null; valid: true } | { value: string; valid: false } {
  const trimmed = rawValue.trim();

  if (trimmed.length === 0) {
    return { value: null, valid: true };
  }

  const normalized = trimmed.toUpperCase().replace(/\s+/g, "");

  if (!IBAN_FORMAT.test(normalized) || normalized.length < 15 || normalized.length > 34) {
    return { value: normalized, valid: false };
  }

  const rearranged = normalized.slice(4) + normalized.slice(0, 4);

  if (ibanMod97(rearranged) !== 1) {
    return { value: normalized, valid: false };
  }

  return { value: normalized, valid: true };
}

export function normalizeAndValidateBic(
  rawValue: string
): { value: string | null; valid: true } | { value: string; valid: false } {
  const trimmed = rawValue.trim();

  if (trimmed.length === 0) {
    return { value: null, valid: true };
  }

  const normalized = trimmed.toUpperCase().replace(/\s+/g, "");

  if (!BIC_FORMAT.test(normalized)) {
    return { value: normalized, valid: false };
  }

  return { value: normalized, valid: true };
}

export function validateEmailFormat(rawValue: string): boolean {
  const trimmed = rawValue.trim();
  return trimmed.length === 0 || EMAIL_FORMAT.test(trimmed);
}

export function normalizeCountryCode(rawValue: string): string | null {
  const trimmed = rawValue.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCurrencyCode(rawValue: string): string | null {
  const trimmed = rawValue.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalInt(rawValue: string): number | null | "invalid" {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  return Number(trimmed);
}

function parseOptionalDecimal(rawValue: string): number | null | "invalid" {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return "invalid";
  return Number(normalized);
}

/**
 * Validuje CELÝ formulár na klientovi PRED odoslaním (rovnaké pravidlá ako
 * DB CHECK constraints — DB ostáva fail-closed poistka, toto je UX vrstva
 * so zrozumiteľnými chybami pri konkrétnom poli). Vracia buď zoznam chýb
 * (prázdny formulár je vždy platný — "prázdna hodnota = null"), alebo
 * pripravený DB payload.
 */
export function validateCompanyBillingProfileForm(
  form: CompanyBillingProfileForm
): { errors: CompanyBillingProfileValidationError[]; payload: null } | {
  errors: [];
  payload: Omit<
    CompanyBillingProfile,
    "company_id" | "created_at" | "updated_at" | "updated_by" | "logo_path"
  >;
} {
  const errors: CompanyBillingProfileValidationError[] = [];

  const legalName = emptyToNull(form.legal_name);

  const countryCode = normalizeCountryCode(form.country_code);
  if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
    errors.push({ field: "country_code", messageKey: "invalidCountryCode" });
  }

  const currency = normalizeCurrencyCode(form.default_currency);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    errors.push({ field: "default_currency", messageKey: "invalidCurrency" });
  }

  const dueDays = parseOptionalInt(form.default_due_days);
  if (dueDays === "invalid" || (typeof dueDays === "number" && (dueDays < 0 || dueDays > 365))) {
    errors.push({ field: "default_due_days", messageKey: "invalidDueDays" });
  }

  const vatRate = parseOptionalDecimal(form.default_vat_rate);
  if (vatRate === "invalid" || (typeof vatRate === "number" && (vatRate < 0 || vatRate > 100))) {
    errors.push({ field: "default_vat_rate", messageKey: "invalidVatRate" });
  }

  const iban = normalizeAndValidateIban(form.iban);
  if (!iban.valid) {
    errors.push({ field: "iban", messageKey: "invalidIban" });
  }

  const bic = normalizeAndValidateBic(form.bic);
  if (!bic.valid) {
    errors.push({ field: "bic", messageKey: "invalidBic" });
  }

  if (!validateEmailFormat(form.contact_email)) {
    errors.push({ field: "contact_email", messageKey: "invalidEmail" });
  }

  // EN16931 identifikátory — páry zodpovedajú DB CHECK *_pair constraintom.
  // Scheme ID je 4-miestny kód (EAS / ICD); ktorý konkrétny kód použiť,
  // Esblu nehádá.
  const electronicAddress = emptyToNull(form.electronic_address);
  const electronicAddressScheme = emptyToNull(form.electronic_address_scheme_id);
  if ((electronicAddress === null) !== (electronicAddressScheme === null)) {
    errors.push({
      field: electronicAddress === null ? "electronic_address" : "electronic_address_scheme_id",
      messageKey: "electronicAddressPairRequired",
    });
  } else if (electronicAddressScheme !== null && !SCHEME_ID_FORMAT.test(electronicAddressScheme)) {
    errors.push({ field: "electronic_address_scheme_id", messageKey: "invalidSchemeId" });
  }

  const legalRegistration = emptyToNull(form.legal_registration_id);
  const legalRegistrationScheme = emptyToNull(form.legal_registration_scheme_id);
  if ((legalRegistration === null) !== (legalRegistrationScheme === null)) {
    errors.push({
      field: legalRegistration === null ? "legal_registration_id" : "legal_registration_scheme_id",
      messageKey: "legalRegistrationPairRequired",
    });
  } else if (legalRegistrationScheme !== null && !SCHEME_ID_FORMAT.test(legalRegistrationScheme)) {
    errors.push({ field: "legal_registration_scheme_id", messageKey: "invalidSchemeId" });
  }

  const vatIdentifier = emptyToNull(form.vat_identifier);
  const vatPayerStatus = form.vat_payer_status === "" ? null : form.vat_payer_status;
  if (vatPayerStatus === "vat_payer" && vatIdentifier === null && emptyToNull(form.ic_dph) === null) {
    errors.push({ field: "vat_payer_status", messageKey: "vatPayerWithoutVatId" });
  }

  if (errors.length > 0) {
    return { errors, payload: null };
  }

  return {
    errors: [],
    payload: {
      legal_name: legalName,
      ico: emptyToNull(form.ico),
      dic: emptyToNull(form.dic),
      ic_dph: emptyToNull(form.ic_dph),
      address_line1: emptyToNull(form.address_line1),
      address_line2: emptyToNull(form.address_line2),
      city: emptyToNull(form.city),
      postal_code: emptyToNull(form.postal_code),
      country_code: countryCode,
      iban: iban.valid ? iban.value : null,
      bic: bic.valid ? bic.value : null,
      contact_email: emptyToNull(form.contact_email),
      default_due_days: dueDays === "invalid" ? null : dueDays,
      default_currency: currency,
      default_vat_rate: vatRate === "invalid" ? null : vatRate,
      invoice_numbering_prefix: emptyToNull(form.invoice_numbering_prefix),
      electronic_address: electronicAddress,
      electronic_address_scheme_id: electronicAddressScheme,
      legal_registration_id: legalRegistration,
      legal_registration_scheme_id: legalRegistrationScheme,
      vat_identifier: vatIdentifier,
      vat_payer_status: vatPayerStatus,
    },
  };
}

/**
 * Upsert (INSERT ... ON CONFLICT (company_id) DO UPDATE) — company_id je
 * PRIMARY KEY, takže upsert je tu prirodzený a bezpečný. RLS
 * (company_billing_profile_insert_owner_admin /
 * ..._update_owner_admin) vynucuje owner/admin na oboch vetvách rovnako,
 * takže upsert sa správa korektne bez ohľadu na to, či riadok už existuje
 * (v praxi vždy existuje — bootstrap aj backfill ho garantujú — toto je iba
 * obranná poistka). logoPath sa odovzdáva samostatne (undefined = nemeniť,
 * pozri deleteLogo()/handleLogoChange() v Nastaveniach), aby uloženie
 * textových polí nikdy neprepísalo logo_path na null.
 */
export async function upsertCompanyBillingProfile(
  companyId: string,
  userId: string,
  // iban/bic sú voliteľné: ne-owner ich neposiela (bankové údaje mení iba
  // majiteľ — DB trigger esblu_guard_company_bank_details).
  payload: Omit<
    CompanyBillingProfile,
    "company_id" | "created_at" | "updated_at" | "updated_by" | "logo_path" | "iban" | "bic"
  > & Partial<Pick<CompanyBillingProfile, "iban" | "bic">>,
  logoPath?: string | null
): Promise<void> {
  const row: Record<string, unknown> = {
    company_id: companyId,
    ...payload,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };

  if (logoPath !== undefined) {
    row.logo_path = logoPath;
  }

  const { error } = await supabase
    .from("company_billing_profile")
    .upsert(row, { onConflict: "company_id" });

  if (error) {
    throw error;
  }
}

/**
 * Iba logo_path — používa deleteLogo()/handleLogoChange() v Nastaveniach
 * (rovnaký retry-kompenzačný vzor ako predtým pri settings.logo_path,
 * commit 9cd7542 — pozri saveLogoPathToDatabaseWithRetry v
 * app/nastavenia/page.tsx). Samostatná funkcia namiesto
 * upsertCompanyBillingProfile() s prázdnym textovým payloadom, aby zápis
 * loga NIKDY netýkal/nevynuloval ostatné, práve rozeditované textové polia
 * profilu.
 */
export async function saveCompanyBillingProfileLogoPath(
  companyId: string,
  userId: string,
  logoPath: string | null
): Promise<void> {
  const { error } = await supabase
    .from("company_billing_profile")
    .upsert(
      {
        company_id: companyId,
        logo_path: logoPath,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id" }
    );

  if (error) {
    throw error;
  }
}
