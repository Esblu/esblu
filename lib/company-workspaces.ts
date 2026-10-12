// =============================================================================
// Firmy (workspaces) prihláseného používateľa — klient (multi-company 2026-10-12).
//
// - Zoznam / prepnutie / nová firma idú VÝHRADNE cez SECURITY DEFINER RPC;
//   server overí členstvo (cudzie company_id → ESBLU_NOT_A_MEMBER).
// - Aktívna firma je PER ZARIADENIE / SESSION na serveri (session_active_company,
//   20261012150000): prepnutie na mobile nemení desktop. Zariadenie si navyše
//   pamätá poslednú voľbu (lib/company-preference.ts) iba ako návrh pre
//   ďalšie prihlásenie — server ho znova overí. Nie je to autorizácia.
// - Po prepnutí: vyčistia sa klientske cache (nároky, členstvo) a appka sa
//   načíta nanovo (plný reload) → žiadny stale obsah, realtime listenery
//   predchádzajúcej firmy ani cache z inej firmy (correctness > micro-opt).
// =============================================================================

import { supabase } from "@/lib/supabase";
import { navigateHard } from "@/lib/app-navigation";
import { apiUrl } from "@/lib/api-url";
import { invalidateCompanyEntitlements } from "@/hooks/use-company-entitlements";
import { resetActiveMembershipCache } from "@/hooks/use-active-membership";
import type { CompanyMemberRole } from "@/lib/company";
import { forgetCompanyPreference, readCompanyPreference, rememberCompanyPreference } from "@/lib/company-preference";

export type MyCompany = {
  company_id: string;
  company_name: string;
  role: CompanyMemberRole;
  is_active: boolean;
};

export class CompanyWorkspaceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function errorCode(error: { message?: string | null } | null): string {
  return /ESBLU_[A-Z_]+/.exec(error?.message ?? "")?.[0] ?? "ESBLU_COMPANY_WORKSPACE_FAILED";
}

export async function listMyCompanies(): Promise<MyCompany[]> {
  const { data, error } = await supabase.rpc("esblu_list_my_companies");
  if (error) throw new CompanyWorkspaceError(errorCode(error));
  return ((data ?? []) as MyCompany[]).map((row) => ({ ...row, is_active: row.is_active === true }));
}

/** Iba po úspechu servera; inak výnimka s kódom (napr. ESBLU_NOT_A_MEMBER). */
export async function setActiveCompany(companyId: string): Promise<void> {
  const { error } = await supabase.rpc("esblu_set_my_active_company", { p_company_id: companyId });
  if (error) throw new CompanyWorkspaceError(errorCode(error));
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

export async function createMyCompany(name: string): Promise<string> {
  const { data, error } = await supabase.rpc("esblu_create_my_company", { p_name: name });
  if (error) throw new CompanyWorkspaceError(errorCode(error));
  const row = ((data ?? []) as Array<{ company_id: string }>)[0];
  if (!row?.company_id) throw new CompanyWorkspaceError("ESBLU_COMPANY_WORKSPACE_FAILED");
  rememberCompanyPreference(await currentUserId(), row.company_id);
  return row.company_id;
}

/**
 * Štart na zariadení bez platnej aktívnej firmy (nové prihlásenie, 2+ firmy):
 * skúsi poslednú voľbu TOHTO zariadenia. true = server ju prijal (treba
 * načítať appku nanovo); false = ukázať výber firmy.
 */
export async function restorePreferredCompany(companies: MyCompany[]): Promise<boolean> {
  const userId = await currentUserId();
  const preferred = readCompanyPreference(userId);
  if (!preferred || !companies.some((company) => company.company_id === preferred)) return false;
  try {
    await setActiveCompany(preferred);
    return true;
  } catch {
    forgetCompanyPreference(userId);
    return false;
  }
}

export type LegalIdentityTrialOutcome = "granted" | "already_has_trial" | "legacy_no_trial" | "pending_legal_identity" | "not_eligible_previous_trial";

/**
 * Owner aktívnej firmy: overenie IČO v registri na serveri. O triale
 * rozhoduje DB podľa histórie právneho subjektu — klient iba zobrazí výsledok.
 */
export async function verifyActiveCompanyLegalIdentity(ico: string): Promise<LegalIdentityTrialOutcome> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CompanyWorkspaceError("ESBLU_SESSION_REQUIRED");
  const response = await fetch(apiUrl("/api/company/legal-identity"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ico }),
  });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; code?: string; trial?: LegalIdentityTrialOutcome };
  if (!response.ok || body.success !== true) throw new CompanyWorkspaceError(body.code ?? "ESBLU_LEGAL_IDENTITY_FAILED");
  return body.trial ?? "pending_legal_identity";
}

export type CompanyLegalIdentity = {
  company_id: string;
  company_name: string | null;
  country_code: string | null;
  registration_id: string | null;
  verification_status: "missing" | "unverified" | "verified" | "manual" | "failed";
  verified_at: string | null;
  last_error: "not_found" | "terminated" | "unavailable" | null;
  trial_status: "eligible" | "not_eligible_previous_trial" | "pending_legal_identity" | "manual_override" | "trial_active" | "trial_used" | "legacy_no_trial";
  trial_ends_at: string | null;
  can_edit: boolean;
};

/** Identita aktívnej firmy pre Nastavenia; null = bez prístupu (zamestnanec) alebo bez firmy. */
export async function loadActiveCompanyLegalIdentity(): Promise<CompanyLegalIdentity | null> {
  const { data, error } = await supabase.rpc("esblu_my_company_legal_identity");
  if (error) {
    const code = errorCode(error);
    if (code === "ESBLU_FORBIDDEN" || code === "ESBLU_NO_ACTIVE_COMPANY") return null;
    throw new CompanyWorkspaceError(code);
  }
  return (data ?? null) as CompanyLegalIdentity | null;
}

/** Vyčistí všetky company-scoped klientske cache (pred reloadom aj pri odchode z firmy). */
export function resetCompanyScopedClientState(): void {
  invalidateCompanyEntitlements();
  resetActiveMembershipCache();
}

/** Prepne firmu na serveri a načíta appku nanovo na danom cieli. */
export async function switchCompanyAndReload(companyId: string, target = "/"): Promise<void> {
  await setActiveCompany(companyId);
  rememberCompanyPreference(await currentUserId(), companyId);
  resetCompanyScopedClientState();
  navigateHard(target);
}

export const WORKSPACE_ERROR_KEYS: Record<string, string> = {
  ESBLU_NOT_A_MEMBER: "workspaces.errors.notMember",
  ESBLU_INVALID_COMPANY_NAME: "workspaces.errors.invalidName",
  ESBLU_DUPLICATE_COMPANY_NAME: "workspaces.errors.duplicateName",
  ESBLU_COMPANY_LIMIT_REACHED: "workspaces.errors.limitReached",
  ESBLU_USE_ONBOARDING: "workspaces.errors.useOnboarding",
  ESBLU_SESSION_REQUIRED: "workspaces.errors.sessionExpired",
  ESBLU_SESSION_MISMATCH: "workspaces.errors.sessionExpired",
  ESBLU_INVALID_REGISTRATION_ID: "workspaces.errors.invalidIco",
  ESBLU_REGISTRY_NOT_FOUND: "workspaces.errors.icoNotFound",
  ESBLU_REGISTRY_ENTITY_TERMINATED: "workspaces.errors.icoTerminated",
  ESBLU_REGISTRY_UNAVAILABLE: "workspaces.errors.registryUnavailable",
  ESBLU_LEGAL_IDENTITY_LOCKED: "workspaces.errors.identityLocked",
  ESBLU_RATE_LIMITED: "workspaces.errors.rateLimited",
  ESBLU_COUNTRY_NOT_SUPPORTED: "workspaces.errors.countryNotSupported",
  ESBLU_NOT_ACTIVE_OWNER: "workspaces.errors.ownerOnly",
};

export function workspaceErrorKey(error: unknown): string {
  const code = error instanceof CompanyWorkspaceError ? error.code : "";
  return WORKSPACE_ERROR_KEYS[code] ?? "workspaces.errors.generic";
}
