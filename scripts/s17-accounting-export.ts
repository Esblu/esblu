// =============================================================================
// S17 (sandbox harness) — mesačný účtovný export BEZ prihlásenia v prehliadači.
//
// Spúšťa ho IBA scripts/stripe-local-sandbox.ps1 -Step s17 (okno 2) na PC operátora:
//   node --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs \
//     scripts/s17-accounting-export.ts --month YYYY-MM --out-dir <lokálny priečinok> \
//     [--invoice in_...] [--payment-intent pi_...]
// Používa TEN ISTÝ kód aplikácie ako admin route app/api/billing/admin/accounting-export:
//   importStripeBalanceTransactions (StripeTestProvider → každý request s pripnutou `Stripe-Version`),
//   RPC esblu_billing_accounting_export (service_role) a buildAccountingCsv.
// Poistky: iba staging Supabase (cjbdijbbcujvmrzezusd), nikdy produkcia; iba Stripe test kľúč; CSV iba do
// zadaného lokálneho priečinka mimo repozitára a mimo OneDrive. Na stdout ide iba nesúkromný súhrn
// (počty, sumy v centoch, Stripe ID) v riadku `S17_RESULT {json}` — žiadne kľúče, mená ani e-maily.
// Env: STRIPE_API_KEY (sk_/rk_/rkcs_test_), ESBLU_QA_SERVICE_ROLE (staging service_role), S17_SUPABASE_URL.
// =============================================================================

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildAccountingCsv, importStripeBalanceTransactions, monthRange, type ImportResult } from "@/lib/billing/accounting-export";
import { StripeTestProvider } from "@/lib/billing/providers/stripe";
import { STRIPE_API_VERSION } from "@/lib/billing/stripe-api-version";

const STAGING_REF = "cjbdijbbcujvmrzezusd";
const PROD_REF = "fkpgvgvsmbpieduoatrt";

type Row = Record<string, unknown>;

function emit(result: Record<string, unknown>): void {
  // synchrónne (process.exit po asynchrónnom zápise do rúry by výstup na Windows mohol orezať)
  writeSync(1, `S17_RESULT ${JSON.stringify(result)}\n`);
}

function fail(code: string): never {
  emit({ ok: false, code });
  process.exit(2);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const words = (v: unknown): string[] => text(v).split(/\s+/).filter(Boolean);

function jwtPayload(token: string): Row | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const month = arg("month") ?? "";
  const range = monthRange(month);
  if (!range) fail("INVALID_MONTH");
  const outDirRaw = arg("out-dir");
  if (!outDirRaw || !path.isAbsolute(outDirRaw)) fail("OUT_DIR_REQUIRED");
  const outDir = path.resolve(outDirRaw);
  if (/onedrive/i.test(outDir)) fail("OUT_DIR_ONEDRIVE_FORBIDDEN");
  const rel = path.relative(process.cwd(), outDir);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) fail("OUT_DIR_INSIDE_REPO_FORBIDDEN");
  const invoiceId = arg("invoice");
  const paymentIntentId = arg("payment-intent");
  if (invoiceId && !/^in_[A-Za-z0-9_]+$/.test(invoiceId)) fail("INVALID_INVOICE_ID");
  if (paymentIntentId && !/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) fail("INVALID_PAYMENT_INTENT_ID");

  // --- poistky prostredia ----------------------------------------------------
  const supabaseUrl = (process.env.S17_SUPABASE_URL ?? "").trim();
  let host = "";
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    fail("SUPABASE_URL_INVALID");
  }
  if (supabaseUrl.includes(PROD_REF)) fail("PRODUCTION_SUPABASE_FORBIDDEN");
  if (host !== `${STAGING_REF}.supabase.co`) fail("SUPABASE_NOT_STAGING");
  const serviceRole = (process.env.ESBLU_QA_SERVICE_ROLE ?? "").trim();
  if (serviceRole.length < 20) fail("SERVICE_ROLE_MISSING");
  if (serviceRole.startsWith("eyJ")) {
    const payload = jwtPayload(serviceRole);
    if (!payload || payload.ref !== STAGING_REF) fail("SERVICE_ROLE_NOT_STAGING");
    if (payload.role !== "service_role") fail("SERVICE_ROLE_WRONG_ROLE");
  }
  const stripeKey = (process.env.STRIPE_API_KEY ?? "").trim();
  if (/^(sk|rk|rkcs)_live_/.test(stripeKey)) fail("STRIPE_LIVE_KEY_FORBIDDEN");
  if (!/^(sk|rk|rkcs)_test_[A-Za-z0-9]+$/.test(stripeKey)) fail("STRIPE_TEST_KEY_MISSING");

  // --- import balance transactions (kód aplikácie, pripnutá verzia) --------------
  const provider = new StripeTestProvider({ secretKey: stripeKey, webhookSecret: undefined, apiVersion: undefined });
  if (provider.apiVersion !== STRIPE_API_VERSION) fail("STRIPE_API_VERSION_NOT_PINNED");
  const admin = createClient(supabaseUrl, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

  let imported: ImportResult;
  try {
    imported = await importStripeBalanceTransactions(admin, provider, "test", range);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]{3,60}$/.test(error.message) ? error.message : "LEDGER_IMPORT_FAILED";
    fail(code);
  }

  // --- export (rovnaké RPC ako admin route; actor = null → operátorský beh S17) --
  const { data, error } = await admin.rpc("esblu_billing_accounting_export", {
    p_environment: "test",
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_actor: null,
  });
  if (error) fail("EXPORT_FAILED");
  const rows: Row[] = (Array.isArray(data) ? data : []).filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
  const csv = buildAccountingCsv(rows);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const fileName = `esblu-billing-test-${month}-s17-${stamp}.csv`;
  writeFileSync(path.join(outDir, fileName), csv, { encoding: "utf8" });

  // --- nesúkromný súhrn ----------------------------------------------------------
  const byType: Record<string, number> = {};
  for (const r of rows) {
    const t = text(r.record_type) || "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const bts = rows.filter((r) => r.record_type === "balance_transaction");
  const refundBts = bts.filter((r) => r.bt_type === "refund" || r.bt_type === "payment_refund");
  const payoutIds = new Set(bts.flatMap((r) => words(r.payout_ids)));
  const invoiceRow = invoiceId ? rows.find((r) => r.record_type === "invoice" && r.stripe_document_id === invoiceId) ?? null : null;
  const creditRows = invoiceId ? rows.filter((r) => r.record_type === "credit_note" && r.related_invoice_id === invoiceId) : [];
  const piBts = paymentIntentId ? bts.filter((r) => r.payment_intent_id === paymentIntentId) : [];

  emit({
    ok: true,
    month,
    api_version: provider.apiVersion,
    import: imported,
    csv_file: fileName,
    csv_sha256: createHash("sha256").update(csv, "utf8").digest("hex"),
    csv_bytes: Buffer.byteLength(csv, "utf8"),
    rows: rows.length,
    rows_by_type: byType,
    totals_minor: {
      gross: bts.reduce((s, r) => s + num(r.gross_minor), 0),
      fee: bts.reduce((s, r) => s + num(r.fee_minor), 0),
      net: bts.reduce((s, r) => s + num(r.net_minor), 0),
      refunds: refundBts.reduce((s, r) => s + num(r.gross_minor), 0),
      refund_count: refundBts.length,
    },
    payouts: { linked_transactions: bts.filter((r) => words(r.payout_ids).length > 0).length, distinct: payoutIds.size, present: payoutIds.size > 0 },
    invoice: invoiceRow
      ? {
          found: true,
          status: invoiceRow.status ?? null,
          total_minor: invoiceRow.total_minor ?? null,
          gross_minor: invoiceRow.gross_minor ?? null,
          fee_minor: invoiceRow.fee_minor ?? null,
          net_minor: invoiceRow.net_minor ?? null,
          bt_ids: words(invoiceRow.bt_ids),
          payout_ids: words(invoiceRow.payout_ids),
          payment_intent_id: invoiceRow.payment_intent_id ?? null,
          pdf_archived: invoiceRow.pdf_archived === true,
          pdf_sha256: invoiceRow.pdf_sha256 ?? null,
          company_linked: invoiceRow.company_linked === true,
          customer_company_id: invoiceRow.customer_company_id ?? null,
          customer_legal_name_present: text(invoiceRow.customer_legal_name).length > 0,
        }
      : { found: false },
    credit_notes: creditRows.map((r) => ({
      id: r.stripe_document_id ?? null,
      total_minor: r.total_minor ?? null,
      gross_minor: r.gross_minor ?? null,
      fee_minor: r.fee_minor ?? null,
      net_minor: r.net_minor ?? null,
      bt_ids: words(r.bt_ids),
    })),
    payment_intent_transactions: piBts.map((r) => ({
      bt_id: r.bt_ids ?? null,
      type: r.bt_type ?? null,
      gross_minor: r.gross_minor ?? null,
      fee_minor: r.fee_minor ?? null,
      net_minor: r.net_minor ?? null,
      payout_present: words(r.payout_ids).length > 0,
    })),
  });
}

main().catch(() => fail("UNEXPECTED_ERROR"));
