import "server-only";

// =============================================================================
// E-Faktúra — API partner onboarding firmy (eFaktura.sk Agent API). SERVER-ONLY.
//
// Tok (API model, nie white-label):
//   1. provisionCompany  → POST /v1/agent/organizations (idempotentné podľa IČO)
//                          + mapovanie firma ↔ org v einvoice_organizations
//   2. enrollCompany     → klient si na portáli FS zvolí eFaktura.sk, overovací kód
//                          zadá v Esblu → POST /v1/agent/peppol/enroll
//   3. participant.* webhook / feed → potvrdenie stavu príjmu (inbound/webhook.ts)
//
// Pravidlá:
//   - firma a org ID IBA zo servera / DB, nikdy z klienta,
//   - overovací kód FS sa neukladá, nevracia ani neloguje,
//   - automatický retry s backoffom iba pre idempotentné volania (založenie
//     podľa IČO, GET); enroll sa automaticky neopakuje,
//   - stav pre UI: príjem je „aktívny" IBA pri reception_status = active
//     (send_only nikdy nevyzerá ako aktívny príjem).
// =============================================================================

import {
  EinvoiceProviderError,
  type EinvoiceEnvironment,
  type EinvoiceOnboardingProvider,
  type EinvoiceProvider,
  type EnrollResult,
} from "./provider/types.ts";

export type ReceptionStatus = "pending" | "active" | "send_only" | "failed" | "deactivated";

export type BillingIdentity = {
  legal_name: string | null;
  ico: string | null;
  dic: string | null;
  ic_dph: string | null;
  street: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
};

export type OrganizationState = {
  providerOrgId: string | null;
  participantId: string | null;
  peppolEligible: boolean;
  receptionStatus: ReceptionStatus | null;
  receptionErrorCode: string | null;
};

export interface OnboardingStore {
  billingIdentity(companyId: string): Promise<BillingIdentity | null>;
  organization(companyId: string, environment: EinvoiceEnvironment): Promise<OrganizationState | null>;
  upsertProvisioned(input: {
    companyId: string;
    provider: string;
    environment: EinvoiceEnvironment;
    providerOrgId: string;
    participantId: string | null;
    orgStatus: string | null;
    peppolStatus: string | null;
    claimStatus: string | null;
    peppolEligible: boolean;
    snapshot: Record<string, string>;
  }): Promise<{ created: boolean; receptionStatus: string | null }>;
  applyEnroll(input: {
    provider: string;
    environment: EinvoiceEnvironment;
    providerOrgId: string;
    outcome: "enrolled" | "skipped" | "send_only" | "failed";
    participantId: string | null;
    heldBy: string | null;
    errorCode: string | null;
  }): Promise<{ receptionStatus: string; peppolEligible: boolean }>;
}

export type OnboardingDeps = {
  store: OnboardingStore;
  provider: EinvoiceProvider & EinvoiceOnboardingProvider;
  environment: EinvoiceEnvironment;
  /** Iba testy: čakanie medzi pokusmi. */
  sleep?: (ms: number) => Promise<void>;
};

const BACKOFF_MS = [500, 2000, 5000];

/** Opakovanie IBA pre idempotentné volania a IBA pri `retryable` chybe (sieť, timeout, 429, 5xx). */
export async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const retryable = error instanceof EinvoiceProviderError && error.retryable;
      if (!retryable || attempt === BACKOFF_MS.length) throw error;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw last;
}

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

export type ProvisionResult =
  | { ok: true; providerOrgId: string; reused: boolean; created: boolean; receptionStatus: string | null }
  | { ok: false; code: string };

/** Založí (alebo idempotentne nájde) organizáciu u poskytovateľa a uloží mapovanie. */
export async function provisionCompany(deps: OnboardingDeps, companyId: string): Promise<ProvisionResult> {
  const identity = await deps.store.billingIdentity(companyId);
  if (!identity) return { ok: false, code: "BILLING_PROFILE_MISSING" };
  const legalName = clean(identity.legal_name);
  const ico = clean(identity.ico);
  const dic = clean(identity.dic);
  if (!legalName || !/^[0-9]{6,8}$/.test(ico)) return { ok: false, code: "BILLING_PROFILE_INCOMPLETE" };
  if (!/^[0-9]{10}$/.test(dic)) return { ok: false, code: "DIC_REQUIRED_FOR_PEPPOL" };

  const existing = await deps.store.organization(companyId, deps.environment);
  const sleep = deps.sleep;
  try {
    const info = existing?.providerOrgId
      ? { ...(await withRetry(() => deps.provider.getOrganization({ environment: deps.environment, providerOrgId: existing.providerOrgId! }), sleep)), reused: true }
      : await withRetry(
          () =>
            deps.provider.provisionOrganization({
              environment: deps.environment,
              legalName,
              ico,
              dic,
              icDph: clean(identity.ic_dph) || null,
              address: {
                street: clean(identity.street),
                city: clean(identity.city),
                postalCode: clean(identity.postal_code),
                countryCode: clean(identity.country_code) || "SK",
              },
            }),
          sleep
        );
    const saved = await deps.store.upsertProvisioned({
      companyId,
      provider: deps.provider.name,
      environment: deps.environment,
      providerOrgId: info.providerOrgId,
      participantId: info.participantId,
      orgStatus: info.orgStatus,
      peppolStatus: info.peppolStatus,
      claimStatus: info.claimStatus,
      peppolEligible: info.peppolEligible,
      snapshot: {
        legal_name: legalName,
        ico,
        dic,
        ic_dph: clean(identity.ic_dph),
        street: clean(identity.street),
        city: clean(identity.city),
        postal_code: clean(identity.postal_code),
        country_code: clean(identity.country_code) || "SK",
      },
    });
    return { ok: true, providerOrgId: info.providerOrgId, reused: info.reused, created: saved.created, receptionStatus: saved.receptionStatus };
  } catch (error) {
    return { ok: false, code: error instanceof EinvoiceProviderError ? error.code : "PROVISION_FAILED" };
  }
}

export type EnrollOutcome =
  | { ok: true; status: EnrollResult["status"]; reception: ReceptionView; warnings: string[] }
  | { ok: false; code: string; retryable: boolean; reception: ReceptionView | null };

/**
 * Aktivácia príjmu FS overovacím kódom klienta. Kód sa použije iba v tomto
 * volaní (nikdy sa neuloží ani nevráti). Chyba neplatného kódu nezhorší
 * už aktívny príjem (DB pravidlo v esblu_einvoice_org_apply_enroll).
 */
export async function enrollCompany(deps: OnboardingDeps, companyId: string, verificationTokenHex: string): Promise<EnrollOutcome> {
  const org = await deps.store.organization(companyId, deps.environment);
  if (!org?.providerOrgId) return { ok: false, code: "ORGANIZATION_NOT_PROVISIONED", retryable: false, reception: null };
  const ctx = { environment: deps.environment, providerOrgId: org.providerOrgId };
  let result: EnrollResult;
  try {
    result = await deps.provider.enrollPeppol(ctx, { verificationTokenHex });
  } catch (error) {
    const code = error instanceof EinvoiceProviderError ? error.code : "ENROLL_FAILED";
    const retryable = error instanceof EinvoiceProviderError && error.retryable;
    // Iba definitívne zamietnutie sa zapisuje (neplatný kód / konflikt); sieť a 5xx stav nemenia.
    if (code === "EINVOICE_ENROLL_TOKEN_INVALID" || code === "EINVOICE_ENROLL_CONFLICT") {
      const applied = await deps.store.applyEnroll({
        provider: deps.provider.name,
        environment: deps.environment,
        providerOrgId: org.providerOrgId,
        outcome: "failed",
        participantId: null,
        heldBy: null,
        errorCode: code === "EINVOICE_ENROLL_TOKEN_INVALID" ? "VERIFICATION_TOKEN_INVALID" : "ENROLL_CONFLICT",
      });
      return { ok: false, code, retryable: false, reception: receptionView({ ...org, receptionStatus: applied.receptionStatus as ReceptionStatus, peppolEligible: applied.peppolEligible }) };
    }
    return { ok: false, code, retryable, reception: receptionView(org) };
  }

  const heldBy = result.receptionHeldBy ? [result.receptionHeldBy.certOrg, result.receptionHeldBy.apHost].filter(Boolean).join(" / ") || null : null;
  const applied = await deps.store.applyEnroll({
    provider: deps.provider.name,
    environment: deps.environment,
    providerOrgId: org.providerOrgId,
    outcome: result.status,
    participantId: result.participantId,
    heldBy,
    errorCode: null,
  });
  return {
    ok: true,
    status: result.status,
    warnings: result.warnings,
    reception: receptionView({
      ...org,
      participantId: result.participantId ?? org.participantId,
      receptionStatus: applied.receptionStatus as ReceptionStatus,
      peppolEligible: applied.peppolEligible,
      receptionErrorCode: result.status === "send_only" ? "PARTICIPANT_HELD_ELSEWHERE" : null,
    }),
  };
}

/** Stav pre UI — bez ID poskytovateľa, participant ID ani názvu iného poskytovateľa. */
export type ReceptionView = {
  state: "not_configured" | ReceptionStatus | "legacy";
  receivingActive: boolean;
  sendingEnabled: boolean;
  errorCode: string | null;
};

export function receptionView(org: OrganizationState | null): ReceptionView {
  if (!org?.providerOrgId) return { state: "not_configured", receivingActive: false, sendingEnabled: false, errorCode: null };
  const status = org.receptionStatus;
  const sendingEnabled = org.peppolEligible && !!org.participantId && status !== "deactivated";
  if (status === null) {
    // Legacy (mäkký sandbox pred 2. 10. 2026): príjem iba ak bola org zapísaná v Peppole.
    return { state: "legacy", receivingActive: sendingEnabled, sendingEnabled, errorCode: null };
  }
  return { state: status, receivingActive: status === "active" && sendingEnabled, sendingEnabled, errorCode: org.receptionErrorCode };
}
