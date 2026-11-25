// =============================================================================
// P1-5 skupina D, krok D-B — vstup zálohy (spúšťa vlastník cez release-backups/p15/run-p15-backup.ps1).
//   ESBLU_P15B_MODE=preflight                                    (bez siete, bez kľúča, bez hesla)
//   ESBLU_P15B_MODE=backup  ESBLU_P15B_INVENTORY=<json> ESBLU_P15B_INVENTORY_SHA256=<hex> ESBLU_P15B_OUT=<nový priečinok>
//   ESBLU_P15B_MODE=verify  ESBLU_P15B_DIR=<priečinok>           (iba heslo, bez siete, bez kľúča)
//   ESBLU_P15B_MODE=compare ESBLU_P15B_DIR=<priečinok>           (kľúč + heslo, iba GET, nič neobnovuje)
// Výstup a chyby: iba počty, kódy a odtlačky — nikdy cesty, názvy súborov, heslo ani kľúč.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertCleanProcess, Stop, validateStagingUrl, verifyDependencyLock, verifyLocalIntegrity } from "./runner-core.ts";
import {
  assertBackupTarget, assertPassphraseSafe, backupGuardedFetch, buildBackup, readBackupDir, sha256, validateInventory, verifyBackup, writeBackupDir,
  type Fetched, type InventoryItem,
} from "./storage-backup.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKUP_ROOT = path.resolve(ROOT, "../../release-backups/p15");
/** F-4: lokálne súbory, ktoré tento proces načíta (vstup pinuje .ps1). */
const BACKUP_EXPECTED_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "scripts/p15-staging/storage-backup.ts": "a2ddf3f122078510af83e8096913d0e613c08f4cfa3c6313d3a34561027fc4d6",
  "scripts/p15-staging/runner-core.ts": "112729265069214a6714357d53d16a843c9ee39b32adb69aea3cb30d17dac54c",
  "scripts/p15-staging/dependency-lock.json": "51c7b7fccbad2c2f844ce2a873dafaa68bb9c2c9c31decf8b999a95b1df4d632",
  "lib/company-export.ts": "96adf813c4e03ba2ec15132900fa53dab6b582b584d016715edfc0a73f034eac",
  "lib/einvoice/visibility.ts": "7013c5f61aa819e6d299fd4eeeef9c9a65fc59cebf634d381756c54f1f14a5d2",
});

function fail(msg: string, code = 2): never { console.error(`STOP: ${msg}`); process.exit(code); }
/** Iba vlastné správy (Stop) — iné chyby (napr. JSON.parse s úryvkom obsahu, cesty v ENOENT) sa nevypisujú. */
function safeMessage(e: unknown): string {
  if (e instanceof Stop) return e.message;
  const code = (e as { code?: unknown })?.code;
  return `neočakávaná chyba (${e instanceof Error ? e.name : typeof e}${typeof code === "string" ? `:${code}` : ""})`;
}

const mode = process.env.ESBLU_P15B_MODE ?? "";
try {
  assertCleanProcess(process.env, process.execArgv);
  verifyLocalIntegrity(ROOT, BACKUP_EXPECTED_SHA256);
  verifyDependencyLock(ROOT);
  if (!["preflight", "backup", "verify", "compare"].includes(mode)) throw new Stop("neznámy režim (preflight | backup | verify | compare)");
} catch (e) { fail(safeMessage(e)); }

const pass = process.env.ESBLU_P15_BACKUP_PASSPHRASE ?? "";
const key = process.env.ESBLU_STAGING_SERVICE_ROLE_KEY ?? "";
try {
  if (mode === "preflight") {
    if (key || pass) throw new Stop("preflight nesmie mať kľúč ani heslo v prostredí");
    validateStagingUrl(process.env.ESBLU_STAGING_SUPABASE_URL ?? "");
    console.log("PREFLIGHT_OK: prostredie Node, odtlačky runnera a závislostí, URL overené; žiadna sieť, žiadny kľúč, žiadne heslo");
    process.exit(0);
  }
  // Heslo archívu ≠ formát kľúča/JWT a ≠ Supabase kľúč — PRED čítaním súborov, klientom a sieťou.
  assertPassphraseSafe(pass, key);
  if (mode === "verify") {
    if (key) throw new Stop("verify nesmie mať kľúč v prostredí");
    const { header, readBlob, files } = readBackupDir(process.env.ESBLU_P15B_DIR ?? "");
    const { manifest } = verifyBackup(header, readBlob, pass);
    if (files.length !== manifest.length + 2) throw new Stop("záloha: v priečinku sú súbory navyše/chýbajú");
    // (neúplný zápis by ostal iba ako "<dir>.partial" bez header.json — verify ho odmietne pri čítaní hlavičky)
    const byBucket = manifest.reduce<Record<string, number>>((a, e) => { a[e.bucket] = (a[e.bucket] ?? 0) + 1; return a; }, {});
    const etag = manifest.reduce<Record<string, number>>((a, e) => { a[e.etag_md5] = (a[e.etag_md5] ?? 0) + 1; return a; }, {});
    console.log(`VERIFY_OK: ${manifest.length} objektov ${JSON.stringify(byBucket)}; HMAC hlavičky, GCM tag, SHA-256 a veľkosť overené; eTag↔MD5 ${JSON.stringify(etag)}`);
    process.exit(0);
  }
  const url = validateStagingUrl(process.env.ESBLU_STAGING_SUPABASE_URL ?? "");
  if (!/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(key)) throw new Stop("kľúč nemá formát sb_secret_");
  const netLog: string[] = [];
  const client = (inv: InventoryItem[]) => {
    const f = backupGuardedFetch(inv, globalThis.fetch, netLog);
    globalThis.fetch = f;
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: f } });
  };
  const download = async (admin: ReturnType<typeof client>, it: InventoryItem, i: number): Promise<Uint8Array> => {
    const { data, error } = await admin.storage.from(it.bucket).download(it.name);
    if (error || !data) throw new Stop(`stiahnutie objektu ${i + 1} zlyhalo (${(error as { status?: number } | null)?.status ?? "?"})`);
    return new Uint8Array(await data.arrayBuffer());
  };
  if (mode === "backup") {
    const invPath = process.env.ESBLU_P15B_INVENTORY ?? "";
    const raw = readFileSync(invPath);
    if (sha256(raw) !== (process.env.ESBLU_P15B_INVENTORY_SHA256 ?? "").toLowerCase()) throw new Stop("inventár: SHA-256 ≠ schválený odtlačok");
    const inventory = JSON.parse(raw.toString("utf8")) as InventoryItem[];
    validateInventory(inventory);
    const out = process.env.ESBLU_P15B_OUT ?? "";
    assertBackupTarget(out, BACKUP_ROOT, [process.env.OneDrive ?? "", process.env.OneDriveConsumer ?? "", process.env.OneDriveCommercial ?? ""]);
    const admin = client(inventory);
    const fetched: Fetched[] = [];
    for (const [i, item] of inventory.entries()) fetched.push({ item, first: await download(admin, item, i), second: new Uint8Array(0) });
    for (const [i, f] of fetched.entries()) f.second = await download(admin, f.item, i); // druhé, nezávislé kolo
    const { header, blobs, summary } = buildBackup(fetched, inventory, pass);
    fetched.length = 0;
    const headerSha = writeBackupDir(out, header, blobs);
    const denied = netLog.filter((l) => l.startsWith("DENY")).length;
    console.log(`BACKUP_OK: ${header.objects} objektov (2× stiahnuté, SHA-256 zhodné) zašifrovaných; eTag↔MD5 ${JSON.stringify(summary)}; požiadavky GET ${netLog.length - denied}, zablokované ${denied}; header.json SHA-256 ${headerSha}`);
    process.exit(denied ? 1 : 0);
  }
  // compare
  const { header, readBlob } = readBackupDir(process.env.ESBLU_P15B_DIR ?? "");
  const { manifest, content } = verifyBackup(header, readBlob, pass);
  const admin = client(manifest);
  let same = 0;
  const diff: string[] = [];
  for (const [i, e] of manifest.entries()) {
    try {
      const live = await download(admin, e, i);
      if (sha256(live) === e.sha256 && Buffer.compare(Buffer.from(live), content.get(`${e.bucket}|${e.name}`)!) === 0) same++;
      else diff.push(`${e.blob}:iný obsah`);
    } catch { diff.push(`${e.blob}:nedostupný`); }
  }
  console.log(`COMPARE: zhoda ${same}/${manifest.length}; rozdiely ${diff.length}${diff.length ? " " + diff.slice(0, 10).join(",") : ""} — nič sa neobnovovalo`);
  process.exit(diff.length ? 1 : 0);
} catch (e) {
  fail(safeMessage(e));
}
