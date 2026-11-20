// =============================================================================
// Trezor súborov v2 — SKUTOČNÝ PostgreSQL (PGlite) s celou schémou Esblu a skutočnými Storage politikami
// + skutočný kód workera (lib/storage-vault/worker.ts) nad Storage simulátorom s bajtmi.
// Nikdy produkcia ani staging.   node --experimental-strip-types --no-warnings scripts/ops/storage-vault-pglite-tests.ts
// =============================================================================
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  drainVaultQueue, eraseVaultCopies, purgeVault, reconcileVault, restoreFromVault, supabaseVaultStorage,
  VAULT_BUCKET, VaultStorageError, type ClaimRow, type PlanRow, type ReconcileResult, type RecordOutcome, type VaultRpc, type VaultStorage,
} from "../../lib/storage-vault/worker.ts";
import { DELETION_PROTECTED_BUCKETS, parseStorageTargets } from "../../lib/account-deletion-storage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
type Db = { exec: (s: string) => Promise<unknown>; query: <T = Record<string, unknown>>(s: string, p?: unknown[]) => Promise<{ rows: T[]; affectedRows?: number }> };
let passed = 0, failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL ${label}\n       ${(e as Error).message.split("\n").slice(0, 5).join("\n       ")}`); }
}
const OVERRIDES: Array<[string, string]> = [
  ["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],
  ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"],
];
const { PGlite } = await import("@electric-sql/pglite");
const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
const db = new PGlite({ extensions: { pgcrypto } }) as unknown as Db;
await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
let files = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const [f, before] of OVERRIDES) { files = files.filter((x) => x !== f); files.splice(files.indexOf(before), 0, f); }
for (const f of files) await db.exec(read(`supabase/migrations/${f}`));

const policies = async () => (await db.query<{ p: string }>(
  "select schemaname||'.'||tablename||'.'||policyname||':'||permissive||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'') p from pg_policies order by 1")).rows.map((r) => r.p);
const policiesBefore = await policies();
const proposal = read("supabase/proposals/storage_vault_proposal.sql");
await db.exec(proposal);
await db.exec(proposal); // idempotentné

const BUCKETS = ["vehicle-photos", "machine-photos", "inventory-photos", "company-logos", "ai-inbox-documents", "ai-evidence-documents", "chat-attachments", "einvoice-documents", "billing-documents"];
const U = { a: "a0000000-0000-4000-8000-0000000000a1", b: "b0000000-0000-4000-8000-0000000000b1" };
const C = { a: "c0000000-0000-4000-8000-0000000000a1", b: "c0000000-0000-4000-8000-0000000000b1" };
await db.exec(`set session_replication_role = replica;
  insert into auth.users (id, email) values ('${U.a}', 'a@example.invalid'), ('${U.b}', 'b@example.invalid');
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.a}', 'A'), ('${C.b}', '${U.b}', 'B');
  set session_replication_role = origin;`);
for (const b of [...BUCKETS, VAULT_BUCKET]) await db.query("insert into storage.buckets (id, name, public) values ($1, $1, false) on conflict do nothing", [b]);

// ----------------------------------------------------------------------------- Storage simulátor (správanie storage-api)
const md5 = (b: Buffer) => crypto.createHash("md5").update(b).digest("hex");
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
class MemStorage implements VaultStorage {
  bytes = new Map<string, Buffer>();
  failNext = 0;
  corruptNext = 0;
  async upload(bucket: string, name: string, data: Buffer, owner: string) {
    this.bytes.set(`${bucket}/${name}`, data);
    await db.query(`insert into storage.objects (bucket_id, name, owner, version, metadata) values ($1, $2, $3, $4, $5)
      on conflict (bucket_id, name) do update set version = excluded.version, metadata = excluded.metadata, updated_at = now()`,
      [bucket, name, owner, crypto.randomUUID(), JSON.stringify({ size: data.length, eTag: `"${md5(data)}"` })]);
  }
  async copy(sb: string, sp: string, dbk: string, dp: string) {
    if (this.failNext > 0) { this.failNext--; throw new VaultStorageError("COPY_FAILED"); }
    const src = this.bytes.get(`${sb}/${sp}`);
    if (!src) throw new VaultStorageError("SOURCE_NOT_FOUND");
    if (this.bytes.has(`${dbk}/${dp}`)) throw new VaultStorageError("DUPLICATE");
    const data = this.corruptNext > 0 ? (this.corruptNext--, Buffer.concat([src, Buffer.from("x")])) : src;
    this.bytes.set(`${dbk}/${dp}`, data);
    await db.query("insert into storage.objects (bucket_id, name, owner, version, metadata) values ($1, $2, null, $3, $4)",
      [dbk, dp, crypto.randomUUID(), JSON.stringify({ size: data.length, eTag: `"${md5(data)}"` })]);
  }
  async remove(bucket: string, paths: string[]) {
    for (const p of paths) { this.bytes.delete(`${bucket}/${p}`); await db.query("delete from storage.objects where bucket_id=$1 and name=$2", [bucket, p]); }
  }
}
const store = new MemStorage();
// Worker smie mazať IBA v trezore (ako supabaseVaultStorage).
const vaultStore: VaultStorage = {
  copy: (a, b, c, d) => store.copy(a, b, c, d),
  remove: async (bucket, paths) => { if (bucket !== VAULT_BUCKET) throw new Error("ESBLU_VAULT_REMOVE_OUTSIDE_VAULT"); await store.remove(bucket, paths); },
};
async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("set role service_role");
  try { return (await db.query<T>(sql, params)).rows; } finally { await db.exec("reset role"); }
}
const rpc: VaultRpc = {
  claim: (o, l) => svc<ClaimRow>("select * from public.esblu_storage_vault_claim($1, $2)", [o, l]),
  record: async (q, o) => (await svc<{ r: RecordOutcome }>("select public.esblu_storage_vault_record($1, $2) r", [q, o]))[0].r,
  fail: async (q, o, c) => { await svc("select public.esblu_storage_vault_fail($1, $2, $3)", [q, o, c]); },
  reconcile: async () => (await svc<{ r: ReconcileResult }>("select public.esblu_storage_vault_reconcile() r"))[0].r,
  erase: (t, r) => svc("select * from public.esblu_storage_vault_erase($1::jsonb, $2)", [JSON.stringify(t), r]),
  purgeCandidates: (l) => svc("select * from public.esblu_storage_vault_purge_candidates($1)", [l]),
  markPurged: async (ids) => (await svc<{ n: number }>("select public.esblu_storage_vault_mark_purged($1::bigint[]) n", [ids]))[0].n,
  restorePlan: (b, p, s) => svc<PlanRow>("select * from public.esblu_storage_vault_restore_plan($1, $2, $3::timestamptz)", [b, p, s]),
};
const owner = () => crypto.randomUUID();
const count = async (sql: string, p: unknown[] = []) => (await db.query<{ n: number }>(`select count(*)::int n from (${sql}) s`, p)).rows[0].n;
async function asUser(uid: string | null, fn: () => Promise<void>) {
  await db.exec(`set role ${uid ? "authenticated" : "anon"}`);
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  try { await fn(); } finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claims', '', false)"); }
}
const original: Record<string, Buffer> = {};

// ============================================================================= 1. kópie po nahratí
await check("nahratie -> trigger -> fronta -> kópia: všetkých 9 súkromných bucketov, bajt po bajte; 2. beh nič neopakuje", async () => {
  for (const b of BUCKETS) for (const [co, uid] of [[C.a, U.a], [C.b, U.b]]) {
    const name = `${co}/${b}/subor.bin`; const data = crypto.randomBytes(1000 + Math.floor(Math.random() * 5000));
    original[`${b}/${name}`] = data; await store.upload(b, name, data, uid);
  }
  assert.equal(await count("select 1 from public.storage_vault_queue where done_at is null"), 18);
  const r = await drainVaultQueue(rpc, vaultStore, owner());
  assert.deepEqual([r.copied, r.failed], [18, 0]);
  assert.equal((await drainVaultQueue(rpc, vaultStore, owner())).claimed, 0);
  const rows = await db.query<{ source_bucket: string; source_name: string; vault_name: string }>("select source_bucket, source_name, vault_name from public.storage_vault_entries");
  for (const e of rows.rows) assert.equal(sha(store.bytes.get(`${VAULT_BUCKET}/${e.vault_name}`)!), sha(original[`${e.source_bucket}/${e.source_name}`]));
  assert.equal(rows.rows.length, 18);
});
await check("trigger nikdy neblokuje nahratie (pokazená fronta) a hodinová kontrola chýbajúcu kópiu doplní", async () => {
  await db.exec("alter table public.storage_vault_queue rename to storage_vault_queue_x");
  const data = crypto.randomBytes(777);
  await store.upload("vehicle-photos", `${C.a}/neskor.webp`, data, U.a); // upload prešiel
  await db.exec("alter table public.storage_vault_queue_x rename to storage_vault_queue");
  assert.equal(await count("select 1 from public.storage_vault_queue where source_name like '%neskor.webp'"), 0);
  const rec = await reconcileVault(rpc);
  assert.equal(rec.enqueued, 1);
  assert.equal((await drainVaultQueue(rpc, vaultStore, owner())).copied, 1);
  original[`vehicle-photos/${C.a}/neskor.webp`] = data;
});
await check("zlyhanie kopírovania: backoff a pokus sa uloží, po lehote opakovanie úspešné", async () => {
  await store.upload("machine-photos", `${C.a}/fail.webp`, crypto.randomBytes(500), U.a);
  store.failNext = 1;
  const r1 = await drainVaultQueue(rpc, vaultStore, owner());
  assert.equal(r1.failed, 1);
  const q = (await db.query<{ attempts: number; last_error: string; later: boolean }>("select attempts, last_error, next_attempt_at > now() later from public.storage_vault_queue where source_name like '%fail.webp'")).rows[0];
  assert.deepEqual(q, { attempts: 1, last_error: "COPY_FAILED", later: true });
  assert.equal((await drainVaultQueue(rpc, vaultStore, owner())).claimed, 0, "počas backoffu sa nespracuje");
  await db.exec("update public.storage_vault_queue set next_attempt_at = now() where done_at is null");
  assert.equal((await drainVaultQueue(rpc, vaultStore, owner())).copied, 1);
});
await check("prerušený beh (kópia hotová, zápis nie): ďalší beh kópiu overí a nezduplikuje", async () => {
  await store.upload("inventory-photos", `${C.a}/crash.webp`, crypto.randomBytes(300), U.a);
  const c = await rpc.claim(owner(), 10);
  await vaultStore.copy(c[0].bucket_id, c[0].name, VAULT_BUCKET, c[0].vault_name); // "pád" pred record
  await db.exec("update public.storage_vault_queue set lease_until = now() - interval '1 second' where done_at is null");
  const r = await drainVaultQueue(rpc, vaultStore, owner());
  assert.equal(r.copied, 1);
  assert.equal(await count("select 1 from storage.objects where bucket_id=$1 and name like '%crash.webp'", [VAULT_BUCKET]), 1);
});
await check("poškodená kópia (iná veľkosť/eTag): odmietnutá, zmazaná, opakovanie vytvorí správnu", async () => {
  await store.upload("company-logos", `${C.a}/logo2.webp`, crypto.randomBytes(400), U.a);
  store.corruptNext = 1;
  assert.equal((await drainVaultQueue(rpc, vaultStore, owner())).mismatch, 1);
  assert.equal(await count("select 1 from storage.objects where bucket_id=$1 and name like '%logo2.webp'", [VAULT_BUCKET]), 0);
  await db.exec("update public.storage_vault_queue set next_attempt_at = now() where done_at is null");
  assert.equal((await drainVaultQueue(rpc, vaultStore, owner())).copied, 1);
});
await check("súbor prepísaný pred kópiou: stará verzia 'stale' (zahodená), uloží sa iba skutočná nová verzia", async () => {
  const n = `${C.b}/race.webp`;
  await store.upload("vehicle-photos", n, Buffer.from("v1"), U.b);
  await store.upload("vehicle-photos", n, Buffer.from("v2-novsia"), U.b);
  const r = await drainVaultQueue(rpc, vaultStore, owner());
  assert.deepEqual([r.copied, r.stale], [1, 1]);
  const e = (await db.query<{ vault_name: string }>("select vault_name from public.storage_vault_entries where source_name=$1", [n])).rows;
  assert.equal(e.length, 1);
  assert.equal(store.bytes.get(`${VAULT_BUCKET}/${e[0].vault_name}`)!.toString(), "v2-novsia");
});
await check("prepísanie existujúceho súboru: stará kópia ostáva s lehotou 8 dní", async () => {
  const n = `${C.a}/vehicle-photos/subor.bin`;
  await store.upload("vehicle-photos", n, Buffer.from("prepisane"), U.a);
  await drainVaultQueue(rpc, vaultStore, owner());
  const r = (await db.query<{ v: number; days: number | null }>("select count(*)::int v, max(round(extract(epoch from (purge_after - superseded_at))/86400))::int days from public.storage_vault_entries where source_name=$1", [n])).rows[0];
  assert.deepEqual(r, { v: 2, days: 8 });
});

// ============================================================================= 2. izolácia
await check("izolácia: vlastník A, používateľ B ani anon nevidia, nevložia, nezmenia ani nezmažú kópiu", async () => {
  const total = await count("select 1 from storage.objects where bucket_id=$1", [VAULT_BUCKET]);
  for (const uid of [U.a, U.b, null]) {
    await asUser(uid, async () => {
      assert.equal(await count("select 1 from storage.objects where bucket_id='esblu-file-vault'"), 0);
      const u = await db.query("update storage.objects set name = name || '-x' where bucket_id='esblu-file-vault'");
      const d = await db.query("delete from storage.objects where bucket_id='esblu-file-vault'");
      assert.equal((u.affectedRows ?? 0) + (d.affectedRows ?? 0), 0);
    });
    await assert.rejects(asUser(uid, async () => { await db.query("insert into storage.objects (bucket_id, name) values ('esblu-file-vault', 'x/evil')"); }), /row-level security|permission denied/);
  }
  assert.equal(await count("select 1 from storage.objects where bucket_id=$1", [VAULT_BUCKET]), total);
});
await check("kontrola testu: RLS zapnuté a klientske roly MAJÚ grant na storage.objects (0 riadkov = RLS)", async () => {
  const r = (await db.query<{ rls: boolean; g: boolean }>("select c.relrowsecurity rls, has_table_privilege('authenticated','storage.objects','SELECT,INSERT,UPDATE,DELETE') g from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname='objects'")).rows[0];
  assert.deepEqual(r, { rls: true, g: true });
});
await check("izolácia: tabuľky trezora a všetkých 14 funkcií sú pre anon/authenticated nedostupné", async () => {
  for (const uid of [U.a, null]) {
    for (const t of ["storage_vault_entries", "storage_vault_queue", "storage_vault_guard"]) {
      await assert.rejects(asUser(uid, async () => { await db.query(`select * from public.${t}`); }), /permission denied/, t);
    }
  }
  const fns = (await db.query<{ f: string; anon: boolean; auth: boolean; svc: boolean }>(`select p.oid::regprocedure::text f,
    has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
    has_function_privilege('service_role', p.oid, 'EXECUTE') svc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'esblu_storage_vault%'`)).rows;
  assert.equal(fns.length, 14);
  assert.deepEqual(fns.filter((f) => f.anon || f.auth || !f.svc).map((f) => f.f), []);
});
await check("tenant izolácia: všetky existujúce politiky bajt po bajte rovnaké, žiadna politika pre trezor", async () => {
  assert.deepEqual(await policies(), policiesBefore);
});
await check("serverový kód: trezor je chránený pred cleanup jobmi a worker nevie mazať mimo trezora", async () => {
  assert.ok(DELETION_PROTECTED_BUCKETS.has(VAULT_BUCKET));
  assert.deepEqual(parseStorageTargets([{ bucket: VAULT_BUCKET, path: "x/y" }, { bucket: "vehicle-photos", path: "a/b" }]), [{ bucket: "vehicle-photos", path: "a/b" }]);
  const fake = { rpc: async () => ({ data: null, error: null }), storage: { from: () => ({ copy: async () => ({ error: null }), remove: async () => ({ error: null }) }) } };
  await assert.rejects(supabaseVaultStorage(fake).remove("vehicle-photos", ["a"]), /OUTSIDE_VAULT/);
});

// ============================================================================= 3. hromadné zmazanie, výmaz, obnova
await check("hromadné zmazanie (chyba úlohy / kompromitovaný účet): kópie ostávajú, purge sa pozastaví na 48 h", async () => {
  const victims = (await db.query<{ bucket_id: string; name: string }>(`select bucket_id, name from storage.objects where bucket_id <> $1 and name like '${C.b}/%'`, [VAULT_BUCKET])).rows;
  await store.remove("x", []); // no-op
  for (const v of victims) await store.remove(v.bucket_id, [v.name]);
  const rec = await reconcileVault(rpc);
  assert.equal(rec.mass_delete_pause, false, `${victims.length} < 20 -> bez pozastavenia`);
  // väčší incident: 25 ďalších súborov firmy A naraz
  for (let i = 0; i < 25; i++) await store.upload("ai-inbox-documents", `${C.a}/bulk/${i}.pdf`, crypto.randomBytes(200), U.a);
  await drainVaultQueue(rpc, vaultStore, owner(), 200);
  for (let i = 0; i < 25; i++) await store.remove("ai-inbox-documents", [`${C.a}/bulk/${i}.pdf`]);
  const rec2 = await reconcileVault(rpc);
  assert.equal(rec2.mass_delete_pause, true);
  await db.exec("update public.storage_vault_entries set purge_after = now() - interval '1 minute' where purge_after is not null");
  assert.equal((await purgeVault(rpc, vaultStore)).purged, 0, "počas pozastavenia sa bežné kópie nemažú");
});
await check("definitívny výmaz (ukončenie firmy A): kópie A zmazané hneď aj počas pozastavenia; B nedotknutá", async () => {
  const targetsA = (await db.query<{ bucket: string; path: string }>(`select bucket_id bucket, name path from storage.objects where bucket_id <> $1 and name like '${C.a}/%'`, [VAULT_BUCKET])).rows;
  const bBefore = await count(`select 1 from public.storage_vault_entries where purged_at is null and source_name like '${C.b}/%'`);
  for (const t of targetsA) await store.remove(t.bucket, [t.path]); // cleanup job: originály
  const r = await eraseVaultCopies(rpc, vaultStore, [...targetsA, ...Array.from({ length: 25 }, (_, i) => ({ bucket: "ai-inbox-documents", path: `${C.a}/bulk/${i}.pdf` }))], "COMPANY_TERMINATION");
  assert.ok(r.erased > 0);
  assert.equal(await count(`select 1 from public.storage_vault_entries where purged_at is null and erasure_requested_at is not null`), 0);
  assert.equal(await count(`select 1 from storage.objects where bucket_id=$1 and name like '%/${C.a}/%'`, [VAULT_BUCKET]), 0);
  assert.equal(await count(`select 1 from public.storage_vault_entries where purged_at is null and source_name like '${C.b}/%'`), bBefore);
});
await check("obnova: zmazané súbory firmy B späť na pôvodné cesty, bajt po bajte; existujúci súbor sa neprepíše", async () => {
  await db.exec("select 1"); // purge_after už je v minulosti, ale purge je pozastavený -> kópie B existujú
  let restored = 0;
  for (const b of BUCKETS) {
    const r = await restoreFromVault(rpc, vaultStore, b, `${C.b}/`, "2000-01-01T00:00:00Z");
    restored += r.restored;
    for (const n of r.restored_names) assert.equal(sha(store.bytes.get(n)!), sha(original[n] ?? store.bytes.get(n)!), n);
  }
  assert.ok(restored >= 9, `obnovených ${restored}`);
  for (const b of BUCKETS) assert.ok(store.bytes.has(`${b}/${C.b}/${b}/subor.bin`), b);
  for (const b of BUCKETS) assert.equal(sha(store.bytes.get(`${b}/${C.b}/${b}/subor.bin`)!), sha(original[`${b}/${C.b}/${b}/subor.bin`]));
  const again = await restoreFromVault(rpc, vaultStore, "vehicle-photos", `${C.b}/`, "2000-01-01T00:00:00Z");
  assert.equal(again.restored, 0, "už obnovené súbory sa neprepíšu");
  assert.ok(again.exists >= 1);
});
await check("po obnove: originály znova v DB metadátach (konzistencia), obnova sa znova zálohuje (trigger)", async () => {
  assert.equal(await count(`select 1 from storage.objects where bucket_id <> $1 and name like '${C.b}/%/subor.bin'`, [VAULT_BUCKET]), 9);
  assert.ok(await count("select 1 from public.storage_vault_queue where done_at is null") >= 9);
});
await check("purge po obnovení prevádzky: nikdy aktuálna verzia existujúceho súboru, limit na beh", async () => {
  await db.exec("select public.esblu_storage_vault_resume_purge()");
  const cand = await rpc.purgeCandidates(1000);
  const live = new Set((await db.query<{ k: string }>("select bucket_id||'/'||name||'@'||public.esblu_storage_vault_version(version, updated_at) k from storage.objects where bucket_id <> $1", [VAULT_BUCKET])).rows.map((r) => r.k));
  const ent = new Map((await db.query<{ id: number; k: string }>("select id, source_bucket||'/'||source_name||'@'||source_version k from public.storage_vault_entries")).rows.map((r) => [Number(r.id), r.k]));
  assert.ok(cand.length > 0);
  assert.ok(cand.every((c) => !live.has(ent.get(Number(c.id))!)));
  assert.equal((await rpc.purgeCandidates(3)).length, 3);
  const p = await purgeVault(rpc, vaultStore, 5);
  assert.equal(p.purged, 5);
});

console.log(`\nstorage-vault: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
