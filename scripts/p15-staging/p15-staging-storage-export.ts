// =============================================================================
// P1-5 skupina C — vstup runnera (Storage + export) pre staging esblu-test, IBA syntetické firmy QA-P15-*.
// Spúšťa vlastník cez release-backups/p15/run-p15-groupC.ps1; logika a poistky sú v runner-core.ts.
// Poradie poistiek PRED prvou sieťovou požiadavkou: F-5 čisté prostredie Node → F-4 odtlačky lokálnych súborov →
// F-3 presná URL projektu → formát kľúča → F-6 manifest. Žiadny výmaz, žiadne volanie eFaktura.sk ani Stripe.
// =============================================================================
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  assertCleanProcess,
  guardedFetch,
  loadManifest,
  Runner,
  Stop,
  validateStagingUrl,
  verifyLocalIntegrity,
  type Backend,
} from "./runner-core.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg: string, code = 2): never {
  console.error(`STOP: ${msg}`);
  process.exit(code);
}

try {
  assertCleanProcess(process.env, process.execArgv);
  verifyLocalIntegrity(ROOT);
} catch (error) {
  fail(error instanceof Error ? error.message : "kontrola prostredia zlyhala");
}

let url: string;
try {
  url = validateStagingUrl(process.env.ESBLU_STAGING_SUPABASE_URL ?? "");
} catch (error) {
  fail(error instanceof Error ? error.message : "URL");
}
const key = process.env.ESBLU_STAGING_SERVICE_ROLE_KEY ?? "";
if (!/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(key)) fail("kľúč nemá formát sb_secret_");

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: guardedFetch(fetch) },
});

const backend: Backend = {
  async selectIn(table, column, values, from, to, orderById) {
    let q = admin.from(table).select("*");
    q = values.length === 1 ? q.eq(column, values[0]) : q.in(column, values);
    if (orderById) q = q.order("id", { ascending: true });
    const { data, error } = await q.range(from, to);
    return { rows: (data ?? []) as Record<string, unknown>[], error: error ? { code: error.code, message: error.message } : undefined };
  },
  async rpc(fn, args) {
    const { data, error } = await admin.rpc(fn, args);
    return { data, error: error ? { code: error.code, message: error.message } : null };
  },
  async download(bucket, p) {
    const { data, error } = await admin.storage.from(bucket).download(p);
    if (!error && data) return { bytes: new Uint8Array(await data.arrayBuffer()) };
    const e = error as { status?: number; statusCode?: string; message?: string } | null;
    if (e && (e.status === 404 || e.statusCode === "404" || (e.status === 400 && /not.?found/i.test(e.message ?? "")))) return { bytes: null };
    return { bytes: null, error: `${e?.status ?? "?"}:${(e?.message ?? "unknown").slice(0, 80)}` };
  },
  async upload(bucket, p, bytes, upsert, contentType) {
    const { error } = await admin.storage.from(bucket).upload(p, bytes, { upsert, contentType });
    if (!error) return { status: "uploaded" };
    const e = error as { status?: number; statusCode?: string; message?: string };
    if (!upsert && (e.statusCode === "409" || e.status === 409 || /exist|duplicate/i.test(e.message ?? ""))) return { status: "exists" };
    return { status: "error", error: `${e.status ?? "?"}:${(e.message ?? "unknown").slice(0, 80)}` };
  },
};

let runner: Runner;
try {
  runner = new Runner(backend, loadManifest(ROOT));
} catch (error) {
  fail(error instanceof Stop ? error.message : "manifest");
}
const { exitCode } = await runner.run();
process.exit(exitCode);
