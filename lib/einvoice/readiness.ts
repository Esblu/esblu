import { checkUblPreconditions } from "./ubl/generate.ts";
import type { UblInvoiceSnapshot, UblIssue, UblWarning } from "./ubl/model.ts";

// =============================================================================
// E-Faktúra — pripravenosť (readiness) PRED finalizáciou / PRED odoslaním.
//
// Čistá funkcia (bez I/O). Vstup zostavuje server (lib/einvoice/readiness-server.ts)
// výhradne z DB pod RLS volajúceho — nikdy z klientského payloadu.
//
// Výsledok je strojovo čitateľný: `code` (stabilný kód → i18n
// `einvoice.readiness.<code>` resp. `einvoice.issues.<code>`), `rule`
// (technická referencia), `params`. Žiadny hotový text v jazyku.
//
// Režimy:
//   pre_finalize — koncept faktúry: snapshot je PREDBEŽNÝ (zostavený rovnako
//     ako ho zachytí esblu_finalize_invoice: predávajúci = profil firmy,
//     kupujúci = obchodný partner; sumy z VAT enginu). Číslo faktúry ešte
//     neexistuje, preto sa NOT_FINALIZED / MISSING_INVOICE_NUMBER ignorujú.
//     Slúži na to, aby používateľ opravil údaje KÝM sa dajú opraviť —
//     finalizovaný snapshot je nemenný.
//   pre_send — finalizovaná faktúra: nemenný snapshot, plná kontrola.
//
// Bežnú finalizáciu (PDF faktúra) táto kontrola NEBLOKUJE — e-faktúra je
// samostatný modul. Blokuje odoslanie (serverová route + DB RPC).
// =============================================================================

export type ReadinessMode = "pre_finalize" | "pre_send";

export type ReadinessCategory = "access" | "entitlement" | "provider" | "organization" | "document";

export type ReadinessIssue = UblIssue & { category: ReadinessCategory };

export type ReadinessInput = {
  mode: ReadinessMode;
  /** esblu_my_finance_manage() volajúceho (owner, accountant, admin s finance.manage). */
  financeManage: boolean;
  /** Aktívny nárok `einvoice` (esblu_resolve_entitlement cez esblu_get_my_company_entitlements). */
  einvoiceEntitlement: boolean;
  /** Serverová konfigurácia poskytovateľa (env) je kompletná. */
  providerConfigured: boolean;
  /** einvoice_organizations pre firmu a SERVEROVÉ prostredie, alebo null. */
  organization: { participantId: string | null; peppolEligible: boolean } | null;
  snapshot: UblInvoiceSnapshot;
};

export type ReadinessResult = {
  ready: boolean;
  mode: ReadinessMode;
  issues: ReadinessIssue[];
  warnings: UblWarning[];
};

/** Kódy, ktoré v režime pre_finalize nedávajú zmysel (vzniknú až finalizáciou). */
const PRE_FINALIZE_IGNORED = new Set(["NOT_FINALIZED", "MISSING_INVOICE_NUMBER"]);

function endpointOf(party: { electronic_address: string | null; electronic_address_scheme_id: string | null }): string | null {
  const value = party.electronic_address?.trim();
  const scheme = party.electronic_address_scheme_id?.trim();
  return value && scheme ? `${scheme}:${value}` : null;
}

export function evaluateEinvoiceReadiness(input: ReadinessInput): ReadinessResult {
  const issues: ReadinessIssue[] = [];

  if (!input.financeManage) {
    issues.push({ code: "FINANCE_MANAGE_REQUIRED", rule: "authz", category: "access" });
  }
  if (!input.einvoiceEntitlement) {
    issues.push({ code: "EINVOICE_ENTITLEMENT_REQUIRED", rule: "entitlement:einvoice", category: "entitlement" });
  }
  if (input.mode === "pre_send" && !input.providerConfigured) {
    issues.push({ code: "PROVIDER_NOT_CONFIGURED", rule: "server-config", category: "provider" });
  }

  const org = input.organization;
  if (!org || !org.peppolEligible || !org.participantId) {
    issues.push({ code: "ORGANIZATION_NOT_READY", rule: "einvoice_organizations", category: "organization" });
  } else {
    // BT-34 predávajúceho musí byť presne participant registrovaný u poskytovateľa.
    const sellerEndpoint = endpointOf(input.snapshot.seller);
    if (sellerEndpoint && sellerEndpoint !== org.participantId) {
      issues.push({ code: "SELLER_ENDPOINT_MISMATCH", rule: "BT-34", category: "organization" });
    }
  }

  const ubl = checkUblPreconditions(input.snapshot);
  for (const issue of ubl.issues) {
    if (input.mode === "pre_finalize" && PRE_FINALIZE_IGNORED.has(issue.code)) continue;
    issues.push({ ...issue, category: "document" });
  }

  return { ready: issues.length === 0, mode: input.mode, issues, warnings: ubl.warnings };
}
