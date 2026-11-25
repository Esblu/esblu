// =============================================================================
// P1-5 skupina D, krok D-B — nezávislá šifrovaná záloha 67 existujúcich objektov Storage MIMO syntetických firiem P15
// (PRÍPRAVA; spúšťa vlastník cez release-backups/p15/run-p15-backup.ps1 až po schválení).
//
// Režimy (ESBLU_P15B_MODE):
//   backup  — iba GET presne tých objektov, ktoré sú v inventári (bucket + názov + id + veľkosť + eTag z DB). Každý
//             objekt: veľkosť a MD5 = eTag (integrita prenosu), SHA-256, šifrovanie AES-256-GCM (kľúč zo scrypt hesla,
//             AAD = formát + názov blobu). Zapisuje IBA do nového priečinka v release-backups/p15 (mimo Git a OneDrive).
//   verify  — offline (bez siete, bez kľúča): dešifruje všetko v pamäti, overí GCM tag, SHA-256, MD5 a veľkosť.
//   compare — iba čítanie: porovná zálohu so živým Storage (SHA-256) → zoznam rozdielov; NIČ neobnovuje.
// Obnova (upload chýbajúceho objektu, upsert:false) nie je implementovaná — vyžaduje samostatné schválenie.
// Hlavička neobsahuje cesty ani názvy; inventár s cestami je iba v zašifrovanom manifeste.
// =============================================================================
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_ORIGIN, Stop, guardedFetch } from "./runner-core.ts";

export const BACKUP_FORMAT = "esblu-p15-storage-backup-v1";
export const EXPECTED_OBJECTS = 67;
export const BACKUP_BUCKETS: ReadonlySet<string> = new Set(["einvoice-documents", "ai-inbox-documents", "billing-documents"]);
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export type InventoryItem = { bucket: string; name: string; id: string; size: number; etag: string; updated_at: string };
export type ManifestEntry = InventoryItem & { sha256: string; md5: string; blob: string };
export type Header = {
  format: string; created_at: string; objects: number; cipher: "aes-256-gcm";
  kdf: { alg: "scrypt"; N: number; r: number; p: number; salt_b64: string };
  manifest: { blob: string; sha256_cipher: string };
  blobs: Array<{ blob: string; sha256_cipher: string }>;
  inventory_sha256: string;
};

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");

/** Inventár: presne 67 objektov, iba 3 buckety, nič zo syntetických firiem P15, bez '..', unikátne, eTag = MD5. */
export function validateInventory(items: InventoryItem[]): void {
  if (!Array.isArray(items) || items.length !== EXPECTED_OBJECTS) throw new Stop(`inventár: očakávaných ${EXPECTED_OBJECTS} objektov`);
  const seen = new Set<string>();
  for (const it of items) {
    if (!BACKUP_BUCKETS.has(it.bucket)) throw new Stop("inventár: nepovolený bucket");
    if (typeof it.name !== "string" || !it.name || it.name.includes("..") || it.name.startsWith("/")) throw new Stop("inventár: neplatná cesta");
    if (it.name.startsWith("f151") || it.name.includes("f1510000-0000-4000-8000-00000000000")) throw new Stop("inventár obsahuje syntetickú firmu P15");
    if (!/^[0-9a-f]{32}$/.test(it.etag)) throw new Stop("inventár: eTag nie je MD5 (multipart?)");
    if (!Number.isInteger(it.size) || it.size < 0 || it.size > 50 * 1024 * 1024) throw new Stop("inventár: neplatná veľkosť");
    const k = `${it.bucket}|${it.name}`;
    if (seen.has(k)) throw new Stop("inventár: duplicita");
    seen.add(k);
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (typeof passphrase !== "string" || passphrase.length < 20) throw new Stop("heslo zálohy musí mať aspoň 20 znakov");
  return scryptSync(passphrase.normalize("NFC"), salt, 32, KDF);
}
function seal(key: Buffer, blob: string, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`${BACKUP_FORMAT}|${blob}`));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(key: Buffer, blob: string, sealed: Buffer): Buffer {
  if (sealed.length < 28) throw new Stop(`blob ${blob}: poškodený`);
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(`${BACKUP_FORMAT}|${blob}`));
  d.setAuthTag(sealed.subarray(12, 28));
  try {
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
  } catch {
    throw new Stop(`blob ${blob}: integrita zlyhala (zlé heslo alebo zmenený obsah)`);
  }
}

export type Fetched = { item: InventoryItem; bytes: Uint8Array };
/** Overenie stiahnutého objektu voči inventáru (veľkosť + MD5 = eTag) a zostavenie šifrovanej zálohy v pamäti. */
export function buildBackup(fetched: Fetched[], inventory: InventoryItem[], passphrase: string, now = new Date()): { header: Header; blobs: Map<string, Buffer> } {
  validateInventory(inventory);
  if (fetched.length !== inventory.length) throw new Stop("záloha: počet stiahnutých ≠ inventár");
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const blobs = new Map<string, Buffer>();
  const manifest: ManifestEntry[] = [];
  fetched.forEach(({ item, bytes }, i) => {
    const inv = inventory[i];
    if (item.bucket !== inv.bucket || item.name !== inv.name) throw new Stop("záloha: poradie ≠ inventár");
    if (bytes.byteLength !== inv.size) throw new Stop(`záloha: veľkosť objektu ${i + 1} ≠ inventár`);
    const m = md5(bytes);
    if (m !== inv.etag) throw new Stop(`záloha: MD5 objektu ${i + 1} ≠ eTag (zmenený počas zálohy?)`);
    const blob = `obj-${String(i + 1).padStart(4, "0")}.bin`;
    blobs.set(blob, seal(key, blob, bytes));
    manifest.push({ ...inv, sha256: sha256(bytes), md5: m, blob });
  });
  const mblob = "manifest.bin";
  blobs.set(mblob, seal(key, mblob, Buffer.from(JSON.stringify(manifest))));
  const header: Header = {
    format: BACKUP_FORMAT, created_at: now.toISOString(), objects: manifest.length, cipher: "aes-256-gcm",
    kdf: { alg: "scrypt", N: KDF.N, r: KDF.r, p: KDF.p, salt_b64: salt.toString("base64") },
    manifest: { blob: mblob, sha256_cipher: sha256(blobs.get(mblob)!) },
    blobs: manifest.map((e) => ({ blob: e.blob, sha256_cipher: sha256(blobs.get(e.blob)!) })),
    inventory_sha256: sha256(JSON.stringify(inventory)),
  };
  return { header, blobs };
}

/** Offline overenie: hlavička, SHA-256 šifrovaných blobov, GCM, SHA-256/MD5/veľkosť obsahu. Vráti manifest a obsah. */
export function verifyBackup(header: Header, readBlob: (blob: string) => Buffer, passphrase: string): { manifest: ManifestEntry[]; content: Map<string, Buffer> } {
  if (header.format !== BACKUP_FORMAT || header.cipher !== "aes-256-gcm" || header.kdf?.alg !== "scrypt") throw new Stop("záloha: neznámy formát");
  if (header.kdf.N !== KDF.N || header.kdf.r !== KDF.r || header.kdf.p !== KDF.p) throw new Stop("záloha: neočakávané parametre KDF");
  const key = deriveKey(passphrase, Buffer.from(header.kdf.salt_b64, "base64"));
  const mraw = readBlob(header.manifest.blob);
  if (sha256(mraw) !== header.manifest.sha256_cipher) throw new Stop("záloha: manifest zmenený");
  const manifest = JSON.parse(open(key, header.manifest.blob, mraw).toString("utf8")) as ManifestEntry[];
  if (manifest.length !== header.objects || header.blobs.length !== header.objects) throw new Stop("záloha: počet objektov nesedí");
  validateInventory(manifest);
  const content = new Map<string, Buffer>();
  manifest.forEach((e, i) => {
    const hb = header.blobs[i];
    if (hb.blob !== e.blob) throw new Stop("záloha: poradie blobov nesedí");
    const raw = readBlob(e.blob);
    if (sha256(raw) !== hb.sha256_cipher) throw new Stop(`záloha: blob ${e.blob} zmenený`);
    const plain = open(key, e.blob, raw);
    if (plain.byteLength !== e.size || sha256(plain) !== e.sha256 || md5(plain) !== e.md5 || e.md5 !== e.etag) throw new Stop(`záloha: obsah ${e.blob} nesedí`);
    content.set(`${e.bucket}|${e.name}`, plain);
  });
  return { manifest, content };
}

/** Sieť zálohy: iba GET objektov z inventára (žiadny zápis, list, delete, auth, RPC). */
export function backupGuardedFetch(inventory: InventoryItem[], inner: typeof fetch = fetch): typeof fetch {
  const allowed = new Set(inventory.map((i) => `/storage/v1/object/${i.bucket}/${i.name}`));
  const og = guardedFetch(inner);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(raw);
    const m = String(init?.method ?? "GET").toUpperCase();
    if (url.origin !== ALLOWED_ORIGIN) throw new Stop("F-3: mimo povoleného projektu");
    if (m !== "GET" || !allowed.has(decodeURIComponent(url.pathname))) throw new Stop("záloha: povolené iba GET objektov z inventára");
    return og(input, init);
  }) as typeof fetch;
}

export function writeBackupDir(dir: string, header: Header, blobs: Map<string, Buffer>): string {
  if (existsSync(dir)) throw new Stop("záloha: cieľový priečinok už existuje (neprepisuje sa)");
  if (/onedrive/i.test(dir)) throw new Stop("záloha: OneDrive je zakázaný");
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
