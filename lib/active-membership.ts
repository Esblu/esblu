// =============================================================================
// Aktívne členstvo prihláseného používateľa — multi-company 2026-10-12.
//
// Zdroj pravdy: DB RPC esblu_my_active_membership() (aktívna firma = platná
// uložená voľba alebo jediné členstvo; pri 2+ bez voľby nič → výber firmy).
// Funguje s klientom prehliadača aj s user-scoped klientom na serveri (RLS +
// auth.uid() z JWT). Nikdy `.maybeSingle()` nad company_members.
// Fallback, kým migrácia 20261012140000 nie je v DB: max 1 aktívne členstvo.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type ActiveMembershipRow = {
  company_id: string;
  role: "owner" | "admin" | "accountant" | "employee";
  permissions: unknown;
  company_name: string | null;
};

type PgError = { code?: string | null; message?: string | null } | null;

function isMissingFunction(error: PgError): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? ""));
}

export async function fetchMyActiveMembership(
  client: SupabaseClient,
  userId: string
): Promise<{ data: ActiveMembershipRow | null; error: PgError }> {
  const { data, error } = await client.rpc("esblu_my_active_membership");
  if (!error) {
    const row = ((data ?? []) as ActiveMembershipRow[])[0];
    return { data: row ? { ...row, permissions: row.permissions ?? {} } : null, error: null };
  }
  if (!isMissingFunction(error)) return { data: null, error };

  const legacy = await client
    .from("company_members")
    .select("company_id, role, permissions")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(2);
  if (legacy.error) return { data: null, error: legacy.error };
  const rows = (legacy.data ?? []) as Array<Omit<ActiveMembershipRow, "company_name">>;
  return { data: rows.length === 1 ? { ...rows[0], permissions: rows[0].permissions ?? {}, company_name: null } : null, error: null };
}
