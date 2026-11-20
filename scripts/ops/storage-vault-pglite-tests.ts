// =============================================================================
// Trezor súborov (supabase/proposals/storage_vault_proposal.sql) na SKUTOČNOM PostgreSQL (PGlite)
// s celou schémou Esblu z migrácií + skutočnými Storage politikami. Nikdy produkcia ani staging.
//   izolácia — anon / authenticated (vlastník aj iná firma) kópie nevidia, nevložia, nezmenia, nezmažú;
//              evidencia a RPC iba service_role; existujúce politiky nezmenené (žiadne rozšírenie prístupu)
//   logika   — kópia novej verzie, prepísanie, zmazanie -> lehota 8 dní, purge iba po lehote,
//              nikdy aktuálna verzia existujúceho súboru, limit na jeden beh
//   node --experimental-strip-types --no-warnings scripts/ops/storage-vault-pglite-tests.ts
// =============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const before = await policies();
const proposal = read("supabase/proposals/storage_vault_proposal.sql");
await db.exec(proposal);
await db.exec(proposal); // idempotentné

const U = { a: "a0000000-0000-4000-8000-0000000000a1", b: "b0000000-0000-4000-8000-0000000000b1" };
const C = { a: "c0000000-0000-4000-8000-0000000000a1", b: "c0000000-0000-4000-8000-0000000000b1" };
await db.exec(`
  set session_replication_role = replica;
  insert into auth.users (id, email) values ('${U.a}', 'a@example.invalid'), ('${U.b}', 'b@example.invalid');
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.a}', 'A'), ('${C.b}', '${U.b}', 'B');
  insert into storage.buckets (id, name, public) values ('company-logos','company-logos',false) on conflict do nothing;
  insert into storage.objects (bucket_id, name, owner, version, metadata) values
    ('company-logos', '${U.a}/logo.webp', '${U.a}', 'v1', '{"size": 100}'),
    ('company-logos', '${U.b}/logo.webp', '${U.b}', 'v1', '{"size": 200}');
  set session_replication_role = origin;
`);

// Simulácia cron behu (service_role): pending -> „Storage copy“ (riadok v esblu-file-vault) -> record.
async function cronCopy() {
  await db.exec("set role service_role");
  try {
    const p = (await db.query<{ bucket_id: string; name: string; object_id: string; version: string; size_bytes: number; vault_name: string }>("select * from public.esblu_storage_vault_pending(100)")).rows;
    for (const r of p) {
      await db.exec("reset role");
      await db.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('esblu-file-vault', $1, null, $2)", [r.vault_name, JSON.stringify({ size: r.size_bytes })]);
      await db.exec("set role service_role");
      await db.query("select public.esblu_storage_vault_record($1,$2,$3,$4,$5,$6)", [r.bucket_id, r.name, r.object_id, r.version, r.vault_name, r.size_bytes]);
    }
    return p.length;
  } finally { await db.exec("reset role"); }
}
async function asUser(uid: string | null, fn: () => Promise<void>) {
  const claims = uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : JSON.stringify({ role: "anon" });
  await db.exec(`set role ${uid ? "authenticated" : "anon"}`);
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  try { await fn(); } finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claims', '', false)"); }
}

await check("kópia: oba súbory skopírované do esblu-file-vault, evidencia zapísaná, druhý beh nič neopakuje", async () => {
  assert.equal(await cronCopy(), 2);
  assert.equal(await cronCopy(), 0);
  const n = (await db.query<{ n: number }>("select count(*)::int n from storage.objects where bucket_id='esblu-file-vault'")).rows[0].n;
  assert.equal(n, 2);
});

await check("kontrola testu: RLS na storage.objects je zapnuté a klientske roly MAJÚ tabuľkové oprávnenia (0 riadkov = RLS, nie chýbajúci grant)", async () => {
  const r = (await db.query<{ rls: boolean; a: boolean; n: boolean }>(`select c.relrowsecurity rls,
    has_table_privilege('authenticated','storage.objects','SELECT,INSERT,UPDATE,DELETE') a, has_table_privilege('anon','storage.objects','SELECT') n
    from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='storage' and c.relname='objects'`)).rows[0];
  assert.deepEqual(r, { rls: true, a: true, n: true });
});
await check("izolácia: vlastník firmy A, používateľ firmy B ani anon NEVIDIA žiadnu kópiu (0 riadkov)", async () => {
  for (const uid of [U.a, U.b, null]) {
    await asUser(uid, async () => {
      const n = (await db.query<{ n: number }>("select count(*)::int n from storage.objects where bucket_id='esblu-file-vault'")).rows[0].n;
      assert.equal(n, 0, `uid ${uid}`);
    });
  }
});
await check("izolácia: INSERT do trezora odmietnutý (RLS) pre authenticated aj anon", async () => {
  for (const uid of [U.a, null]) {
    await assert.rejects(asUser(uid, async () => {
      await db.query("insert into storage.objects (bucket_id, name, owner) values ('esblu-file-vault', $1, $2)", [`company-logos/x/${U.a}/evil.webp`, uid]);
    }), /row-level security|permission denied/);
  }
});
await check("izolácia: UPDATE a DELETE kópií nezasiahnu žiadny riadok (vlastník A aj B)", async () => {
  for (const uid of [U.a, U.b]) {
    await asUser(uid, async () => {
      const u = await db.query("update storage.objects set name = name || '-x' where bucket_id='esblu-file-vault'");
      const d = await db.query("delete from storage.objects where bucket_id='esblu-file-vault'");
      assert.equal((u.affectedRows ?? 0) + (d.affectedRows ?? 0), 0);
    });
  }
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from storage.objects where bucket_id='esblu-file-vault'")).rows[0].n, 2);
});
await check("izolácia: evidencia storage_vault_entries a všetky vault RPC sú pre anon/authenticated nedostupné", async () => {
  for (const uid of [U.a, null]) {
    await assert.rejects(asUser(uid, async () => { await db.query("select * from public.storage_vault_entries"); }), /permission denied/);
    for (const fn of ["esblu_storage_vault_pending(10)", "esblu_storage_vault_mark_deleted()", "esblu_storage_vault_purge_candidates(10)", "esblu_storage_vault_mark_purged(array[1]::bigint[])"]) {
      await assert.rejects(asUser(uid, async () => { await db.query(`select * from public.${fn}`); }), /permission denied/, fn);
    }
  }
});
await check("tenant izolácia: existujúce politiky sú presne rovnaké (návrh nepridal ani nezmenil žiadnu)", async () => {
  assert.deepEqual(await policies(), before);
  const vaultPolicies = (await db.query<{ n: number }>("select count(*)::int n from pg_policies where coalesce(qual,'')||coalesce(with_check,'') like '%esblu-file-vault%'")).rows[0].n;
  assert.equal(vaultPolicies, 0);
});
await check("prepísanie: nová verzia sa skopíruje, stará kópia ostáva a dostane lehotu 8 dní", async () => {
  await db.exec(`update storage.objects set version='v2', updated_at=now() where bucket_id='company-logos' and name='${U.a}/logo.webp'`);
  assert.equal(await cronCopy(), 1);
  const r = (await db.query<{ v: string; purge: boolean; days: number }>(`select source_version v, purge_after is not null purge,
    round(extract(epoch from (purge_after - superseded_at))/86400)::int days from public.storage_vault_entries where source_name='${U.a}/logo.webp' order by v`)).rows;
  assert.deepEqual(r.map((x) => [x.v, x.purge]), [["v1", true], ["v2", false]]);
  assert.equal(r[0].days, 8);
});
await check("zmazanie originálu (aj hromadné): kópia ostáva, iba sa spustí lehota 8 dní; purge pred lehotou nič nevráti", async () => {
  await db.exec(`delete from storage.objects where bucket_id='company-logos'`); // napr. omyl / kompromitovaný účet / chyba aplikácie
  await db.exec("set role service_role");
  const marked = (await db.query<{ n: number }>("select public.esblu_storage_vault_mark_deleted() n")).rows[0].n;
  const cand = (await db.query("select * from public.esblu_storage_vault_purge_candidates(100)")).rows.length;
  await db.exec("reset role");
  assert.equal(marked, 3, "všetky 3 kópie (vrátane staršej verzie A) zmazaných súborov");
  assert.equal(cand, 0);
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from storage.objects where bucket_id='esblu-file-vault'")).rows[0].n, 3);
});
await check("obnova: všetky verzie zmazaných súborov sú v trezore dohľadateľné (bucket, cesta, verzia)", async () => {
  const r = (await db.query<{ k: string }>("select source_bucket||'/'||source_name||'@'||source_version k from public.storage_vault_entries where purged_at is null order by 1")).rows.map((x) => x.k);
  assert.deepEqual(r, [`company-logos/${U.a}/logo.webp@v1`, `company-logos/${U.a}/logo.webp@v2`, `company-logos/${U.b}/logo.webp@v1`]);
});
await check("purge: až po lehote, nikdy aktuálna verzia existujúceho súboru, najviac p_limit naraz", async () => {
  await db.exec(`insert into storage.objects (bucket_id, name, owner, version, metadata) values ('company-logos', '${U.b}/logo.webp', '${U.b}', 'v1', '{"size": 200}')`); // obnovený originál
  await db.exec("update public.storage_vault_entries set purge_after = now() - interval '1 minute'");
  await db.exec("set role service_role");
  const all = (await db.query<{ vault_name: string }>("select * from public.esblu_storage_vault_purge_candidates(100)")).rows.map((x) => x.vault_name);
  const one = (await db.query("select * from public.esblu_storage_vault_purge_candidates(1)")).rows.length;
  await db.exec("reset role");
  assert.equal(all.length, 2, "iba 2 kópie (aktuálna verzia obnoveného súboru B sa nemaže)");
  assert.ok(!all.some((v) => v.includes(U.b)));
  assert.equal(one, 1);
});

console.log(`\nstorage-vault: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
