import { supabase } from "@/lib/supabase";
import { currentDisplayLocale } from "@/lib/legal-acceptance";

export type CompanyDpaStatus = {
  company_id: string;
  current_dpa_version: string;
  has_current_acceptance: boolean;
  accepted_at: string | null;
  my_role: "owner" | "admin" | "accountant" | "employee";
};

/**
 * Stav company-level DPA acceptance pre AKTÍVNU firmu prihláseného
 * používateľa (owner/admin/employee rovnako). Volá
 * public.esblu_get_my_company_dpa_status()
 * (supabase/migrations/20260816090000_add_company_dpa_acceptance.sql).
 * Vracia null, ak volajúci nie je prihlásený, nemá aktívny membership,
 * alebo ešte nebola aplikovaná príslušná migrácia — appka sa v tomto
 * prípade správa, akoby nebolo treba nič zobraziť (neblokuje naslepo).
 */
export async function getMyCompanyDpaStatus(): Promise<CompanyDpaStatus | null> {
  const { data, error } = await supabase.rpc("esblu_get_my_company_dpa_status");

  if (error) {
    console.error("getMyCompanyDpaStatus zlyhalo:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return (row as CompanyDpaStatus) ?? null;
}

/**
 * Zapíše company-level DPA acceptance V MENE AKTÍVNEJ FIRMY prihláseného
 * používateľa. Server-side (esblu_accept_company_dpa) vyžaduje, aby
 * volajúci bol AKTÍVNY OWNER danej firmy (nie admin, nie employee —
 * appková rola admin nezakladá právne oprávnenie uzatvárať zmluvy za
 * firmu, pozri revíznu poznámku v
 * supabase/migrations/20260816090000_add_company_dpa_acceptance.sql) —
 * pre admina aj employee vráti chybu ESBLU_NOT_ACTIVE_OWNER a appka to
 * nemá tichcky prehltnúť (pozri getAcceptCompanyDpaErrorMessage nižšie).
 */
export async function acceptCompanyDpa(version: string, authorityConfirmed: boolean): Promise<boolean> {
  // J10.1 (CLIA 11.11.2026): elektronické uzatvorenie DPA — server eviduje
  // osobu, rolu, výslovné vyhlásenie o oprávnení, verziu + hash, čas, jazyk.
  const { error } = await supabase.rpc("esblu_accept_company_dpa", {
    p_version: version,
    p_authority_confirmed: authorityConfirmed,
    p_locale: currentDisplayLocale(),
  });

  if (error) {
    console.error("acceptCompanyDpa zlyhalo:", error.message);
    return false;
  }

  return true;
}

// Kódy chýb vracané esblu_accept_company_dpa() — texty pre používateľa
// poskytuje volajúca stránka cez i18n kľúč
// companyDpaGate.errors.<code> (pozri getAcceptCompanyDpaErrorMessage
// nižšie), tento modul nesmie renderovať pevný slovenský text.
// ESBLU_NOT_CURRENT_DPA_VERSION / ESBLU_NO_CURRENT_DPA: pridané v
// hardeningu esblu_accept_company_dpa() (piate kolo,
// supabase/migrations/20260816090000_add_company_dpa_acceptance.sql) —
// RPC si aktuálnu účinnú DPA verziu (effective_at <= now()) zisťuje
// sama, p_version musí byť presne táto verzia. Nahradili
// ESBLU_UNKNOWN_LEGAL_DOCUMENT_VERSION, ktorý RPC už nevracia a ktorý
// nikde inde v appke nebol používaný.
const ACCEPT_COMPANY_DPA_ERROR_CODES = [
  "ESBLU_NOT_ACTIVE_OWNER",
  "ESBLU_NO_ACTIVE_MEMBERSHIP",
  "ESBLU_NOT_CURRENT_DPA_VERSION",
  "ESBLU_DPA_AUTHORITY_NOT_CONFIRMED",
  "ESBLU_NO_CURRENT_DPA",
  "ESBLU_COMPANY_TERMS_NOT_ACCEPTED",
  "NOT_AUTHENTICATED",
] as const;

/**
 * "Legal-hold" správa pre UI vrstvu (CompanyDpaGate.tsx exportuje
 * useCompanyDpaLegalHold(); jednotlivé stránky s vytváraním nových
 * business záznamov — vozidlá, stroje, sklad, AI evidencia — ju použijú
 * na deaktiváciu/skrytie akcií, ktoré by DB BEFORE INSERT trigger
 * (esblu_require_company_dpa_before_insert,
 * 20260816090000_add_company_dpa_acceptance.sql) aj tak odmietol s
 * ESBLU_COMPANY_DPA_NOT_ACCEPTED. Táto UI vrstva je iba pomocná/UX —
 * hlavnou ochranou zostáva DB trigger. Text poskytuje volajúca stránka
 * cez i18n kľúč common.legalHoldMessage (t("common.legalHoldMessage")).
 */
export function getAcceptCompanyDpaErrorMessage(
  error: unknown,
  t: (key: string) => string
): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  for (const code of ACCEPT_COMPANY_DPA_ERROR_CODES) {
    if (text.includes(code)) {
      return t(`companyDpaGate.errors.${code}`);
    }
  }

  return t("companyDpaGate.errors.generic");
}

// ---------------------------------------------------------------------------
// B2B VOP 1.2 — firemné prijatie Všeobecných obchodných podmienok (VOP čl. 8).
// Rovnaká evidencia ako DPA (company_dpa_acceptances, document_type 'terms'),
// žiadny paralelný systém. Server: esblu_accept_company_terms /
// esblu_get_my_company_terms_status
// (supabase/migrations/20261112100000_b2b_terms_1_2_company_acceptance.sql).
// ---------------------------------------------------------------------------
export type CompanyTermsStatus = {
  company_id: string;
  current_terms_version: string;
  has_current_acceptance: boolean;
  accepted_at: string | null;
  my_role: "owner" | "admin" | "accountant" | "employee";
  /** VOP 39.2 / 44.5: do kedy môže existujúca firma novú verziu prijať (null = povinné hneď). */
  grace_until: string | null;
  /** true = prijatie je už povinné (nová firma alebo uplynutá lehota). */
  required_now: boolean;
  /** Údaje firmy na kontrolu pred odoslaním (22/2004 § 5, VOP 8.2). */
  company_name: string | null;
  company_registration_id: string | null;
  /** VOP 39.2 / 44.5: existujúca firma — lehota beží od preukázateľného oznámenia. */
  needs_notice?: boolean;
  notified_at?: string | null;
};

/**
 * VOP 39.2 / 44.5: zaznamená preukázateľné in-app oznámenie novej verzie VOP
 * Vlastníkovi existujúcej firmy (company_terms_notices). Lehota 30 dní beží od
 * tohto okamihu. Opakované volanie lehotu neposúva.
 */
export async function recordCompanyTermsNotice(): Promise<{ notified_at: string; grace_until: string } | null> {
  const { data, error } = await supabase.rpc("esblu_record_company_terms_notice");
  if (error) {
    console.error("recordCompanyTermsNotice zlyhalo:", error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { notified_at?: string | null; grace_until?: string | null } | null;
  return row?.notified_at && row.grace_until ? { notified_at: row.notified_at, grace_until: row.grace_until } : null;
}

/** Záznam firemného prijatia (VOP 8.3 / 8.5) — potvrdenie zobrazené v appke. */
export type CompanyLegalAcceptanceRecord = {
  document_type: "terms" | "dpa";
  version: string;
  accepted_at: string;
  accepted_role: string | null;
  acceptance_method: string;
  authority_confirmed: boolean | null;
  b2b_confirmed: boolean | null;
  document_content_hash: string | null;
  display_locale: string | null;
  company_name_snapshot: string | null;
  company_registration_id_snapshot: string | null;
};

const ACCEPTANCE_RECORD_COLUMNS =
  "document_type, version, accepted_at, accepted_role, acceptance_method, authority_confirmed, b2b_confirmed, document_content_hash, display_locale, company_name_snapshot, company_registration_id_snapshot";

/**
 * VOP 8.3 / 8.5: záznamy firemného prijatia VOP a DPA aktívnej firmy (RLS:
 * iba aktívni členovia firmy). Zobrazujú sa v Nastaveniach ako trvalé
 * potvrdenie uzatvorenia.
 */
export async function listCompanyLegalAcceptances(companyId: string): Promise<CompanyLegalAcceptanceRecord[]> {
  const { data, error } = await supabase
    .from("company_dpa_acceptances")
    .select(ACCEPTANCE_RECORD_COLUMNS)
    .eq("company_id", companyId)
    .order("accepted_at", { ascending: false });

  if (error) {
    console.error("listCompanyLegalAcceptances zlyhalo:", error.message);
    return [];
  }

  return (data ?? []) as CompanyLegalAcceptanceRecord[];
}

/** Stav firemného prijatia aktuálnych VOP; null = nič neblokovať (bez session / migrácie). */
export async function getMyCompanyTermsStatus(): Promise<CompanyTermsStatus | null> {
  const { data, error } = await supabase.rpc("esblu_get_my_company_terms_status");

  if (error) {
    console.error("getMyCompanyTermsStatus zlyhalo:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return (row as CompanyTermsStatus) ?? null;
}

/**
 * Owner aktívnej firmy prijíma VOP v mene Zákazníka: vyhlásenie o B2B
 * charaktere (VOP 4.3) + o oprávnení konať za Zákazníka (VOP 6.1). Server
 * eviduje osobu, rolu, verziu + hash, čas, jazyk a identitu firmy.
 */
export async function acceptCompanyTerms(
  version: string,
  b2bConfirmed: boolean,
  authorityConfirmed: boolean
): Promise<{ ok: true; record: CompanyLegalAcceptanceRecord | null } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("esblu_accept_company_terms", {
    p_version: version,
    p_b2b_confirmed: b2bConfirmed,
    p_authority_confirmed: authorityConfirmed,
    p_locale: currentDisplayLocale(),
  });

  if (error) {
    console.error("acceptCompanyTerms zlyhalo:", error.message);
    return { ok: false, error: error.message };
  }

  // VOP 8.5: RPC vracia zaznamenaný riadok → okamžité potvrdenie v appke.
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, record: (row as CompanyLegalAcceptanceRecord) ?? null };
}

export const ACCEPT_COMPANY_TERMS_ERROR_CODES = [
  "ESBLU_NOT_ACTIVE_OWNER",
  "ESBLU_NO_ACTIVE_MEMBERSHIP",
  "ESBLU_TERMS_B2B_NOT_CONFIRMED",
  "ESBLU_TERMS_AUTHORITY_NOT_CONFIRMED",
  "ESBLU_NOT_CURRENT_TERMS_VERSION",
  "ESBLU_NO_CURRENT_TERMS",
  "NOT_AUTHENTICATED",
] as const;

export function getAcceptCompanyTermsErrorMessage(
  error: string,
  t: (key: string) => string
): string {
  for (const code of ACCEPT_COMPANY_TERMS_ERROR_CODES) {
    if (error.includes(code)) {
      return t(`companyTermsGate.errors.${code}`);
    }
  }
  return t("companyTermsGate.errors.generic");
}
