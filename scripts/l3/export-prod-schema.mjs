// =============================================================================
// L3 — READ-ONLY export štruktúry PRODUKCIE (bez dát používateľov) pre staging.
// Spúšťa IBA používateľ lokálne, po výslovnom súhlase. Claude ho nespúšťa.
//
// Bezpečnosť:
//   - pg_dump beží s PGOPTIONS="-c default_transaction_read_only=on"
//     (produkcia sa nemôže zmeniť ani omylom),
//   - --schema-only pre public (štruktúra, RLS, granty, funkcie, triggery),
//   - z managed schém iba: politiky storage.objects, triggery auth.users,
//     riadky storage.buckets (konfigurácia bucketov) a referenčné dáta
//     4 katalógových tabuliek (legal_documents, plan_limits, ai_scan_limits,
//     entitlement_catalog) — ŽIADNE dáta firiem, používateľov ani dokladov,
//   - výstup iba do .l3-local/ (gitignored).
//   - PROD_DB_URL sa NIKDY nedostane do argv pg_dump (ani do zoznamu procesov,
//     ani do textu chyby child_process): rozloží sa na PGHOST/PGPORT/PGUSER/
//     PGPASSWORD/PGDATABASE/PGSSLMODE a samotná premenná sa z env potomka
//     odstráni. Chyby pg_dump sa vypisujú iba redigované (bez hesla, používateľa,
//     hostiteľa a akéhokoľvek connection stringu).
//
// Oprava 2026-10-03 (prázdne 20-/21- súbory): pg_dump na Windows zapisuje CRLF,
// pôvodný výber `;\n` preto nenašiel ani jeden príkaz. Výstup sa teraz
// normalizuje na LF a výber je fail-closed (ak dump príkazy obsahuje, ale výber
// je prázdny, skript skončí chybou namiesto zápisu prázdneho súboru).
//
// Použitie (PowerShell, z koreňa worktree; pg_dump 17 v PATH):
//   node --env-file=C:\cesta\mimo\repa\esblu-prod-readonly.env scripts/l3/export-prod-schema.mjs --confirm-read-only
//   env súbor: PROD_DB_URL=postgresql://…  (session pooler, iba na tento export)
// =============================================================================
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PRODUCTION_REF, STAGING_REF } from "./staging-guard.mjs";

const secrets = new Set();

/** Odstráni z textu všetko, čo by mohlo prezradiť prístup k produkcii. */
export function redact(text) {
  let out = String(text ?? "");
  out = out.replace(/postgres(?:ql)?:\/\/\S+/gi, "<db-url>");
  out = out.replace(/(password\s*=\s*)\S+/gi, "$1<redacted>");
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s && s.length >= 3) out = out.split(s).join("<redacted>");
  }
  return out;
}

function stop(message, code = 2) {
  console.error(`STOP: ${redact(message)}`);
  process.exit(code);
}

process.on("uncaughtException", (error) => stop(`neočakávaná chyba: ${error instanceof Error ? error.message : "?"}`));

/** Rozloží PROD_DB_URL na libpq premenné (heslo nikdy nejde do argv). */
export function connectionEnv(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("PROD_DB_URL nie je platná URL");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("PROD_DB_URL musí začínať postgresql://");
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  if (!u.hostname || !user || !password) throw new Error("PROD_DB_URL neobsahuje hostiteľa, používateľa alebo heslo");
  for (const s of [rawUrl, user, password, u.hostname, `${u.hostname}:${u.port}`]) secrets.add(s);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
    PGSSLMODE: u.searchParams.get("sslmode") || "require",
  };
}

/** CRLF → LF a bez psql meta-príkazov \restrict / \unrestrict (pg_dump ≥ 17.6). */
export function normalizeDump(text) {
  return text.replace(/\r\n?/g, "\n").replace(/^\\(?:un)?restrict\b.*\n?/gm, "");
}

/** Vyberie celé príkazy (začiatok riadku → `;` na konci riadku). */
export function pickStatements(sql, keyword) {
  const re = new RegExp(`^${keyword} [\\s\\S]*?;$`, "gm");
  return sql.match(re) ?? [];
}

function main() {
  if (!process.argv.includes("--confirm-read-only")) stop("chýba --confirm-read-only");
  const url = process.env.PROD_DB_URL?.trim() ?? "";
  if (!url) stop("chýba PROD_DB_URL (env súbor mimo repa)");
  secrets.add(url);
  if (!url.includes(PRODUCTION_REF)) stop("PROD_DB_URL nie je produkčný projekt — export je určený iba na čítanie produkcie");
  if (url.includes(STAGING_REF)) stop("PROD_DB_URL ukazuje na staging");

  let conn;
  try {
    conn = connectionEnv(url);
  } catch (error) {
    stop(error instanceof Error ? error.message : "neplatná PROD_DB_URL");
  }

  const env = { ...process.env, ...conn, PGOPTIONS: "-c default_transaction_read_only=on", PGCONNECT_TIMEOUT: "15", PGAPPNAME: "esblu-l3-readonly-export" };
  delete env.PROD_DB_URL;

  const out = path.resolve(".l3-local");
  mkdirSync(out, { recursive: true });

  const dump = (label, args) => {
    // Žiadne heslo ani URL v argv; stderr sa nededí — vypíše sa iba redigovaný.
    const r = spawnSync("pg_dump", ["--no-password", ...args], {
      env,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (r.error) {
      stop(r.error.code === "ENOENT" ? "pg_dump sa nenašiel v PATH (potrebný pg_dump 17)" : `pg_dump sa nepodarilo spustiť (${label}): ${r.error.code ?? "?"}`);
    }
    if (r.status !== 0) {
      const err = redact(r.stderr?.toString("utf8") ?? "").split(/\r?\n/).filter(Boolean).slice(0, 15).join("\n  ");
      stop(`pg_dump zlyhal pri ${label} (exit ${r.status ?? r.signal})${err ? `:\n  ${err}` : ""}`);
    }
    return normalizeDump(r.stdout.toString("utf8"));
  };

  const files = {};
  const write = (name, content) => {
    const body = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
    writeFileSync(path.join(out, name), body, "utf8");
    files[name] = { bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") };
  };

  // 1) public — iba štruktúra
  write("10-prod-public-schema.sql", dump("public schema", ["--schema-only", "--schema=public"]));

  // 2) managed schémy — iba objekty, ktoré definujú Esblu migrácie
  const storageDdl = dump("storage.objects", ["--schema-only", "--table=storage.objects"]);
  const authDdl = dump("auth.users", ["--schema-only", "--table=auth.users"]);
  if (!/^CREATE TABLE storage\.objects\b/m.test(storageDdl)) stop("dump neobsahuje storage.objects (filter alebo oprávnenie) — nič sa nezapísalo");
  if (!/^CREATE TABLE auth\.users\b/m.test(authDdl)) stop("dump neobsahuje auth.users (filter alebo oprávnenie) — nič sa nezapísalo");

  const policies = pickStatements(storageDdl, "CREATE POLICY");
  const policyComments = pickStatements(storageDdl, "COMMENT ON POLICY");
  const triggers = pickStatements(authDdl, "CREATE TRIGGER");
  const triggerComments = pickStatements(authDdl, "COMMENT ON TRIGGER");
  // Fail-closed: dump príkazy má, výber je prázdny → chyba parsovania, nie „produkcia nič nemá".
  const rawPolicies = (storageDdl.match(/^CREATE POLICY /gm) ?? []).length;
  const rawTriggers = (authDdl.match(/^CREATE TRIGGER /gm) ?? []).length;
  if (rawPolicies !== policies.length) stop(`výber politík nesedí (${policies.length} z ${rawPolicies}) — nič sa nezapísalo`);
  if (rawTriggers !== triggers.length) stop(`výber triggerov nesedí (${triggers.length} z ${rawTriggers}) — nič sa nezapísalo`);

  write("20-prod-storage-policies.sql", [...policies, ...policyComments].join("\n\n"));
  write("21-prod-auth-users-triggers.sql", [...triggers, ...triggerComments].join("\n\n"));

  // 3) konfigurácia bucketov + referenčné katalógy (žiadne osobné údaje)
  write("30-prod-storage-buckets.sql", dump("storage.buckets", ["--data-only", "--table=storage.buckets", "--inserts", "--column-inserts"]));
  write(
    "31-prod-reference-data.sql",
    dump("reference data", ["--data-only", "--inserts", "--column-inserts", "--table=public.legal_documents", "--table=public.plan_limits", "--table=public.ai_scan_limits", "--table=public.entitlement_catalog"])
  );

  const manifest = {
    generated_at: new Date().toISOString(),
    source: "production (read-only)",
    counts: { storage_policies: policies.length, auth_users_triggers: triggers.length },
    files,
  };
  writeFileSync(path.join(out, "00-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const [name, f] of Object.entries(files)) console.log(`OK ${name} (${f.bytes} B)`);
  console.log(`storage.objects politiky: ${policies.length}, auth.users triggery: ${triggers.length}`);
  console.log("Hotovo — súbory sú v .l3-local/ (gitignored). Nič sa nezmenilo.");
}

const isCli = process.argv[1]?.endsWith("export-prod-schema.mjs");
if (isCli) main();
