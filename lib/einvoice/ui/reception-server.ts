import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { enrollCompany, provisionCompany, receptionView, type OnboardingDeps, type OrganizationState, type ReceptionStatus, type ReceptionView } from "../onboarding.ts";
import type { EinvoiceAccess } from "./types.ts";
import { accessFailure, type AccessResult } from "./summary-server.ts";

// =============================================================================
// E-Faktúra UI — stav príjmu a aktivácia príjmu FS overovacím kódom. SERVER-ONLY.
//
// GET  /api/einvoice/reception         → stav (finance.view, RLS)
// POST /api/einvoice/reception/enroll  → { verification_code, confirm_enroll: true }
//
// Bezpečnostné invarianty:
//   - identita z Bearer JWT; firma IBA z esblu_my_active_company_id() (nikdy z klienta),
//   - čítanie stavu cez user-scoped klienta (RLS: aktívna firma + finance.view),
//   - aktivácia iba s finance.manage + nárok einvoice + rollout + nakonfigurovaný
//     poskytovateľ; employee nikdy (esblu_my_finance_manage = false),
//   - overovací kód FS: iba formát (hex), použije sa v jednom volaní enroll a zahodí;
//     neukladá sa, nevracia sa, nelogovaný, nie je v chybových kódoch,
//   - telo presne {verification_code, confirm_enroll:true}; iné polia = 400 PRED čímkoľvek.
// =============================================================================

export type ReceptionDto = {
  access: EinvoiceAccess & { financeView: true };
  environment: "sandbox" | "live" | null;
  reception: ReceptionView;
};

export type ReceptionDeps = {
  /** user-scoped klient (RLS) */
  db: SupabaseClient;
  /** Klasifikovaný prístup (401 / 403 / 503 sa nikdy nezamieňajú). */
  access: (db: SupabaseClient) => Promise<AccessResult>;
  environment: "sandbox" | "live" | null;
};

type Result<T> = { status: number; body: T | { code: string } };

const ORG_COLS = "provider_org_id, participant_id, peppol_eligible, reception_status, reception_error_code";
type OrgRow = { provider_org_id: string | null; participant_id: string | null; peppol_eligible: boolean; reception_status: string | null; reception_error_code: string | null };

async function readOrganization(db: SupabaseClient, environment: "sandbox" | "live"): Promise<OrganizationState | null | "error"> {
  const { data, error } = await db.from("einvoice_organizations").select(ORG_COLS).eq("environment", environment).maybeSingle<OrgRow>();
  if (error) return "error";
  if (!data) return null;
  return {
    providerOrgId: data.provider_org_id,
    participantId: data.participant_id,
    peppolEligible: data.peppol_eligible === true,
    receptionStatus: (data.reception_status as ReceptionStatus | null) ?? null,
    receptionErrorCode: data.reception_error_code,
  };
}

export async function loadReception(deps: ReceptionDeps): Promise<Result<ReceptionDto>> {
  const acc = await deps.access(deps.db);
  if (!acc.ok) {
    const f = accessFailure(acc.kind);
    return { status: f.status, body: { code: f.code } };
  }
  if (!acc.financeView) return { status: 403, body: { code: "FORBIDDEN" } };
  let reception = receptionView(null);
  if (deps.environment) {
    const org = await readOrganization(deps.db, deps.environment);
    if (org === "error") return { status: 500, body: { code: "LOAD_FAILED" } };
    reception = receptionView(org);
  }
  return { status: 200, body: { access: { ...acc.access, financeView: true }, environment: deps.environment, reception } };
}

/** Striktné telo: presne dva kľúče. Kód sa NIKDY neobjaví v odpovedi ani v chybe. */
export function parseEnrollBody(raw: unknown): { ok: true; code: string } | { ok: false; code: "INVALID_BODY" | "CONFIRMATION_REQUIRED" | "INVALID_CODE_FORMAT" } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "INVALID_BODY" };
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== "confirm_enroll" || keys[1] !== "verification_code") return { ok: false, code: "INVALID_BODY" };
  const b = raw as { verification_code: unknown; confirm_enroll: unknown };
  if (b.confirm_enroll !== true) return { ok: false, code: "CONFIRMATION_REQUIRED" };
  if (typeof b.verification_code !== "string") return { ok: false, code: "INVALID_CODE_FORMAT" };
  const code = b.verification_code.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]{2,128}$/.test(code)) return { ok: false, code: "INVALID_CODE_FORMAT" };
  return { ok: true, code };
}

export type EnrollDeps = ReceptionDeps & {
  /** Privilegovaná vrstva + poskytovateľ — vytvorí sa až PO overení oprávnení (lenivo). */
  onboarding: () => OnboardingDeps | null;
};

export async function enrollReception(deps: EnrollDeps, rawBody: unknown): Promise<Result<{ code: string; reception: ReceptionView }>> {
  const parsed = parseEnrollBody(rawBody);
  if (!parsed.ok) return { status: 400, body: { code: parsed.code } };

  const acc = await deps.access(deps.db);
  if (!acc.ok) {
    const f = accessFailure(acc.kind);
    return { status: f.status, body: { code: f.code } };
  }
  if (!acc.financeView || !acc.access.financeManage) return { status: 403, body: { code: "FORBIDDEN" } };
  if (!acc.access.entitlementActive) return { status: 403, body: { code: "ENTITLEMENT_REQUIRED" } };
  if (!acc.access.providerConfigured || !deps.environment) return { status: 503, body: { code: "NOT_CONFIGURED" } };
  if (!acc.access.rolloutEnabled) return { status: 403, body: { code: "ROLLOUT_NOT_ENABLED" } };

  const company = await deps.db.rpc("esblu_my_active_company_id");
  const companyId = typeof company.data === "string" ? company.data : null;
  if (company.error || !companyId) return { status: 403, body: { code: "FORBIDDEN" } };

  const onboarding = deps.onboarding();
  if (!onboarding || onboarding.environment !== deps.environment) return { status: 503, body: { code: "NOT_CONFIGURED" } };

  const existing = await onboarding.store.organization(companyId, onboarding.environment);
  if (!existing?.providerOrgId) {
    const prov = await provisionCompany(onboarding, companyId);
    if (!prov.ok) return { status: prov.code.startsWith("BILLING_") || prov.code === "DIC_REQUIRED_FOR_PEPPOL" ? 422 : 502, body: { code: prov.code } };
  }
  const res = await enrollCompany(onboarding, companyId, parsed.code);
  if (res.ok) return { status: 200, body: { code: res.status === "enrolled" ? "ENROLLED" : res.status === "send_only" ? "SEND_ONLY" : "PENDING", reception: res.reception } };
  const status = res.code === "EINVOICE_ENROLL_TOKEN_INVALID" || res.code === "EINVOICE_ENROLL_TOKEN_FORMAT" ? 422 : res.code === "EINVOICE_ENROLL_CONFLICT" ? 409 : res.retryable ? 503 : 502;
  const reception = res.reception ?? receptionView(await onboarding.store.organization(companyId, onboarding.environment));
  return { status, body: { code: res.code, reception } };
}
