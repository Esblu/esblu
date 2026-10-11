// =============================================================================
// Reporting obchodom (SERVER ONLY) — z outboxu billing_store_reports.
//
// Google (billing choice → Esblu billing): externalTransactions do 24 h
//   initial  → recurringTransaction.externalTransactionToken
//   renewal  → recurringTransaction.initialExternalTransactionId
//   refund   → externalTransactions/{id}:refund
// Apple (EÚ ExternalPurchaseCustomLink): PUT /externalPurchase/v1/reports,
//   mesačne do 15. dňa; SubscriptionBuyLineItem (SUBSCRIPTION_START / RENEWAL),
//   NO_LINE_ITEM pre tokeny bez nákupu. Sumy v milli-jednotkách, taxCountry ISO-3.
// Polia podľa developers.google.com/android-publisher (externaltransactions) a
// developer.apple.com/documentation/externalpurchaseserverapi (overené 2026-10-08).
// Apple RefundLineItem schéma NEOVERENÁ → refund ostane 'failed' pre operátora.
// =============================================================================

import type { AppleStoreApi, GooglePlayApi } from "@/lib/billing/stores/store-apis";

export type StoreReportRow = {
  id: string;
  store: "google" | "apple";
  report_kind: string;
  external_transaction_id: string;
  initial_external_transaction_id: string | null;
  store_token: string | null;
  amount_pre_tax_minor: number | string | null;
  tax_minor: number | string | null;
  currency: string | null;
  tax_country: string | null;
  transaction_at: string;
  period_start: string | null;
  period_end: string | null;
  product_id: string | null;
};

const ISO3: Record<string, string> = {
  AT: "AUT", BE: "BEL", BG: "BGR", HR: "HRV", CY: "CYP", CZ: "CZE", DK: "DNK", EE: "EST", FI: "FIN", FR: "FRA",
  DE: "DEU", GR: "GRC", HU: "HUN", IE: "IRL", IT: "ITA", LV: "LVA", LT: "LTU", LU: "LUX", MT: "MLT", NL: "NLD",
  PL: "POL", PT: "PRT", RO: "ROU", SK: "SVK", SI: "SVN", ES: "ESP", SE: "SWE", IS: "ISL", LI: "LIE", NO: "NOR",
  US: "USA", GB: "GBR", CH: "CHE",
};

const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));
const micros = (minor: number | null) => (minor === null ? null : String(Math.round(minor * 10_000)));
const millis = (minor: number | null) => (minor === null ? null : Math.round(minor * 10));

export class StoreReportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function googleExternalTransactionBody(row: StoreReportRow): Record<string, unknown> {
  const pre = num(row.amount_pre_tax_minor);
  const tax = num(row.tax_minor) ?? 0;
  if (pre === null || !row.currency || !row.tax_country) throw new StoreReportError("REPORT_DATA_INCOMPLETE");
  const base = {
    originalPreTaxAmount: { currency: row.currency, priceMicros: micros(pre) },
    originalTaxAmount: { currency: row.currency, priceMicros: micros(tax) },
    transactionTime: new Date(row.transaction_at).toISOString(),
    userTaxAddress: { regionCode: row.tax_country },
  };
  if (row.report_kind === "google_initial") {
    if (!row.store_token) throw new StoreReportError("REPORT_TOKEN_MISSING");
    return { ...base, recurringTransaction: { externalTransactionToken: row.store_token, externalSubscription: { subscriptionType: "RECURRING" } } };
  }
  if (row.report_kind === "google_renewal") {
    if (!row.initial_external_transaction_id) throw new StoreReportError("REPORT_INITIAL_MISSING");
    return { ...base, recurringTransaction: { initialExternalTransactionId: row.initial_external_transaction_id, externalSubscription: { subscriptionType: "RECURRING" } } };
  }
  throw new StoreReportError("REPORT_KIND_UNSUPPORTED");
}

export function googleRefundBody(row: StoreReportRow): Record<string, unknown> {
  const pre = num(row.amount_pre_tax_minor);
  if (pre === null || !row.currency) throw new StoreReportError("REPORT_DATA_INCOMPLETE");
  return {
    refundTime: new Date(row.transaction_at).toISOString(),
    partialRefund: { refundId: row.external_transaction_id, refundPreTaxAmount: { currency: row.currency, priceMicros: micros(pre) } },
  };
}

/** externalPurchaseId z Apple tokenu (base64 JSON). Tvar tokenu NEOVERENÝ → fail closed. */
export function appleExternalPurchaseId(token: string | null): string {
  if (!token) throw new StoreReportError("REPORT_TOKEN_MISSING");
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as { externalPurchaseId?: unknown };
    if (typeof decoded.externalPurchaseId === "string" && decoded.externalPurchaseId) return decoded.externalPurchaseId;
  } catch {
    // padne nižšie
  }
  throw new StoreReportError("APPLE_TOKEN_UNDECODABLE");
}

const uuidFromHex = (hex: string) =>
  /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : hex;

export function appleExternalPurchaseReport(row: StoreReportRow): Record<string, unknown> {
  const externalPurchaseId = appleExternalPurchaseId(row.store_token);
  const requestIdentifier = uuidFromHex(row.external_transaction_id);
  if (row.report_kind === "apple_no_line_item") {
    return { requestIdentifier, externalPurchaseId, status: "NO_LINE_ITEM", lineItems: [] };
  }
  if (row.report_kind === "apple_refund") throw new StoreReportError("APPLE_REFUND_SCHEMA_UNVERIFIED");
  const pre = num(row.amount_pre_tax_minor);
  const tax = num(row.tax_minor) ?? 0;
  const taxCountry = row.tax_country ? ISO3[row.tax_country] : undefined;
  if (pre === null || !row.currency || !taxCountry || !row.period_start || !row.period_end) {
    throw new StoreReportError("REPORT_DATA_INCOMPLETE");
  }
  const start = Date.parse(row.period_start);
  const end = Date.parse(row.period_end);
  return {
    requestIdentifier,
    externalPurchaseId,
    status: "LINE_ITEM",
    lineItems: [
      {
        lineItemId: row.external_transaction_id,
        ...(row.report_kind === "apple_renewal" && row.initial_external_transaction_id
          ? { referenceLineItemId: row.initial_external_transaction_id }
          : {}),
        creationDate: Date.parse(row.transaction_at),
        eventType: "BUY",
        productType: "SUBSCRIPTION",
        subscriptionEvent: row.report_kind === "apple_renewal" ? "RENEWAL" : "SUBSCRIPTION_START",
        subscriptionStartDate: start,
        subscriptionEndDate: end,
        subscriptionDaysOfPaidService: Math.max(1, Math.round((end - start) / 86_400_000)),
        pricingCurrency: row.currency,
        amountTaxExclusive: millis(pre),
        amountTaxInclusive: millis(pre + tax),
        taxAmount: millis(tax),
        taxCountry,
        productIdentifier: row.product_id ?? "esblu_subscription",
        quantity: 1,
      },
    ],
  };
}

export async function sendStoreReport(row: StoreReportRow, apis: { google: GooglePlayApi | null; apple: AppleStoreApi | null }): Promise<void> {
  if (row.store === "google") {
    if (!apis.google) throw new StoreReportError("NOT_CONFIGURED");
    if (row.report_kind === "google_refund") {
      if (!row.initial_external_transaction_id) throw new StoreReportError("REPORT_INITIAL_MISSING");
      await apis.google.refundExternalTransaction(row.initial_external_transaction_id, googleRefundBody(row));
      return;
    }
    await apis.google.createExternalTransaction(row.external_transaction_id, googleExternalTransactionBody(row));
    return;
  }
  if (!apis.apple) throw new StoreReportError("NOT_CONFIGURED");
  await apis.apple.sendExternalPurchaseReport(appleExternalPurchaseReport(row));
}
