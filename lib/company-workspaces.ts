// =============================================================================
// Firmy (workspaces) prihláseného používateľa — klient (multi-company 2026-10-12).
//
// - Zoznam / prepnutie / nová firma idú VÝHRADNE cez SECURITY DEFINER RPC;
//   server overí členstvo (cudzie company_id → ESBLU_NOT_A_MEMBER).
// - Voľba aktívnej firmy je uložená na serveri (user_active_company), klient
//   ju neukladá — nie je to autorizácia, iba preferencia validovaná DB.
// - Po prepnutí: vyčistia sa klientske cache (nároky, členstvo) a appka sa
//   načíta nanovo (plný reload) → žiadny stale obsah, realtime listenery
//   predchádzajúcej firmy ani cache z inej firmy (correctness > micro-opt).
// =============================================================================

import { supabase } from "@/lib/supabase";
import { navigateHard } from "@/lib/app-navigation";
import { invalidateCompanyEntitlements } from "@/hooks/use-company-entitlements";
import { resetActiveMembershipCache } from "@/hooks/use-active-membership";
import type { CompanyMemberRole } from "@/lib/company";

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

export async function createMyCompany(name: string): Promise<string> {
  const { data, error } = await supabase.rpc("esblu_create_my_company", { p_name: name });
  if (error) throw new CompanyWorkspaceError(errorCode(error));
  const row = ((data ?? []) as Array<{ company_id: string }>)[0];
  if (!row?.company_id) throw new CompanyWorkspaceError("ESBLU_COMPANY_WORKSPACE_FAILED");
  return row.company_id;
}

/** Vyčistí všetky company-scoped klientske cache (pred reloadom aj pri odchode z firmy). */
export function resetCompanyScopedClientState(): void {
  invalidateCompanyEntitlements();
  resetActiveMembershipCache();
}

/** Prepne firmu na serveri a načíta appku nanovo na danom cieli. */
export async function switchCompanyAndReload(companyId: string, target = "/"): Promise<void> {
  await setActiveCompany(companyId);
  resetCompanyScopedClientState();
  navigateHard(target);
}

export const WORKSPACE_ERROR_KEYS: Record<string, string> = {
  ESBLU_NOT_A_MEMBER: "workspaces.errors.notMember",
  ESBLU_INVALID_COMPANY_NAME: "workspaces.errors.invalidName",
  ESBLU_DUPLICATE_COMPANY_NAME: "workspaces.errors.duplicateName",
  ESBLU_COMPANY_LIMIT_REACHED: "workspaces.errors.limitReached",
  ESBLU_USE_ONBOARDING: "workspaces.errors.useOnboarding",
};

export function workspaceErrorKey(error: unknown): string {
  const code = error instanceof CompanyWorkspaceError ? error.code : "";
  return WORKSPACE_ERROR_KEYS[code] ?? "workspaces.errors.generic";
}
