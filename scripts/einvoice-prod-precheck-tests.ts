// =============================================================================
// Test produkčného prechecku (scripts/sql/einvoice-prod-precheck.sql) — IBA PGlite, nikdy produkcia.
//
//  1. Statika: skript je striktne READ ONLY (BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;) a
//     neobsahuje DML/DDL mimo komentárov.
//  2. Simulácia PRODUKCIE: kostra + migrácie PRED reťazcom eFaktúry + schema_migrations s poslednou
//     verziou 20261005091000 → všetky kontroly OK / INFO (žiadne STOP / WARN).
//  3. Negatívny prípad: séria PF už existuje → STOP numbering_new_series.
//  4. Po reťazci 20261002100000 … 20261008100011 (= stav stagingu) → skript stále beží a hlási STOP
//     pre stav migrácií, nové tabuľky, funkcie a stĺpce.
// Spustenie: npm run test:einvoice-prod-precheck
// =============================================================================
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EINVOICE_MIGRATIONS } from "./einvoice-partner-harness.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const PRECHECK = read("scripts/sql/einvoice-prod-precheck.sql");
const CHAIN_START = "20261002100000";

let passed = 0;
const failures: string[] = [];
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  ✗ ${label}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Row = { ord: number; check_name: string; status: string; detail: string | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

async function freshDb(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  const crypto = dir ? pathToFileURL(path.join(dir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto";
  const { PGlite } = await import(main);
  const { pgcrypto } = await import(crypto);
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(read("scripts/sql/pglite/einvoice-baseline.sql"));
  for (const m of EINVOICE_MIGRATIONS.filter((m) => m < CHAIN_START)) await db.exec(read(`supabase/migrations/${m}`));
  // Produkčná evidencia migrácií: posledná je 20261005091000 (main), eFaktúra ešte nie.
  await db.exec(`create schema if not exists supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key, name text);
    insert into supabase_migrations.schema_migrations values ('20260929100000', 'closed_beta_p0_hardening'),
      ('20261005090000', 'media_storage_access_model'), ('20261005091000', 'private_media_buckets');`);
  return db;
}

async function runPrecheck(db: Db): Promise<Row[]> {
  const results = await db.exec(PRECHECK);
  const res = results.find((r: { fields: { name: string }[] }) => r.fields.some((f) => f.name === "check_name"));
  assert.ok(res, "výsledok súhrnu nenájdený");
  return res.rows as Row[];
}

console.log("eFaktúra — produkčný precheck (PGlite)");

await check("statika: READ ONLY transakcia, ROLLBACK, žiadne DML/DDL mimo komentárov", () => {
  // bez komentárov a bez textových literálov (detailné správy smú spomínať napr. „DROP IF EXISTS")
  const code = PRECHECK.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''");
  assert.match(code, /^\s*begin;\s*set transaction read only;/i);
  assert.match(code, /rollback;\s*$/i);
  const forbidden = /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|create\s+(table|index|function|trigger|policy|schema)|alter\s+(table|function)|drop\s+\w+|grant\s|revoke\s|copy\s|vacuum|refresh\s+materialized|set\s+role|pg_read_file|lo_import)\b/i;
  assert.doesNotMatch(code, forbidden);
});

let prodRows: Row[] = [];
await check("simulácia produkcie (schéma pred reťazcom): všetky kontroly OK / INFO", async () => {
  const db = await freshDb();
  prodRows = await runPrecheck(db);
  const bad = prodRows.filter((r) => r.status !== "OK" && r.status !== "INFO");
  assert.deepEqual(bad.map((r) => `${r.ord} ${r.check_name} ${r.status}: ${r.detail}`), []);
  assert.ok(prodRows.length >= 36, String(prodRows.length));
  // READ ONLY: po skripte žiadna zmena
  const { rows } = await db.query("select count(*)::int n from supabase_migrations.schema_migrations");
  assert.equal(rows[0].n, 3);
  await db.close();
});

await check("kontroly pokrývajú nové constraints až po 20261008100011", () => {
  const names = new Set(prodRows.map((r) => r.check_name));
  for (const n of ["migration_state", "einvoice_objects_absent", "new_columns_absent", "function_signature_drift", "ck_items_vat_category",
    "ck_invoices_kind", "ck_invoices_payment_status", "ck_corrections_reference", "duplicate_invoice_numbers", "number_sequence_behind_existing",
    "currency_format", "items_negative_unit_price", "new_tables_absent", "new_functions_absent", "required_objects_present", "rls_enabled_invoicing",
    "numbering_new_series", "drafts_with_items_breaking_new_checks", "received_invoices_overview"]) assert.ok(names.has(n), n);
  assert.match(PRECHECK, /'einvoice_outbound', 'sbdh_instance_identifier'/);
  assert.match(PRECHECK, /\('esblu_einvoice_outbound_record_transport'\)/);
  assert.match(PRECHECK, /\('received_advance_links'\)/);
});

await check("negatívny prípad: existujúca séria PF → STOP numbering_new_series", async () => {
  const db = await freshDb();
  await db.exec(`insert into public.companies (id, name) values ('c0000000-0000-4000-8000-000000000001', 'Synthetic s.r.o.');
    insert into public.invoice_number_sequences (company_id, year, series_key, prefix) values ('c0000000-0000-4000-8000-000000000001', 2026, 'proforma', 'PF');`);
  const rows = await runPrecheck(db);
  assert.equal(rows.find((r) => r.check_name === "numbering_new_series")?.status, "STOP");
  await db.close();
});

await check("po reťazci (stav stagingu): skript beží, STOP pre migrácie / nové objekty", async () => {
  const db = await freshDb();
  for (const m of EINVOICE_MIGRATIONS.filter((m) => m >= CHAIN_START)) await db.exec(read(`supabase/migrations/${m}`));
  const rows = await runPrecheck(db);
  const st = (n: string) => rows.find((r) => r.check_name === n)?.status;
  assert.equal(st("new_tables_absent"), "STOP");
  assert.equal(st("new_functions_absent"), "STOP");
  assert.equal(st("new_columns_absent"), "STOP");
  assert.equal(st("einvoice_objects_absent"), "STOP");
  await db.close();
});

await check("alerting návrh: NEAKTÍVNY (docs/ops, nie .github/workflows), secret iba odkazom, C1–C7, žiadne telo do logu", () => {
  const wf = read("docs/ops/einvoice-health-alert.github-workflow.yml");
  assert.ok(!existsSync(path.join(ROOT, ".github/workflows/einvoice-health.yml")), "workflow nesmie byť aktívny");
  assert.match(wf, /\$\{\{ secrets\.ESBLU_CRON_SECRET \}\}/);
  assert.doesNotMatch(wf, /efk_pk_|whsec_|sk-[A-Za-z0-9]{10}|eyJhbGci/);
  for (const c of ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]) assert.match(wf, new RegExp(`${c} `), c);
  assert.match(wf, /rm -f body\.json/);
  assert.match(wf, /rm -f fx\.json/);
  assert.doesNotMatch(wf, /cat body\.json|cat fx\.json|echo .*\$\(cat/);
  assert.match(wf, /permissions: \{\}/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
