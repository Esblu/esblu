// =============================================================================
// Aktívna firma používateľa na SERVERI (service_role) — multi-company 2026-10-12.
//
// Jediný zdroj pravdy je DB funkcia esblu_active_membership_for_user
// (20261012140000): platná uložená voľba (user_active_company) alebo jediné
// aktívne členstvo; pri 2+ členstvách bez platnej voľby žiadna firma (klient
// ukáže výber). Nikdy `.maybeSingle()` nad company_members (pri 2+ riadkoch
// by zlyhalo / vybralo náhodne).
//
// Fallback, kým migrácia nie je v DB: pôvodný model (max 1 aktívne členstvo).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type ServerActiveMembership = {
  companyId: string | null;
  role: "owner" | "admin" | "accountant" | "employee" | null;
  permissions: unknown;
  /** Počet VŠETKÝCH aktívnych členstiev používateľa (0 = bez firmy). */
  activeMembershipCount: number;
};

type PgError = { code?: string | null; message?: string | null } | null;

function isMissingFunction(error: PgError): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? ""));
}

export async function resolveActiveMembershipForUser(
  admin: SupabaseClient,
  userId: string
): Promise<{ data: ServerActiveMembership | null; error: PgError }> {
  const { data, error } = await admin.rpc("esblu_active_membership_for_user", { p_user_id: userId });

  if (!error) {
    const row = ((data ?? []) as Array<{ company_id: string; role: ServerActiveMembership["role"]; permissions: unknown; active_membership_count: number }>)[0];
    if (row) {
      return {
        data: { companyId: row.company_id, role: row.role, permissions: row.permissions ?? {}, activeMembershipCount: Number(row.active_membership_count ?? 1) },
        error: null,
      };
    }
    const { count, error: countError } = await admin
      .from("company_members")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active");
    if (countError) return { data: null, error: countError };
    return { data: { companyId: null, role: null, permissions: {}, activeMembershipCount: count ?? 0 }, error: null };
  }

  if (!isMissingFunction(error)) return { data: null, error };

  // Pred migráciou: unikátny index = max 1 aktívne členstvo.
  const legacy = await admin
    .from("company_members")
    .select("company_id, role, permissions")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(2);
  if (legacy.error) return { data: null, error: legacy.error };
  const rows = (legacy.data ?? []) as Array<{ company_id: string; role: ServerActiveMembership["role"]; permissions: unknown }>;
  if (rows.length !== 1) {
    return { data: { companyId: null, role: null, permissions: {}, activeMembershipCount: rows.length }, error: null };
  }
  return { data: { companyId: rows[0].company_id, role: rows[0].role, permissions: rows[0].permissions ?? {}, activeMembershipCount: 1 }, error: null };
}
