import { handleLegalIdentityRequest } from "@/lib/company-legal-identity/handler";
import { companyLookupService } from "@/lib/company-lookup/server";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { bearerToken } from "@/lib/request-session";
import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/company/legal-identity   { ico, country? = "SK" }
//
// Owner AKTÍVNEJ firmy (tejto session) overí IČO v registri RPO. Až po úspechu
// service role zapíše overenú identitu (esblu_record_company_legal_identity)
// a DB rozhodne o triale podľa histórie subjektu (trial_claims). Zlyhanie
// registra = esblu_record_company_legal_identity_attempt (žiadny trial, žiadna
// vymyslená identita). Logika: lib/company-legal-identity/handler.ts.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const db = getUserScopedSupabaseClient(bearerToken(req));
  const admin = getSupabaseAdmin();

  return handleLegalIdentityRequest(body, {
    verifyUser: async () => {
      const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
      return error || !user ? null : { id: user.id };
    },
    activeMembership: async () => {
      // aktívna firma a rola z DB pre TÚTO session (user-scoped JWT so session_id)
      const { data, error } = await db.rpc("esblu_my_active_membership");
      if (error) return "error";
      const row = ((data ?? []) as Array<{ company_id: string; role: string }>)[0];
      return row?.company_id ? { companyId: row.company_id, role: row.role } : null;
    },
    consumeRateLimit: (userId, companyId) => companyLookupService.consumeRateLimit(userId, companyId),
    lookup: (ico) => companyLookupService.detail(ico),
    recordVerified: async (companyId, country, registrationId) =>
      admin.rpc("esblu_record_company_legal_identity", {
        p_company_id: companyId,
        p_country: country,
        p_registration_id: registrationId,
        p_verified: true,
        p_source: "registry:rpo",
      }),
    recordAttempt: async (companyId, country, registrationId, outcome) =>
      admin.rpc("esblu_record_company_legal_identity_attempt", {
        p_company_id: companyId,
        p_country: country,
        p_registration_id: registrationId,
        p_outcome: outcome,
      }),
    log: (message) => console.error(message),
  });
}
