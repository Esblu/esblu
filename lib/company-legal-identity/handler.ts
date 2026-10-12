// =============================================================================
// POST /api/company/legal-identity — logika (bez I/O, testovateľná).
//
// Owner AKTÍVNEJ firmy tejto session zadá IČO → server ho overí v registri
// (RPO) → až po ÚSPEŠNOM overení service role zapíše overenú identitu a DB
// rozhodne o triale podľa histórie subjektu. Klient nikdy neposiela
// company_id ani „trial áno/nie".
//
// Zlyhanie registra: identita sa NEVYMYSLÍ, trial sa neaktivuje.
//   neexistuje → 'failed' (404), zaniknutý → 'failed' (409),
//   nedostupný / neúplné overenie → 'unverified', opakovateľné (503).
// =============================================================================

import type { CompanyDetailResponseBody } from "@/lib/company-lookup/types";
import { normalizeRegistrationId } from "./normalize.ts";

export type TrialOutcome = "granted" | "already_has_trial" | "legacy_no_trial" | "pending_legal_identity" | "not_eligible_previous_trial";
export type AttemptOutcome = "not_found" | "terminated" | "unavailable";
type DbError = { message?: string | null } | null;
type LookupOutcome = { ok: true; body: CompanyDetailResponseBody } | { ok: false; status: 404 | 429 | 503; code: string };

export type LegalIdentityDeps = {
  verifyUser(): Promise<{ id: string } | null>;
  activeMembership(): Promise<{ companyId: string; role: string } | null | "error">;
  consumeRateLimit(userId: string, companyId: string): boolean;
  lookup(ico: string): Promise<LookupOutcome>;
  recordVerified(companyId: string, country: string, registrationId: string): Promise<{ data: unknown; error: DbError }>;
  recordAttempt(companyId: string, country: string, registrationId: string, outcome: AttemptOutcome): Promise<{ error: DbError }>;
  log?(message: string): void;
};

const SUPPORTED_COUNTRIES = new Set(["SK"]);

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export async function handleLegalIdentityRequest(body: unknown, deps: LegalIdentityDeps): Promise<Response> {
  const user = await deps.verifyUser();
  if (!user) return json(401, { success: false, code: "NOT_AUTHENTICATED" });

  const input = (body && typeof body === "object" ? body : {}) as { ico?: unknown; country?: unknown };
  const country = typeof input.country === "string" && input.country.trim() ? input.country.trim().toUpperCase() : "SK";
  if (!SUPPORTED_COUNTRIES.has(country)) return json(422, { success: false, code: "ESBLU_COUNTRY_NOT_SUPPORTED" });
  const ico = normalizeRegistrationId(country, input.ico);
  if (!ico) return json(400, { success: false, code: "ESBLU_INVALID_REGISTRATION_ID" });

  const membership = await deps.activeMembership();
  if (membership === "error") return json(500, { success: false, code: "ESBLU_MEMBERSHIP_LOOKUP_FAILED" });
  if (!membership) return json(409, { success: false, code: "ESBLU_NO_ACTIVE_COMPANY" });
  if (membership.role !== "owner") return json(403, { success: false, code: "ESBLU_NOT_ACTIVE_OWNER" });

  if (!deps.consumeRateLimit(user.id, membership.companyId)) {
    return json(429, { success: false, code: "ESBLU_RATE_LIMITED", retryable: true });
  }

  const attempt = async (outcome: AttemptOutcome) => {
    const { error } = await deps.recordAttempt(membership.companyId, country, ico, outcome);
    if (error) deps.log?.(`company/legal-identity: attempt zlyhal: ${/ESBLU_[A-Z_]+/.exec(error.message ?? "")?.[0] ?? "DB"}`);
  };

  const lookup = await deps.lookup(ico);
  if (!lookup.ok && lookup.status === 404) {
    await attempt("not_found");
    return json(404, { success: false, code: "ESBLU_REGISTRY_NOT_FOUND", verificationStatus: "failed" });
  }
  const rpoVerified = lookup.ok && lookup.body.sources.some((source) => source.id === "rpo" && source.status === "VERIFIED");
  if (!lookup.ok || !rpoVerified) {
    await attempt("unavailable");
    return json(503, { success: false, code: "ESBLU_REGISTRY_UNAVAILABLE", verificationStatus: "unverified", retryable: true });
  }
  if (lookup.body.company.status !== "active") {
    await attempt("terminated");
    return json(409, { success: false, code: "ESBLU_REGISTRY_ENTITY_TERMINATED", verificationStatus: "failed" });
  }

  const registryIco = normalizeRegistrationId(country, lookup.body.company.ico);
  if (registryIco !== ico) {
    // register vrátil iný subjekt, než sa pýtalo → nič sa neoverí
    await attempt("unavailable");
    return json(503, { success: false, code: "ESBLU_REGISTRY_UNAVAILABLE", verificationStatus: "unverified", retryable: true });
  }

  const { data, error } = await deps.recordVerified(membership.companyId, country, ico);
  if (error) {
    const code = /ESBLU_[A-Z_]+/.exec(error.message ?? "")?.[0] ?? "ESBLU_LEGAL_IDENTITY_FAILED";
    const status = code === "ESBLU_LEGAL_IDENTITY_LOCKED" ? 409 : code === "ESBLU_INVALID_REGISTRATION_ID" ? 400 : 500;
    if (status === 500) deps.log?.(`company/legal-identity: record zlyhal: ${code}`);
    return json(status, { success: false, code });
  }
  const result = (data ?? {}) as { verification_status?: string; trial?: TrialOutcome };
  return json(200, { success: true, verificationStatus: result.verification_status ?? "verified", trial: result.trial ?? "pending_legal_identity" });
}
