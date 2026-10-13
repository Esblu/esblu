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
  /**
   * Phase 6: serverové prostredie poskytovateľa (null = nenakonfigurované) a
   * dnešný dátum v Europe/Bratislava (YYYY-MM-DD). Bez nich sa pravidlá
   * prostredia a dátumu vyhotovenia nevyhodnocujú.
   */
  environment?: "sandbox" | "live" | null;
  today?: string | null;
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

/**
 * Pravidlá dátumu vyhotovenia pri živom Peppol odoslaní (eFaktura.sk changelog
 * 2026-09-23 / 2026-09-28; FS FAQ a § 85o zákona o DPH):
 *   - do 31. 12. 2026: interný limit poskytovateľa — nie starší ako 10 dní
 *     (INVOICE_ISSUE_DATE_TOO_OLD),
 *   - od 1. 1. 2027: dátum vyhotovenia (BT-2) = deň odoslania
 *     (INVOICE_ISSUE_DATE_NOT_SEND_DATE).
 * Testovacie (sandbox) odoslania sú vyňaté → iba upozornenie.
 */
export const ISSUE_DATE_MAX_AGE_DAYS = 10;
export const SAME_DAY_RULE_FROM = "2027-01-01";

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

export function issueDateRule(issueDate: string | null | undefined, today: string): UblIssue | null {
  if (!issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  if (today >= SAME_DAY_RULE_FROM) {
    return issueDate === today ? null : { code: "ISSUE_DATE_NOT_SEND_DATE", rule: "BT-2/§85o" };
  }
  const age = daysBetween(issueDate, today);
  return age !== null && age > ISSUE_DATE_MAX_AGE_DAYS
    ? { code: "ISSUE_DATE_TOO_OLD", rule: "provider:issue-date", params: { days: ISSUE_DATE_MAX_AGE_DAYS } }
    : null;
}

/** Dnešný dátum v Europe/Bratislava (YYYY-MM-DD). */
export function bratislavaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function evaluateEinvoiceReadiness(input: ReadinessInput): ReadinessResult {
  const issues: ReadinessIssue[] = [];
  const extraWarnings: UblWarning[] = [];

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

  // Phase 6: Peppol sieť odberateľa musí sedieť s prostredím (docs „Sandbox vs.
  // production": surové UBL nesie v sandboxe schému 9915; live nikdy 9915).
  const buyerEndpoint = endpointOf(input.snapshot.buyer);
  if (buyerEndpoint && input.environment === "live" && buyerEndpoint.startsWith("9915:")) {
    issues.push({ code: "BUYER_ENDPOINT_TEST_SCHEME", rule: "BT-49", category: "document" });
  }
  if (buyerEndpoint && input.environment === "sandbox" && !buyerEndpoint.startsWith("9915:")) {
    issues.push({ code: "BUYER_ENDPOINT_SANDBOX_SCHEME", rule: "BT-49", category: "document" });
  }

  // Phase 6: dátum vyhotovenia vs. deň odoslania (live = blokuje pri odoslaní; inak upozornenie).
  if (input.today) {
    const rule = issueDateRule(input.snapshot.invoice.issue_date, input.today);
    if (rule) {
      if (input.mode === "pre_send" && input.environment === "live") issues.push({ ...rule, category: "document" });
      else extraWarnings.push(rule);
    }
  }

  // Dokumentové pravidlá UBL — TÁ ISTÁ funkcia, akú volá generateUbl, takže
  // readiness a UBL validácia sú vždy konzistentné. Patrí sem aj BR-61
  // (bankTransferAccountIssue: kód úhrady 30/58 bez IBAN dodávateľa →
  // BANK_TRANSFER_IBAN_MISSING) — v pre_finalize sa ukáže ešte na koncepte
  // (IBAN z profilu firmy), v pre_send zablokuje odoslanie PRED volaním
  // poskytovateľa. Zámerne sa tu neduplikuje (duplicitný blocker v UI).
  const ubl = checkUblPreconditions(input.snapshot);
  for (const issue of ubl.issues) {
    if (input.mode === "pre_finalize" && PRE_FINALIZE_IGNORED.has(issue.code)) continue;
    issues.push({ ...issue, category: "document" });
  }

  return { ready: issues.length === 0, mode: input.mode, issues, warnings: [...ubl.warnings, ...extraWarnings] };
}
