import { canonicalIco } from "@/lib/company-lookup/normalize";
import { companyLookupService } from "@/lib/company-lookup/server";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { bearerToken } from "@/lib/request-session";
import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/company/legal-identity   { ico }
//
// Owner AKTÍVNEJ firmy (tejto session) priradí firme právny subjekt (SK IČO).
// Identita sa NEVYMÝŠĽA: IČO musí existovať v RPO a byť aktívne (overenie
// v registri na serveri). Až potom service role zapíše overenú identitu
// (esblu_record_company_legal_identity) a DB rozhodne o triale podľa histórie
// subjektu (trial_claims). Klient nikdy neposiela „trial áno/nie" ani
// company_id. Register nedostupný → 503, trial ostáva pending (nič sa
// nehádže ako overené).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TrialOutcome = "granted" | "already_has_trial" | "legacy_no_trial" | "pending_legal_identity" | "not_eligible_previous_trial";

export async function POST(req: Request) {
  const { user, error: authError } = await verifyRequestUser(req, getRequestLocale(req));
  if (authError || !user) return Response.json({ success: false, code: "NOT_AUTHENTICATED" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { ico?: unknown } | null;
  const ico = canonicalIco(body?.ico);
  if (!ico) return Response.json({ success: false, code: "ESBLU_INVALID_REGISTRATION_ID" }, { status: 400 });

  // Aktívna firma a rola z DB pre TÚTO session (user-scoped JWT so session_id).
  const db = getUserScopedSupabaseClient(bearerToken(req));
  const { data: membershipRows, error: membershipError } = await db.rpc("esblu_my_active_membership");
  if (membershipError) return Response.json({ success: false, code: "ESBLU_MEMBERSHIP_LOOKUP_FAILED" }, { status: 500 });
  const membership = ((membershipRows ?? []) as Array<{ company_id: string; role: string }>)[0];
  if (!membership?.company_id) return Response.json({ success: false, code: "ESBLU_NO_ACTIVE_COMPANY" }, { status: 409 });
  if (membership.role !== "owner") return Response.json({ success: false, code: "ESBLU_NOT_ACTIVE_OWNER" }, { status: 403 });

  const lookup = await companyLookupService.detail(ico);
  if (!lookup.ok) {
    const status = lookup.status === 404 ? 404 : 503;
    return Response.json({ success: false, code: status === 404 ? "ESBLU_REGISTRY_NOT_FOUND" : "ESBLU_REGISTRY_UNAVAILABLE" }, { status });
  }
  const rpoVerified = lookup.body.sources.some((source) => source.id === "rpo" && source.status === "VERIFIED");
  if (!rpoVerified) return Response.json({ success: false, code: "ESBLU_REGISTRY_UNAVAILABLE" }, { status: 503 });
  if (lookup.body.company.status !== "active") {
    return Response.json({ success: false, code: "ESBLU_REGISTRY_ENTITY_TERMINATED" }, { status: 409 });
  }

  const { data, error } = await getSupabaseAdmin().rpc("esblu_record_company_legal_identity", {
    p_company_id: membership.company_id,
    p_country: lookup.body.company.countryCode ?? "SK",
    p_registration_id: lookup.body.company.ico,
    p_verified: true,
    p_source: "registry:rpo",
  });
  if (error) {
    const code = /ESBLU_[A-Z_]+/.exec(error.message ?? "")?.[0] ?? "ESBLU_LEGAL_IDENTITY_FAILED";
    const status = code === "ESBLU_LEGAL_IDENTITY_LOCKED" ? 409 : code === "ESBLU_INVALID_REGISTRATION_ID" ? 400 : 500;
    if (status === 500) console.error("company/legal-identity: record zlyhalo:", code);
    return Response.json({ success: false, code }, { status });
  }

  const result = (data ?? {}) as { verification_status?: string; trial?: TrialOutcome };
  return Response.json({ success: true, verificationStatus: result.verification_status ?? "verified", trial: result.trial ?? "pending_legal_identity" });
}
