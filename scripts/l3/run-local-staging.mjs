// =============================================================================
// L3 — lokálny Next.js dev server proti STAGING Supabase (esblu-test) a
// eFaktura.sk SANDBOXU. Fail-closed launcher.
//
//   node scripts/l3/run-local-staging.mjs [--l3-env=CESTA] [--check] [-- <args pre next dev>]
//
//   --l3-env=CESTA    externý env súbor MIMO repa (default
//                     %USERPROFILE%\Documents\esblu-l3-staging.env, alebo
//                     ESBLU_L3_ENV_FILE). Šablóna: docs/einvoice-l3-env-template.txt
//                     Zámerne nie --env-file: ten si node prisvojí aj za
//                     názvom skriptu (načítal by súbor do procesu launchera).
//   --check           iba overí env (nič nespúšťa)
//
// Bezpečnosť:
//   - .env.local (v worktree je to HARDLINK na produkčný .env.local hlavného
//     repa) sa NIKDY nezapisuje ani nečíta jeho hodnota. Launcher z env súborov
//     repa číta iba NÁZVY premenných a v procese Next.js ich prekryje prázdnou
//     hodnotou (+ __NEXT_PROCESSED_ENV), takže Next.js síce súbor nájde
//     (hlavička „Environments: .env.local"), ale nepoužije z neho nič —
//     Next.js nikdy neprepíše existujúcu premennú.
//     Pri zmene .env* počas behu by Next.js dev env znova načítal a doplnil
//     NOVÉ názvy → launcher .env* sleduje a pri zmene dev server zastaví.
//     Po skončení overí, že .env.local je bajtovo nezmenený.
//   - env súbor musí byť mimo repa; povolené sú iba známe názvy premenných.
//   - NEXT_PUBLIC_SUPABASE_URL musí byť presne https://<staging-ref>.supabase.co;
//     produkčný ref v ktorejkoľvek hodnote (aj v JWT payloade kľúča) = STOP.
//   - iba ESBLU_EINVOICE_PROVIDER=efaktura_sk, ESBLU_EINVOICE_ENVIRONMENT=sandbox,
//     API kľúč efk_pk_test_…; ESBLU_EINVOICE_LIVE_ENABLED a VERCEL_ENV=production
//     sú zakázané.
//   - zdedené premenné shellu, ktoré by mohli ukazovať na produkciu
//     (SUPABASE*, ESBLU_*, NEXT_PUBLIC_*, VERCEL*, OPENAI*, push kľúče, DB URL…),
//     sa do procesu Next.js neprenesú.
//   - výstup obsahuje iba názvy premenných a verdikty — nikdy hodnoty; chyby sa
//     vypisujú redigované a bez stack trace.
// =============================================================================
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_REF, STAGING_REF } from "./staging-guard.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STAGING_SUPABASE_HOST = `${STAGING_REF}.supabase.co`;

export const REQUIRED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "ESBLU_ACTION_CONFIRMATION_SECRET",
  "ESBLU_EINVOICE_PROVIDER",
  "ESBLU_EINVOICE_ENVIRONMENT",
  "ESBLU_EFAKTURA_API_KEY",
  "ESBLU_EFAKTURA_WEBHOOK_SECRETS",
];

// Nie sú potrebné pre L3 eInvoice E2E. Push kľúče (VAPID/FCM/APNS) zámerne
// NIE sú povolené — staging nesmie posielať notifikácie na reálne zariadenia.
export const OPTIONAL_VARS = [
  "ESBLU_INTAKE_ATTEST_SECRET",
  "OPENAI_API_KEY",
  "ESBLU_EFAKTURA_BASE_URL",
  "ESBLU_EINVOICE_WORKER_BATCH",
  "ESBLU_CORS_EXTRA_ORIGINS",
  "ESBLU_LEGAL_CONTENT_ROOT",
  "NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS",
  "NEXT_PUBLIC_ESBLU_BUILD_ID",
  "ESBLU_EINVOICE_LIVE_ENABLED", // povolené iba ako prázdne / "false"
  "VERCEL_ENV", // povolené iba "development"
  "STAGING_SUPABASE_REF", // pre staging-guard.mjs; ak je, musí byť staging ref
];

// Konfigurácia, nie tajomstvá — nepridávajú sa do redakcie (inak by sa
// redigovali aj slová ako "production" v chybových hláškach). Každá iná
// hodnota (aj neznámej premennej) sa považuje za tajomstvo.
const NON_SECRET_VARS = new Set([
  "NEXT_PUBLIC_SUPABASE_URL",
  "ESBLU_EINVOICE_PROVIDER",
  "ESBLU_EINVOICE_ENVIRONMENT",
  "ESBLU_EINVOICE_LIVE_ENABLED",
  "VERCEL_ENV",
  "ESBLU_EFAKTURA_BASE_URL",
  "ESBLU_EINVOICE_WORKER_BATCH",
  "ESBLU_CORS_EXTRA_ORIGINS",
  "ESBLU_LEGAL_CONTENT_ROOT",
  "NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS",
  "NEXT_PUBLIC_ESBLU_BUILD_ID",
  "STAGING_SUPABASE_REF",
]);

// Zdedené z shellu → do procesu Next.js sa NEPRENESÚ (môžu ukazovať na produkciu).
const INHERITED_DENY = /^(NEXT_PUBLIC_|SUPABASE|ESBLU_|EFAKTURA|VERCEL|OPENAI|CRON_SECRET$|VAPID_|FCM_|APNS_|DATABASE_URL$|DIRECT_URL$|POSTGRES|PROD_DB_URL$|STAGING_DB_URL$|PG(HOST|PORT|USER|PASSWORD|DATABASE|SSLMODE|SERVICE|PASSFILE)$|__NEXT_)/i;

const REPO_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];

export class LauncherStop extends Error {
  constructor(message, code = 3) {
    super(message);
    this.name = "LauncherStop";
    this.exitCode = code;
  }
}

// ---------------------------------------------------------------------------
// Redakcia — každá hodnota z env súboru je tajomstvo.
// ---------------------------------------------------------------------------
export function createRedactor() {
  const secrets = new Set();
  return {
    add(value) {
      if (typeof value !== "string") return;
      const v = value.trim();
      if (v.length >= 4) secrets.add(v);
      // JWT: aj jednotlivé časti (payload/podpis) sa môžu objaviť samostatne.
      if (/^eyJ/.test(v)) for (const part of v.split(".")) if (part.length >= 8) secrets.add(part);
    },
    redact(text) {
      let out = String(text ?? "");
      for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("<redacted>");
      out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "<jwt>");
      out = out.replace(/\b(efk_pk_(?:test|live)_|whsec_|sb_secret_|sb_publishable_|sk-)[A-Za-z0-9_-]+/g, "$1<redacted>");
      out = out.replace(/postgres(?:ql)?:\/\/\S+/gi, "<db-url>");
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Parser env súboru — chyby uvádzajú iba číslo riadku, nikdy obsah.
// ---------------------------------------------------------------------------
export function parseEnvText(text) {
  const vars = {};
  const errors = [];
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) {
      errors.push(`riadok ${lineNo}: chýba KEY=VALUE`);
      return;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`riadok ${lineNo}: neplatný názov premennej`);
      return;
    }
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value[value.length - 1] !== quote) {
        errors.push(`riadok ${lineNo} (${key}): neukončené úvodzovky (viacriadkové hodnoty nie sú podporované)`);
        return;
      }
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      errors.push(`riadok ${lineNo}: ${key} je definovaná viackrát`);
      return;
    }
    vars[key] = value;
  });
  return { vars, errors };
}

/** Iba NÁZVY premenných (hodnoty sa okamžite zahodia). */
export function envFileKeyNames(text) {
  return Object.keys(parseEnvText(text).vars);
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

const PLACEHOLDER = /(<[^>]*>|^\s*(changeme|change_me|todo|tbd|xxx+|\.\.\.|placeholder|your[-_ ].*)\s*$)/i;

/**
 * Overí kľúč Supabase. JWT: payload.ref MUSÍ byť staging a role zodpovedať.
 * Nové kľúče (sb_publishable_/sb_secret_) ref neobsahujú → poznámka.
 */
function checkSupabaseKey(name, value, expectedRole, errors, notes) {
  if (value.startsWith("eyJ")) {
    const payload = decodeJwtPayload(value);
    if (!payload) {
      errors.push(`${name}: neplatný JWT formát`);
      return;
    }
    if (payload.ref === PRODUCTION_REF) {
      errors.push(`${name}: kľúč patrí PRODUKČNÉMU projektu`);
      return;
    }
    if (payload.ref !== STAGING_REF) errors.push(`${name}: kľúč nepatrí staging projektu ${STAGING_REF}`);
    if (payload.role !== expectedRole) errors.push(`${name}: očakávaná rola ${expectedRole}`);
    if (payload.ref === STAGING_REF && payload.role === expectedRole) notes.push(`${name}: JWT ref = staging, rola ${expectedRole} ✓`);
    return;
  }
  if (expectedRole === "anon") {
    if (value.startsWith("sb_secret_")) errors.push(`${name}: tajný kľúč v NEXT_PUBLIC_ premennej — zakázané`);
    else if (value.startsWith("sb_publishable_")) notes.push(`${name}: publishable kľúč (projekt sa z neho overiť nedá — skontroluj, že je zo stagingu)`);
    else errors.push(`${name}: neznámy formát kľúča`);
  } else {
    if (value.startsWith("sb_publishable_")) errors.push(`${name}: publishable kľúč namiesto service_role`);
    else if (value.startsWith("sb_secret_")) notes.push(`${name}: secret kľúč (projekt sa z neho overiť nedá — skontroluj, že je zo stagingu)`);
    else errors.push(`${name}: neznámy formát kľúča`);
  }
}

/** Validácia staging env. Vracia { errors, notes } — správy nikdy neobsahujú hodnoty. */
export function validateStagingEnv(vars) {
  const errors = [];
  const notes = [];
  const allowed = new Set([...REQUIRED_VARS, ...OPTIONAL_VARS]);

  // 1) produkčný ref kdekoľvek (aj v názve), staging marker nesmie chýbať
  for (const [key, value] of Object.entries(vars)) {
    if (key.includes(PRODUCTION_REF) || value.includes(PRODUCTION_REF)) errors.push(`${key}: obsahuje produkčný project ref — STOP`);
  }

  // 2) iba známe názvy
  const unknown = Object.keys(vars).filter((k) => !allowed.has(k));
  if (unknown.length > 0) errors.push(`nepovolené premenné (odstráň ich zo súboru): ${unknown.sort().join(", ")}`);

  // 3) povinné, neprázdne, nie zástupné hodnoty
  const missing = REQUIRED_VARS.filter((k) => !vars[k] || vars[k].trim() === "");
  if (missing.length > 0) errors.push(`chýbajú povinné premenné: ${missing.join(", ")}`);
  for (const [key, value] of Object.entries(vars)) {
    if (value && PLACEHOLDER.test(value)) errors.push(`${key}: obsahuje zástupnú hodnotu zo šablóny`);
  }

  const v = (k) => (vars[k] ?? "").trim();

  // 4) Supabase URL — presne staging host
  if (v("NEXT_PUBLIC_SUPABASE_URL")) {
    let url = null;
    try {
      url = new URL(v("NEXT_PUBLIC_SUPABASE_URL"));
    } catch {
      errors.push("NEXT_PUBLIC_SUPABASE_URL: neplatná URL");
    }
    if (url) {
      if (!v("NEXT_PUBLIC_SUPABASE_URL").includes(STAGING_REF)) errors.push(`NEXT_PUBLIC_SUPABASE_URL: neobsahuje staging ref ${STAGING_REF}`);
      else if (url.protocol !== "https:" || url.hostname.toLowerCase() !== STAGING_SUPABASE_HOST || (url.pathname !== "/" && url.pathname !== "") || url.port) {
        errors.push(`NEXT_PUBLIC_SUPABASE_URL: musí byť presne https://${STAGING_SUPABASE_HOST}`);
      } else notes.push("NEXT_PUBLIC_SUPABASE_URL: staging ✓");
    }
  }

  // 5) Supabase kľúče
  if (v("NEXT_PUBLIC_SUPABASE_ANON_KEY")) checkSupabaseKey("NEXT_PUBLIC_SUPABASE_ANON_KEY", v("NEXT_PUBLIC_SUPABASE_ANON_KEY"), "anon", errors, notes);
  if (v("SUPABASE_SERVICE_ROLE_KEY")) checkSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", v("SUPABASE_SERVICE_ROLE_KEY"), "service_role", errors, notes);
  if (v("NEXT_PUBLIC_SUPABASE_ANON_KEY") && v("NEXT_PUBLIC_SUPABASE_ANON_KEY") === v("SUPABASE_SERVICE_ROLE_KEY")) {
    errors.push("NEXT_PUBLIC_SUPABASE_ANON_KEY a SUPABASE_SERVICE_ROLE_KEY sú rovnaké");
  }

  // 6) eInvoice — iba sandbox
  if (v("ESBLU_EINVOICE_PROVIDER") && v("ESBLU_EINVOICE_PROVIDER") !== "efaktura_sk") errors.push("ESBLU_EINVOICE_PROVIDER: musí byť efaktura_sk");
  if (v("ESBLU_EINVOICE_ENVIRONMENT") && v("ESBLU_EINVOICE_ENVIRONMENT") !== "sandbox") errors.push("ESBLU_EINVOICE_ENVIRONMENT: musí byť sandbox (live je v L3 zakázané)");
  const live = v("ESBLU_EINVOICE_LIVE_ENABLED").toLowerCase();
  if (live !== "" && live !== "false") errors.push("ESBLU_EINVOICE_LIVE_ENABLED: v L3 zakázané (povolené iba prázdne alebo false)");
  const vercelEnv = v("VERCEL_ENV").toLowerCase();
  if (vercelEnv === "production") errors.push("VERCEL_ENV=production je zakázané");
  else if (vercelEnv !== "" && vercelEnv !== "development") errors.push("VERCEL_ENV: povolené iba development");
  const apiKey = v("ESBLU_EFAKTURA_API_KEY");
  if (apiKey) {
    if (apiKey.startsWith("efk_pk_live_")) errors.push("ESBLU_EFAKTURA_API_KEY: LIVE kľúč — zakázané");
    else if (!apiKey.startsWith("efk_pk_test_")) errors.push("ESBLU_EFAKTURA_API_KEY: musí byť sandbox kľúč efk_pk_test_…");
    else notes.push("ESBLU_EFAKTURA_API_KEY: sandbox (efk_pk_test_) ✓");
  }
  const whs = v("ESBLU_EFAKTURA_WEBHOOK_SECRETS");
  if (whs) {
    const items = whs.split(",").map((s) => s.trim()).filter(Boolean);
    if (items.length === 0 || items.some((s) => s.length < 16)) errors.push("ESBLU_EFAKTURA_WEBHOOK_SECRETS: každé tajomstvo musí mať aspoň 16 znakov");
    else notes.push(`ESBLU_EFAKTURA_WEBHOOK_SECRETS: ${items.length} tajomstvo/á ✓`);
  }
  if (v("STAGING_SUPABASE_REF") && v("STAGING_SUPABASE_REF") !== STAGING_REF) errors.push(`STAGING_SUPABASE_REF: musí byť ${STAGING_REF}`);
  const baseUrl = v("ESBLU_EFAKTURA_BASE_URL");
  if (baseUrl && baseUrl.replace(/\/+$/, "") !== "https://api.efaktura.sk") errors.push("ESBLU_EFAKTURA_BASE_URL: povolené iba https://api.efaktura.sk");

  // 7) aplikačné tajomstvá
  if (v("CRON_SECRET") && v("CRON_SECRET").length < 32) errors.push("CRON_SECRET: aspoň 32 znakov");
  if (v("ESBLU_ACTION_CONFIRMATION_SECRET") && !/^[0-9a-fA-F]{64,}$/.test(v("ESBLU_ACTION_CONFIRMATION_SECRET"))) {
    errors.push("ESBLU_ACTION_CONFIRMATION_SECRET: musí byť hex, aspoň 64 znakov (32 B)");
  }
  if (v("ESBLU_INTAKE_ATTEST_SECRET") && v("ESBLU_INTAKE_ATTEST_SECRET").length < 32) errors.push("ESBLU_INTAKE_ATTEST_SECRET: aspoň 32 znakov (alebo vynechaj)");
  if (!v("ESBLU_INTAKE_ATTEST_SECRET")) notes.push("ESBLU_INTAKE_ATTEST_SECRET: nenastavené (upload dokladov/AI intake nebude dostupný — pre eInvoice E2E netreba)");
  if (!v("OPENAI_API_KEY")) notes.push("OPENAI_API_KEY: nenastavené (AI funkcie vypnuté — pre eInvoice E2E netreba)");

  // 8) tajomstvá sa nesmú opakovať (napr. CRON_SECRET = webhook secret)
  const secretKeys = ["SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "ESBLU_ACTION_CONFIRMATION_SECRET", "ESBLU_EFAKTURA_API_KEY", "ESBLU_EFAKTURA_WEBHOOK_SECRETS", "ESBLU_INTAKE_ATTEST_SECRET"];
  const seen = new Map();
  for (const k of secretKeys) {
    const val = v(k);
    if (!val) continue;
    if (seen.has(val)) errors.push(`${k} má rovnakú hodnotu ako ${seen.get(val)}`);
    else seen.set(val, k);
  }

  return { errors, notes };
}

function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  const relCmp = process.platform === "win32" ? rel.toLowerCase() : rel;
  return rel === "" || (!relCmp.startsWith("..") && !path.isAbsolute(rel));
}

export function defaultEnvFile(env = process.env) {
  return env.ESBLU_L3_ENV_FILE?.trim() || path.join(os.homedir(), "Documents", "esblu-l3-staging.env");
}

export function parseArgs(argv) {
  const out = { envFile: null, check: false, nextArgs: [] };
  const dd = argv.indexOf("--");
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  out.nextArgs = dd >= 0 ? argv.slice(dd + 1) : [];
  for (const a of own) {
    if (a === "--check") out.check = true;
    else if (a.startsWith("--l3-env=")) out.envFile = a.slice("--l3-env=".length);
    else throw new LauncherStop(`neznámy argument (použi --l3-env=…, --check, -- <args pre next dev>)`, 2);
  }
  // next dev beží bez shellu; povolené sú iba jednoduché tokeny (port, hostname, prepínače).
  for (const a of out.nextArgs) {
    if (!/^[A-Za-z0-9.:=_-]+$/.test(a)) throw new LauncherStop("nepovolený argument pre next dev", 2);
  }
  return out;
}

/** Názvy premenných zo všetkých env súborov repa (hodnoty sa nečítajú do výsledku). */
export function repoEnvNames(root, readFile = readFileSync) {
  const names = new Set();
  for (const f of REPO_ENV_FILES) {
    const p = path.join(root, f);
    if (!existsSync(p)) continue;
    for (const n of envFileKeyNames(readFile(p, "utf8"))) names.add(n);
  }
  return [...names];
}

export function fileFingerprint(p) {
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Odtlačok všetkých .env* súborov repa (iba hash, obsah sa nikam neukladá). */
export function repoEnvFingerprint(root) {
  return JSON.stringify(REPO_ENV_FILES.map((f) => fileFingerprint(path.join(root, f))));
}

/** Env pre proces Next.js: čisté systémové env + staging hodnoty + prekrytie env súborov repa. */
export function buildChildEnv(parentEnv, stagingVars, repoNames) {
  const env = {};
  for (const [k, val] of Object.entries(parentEnv)) {
    if (val === undefined) continue;
    if (INHERITED_DENY.test(k)) continue;
    if (k === "NODE_OPTIONS" && /--env-file|--require|-r\s|--import/.test(val)) continue;
    env[k] = val;
  }
  // .env.local (produkčný hardlink) ani iné .env* nesmú nič doplniť: Next.js
  // nikdy neprepíše existujúcu premennú → každý názov z nich prekryjeme prázdnou.
  for (const n of repoNames) env[n] = "";
  for (const [k, val] of Object.entries(stagingVars)) env[k] = val.trim();
  env.ESBLU_EINVOICE_LIVE_ENABLED = "false";
  env.VERCEL_ENV = "development";
  env.NODE_ENV = "development";
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.ESBLU_L3_STAGING = "1";
  // Next.js: env súbory sú „už spracované" → .env.local sa nenačíta vôbec.
  env.__NEXT_PROCESSED_ENV = "true";
  return env;
}

/** Posledná poistka: v celom env potomka nesmie byť produkčný ref. */
export function assertChildEnvSafe(env) {
  for (const [k, val] of Object.entries(env)) {
    if (k.includes(PRODUCTION_REF) || String(val).includes(PRODUCTION_REF)) throw new LauncherStop(`produkčný ref v env procesu (${k}) — STOP`);
    if (String(val).startsWith("eyJ")) {
      const p = decodeJwtPayload(String(val));
      if (p && p.ref === PRODUCTION_REF) throw new LauncherStop(`produkčný JWT v env procesu (${k}) — STOP`);
    }
  }
  if (env.ESBLU_EINVOICE_LIVE_ENABLED === "true" || env.VERCEL_ENV === "production" || env.ESBLU_EINVOICE_ENVIRONMENT !== "sandbox") {
    throw new LauncherStop("live/production príznak v env procesu — STOP");
  }
  if (!String(env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new LauncherStop("Supabase URL procesu nie je staging — STOP");
}

/**
 * Hlavná logika. Všetko vstupné je injektovateľné (testy bez reálneho Next.js).
 * Vracia Promise<exitCode>.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  root = REPO_ROOT,
  spawnImpl = nodeSpawn,
  resolveNext = (dir) => createRequire(path.join(dir, "package.json")).resolve("next/dist/bin/next"),
  readFile = readFileSync,
  pollMs = 2000,
  out =(s) => process.stdout.write(`${s}\n`),
  err = (s) => process.stderr.write(`${s}\n`),
  redactor = createRedactor(),
} = {}) {
  const say = (s) => out(redactor.redact(s));
  const fail = (s) => err(redactor.redact(s));
  try {
    const args = parseArgs(argv);
    const envFile = path.resolve(args.envFile || defaultEnvFile(env));

    if (isInside(envFile, root)) throw new LauncherStop("env súbor musí byť MIMO repa (nikdy .env.local) — STOP");
    if (path.basename(envFile).toLowerCase().startsWith(".env")) throw new LauncherStop("env súbor sa nesmie volať .env* (zámena s Next.js súbormi) — STOP");
    if (!existsSync(envFile)) throw new LauncherStop(`env súbor neexistuje: ${envFile}\n  Vytvor ho podľa docs/einvoice-l3-env-template.txt`, 2);

    let text;
    try {
      text = readFile(envFile, "utf8");
    } catch {
      throw new LauncherStop("env súbor sa nedá prečítať", 2);
    }
    const { vars, errors: parseErrors } = parseEnvText(text);
    text = null;
    for (const [key, val] of Object.entries(vars)) if (!NON_SECRET_VARS.has(key)) redactor.add(val);
    if (parseErrors.length > 0) throw new LauncherStop(`env súbor má chyby:\n  - ${parseErrors.join("\n  - ")}`, 2);

    const { errors, notes } = validateStagingEnv(vars);
    if (errors.length > 0) throw new LauncherStop(`staging env neprešiel kontrolou:\n  - ${errors.join("\n  - ")}`);

    const envLocal = path.join(root, ".env.local");
    const before = fileFingerprint(envLocal);
    const beforeAll = repoEnvFingerprint(root);
    const names = repoEnvNames(root, readFile);
    const childEnv = buildChildEnv(env, vars, names);
    assertChildEnvSafe(childEnv);

    say(`L3 staging env OK (${envFile})`);
    for (const n of notes) say(`  · ${n}`);
    say(`  · premenné: ${Object.keys(vars).sort().join(", ")}`);
    say(`  · .env* repa: ${names.length} názvov prekrytých prázdnou hodnotou — ich hodnoty sa do Next.js nedostanú (Next.js môže v hlavičke vypísať „Environments: .env.local", súbor nájde, ale nič z neho nepoužije); zmena .env* počas behu = STOP`);

    if (args.check) {
      say("--check: nič sa nespúšťa.");
      return 0;
    }

    let nextBin;
    try {
      nextBin = resolveNext(root);
    } catch {
      throw new LauncherStop("next sa nenašiel v node_modules (spusti npm install)", 2);
    }
    const nextArgs = ["dev", ...(args.nextArgs.some((a) => /^(-p|--port)/.test(a)) ? [] : ["--port", "3000"]), ...args.nextArgs];
    say(`Spúšťam: next ${nextArgs.join(" ")} (staging ${STAGING_REF}, eFaktura sandbox)`);

    const child = spawnImpl(process.execPath, [nextBin, ...nextArgs], { cwd: root, env: childEnv, stdio: "inherit", windowsHide: false });
    const forward = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);

    // Next.js dev pri zmene .env* súboru znova načíta env (forceReload) a NOVÉ
    // názvy by doplnil → akákoľvek zmena .env* repa počas behu = okamžitý STOP.
    let tripped = false;
    const watcher = setInterval(() => {
      if (tripped || repoEnvFingerprint(root) === beforeAll) return;
      tripped = true;
      fail("STOP: .env* súbor repa sa počas behu zmenil — dev server sa zastavuje (Next.js by ho znova načítal).");
      forward("SIGTERM")();
    }, pollMs);

    const code = await new Promise((resolve) => {
      child.on("error", (e) => {
        fail(`STOP: next dev sa nepodarilo spustiť (${e && e.code ? e.code : "?"})`);
        resolve(1);
      });
      child.on("exit", (c, s) => resolve(c ?? (s ? 1 : 0)));
    });
    clearInterval(watcher);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);

    if (tripped) return 5;
    const after = fileFingerprint(envLocal);
    if (before !== after) {
      fail("VAROVANIE: .env.local sa počas behu zmenil (nie launcherom) — skontroluj ho.");
      return code || 4;
    }
    say(".env.local nezmenený ✓");
    return code;
  } catch (e) {
    if (e instanceof LauncherStop) {
      fail(`STOP: ${e.message}`);
      return e.exitCode;
    }
    fail(`STOP: neočakávaná chyba (${e && e.name ? e.name : "Error"}): ${e && e.message ? e.message : "?"}`);
    return 1;
  }
}

const isCli = process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (isCli) {
  const redactor = createRedactor();
  const safeExit = (label) => (e) => {
    process.stderr.write(`STOP: ${label}: ${redactor.redact(e && e.message ? e.message : String(e))}\n`);
    process.exit(1);
  };
  process.on("uncaughtException", safeExit("neočakávaná chyba"));
  process.on("unhandledRejection", safeExit("neočakávaná chyba"));
  main({ redactor }).then((code) => process.exit(code));
}
