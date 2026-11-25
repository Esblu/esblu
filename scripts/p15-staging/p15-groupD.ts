// =============================================================================
// P1-5 skupina D — vstup runnera skutočného výmazu JEDNEJ syntetickej firmy (t1 | t2 | perf) na stagingu esblu-test.
// Spúšťa vlastník cez release-backups/p15/run-p15-groupD.ps1 až po samostatnom schválení každej firmy.
// Poradie poistiek PRED sieťou: čisté prostredie Node → odtlačky lokálnych súborov a závislostí → allowlist → URL →
// formát kľúča. Všetky požiadavky idú cez deletionGuardedFetch (groupD-core.ts). Žiadne volanie eFaktura.sk.
// =============================================================================
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildTerminationAck } from "../../lib/company-termination-ack.ts";
import { orchestrateAccountDeletion, runCleanupJob } from "../../lib/account-deletion-orchestrator.ts";
import { supabaseDeletionDeps, supabaseTerminationDeps } from "../../lib/account-deletion-deps.ts";
import { parseStorageTargets } from "../../lib/account-deletion-storage.ts";
import { loadManifest, Runner, Stop, validateStagingUrl, verifyDependencyLock, verifyLocalIntegrity, type Backend } from "./runner-core.ts";
import { deletionGuardedFetch, listAll, newScope, realReauth, resolveDeletionTarget, type Target } from "./groupD-core.ts";
import { runAuthTest, runCleanupOnly, runDeletionTarget, type DDeps } from "./groupD-runner.ts";
import { assertCleanProcessD, D_EXPECTED_LOCAL_SHA256 } from "./groupD-pins.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLISHABLE_KEY = "sb_publishable_AQ4QLRJBTcEPp__yMrh4bg_MUY3N-Ma"; // verejný kľúč stagingu (iba verifyOtp)

function fail(msg: string, code = 2): never {
  console.error(`STOP: ${msg}`);
  process.exit(code);
}

let target: Target;
try {
  assertCleanProcessD(process.env, process.execArgv);
  verifyLocalIntegrity(ROOT, D_EXPECTED_LOCAL_SHA256);
  verifyDependencyLock(ROOT);
  target = resolveDeletionTarget(process.env.ESBLU_P15D_TARGET ?? "");
  const inject = process.env.ESBLU_P15D_INJECT ?? "";
  if (inject && !(target.key === "t2" && inject === "einvoice-documents")) throw new Stop("simulovaný výpadok je povolený iba pre t2 / einvoice-documents");
} catch (error) {
  fail(error instanceof Error ? error.message : "kontrola prostredia zlyhala");
}

if (process.env.ESBLU_P15_PREFLIGHT === "1") {
  try {
    validateStagingUrl(process.env.ESBLU_STAGING_SUPABASE_URL ?? "");
    new Runner(null as unknown as Backend, loadManifest(ROOT));
  } catch (error) {
    fail(error instanceof Error ? error.message : "preflight");
  }
  if (process.env.ESBLU_STAGING_SERVICE_ROLE_KEY) fail("preflight nesmie mať kľúč v prostredí");
  console.log(`PREFLIGHT_OK: cieľ ${target.name}; prostredie, odtlačky, allowlist a URL overené; žiadna sieť, žiadny kľúč`);
  process.exit(0);
}

let url: string;
try {
  url = validateStagingUrl(process.env.ESBLU_STAGING_SUPABASE_URL ?? "");
} catch (error) {
  fail(error instanceof Error ? error.message : "URL");
}
const key = process.env.ESBLU_STAGING_SERVICE_ROLE_KEY ?? "";
if (!/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(key)) fail("kľúč nemá formát sb_secret_");

const scope = newScope(null);
const nativeFetch = globalThis.fetch;
const dFetch = deletionGuardedFetch(scope, nativeFetch);
globalThis.fetch = dFetch;
const clientOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: dFetch } };
const admin = createClient(url, key, clientOpts);
const anon = createClient(url, PUBLISHABLE_KEY, clientOpts);

const read: DDeps["read"] = async (table, filter, select = "*") => {
  let q = admin.from(table).select(select);
  for (const [col, expr] of Object.entries(filter)) {
    const i = expr.indexOf(".");
    q = q.filter(col, expr.slice(0, i), expr.slice(i + 1));
  }
  const { data, error } = await q.limit(10000);
  if (error) throw new Stop(`čítanie ${table}: ${error.code ?? "?"}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
};
const rpc: DDeps["rpc"] = async (fn, args) => {
  const { data, error } = await admin.rpc(fn, args);
  return { data, error: error ? { code: error.code, message: error.message } : null };
};
const list: DDeps["list"] = (bucket, prefix) => listAll(async (b, p) => {
  const { data, error } = await admin.storage.from(b).list(p, { limit: 1000 });
  if (error) throw new Stop(`Storage list ${b}: ${error.message.slice(0, 60)}`);
  return (data ?? []).map((e) => ({ name: e.name, id: e.id ?? null }));
}, bucket, prefix);

const backend: Backend = {
  async selectIn(table, column, values, from, to, orderById) {
    let q = admin.from(table).select("*");
    q = values.length === 1 ? q.eq(column, values[0]) : q.in(column, values);
    if (orderById) q = q.order("id", { ascending: true });
    const { data, error } = await q.range(from, to);
    return { rows: (data ?? []) as Record<string, unknown>[], error: error ? { code: error.code, message: error.message } : undefined };
  },
  rpc,
  async download(bucket, p) {
    const { data, error } = await admin.storage.from(bucket).download(p);
    if (!error && data) return { bytes: new Uint8Array(await data.arrayBuffer()) };
    const e = error as { status?: number; statusCode?: string; message?: string } | null;
    if (e && (e.status === 404 || e.statusCode === "404" || (e.status === 400 && /not.?found/i.test(e.message ?? "")))) return { bytes: null };
    return { bytes: null, error: `${e?.status ?? "?"}:${(e?.message ?? "unknown").slice(0, 80)}` };
  },
  async upload() {
    throw new Stop("skupina D nenahráva súbory");
  },
};
const exportRunner = new Runner(backend, loadManifest(ROOT));

const deps: DDeps = {
  scope, read, rpc, list,
  async exportRefresh(t) {
    const r = await exportRunner.runExport(`DX.${t.key}`, t.key);
    return { status: r.status === "completed" ? (await exportRunner.runState(r.runId)) === "completed:-" ? "completed" : "state_mismatch" : r.status, runId: r.runId };
  },
  async reauth(t) {
    // skutočný Supabase Auth: generate_link (bez e-mailu) → verify → GET /auth/v1/user → odhlásenie (groupD-core)
    return realReauth({ admin: admin as never, anon: anon as never }, t);
  },
  buildAck(t) {
    return buildTerminationAck({ authorityConfirmed: true, locale: "sk", companyId: t.companyId, headers: new Headers({ "user-agent": "esblu-p15-groupD-runner/1" }) }) as unknown as Record<string, unknown> | null;
  },
  async terminate(t, ack) {
    const base = supabaseTerminationDeps(admin, "exported", ack as never);
    const wrapped = {
      ...base,
      async commit(r: Parameters<typeof base.commit>[0]) {
        const c = await base.commit(r);
        if (c.ok) scope.jobId = c.jobId;
        return c;
      },
    };
    return (await orchestrateAccountDeletion(wrapped, { kind: "owner", userId: t.ownerId, companyId: t.companyId, deleteAccount: true })) as never;
  },
  async retryJob(row, t) {
    if (row.company_id !== t.companyId || row.id !== scope.jobId) throw new Stop("retry: job nepatrí aktívnemu cieľu");
    const terminationCompanyId = row.termination_id && row.company_id ? String(row.company_id) : null;
    return runCleanupJob(supabaseDeletionDeps(admin), {
      id: String(row.id), userId: String(row.user_id), terminationCompanyId,
      storageTargets: parseStorageTargets(row.storage_targets, { terminationCompanyId }),
      storagePending: row.storage_status === "pending", authPending: row.auth_status === "pending", attempts: Number(row.attempts),
    });
  },
  now: () => new Date(),
  log: (s) => console.log(s),
};

const mode = process.env.ESBLU_P15D_MODE ?? "delete";
if (mode !== "delete" && mode !== "cleanup" && mode !== "auth-test") fail("ESBLU_P15D_MODE musí byť delete, cleanup alebo auth-test");
if (mode === "auth-test" && (process.env.ESBLU_P15D_INJECT ?? "")) fail("auth-test nepovoľuje simulovaný výpadok");
const { exitCode } = mode === "auth-test"
  ? await runAuthTest(deps, target.key)
  : mode === "cleanup"
  ? await runCleanupOnly(deps, target.key)
  : await runDeletionTarget(deps, target.key, process.env.ESBLU_P15D_INJECT ? { injectStorageFailureBucket: "einvoice-documents" } : {});
console.log(JSON.stringify({ network: scope.log.filter((l) => l.startsWith("DENY") || l.startsWith("INJECT")) }));
process.exit(exitCode);
