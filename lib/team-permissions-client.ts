// =============================================================================
// Efektívne oprávnenia prihláseného člena v AKTÍVNEJ firme (iba pre UI).
// Autoritou je databáza (RLS/RPC); toto len rozhoduje, ktoré tlačidlá ukázať.
// =============================================================================
import { supabase } from "@/lib/supabase";
import { isTeamPermission, type TeamPermission } from "@/lib/team-permissions";

/**
 * Množina z esblu_my_permissions(). `null` = server oprávnenia nevrátil
 * (napr. databáza ešte bez migrácie 20261023100000) — volajúci potom použije
 * iba rolu, teda správanie pred granulárnymi oprávneniami (nikdy viac).
 */
export async function getMyPermissions(): Promise<Set<TeamPermission> | null> {
  const { data, error } = await supabase.rpc("esblu_my_permissions");
  if (error || !Array.isArray(data)) return null;
  return new Set((data as unknown[]).filter(isTeamPermission));
}

export type MemberPermissionRow = { member_id: string; permission: string };

export async function listCompanyMemberPermissions(): Promise<MemberPermissionRow[]> {
  const { data, error } = await supabase.rpc("esblu_list_company_member_permissions");
  if (error) throw error;
  return (data as MemberPermissionRow[]) ?? [];
}

export async function setMemberPermissions(memberId: string, permissions: string[]): Promise<string[]> {
  const { data, error } = await supabase.rpc("esblu_set_member_permissions", {
    p_member_id: memberId,
    p_permissions: permissions,
  });
  if (error) throw error;
  return (data as string[]) ?? [];
}

/** Používateľská správa pre chybu RPC (kód z DB → i18n kľúč). */
export function memberPermissionErrorKey(error: unknown): string {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  if (message.includes("ESBLU_CANNOT_EDIT_OWN_PERMISSIONS")) return "settings.permissions.errors.own";
  if (message.includes("ESBLU_PERMISSIONS_EMPLOYEE_ONLY")) return "settings.permissions.errors.employeeOnly";
  if (message.includes("ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN")) return "settings.permissions.errors.forbidden";
  if (message.includes("ESBLU_PERMISSION_OWNER_ONLY")) return "settings.permissions.errors.ownerOnly";
  if (message.includes("ESBLU_MEMBER_NOT_FOUND") || message.includes("ESBLU_MEMBER_NOT_ACTIVE")) return "settings.permissions.errors.member";
  return "settings.permissions.errors.generic";
}
