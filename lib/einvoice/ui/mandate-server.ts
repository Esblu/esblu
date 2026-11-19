import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { EINVOICE_MANDATE_STATEMENT_VERSION, mandateStatementUsableIn } from "../mandate-statement.ts";
import { canonicalSha256, regrantEffectiveScope, type MandateEvidence, type MandateStatement, type MandateStore } from "../mandate.ts";
import type { EinvoiceEnvironment, EinvoiceProvider } from "../provider/types.ts";
import { accessFailure, type AccessResult } from "./summary-server.ts";

// =============================================================================
// E-Faktúra UI — stav, opätovné udelenie a odvolanie elektronického poverenia
// (mandátu). SERVER-ONLY. 20261122100000.
//
// GET  /api/einvoice/mandate                      → stav (finance.view, RPC pod RLS volajúceho)
// POST /api/einvoice/mandate {action:"revoke", confirm_revoke:true}
//        → odvolá všetky neodvolané mandáty aktívnej firmy (finance.manage); od tejto chvíle
//          sa nič nové neodošle (DB brána + claim). Registrácia u poskytovateľa ostáva.
// POST /api/einvoice/mandate {action:"grant", confirm_mandate:true, mandate_version}
//        → opätovné udelenie pre UŽ registrovanú organizáciu (bez FS kódu): server overí
//          organizáciu u poskytovateľa (GET /organizations/{id}) a jej odpoveď zahashuje.
// Firma IBA z esblu_my_active_company_id(); prostredie IBA zo serverovej konfigurácie.
// =============================================================================

type Result = { status: number; body: Record<string, unknown> };

export type MandateRouteDeps = {
  db: SupabaseClient;
  access: (db: SupabaseClient) => Promise<AccessResult>;
  userId: string;
  runtime: { provider: EinvoiceProvider; environment: EinvoiceEnvironment } | null;
  store: () => MandateStore | null;
  statement: MandateStatement;
  evidence: (companyId: string) => MandateEvidence;
};

export type MandateBody =
  | { action: "revoke" }
  | { action: "grant"; mandateVersion: string };

export function parseMandateBody(raw: unknown): { ok: true; body: MandateBody } | { ok: false; code: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "INVALID_BODY" };
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (r.action === "revoke") {
    if (keys !== "action,confirm_revoke") return { ok: false, code: "INVALID_BODY" };
    if (r.confirm_revoke !== true) return { ok: false, code: "CONFIRMATION_REQUIRED" };
    return { ok: true, body: { action: "revoke" } };
  }
  if (r.action === "grant") {
    if (keys !== "action,confirm_mandate,mandate_version") return { ok: false, code: "INVALID_BODY" };
    if (r.confirm_mandate !== true) return { ok: false, code: "CONFIRMATION_REQUIRED" };
    if (r.mandate_version !== EINVOICE_MANDATE_STATEMENT_VERSION) return { ok: false, code: "MANDATE_STATEMENT_OUTDATED" };
    return { ok: true, body: { action: "grant", mandateVersion: r.mandate_version } };
  }
  return { ok: false, code: "INVALID_BODY" };
}

async function activeCompany(db: SupabaseClient): Promise<string | null> {
  const r = await db.rpc("esblu_my_active_company_id");
  return !r.error && typeof r.data === "string" ? r.data : null;
}

export async function loadMandate(deps: Pick<MandateRouteDeps, "db" | "access" | "runtime">): Promise<Result> {
  const acc = await deps.access(deps.db);
  if (!acc.ok) {
    const f = accessFailure(acc.kind);
    return { status: f.status, body: { code: f.code } };
  }
  if (!acc.financeView) return { status: 403, body: { code: "FORBIDDEN" } };
  if (!deps.runtime) return { status: 200, body: { code: "OK", environment: null, mandate: null, current_version: EINVOICE_MANDATE_STATEMENT_VERSION } };
  const r = await deps.db.rpc("esblu_einvoice_my_mandate", { p_environment: deps.runtime.environment });
  if (r.error) return { status: 500, body: { code: "LOAD_FAILED" } };
  return { status: 200, body: { code: "OK", environment: deps.runtime.environment, mandate: r.data, current_version: EINVOICE_MANDATE_STATEMENT_VERSION } };
}

export async function changeMandate(deps: MandateRouteDeps, raw: unknown): Promise<Result> {
  const parsed = parseMandateBody(raw);
  if (!parsed.ok) return { status: parsed.code === "MANDATE_STATEMENT_OUTDATED" ? 409 : 400, body: { code: parsed.code } };
  const acc = await deps.access(deps.db);
  if (!acc.ok) {
    const f = accessFailure(acc.kind);
    return { status: f.status, body: { code: f.code } };
  }
  if (!acc.financeView || !acc.access.financeManage) return { status: 403, body: { code: "FORBIDDEN" } };
  if (!deps.runtime) return { status: 503, body: { code: "NOT_CONFIGURED" } };
  const companyId = await activeCompany(deps.db);
  if (!companyId) return { status: 403, body: { code: "FORBIDDEN" } };
  const store = deps.store();
  if (!store) return { status: 503, body: { code: "NOT_CONFIGURED" } };
  const environment = deps.runtime.environment;

  if (parsed.body.action === "revoke") {
    try {
      const n = await store.revoke({ companyId, environment, kind: "user", actorUserId: deps.userId, reasonCode: "USER_REVOKED" });
      return { status: 200, body: { code: n > 0 ? "REVOKED" : "NOTHING_TO_REVOKE", revoked: n } };
    } catch {
      return { status: 500, body: { code: "MANDATE_RECORD_FAILED" } };
    }
  }

  // grant (regrant) — organizácia musí byť registrovaná a spôsobilá odosielať.
  if (!acc.access.entitlementActive) return { status: 403, body: { code: "ENTITLEMENT_REQUIRED" } };
  if (!acc.access.rolloutEnabled) return { status: 403, body: { code: "ROLLOUT_NOT_ENABLED" } };
  // Text poverenia je DRAFT, kým ho prevádzkovateľ neschváli → v live sa poverenie neudelí (odvolanie áno).
  if (!mandateStatementUsableIn(environment)) return { status: 409, body: { code: "MANDATE_STATEMENT_NOT_APPROVED" } };
  const org = await deps.db
    .from("einvoice_organizations")
    .select("provider, provider_org_id, reception_status")
    .eq("environment", environment)
    .maybeSingle<{ provider: string; provider_org_id: string | null; reception_status: string | null }>();
  if (org.error) return { status: 500, body: { code: "LOAD_FAILED" } };
  if (!org.data?.provider_org_id || org.data.provider !== deps.runtime.provider.name || org.data.reception_status === "deactivated") {
    return { status: 409, body: { code: "ORGANIZATION_NOT_READY" } };
  }
  let info;
  try {
    info = await deps.runtime.provider.getOrganization({ environment, providerOrgId: org.data.provider_org_id });
  } catch {
    return { status: 502, body: { code: "PROVIDER_UNAVAILABLE" } };
  }
  const scope = regrantEffectiveScope(info, org.data.reception_status === "active");
  if (scope.length === 0) return { status: 409, body: { code: "ORGANIZATION_NOT_READY" } };
  let mandateId: string;
  try {
    mandateId = await store.grant({
      actorUserId: deps.userId,
      companyId,
      environment,
      scope,
      statement: deps.statement,
      channel: "regrant",
      evidence: deps.evidence(companyId),
    });
  } catch {
    return { status: 500, body: { code: "MANDATE_RECORD_FAILED" } };
  }
  try {
    await store.confirm({
      mandateId,
      scope,
      providerOutcome: "ORG_VERIFIED",
      providerResponseSha256: canonicalSha256({ ...info, reused: undefined }),
      participantId: info.participantId,
    });
  } catch {
    return { status: 500, body: { code: "MANDATE_RECORD_FAILED" } };
  }
  return { status: 200, body: { code: "GRANTED", scope } };
}
