// =============================================================================
// Esblu — overenie obnovy produkčnej zálohy v IZOLOVANOM prostredí (PGlite v pamäti), 2026-11-26.
//
// Nikdy sa nepripája k Supabase ani k sieti. Vstup: priečinok z
//   node scripts/ops/esblu-daily-backup.mjs --extract <záloha.esblubk2> <private.pem> <priečinok>
// a inventúra produkcie (docs/release/prod-inventory-<dátum>.json, read-only SQL pred zálohou).
//
// Postup: nová prázdna DB = platform stub + repo migrácie s verziou <= --max-version (stav produkcie pri zálohe)
//   → auth používatelia (id, e-mail) → restore-public-data.sql (jedna transakcia, kontrola počtov v SQL)
//   → porovnanie každej public tabuľky s inventúrou (počet riadkov povinne, odtlačok informatívne)
//   → súbory Storage (počet a bajty po bucketoch) a auth používatelia (počet).
// Výsledok: RESTORE_VERIFY_OK / RESTORE_VERIFY_FAIL (exit 0 / 1). Vypisuje iba počty a odtlačky, žiadne údaje.
//
//   node --experimental-strip-types --no-warnings scripts/ops/esblu-restore-verify.ts \
//        <extract-dir> docs/release/prod-inventory-2026-11-26.json [--max-version 20261123120000]
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
type Db = { exec: (sql: string) => Promise<unknown>; query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>; close: () => Promise<void> };
export type Inventory = {
  tables: Record<string, { rows: number; fp: string }>;
  auth_users: number;
  storage: Record<string, { objects: number; bytes: number }>;
  excluded_from_backup?: string[];
};

// Rovnaké poradie replayu ako scripts/grants-replay-pglite-tests.ts (2 historické výnimky).
const OVERRIDES: Array<[string, string]> = [
  ["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],
  ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"],
];
export function replayOrder(files: string[]) {
  let out = [...files].sort();
  for (const [f, before] of OVERRIDES) {
    if (!out.includes(f) || !out.includes(before)) continue;
    out = out.filter((x) => x !== f); out.splice(out.indexOf(before), 0, f);
  }
  return out;
}

// Rovnaký odtlačok ako read-only inventúra produkcie (md5 zoradených md5 textov riadkov).
export const FP_SQL = (t: string) =>
  `select count(*)::int n, md5(coalesce(string_agg(md5(x::text), '' order by md5(x::text)), '')) h from public."${t}" x`;

export async function freshDb(maxVersion: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const db = new PGlite({ extensions: { pgcrypto } }) as unknown as Db;
  await db.exec("set timezone = 'UTC'");
  await db.exec(fs.readFileSync(path.join(ROOT, "scripts/sql/pglite/supabase-platform-stub.sql"), "utf8"));
  await db.exec("create table if not exists auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), provider text, identity_data jsonb)");
  const files = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql") && f.slice(0, 14) <= maxVersion);
  for (const f of replayOrder(files)) await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"));
  return db;
}

function dirStats(dir: string): { objects: number; bytes: number } {
  let objects = 0, bytes = 0;
  if (!fs.existsSync(dir)) return { objects, bytes };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = dirStats(p); objects += s.objects; bytes += s.bytes; }
    else { objects++; bytes += fs.statSync(p).size; }
  }
  return { objects, bytes };
}

export async function verifyRestore(db: Db, extractDir: string, inv: Inventory) {
  const errors: string[] = []; const notes: string[] = [];
  const users = JSON.parse(fs.readFileSync(path.join(extractDir, "auth_users.json"), "utf8")) as Array<{ id: string; email: string }>;
  if (users.length !== inv.auth_users) errors.push(`auth.users: záloha ${users.length} ≠ inventúra ${inv.auth_users}`);
  for (const u of users) await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [u.id, u.email]);
  await db.exec(fs.readFileSync(path.join(extractDir, "restore-public-data.sql"), "utf8"));
  const excluded = new Set(inv.excluded_from_backup ?? []);
  let fpMatch = 0, fpDiff = 0;
  for (const [t, want] of Object.entries(inv.tables)) {
    const exists = (await db.query<{ ok: boolean }>("select to_regclass($1) is not null ok", [`public.${t}`])).rows[0].ok;
    if (!exists) { errors.push(`${t}: tabuľka v obnovenej schéme chýba`); continue; }
    const got = (await db.query<{ n: number; h: string }>(FP_SQL(t))).rows[0];
    if (excluded.has(t)) { notes.push(`${t}: vylúčená zo zálohy (prod ${want.rows}, obnova ${got.n})`); continue; }
    if (got.n !== want.rows) errors.push(`${t}: riadky obnova ${got.n} ≠ inventúra ${want.rows}`);
    else if (got.h === want.fp) fpMatch++;
    else { fpDiff++; notes.push(`${t}: počet zhodný, odtlačok iný (textová reprezentácia / referenčné dáta migrácií)`); }
  }
  for (const [b, want] of Object.entries(inv.storage)) {
    const got = dirStats(path.join(extractDir, "storage", b));
    if (got.objects !== want.objects || got.bytes !== want.bytes) errors.push(`storage ${b}: obnova ${got.objects} obj / ${got.bytes} B ≠ inventúra ${want.objects} / ${want.bytes}`);
  }
  return { errors, notes, fpMatch, fpDiff };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [extractDir, invPath] = process.argv.slice(2, 4);
  const i = process.argv.indexOf("--max-version");
  const maxVersion = i > 0 ? process.argv[i + 1] : "20261123120000";
  if (!extractDir || !invPath || !/^\d{14}$/.test(maxVersion)) {
    console.error("Použitie: esblu-restore-verify.ts <extract-dir> <inventory.json> [--max-version YYYYMMDDHHMMSS]");
    process.exit(2);
  }
  const inv = JSON.parse(fs.readFileSync(invPath, "utf8")) as Inventory;
  console.log(`Izolovaná obnova: PGlite + migrácie <= ${maxVersion} (bez siete)…`);
  const db = await freshDb(maxVersion);
  const r = await verifyRestore(db, extractDir, inv);
  await db.close();
  for (const n of r.notes) console.log(`  info  ${n}`);
  for (const e of r.errors) console.log(`  FAIL  ${e}`);
  console.log(`tabuľky: odtlačok zhodný ${r.fpMatch}, iný ${r.fpDiff}; chyby ${r.errors.length}`);
  console.log(r.errors.length ? "RESTORE_VERIFY_FAIL" : "RESTORE_VERIFY_OK");
  process.exit(r.errors.length ? 1 : 0);
}
