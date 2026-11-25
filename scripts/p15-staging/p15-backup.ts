// =============================================================================
// P1-5 skupina D, krok D-B — vstup zálohy (spúšťa vlastník cez release-backups/p15/run-p15-backup.ps1).
//   ESBLU_P15B_MODE=backup   ESBLU_P15B_INVENTORY=<json> ESBLU_P15B_OUT=<nový priečinok>  (kľúč + heslo v prostredí)
//   ESBLU_P15B_MODE=verify   ESBLU_P15B_DIR=<priečinok>                                     (iba heslo, bez siete)
//   ESBLU_P15B_MODE=compare  ESBLU_P15B_DIR=<priečinok>                                     (kľúč + heslo, iba GET)
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertCleanProcess, Stop, validateStagingUrl, verifyDependencyLock } from "./runner-core.ts";
import { backupGuardedFetch, buildBackup, readBackupDir, validateInventory, verifyBackup, writeBackupDir, type InventoryItem } from "./storage-backup.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function fail(msg: string, code = 2): never { console.error(`STOP: ${msg}`); process.exit(code); }
const createHashHex = async (b: Uint8Array) => (await import("node:crypto")).createHash("sha256").update(b).digest("hex");

try {
  assertCleanProcess(process.env, process.execArgv);
  verifyDependencyLock(ROOT);
} catch (e) { fail(e instanceof Error ? e.message : "prostredie"); }

const mode = process.env.ESBLU_P15B_MODE ?? "";
const pass = process.env.ESBLU_P15_BACKUP_PASSPHRASE ?? "";
try {
  if (mode === "verify") {
    if (process.env.ESBLU_STAGING_SERVICE_ROLE_KEY) fail("verify nesmie mať kľúč v prostredí");
    const { header, readBlob, files } = readBackupDir(process.env.ESBLU_P15B_DIR ?? "");
    const { manifest } = verifyBackup(header, readBlob, pass);
    if (files.length !== manifest.length + 2) throw new Stop("záloha: v priečinku sú súbory navyše/chýbajú");
    const byBucket = manifest.reduce<Record<string, number>>((a, e) => { a[e.bucket] = (a[e.bucket] ?? 0) + 1; return a; }, {});
    console.log(`VERIFY_OK: ${manifest.length} objektov (${JSON.stringify(byBucket)}), GCM + SHA-256 + MD5 + veľkosť overené, inventár ${header.inventory_sha256.slice(0, 16)}…`);
    process.exit(0);
  }
  const url = validateStagingUrl(process.env.ESBLU_STAGING_SUPABASE_URL ?? "");
  const key = process.env.ESBLU_STAGING_SERVICE_ROLE_KEY ?? "";
  if (!/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(key)) fail("kľúč nemá formát sb_secret_");
  if (mode === "backup") {
    const inventory = JSON.parse(readFileSync(process.env.ESBLU_P15B_INVENTORY ?? "", "utf8")) as InventoryItem[];
    validateInventory(inventory);
    const f = backupGuardedFetch(inventory, globalThis.fetch);
    globalThis.fetch = f;
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: f } });
    const fetched = [];
    for (const item of inventory) {
      const { data, error } = await admin.storage.from(item.bucket).download(item.name);
      if (error || !data) throw new Stop(`stiahnutie objektu zlyhalo (${(error as { status?: number } | null)?.status ?? "?"})`);
      fetched.push({ item, bytes: new Uint8Array(await data.arrayBuffer()) });
    }
    const { header, blobs } = buildBackup(fetched, inventory, pass);
    const headerSha = writeBackupDir(process.env.ESBLU_P15B_OUT ?? "", header, blobs);
    console.log(`BACKUP_OK: ${header.objects} objektov zašifrovaných; header.json SHA-256 ${headerSha}`);
    process.exit(0);
  }
  if (mode === "compare") {
    const { header, readBlob } = readBackupDir(process.env.ESBLU_P15B_DIR ?? "");
    const { manifest, content } = verifyBackup(header, readBlob, pass);
    const f = backupGuardedFetch(manifest, globalThis.fetch);
    globalThis.fetch = f;
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: f } });
    let same = 0; const diff: string[] = [];
    for (const e of manifest) {
      const { data, error } = await admin.storage.from(e.bucket).download(e.name);
      if (error || !data) { diff.push(`${e.blob}:chýba/nedostupný`); continue; }
      const live = new Uint8Array(await data.arrayBuffer());
      if (await createHashHex(live) === e.sha256 && Buffer.compare(Buffer.from(live), content.get(`${e.bucket}|${e.name}`)!) === 0) same++;
      else diff.push(`${e.blob}:iný obsah`);
    }
    console.log(`COMPARE: zhoda ${same}/${manifest.length}; rozdiely ${diff.length}${diff.length ? " " + diff.slice(0, 10).join(",") : ""} — nič sa neobnovovalo`);
    process.exit(diff.length ? 1 : 0);
  }
  fail("neznámy režim (backup | verify | compare)");
} catch (e) {
  fail(e instanceof Error ? e.message : "chyba");
}
