import { buildAccountingCsv, importStripeBalanceTransactions, monthRange } from "@/lib/billing/accounting-export";
import { getStripeReportingProvider } from "@/lib/billing/server";
import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getRequestLocale } from "@/lib/i18n/request-locale";

// -----------------------------------------------------------------------------
// GET /api/billing/admin/accounting-export?month=YYYY-MM[&environment=test|live][&refresh=1]
// P4: mesačný účtovný export (CSV) Stripe faktúr, dobropisov a balance transactions (hrubá suma,
// poplatok Stripe, čistá suma, výplata) pre účtovníčku.
//
// Prístup: iba prihlásený používateľ (Bearer JWT) zapísaný v public.billing_ops_admins (zapisuje ho
// iba operátor cez SQL). Overenie robí DB (esblu_billing_is_ops_admin z JWT), nie klient.
// refresh=1 → najprv read-only import balance transactions a výplat zo Stripe (reportingový kľúč;
// bez neho sa exportujú iba dáta v DB a hlavička X-Esblu-Ledger-Import = not_configured).
// Každý export sa zapíše do billing_accounting_export_log. Odpoveď nie je cacheovaná.
// CSV neobsahuje meno, e-mail ani adresu odberateľa.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const month = url.searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) return Response.json({ success: false, code: "INVALID_MONTH" }, { status: 400 });

  const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
  if (error || !user) return Response.json({ success: false, code: "NOT_AUTHENTICATED" }, { status: 401 });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const { data: isAdmin, error: adminError } = await getUserScopedSupabaseClient(token).rpc("esblu_billing_is_ops_admin");
  if (adminError || isAdmin !== true) return Response.json({ success: false, code: "FORBIDDEN" }, { status: 403 });

  const admin = getSupabaseAdmin();
  let environment = url.searchParams.get("environment");
  if (environment !== null && environment !== "test" && environment !== "live") {
    return Response.json({ success: false, code: "INVALID_ENVIRONMENT" }, { status: 400 });
  }
  if (!environment) {
    const { data: config, error: configError } = await admin.from("billing_runtime_config").select("environment").maybeSingle();
    if (configError || (config?.environment !== "test" && config?.environment !== "live")) {
      return Response.json({ success: false, code: "CONFIG_READ_FAILED" }, { status: 500 });
    }
    environment = config.environment as "test" | "live";
  }
  const env = environment as "test" | "live";

  let importStatus = "skipped";
  if (url.searchParams.get("refresh") === "1") {
    const reporting = getStripeReportingProvider(env);
    if (!reporting) importStatus = "not_configured";
    else {
      try {
        const r = await importStripeBalanceTransactions(admin, reporting, env, range);
        importStatus = r.truncated ? "partial" : "ok";
      } catch {
        importStatus = "failed";
      }
    }
  }

  const { data, error: exportError } = await admin.rpc("esblu_billing_accounting_export", {
    p_environment: env,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_actor: user.id,
  });
  if (exportError) return Response.json({ success: false, code: "EXPORT_FAILED" }, { status: 500 });
  const csv = buildAccountingCsv(Array.isArray(data) ? data : []);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="esblu-billing-${env}-${month}.csv"`,
      "Cache-Control": "no-store",
      "X-Esblu-Ledger-Import": importStatus,
    },
  });
}
