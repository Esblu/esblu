// =============================================================================
// P1-5 skupina C — offline testy runnera (F-1 … F-6). PGlite (všetky migrácie + 20261124 zo stagingu, ak je
// v supabase/migrations) + syntetický seed skupiny C + Storage v pamäti, ktorý zrkadlí storage.objects.
// Žiadna sieť, žiadny kľúč.
//   node --experimental-strip-types --no-warnings scripts/p15-staging/runner-tests.ts
// =============================================================================
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  ALLOWED_ORIGIN,
  APPROVED_COMPANIES,
  assertCleanProcess,
  EXPECTED_LOCAL_SHA256,
  guardedFetch,
  loadManifest,
  Runner,
  sha256,
  validateManifest,
  validateStagingUrl,
  verifyLocalIntegrity,
  type Backend,
  type Manifest,
  type Row,
} from "./runner-core.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}
const throwsStop = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof Error && re.test(e.message));
const manifest = loadManifest(ROOT);
const clone = (m: Manifest): Manifest => JSON.parse(JSON.stringify(m));

// ============================================================================= statické poistky
await check("F-3 presná URL: povolený iba https://cjbdijbbcujvmrzezusd.supabase.co", () => {
  assert.equal(validateStagingUrl(ALLOWED_ORIGIN), ALLOWED_ORIGIN);
  for (const bad of [
    "", "http://cjbdijbbcujvmrzezusd.supabase.co", `${ALLOWED_ORIGIN}/`, `${ALLOWED_ORIGIN}/rest/v1`, `${ALLOWED_ORIGIN}?x=1`, `${ALLOWED_ORIGIN}#a`,
    "https://cjbdijbbcujvmrzezusd.supabase.co.evil.example", "https://evil.example/?cjbdijbbcujvmrzezusd", "https://user@cjbdijbbcujvmrzezusd.supabase.co",
    "https://cjbdijbbcujvmrzezusd.supabase.co:8443", "https://fkpgvgvsmbpieduoatrt.supabase.co", "https://CJBDIJBBCUJVMRZEZUSD.supabase.co",
  ]) throwsStop(() => validateStagingUrl(bad), /F-3/);
});

await check("F-3 guardedFetch: iný hostiteľ / projekt zablokovaný, presmerovanie zakázané", async () => {
  const seen: Array<{ url: string; redirect?: string }> = [];
  const inner = (async (input: unknown, init?: RequestInit) => {
    seen.push({ url: String(input), redirect: init?.redirect });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const f = guardedFetch(inner);
  await f(`${ALLOWED_ORIGIN}/rest/v1/companies?select=id`);
  assert.equal(seen[0].redirect, "error");
  for (const bad of ["https://fkpgvgvsmbpieduoatrt.supabase.co/rest/v1/x", "https://cjbdijbbcujvmrzezusd.supabase.co.evil.example/x", "http://cjbdijbbcujvmrzezusd.supabase.co/x"]) {
    await assert.rejects(() => f(bad), /F-3/);
  }
  assert.equal(seen.length, 1, "zablokované požiadavky sa neodoslali");
});

await check("F-3 supabase-js s guardedFetch: požiadavky iba na povolený origin", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const seen: string[] = [];
  const inner = (async (input: unknown) => { seen.push(String(input instanceof Request ? input.url : input)); return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  const ok = createClient(ALLOWED_ORIGIN, "sb_secret_test_test_test_test_test", { auth: { persistSession: false }, global: { fetch: guardedFetch(inner) } });
  await ok.from("companies").select("id").limit(1);
  await ok.storage.from("einvoice-documents").download("x/y.xml");
  assert.ok(seen.length >= 2 && seen.every((u) => new URL(u).origin === ALLOWED_ORIGIN));
  const evil = createClient("https://fkpgvgvsmbpieduoatrt.supabase.co", "sb_secret_test_test_test_test_test", { auth: { persistSession: false }, global: { fetch: guardedFetch(inner) } });
  const before = seen.length;
  const r = await evil.from("companies").select("id");
  assert.ok(r.error, "požiadavka na iný projekt zlyhá");
  assert.equal(seen.length, before, "nič sa neodoslalo");
});

await check("F-4 zmenená knižnica / manifest = STOP; nezmenené = OK", () => {
  verifyLocalIntegrity(ROOT);
  for (const rel of Object.keys(EXPECTED_LOCAL_SHA256)) {
    const dir = mkdtempSync(path.join(tmpdir(), "p15-int-"));
    for (const r of Object.keys(EXPECTED_LOCAL_SHA256)) {
      const src = path.join(ROOT, r);
      const dst = path.join(dir, r);
      cpSync(src, dst);
    }
    writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), "utf8") + "\n// tampered\n");
    throwsStop(() => verifyLocalIntegrity(dir), /F-4/);
  }
});

await check("F-4 graf závislostí: zmenený tranzitívny modul (tslib, iceberg-js, phoenix) alebo prítomný @opentelemetry/api = STOP", async () => {
  const { verifyDependencyLock } = await import("./runner-core.ts");
  verifyDependencyLock(ROOT);
  const lock = JSON.parse(readFileSync(path.join(ROOT, "scripts/p15-staging/dependency-lock.json"), "utf8")) as { files: Record<string, string>; absent: string[] };
  for (const target of ["node_modules/tslib/tslib.js", "node_modules/iceberg-js/dist/index.mjs", "node_modules/@supabase/phoenix/priv/static/phoenix.cjs.js", "node_modules/@supabase/storage-js/package.json"]) {
    assert.ok(lock.files[target], `v locku: ${target}`);
    const dir = mkdtempSync(path.join(tmpdir(), "p15-dep-"));
    for (const rel of Object.keys(lock.files).concat("scripts/p15-staging/dependency-lock.json")) cpSync(path.join(ROOT, rel), path.join(dir, rel));
    writeFileSync(path.join(dir, target), readFileSync(path.join(dir, target), "utf8") + "\n// tampered\n");
    throwsStop(() => verifyDependencyLock(dir), /F-4/);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "p15-dep-"));
  for (const rel of Object.keys(lock.files).concat("scripts/p15-staging/dependency-lock.json")) cpSync(path.join(ROOT, rel), path.join(dir, rel));
  cpSync(path.join(ROOT, "package.json"), path.join(dir, "node_modules/@opentelemetry/api/package.json"));
  throwsStop(() => verifyDependencyLock(dir), /F-4: nečakaný balík/);
});

await check("preflight režim: všetky lokálne kontroly, žiadna sieť, žiadny kľúč; s kľúčom v prostredí = STOP", () => {
  const base = { PATH: process.env.PATH ?? "", ESBLU_P15_PREFLIGHT: "1", ESBLU_STAGING_SUPABASE_URL: ALLOWED_ORIGIN };
  const ok = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/p15-staging/p15-staging-storage-export.ts"], { cwd: ROOT, env: base, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PREFLIGHT_OK/);
  const withKey = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/p15-staging/p15-staging-storage-export.ts"], { cwd: ROOT, env: { ...base, ESBLU_STAGING_SERVICE_ROLE_KEY: "sb_secret_offline_test_not_real_000000" }, encoding: "utf8" });
  assert.equal(withKey.status, 2);
  assert.doesNotMatch(withKey.stdout + withKey.stderr, /sb_secret_offline/);
  const badUrl = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/p15-staging/p15-staging-storage-export.ts"], { cwd: ROOT, env: { ...base, ESBLU_STAGING_SUPABASE_URL: "https://evil.example" }, encoding: "utf8" });
  assert.equal(badUrl.status, 2);
});

await check("F-5 NODE_OPTIONS / NODE_PATH / proxy / TLS výnimky / NPM_CONFIG_* / iné execArgv = STOP", () => {
  assertCleanProcess({ PATH: "x", ESBLU_STAGING_SUPABASE_URL: ALLOWED_ORIGIN }, ["--experimental-strip-types", "--no-warnings"]);
  for (const env of [{ NODE_OPTIONS: "--require x.js" }, { node_options: "--import x" }, { NODE_PATH: "/x" }, { HTTPS_PROXY: "http://p" }, { https_proxy: "http://p" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { NODE_EXTRA_CA_CERTS: "/ca.pem" }, { NPM_CONFIG_REGISTRY: "x" }, { NODE_USE_ENV_PROXY: "1" }]) {
    throwsStop(() => assertCleanProcess(env, ["--experimental-strip-types", "--no-warnings"]), /F-5/);
  }
  for (const argv of [[], ["--experimental-strip-types"], ["--experimental-strip-types", "--no-warnings", "--require", "x.js"], ["--import", "x", "--experimental-strip-types", "--no-warnings"]]) {
    throwsStop(() => assertCleanProcess({}, argv), /F-5/);
  }
});

await check("F-5 skutočný proces: podstrčené NODE_OPTIONS → runner skončí STOP (exit 2) pred sieťou a kľúčom", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p15-pre-"));
  const pre = path.join(dir, "pre.cjs");
  writeFileSync(pre, "");
  const env = { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require ${pre}`, ESBLU_STAGING_SUPABASE_URL: ALLOWED_ORIGIN, ESBLU_STAGING_SERVICE_ROLE_KEY: "sb_secret_offline_test_not_real_000000" };
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/p15-staging/p15-staging-storage-export.ts"], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /STOP: F-5/);
  assert.doesNotMatch(r.stdout + r.stderr, /sb_secret_offline/);
});

await check("F-3 skutočný proces: nesprávna URL projektu → STOP (exit 2), kľúč sa nevypíše", () => {
  for (const u of ["https://fkpgvgvsmbpieduoatrt.supabase.co", "https://cjbdijbbcujvmrzezusd.supabase.co.evil.example", ""]) {
    const env = { PATH: process.env.PATH ?? "", ESBLU_STAGING_SUPABASE_URL: u, ESBLU_STAGING_SERVICE_ROLE_KEY: "sb_secret_offline_test_not_real_000000" };
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/p15-staging/p15-staging-storage-export.ts"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(r.status, 2, `${u}: ${r.stderr}`);
    assert.match(r.stderr, /STOP: F-3/);
    assert.doesNotMatch(r.stdout + r.stderr, /sb_secret_offline/);
  }
});

await check("F-6 manifest: cudzie company_id, cesta mimo prefixu, iný bucket, zmenené mapovanie firiem, zmenený obsah = STOP", () => {
  validateManifest(manifest);
  const cases: Array<[string, (m: Manifest) => void]> = [
    ["cudzie company_id", (m) => { m.files[0].company_id = "0a0040a6-6a31-4a4a-81c3-33bca867363d"; }],
    ["iná firma pre súbor", (m) => { m.files[0].company = "iso"; }],
    ["cesta pôvodnej firmy", (m) => { m.files[0].path = "0a0040a6-6a31-4a4a-81c3-33bca867363d/x.xml"; }],
    ["cesta s ..", (m) => { m.files[0].path = `${m.files[0].company_id}/../0a0040a6-6a31-4a4a-81c3-33bca867363d/x.xml`; }],
    ["billing-documents", (m) => { m.files[0].bucket = "billing-documents"; }],
    ["UUID firmy v mape", (m) => { m.companies.t1 = "0a0040a6-6a31-4a4a-81c3-33bca867363d"; }],
    ["vlastník", (m) => { m.users.t1 = "0a0040a6-6a31-4a4a-81c3-33bca867363d"; }],
    ["obsah", (m) => { m.files[0].content_b64 = Buffer.from("x").toString("base64"); }],
    ["chýbajúci súbor", (m) => { m.files.pop(); }],
  ];
  for (const [why, mut] of cases) {
    const m = clone(manifest);
    mut(m);
    throwsStop(() => validateManifest(m), /F-6/);
  }
});

// ============================================================================= E2E (PGlite + Storage v pamäti)
const OV: Array<[string, string]> = [["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"], ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"]];
const ORIGINAL_COMPANY = "0a0040a6-6a31-4a4a-81c3-33bca867363d";
async function freshDb(perfFull = false): Promise<PGlite> {
  let o = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const [f, b] of OV) { o = o.filter((x) => x !== f); o.splice(o.indexOf(b), 0, f); }
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
  for (const f of o) await db.exec(read(`supabase/migrations/${f}`));
  await db.exec("alter table auth.users add column if not exists instance_id uuid, add column if not exists aud text, add column if not exists role text;");
  // PERF: plný objem iba pre beh s meraním; ostatné scenáre menší objem (rovnaké súbory a firmy).
  const seed = read("scripts/p15-staging/seed-group-c.sql");
  await db.exec(perfFull ? seed : seed.replaceAll("generate_series(1, 25000)", "generate_series(1, 500)").replaceAll("generate_series(1, 4700)", "generate_series(1, 100)"));
  // pôvodná (nesyntetická) firma s vlastným súborom — kontrola izolácie
  await db.exec(`insert into auth.users (id, email) values ('0a0040a6-0000-4000-8000-0000000000aa', 'orig@example.invalid');
    set session_replication_role = replica;
    insert into public.companies (id, owner_id, name) values ('${ORIGINAL_COMPANY}', '0a0040a6-0000-4000-8000-0000000000aa', 'Pôvodná firma');
    insert into public.company_members (company_id, user_id, role, status, permissions) values ('${ORIGINAL_COMPANY}', '0a0040a6-0000-4000-8000-0000000000aa', 'owner', 'active', '{}');
    set session_replication_role = origin;
    insert into storage.buckets (id, name) values ('ai-inbox-documents', 'ai-inbox-documents') on conflict do nothing;`);
  return db;
}

type Faults = { failUploadAt?: number; failRestore?: boolean; failRpc?: { fn: string; at: number; label?: string }; downloadErrorPath?: string };
class MemBackend implements Backend {
  store = new Map<string, Uint8Array>();
  uploads = 0;
  rpcCalls = new Map<string, number>();
  writes: string[] = [];
  faults: Faults = {};
  readonly db: PGlite;
  constructor(db: PGlite) { this.db = db; }
  async selectIn(table: string, column: string, values: string[], from: number, to: number, orderById: boolean) {
    try {
      const r = await this.db.query<Row>(`select * from public.${table} where ${column}::text = any($1::text[]) ${orderById ? "order by id" : ""} limit ${to - from + 1} offset ${from}`, [values]);
      return { rows: r.rows.map((x) => JSON.parse(JSON.stringify(x)) as Row) };
    } catch (e) {
      return { rows: [], error: { code: (e as { code?: string }).code, message: (e as Error).message } };
    }
  }
  async rpc(fn: string, args: Record<string, unknown>) {
    const n = (this.rpcCalls.get(fn) ?? 0) + 1;
    this.rpcCalls.set(fn, n);
    if (this.faults.failRpc && this.faults.failRpc.fn === fn && this.faults.failRpc.at === n) throw new Error("simulovaný výpadok siete");
    const names = Object.keys(args);
    const params = names.map((k) => (typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
    const call = `${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    await this.db.exec("begin");
    try {
      await this.db.exec("set local role service_role");
      const sql = fn === "esblu_company_export_file_list" ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) r from public.${call} x` : `select public.${call} r`;
      const r = await this.db.query<{ r: unknown }>(sql, params);
      await this.db.exec("commit");
      return { data: r.rows[0]?.r ?? null, error: null };
    } catch (e) {
      await this.db.exec("rollback");
      return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
    }
  }
  async download(bucket: string, p: string) {
    if (this.faults.downloadErrorPath === p) return { bytes: null, error: "503:unavailable" };
    const b = this.store.get(`${bucket}/${p}`);
    return { bytes: b ? new Uint8Array(b) : null };
  }
  async upload(bucket: string, p: string, bytes: Uint8Array, upsert: boolean) {
    this.uploads++;
    if (this.faults.failUploadAt === this.uploads) return { status: "error" as const, error: "simulované prerušenie uploadu" };
    if (this.faults.failRestore && upsert && p.includes("corrupt") && !Buffer.from(bytes).toString("utf8").includes("CORRUPTED")) return { status: "error" as const, error: "simulované zlyhanie obnovy" };
    const k = `${bucket}/${p}`;
    if (this.store.has(k) && !upsert) return { status: "exists" as const };
    this.store.set(k, new Uint8Array(bytes));
    this.writes.push(k);
    const etag = createHash("md5").update(bytes).digest("hex");
    await this.db.query(`insert into storage.objects (bucket_id, name, metadata) values ($1, $2, jsonb_build_object('eTag', $3::text, 'size', $4::int))
      on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = clock_timestamp()`, [bucket, p, etag, bytes.byteLength]);
    return { status: "uploaded" as const };
  }
}
const quiet: string[] = [];
const run = async (be: MemBackend, opts: { skipPerf?: boolean } = { skipPerf: true }) => {
  const lines: string[] = [];
  const r = new Runner(be, manifest, { log: (s) => { lines.push(s); quiet.push(s); }, skipPerf: opts.skipPerf });
  const { exitCode } = await r.run();
  return { exitCode, results: r.results, lines };
};
const st = (res: Awaited<ReturnType<typeof run>>, id: string) => res.results.find((x) => x.id === id)?.status;
const corrupt = manifest.files.find((f) => f.phase === "T2_CORRUPT")!;
const corruptKey = `${corrupt.bucket}/${corrupt.path}`;
async function companyState(db: PGlite, c: string) {
  return (await db.query<{ s: string }>(`select status||':'||coalesce(error_code,'-') s from public.company_export_runs where company_id = $1 order by created_at, id`, [c])).rows.map((x) => x.s);
}
function onlySynthetic(be: MemBackend) {
  const ids = Object.values(APPROVED_COMPANIES);
  for (const k of be.writes) {
    const p = k.split("/").slice(1).join("/");
    assert.ok(ids.some((id) => p.startsWith(`${id}/`)), `zápis mimo syntetických firiem: ${k}`);
  }
}

{
  const db = await freshDb(true);
  const be = new MemBackend(db);
  be.store.set(`ai-inbox-documents/${ORIGINAL_COMPANY}/qa-ux/original.pdf`, new Uint8Array(Buffer.from("%PDF original")));
  await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('ai-inbox-documents', $1, '{"eTag":"orig"}')`, [`${ORIGINAL_COMPANY}/qa-ux/original.pdf`]);
  const origRow = (await db.query<Row>(`select id, updated_at from storage.objects where name like $1`, [`${ORIGINAL_COMPANY}/%`])).rows[0];

  let r1: Awaited<ReturnType<typeof run>>;
  await check("beh 1 (vrátane PERF): všetky kroky PASS, E4 PASS, poškodený originál zistený a obnovený, export T2 dokončený", async () => {
    r1 = await run(be, { skipPerf: false });
    assert.equal(r1.exitCode, 0, r1.lines.filter((l) => /FAIL|ABORT/.test(l)).join("\n"));
    for (const id of ["S0.identity_db_manifest", "S1.phase_A", "E1.t1_change_during_export", "E2.t1_export_completed", "E2.t1_r3_excluded", "E2.t1_counts_match_db",
      "E3.iso_export_completed", "E4.t2_missing_files", "S2.t2_late", "E5.t2_corrupt_original", "E5R.t2_restore_original", "E6.t2_restored_export_completed", "P1.perf_export_completed"]) {
      assert.equal(st(r1, id), "PASS", id);
    }
    assert.equal(sha256(be.store.get(corruptKey)!), corrupt.sha256, "pôvodné bajty obnovené");
    assert.equal(be.store.size, 322 + 1, "322 syntetických + 1 pôvodný objekt");
  });
  await check("izolácia: žiadny zápis mimo 4 syntetických firiem; pôvodný objekt nezmenený", async () => {
    onlySynthetic(be);
    const now = (await db.query<Row>(`select id, updated_at from storage.objects where name like $1`, [`${ORIGINAL_COMPANY}/%`])).rows[0];
    assert.deepEqual(JSON.stringify(now), JSON.stringify(origRow));
    assert.equal((await db.query(`select 1 from public.company_export_runs where company_id = $1`, [ORIGINAL_COMPANY])).rows.length, 0);
  });
  await check("beh 2 a beh 3: opakovateľné (E4 SKIP, E5 znova FILES_CORRUPT, obnova, E6 completed), nič neočakávané sa neprepisuje", async () => {
    for (const n of [2, 3]) {
      const writesBefore = be.writes.length;
      const r = await run(be);
      assert.equal(r.exitCode, 0, `beh ${n}: ${r.lines.filter((l) => /FAIL|ABORT/.test(l)).join("\n")}`);
      assert.equal(st(r, "E4.t2_missing_files"), "SKIP");
      assert.equal(st(r, "E5.t2_corrupt_original"), "PASS");
      assert.equal(st(r, "E6.t2_restored_export_completed"), "PASS");
      const newWrites = be.writes.slice(writesBefore);
      assert.ok(newWrites.every((k) => k === corruptKey || k.endsWith("/p15/doc-1.pdf")), `beh ${n}: prepísané iba kontrolované objekty (${newWrites.length})`);
      assert.equal(sha256(be.store.get(corruptKey)!), corrupt.sha256);
    }
    onlySynthetic(be);
  });
}

await check("prerušený upload: beh 1 ABORT, beh 2 dokončí (platné objekty sa neprepíšu)", async () => {
  const be = new MemBackend(await freshDb());
  be.faults.failUploadAt = 40;
  const a = await run(be);
  assert.equal(a.exitCode, 1);
  assert.match(a.lines.join("\n"), /ABORT .*upload/);
  const storedBefore = new Map(be.store);
  be.faults = {};
  const b = await run(be);
  assert.equal(b.exitCode, 0, b.lines.filter((l) => /FAIL|ABORT/.test(l)).join("\n"));
  for (const [k, v] of storedBefore) assert.deepEqual(be.store.get(k), v, `platný objekt sa neprepísal: ${k}`);
  onlySynthetic(be);
});

await check("čiastočne dokončený export (výpadok pri dávke E2): FAIL, beh 2 vytvorí nový úplný export", async () => {
  const be = new MemBackend(await freshDb());
  be.faults.failRpc = { fn: "esblu_company_export_part_files", at: 2 }; // 1. = E1, 2. = E2
  const a = await run(be);
  assert.equal(a.exitCode, 1);
  assert.ok(st(a, "E2.t1_export_completed") === undefined || st(a, "E2.t1_export_completed") === "FAIL");
  be.faults = {};
  const b = await run(be);
  assert.equal(b.exitCode, 0, b.lines.filter((l) => /FAIL|ABORT/.test(l)).join("\n"));
  const runs = await companyState(be.db, APPROVED_COMPANIES.t1);
  assert.ok(runs.includes("in_progress:-"), "nedokončený beh ostal ako dôkaz (nedá sa použiť na ukončenie)");
  assert.ok(runs.includes("completed:-"));
});

await check("prerušenie medzi poškodením a obnovou (výpadok počas E5): finally obnoví pôvodné bajty", async () => {
  const be = new MemBackend(await freshDb());
  await run(be); // príprava (beh 1 OK)
  be.faults.failRpc = { fn: "esblu_company_export_part_files", at: (be.rpcCalls.get("esblu_company_export_part_files") ?? 0) + 4 }; // E1,E2,E3 → 4. = E5
  const r = await run(be);
  assert.ok(r.results.some((x) => x.id === "E5R.t2_restore_original" && x.status === "PASS"), r.lines.join("\n"));
  assert.equal(sha256(be.store.get(corruptKey)!), corrupt.sha256);
});

await check("neúspešná obnova poškodeného súboru: KRITICKÝ FAIL (exit 3) + upozornenie; ďalší beh stav opraví", async () => {
  const be = new MemBackend(await freshDb());
  be.faults.failRestore = true;
  const r = await run(be);
  assert.equal(r.exitCode, 3);
  assert.match(r.lines.join("\n"), /KRITICKÉ/);
  assert.equal(st(r, "E5R.t2_restore_original"), "FAIL");
  assert.equal(sha256(be.store.get(corruptKey)!), corrupt.upload_sha256, "T2 ostala poškodená — správne ohlásené");
  be.faults = {};
  const fix = await run(be);
  assert.equal(fix.exitCode, 0, fix.lines.filter((l) => /FAIL|ABORT/.test(l)).join("\n"));
  assert.equal(sha256(be.store.get(corruptKey)!), corrupt.sha256);
});

await check("neočakávaný obsah objektu: STOP, objekt sa neprepíše", async () => {
  const be = new MemBackend(await freshDb());
  const f = manifest.files.find((x) => x.company === "t1" && x.kind === "ubl")!;
  const foreign = new Uint8Array(Buffer.from("<x>iný obsah</x>"));
  be.store.set(`${f.bucket}/${f.path}`, foreign);
  const r = await run(be);
  assert.equal(r.exitCode, 1);
  assert.match(r.lines.join("\n"), /F-2: neočakávaný obsah/);
  assert.deepEqual(be.store.get(`${f.bucket}/${f.path}`), foreign);
});

await check("neznámy stav objektu (chyba stiahnutia) a cudzia DB (firmy nesedia): STOP pred zápisom", async () => {
  const be = new MemBackend(await freshDb());
  be.faults.downloadErrorPath = manifest.files[0].path;
  const r = await run(be);
  assert.equal(r.exitCode, 1);
  assert.equal(be.writes.length, 0, "žiadny upload");
  const db2 = await freshDb();
  await db2.exec(`set session_replication_role = replica; update public.companies set name = 'Iná' where id = '${APPROVED_COMPANIES.iso}'; set session_replication_role = origin;`);
  const be2 = new MemBackend(db2);
  const r2 = await run(be2);
  assert.equal(r2.exitCode, 1);
  assert.match(r2.lines.join("\n"), /S0/);
  assert.equal(be2.writes.length, 0);
});

console.log(`\np15-runner-tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
