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
//   - výstup iba do .l3-local/ (gitignored), DB URL sa nikdy nevypisuje.
//
// Použitie (PowerShell, z koreňa worktree; pg_dump 17 v PATH):
//   node --env-file=C:\cesta\mimo\repa\esblu-prod-readonly.env scripts/l3/export-prod-schema.mjs --confirm-read-only
//   env súbor: PROD_DB_URL=postgresql://…  (session pooler, iba na tento export)
// =============================================================================
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PRODUCTION_REF, STAGING_REF } from "./staging-guard.mjs";

function stop(m) {
  console.error(`STOP: ${m}`);
  process.exit(2);
}
if (!process.argv.includes("--confirm-read-only")) stop("chýba --confirm-read-only");
const url = process.env.PROD_DB_URL?.trim() ?? "";
if (!url) stop("chýba PROD_DB_URL (env súbor mimo repa)");
if (!url.includes(PRODUCTION_REF)) stop("PROD_DB_URL nie je produkčný projekt — export je určený iba na čítanie produkcie");
if (url.includes(STAGING_REF)) stop("PROD_DB_URL ukazuje na staging");

const out = path.resolve(".l3-local");
mkdirSync(out, { recursive: true });
const env = { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on", PGCONNECT_TIMEOUT: "15" };
const dump = (args) => execFileSync("pg_dump", [...args, "--dbname", url], { env, maxBuffer: 256 * 1024 * 1024 }).toString("utf8");

// 1) public — iba štruktúra
writeFileSync(path.join(out, "10-prod-public-schema.sql"), dump(["--schema-only", "--schema=public"]));
// 2) managed schémy — iba objekty, ktoré definujú Esblu migrácie
const storageDdl = dump(["--schema-only", "--table=storage.objects"]);
const authDdl = dump(["--schema-only", "--table=auth.users"]);
const pick = (sql, re) => (sql.match(re) ?? []).join("\n\n");
writeFileSync(path.join(out, "20-prod-storage-policies.sql"), pick(storageDdl, /CREATE POLICY [\s\S]*?;\n/g));
writeFileSync(path.join(out, "21-prod-auth-users-triggers.sql"), pick(authDdl, /CREATE TRIGGER [\s\S]*?;\n/g));
// 3) konfigurácia bucketov + referenčné katalógy (žiadne osobné údaje)
writeFileSync(path.join(out, "30-prod-storage-buckets.sql"), dump(["--data-only", "--table=storage.buckets", "--inserts"]));
writeFileSync(
  path.join(out, "31-prod-reference-data.sql"),
  dump(["--data-only", "--inserts", "--table=public.legal_documents", "--table=public.plan_limits", "--table=public.ai_scan_limits", "--table=public.entitlement_catalog"])
);
const size = (f) => readFileSync(path.join(out, f)).byteLength;
for (const f of ["10-prod-public-schema.sql", "20-prod-storage-policies.sql", "21-prod-auth-users-triggers.sql", "30-prod-storage-buckets.sql", "31-prod-reference-data.sql"]) {
  console.log(`OK ${f} (${size(f)} B)`);
}
console.log("Hotovo — súbory sú v .l3-local/ (gitignored). Nič sa nezmenilo.");
