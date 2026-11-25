// =============================================================================
// P1-5 skupina D, krok D-B — offline testy šifrovanej zálohy (iba syntetické bajty, bez siete, bez stagingu).
//   node --experimental-strip-types --no-warnings scripts/p15-staging/storage-backup-tests.ts
// Test 9 zapíše syntetický archív do dočasného priečinka a vypíše jeho cestu pre nezávislé overenie (Python).
// =============================================================================
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ALLOWED_ORIGIN, Stop } from "./runner-core.ts";
import {
  assertBackupTarget, backupGuardedFetch, buildBackup, readBackupDir, validateInventory, verifyBackup, writeBackupDir,
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

console.log(`\np15-storage-backup-tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
