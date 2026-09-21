import { supabase } from "@/lib/supabase";

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
export async function acceptCompanyDpa(version: string): Promise<boolean> {
  const { error } = await supabase.rpc("esblu_accept_company_dpa", {
    p_version: version,
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
  "ESBLU_NO_CURRENT_DPA",
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
