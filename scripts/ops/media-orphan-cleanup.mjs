#!/usr/bin/env node
// =============================================================================
// SAMOSTATNÝ, MANUÁLNE SCHVAĽOVANÝ cleanup 5 osirelých súborov médií
// (zistené read-only auditom 2026-10-04, docs/media-orphans-report-2026-10-04.md).
//
// NIE JE súčasťou security migrácií 20261005090000 + 20261005091000 a nespúšťa sa automaticky.
//
// BEZPEČNOSŤ
//   - Predvolene DRY-RUN: iba vypíše, čo by urobil.
//   - Maže výhradne cesty z pevného zoznamu nižšie (žiadne prefixy, žiadne
//     wildcardy) a iba ak sa pri spustení znova overí, že ich NIČ v DB
//     nereferencuje a že objekt stále existuje.
//   - Mazanie cez Storage API (nie SQL DELETE na storage.objects — to by
//     nechalo samotný súbor v úložisku).
//   - Voliteľná záloha: --backup-dir=<priečinok> stiahne kópie pred zmazaním.
//   - Vyžaduje service_role kľúč z PREMENNEJ PROSTREDIA (nikdy nie z repa);
//     spúšťa iba vlastník lokálne, nikdy appka ani klient.
//
// POUŽITIE (Windows PowerShell, z koreňa repa):
//   node scripts/ops/media-orphan-cleanup.mjs                     # dry-run
//   node scripts/ops/media-orphan-cleanup.mjs --backup-dir=.\orphan-backup --execute --confirm=5
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ORPHANS = [
  { bucket: "company-logos", path: "9932bb02-926f-47d2-9490-7c8fd827e32a/1783967328946-company-logo.webp" },
  { bucket: "vehicle-photos", path: "e61c3329-5912-4a4f-9b9b-7774cb3a7f5b/af334d58-d950-49c1-b3e4-9e4b32380d89/1787947202360-8b08589c-9587-4d20-9aeb-4e083a2029c0-20260828_125220.webp" },
  { bucket: "inventory-photos", path: "9932bb02-926f-47d2-9490-7c8fd827e32a/ad53ee49-b475-4fce-823e-4311e3ad56b9/1787947925414.webp" },
  { bucket: "machine-photos", path: "e61c3329-5912-4a4f-9b9b-7774cb3a7f5b/2b0cde11-a851-4faf-9b93-ec762a4add09/1788123029975-17881230237048957089319671002948.webp" },
  { bucket: "inventory-photos", path: "e61c3329-5912-4a4f-9b9b-7774cb3a7f5b/89cf9510-a79d-4f4c-a58e-efb04aa2ef2c/1788123064033.webp" },
];

// Všetky miesta, kde môže byť cesta súboru referencovaná.
const REFERENCES = [
  ["vehicle_photos", "storage_path"],
  ["machine_photos", "file_path"],
  ["inventory_photos", "file_path"],
  ["company_billing_profile", "logo_path"],
  ["settings", "logo_path"],
  ["documents", "storage_path"],
  ["document_attachments", "storage_path"],
  ["ai_evidence", "photo_url"],
  ["chat_attachments", "storage_path"],
];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const execute = args.execute === true;
const backupDir = typeof args["backup-dir"] === "string" ? args["backup-dir"] : null;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Chýba NEXT_PUBLIC_SUPABASE_URL alebo SUPABASE_SERVICE_ROLE_KEY v prostredí.");
  process.exit(2);
}
if (!/fkpgvgvsmbpieduoatrt/.test(url)) {
  console.error("Neočakávaný projekt — skript je určený iba pre produkčný projekt Esblu.");
  process.exit(2);
}
if (execute && Number(args.confirm) !== ORPHANS.length) {
  console.error(`Pre --execute treba --confirm=${ORPHANS.length}.`);
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false } });

async function isReferenced(objectPath) {
  for (const [table, column] of REFERENCES) {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).eq(column, objectPath);
    if (error) throw new Error(`${table}.${column}: ${error.message}`);
    if ((count ?? 0) > 0) return `${table}.${column}`;
  }
  return null;
}

async function exists(bucket, objectPath) {
  const dir = path.posix.dirname(objectPath);
  const name = path.posix.basename(objectPath);
  const { data, error } = await db.storage.from(bucket).list(dir === "." ? "" : dir, { search: name, limit: 100 });
  if (error) throw new Error(`list ${bucket}: ${error.message}`);
  return (data ?? []).some((f) => f.name === name);
}

let deleted = 0;
let skipped = 0;
for (const item of ORPHANS) {
  const label = `${item.bucket}/${item.path}`;
  const ref = await isReferenced(item.path);
  if (ref) {
    console.log(`SKIP (referencované v ${ref}): ${label}`);
    skipped++;
    continue;
  }
  if (!(await exists(item.bucket, item.path))) {
    console.log(`SKIP (už neexistuje): ${label}`);
    skipped++;
    continue;
  }
  if (!execute) {
    console.log(`DRY-RUN zmazal by: ${label}`);
    continue;
  }
  if (backupDir) {
    const { data, error } = await db.storage.from(item.bucket).download(item.path);
    if (error || !data) {
      console.error(`STOP: zálohu sa nepodarilo stiahnuť: ${label}`);
      process.exit(1);
    }
    const target = path.join(backupDir, item.bucket, ...item.path.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await data.arrayBuffer()));
  }
  const { data, error } = await db.storage.from(item.bucket).remove([item.path]);
  if (error || (data ?? []).length !== 1) {
    console.error(`CHYBA pri mazaní: ${label}`);
    process.exit(1);
  }
  console.log(`ZMAZANÉ: ${label}`);
  deleted++;
}

console.log(`\nHotovo. ${execute ? `zmazané ${deleted}` : "dry-run"}, preskočené ${skipped}.`);
