// =============================================================================
// P1-5 skupina D, krok D-B — offline testy šifrovanej zálohy (iba syntetické bajty, bez siete, bez stagingu).
//   node --experimental-strip-types --no-warnings scripts/p15-staging/storage-backup-tests.ts
// Test 9 zapíše syntetický archív do dočasného priečinka a vypíše jeho cestu pre nezávislé overenie (Python).
// =============================================================================
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ALLOWED_ORIGIN, Stop } from "./runner-core.ts";
import {
  assertBackupTarget, assertPassphraseSafe, backupGuardedFetch, buildBackup, looksLikeApiKey, readBackupDir, sameSecret, validateInventory, verifyBackup, writeBackupDir,
  type Fetched, type InventoryItem,
} from "./storage-backup.ts";

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`); }
}
const PASS = "correct horse battery staple 2026";
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function fixture(opaqueEtags = 0) {
  const items: InventoryItem[] = [];
  const bytes: Buffer[] = [];
  for (let i = 0; i < 67; i++) {
    const b = randomBytes(100 + i);
    const bucket = i < 63 ? "einvoice-documents" : i < 64 ? "ai-inbox-documents" : "billing-documents";
    const name = bucket === "billing-documents" ? `2026/inv-${i}.pdf` : `0c7d3a52-6f0e-4d8a-9a51-1f6f3f2b7e1${i % 3}/inbound/${i}.xml`;
    // eTag ako ho vracia Storage (s úvodzovkami); časť „nie MD5“ (napr. SSE/multipart) ako nepriehľadný identifikátor
    const etag = i < opaqueEtags ? `"${randomBytes(16).toString("hex")}-2"` : `"${md5(b)}"`;
    items.push({ bucket, name, id: randomUUID(), size: b.byteLength, etag, updated_at: "2026-11-01T00:00:00.000000+00:00", mimetype: "application/xml" });
    bytes.push(b);
  }
  const fetched: Fetched[] = items.map((item, i) => ({ item, first: bytes[i], second: Buffer.from(bytes[i]) }));
  return { items, bytes, fetched };
}
const rb = (m: Map<string, Buffer>) => (b: string) => { const x = m.get(b); if (!x) throw new Error("missing"); return x; };

await test("1 inventár: 67, 3 buckety, bez P15, bezpečné cesty, unikátne id aj cesty, eTag/updated_at prítomné", () => {
  const { items } = fixture();
  validateInventory(items);
  for (const mut of [
    (x: InventoryItem[]) => x.pop(),
    (x: InventoryItem[]) => { x[0].bucket = "company-logos"; },
    (x: InventoryItem[]) => { x[0].name = "f1510000-0000-4000-8000-000000000003/inbound/a.xml"; },
    (x: InventoryItem[]) => { x[0].name = "a/../b"; },
    (x: InventoryItem[]) => { x[0].name = "a b%20.xml"; },
    (x: InventoryItem[]) => { x[1] = { ...x[0] }; },
    (x: InventoryItem[]) => { x[1].id = x[0].id; },
    (x: InventoryItem[]) => { x[0].id = "nie-uuid"; },
    (x: InventoryItem[]) => { x[0].etag = ""; },
    (x: InventoryItem[]) => { x[0].updated_at = "x"; },
  ]) { const c = structuredClone(items); mut(c); assert.throws(() => validateInventory(c), Stop); }
});
await test("2 eTag sa nepredpokladá ako MD5: nepriehľadný eTag prejde (not_md5), nesúlad je iba informácia, SHA-256 je autorita", () => {
  const { items, fetched } = fixture(5);
  const r = buildBackup(fetched, items, PASS);
  assert.equal(r.summary.not_md5, 5);
  assert.equal(r.summary.match, 62);
  const { items: i2, fetched: f2 } = fixture();
  i2[3].etag = `"${"0".repeat(32)}"`; // 32-hex, ale iný ako MD5 (napr. šifrovanie na strane servera)
  const r2 = buildBackup(f2, i2, PASS);
  assert.equal(r2.summary.mismatch, 1);
});
await test("3 dve stiahnutia sa líšia / veľkosť ≠ inventár / poradie ≠ inventár → STOP, nič sa nezapíše", () => {
  const { items, fetched } = fixture();
  const a = fetched.map((x) => ({ ...x })); a[10] = { ...a[10], second: randomBytes(a[10].first.byteLength) };
  assert.throws(() => buildBackup(a, items, PASS), Stop);
  const b = fetched.map((x) => ({ ...x })); b[3] = { ...b[3], first: new Uint8Array(1), second: new Uint8Array(1) };
  assert.throws(() => buildBackup(b, items, PASS), Stop);
  const c = fetched.map((x) => ({ ...x })); [c[0], c[1]] = [c[1], c[0]];
  assert.throws(() => buildBackup(c, items, PASS), Stop);
});
await test("4 záloha → zápis → verify: obsah bajt po bajte, hlavička bez ciest/názvov, žiadny plaintext na disku", () => {
  const { items, fetched, bytes } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "p15b-")), "backup");
  writeBackupDir(dir, header, blobs);
  const h = readFileSync(path.join(dir, "header.json"), "utf8");
  assert.ok(!h.includes("inbound") && !h.includes("0c7d3a52") && !h.includes("inv-") && !h.includes(items[0].id), "hlavička nesmie obsahovať cesty ani id");
  for (const f of readdirSync(dir)) {
    const disk = readFileSync(path.join(dir, f));
    for (const b of bytes.slice(0, 67)) assert.equal(disk.indexOf(b.subarray(0, 32)), -1, `plaintext v ${f}`);
  }
  const r = readBackupDir(dir);
  const { manifest, content } = verifyBackup(r.header, r.readBlob, PASS);
  assert.equal(manifest.length, 67);
  fetched.forEach(({ item, first }) => assert.ok(Buffer.from(first).equals(content.get(`${item.bucket}|${item.name}`)!)));
  assert.equal(readdirSync(dir).length, 69);
  assert.throws(() => writeBackupDir(dir, header, blobs), Stop, "neprepisuje existujúci priečinok");
});
await test("5 zlé/krátke heslo, zmenený bajt (aj s prepočítaným hashom), vymenené bloby, zmenený manifest → STOP", () => {
  const { items, fetched } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  assert.throws(() => verifyBackup(header, rb(blobs), PASS + "x"), Stop);
  assert.throws(() => buildBackup(fetched, items, "short"), Stop);
  const t1 = new Map(blobs); const x = Buffer.from(t1.get("obj-0005.bin")!); x[40] ^= 1; t1.set("obj-0005.bin", x);
  assert.throws(() => verifyBackup(header, rb(t1), PASS), Stop);
  const t2 = new Map(blobs); const a = t2.get("obj-0001.bin")!, b = t2.get("obj-0002.bin")!; t2.set("obj-0001.bin", b); t2.set("obj-0002.bin", a);
  assert.throws(() => verifyBackup(header, rb(t2), PASS), Stop);
  const t3 = new Map(blobs); const mm = Buffer.from(t3.get("manifest.bin")!); mm[50] ^= 1; t3.set("manifest.bin", mm);
  assert.throws(() => verifyBackup(header, rb(t3), PASS), Stop);
});
await test("6 zmenená hlavička (HMAC): hash blobu, počet, KDF, soľ, čas, formát, odstránený MAC → STOP", () => {
  const { items, fetched } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  const tamper: Array<(h: typeof header) => void> = [
    (h) => { h.blobs[4].sha256_cipher = "0".repeat(64); },
    (h) => { h.objects = 66; },
    (h) => { h.kdf.N = 2 ** 10; },
    (h) => { h.kdf.salt_b64 = Buffer.alloc(16).toString("base64"); },
    (h) => { h.created_at = "2020-01-01T00:00:00.000Z"; },
    (h) => { h.inventory_sha256 = "1".repeat(64); },
    (h) => { delete h.header_mac; },
    (h) => { h.format = "esblu-p15-storage-backup-v1"; },
  ];
  for (const t of tamper) { const h = structuredClone(header); t(h); assert.throws(() => verifyBackup(h, rb(blobs), PASS), Stop); }
});
await test("7 sieť: skutočný supabase-js download prejde iba ako GET z inventára; upload/update/remove/list/move/sign → STOP bez odoslania", async () => {
  const { items, bytes } = fixture();
  const sent: string[] = [];
  const server = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    sent.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const i = items.findIndex((it) => `/storage/v1/object/${it.bucket}/${it.name}` === decodeURIComponent(u.pathname));
    return i >= 0 ? new Response(new Uint8Array(bytes[i]), { status: 200 }) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const log: string[] = [];
  const f = backupGuardedFetch(items, server, log);
  const c = createClient(ALLOWED_ORIGIN, "sb_secret_offline_test_key_000000000000", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: f } });
  const { data, error } = await c.storage.from(items[0].bucket).download(items[0].name);
  assert.ok(!error && data);
  assert.equal(sha(new Uint8Array(await data!.arrayBuffer())), sha(bytes[0]));
  const s = c.storage.from(items[0].bucket);
  const attempts = [
    () => s.upload(items[0].name, new Uint8Array(1)),
    () => s.upload(items[0].name, new Uint8Array(1), { upsert: true }),
    () => s.update(items[0].name, new Uint8Array(1)),
    () => s.remove([items[0].name]),
    () => s.list("0c7d3a52-6f0e-4d8a-9a51-1f6f3f2b7e10"),
    () => s.move(items[0].name, "x/y.xml"),
    () => s.copy(items[0].name, "x/y.xml"),
    () => s.createSignedUrl(items[0].name, 60),
    () => s.download("f1510000-0000-4000-8000-000000000003/inbound/a.xml"),
    () => c.storage.from("billing-documents").download("2026/x.pdf"),
    () => c.from("companies").select("id"),
    () => c.rpc("esblu_company_termination_execute", {}),
  ];
  for (const a of attempts) {
    let r: unknown;
    try { r = await (a() as unknown as Promise<unknown>); } catch (e) { r = { error: e }; }
    assert.ok((r as { error?: unknown }).error, "musí zlyhať");
  }
  assert.deepEqual(sent, [`GET /storage/v1/object/${items[0].bucket}/${items[0].name}`]);
  // storage-js pri GET opakuje pokus (retry) — každé opakovanie je tiež zablokované; povolené je iba prvé stiahnutie
  assert.ok(log.filter((l) => l.startsWith("DENY")).length >= attempts.length, JSON.stringify(log));
  assert.equal(log.filter((l) => l.startsWith("ALLOW")).length, 1);
});
await test("8 cieľ archívu: OneDrive, mimo koreňa, existujúci priečinok, odkaz v ceste → STOP", () => {
  const root = mkdtempSync(path.join(tmpdir(), "p15root-"));
  assertBackupTarget(path.join(root, "storage-backup-1"), root);
  assert.throws(() => assertBackupTarget(path.join(root, "OneDrive", "x"), root), Stop);
  assert.throws(() => assertBackupTarget(path.join(tmpdir(), "elsewhere"), root), Stop);
  assert.throws(() => assertBackupTarget(path.join(root, "sync", "x"), root, [path.join(root, "sync")]), Stop);
  mkdirSync(path.join(root, "exists"));
  assert.throws(() => assertBackupTarget(path.join(root, "exists"), root), Stop);
  const real = mkdtempSync(path.join(tmpdir(), "p15real-"));
  symlinkSync(real, path.join(root, "link"));
  assert.throws(() => assertBackupTarget(path.join(root, "link", "x"), root), Stop);
});
await test("9 syntetický archív na nezávislé overenie (Python): zapíše archív + referenčné SHA-256", () => {
  const { items, fetched, bytes } = fixture(3);
  const { header, blobs } = buildBackup(fetched, items, PASS);
  const base = mkdtempSync(path.join(tmpdir(), "p15b-indep-"));
  writeBackupDir(path.join(base, "backup"), header, blobs);
  // referencia mimo archívu: SHA-256 pôvodných syntetických bajtov (Python ich porovná s dešifrovaným obsahom)
  writeFileSync(path.join(base, "reference.json"), JSON.stringify(items.map((it, i) => ({ bucket: it.bucket, name: it.name, sha256: sha(bytes[i]) }))));
  writeFileSync("/tmp/p15b-indep-path.txt", base);
});

// ----------------------------------------------------------------------------- po prerušení 1. pokusu (zámena hesla a kľúča)
const FAKE_KEY = "sb_secret_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"; // syntetická hodnota (nie skutočný kľúč)
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXRlc3Q";
await test("10 heslo archívu vo formáte kľúča/JWT, totožné s kľúčom, podreťazec, krátke → STOP", () => {
  for (const bad of [FAKE_KEY, ` ${FAKE_KEY} `, "sb_publishable_AQ4QLRJBTcEPp__yMrh4bg_MUY3N-Ma", "sbp_0123456789abcdef0123456789", "SB_SECRET_xxxxxxxxxxxxxxxxxxxxxxxx", FAKE_JWT, `moje heslo ${FAKE_KEY}`]) {
    assert.throws(() => assertPassphraseSafe(bad), Stop, bad.slice(0, 12));
  }
  const good = "zelena-lampa-orech-vlak-2026-kopec";
  assertPassphraseSafe(good);
  assertPassphraseSafe(good, FAKE_KEY);
  assert.throws(() => assertPassphraseSafe(good, good), Stop, "totožné");
  assert.throws(() => assertPassphraseSafe(good, ` ${good}\n`), Stop, "totožné po orezaní");
  assert.throws(() => assertPassphraseSafe(good + "x", good), Stop, "podreťazec");
  assert.throws(() => assertPassphraseSafe("kratke-heslo"), Stop);
  assert.ok(looksLikeApiKey(FAKE_KEY) && looksLikeApiKey(FAKE_JWT) && !looksLikeApiKey(good));
  assert.ok(sameSecret("a", "a") && !sameSecret("a", "b"));
  // šifrovanie odmietne heslo vo formáte kľúča aj pri vytváraní zálohy
  const { items, fetched } = fixture();
  assert.throws(() => buildBackup(fetched, items, FAKE_KEY), Stop);
});
await test("11 prerušenie počas zápisu archívu → iba <dir>.partial bez header.json (šifrované bloby), <dir> nevznikne, nový pokus do toho istého cieľa = STOP", () => {
  const { items, fetched, bytes } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  const base = mkdtempSync(path.join(tmpdir(), "p15b-int-"));
  const dir = path.join(base, "storage-backup-x");
  assert.throws(() => writeBackupDir(dir, header, blobs, { afterBlob: (n) => { if (n === 20) throw new Error("simulované prerušenie"); } }));
  assert.ok(!existsSync(dir), "hotový priečinok nesmie vzniknúť");
  const left = readdirSync(`${dir}.partial`);
  assert.equal(left.length, 20);
  assert.ok(!left.includes("header.json"));
  for (const f of left) { const d = readFileSync(path.join(`${dir}.partial`, f)); for (const b of bytes) assert.equal(d.indexOf(b.subarray(0, 32)), -1); }
  assert.throws(() => writeBackupDir(dir, header, blobs), Stop);
  assert.throws(() => assertBackupTarget(dir, base), Stop);
  assert.throws(() => readBackupDir(`${dir}.partial`));
});
await test("12 skutočný proces runnera: zámena hesla/kľúča a zlé heslo → STOP pred čítaním inventára a sieťou; hodnoty sa nevypíšu; SIGKILL počas verify nič nezmení", async () => {
  const WT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/p15-staging/p15-backup.ts"], {
    cwd: WT, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ESBLU_STAGING_SUPABASE_URL: ALLOWED_ORIGIN, ...env },
  });
  const outDir = path.join(mkdtempSync(path.join(tmpdir(), "p15b-proc-")), "storage-backup-proc");
  const common = { ESBLU_P15B_INVENTORY: "/neexistuje/inventar.json", ESBLU_P15B_INVENTORY_SHA256: "0".repeat(64), ESBLU_P15B_OUT: outDir };
  const good = "zelena-lampa-orech-vlak-2026-kopec";
  for (const [label, env, expect] of [
    ["heslo = kľúč (formát kľúča)", { ESBLU_P15B_MODE: "backup", ESBLU_P15_BACKUP_PASSPHRASE: FAKE_KEY, ESBLU_STAGING_SERVICE_ROLE_KEY: FAKE_KEY, ...common }, /formát API kľúča/],
    ["heslo = JWT", { ESBLU_P15B_MODE: "compare", ESBLU_P15_BACKUP_PASSPHRASE: FAKE_JWT, ESBLU_STAGING_SERVICE_ROLE_KEY: FAKE_KEY, ESBLU_P15B_DIR: "/neexistuje" }, /formát API kľúča/],
    ["heslo = kľúč (iný formát)", { ESBLU_P15B_MODE: "backup", ESBLU_P15_BACKUP_PASSPHRASE: good, ESBLU_STAGING_SERVICE_ROLE_KEY: good, ...common }, /totožné/],
    ["kľúč v poli hesla pri verify", { ESBLU_P15B_MODE: "verify", ESBLU_P15_BACKUP_PASSPHRASE: FAKE_KEY, ESBLU_P15B_DIR: "/neexistuje" }, /formát API kľúča/],
  ] as const) {
    const r = run(env as Record<string, string>);
    assert.equal(r.status, 2, `${label}: ${r.stderr}`);
    assert.match(r.stderr, expect, label);
    assert.ok(!/ENOENT|inventár/.test(r.stderr), `${label}: musí zastaviť pred čítaním súborov`);
    assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY) && !r.stderr.includes(good) && !r.stderr.includes(FAKE_JWT), `${label}: hodnota vo výstupe`);
    assert.ok(!existsSync(outDir) && !existsSync(`${outDir}.partial`), `${label}: nič sa nezapísalo`);
  }
  // zlé heslo pri verify syntetického archívu
  const { items, fetched } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  const arch = path.join(mkdtempSync(path.join(tmpdir(), "p15b-v-")), "storage-backup-v");
  writeBackupDir(arch, header, blobs);
  const snap = () => readdirSync(arch).map((f) => `${f}:${sha(readFileSync(path.join(arch, f)))}`).join(",");
  const before = snap();
  const wrong = run({ ESBLU_P15B_MODE: "verify", ESBLU_P15_BACKUP_PASSPHRASE: PASS + " zle", ESBLU_P15B_DIR: arch });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /HMAC/);
  const ok = run({ ESBLU_P15B_MODE: "verify", ESBLU_P15_BACKUP_PASSPHRASE: PASS, ESBLU_P15B_DIR: arch });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /VERIFY_OK: 67/);
  // prerušenie procesu (SIGKILL) počas verify: archív bez zmeny, žiadne nové súbory
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/p15-staging/p15-backup.ts"], {
    cwd: WT, env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ESBLU_P15B_MODE: "verify", ESBLU_P15_BACKUP_PASSPHRASE: PASS, ESBLU_P15B_DIR: arch }, stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 400));
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  assert.equal(snap(), before);
  assert.deepEqual(readdirSync(path.dirname(arch)), ["storage-backup-v"]);
});

console.log(`\np15-storage-backup-tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
