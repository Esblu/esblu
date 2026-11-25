// P1-5 skupina D — offline testy šifrovanej zálohy (bez siete).
//   node --experimental-strip-types --no-warnings scripts/p15-staging/storage-backup-tests.ts
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALLOWED_ORIGIN, Stop } from "./runner-core.ts";
import { backupGuardedFetch, buildBackup, readBackupDir, validateInventory, verifyBackup, writeBackupDir, type InventoryItem } from "./storage-backup.ts";

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`); }
}
const PASS = "correct horse battery staple 2026";
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
function fixture() {
  const items: InventoryItem[] = [];
  const bytes: Uint8Array[] = [];
  for (let i = 0; i < 67; i++) {
    const b = randomBytes(100 + i);
    const bucket = i < 63 ? "einvoice-documents" : i < 64 ? "ai-inbox-documents" : "billing-documents";
    const name = bucket === "billing-documents" ? `2026/inv-${i}.pdf` : `0c7d3a52-6f0e-4d8a-9a51-1f6f3f2b7e1${i % 3}/inbound/${i}.xml`;
    items.push({ bucket, name, id: `id-${i}`, size: b.byteLength, etag: md5(b), updated_at: "2026-11-01T00:00:00Z" });
    bytes.push(b);
  }
  return { items, fetched: items.map((item, i) => ({ item, bytes: bytes[i] })) };
}

await test("1 inventár: 67, iba 3 buckety, bez P15, bez '..', bez duplicít, eTag = MD5", () => {
  const { items } = fixture();
  validateInventory(items);
  for (const mut of [
    (x: InventoryItem[]) => x.pop(),
    (x: InventoryItem[]) => { x[0].bucket = "company-logos"; },
    (x: InventoryItem[]) => { x[0].name = "f1510000-0000-4000-8000-000000000003/inbound/a.xml"; },
    (x: InventoryItem[]) => { x[0].name = "a/../b"; },
    (x: InventoryItem[]) => { x[1] = { ...x[0] }; },
    (x: InventoryItem[]) => { x[0].etag = "abc-2"; },
  ]) { const c = structuredClone(items); mut(c); assert.throws(() => validateInventory(c), Stop); }
});
await test("2 záloha → zápis → verify: všetky objekty bajt po bajte, hlavička bez ciest", () => {
  const { items, fetched } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "p15b-")), "backup");
  writeBackupDir(dir, header, blobs);
  const h = readFileSync(path.join(dir, "header.json"), "utf8");
  assert.ok(!h.includes("inbound") && !h.includes("0c7d3a52") && !h.includes("inv-"), "hlavička nesmie obsahovať cesty");
  const r = readBackupDir(dir);
  const { manifest, content } = verifyBackup(r.header, r.readBlob, PASS);
  assert.equal(manifest.length, 67);
  fetched.forEach(({ item, bytes }) => assert.ok(Buffer.from(bytes).equals(content.get(`${item.bucket}|${item.name}`)!)));
  assert.equal(readdirSync(dir).length, 69);
  assert.throws(() => writeBackupDir(dir, header, blobs), Stop, "neprepisuje existujúci priečinok");
});
await test("3 zlé heslo, krátke heslo, zmenený bajt, vymenené bloby, zmenený manifest → STOP", () => {
  const { items, fetched } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  const rb = (m: Map<string, Buffer>) => (b: string) => m.get(b)!;
  assert.throws(() => verifyBackup(header, rb(blobs), PASS + "x"), Stop);
  assert.throws(() => buildBackup(fetched, items, "short"), Stop);
  const t1 = new Map(blobs); const x = Buffer.from(t1.get("obj-0005.bin")!); x[40] ^= 1; t1.set("obj-0005.bin", x);
  assert.throws(() => verifyBackup(header, rb(t1), PASS), Stop);
  const h2 = structuredClone(header); h2.blobs[4].sha256_cipher = createHash("sha256").update(x).digest("hex");
  assert.throws(() => verifyBackup(h2, rb(t1), PASS), Stop, "GCM odhalí zmenu aj pri prepočítanom hashi");
  const t2 = new Map(blobs); const a = t2.get("obj-0001.bin")!, b = t2.get("obj-0002.bin")!; t2.set("obj-0001.bin", b); t2.set("obj-0002.bin", a);
  const h3 = structuredClone(header); [h3.blobs[0].sha256_cipher, h3.blobs[1].sha256_cipher] = [h3.blobs[1].sha256_cipher, h3.blobs[0].sha256_cipher];
  assert.throws(() => verifyBackup(h3, rb(t2), PASS), Stop, "AAD viaže blob na jeho meno");
  const t3 = new Map(blobs); const mm = Buffer.from(t3.get("manifest.bin")!); mm[50] ^= 1; t3.set("manifest.bin", mm);
  assert.throws(() => verifyBackup(header, rb(t3), PASS), Stop);
});
await test("4 objekt sa zmenil počas zálohy (MD5 ≠ eTag / veľkosť) → STOP, nič sa nezapíše", () => {
  const { items, fetched } = fixture();
  const f2 = fetched.map((x) => ({ ...x }));
  f2[10] = { item: f2[10].item, bytes: randomBytes(f2[10].item.size) };
  assert.throws(() => buildBackup(f2, items, PASS), Stop);
  const f3 = fetched.map((x) => ({ ...x }));
  f3[3] = { item: f3[3].item, bytes: new Uint8Array(1) };
  assert.throws(() => buildBackup(f3, items, PASS), Stop);
});
await test("5 sieť zálohy: iba GET objektov z inventára; list/delete/upload/iný objekt/iný projekt → STOP", async () => {
  const { items } = fixture();
  let calls = 0;
  const f = backupGuardedFetch(items, (async () => { calls++; return new Response("x"); }) as typeof fetch);
  await f(`${ALLOWED_ORIGIN}/storage/v1/object/${items[0].bucket}/${items[0].name}`, { method: "GET" });
  for (const [u, m] of [
    [`${ALLOWED_ORIGIN}/storage/v1/object/${items[0].bucket}/${items[0].name}`, "DELETE"],
    [`${ALLOWED_ORIGIN}/storage/v1/object/${items[0].bucket}/${items[0].name}`, "POST"],
    [`${ALLOWED_ORIGIN}/storage/v1/object/list/${items[0].bucket}`, "POST"],
    [`${ALLOWED_ORIGIN}/storage/v1/object/einvoice-documents/f1510000-0000-4000-8000-000000000001/a.xml`, "GET"],
    [`${ALLOWED_ORIGIN}/rest/v1/companies`, "GET"],
    [`https://fkpgvgvsmbpieduoatrt.supabase.co/storage/v1/object/${items[0].bucket}/${items[0].name}`, "GET"],
  ] as const) await assert.rejects(() => f(u, { method: m }), Stop, `${m} ${u}`);
  assert.equal(calls, 1);
});
await test("6 OneDrive cieľ → STOP", () => {
  const { items, fetched } = fixture();
  const { header, blobs } = buildBackup(fetched, items, PASS);
  assert.throws(() => writeBackupDir(path.join(tmpdir(), "OneDrive", "x"), header, blobs), Stop);
});
void writeFileSync;
console.log(`\np15-storage-backup-tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
