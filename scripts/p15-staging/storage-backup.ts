// =============================================================================
// P1-5 skupina D, krok D-B — nezávislá šifrovaná záloha 67 existujúcich objektov Storage MIMO syntetických firiem P15
// (PRÍPRAVA; spúšťa vlastník cez release-backups/p15/run-p15-backup.ps1 až po schválení).
//
// Integrita (verzia 2, 2026-11-25):
//   - Autoritatívny odtlačok obsahu = SHA-256 vypočítaný runnerom. Každý objekt sa stiahne DVAKRÁT nezávisle;
//     obe kópie musia mať rovnaký SHA-256 a veľkosť = inventár (DB metadata.size).
//   - Storage eTag sa NEPOKLADÁ za MD5. Ukladá sa ako nepriehľadný identifikátor verzie (spolu s id a updated_at);
//     zmenu objektu počas zálohy odhalí opakovaný inventár (SQL) po zálohe. MD5 obsahu sa porovná s eTagom iba
//     informatívne (match / mismatch / not_md5) a výsledok sa zapíše do manifestu.
//   - AES-256-GCM (96-bit náhodné IV na blob, 128-bit tag, AAD = formát + názov blobu), kľúč zo scrypt
//     (N=2^17, r=8, p=1, 16 B soľ; 64 B → 32 B šifrovací + 32 B MAC kľúč); hlavička chránená HMAC-SHA256.
//   - Plaintext existuje iba v pamäti procesu; na disk ide iba šifrovaný blob (žiadne dočasné súbory).
// Režimy (p15-backup.ts): preflight | backup | verify | compare. Obnova (upload) nie je implementovaná.
// =============================================================================
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_ORIGIN, Stop, guardedFetch } from "./runner-core.ts";

export const BACKUP_FORMAT = "esblu-p15-storage-backup-v2";
export const EXPECTED_OBJECTS = 67;
export const BACKUP_BUCKETS: ReadonlySet<string> = new Set(["einvoice-documents", "ai-inbox-documents", "billing-documents"]);
export const KDF = Object.freeze({ N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_NAME = /^[A-Za-z0-9._/-]{1,1000}$/;

export type InventoryItem = { bucket: string; name: string; id: string; size: number; etag: string; updated_at: string; mimetype?: string };
export type EtagCheck = "match" | "mismatch" | "not_md5";
export type ManifestEntry = InventoryItem & { sha256: string; md5: string; etag_md5: EtagCheck; blob: string };
export type Header = {
  format: string; created_at: string; objects: number; cipher: "aes-256-gcm";
  kdf: { alg: "scrypt"; N: number; r: number; p: number; salt_b64: string };
  manifest: { blob: string; sha256_cipher: string };
  blobs: Array<{ blob: string; sha256_cipher: string }>;
  inventory_sha256: string;
  header_mac?: string;
};

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
export const normalizeEtag = (e: string) => String(e ?? "").replace(/"/g, "");

/** Inventár: presne 67 objektov, iba 3 buckety, nič z P15, bezpečné cesty, unikátne id aj cesty, metadáta prítomné. */
export function validateInventory(items: InventoryItem[]): void {
  if (!Array.isArray(items) || items.length !== EXPECTED_OBJECTS) throw new Stop(`inventár: očakávaných ${EXPECTED_OBJECTS} objektov`);
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const it of items) {
    if (!BACKUP_BUCKETS.has(it.bucket)) throw new Stop("inventár: nepovolený bucket");
    if (typeof it.name !== "string" || !SAFE_NAME.test(it.name) || it.name.includes("..") || it.name.startsWith("/") || it.name.includes("//")) throw new Stop("inventár: neplatná cesta");
    if (it.name.startsWith("f151") || it.name.includes("f1510000-0000-4000-8000-00000000000")) throw new Stop("inventár obsahuje syntetickú firmu P15");
    if (!UUID.test(it.id)) throw new Stop("inventár: id objektu nie je UUID");
    const e = normalizeEtag(it.etag);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(e)) throw new Stop("inventár: chýba eTag");
    if (!Number.isInteger(it.size) || it.size < 0 || it.size > 50 * 1024 * 1024) throw new Stop("inventár: neplatná veľkosť");
    if (typeof it.updated_at !== "string" || Number.isNaN(Date.parse(it.updated_at))) throw new Stop("inventár: chýba updated_at");
    const k = `${it.bucket}|${it.name}`;
    if (paths.has(k) || ids.has(it.id)) throw new Stop("inventár: duplicita");
    paths.add(k);
    ids.add(it.id);
  }
}

function deriveKeys(passphrase: string, salt: Buffer): { enc: Buffer; mac: Buffer } {
  if (typeof passphrase !== "string" || passphrase.length < 20) throw new Stop("heslo zálohy musí mať aspoň 20 znakov");
  const k = scryptSync(passphrase.normalize("NFC"), salt, 64, KDF);
  return { enc: k.subarray(0, 32), mac: k.subarray(32) };
}
function headerMac(macKey: Buffer, h: Header): string {
  const { header_mac: _ignored, ...rest } = h;
  return createHmac("sha256", macKey).update(`${BACKUP_FORMAT}|header|${JSON.stringify(rest)}`).digest("hex");
}
function seal(key: Buffer, blob: string, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(`${BACKUP_FORMAT}|${blob}`));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(key: Buffer, blob: string, sealed: Buffer): Buffer {
  if (sealed.length < 28) throw new Stop(`blob ${blob}: poškodený`);
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(`${BACKUP_FORMAT}|${blob}`));
  d.setAuthTag(sealed.subarray(12, 28));
  try {
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
  } catch {
    throw new Stop(`blob ${blob}: autentifikačný tag nesedí (zlé heslo alebo zmenený obsah)`);
  }
}

/** Dve nezávislé stiahnutia toho istého objektu (rovnaké poradie ako inventár). */
export type Fetched = { item: InventoryItem; first: Uint8Array; second: Uint8Array };

export function buildBackup(fetched: Fetched[], inventory: InventoryItem[], passphrase: string, now = new Date()): { header: Header; blobs: Map<string, Buffer>; summary: Record<EtagCheck, number> } {
  validateInventory(inventory);
  if (fetched.length !== inventory.length) throw new Stop("záloha: počet stiahnutých ≠ inventár");
  const salt = randomBytes(16);
  const keys = deriveKeys(passphrase, salt);
  const blobs = new Map<string, Buffer>();
  const manifest: ManifestEntry[] = [];
  const summary: Record<EtagCheck, number> = { match: 0, mismatch: 0, not_md5: 0 };
  fetched.forEach(({ item, first, second }, i) => {
    const inv = inventory[i];
    if (item.bucket !== inv.bucket || item.name !== inv.name || item.id !== inv.id) throw new Stop("záloha: poradie ≠ inventár");
    const h1 = sha256(first);
    if (first.byteLength !== inv.size || second.byteLength !== inv.size) throw new Stop(`záloha: veľkosť objektu ${i + 1} ≠ inventár`);
    if (h1 !== sha256(second)) throw new Stop(`záloha: dve stiahnutia objektu ${i + 1} sa líšia (zmena počas zálohy alebo chyba prenosu)`);
    const m = md5(first);
    const e = normalizeEtag(inv.etag);
    const etagCheck: EtagCheck = /^[0-9a-f]{32}$/.test(e) ? (e === m ? "match" : "mismatch") : "not_md5";
    summary[etagCheck]++;
    const blob = `obj-${String(i + 1).padStart(4, "0")}.bin`;
    blobs.set(blob, seal(keys.enc, blob, first));
    manifest.push({ ...inv, etag: e, sha256: h1, md5: m, etag_md5: etagCheck, blob });
  });
  const mblob = "manifest.bin";
  blobs.set(mblob, seal(keys.enc, mblob, Buffer.from(JSON.stringify(manifest))));
  const header: Header = {
    format: BACKUP_FORMAT, created_at: now.toISOString(), objects: manifest.length, cipher: "aes-256-gcm",
    kdf: { alg: "scrypt", N: KDF.N, r: KDF.r, p: KDF.p, salt_b64: salt.toString("base64") },
    manifest: { blob: mblob, sha256_cipher: sha256(blobs.get(mblob)!) },
    blobs: manifest.map((e) => ({ blob: e.blob, sha256_cipher: sha256(blobs.get(e.blob)!) })),
    inventory_sha256: sha256(JSON.stringify(inventory)),
  };
  header.header_mac = headerMac(keys.mac, header);
  return { header, blobs, summary };
}

/** Overenie (bez siete): HMAC hlavičky, SHA-256 šifrovaných blobov, GCM tag, SHA-256 a veľkosť obsahu. Plaintext iba v pamäti. */
export function verifyBackup(header: Header, readBlob: (blob: string) => Buffer, passphrase: string): { manifest: ManifestEntry[]; content: Map<string, Buffer> } {
  if (header.format !== BACKUP_FORMAT || header.cipher !== "aes-256-gcm" || header.kdf?.alg !== "scrypt") throw new Stop("záloha: neznámy formát");
  if (header.kdf.N !== KDF.N || header.kdf.r !== KDF.r || header.kdf.p !== KDF.p) throw new Stop("záloha: neočakávané parametre KDF");
  const salt = Buffer.from(header.kdf.salt_b64, "base64");
  if (salt.length !== 16) throw new Stop("záloha: neplatná soľ");
  const keys = deriveKeys(passphrase, salt);
  const mac = Buffer.from(String(header.header_mac ?? ""), "hex");
  const want = Buffer.from(headerMac(keys.mac, header), "hex");
  if (mac.length !== 32 || !timingSafeEqual(mac, want)) throw new Stop("záloha: hlavička zmenená alebo zlé heslo (HMAC)");
  const mraw = readBlob(header.manifest.blob);
  if (sha256(mraw) !== header.manifest.sha256_cipher) throw new Stop("záloha: manifest zmenený");
  const manifest = JSON.parse(open(keys.enc, header.manifest.blob, mraw).toString("utf8")) as ManifestEntry[];
  if (manifest.length !== header.objects || header.blobs.length !== header.objects) throw new Stop("záloha: počet objektov nesedí");
  validateInventory(manifest);
  const content = new Map<string, Buffer>();
  manifest.forEach((e, i) => {
    const hb = header.blobs[i];
    if (hb.blob !== e.blob || e.blob !== `obj-${String(i + 1).padStart(4, "0")}.bin`) throw new Stop("záloha: poradie blobov nesedí");
    const raw = readBlob(e.blob);
    if (sha256(raw) !== hb.sha256_cipher) throw new Stop(`záloha: blob ${e.blob} zmenený`);
    const plain = open(keys.enc, e.blob, raw);
    if (plain.byteLength !== e.size || sha256(plain) !== e.sha256 || md5(plain) !== e.md5) throw new Stop(`záloha: obsah ${e.blob} nesedí`);
    content.set(`${e.bucket}|${e.name}`, plain);
  });
  return { manifest, content };
}

/** Sieť zálohy: iba GET presne objektov z inventára (žiadny upload, update, remove, list, REST, auth, RPC). */
export function backupGuardedFetch(inventory: InventoryItem[], inner: typeof fetch = fetch, log: string[] = []): typeof fetch {
  const allowed = new Set(inventory.map((i) => `/storage/v1/object/${i.bucket}/${i.name}`));
  const og = guardedFetch(inner);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(raw);
    const m = String(init?.method ?? (typeof input === "object" && "method" in (input as Request) ? (input as Request).method : "GET")).toUpperCase();
    if (url.origin !== ALLOWED_ORIGIN) { log.push("DENY origin"); throw new Stop("F-3: mimo povoleného projektu"); }
    if (m !== "GET" || url.search || init?.body != null || !allowed.has(decodeURIComponent(url.pathname))) {
      log.push(`DENY ${m}`);
      throw new Stop("záloha: povolené iba GET objektov z inventára");
    }
    log.push("ALLOW GET");
    return og(input, init);
  }) as typeof fetch;
}

/** Cieľ zálohy: nový priečinok, nie OneDrive, nie odkaz (junction/symlink) v ceste od koreňa zálohy. */
export function assertBackupTarget(dir: string, root: string, forbiddenPrefixes: string[] = []): void {
  const abs = path.resolve(dir);
  const r = path.resolve(root);
  if (!abs.startsWith(r + path.sep)) throw new Stop("záloha: cieľ mimo povoleného koreňa");
  if (/onedrive/i.test(abs)) throw new Stop("záloha: OneDrive je zakázaný");
  for (const p of forbiddenPrefixes) if (p && abs.toLowerCase().startsWith(path.resolve(p).toLowerCase())) throw new Stop("záloha: cieľ v synchronizovanom priečinku");
  if (existsSync(abs)) throw new Stop("záloha: cieľový priečinok už existuje (neprepisuje sa)");
  let cur = path.dirname(abs);
  while (cur.length >= r.length) {
    if (lstatSync(cur).isSymbolicLink()) throw new Stop("záloha: v ceste je odkaz (junction/symlink)");
    if (cur === r) break;
    cur = path.dirname(cur);
  }
}

export function writeBackupDir(dir: string, header: Header, blobs: Map<string, Buffer>): string {
  if (existsSync(dir)) throw new Stop("záloha: cieľový priečinok už existuje (neprepisuje sa)");
  if (/onedrive/i.test(path.resolve(dir))) throw new Stop("záloha: OneDrive je zakázaný");
  mkdirSync(dir, { recursive: false });
  for (const [name, buf] of blobs) writeFileSync(path.join(dir, name), buf, { flag: "wx" });
  const h = JSON.stringify(header, null, 2);
  writeFileSync(path.join(dir, "header.json"), h, { flag: "wx" });
  return sha256(h);
}
export function readBackupDir(dir: string): { header: Header; readBlob: (b: string) => Buffer; files: string[] } {
  const header = JSON.parse(readFileSync(path.join(dir, "header.json"), "utf8")) as Header;
  const files = readdirSync(dir).sort();
  return { header, files, readBlob: (b) => { if (!/^(obj-\d{4}|manifest)\.bin$/.test(b)) throw new Stop("záloha: neplatný názov blobu"); return readFileSync(path.join(dir, b)); } };
}
