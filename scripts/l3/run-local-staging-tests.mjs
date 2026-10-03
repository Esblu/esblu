// =============================================================================
// Testy L3 launchera (scripts/l3/run-local-staging.mjs) — bez reálnych tajomstiev
// a bez reálneho Next.js (spawn je test double). Všetky "tajomstvá" sú
// syntetické kanáriky; test overí, že sa nikdy neobjavia vo výstupe.
//   node scripts/l3/run-local-staging-tests.mjs
// =============================================================================
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseEnvText, validateStagingEnv, buildChildEnv, assertChildEnvSafe, REQUIRED_VARS } from "./run-local-staging.mjs";

const STAGING = "cjbdijbbcujvmrzezusd";
const PROD = "fkpgvgvsmbpieduoatrt";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (ref, role, sig) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role, iat: 1, exp: 2 })}.${sig}`;

// Kanáriky — nesmú sa objaviť v žiadnom výstupe.
const C = {
  anon: fakeJwt(STAGING, "anon", "CANARYanonSIGNATURE0001"),
  service: fakeJwt(STAGING, "service_role", "CANARYserviceSIGNATURE02"),
  cron: "CANARY-cron-0123456789abcdef0123456789abcdef",
  confirm: "c0ffee".repeat(11) + "ab", // 68 hex
  api: "efk_pk_test_CANARYapikey0123456789",
  whsec: "whsec_CANARYwebhook0123456789",
};
const CANARIES = [C.anon, C.service, C.cron, C.confirm, C.api, C.whsec, "CANARYanonSIGNATURE0001", "CANARYserviceSIGNATURE02", "CANARYapikey", "CANARYwebhook"];

const good = () => ({
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: C.anon,
  SUPABASE_SERVICE_ROLE_KEY: C.service,
  CRON_SECRET: C.cron,
  ESBLU_ACTION_CONFIRMATION_SECRET: C.confirm,
  ESBLU_EINVOICE_PROVIDER: "efaktura_sk",
  ESBLU_EINVOICE_ENVIRONMENT: "sandbox",
  ESBLU_EFAKTURA_API_KEY: C.api,
  ESBLU_EFAKTURA_WEBHOOK_SECRETS: C.whsec,
});
const toText = (vars) => `# L3 test\n${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;

const tmp = mkdtempSync(path.join(os.tmpdir(), "esblu-l3-launcher-"));
// Falošný "repo root" s produkčne vyzerajúcim .env.local (iba kanárikové hodnoty).
const fakeRoot = path.join(tmp, "repo");
mkdirSync(fakeRoot);
const ENV_LOCAL_TEXT = `NEXT_PUBLIC_SUPABASE_URL=https://${PROD}.supabase.co\nOPENAI_API_KEY=sk-CANARYprodopenai\nVAPID_PRIVATE_KEY=CANARYvapidprivate\nESBLU_INTAKE_ATTEST_SECRET=CANARYprodintakeattest0123456789abc\n`;
CANARIES.push("CANARYprodopenai", "CANARYvapidprivate", "CANARYprodintakeattest");
writeFileSync(path.join(fakeRoot, ".env.local"), ENV_LOCAL_TEXT);
writeFileSync(path.join(fakeRoot, "package.json"), "{}");

let allOutput = "";
let passed = 0;
async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}\n${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  }
}

/** Spustí main() s test double pre spawn; vráti {code, out, spawned}. */
async function launch(vars, { argv = [], parentEnv = {}, envFileName = "esblu-l3-staging.env", root = fakeRoot, childExit = 0, spawnThrows = null, holdUntilKill = false, onSpawn = null } = {}) {
  const file = path.join(tmp, envFileName);
  if (vars !== null) writeFileSync(file, typeof vars === "string" ? vars : toText(vars));
  else rmSync(file, { force: true });
  const lines = [];
  let spawned = null;
  const spawnImpl = (cmd, args, opts) => {
    if (spawnThrows) throw spawnThrows;
    spawned = { cmd, args, opts };
    const child = new EventEmitter();
    child.killedWith = null;
    child.kill = (sig) => {
      child.killedWith = sig;
      if (holdUntilKill) setImmediate(() => child.emit("exit", null, sig));
    };
    spawned.child = child;
    if (!holdUntilKill) setImmediate(() => child.emit("exit", childExit, null));
    if (onSpawn) onSpawn(child);
    return child;
  };
  const code = await main({
    argv: [`--l3-env=${file}`, ...argv],
    env: parentEnv,
    root,
    spawnImpl,
    resolveNext: (dir) => path.join(dir, "node_modules", "next", "dist", "bin", "next"),
    pollMs: 20,
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
  });
  const out = lines.join("\n");
  allOutput += `\n${out}`;
  return { code, out, spawned };
}

// Skutočný repo root — iba na šablónu a CLI test (--check).
const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

await run("parser: komentáre, úvodzovky, export, inline komentár; chyby bez obsahu", () => {
  const { vars, errors } = parseEnvText(`\uFEFF# x\nexport A=1\nB="two words"\nC='x # y'\nD=val # komentar\nE="unterminated SECRETVALUE\nbad line SECRET2\nA=dup`);
  assert.deepEqual(vars, { A: "1", B: "two words", C: "x # y", D: "val" });
  assert.equal(errors.length, 3);
  assert.ok(!errors.join(" ").includes("SECRET"));
});

await run("správny staging env: validácia bez chýb", () => {
  const { errors, notes } = validateStagingEnv(good());
  assert.deepEqual(errors, []);
  assert.ok(notes.some((n) => n.includes("JWT ref = staging")));
});

await run("chýbajúci env súbor → STOP (exit 2), nič sa nespustí", async () => {
  const r = await launch(null);
  assert.equal(r.code, 2);
  assert.match(r.out, /env súbor neexistuje/);
  assert.equal(r.spawned, null);
});

await run("chýbajúce povinné premenné → STOP, vypíše iba názvy", async () => {
  const v = good();
  delete v.SUPABASE_SERVICE_ROLE_KEY;
  delete v.ESBLU_EFAKTURA_WEBHOOK_SECRETS;
  const r = await launch(v);
  assert.equal(r.code, 3);
  assert.match(r.out, /chýbajú povinné premenné: SUPABASE_SERVICE_ROLE_KEY, ESBLU_EFAKTURA_WEBHOOK_SECRETS/);
  assert.equal(r.spawned, null);
});

await run("prázdna šablóna → STOP (všetky povinné chýbajú)", async () => {
  const tpl = readFileSync(path.join(realRoot, "docs", "einvoice-l3-env-template.txt"), "utf8");
  const r = await launch(tpl);
  assert.equal(r.code, 3);
  for (const k of REQUIRED_VARS.filter((k) => !k.startsWith("ESBLU_EINVOICE_"))) assert.ok(r.out.includes(k), k);
  assert.equal(r.spawned, null);
});

await run("produkčná Supabase URL → STOP", async () => {
  const r = await launch({ ...good(), NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` });
  assert.equal(r.code, 3);
  assert.match(r.out, /produkčný project ref/);
  assert.equal(r.spawned, null);
});

await run("URL so staging refom, ale iný host (napr. prod host s ?x=staging) → STOP", async () => {
  const r = await launch({ ...good(), NEXT_PUBLIC_SUPABASE_URL: `https://evil.example.com/${STAGING}` });
  assert.equal(r.code, 3);
  assert.match(r.out, /musí byť presne https:\/\/cjbdijbbcujvmrzezusd\.supabase\.co/);
});

await run("produkčný ref v ľubovoľnej inej hodnote → STOP", async () => {
  const r = await launch({ ...good(), CRON_SECRET: `${PROD}-0123456789abcdef0123456789` });
  assert.equal(r.code, 3);
  assert.match(r.out, /CRON_SECRET: obsahuje produkčný project ref/);
});

await run("produkčný service_role JWT (ref iba v base64 payloade) → STOP", async () => {
  const r = await launch({ ...good(), SUPABASE_SERVICE_ROLE_KEY: fakeJwt(PROD, "service_role", "CANARYprodSIG000001") });
  CANARIES.push("CANARYprodSIG000001");
  assert.equal(r.code, 3);
  assert.match(r.out, /SUPABASE_SERVICE_ROLE_KEY: kľúč patrí PRODUKČNÉMU projektu/);
});

await run("anon kľúč v slote service_role / prehodené role → STOP", async () => {
  const r = await launch({ ...good(), SUPABASE_SERVICE_ROLE_KEY: fakeJwt(STAGING, "anon", "CANARYswapSIG0000001") });
  CANARIES.push("CANARYswapSIG0000001");
  assert.equal(r.code, 3);
  assert.match(r.out, /očakávaná rola service_role/);
});

await run("ESBLU_EINVOICE_LIVE_ENABLED=true → STOP", async () => {
  const r = await launch({ ...good(), ESBLU_EINVOICE_LIVE_ENABLED: "true" });
  assert.equal(r.code, 3);
  assert.match(r.out, /ESBLU_EINVOICE_LIVE_ENABLED: v L3 zakázané/);
  assert.equal(r.spawned, null);
});

await run("VERCEL_ENV=production → STOP", async () => {
  const r = await launch({ ...good(), VERCEL_ENV: "production" });
  assert.equal(r.code, 3);
  assert.match(r.out, /VERCEL_ENV=production je zakázané/);
});

await run("ESBLU_EINVOICE_ENVIRONMENT=live, iný provider, live API kľúč → STOP", async () => {
  const r = await launch({ ...good(), ESBLU_EINVOICE_ENVIRONMENT: "live", ESBLU_EINVOICE_PROVIDER: "mock", ESBLU_EFAKTURA_API_KEY: "efk_pk_live_CANARYlive0001" });
  CANARIES.push("CANARYlive0001");
  assert.equal(r.code, 3);
  assert.match(r.out, /ESBLU_EINVOICE_ENVIRONMENT: musí byť sandbox/);
  assert.match(r.out, /ESBLU_EINVOICE_PROVIDER: musí byť efaktura_sk/);
  assert.match(r.out, /LIVE kľúč — zakázané/);
});

await run("neznáme premenné (napr. push kľúče, DB URL) → STOP", async () => {
  const r = await launch({ ...good(), VAPID_PRIVATE_KEY: "CANARYvapid2", STAGING_DB_URL: "postgresql://u:CANARYdbpw@h/db" });
  CANARIES.push("CANARYvapid2", "CANARYdbpw");
  assert.equal(r.code, 3);
  assert.match(r.out, /nepovolené premenné .*STAGING_DB_URL, VAPID_PRIVATE_KEY/);
});

await run("zástupné hodnoty a slabé tajomstvá → STOP", async () => {
  const r = await launch({ ...good(), CRON_SECRET: "<cron>", ESBLU_ACTION_CONFIRMATION_SECRET: "nothex" });
  assert.equal(r.code, 3);
  assert.match(r.out, /CRON_SECRET: obsahuje zástupnú hodnotu/);
  assert.match(r.out, /ESBLU_ACTION_CONFIRMATION_SECRET: musí byť hex/);
});

await run("rovnaké tajomstvo v dvoch premenných → STOP", async () => {
  const r = await launch({ ...good(), ESBLU_EFAKTURA_WEBHOOK_SECRETS: C.cron });
  assert.equal(r.code, 3);
  assert.match(r.out, /ESBLU_EFAKTURA_WEBHOOK_SECRETS má rovnakú hodnotu ako CRON_SECRET/);
});

await run("env súbor vnútri repa / s názvom .env* → STOP", async () => {
  const inside = path.join(fakeRoot, "staging.env");
  writeFileSync(inside, toText(good()));
  const lines = [];
  const code = await main({ argv: [`--l3-env=${inside}`], env: {}, root: fakeRoot, spawnImpl: () => assert.fail("spawn"), out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.equal(code, 3);
  assert.match(lines.join("\n"), /MIMO repa/);
  const r = await launch(good(), { envFileName: ".env.staging" });
  assert.equal(r.code, 3);
  assert.match(r.out, /nesmie volať \.env\*/);
  allOutput += lines.join("\n");
});

await run("--check so správnym env: OK, nič sa nespustí", async () => {
  const r = await launch(good(), { argv: ["--check"] });
  assert.equal(r.code, 0);
  assert.match(r.out, /L3 staging env OK/);
  assert.match(r.out, /--check: nič sa nespúšťa/);
  assert.equal(r.spawned, null);
});

await run("správny env: spustí next dev (test double) so staging env; .env.local sa nenačíta ani nezmení", async () => {
  const envLocalBefore = readFileSync(path.join(fakeRoot, ".env.local"), "utf8");
  const parentEnv = {
    PATH: "/usr/bin",
    NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co`, // zdedené zo shellu
    OPENAI_API_KEY: "sk-CANARYshellopenai",
    VERCEL_ENV: "production",
    ESBLU_EINVOICE_LIVE_ENABLED: "true",
    PGPASSWORD: "CANARYpgpw",
    NODE_OPTIONS: "--env-file=C:/prod.env",
  };
  CANARIES.push("CANARYshellopenai", "CANARYpgpw");
  const r = await launch(good(), { parentEnv, argv: ["--", "--port", "3001"] });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.spawned, "spawn sa mal zavolať");
  assert.equal(r.spawned.cmd, process.execPath);
  assert.match(r.spawned.args[0].replace(/\\/g, "/"), /next\/dist\/bin\/next$/);
  assert.deepEqual(r.spawned.args.slice(1), ["dev", "--port", "3001"]);
  assert.equal(r.spawned.opts.cwd, fakeRoot);
  assert.equal(r.spawned.opts.shell, undefined);
  const e = r.spawned.opts.env;
  assert.equal(e.NEXT_PUBLIC_SUPABASE_URL, `https://${STAGING}.supabase.co`);
  assert.equal(e.SUPABASE_SERVICE_ROLE_KEY, C.service);
  assert.equal(e.ESBLU_EINVOICE_ENVIRONMENT, "sandbox");
  assert.equal(e.ESBLU_EINVOICE_LIVE_ENABLED, "false");
  assert.equal(e.VERCEL_ENV, "development");
  assert.equal(e.__NEXT_PROCESSED_ENV, "true");
  assert.equal(e.PGPASSWORD, undefined);
  assert.equal(e.NODE_OPTIONS, undefined);
  // názvy z (falošného produkčného) .env.local → prázdne, Next.js ich nedoplní
  assert.equal(e.OPENAI_API_KEY, "");
  assert.equal(e.VAPID_PRIVATE_KEY, "");
  assert.equal(e.ESBLU_INTAKE_ATTEST_SECRET, "");
  assert.ok(!Object.values(e).some((v) => String(v).includes(PROD)));
  assert.match(r.out, /\.env\.local nezmenený/);
  assert.equal(readFileSync(path.join(fakeRoot, ".env.local"), "utf8"), envLocalBefore);
});

await run("buildChildEnv: názvy z .env.local sú prekryté prázdnou hodnotou (Next.js ich nedoplní)", () => {
  const names = ["NEXT_PUBLIC_SUPABASE_URL", "OPENAI_API_KEY", "VAPID_PRIVATE_KEY", "ESBLU_INTAKE_ATTEST_SECRET"];
  const e = buildChildEnv({ PATH: "/bin" }, good(), names);
  assert.equal(e.OPENAI_API_KEY, "");
  assert.equal(e.VAPID_PRIVATE_KEY, "");
  assert.equal(e.ESBLU_INTAKE_ATTEST_SECRET, "");
  assert.equal(e.NEXT_PUBLIC_SUPABASE_URL, `https://${STAGING}.supabase.co`);
  assert.doesNotThrow(() => assertChildEnvSafe(e));
  assert.throws(() => assertChildEnvSafe({ ...e, SOMETHING: `x${PROD}` }), /produkčný ref/);
  assert.throws(() => assertChildEnvSafe({ ...e, ESBLU_EINVOICE_LIVE_ENABLED: "true" }), /live\/production/);
});

await run("výnimka zo spawn s tajomstvom v správe → redigovaná, bez stack trace", async () => {
  const boom = new Error(`spawn failed key=${C.service} api=${C.api} url=postgresql://user:CANARYurlpw@host/db`);
  CANARIES.push("CANARYurlpw");
  const r = await launch(good(), { spawnThrows: boom });
  assert.equal(r.code, 1);
  assert.match(r.out, /neočakávaná chyba/);
  assert.ok(!/\n\s+at /.test(r.out), "žiadny stack trace");
});

await run("CLI end-to-end (skutočný proces): --check OK, produkcia STOP, chýbajúci súbor STOP", () => {
  const script = path.join(realRoot, "scripts", "l3", "run-local-staging.mjs");
  const okFile = path.join(tmp, "cli-ok.env");
  writeFileSync(okFile, toText(good()));
  const ok = spawnSync(process.execPath, [script, `--l3-env=${okFile}`, "--check"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  allOutput += ok.stdout + ok.stderr;
  assert.equal(ok.status, 0, ok.stderr);
  const prodFile = path.join(tmp, "cli-prod.env");
  writeFileSync(prodFile, toText({ ...good(), NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }));
  const bad = spawnSync(process.execPath, [script, `--l3-env=${prodFile}`, "--check"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  allOutput += bad.stdout + bad.stderr;
  assert.equal(bad.status, 3);
  const missing = spawnSync(process.execPath, [script, `--l3-env=${path.join(tmp, "nope.env")}`], { encoding: "utf8", env: { PATH: process.env.PATH } });
  allOutput += missing.stdout + missing.stderr;
  assert.equal(missing.status, 2);
});

await run("zmena .env.local počas behu → dev server sa zastaví (exit 5)", async () => {
  const envLocal = path.join(fakeRoot, ".env.local");
  const original = readFileSync(envLocal, "utf8");
  const r = await launch(good(), {
    holdUntilKill: true,
    onSpawn: () => setTimeout(() => writeFileSync(envLocal, `${original}NEW_PROD_VAR=CANARYnewprod\n`), 60),
  });
  CANARIES.push("CANARYnewprod");
  writeFileSync(envLocal, original);
  assert.equal(r.code, 5);
  assert.equal(r.spawned.child.killedWith, "SIGTERM");
  assert.match(r.out, /\.env\* súbor repa sa počas behu zmenil/);
});

await run("skutočný @next/env: s env od launchera sa z .env.local nepoužije žiadna hodnota", () => {
  const nextEnvPath = createRequire(path.join(realRoot, "package.json")).resolve("@next/env");
  const names = ["NEXT_PUBLIC_SUPABASE_URL", "OPENAI_API_KEY", "VAPID_PRIVATE_KEY", "ESBLU_INTAKE_ATTEST_SECRET"];
  const childEnv = buildChildEnv({ PATH: process.env.PATH }, good(), names);
  const probe = `const {loadEnvConfig}=require(${JSON.stringify(nextEnvPath)});
    const silent={info(){},error(){},warn(){}};
    loadEnvConfig(${JSON.stringify(fakeRoot)}, true, silent, false);
    const a={url:process.env.NEXT_PUBLIC_SUPABASE_URL,openai:process.env.OPENAI_API_KEY,vapid:process.env.VAPID_PRIVATE_KEY,intake:process.env.ESBLU_INTAKE_ATTEST_SECRET};
    loadEnvConfig(${JSON.stringify(fakeRoot)}, true, silent, true);
    const b={url:process.env.NEXT_PUBLIC_SUPABASE_URL,openai:process.env.OPENAI_API_KEY,vapid:process.env.VAPID_PRIVATE_KEY,intake:process.env.ESBLU_INTAKE_ATTEST_SECRET};
    process.stdout.write(JSON.stringify({a,b}));`;
  const res = spawnSync(process.execPath, ["-e", probe], { env: childEnv, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const { a, b } = JSON.parse(res.stdout);
  const expected = { url: `https://${STAGING}.supabase.co`, openai: "", vapid: "", intake: "" };
  assert.deepEqual(a, expected, "prvé načítanie");
  assert.deepEqual(b, expected, "forceReload (zmena súboru v dev)");
  // kontrola: bez launchera by @next/env hodnoty z .env.local naozaj doplnil
  const raw = spawnSync(process.execPath, ["-e", probe], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(JSON.parse(raw.stdout).a.vapid, "CANARYvapidprivate");
});

await run("žiadny kanárik (tajomstvo) sa neobjavil v žiadnom výstupe", () => {
  for (const c of CANARIES) assert.ok(!allOutput.includes(c), `únik: ${c.slice(0, 6)}…`);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testov prešlo${process.exitCode ? " — NIEKTORÉ ZLYHALI" : ""}`);
