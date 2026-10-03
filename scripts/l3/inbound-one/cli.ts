// =============================================================================
// L3-ONLY CLI: spracovanie presne jedného sandbox inbound dokladu (FA20260004).
// Logika a guardy: ./core.ts. Spúšťa IBA používateľ lokálne.
//
//   Kontrola (bez zápisu, bez ACK — iba čítanie zoznamu u poskytovateľa a DB):
//     npm run l3:inbound-one -- --check
//   Spracovanie + ACK (iba cieľ, iba s výslovným potvrdením):
//     npm run l3:inbound-one -- --run --confirm-document=ebcda9cf-d854-48a3-8d30-dde8970f8c78
//
//   --l3-env=CESTA   externý env súbor mimo repa (default
//                    %USERPROFILE%\Documents\esblu-l3-staging.env / ESBLU_L3_ENV_FILE)
//
// Env sa číta IBA z externého súboru (nie z process.env ani z .env.local) a
// nikam sa nezapisuje. Výstup: iba ID, stavy, kódy, hash a veľkosť — nikdy
// kľúče, XML ani telo odpovede. Chyby sú redigované a bez stack trace.
// =============================================================================
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createRedactor, defaultEnvFile, isInside, parseEnvText, REPO_ROOT, validateStagingEnv } from "../run-local-staging.mjs";
import { getEinvoiceProvider } from "../../../lib/einvoice/provider/index.ts";
import { createSupabaseInboundStore } from "../../../lib/einvoice/inbound/supabase-store.ts";
import { createSupabaseOpsStore } from "../../../lib/einvoice/ops/supabase-store.ts";
import {
  assertL3InboundEnv,
  L3_ACTOR_EMAIL,
  L3_ACTOR_USER_ID,
  L3_ENVIRONMENT,
  L3_INBOUND_TARGET,
  L3_PROVIDER,
  L3Stop,
  runL3InboundOne,
  type L3InboundReadRow,
} from "./core.ts";

const redactor = createRedactor();
const say = (s: string) => process.stdout.write(`${redactor.redact(s)}\n`);
const fail = (s: string) => process.stderr.write(`${redactor.redact(s)}\n`);

type Args = { mode: "check" | "run"; confirm: string | null; envFile: string | null };
export function parseCliArgs(argv: string[]): Args {
  let mode: Args["mode"] | null = null;
  let confirm: string | null = null;
  let envFile: string | null = null;
  for (const a of argv) {
    if (a === "--check") mode = mode === "run" ? (() => { throw new L3Stop("L3_STOP_ARGS_CHECK_AND_RUN"); })() : "check";
    else if (a === "--run") mode = mode === "check" ? (() => { throw new L3Stop("L3_STOP_ARGS_CHECK_AND_RUN"); })() : "run";
    else if (a.startsWith("--confirm-document=")) confirm = a.slice("--confirm-document=".length);
    else if (a.startsWith("--l3-env=")) envFile = a.slice("--l3-env=".length);
    else throw new L3Stop("L3_STOP_UNKNOWN_ARGUMENT");
  }
  if (!mode) throw new L3Stop("L3_STOP_MODE_REQUIRED (--check alebo --run)");
  if (mode === "run" && confirm !== L3_INBOUND_TARGET) throw new L3Stop("L3_STOP_CONFIRM_DOCUMENT_MISMATCH");
  return { mode, confirm, envFile };
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  const envFile = path.resolve(args.envFile || defaultEnvFile(process.env));
  if (isInside(envFile, REPO_ROOT) || path.basename(envFile).toLowerCase().startsWith(".env")) throw new L3Stop("L3_STOP_ENV_FILE_LOCATION");
  if (!existsSync(envFile)) throw new L3Stop("L3_STOP_ENV_FILE_MISSING");
  const { vars, errors: parseErrors } = parseEnvText(readFileSync(envFile, "utf8"));
  for (const v of Object.values(vars)) redactor.add(v);
  if (parseErrors.length) throw new L3Stop(`L3_STOP_ENV_PARSE:${parseErrors.join(";")}`);
  const { errors } = validateStagingEnv(vars);
  if (errors.length) throw new L3Stop(`L3_STOP_ENV_INVALID:\n  - ${errors.join("\n  - ")}`);
  assertL3InboundEnv(vars);

  const runtime = getEinvoiceProvider({
    ESBLU_EINVOICE_PROVIDER: vars.ESBLU_EINVOICE_PROVIDER,
    ESBLU_EINVOICE_ENVIRONMENT: vars.ESBLU_EINVOICE_ENVIRONMENT,
    ESBLU_EFAKTURA_API_KEY: vars.ESBLU_EFAKTURA_API_KEY,
    ESBLU_EFAKTURA_BASE_URL: vars.ESBLU_EFAKTURA_BASE_URL,
    ESBLU_EINVOICE_LIVE_ENABLED: "false",
    VERCEL_ENV: "development",
  });
  if (!runtime || runtime.environment !== L3_ENVIRONMENT || runtime.provider.name !== L3_PROVIDER) throw new L3Stop("L3_STOP_PROVIDER_RUNTIME");

  const admin = createClient(vars.NEXT_PUBLIC_SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const actor = await admin.auth.admin.getUserById(L3_ACTOR_USER_ID);
  if (actor.error || actor.data.user?.email !== L3_ACTOR_EMAIL) throw new L3Stop("L3_STOP_ACTOR_MISMATCH");

  const readInbound = async (pid: string): Promise<L3InboundReadRow | null> => {
    if (pid !== L3_INBOUND_TARGET) throw new L3Stop("L3_STOP_READ_NON_TARGET");
    const { data, error } = await admin
      .from("einvoice_inbound")
      .select("id, company_id, provider, environment, provider_received_id, processing_status, xml_sha256, xml_size_bytes, xml_storage_path, invoice_id, last_error_code, locked_until, acknowledged_at")
      .eq("provider", L3_PROVIDER)
      .eq("environment", L3_ENVIRONMENT)
      .eq("provider_received_id", pid)
      .maybeSingle();
    if (error) throw new L3Stop("L3_STOP_DB_READ");
    return (data as L3InboundReadRow | null) ?? null;
  };

  say(`L3 inbound-one — režim ${args.mode}, cieľ ${L3_INBOUND_TARGET} (staging cjbdijbbcujvmrzezusd, eFaktura sandbox)`);
  const report = await runL3InboundOne(
    { provider: runtime.provider, inbound: createSupabaseInboundStore(admin), ops: createSupabaseOpsStore(admin), readInbound },
    { mode: args.mode, confirmDocument: args.confirm }
  );
  const row = (r: L3InboundReadRow | null) =>
    r ? { id: r.id, status: r.processing_status, xml_sha256: r.xml_sha256, xml_size_bytes: r.xml_size_bytes, invoice_id: r.invoice_id, last_error_code: r.last_error_code, acknowledged_at: r.acknowledged_at ?? null } : null;
  say(JSON.stringify({
    verdict: report.verdict,
    mode: report.mode,
    target: report.target,
    provider_list: { listed: report.listed, target_listed: report.targetListed, target_meta: report.targetMeta, other_pending_untouched: report.otherPending, protected_l2_seen: report.protectedSeen },
    planned_action: report.action,
    registered: report.registered,
    operator: report.operator,
    staging_before: row(report.stagingBefore),
    staging_after: row(report.stagingAfter),
    provider_calls: report.providerCalls,
  }, null, 2));
  return report.verdict.startsWith("STOPPED_AT") ? 3 : 0;
}

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/l3/inbound-one/cli.ts");
if (isCli) {
  const bail = (e: unknown) => {
    fail(`STOP: neočakávaná chyba: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);
  main().then(
    (code) => process.exit(code),
    (e) => {
      fail(`STOP: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(e instanceof L3Stop ? 2 : 1);
    }
  );
}
