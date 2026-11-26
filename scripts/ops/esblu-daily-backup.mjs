#!/usr/bin/env node
// =============================================================================
// Esblu — denná šifrovaná záloha produkcie (databáza + Storage + Auth), 2026-11-20.
//
// Odvodené z overeného skriptu release-backups/2026-11-19-cleanup/esblu-prod-backup.mjs.
// Rozdiely: dynamický zoznam tabuliek a súborov, šifrovanie VEREJNÝM kľúčom (denný beh
// nepotrebuje heslo ani súkromný kľúč), retencia, súhrn bez osobných údajov, minimalizácia.
//
// BEZPEČNOSŤ
//   - Voči produkcii iba čítanie: GET (PostgREST, Auth Admin, Storage) a POST /storage/v1/object/list
//     (výpis obsahu bucketu, nič nemení). Nič nezapisuje do Supabase ani neposiela inam.
//   - Serverový kľúč iba z premennej ESBLU_BACKUP_SUPABASE_KEY (wrapper ho drží v DPAPI); nikdy sa nevypisuje.
//   - Šifrovanie: náhodný AES-256-GCM kľúč na každú zálohu, zabalený RSA-4096-OAEP-SHA256 verejným
//     kľúčom. Súkromný kľúč (šifrovaný heslom) je offline u prevádzkovateľa; bez neho sa záloha neotvorí.
//   - Cieľ nesmie byť v repozitári ani v OneDrive. Priečinok je obmedzený na aktuálneho používateľa.
//
// POUŽITIE
//   node scripts/ops/esblu-daily-backup.mjs --init-keys <priečinok>   vytvorí pár kľúčov (raz)
//   node scripts/ops/esblu-daily-backup.mjs --run                      denná záloha (Plánovač úloh)
//   node scripts/ops/esblu-daily-backup.mjs --verify <súbor> <private.pem>
//   node scripts/ops/esblu-daily-backup.mjs --extract <súbor> <private.pem> <cieľ>   (obnova)
// Premenné: ESBLU_BACKUP_SUPABASE_KEY, ESBLU_BACKUP_PUBLIC_KEY (cesta .pem),
//   ESBLU_BACKUP_PUBKEY_SHA256 (odtlačok z --init-keys), ESBLU_BACKUP_DIR, ESBLU_BACKUP_KEEP_DAILY (14),
//   ESBLU_BACKUP_KEEP_WEEKLY (4). Test: ESBLU_TEST_BASE_URL=http://127.0.0.1:<port> (iba mock).
// =============================================================================
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXPECTED_REF = "fkpgvgvsmbpieduoatrt";
export const MAGIC = Buffer.from("ESBLUBK2");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FILE_RE = /^esblu-prod-(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})(?:-\d{3})?Z\.esblubk2$/;

// Minimalizácia (GDPR čl. 5 ods. 1 písm. c): tabuľky, ktoré nie sú potrebné na obnovu služby.
// Pri obnove sa znovu vytvoria (zariadenia sa znovu zaregistrujú, relácie/potvrdenia sú dočasné).
export const EXCLUDED_TABLES = {
  push_devices: "FCM tokeny zariadení - appka ich po obnove znovu zaregistruje",
  push_subscriptions: "web push odbery (endpoint + kľúče) - prehliadač ich obnoví",
  session_active_company: "dočasný stav relácie",
  assistant_action_confirmations: "dočasné potvrdenia akcií asistenta (minúty)",
  assistant_conversation_contexts: "dočasný kontext konverzácie asistenta",
  einvoice_enroll_attempts: "dočasné pokusy o aktiváciu (30 dní), bez dôkaznej hodnoty",
};
// Tabuľky iba s počtom riadkov (bez obsahu). Zámerne prázdne: kurzy ECB (fx_reference_rates) sa zálohujú celé -
// historické kurzy sú súčasťou prepočtu vystavených faktúr a cron ich spätne nedoťahuje.
export const COUNT_ONLY_TABLES = {};

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

class BackupError extends Error {}
function die(msg) { throw new BackupError(msg); }

// ----------------------------------------------------------------------------- šifrovanie
export function publicKeyFingerprint(pem) {
  const der = crypto.createPublicKey(pem).export({ type: "spki", format: "der" });
  return sha256(der);
}

export function encryptBundle(plain, publicPem) {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const wrapped = crypto.publicEncrypt({ key: publicPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey);
  const fp = Buffer.from(publicKeyFingerprint(publicPem), "hex");
  const c = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  const header = Buffer.concat([MAGIC, fp, u32(wrapped.length), wrapped, iv]);
  c.setAAD(header); // hlavička (odtlačok kľúča, zabalený kľúč) je chránená tagom
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { file: Buffer.concat([header, c.getAuthTag(), ct]), dataKey };
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

export function parseHeader(buf) {
  if (buf.length < 64 || !buf.subarray(0, 8).equals(MAGIC)) die("súbor nie je denná záloha Esblu (ESBLUBK2)");
  const fp = buf.subarray(8, 40).toString("hex");
  const wl = buf.readUInt32BE(40);
  if (wl < 256 || wl > 1024 || 44 + wl + 28 > buf.length) die("poškodená hlavička zálohy");
  const wrapped = buf.subarray(44, 44 + wl);
  const iv = buf.subarray(44 + wl, 56 + wl);
  const header = buf.subarray(0, 56 + wl);
  const tag = buf.subarray(56 + wl, 72 + wl);
  return { fp, wrapped, iv, header, tag, ct: buf.subarray(72 + wl) };
}

export function decryptWithDataKey(buf, dataKey) {
  const h = parseHeader(buf);
  const d = crypto.createDecipheriv("aes-256-gcm", dataKey, h.iv);
  d.setAAD(h.header);
  d.setAuthTag(h.tag);
  try { return Buffer.concat([d.update(h.ct), d.final()]); }
  catch { die("poškodený súbor alebo nesprávny kľúč (GCM tag nesedí)"); }
}

export function decryptWithPrivateKey(buf, privatePem, passphrase) {
  const h = parseHeader(buf);
  let key;
  try { key = crypto.createPrivateKey({ key: privatePem, passphrase }); }
  catch { die("súkromný kľúč sa nedá otvoriť (nesprávne heslo?)"); }
  const pubFp = publicKeyFingerprint(crypto.createPublicKey(key).export({ type: "spki", format: "pem" }));
  if (pubFp !== h.fp) die("záloha je zašifrovaná iným kľúčom (odtlačok nesedí)");
  let dataKey;
  try { dataKey = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, h.wrapped); }
  catch { die("dátový kľúč sa nedá rozbaliť"); }
  return decryptWithDataKey(buf, dataKey);
}

// ----------------------------------------------------------------------------- čítanie produkcie
function headersFor(key, extra = {}) {
  const auth = key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` };
  return { apikey: key, ...auth, ...extra };
}
// Sieťové chyby Node fetch (undici) majú skutočnú príčinu v error.cause (pri viacerých adresách AggregateError).
// Diagnostika vypíše iba hostiteľa, cestu, kód a triedu chyby — nikdy kľúč, hlavičky, query ani telo odpovede.
const NET_CLASSES = [
  [/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NODATA|EAI_NONAME)$/, "DNS – názov servera sa nepodarilo preložiť (internet, DNS, VPN)"],
  [/^(UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED)$/,
    "TLS – certifikát servera nie je dôveryhodný pre Node (typicky HTTPS kontrola antivírusu/proxy s vlastným koreňovým certifikátom vo Windows); riešenie: node --use-system-ca"],
  [/^(CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_.*|ERR_TLS_.*)$/, "TLS – chyba certifikátu alebo TLS spojenia (systémový čas, prerušenie HTTPS)"],
  [/^(UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/, "TIMEOUT – server neodpovedal včas (sieť, firewall, VPN)"],
  [/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|ECONNABORTED)$/, "SPOJENIE – spojenie odmietnuté alebo prerušené (firewall, proxy, antivírus, sieť)"],
];
function redact(s) {
  return String(s ?? "").replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "sb_***").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "eyJ***").slice(0, 200);
}
export function describeFetchError(e) {
  const causes = [];
  const walk = (x, depth = 0) => {
    if (!x || depth > 4) return;
    if (Array.isArray(x.errors)) for (const y of x.errors) walk(y, depth + 1);
    if (x.code || x.name) causes.push({ code: String(x.code || x.name), message: redact(x.message) });
    if (x.cause) walk(x.cause, depth + 1);
  };
  walk(e?.cause);
  const codes = [...new Set(causes.map((c) => c.code))].filter((c) => !/Error$/.test(c));
  const cls = codes.map((c) => NET_CLASSES.find(([re]) => re.test(c))?.[1]).find(Boolean) || "neznáma sieťová chyba";
  return { codes, cls, detail: causes.map((c) => c.message).filter(Boolean).slice(0, 3).join(" | ") };
}
async function http(url, key, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: headersFor(key, init.headers || {}) });
  } catch (e) {
    const u = new URL(url);
    const d = describeFetchError(e);
    die(`sieťová chyba pre ${u.host}${u.pathname}: ${d.cls} [${d.codes.join(",") || "bez kódu"}]${d.detail ? ` – ${d.detail}` : ""}. Diagnostika: node scripts/ops/esblu-daily-backup.mjs --diagnose`);
  }
  if (!res.ok) die(`HTTP ${res.status} pre ${new URL(url).pathname}`);
  return res;
}

// Diagnostika siete bez kľúča a bez osobných údajov: DNS, TCP+TLS (vydavateľ certifikátu, overenie), verejný GET.
export async function diagnose(host = `${EXPECTED_REF}.supabase.co`, log = console.log) {
  const dns = await import("node:dns");
  const tls = await import("node:tls");
  log(`Node ${process.version}; --use-system-ca: ${process.execArgv.includes("--use-system-ca") || /--use-system-ca/.test(process.env.NODE_OPTIONS || "") ? "áno" : "nie"}`);
  for (const v of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED"])
    log(`  ${v}: ${process.env[v] || process.env[v.toLowerCase()] ? "nastavené" : "-"}`);
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    log(`DNS ${host}: OK (${addrs.map((a) => `IPv${a.family}`).join(", ")})`);
  } catch (e) { log(`DNS ${host}: CHYBA [${e.code}]`); return; }
  await new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const c = sock.getPeerCertificate();
      log(`TLS: overenie ${sock.authorized ? "OK" : `ZLYHALO [${sock.authorizationError}]`}; vydavateľ: ${redact(c?.issuer?.O || "")} / ${redact(c?.issuer?.CN || "")}`);
      sock.end(); resolve();
    });
    sock.on("timeout", () => { log("TLS: TIMEOUT (15 s)"); sock.destroy(); resolve(); });
    sock.on("error", (e) => { log(`TLS: CHYBA [${e.code || e.name}] ${redact(e.message)}`); resolve(); });
  });
  try {
    const r = await fetch(`https://${host}/auth/v1/health`);
    log(`HTTPS GET /auth/v1/health (bez kľúča): HTTP ${r.status} – sieť a TLS pre Node fungujú`);
  } catch (e) {
    const d = describeFetchError(e);
    log(`HTTPS GET /auth/v1/health: ${d.cls} [${d.codes.join(",") || "bez kódu"}]`);
  }
}

export async function listTables(base, key) {
  const spec = await (await http(`${base}/rest/v1/`, key, { headers: { Accept: "application/openapi+json" } })).json();
  const names = Object.keys(spec.definitions || {}).filter((t) => /^[a-z0-9_]+$/.test(t)).sort();
  if (names.length === 0) die("PostgREST nevrátil žiadne tabuľky (kľúč nie je serverový?)");
  return names;
}

async function fetchTable(base, key, table, countOnly) {
  const rows = [];
  let total = null;
  for (let offset = 0; ; offset += 1000) {
    const res = await http(`${base}/rest/v1/${table}?select=*`, key, {
      headers: { "Accept-Profile": "public", Prefer: "count=exact", Range: `${offset}-${offset + 999}`, "Range-Unit": "items" },
    });
    const t = Number((res.headers.get("content-range") || "").split("/")[1]);
    if (Number.isFinite(t)) total = t;
    if (countOnly) { await res.arrayBuffer(); return { count: total ?? 0, count_only: true }; }
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  if (total !== null && total !== rows.length) die(`${table}: stiahnutých ${rows.length}, server hlási ${total}`);
  return { count: rows.length, rows, rows_sha256: sha256(Buffer.from(JSON.stringify(rows))) };
}

async function fetchAuthUsers(base, key) {
  const users = [];
  for (let page = 1; page < 500; page++) {
    const body = await (await http(`${base}/auth/v1/admin/users?page=${page}&per_page=200`, key)).json();
    const list = body.users || [];
    users.push(...list);
    if (list.length < 200) break;
  }
  return users;
}

async function listObjects(base, key, bucket, prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const items = await (await http(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`, key, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    })).json();
    for (const it of items) {
      const full = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null || it.id === undefined) out.push(...(await listObjects(base, key, bucket, full)));
      else out.push({ bucket, name: full, size: Number(it.metadata?.size ?? -1), etag: String(it.metadata?.eTag ?? "").replace(/"/g, "") });
    }
    if (items.length < 1000) break;
  }
  return out;
}

async function fetchObject(base, key, o) {
  const p = o.name.split("/").map(encodeURIComponent).join("/");
  const data = Buffer.from(await (await http(`${base}/storage/v1/object/authenticated/${encodeURIComponent(o.bucket)}/${p}`, key)).arrayBuffer());
  if (o.size >= 0 && data.length !== o.size) die(`súbor ${o.bucket}/${o.name}: veľkosť ${data.length} != ${o.size}`);
  // eTag = MD5 pri jednorazovom nahratí; pri multipart má tvar "<hash>-<n>" a MD5 sa neporovnáva.
  if (/^[0-9a-f]{32}$/.test(o.etag) && md5(data) !== o.etag) die(`súbor ${o.bucket}/${o.name}: MD5 nesedí s eTag`);
  return { bucket: o.bucket, name: o.name, size: data.length, md5: md5(data), sha256: sha256(data), data_b64: data.toString("base64") };
}

// ----------------------------------------------------------------------------- kontrola, súhrn, retencia
export function verifyBundle(b) {
  const problems = [];
  for (const [t, e] of Object.entries(b.tables || {})) {
    if (e.count_only) continue;
    if (!Array.isArray(e.rows) || e.rows.length !== e.count) problems.push(`tabuľka ${t}: počet`);
    else if (sha256(Buffer.from(JSON.stringify(e.rows))) !== e.rows_sha256) problems.push(`tabuľka ${t}: SHA-256`);
  }
  for (const t of Object.keys(EXCLUDED_TABLES)) if (b.tables?.[t]) problems.push(`vylúčená tabuľka ${t} je v zálohe`);
  for (const o of b.objects || []) {
    const d = Buffer.from(o.data_b64, "base64");
    if (d.length !== o.size || sha256(d) !== o.sha256 || md5(d) !== o.md5) problems.push(`súbor ${o.bucket}/${o.name}`);
  }
  if (!Array.isArray(b.auth_users)) problems.push("chýbajú Auth používatelia");
  if ((b.objects || []).length !== b.meta?.storage_objects) problems.push("počet súborov Storage");
  return problems;
}

export function summaryOf(b, fileName, fileSha) {
  // Bez osobných údajov: iba počty, veľkosti a odtlačky.
  return {
    created_at: b.meta.created_at,
    project_ref: b.meta.project_ref,
    file: fileName,
    file_sha256: fileSha,
    public_key_sha256: b.meta.public_key_sha256,
    encryption: "AES-256-GCM (náhodný kľúč) + RSA-4096-OAEP-SHA256, gzip",
    auth_users: b.auth_users.length,
    tables: Object.keys(b.tables).length,
    rows: Object.values(b.tables).reduce((s, e) => s + (e.count_only ? 0 : e.count), 0),
    excluded_tables: Object.keys(EXCLUDED_TABLES).filter((t) => b.meta.all_tables.includes(t)),
    storage_buckets: b.meta.buckets.length,
    storage_objects: b.objects.length,
    storage_bytes: b.objects.reduce((s, o) => s + o.size, 0),
  };
}

export function selectForDeletion(fileNames, keepDaily = 14, keepWeekly = 4) {
  // Ponechá najnovších `keepDaily` záloh + najnovšiu zálohu z každého z `keepWeekly` predchádzajúcich ISO týždňov.
  const items = fileNames.map((f) => ({ f, m: f.match(FILE_RE) })).filter((x) => x.m)
    .map((x) => ({ f: x.f, t: Date.parse(`${x.m[1]}T${x.m[2].replace(/-/g, ":")}Z`) })).sort((a, b) => b.t - a.t);
  const keep = new Set(items.slice(0, keepDaily).map((x) => x.f));
  const weeks = new Map();
  for (const x of items.slice(keepDaily)) {
    const d = new Date(x.t); const day = (d.getUTCDay() + 6) % 7;
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    if (!weeks.has(monday)) weeks.set(monday, x.f);
  }
  [...weeks.entries()].sort((a, b) => b[0] - a[0]).slice(0, keepWeekly).forEach(([, f]) => keep.add(f));
  return items.filter((x) => !keep.has(x.f)).map((x) => x.f);
}

export function compareManifests(prev, now) {
  const errors = [], warnings = [];
  if (!prev) return { errors, warnings };
  for (const t of Object.keys(prev.tables || {})) if (!(t in now.tables) && !(t in EXCLUDED_TABLES)) errors.push(`chýba tabuľka ${t}`);
  for (const b of Object.keys(prev.buckets || {})) if (!(b in now.buckets)) errors.push(`chýba bucket ${b}`);
  const sum = (o) => Object.values(o || {}).reduce((a, n) => a + n, 0);
  if (sum(prev.tables) > 0 && sum(now.tables) === 0) errors.push("všetky tabuľky prázdne");
  if (sum(prev.buckets) > 0 && sum(now.buckets) === 0) errors.push("Storage prázdny");
  for (const [t, n] of Object.entries(prev.tables || {})) {
    const m = now.tables[t];
    if (m !== undefined && n >= 100 && m < n * 0.5) warnings.push(`tabuľka ${t}: ${n} -> ${m} riadkov`);
  }
  for (const [b, n] of Object.entries(prev.buckets || {})) {
    const m = now.buckets[b];
    if (m !== undefined && n >= 10 && m < n * 0.5) warnings.push(`bucket ${b}: ${n} -> ${m} súborov`);
  }
  return { errors, warnings };
}

export function assertSafeOutDir(outDir) {
  const abs = path.resolve(outDir);
  const low = abs.toLowerCase();
  if (/[\\/]onedrive([\\/ -]|$)/i.test(abs) || /[\\/](dropbox|google ?drive|icloud ?drive)([\\/]|$)/i.test(abs)) die("cieľ zálohy nesmie byť v synchronizovanom cloudovom priečinku (OneDrive a pod.)");
  if (low === REPO_ROOT.toLowerCase() || low.startsWith(REPO_ROOT.toLowerCase() + path.sep)) die("cieľ zálohy nesmie byť v repozitári");
  // Žiadny Git repozitár ani worktree (ani hlavný checkout, ak sa skript spúšťa z iného worktree): .git v cieli
  // alebo v ktoromkoľvek nadradenom priečinku = odmietnuté.
  for (let d = abs; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) die(`cieľ zálohy nesmie byť v Git repozitári (${path.join(d, ".git")})`);
    if (path.dirname(d) === d) break;
  }
  return abs;
}

function restrictDir(dir) {
  if (process.platform !== "win32") { fs.chmodSync(dir, 0o700); return; }
  try { execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`], { stdio: "ignore" }); }
  catch { console.warn("Upozornenie: icacls zlyhal - priečinok nemá obmedzené práva (záloha je aj tak šifrovaná)."); }
}

// ----------------------------------------------------------------------------- príkazy
export async function runBackup(env = process.env, log = console.log) {
  const testBase = env.ESBLU_TEST_BASE_URL;
  if (testBase && !/^http:\/\/127\.0\.0\.1:\d+$/.test(testBase)) die("ESBLU_TEST_BASE_URL smie byť iba http://127.0.0.1:<port>");
  const base = testBase || `https://${EXPECTED_REF}.supabase.co`;
  const key = (env.ESBLU_BACKUP_SUPABASE_KEY || "").trim();
  // test_only_ kľúč iba pre lokálny mock (127.0.0.1) - testy tak neobsahujú nič, čo vyzerá ako skutočný kľúč.
  if (!/^(sb_secret_|eyJ)/.test(key) && !(testBase && /^test_only_[a-z0-9_]+$/.test(key))) die("chýba serverový kľúč ESBLU_BACKUP_SUPABASE_KEY (sb_secret_… alebo service_role)");
  if (!env.ESBLU_BACKUP_PUBLIC_KEY || !fs.existsSync(env.ESBLU_BACKUP_PUBLIC_KEY)) die("chýba verejný kľúč ESBLU_BACKUP_PUBLIC_KEY");
  const pub = fs.readFileSync(env.ESBLU_BACKUP_PUBLIC_KEY, "utf8");
  const fp = publicKeyFingerprint(pub);
  if (crypto.createPublicKey(pub).asymmetricKeyDetails?.modulusLength < 4096) die("verejný kľúč musí byť RSA 4096");
  if ((env.ESBLU_BACKUP_PUBKEY_SHA256 || "").toLowerCase() !== fp) die("odtlačok verejného kľúča nesedí s ESBLU_BACKUP_PUBKEY_SHA256 (podvrhnutý kľúč?)");
  const outDir = assertSafeOutDir(env.ESBLU_BACKUP_DIR || path.join(os.homedir(), "esblu-backups", "daily"));

  const started = Date.now();
  log("1/5 Auth používatelia (bez hesiel - Admin API ich nevracia)…");
  const auth_users = await fetchAuthUsers(base, key);
  log("2/5 Tabuľky public…");
  const all = await listTables(base, key);
  const tables = {};
  for (const t of all) {
    if (EXCLUDED_TABLES[t]) continue;
    tables[t] = await fetchTable(base, key, t, Boolean(COUNT_ONLY_TABLES[t]));
  }
  log("3/5 Storage (všetky buckety vrátane súkromných)…");
  const buckets = (await (await http(`${base}/storage/v1/bucket`, key)).json()).map((b) => b.id).sort();
  const objects = [];
  for (const b of buckets) for (const o of await listObjects(base, key, b)) objects.push(await fetchObject(base, key, o));

  const bundle = {
    meta: { format: 2, created_at: new Date().toISOString(), project_ref: EXPECTED_REF, public_key_sha256: fp, all_tables: all,
      excluded_tables: EXCLUDED_TABLES, count_only_tables: COUNT_ONLY_TABLES, buckets, storage_objects: objects.length },
    auth_users, tables, objects,
  };
  const p1 = verifyBundle(bundle);
  if (p1.length) die(`kontrola pred šifrovaním: ${p1.join("; ")}`);

  log("4/5 Šifrovanie verejným kľúčom…");
  fs.mkdirSync(outDir, { recursive: true });
  restrictDir(outDir);
  const stamp = bundle.meta.created_at.replace(/:/g, "-").replace(".", "-"); // s milisekundami - dva behy nikdy nekolidujú
  const name = `esblu-prod-${stamp}.esblubk2`;
  const file = path.join(outDir, name);
  const { file: enc, dataKey } = encryptBundle(zlib.gzipSync(Buffer.from(JSON.stringify(bundle))), pub);
  if (fs.existsSync(file)) die(`súbor ${name} už existuje - neprepisujem`);
  fs.writeFileSync(`${file}.tmp`, enc, { mode: 0o600, flag: "wx" });
  fs.renameSync(`${file}.tmp`, file);

  log("5/5 Kontrola integrity zo súboru na disku…");
  const disk = fs.readFileSync(file);
  const back = JSON.parse(zlib.gunzipSync(decryptWithDataKey(disk, dataKey)).toString("utf8"));
  dataKey.fill(0);
  const p2 = verifyBundle(back);
  if (p2.length) { fs.rmSync(file, { force: true }); die(`kontrola po zápise: ${p2.join("; ")}`); }

  const summary = { status: "OK", duration_s: Math.round((Date.now() - started) / 1000), ...summaryOf(back, name, sha256(disk)) };
  // Neúplná záloha: porovnanie s predchádzajúcim úspešným behom (iba názvy a počty, bez osobných údajov).
  const manifestNow = {
    tables: Object.fromEntries(Object.entries(back.tables).map(([t, e]) => [t, e.count])),
    buckets: Object.fromEntries(back.meta.buckets.map((b) => [b, back.objects.filter((o) => o.bucket === b).length])),
  };
  const manifestFile = path.join(outDir, "last-manifest.json");
  const issues = compareManifests(fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null, manifestNow);
  summary.warnings = issues.warnings;
  if (issues.errors.length) {
    fs.rmSync(file, { force: true });
    die(`záloha je neúplná oproti predchádzajúcej: ${issues.errors.join("; ")} (ak je to zámer, presuň last-manifest.json a spusti znova)`);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifestNow, null, 1));
  const deleted = selectForDeletion(fs.readdirSync(outDir), Number(env.ESBLU_BACKUP_KEEP_DAILY || 14), Number(env.ESBLU_BACKUP_KEEP_WEEKLY || 4));
  for (const f of deleted) fs.rmSync(path.join(outDir, f), { force: true });
  summary.retention_deleted = deleted.length;
  fs.writeFileSync(path.join(outDir, "last-success.json"), JSON.stringify(summary, null, 1));
  fs.appendFileSync(path.join(outDir, "backup-runs.jsonl"), JSON.stringify(summary) + "\n");
  log(`ZÁLOHA OK: ${name} (${disk.length} B), tabuliek ${summary.tables}, riadkov ${summary.rows}, Auth ${summary.auth_users}, súborov ${summary.storage_objects}; zmazaných starých ${deleted.length}`);
  return { file, summary };
}

export function openBackup(file, privatePem, passphrase) {
  const disk = fs.readFileSync(file);
  const bundle = JSON.parse(zlib.gunzipSync(decryptWithPrivateKey(disk, privatePem, passphrase)).toString("utf8"));
  const problems = verifyBundle(bundle);
  if (problems.length) die(problems.join("; "));
  return { bundle, sha: sha256(disk) };
}

export function extractBundle(bundle, outDir) {
  fs.mkdirSync(path.join(outDir, "tables"), { recursive: true });
  restrictDir(outDir);
  for (const [t, v] of Object.entries(bundle.tables)) if (!v.count_only) fs.writeFileSync(path.join(outDir, "tables", `${t}.json`), JSON.stringify(v.rows, null, 1));
  fs.writeFileSync(path.join(outDir, "auth_users.json"), JSON.stringify(bundle.auth_users, null, 1));
  for (const o of bundle.objects) {
    const root = path.resolve(outDir, "storage", o.bucket);
    const p = path.resolve(root, ...o.name.split("/"));
    if (!/^[A-Za-z0-9._-]+$/.test(o.bucket) || !p.startsWith(root + path.sep)) die(`neplatná cesta v zálohe: ${o.bucket}/${o.name}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(o.data_b64, "base64"));
  }
}

// Obnova databázových záznamov: SQL pre psql / Supabase SQL Editor do NOVEJ databázy so schémou z repo migrácií.
// Jedna transakcia; session_replication_role=replica vypne FK kontroly a triggery počas importu (poradie tabuliek
// je potom ľubovoľné a triggery nevytvárajú duplicitné vedľajšie záznamy); generované stĺpce sa vynechajú,
// identity hodnoty sa zachovajú (OVERRIDING SYSTEM VALUE), sekvencie sa posunú za maximum; na konci kontrola počtov.
// Auth používatelia sa obnovujú cez Admin API s pôvodným id (heslá záloha neobsahuje), súbory cez Storage API.
export function buildRestoreSql(bundle) {
  const tag = `esblu_${crypto.randomBytes(6).toString("hex")}`;
  const lines = [
    "-- Esblu obnova databázových záznamov zo zálohy " + bundle.meta.created_at + " (CITLIVÉ ÚDAJE - po obnove zmazať)",
    "begin;",
    "set local session_replication_role = replica;",
    "create function pg_temp.esblu_restore(p_table regclass, p_rows json) returns bigint language plpgsql as $f$",
    "declare cols text; n bigint;",
    "begin",
    "  select string_agg(quote_ident(attname), ',' order by attnum) into cols from pg_attribute",
    "   where attrelid = p_table and attnum > 0 and not attisdropped and attgenerated = '';",
    "  execute format('insert into %s (%s) overriding system value select %s from json_populate_recordset(null::%s, $1)', p_table, cols, cols, p_table) using p_rows;",
    "  get diagnostics n = row_count; return n;",
    "end $f$;",
    "create temp table esblu_restore_check (t text primary key, expected bigint, restored bigint);",
  ];
  // Cieľ je NOVÁ databáza zo schémy migrácií: referenčné dáta, ktoré vložili migrácie (plány, limity, právne
  // dokumenty…), sa nahradia stavom zo zálohy - inak by kolidovali primárne kľúče.
  const restored = Object.entries(bundle.tables).filter(([t, e]) => !e.count_only && /^[a-z0-9_]+$/.test(t)).map(([t]) => `public.${t}`);
  if (restored.length) lines.push(`truncate table ${restored.join(", ")} cascade;`);
  for (const [t, e] of Object.entries(bundle.tables)) {
    if (e.count_only || !/^[a-z0-9_]+$/.test(t)) continue;
    const json = JSON.stringify(e.rows);
    if (json.includes(`$${tag}$`)) die("nečakaný obsah v zálohe (kolízia oddeľovača)");
    lines.push(`insert into esblu_restore_check values ('${t}', ${e.count}, pg_temp.esblu_restore('public.${t}', $${tag}$${json}$${tag}$::json));`);
  }
  lines.push(
    "do $f$ declare r record; m bigint; begin",
    "  for r in select s.oid::regclass seq, c.oid::regclass tbl, a.attname col from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a','i')",
    "    join pg_class c on c.oid = d.refobjid join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid",
    "    join pg_namespace n on n.oid = c.relnamespace where s.relkind = 'S' and n.nspname = 'public' loop",
    "    execute format('select max(%I) from %s', r.col, r.tbl) into m;",
    "    if m is not null then perform setval(r.seq, m); end if;",
    "  end loop;",
    "  if exists (select 1 from esblu_restore_check where expected <> restored) then",
    "    raise exception 'OBNOVA ZLYHALA: počty nesedia: %', (select string_agg(t || ' ' || restored || '/' || expected, ', ') from esblu_restore_check where expected <> restored);",
    "  end if;",
    "end $f$;",
    "commit;",
    "select count(*) as tables_restored, sum(restored) as rows_restored from esblu_restore_check;",
  );
  return lines.join("\n") + "\n";
}

export function initKeys(dir, passphrase) {
  if (!passphrase || passphrase.length < 16) die("heslo súkromného kľúča musí mať aspoň 16 znakov");
  // Zámena s API kľúčom Supabase (vložený zo schránky) — heslo kľúča nesmie byť serverový ani verejný kľúč.
  if (/^(sb_secret_|sb_publishable_|sbp_|eyJ)/.test(passphrase.trim())) die("heslo vyzerá ako API kľúč Supabase - použi samostatné heslo zo správcu hesiel");
  // Kľúče nie v Git repozitári, OneDrive a pod. (rovnaké pravidlá ako cieľ zálohy) a nie v priečinku so zálohami.
  const abs = assertSafeOutDir(dir);
  const backups = path.join(os.homedir(), "esblu-backups").toLowerCase();
  const custom = (process.env.ESBLU_BACKUP_DIR || "").trim() ? path.resolve(process.env.ESBLU_BACKUP_DIR).toLowerCase() : null;
  for (const b of [backups, custom].filter(Boolean)) {
    if (abs.toLowerCase() === b || abs.toLowerCase().startsWith(b + path.sep)) die("kľúče nesmú byť v priečinku so zálohami");
  }
  fs.mkdirSync(dir, { recursive: true });
  restrictDir(dir);
  const priv = path.join(dir, "esblu-backup-private.pem");
  const pub = path.join(dir, "esblu-backup-public.pem");
  if (fs.existsSync(priv) || fs.existsSync(pub)) die("kľúče v cieľovom priečinku už existujú - neprepisujem");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096, publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
  });
  fs.writeFileSync(priv, privateKey, { mode: 0o600 });
  fs.writeFileSync(pub, publicKey);
  return { priv, pub, fingerprint: publicKeyFingerprint(publicKey) };
}

async function askHidden(prompt) {
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8").split(/\r?\n/)[0];
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(prompt); };
    rl.question(prompt, (v) => { rl.close(); process.stdout.write("\n"); resolve(v); });
  });
}

async function main() {
  const [mode, a, b, c] = process.argv.slice(2);
  if (mode === "--run") { await runBackup(); return; }
  if (mode === "--diagnose") { await diagnose(); return; }
  if (mode === "--init-keys") {
    const pass = await askHidden("Heslo súkromného kľúča (min. 16 znakov, uložte do správcu hesiel): ");
    const r = initKeys(a, pass);
    console.log(`Kľúče vytvorené.\n  verejný (na PC, do zálohovania): ${r.pub}\n  súkromný (OFFLINE: USB/trezor, NIE na tomto PC): ${r.priv}\n  ESBLU_BACKUP_PUBKEY_SHA256=${r.fingerprint}`);
    return;
  }
  if (mode === "--verify" || mode === "--extract") {
    const pass = await askHidden("Heslo súkromného kľúča: ");
    const { bundle, sha } = openBackup(a, fs.readFileSync(b, "utf8"), pass);
    console.log(`OVERENÉ: ${Object.keys(bundle.tables).length} tabuliek, ${bundle.auth_users.length} Auth, ${bundle.objects.length} súborov, SHA-256 ${sha}, vytvorené ${bundle.meta.created_at}`);
    if (mode === "--extract") {
      const dir = assertSafeOutDir(c);
      extractBundle(bundle, dir);
      fs.writeFileSync(path.join(dir, "restore-public-data.sql"), buildRestoreSql(bundle), { mode: 0o600 });
      console.log(`Rozbalené do ${c} (tables/, storage/, auth_users.json, restore-public-data.sql) - citlivé údaje, po obnove zmazať.`);
    }
    return;
  }
  console.log("Použitie: --init-keys <priečinok> | --run | --diagnose | --verify <súbor> <private.pem> | --extract <súbor> <private.pem> <cieľ>");
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nCHYBA: ${e instanceof BackupError ? e.message : (e?.message || String(e))}\nZáloha NIE JE platná. V produkcii sa nič nezmenilo.`);
    process.exitCode = 1;
  });
}
