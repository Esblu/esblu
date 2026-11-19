// =============================================================================
// P4 (2026-11-23) — mesačný účtovný export Stripe dokladov a platieb (CSV pre účtovníčku).
//
//   importStripeBalanceTransactions — read-only import `GET /v1/balance_transactions` (hrubá suma,
//     poplatok Stripe, čistá suma, zdroj → PaymentIntent) a väzby na výplaty (`GET /v1/payouts` +
//     `balance_transactions?payout=`) do billing_balance_transactions. Kľúč: samostatný read-only
//     reportingový kľúč (live: STRIPE_LIVE_REPORTING_KEY), nie runtime kľúč.
//   buildAccountingCsv — CSV (UTF-8 s BOM, oddeľovač `;`, desatinná čiarka nie — bodka, sumy v menových
//     jednotkách) z esblu_billing_accounting_export. Ochrana pred CSV/formula injection v textových poliach.
// Export obsahuje údaje z dokladu (číslo, dátum, sumy, DPH polia, krajina a IČ DPH odberateľa tak, ako sú
// na doklade), Stripe ID a identifikáciu odberateľa (firmy) z NEMENNÉHO snapshotu účtovnej kópie
// (customer_company_id, obchodné meno, IČO, DIČ, IČ DPH, registrácia, fakturačná adresa, krajina) —
// platí aj po ukončení firmy (company_id = null, company_linked = no). Žiadny e-mail, IBAN ani údaje
// osoby z objektu zákazníka v Stripe.
// =============================================================================

import type { BillingDb } from "@/lib/billing/pipeline";

type Obj = Record<string, unknown>;

export interface StripeReportingSource {
  listBalanceTransactions(params: { createdGte?: number; createdLt?: number; payout?: string; startingAfter?: string; limit?: number }): Promise<{ data: Obj[]; hasMore: boolean }>;
  listPayouts(params: { createdGte?: number; createdLt?: number; startingAfter?: string; limit?: number }): Promise<{ data: Obj[]; hasMore: boolean }>;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (isObj(v) ? str(v.id) : null);
const iso = (v: unknown): string | null => (typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null);
const only = (v: string | null, re: RegExp) => (v && re.test(v) ? v : null);

/** Kalendárny mesiac `YYYY-MM` → [from, to) v UTC. */
export function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 2025 || y > 2100) return null;
  return { from: new Date(Date.UTC(y, mo - 1, 1)), to: new Date(Date.UTC(y, mo, 1)) };
}

export function balanceTransactionRow(txn: Obj, payout?: { id: string; arrival: string | null }): Obj | null {
  const id = only(str(txn.id), /^txn_[A-Za-z0-9_]+$/);
  const type = only(str(txn.type), /^[a-z_]{1,60}$/);
  if (!id || !type || typeof txn.amount !== "number" || typeof txn.net !== "number") return null;
  const source = txn.source;
  const sourceObj = isObj(source) ? source : null;
  const sourceId = only(idOf(source), /^[A-Za-z0-9_]{3,255}$/);
  let paymentIntent: string | null = null;
  let charge: string | null = null;
  if (sourceObj) {
    paymentIntent = idOf(sourceObj.payment_intent);
    charge = sourceObj.object === "charge" ? str(sourceObj.id) : idOf(sourceObj.charge);
  }
  return {
    bt_id: id,
    type,
    reporting_category: only(str(txn.reporting_category), /^[a-z_]{1,60}$/),
    source_id: sourceId,
    payment_intent_id: only(paymentIntent, /^pi_[A-Za-z0-9_]+$/),
    charge_id: only(charge, /^(ch|py)_[A-Za-z0-9_]+$/),
    amount_minor: Math.trunc(txn.amount),
    fee_minor: typeof txn.fee === "number" ? Math.trunc(txn.fee) : 0,
    net_minor: Math.trunc(txn.net),
    currency: (str(txn.currency) ?? "").toUpperCase(),
    status: only(str(txn.status), /^[a-z_]{1,30}$/),
    created_at: iso(txn.created),
    available_on: iso(txn.available_on),
    payout_id: payout ? only(payout.id, /^po_[A-Za-z0-9_]+$/) : null,
    payout_arrival_date: payout?.arrival ?? null,
  };
}

export type ImportResult = { transactions: number; payouts: number; payoutLinks: number; truncated: boolean };

export async function importStripeBalanceTransactions(
  db: BillingDb,
  source: StripeReportingSource,
  environment: "test" | "live",
  range: { from: Date; to: Date },
  options: { maxPages?: number; payoutWindowDays?: number; now?: () => Date } = {},
): Promise<ImportResult> {
  const maxPages = options.maxPages ?? 30;
  const now = (options.now ?? (() => new Date()))();
  const out: ImportResult = { transactions: 0, payouts: 0, payoutLinks: 0, truncated: false };
  let pages = 0;
  const save = async (rows: Obj[]) => {
    if (rows.length === 0) return;
    const r = await db.rpc("esblu_billing_upsert_balance_transactions", { p_environment: environment, p_rows: rows });
    if (r.error) throw new Error("LEDGER_UPSERT_FAILED");
  };
  const gte = Math.floor(range.from.getTime() / 1000);
  const lt = Math.floor(range.to.getTime() / 1000);

  // 1) transakcie obdobia
  let after: string | undefined;
  for (;;) {
    if (pages++ >= maxPages) { out.truncated = true; break; }
    const page = await source.listBalanceTransactions({ createdGte: gte, createdLt: lt, startingAfter: after, limit: 100 });
    const rows = page.data.map((t) => balanceTransactionRow(t)).filter((r): r is Obj => r !== null);
    await save(rows);
    out.transactions += rows.length;
    if (!page.hasMore || page.data.length === 0) break;
    after = str(page.data[page.data.length - 1].id) ?? undefined;
  }

  // 2) výplaty vytvorené od začiatku obdobia do +N dní (transakcie obdobia sa vyplácajú neskôr)
  const payoutLt = Math.min(lt + (options.payoutWindowDays ?? 40) * 86_400, Math.floor(now.getTime() / 1000));
  let payoutAfter: string | undefined;
  for (;;) {
    if (pages++ >= maxPages) { out.truncated = true; break; }
    const page = await source.listPayouts({ createdGte: gte, createdLt: payoutLt, startingAfter: payoutAfter, limit: 100 });
    for (const payout of page.data) {
      const id = only(str(payout.id), /^po_[A-Za-z0-9_]+$/);
      if (!id || (payout.status !== "paid" && payout.status !== "in_transit")) continue;
      out.payouts++;
      const arrival = iso(payout.arrival_date);
      let txAfter: string | undefined;
      for (;;) {
        if (pages++ >= maxPages) { out.truncated = true; break; }
        const txPage = await source.listBalanceTransactions({ payout: id, startingAfter: txAfter, limit: 100 });
        const rows = txPage.data.map((t) => balanceTransactionRow(t, { id, arrival })).filter((r): r is Obj => r !== null);
        await save(rows);
        out.payoutLinks += rows.length;
        if (!txPage.hasMore || txPage.data.length === 0) break;
        txAfter = str(txPage.data[txPage.data.length - 1].id) ?? undefined;
      }
      if (out.truncated) break;
    }
    if (out.truncated || !page.hasMore || page.data.length === 0) break;
    payoutAfter = str(page.data[page.data.length - 1].id) ?? undefined;
  }
  return out;
}

export const ACCOUNTING_CSV_COLUMNS = [
  "record_type", "document_date", "document_number", "stripe_document_id", "related_invoice_number", "related_invoice_id",
  "status", "legal_issuer", "currency", "total_excl_tax", "tax", "total", "customer_country", "customer_tax_ids",
  "customer_tax_exempt", "tax_details", "service_period_start", "service_period_end", "paid_at", "payment_intent_id",
  "gross", "stripe_fee", "net", "balance_transaction_ids", "bt_type", "reporting_category", "payout_ids", "payout_arrival_date",
  "pdf_archived", "pdf_sha256", "pdf_storage_path",
  "customer_company_id", "customer_legal_name", "customer_ico", "customer_dic", "customer_ic_dph",
  "customer_registration_id", "customer_address", "customer_billing_country", "company_linked",
  "provider_customer_id", "provider_subscription_id",
] as const;

const MONEY_FIELDS: Record<string, string> = {
  total_excl_tax: "total_excl_tax_minor", tax: "tax_minor", total: "total_minor",
  gross: "gross_minor", stripe_fee: "fee_minor", net: "net_minor",
};
const RENAMED: Record<string, string> = { balance_transaction_ids: "bt_ids" };
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

export function formatMinor(minor: unknown, currency: unknown): string {
  if (typeof minor !== "number" || !Number.isFinite(minor)) return "";
  if (typeof currency === "string" && ZERO_DECIMAL.has(currency.toUpperCase())) return String(Math.trunc(minor));
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Textová bunka: úvodzovky + ochrana pred formula injection (=, +, -, @, tab, CR). */
export function csvText(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") s = String(value);
  else s = JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function taxIdsText(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v.filter(isObj).map((t) => `${str(t.type) ?? ""}:${str(t.value) ?? ""}`).join(" ");
}

/** Fakturačná adresa zo snapshotu → jeden riadok („ulica, ulica 2, PSČ mesto, krajina“). */
export function addressText(v: unknown): string {
  if (!isObj(v)) return "";
  const city = [str(v.postal_code), str(v.city)].filter(Boolean).join(" ");
  return [str(v.line1), str(v.line2), city || null, str(v.country_code)].filter(Boolean).join(", ");
}

export function buildAccountingCsv(rows: unknown[]): string {
  const lines = [ACCOUNTING_CSV_COLUMNS.join(";")];
  for (const raw of rows) {
    if (!isObj(raw)) continue;
    const cells = ACCOUNTING_CSV_COLUMNS.map((col) => {
      if (MONEY_FIELDS[col]) return formatMinor(raw[MONEY_FIELDS[col]], raw.currency);
      if (col === "customer_tax_ids") return csvText(taxIdsText(raw.customer_tax_ids));
      if (col === "tax_details") return csvText(Array.isArray(raw.tax_details) && raw.tax_details.length ? raw.tax_details : "");
      if (col === "pdf_archived") return raw.pdf_archived === true ? "yes" : raw.record_type === "balance_transaction" ? "" : "no";
      if (col === "customer_address") return csvText(addressText(raw.customer_address));
      if (col === "company_linked") return raw.record_type === "balance_transaction" ? "" : raw.company_linked === true ? "yes" : "no";
      return csvText(raw[RENAMED[col] ?? col]);
    });
    lines.push(cells.join(";"));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
