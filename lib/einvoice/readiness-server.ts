import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCompanyEntitlements } from "@/lib/entitlements-server";
import { hasEntitlement } from "@/lib/entitlements";
import { loadFinalizedIssuedInvoiceSnapshot } from "./load-finalized-invoice.ts";
import { getEinvoiceProvider } from "./provider/index.ts";
import {
  buildProvisionalSnapshot,
  type BillingProfileRow,
  type DraftHeaderRow,
  type DraftItemRow,
  type PartnerRow,
} from "./provisional-snapshot.ts";
import { evaluateEinvoiceReadiness, type ReadinessResult } from "./readiness.ts";
import type { EinvoiceEnvironment } from "./provider/types.ts";
import type { UblInvoiceSnapshot } from "./ubl/model.ts";

// =============================================================================
// Serverové zostavenie vstupu pre readiness kontrolu. SERVER-ONLY.
//
// `db` je VŽDY user-scoped klient (getUserScopedSupabaseClient — anon key +
// Bearer JWT volajúceho): firma, rola, nárok aj dáta faktúry sa čítajú pod
// RLS a cez kanonické DB helpery. Žiadny service_role, nič z klienta.
// Prostredie poskytovateľa určuje výhradne serverová konfigurácia (env).
// =============================================================================

/** Serverový kontext readiness — používa ho outbound orchestrácia (nikdy nejde klientovi). */
export type ReadinessContext = {
  companyId: string;
  environment: EinvoiceEnvironment | null;
  organization: { providerOrgId: string | null; provider: string; participantId: string | null; peppolEligible: boolean } | null;
  /** Nemenný snapshot finalizovanej faktúry (iba v režime pre_send). */
  finalizedSnapshot: UblInvoiceSnapshot | null;
};

export type ReadinessLoadResult =
  | { ok: true; result: ReadinessResult; context: ReadinessContext }
  | { ok: false; status: 403 | 404 | 409 | 500; code: "NO_ACTIVE_COMPANY" | "FORBIDDEN" | "NOT_FOUND" | "NOT_ISSUED" | "QUERY_FAILED" };

const DRAFT_COLUMNS =
  "id, company_id, direction, kind, document_status, invoice_number, issue_date, due_date, delivery_date, " +
  "tax_point_date, currency, rounding_amount, buyer_reference, purchase_order_reference, payment_means_code, " +
  "payment_reference, corrects_invoice_id, customer_business_partner_id";

const PROFILE_COLUMNS =
  "legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code, country_code, iban, bic, " +
  "contact_email, electronic_address, electronic_address_scheme_id, legal_registration_id, " +
  "legal_registration_scheme_id, vat_identifier";

const PARTNER_COLUMNS =
  "legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code, country_code, email, " +
  "electronic_address, electronic_address_scheme_id, legal_registration_id, legal_registration_scheme_id, vat_identifier";

/** Serverové prostredie poskytovateľa (iba env). null = nenakonfigurované. */
function serverEnvironment(env: Record<string, string | undefined>): EinvoiceEnvironment | null {
  const value = env.ESBLU_EINVOICE_ENVIRONMENT?.trim();
  return value === "sandbox" || value === "live" ? value : null;
}

function providerConfigured(env: Record<string, string | undefined>): boolean {
  try {
    return getEinvoiceProvider(env) !== null;
  } catch {
    // Napr. kľúč nezodpovedá prostrediu — fail closed, bez detailu (žiadne tajomstvo do odpovede).
    return false;
  }
}

async function rpcBoolean(db: SupabaseClient, fn: string): Promise<boolean | null> {
  const { data, error } = await db.rpc(fn);
  if (error) return null;
  return data === true;
}

export async function loadEinvoiceReadiness(
  db: SupabaseClient,
  invoiceId: string,
  env: Record<string, string | undefined> = process.env
): Promise<ReadinessLoadResult> {
  const { data: companyId, error: companyError } = await db.rpc("esblu_my_active_company_id");
  if (companyError) return { ok: false, status: 500, code: "QUERY_FAILED" };
  if (typeof companyId !== "string" || !companyId) return { ok: false, status: 403, code: "NO_ACTIVE_COMPANY" };

  const financeView = await rpcBoolean(db, "esblu_my_finance_view");
  if (financeView === null) return { ok: false, status: 500, code: "QUERY_FAILED" };
  if (!financeView) return { ok: false, status: 403, code: "FORBIDDEN" };
  const financeManage = (await rpcBoolean(db, "esblu_my_finance_manage")) === true;

  const entitlements = await getCompanyEntitlements(db);
  const einvoiceEntitlement = hasEntitlement(entitlements, "einvoice");

  const environment = serverEnvironment(env);
  let organization: ReadinessContext["organization"] = null;
  if (environment) {
    const { data: org, error: orgError } = await db
      .from("einvoice_organizations")
      .select("provider, provider_org_id, participant_id, peppol_eligible")
      .eq("company_id", companyId)
      .eq("environment", environment)
      .maybeSingle<{ provider: string; provider_org_id: string | null; participant_id: string | null; peppol_eligible: boolean }>();
    if (orgError) return { ok: false, status: 500, code: "QUERY_FAILED" };
    organization = org
      ? { provider: org.provider, providerOrgId: org.provider_org_id, participantId: org.participant_id, peppolEligible: org.peppol_eligible === true }
      : null;
  }

  const { data: header, error: headerError } = await db
    .from("invoices")
    .select(DRAFT_COLUMNS)
    .eq("id", invoiceId)
    .maybeSingle<DraftHeaderRow & { customer_business_partner_id: string | null }>();
  if (headerError) return { ok: false, status: 500, code: "QUERY_FAILED" };
  if (!header || header.company_id !== companyId) return { ok: false, status: 404, code: "NOT_FOUND" };
  if (header.direction !== "issued") return { ok: false, status: 409, code: "NOT_ISSUED" };

  const common = { financeManage, einvoiceEntitlement, providerConfigured: providerConfigured(env), organization };

  if (header.document_status === "finalized") {
    const loaded = await loadFinalizedIssuedInvoiceSnapshot(db, invoiceId, companyId);
    if (!loaded.ok) {
      if (loaded.reason === "NOT_FOUND") return { ok: false, status: 404, code: "NOT_FOUND" };
      if (loaded.reason === "QUERY_FAILED") return { ok: false, status: 500, code: "QUERY_FAILED" };
      return { ok: false, status: 409, code: "NOT_ISSUED" };
    }
    return {
      ok: true,
      result: evaluateEinvoiceReadiness({ ...common, mode: "pre_send", snapshot: loaded.snapshot }),
      context: { companyId, environment, organization, finalizedSnapshot: loaded.snapshot },
    };
  }

  const [itemsRes, profileRes, partnerRes] = await Promise.all([
    db
      .from("invoice_items")
      .select("position, description, quantity, unit_code, unit_price, price_mode, vat_category_code, vat_rate")
      .eq("invoice_id", invoiceId)
      .order("position", { ascending: true })
      .returns<DraftItemRow[]>(),
    db.from("company_billing_profile").select(PROFILE_COLUMNS).eq("company_id", companyId).maybeSingle<BillingProfileRow>(),
    header.customer_business_partner_id
      ? db
          .from("business_partners")
          .select(PARTNER_COLUMNS)
          .eq("id", header.customer_business_partner_id)
          .maybeSingle<PartnerRow>()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (itemsRes.error || profileRes.error || partnerRes.error) return { ok: false, status: 500, code: "QUERY_FAILED" };

  const snapshot = buildProvisionalSnapshot({
    invoice: header,
    items: itemsRes.data ?? [],
    profile: profileRes.data ?? null,
    partner: (partnerRes.data as PartnerRow | null) ?? null,
  });

  if (header.corrects_invoice_id) {
    const { data: corrected, error: correctedError } = await db
      .from("invoices")
      .select("invoice_number, issue_date, company_id")
      .eq("id", header.corrects_invoice_id)
      .maybeSingle<{ invoice_number: string | null; issue_date: string | null; company_id: string }>();
    if (correctedError) return { ok: false, status: 500, code: "QUERY_FAILED" };
    if (corrected && corrected.company_id === companyId) {
      snapshot.correctedInvoice = { invoice_number: corrected.invoice_number, issue_date: corrected.issue_date };
    }
  }

  return {
    ok: true,
    result: evaluateEinvoiceReadiness({ ...common, mode: "pre_finalize", snapshot }),
    context: { companyId, environment, organization, finalizedSnapshot: null },
  };
}
