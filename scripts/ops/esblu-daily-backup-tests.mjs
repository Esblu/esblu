// Testy dennej zálohy (scripts/ops/esblu-daily-backup.mjs) proti lokálnemu mock Supabase (127.0.0.1).
// Nepripája sa k produkcii. Spustenie: node scripts/ops/esblu-daily-backup-tests.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as B from "./esblu-daily-backup.mjs";

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL ${label}\n       ${e.message}`); }
}

const KEY = "test_only_mock_key";
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
function mockData() {
  const vehicles = Array.from({ length: 2345 }, (_, i) => ({ id: i + 1, plate: `BA${i}`, company_id: "c1" }));
  const files = {
    "vehicle-photos/c1/v1/a.webp": Buffer.from("vehicle-photo-bytes"),
    "vehicle-photos/c1/v1/b.webp": Buffer.from("second"),
    "company-logos/c1/logo.webp": Buffer.from("logo"),
    "ai-inbox-documents/c1/doc.pdf": crypto.randomBytes(5000),
  };
  return {
    tables: { vehicles, companies: [{ id: "c1", name: "Firma" }], push_devices: [{ token: "fcm-secret" }],
      push_subscriptions: [{ endpoint: "x" }], session_active_company: [{ s: 1 }], fx_reference_rates: Array.from({ length: 30 }, (_, i) => ({ d: i })) },
    users: Array.from({ length: 3 }, (_, i) => ({ id: `u${i}`, email: `u${i}@example.invalid` })),
    files, buckets: ["ai-inbox-documents", "company-logos", "einvoice-documents", "vehicle-photos"],
  };
}
function startMock(data, opts = {}) {
  const writes = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const auth = req.headers.apikey === KEY;
    if (!auth) { res.writeHead(401); return res.end(); }
    let body = ""; for await (const c of req) body += c;
    if (req.method !== "GET" && !(req.method === "POST" && u.pathname.startsWith("/storage/v1/object/list/"))) { writes.push(`${req.method} ${u.pathname}`); res.writeHead(405); return res.end(); }
    if (u.pathname === "/rest/v1/") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ definitions: Object.fromEntries(Object.keys(data.tables).map((t) => [t, {}])) })); }
    const tm = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (tm) {
      const rows = data.tables[tm[1]] || [];
      const [from, to] = (req.headers.range || "0-999").split("-").map(Number);
      const page = rows.slice(from, to + 1);
      const total = opts.lieCount && tm[1] === "vehicles" ? rows.length + 1 : rows.length;
      res.writeHead(206, { "content-type": "application/json", "content-range": `${from}-${from + page.length - 1}/${total}` });
      return res.end(JSON.stringify(page));
    }
    if (u.pathname === "/auth/v1/admin/users") { res.writeHead(200); return res.end(JSON.stringify({ users: Number(u.searchParams.get("page")) === 1 ? data.users : [] })); }
    if (u.pathname === "/storage/v1/bucket") { res.writeHead(200); return res.end(JSON.stringify(data.buckets.map((id) => ({ id })))); }
    const lm = u.pathname.match(/^\/storage\/v1\/object\/list\/(.+)$/);
    if (lm) {
      const bucket = decodeURIComponent(lm[1]); const { prefix } = JSON.parse(body || "{}");
      const pre = prefix ? `${bucket}/${prefix}/` : `${bucket}/`;
      const entries = new Map();
      for (const [k, v] of Object.entries(data.files)) {
        if (!k.startsWith(pre)) continue;
        const rest = k.slice(pre.length); const [first, ...more] = rest.split("/");
        if (more.length) entries.set(first, { name: first, id: null });
        else entries.set(first, { name: first, id: "x", metadata: { size: v.length, eTag: `"${opts.badEtag && k.endsWith("logo.webp") ? "0".repeat(32) : md5(v)}"` } });
      }
      res.writeHead(200); return res.end(JSON.stringify([...entries.values()]));
    }
    const om = u.pathname.match(/^\/storage\/v1\/object\/authenticated\/(.+)$/);
    if (om) {
      const k = om[1].split("/").map(decodeURIComponent).join("/");
      if (!data.files[k]) { res.writeHead(404); return res.end(); }
      res.writeHead(200); return res.end(data.files[k]);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: `http://127.0.0.1:${srv.address().port}`, writes })));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "esblu-bk-"));
const PASS = "correct horse battery staple 2026";
const keys = B.initKeys(path.join(tmp, "keys"), PASS);
const envFor = (base, extra = {}) => ({ ESBLU_TEST_BASE_URL: base, ESBLU_BACKUP_SUPABASE_KEY: KEY, ESBLU_BACKUP_PUBLIC_KEY: keys.pub,
  ESBLU_BACKUP_PUBKEY_SHA256: keys.fingerprint, ESBLU_BACKUP_DIR: path.join(tmp, "out"), ...extra });
const quiet = () => {};

await check("init-keys: RSA-4096, súkromný kľúč šifrovaný heslom, neprepíše existujúce", () => {
  const priv = fs.readFileSync(keys.priv, "utf8");
  assert.match(priv, /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.throws(() => crypto.createPrivateKey(priv));
  assert.equal(crypto.createPublicKey(fs.readFileSync(keys.pub)).asymmetricKeyDetails.modulusLength, 4096);
  assert.throws(() => B.initKeys(path.join(tmp, "keys"), PASS), /neprepisujem/);
  assert.throws(() => B.initKeys(path.join(tmp, "k2"), "short"), /16 znakov/);
  assert.throws(() => B.initKeys(path.join(tmp, "k3"), "sb_secret_abcdefghijklmnop"), /API kľúč/);
  assert.throws(() => B.initKeys(path.join(os.homedir(), "OneDrive", "esblu-keys"), PASS), /OneDrive/);
  assert.throws(() => B.initKeys(path.join(os.homedir(), "esblu-backups", "daily", "keys"), PASS), /priečinku so zálohami/);
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "esblu-keys-git-")); fs.mkdirSync(path.join(gitDir, ".git"));
  assert.throws(() => B.initKeys(path.join(gitDir, "keys"), PASS), /Git repozitári/);
  fs.rmSync(gitDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(os.homedir(), "OneDrive", "esblu-keys")), "odmietnutý cieľ sa nevytvorí");
});

const data = mockData();
const m = await startMock(data);
let first;
await check("záloha: všetky tabuľky (stránkovanie > 1000), Auth, všetky buckety vrátane podpriečinkov; iba čítanie", async () => {
  first = await B.runBackup(envFor(m.base), quiet);
  assert.equal(m.writes.length, 0, "žiadny zápis do Supabase");
  assert.equal(first.summary.storage_objects, 4);
  assert.equal(first.summary.auth_users, 3);
  const { bundle } = B.openBackup(first.file, fs.readFileSync(keys.priv, "utf8"), PASS);
  assert.equal(bundle.tables.vehicles.rows.length, 2345);
  assert.deepEqual(bundle.objects.map((o) => `${o.bucket}/${o.name}`).sort(), Object.keys(data.files).sort());
});
await check("minimalizácia: push tokeny, web push, relácie nie sú v zálohe; kurzy ECB celé (prepočty faktúr)", async () => {
  const { bundle } = B.openBackup(first.file, fs.readFileSync(keys.priv, "utf8"), PASS);
  for (const t of ["push_devices", "push_subscriptions", "session_active_company"]) assert.equal(bundle.tables[t], undefined, t);
  assert.equal(bundle.tables.fx_reference_rates.count, 30);
  assert.equal(bundle.tables.fx_reference_rates.rows.length, 30);
  assert.ok(!fs.readFileSync(first.file).includes("fcm-secret"));
});
await check("súhrn last-success.json bez osobných údajov (žiadne e-maily, mená, ŠPZ)", () => {
  const s = fs.readFileSync(path.join(tmp, "out", "last-success.json"), "utf8");
  assert.doesNotMatch(s, /@example\.invalid|Firma|BA1|plate/);
  assert.match(s, /"status": "OK"/);
});
await check("šifrovanie: bez súkromného kľúča/hesla sa nedá otvoriť; obsah nie je čitateľný", () => {
  const buf = fs.readFileSync(first.file);
  assert.ok(!buf.includes("example.invalid") && !buf.includes("vehicle-photo-bytes"));
  assert.throws(() => B.openBackup(first.file, fs.readFileSync(keys.priv, "utf8"), "wrong password 123456"), /heslo/);
  const other = B.initKeys(path.join(tmp, "other"), PASS);
  assert.throws(() => B.openBackup(first.file, fs.readFileSync(other.priv, "utf8"), PASS), /iným kľúčom/);
});
await check("integrita: zmena 1 bajtu v dátach aj v hlavičke = odmietnuté", () => {
  const buf = fs.readFileSync(first.file);
  for (const pos of [buf.length - 10, 50]) {
    const bad = Buffer.from(buf); bad[pos] ^= 1;
    const f = path.join(tmp, `bad-${pos}.esblubk2`); fs.writeFileSync(f, bad);
    assert.throws(() => B.openBackup(f, fs.readFileSync(keys.priv, "utf8"), PASS));
  }
});
await check("obnova: --extract vytvorí tabuľky, Auth a súbory s pôvodným obsahom", () => {
  const { bundle } = B.openBackup(first.file, fs.readFileSync(keys.priv, "utf8"), PASS);
  const dir = path.join(tmp, "restore");
  B.extractBundle(bundle, dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "tables", "vehicles.json"))).length, 2345);
  assert.deepEqual(fs.readFileSync(path.join(dir, "storage", "ai-inbox-documents", "c1", "doc.pdf")), data.files["ai-inbox-documents/c1/doc.pdf"]);
  assert.equal(fs.existsSync(path.join(dir, "tables", "push_devices.json")), false);
});
await check("extract: cesta mimo cieľa (../) je odmietnutá", () => {
  const { bundle } = B.openBackup(first.file, fs.readFileSync(keys.priv, "utf8"), PASS);
  bundle.objects.push({ bucket: "x", name: "../../evil.txt", size: 1, md5: "", sha256: "", data_b64: "eA==" });
  assert.throws(() => B.extractBundle(bundle, path.join(tmp, "restore2")), /neplatná cesta/);
});
await check("chyby zdroja: nesúhlasný počet riadkov a nesprávny eTag súboru zastavia zálohu", async () => {
  const m2 = await startMock(mockData(), { lieCount: true });
  await assert.rejects(B.runBackup(envFor(m2.base, { ESBLU_BACKUP_DIR: path.join(tmp, "o2") }), quiet), /server hlási/);
  m2.srv.close();
  const m3 = await startMock(mockData(), { badEtag: true });
  await assert.rejects(B.runBackup(envFor(m3.base, { ESBLU_BACKUP_DIR: path.join(tmp, "o3") }), quiet), /MD5 nesedí/);
  m3.srv.close();
  assert.equal(fs.existsSync(path.join(tmp, "o2", "last-success.json")), false);
});
await check("ochrany: iba produkčný ref alebo 127.0.0.1, pripnutý odtlačok kľúča, cieľ mimo repa a OneDrive", async () => {
  await assert.rejects(B.runBackup(envFor("https://cjbdijbbcujvmrzezusd.supabase.co"), quiet), /127\.0\.0\.1/);
  await assert.rejects(B.runBackup(envFor(m.base, { ESBLU_BACKUP_PUBKEY_SHA256: "0".repeat(64) }), quiet), /odtlačok/);
  await assert.rejects(B.runBackup(envFor(m.base, { ESBLU_BACKUP_SUPABASE_KEY: "anon" }), quiet), /serverový kľúč/);
  await assert.rejects(B.runBackup({ ...envFor(m.base), ESBLU_TEST_BASE_URL: "" }, quiet), /serverový kľúč/); // test_only_ kľúč nikdy proti produkcii
  assert.throws(() => B.assertSafeOutDir("C:\\Users\\roiaj\\OneDrive\\esblu"), /OneDrive/);
  assert.throws(() => B.assertSafeOutDir(path.join(os.homedir(), "OneDrive - Esblu", "x")), /OneDrive/);
  assert.throws(() => B.assertSafeOutDir(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "tmp")), /repozitári/);
  // Iný Git repozitár / worktree (napr. hlavný checkout pri behu z worktree) = odmietnuté aj v podpriečinku.
  const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "esblu-other-repo-"));
  fs.mkdirSync(path.join(otherRepo, ".git"));
  assert.throws(() => B.assertSafeOutDir(path.join(otherRepo, "zalohy", "daily")), /Git repozitári/);
  fs.rmSync(path.join(otherRepo, ".git"), { recursive: true }); fs.writeFileSync(path.join(otherRepo, ".git"), "gitdir: x"); // worktree má .git ako súbor
  assert.throws(() => B.assertSafeOutDir(path.join(otherRepo, "a")), /Git repozitári/);
  fs.rmSync(otherRepo, { recursive: true, force: true });
  assert.doesNotThrow(() => B.assertSafeOutDir(path.join(os.tmpdir(), "esblu-ok-target")));
});
await check("PowerShell: DPAPI kľúč sa ukladá/číta cez esblu-backup-secret.ps1 (bez CRLF/BOM, tolerantné čítanie, kódy chýb), regresný test existuje", async () => {
  const ops = path.dirname(new URL(import.meta.url).pathname);
  const ps = fs.readFileSync(path.join(ops, "esblu-daily-backup.ps1"), "utf8");
  const lib = fs.readFileSync(path.join(ops, "esblu-backup-secret.ps1"), "utf8");
  const t = fs.readFileSync(path.join(ops, "tests", "esblu-backup-secret.tests.ps1"), "utf8");
  assert.doesNotMatch(ps, /Get-Content \$KeyFile -Raw \| ConvertTo-SecureString/, "pôvodné čítanie (koncový CRLF) odstránené");
  assert.doesNotMatch(ps, /ConvertFrom-SecureString \| Set-Content/, "pôvodný zápis odstránený");
  assert.match(ps, /\. \(Join-Path \$PSScriptRoot "esblu-backup-secret\.ps1"\)/);
  assert.match(ps, /Save-EsbluSecret -Secure \$sec -Path \$KeyFile/);
  assert.match(ps, /try \{ \$sec = Read-EsbluSecret -Path \$KeyFile \} catch \{ Fail/);
  assert.match(lib, /WriteAllText\(\$Path, \$enc, \(New-Object Text\.ASCIIEncoding\)\)/);
  for (const c of ["SECRET_MISSING", "SECRET_EMPTY", "SECRET_FORMAT", "SECRET_DPAPI"]) assert.ok(lib.includes(c), c);
  assert.match(lib, /\.Trim\(\)/);
  for (const name of ["stary format zo -Setup", "SECRET_DPAPI", "SECRET_FORMAT", "SECRET_MISSING", "neobsahuju hodnotu"]) assert.ok(t.includes(name), name);
  for (const f of [ps, lib, t]) assert.ok(/^[\x00-\x7F]*$/.test(f), "iba ASCII (PowerShell 5.1)");
});
await check("neúplná záloha: zmiznutá tabuľka alebo bucket oproti predchádzajúcemu behu = FAIL, súbor sa nezachová", async () => {
  const d = mockData(); delete d.tables.companies; d.buckets = d.buckets.filter((b) => b !== "company-logos");
  for (const k of Object.keys(d.files)) if (k.startsWith("company-logos/")) delete d.files[k];
  const m4 = await startMock(d);
  const before = fs.readdirSync(path.join(tmp, "out")).filter((f) => f.endsWith(".esblubk2")).length;
  await assert.rejects(B.runBackup(envFor(m4.base), quiet), /neúplná.*chýba tabuľka companies.*chýba bucket company-logos/);
  m4.srv.close();
  assert.equal(fs.readdirSync(path.join(tmp, "out")).filter((f) => f.endsWith(".esblubk2")).length, before);
  const w = B.compareManifests({ tables: { vehicles: 2000 }, buckets: { "vehicle-photos": 40 } }, { tables: { vehicles: 100 }, buckets: { "vehicle-photos": 3 } });
  assert.equal(w.errors.length, 0);
  assert.equal(w.warnings.length, 2);
});
await check("retencia: 14 denných + najnovšia z každého zo 4 predchádzajúcich týždňov", () => {
  const names = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 20, 2, 30) - i * 86400000);
    return `esblu-prod-${d.toISOString().slice(0, 19).replace(/:/g, "-")}Z.esblubk2`;
  });
  const del = B.selectForDeletion([...names, "last-success.json", "backup-runs.jsonl"], 14, 4);
  const kept = names.filter((n) => !del.includes(n));
  assert.equal(kept.length, 18);
  assert.ok(kept.includes(names[0]) && kept.includes(names[13]));
  assert.ok(!del.includes("last-success.json"));
  const oldest = kept.map((n) => Date.parse(n.slice(11, 21))).sort()[0];
  assert.ok(Date.UTC(2026, 10, 20) - oldest <= 45 * 86400000, "najstaršia záloha max ~6 týždňov");
});
await check("formát: ESBLUBK2 + odtlačok kľúča v hlavičke (AAD), RSA-OAEP zabalený kľúč", () => {
  const h = B.parseHeader(fs.readFileSync(first.file));
  assert.equal(h.fp, keys.fingerprint);
  assert.equal(h.wrapped.length, 512);
  const plain = zlib.gunzipSync(B.decryptWithPrivateKey(fs.readFileSync(first.file), fs.readFileSync(keys.priv, "utf8"), PASS));
  assert.equal(JSON.parse(plain).meta.format, 2);
});
m.srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nesblu-daily-backup: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
