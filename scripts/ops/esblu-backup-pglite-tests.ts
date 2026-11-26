// =============================================================================
// Záloha Esblu na SKUTOČNOM PostgreSQL (PGlite) s CELOU schémou z repo migrácií (2026-11-20).
//   role    — supabase/ops/esblu-backup-readonly-role.sql: SELECT všade (aj cez RLS), žiadny zápis,
//             žiadne SECURITY DEFINER funkcie, žiadne CREATE — aj po vypnutí default_transaction_read_only
//   restore — syntetické dáta -> denná záloha (skutočný kód + šifrovanie) -> obnova do NOVEJ databázy
//             (schéma z migrácií + restore-public-data.sql) -> zhoda každej tabuľky (MD5 riadkov), sekvencie,
//             súbory Storage (SHA-256) a väzby DB <-> Storage
// Nikdy produkcia ani staging.   node --experimental-strip-types --no-warnings scripts/ops/esblu-backup-pglite-tests.ts
// =============================================================================
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error - .mjs modul bez typov
import * as B from "./esblu-daily-backup.mjs";
import { freshDb as verifyFreshDb, verifyRestore, FP_SQL, type Inventory } from "./esblu-restore-verify.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
type Db = { exec: (sql: string) => Promise<unknown>; query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>; close: () => Promise<void> };

let passed = 0, failed = 0;
async function check(label: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL ${label}\n       ${(e as Error).message.split("\n").slice(0, 6).join("\n       ")}`); }
}

// Rovnaké poradie replayu ako scripts/grants-replay-pglite-tests.ts (2 historické výnimky).
const OVERRIDES: Array<[string, string]> = [
  ["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],
  ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"],
];
function replayOrder(files: string[]) {
  let out = [...files].sort();
  for (const [f, before] of OVERRIDES) { out = out.filter((x) => x !== f); out.splice(out.indexOf(before), 0, f); }
  return out;
}
async function freshDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const db = new PGlite({ extensions: { pgcrypto } }) as unknown as Db;
  await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
  await db.exec("create table if not exists auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), provider text, identity_data jsonb)");
  for (const f of replayOrder(fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(".sql")))) {
    await db.exec(read(`supabase/migrations/${f}`));
  }
  return db;
}
const publicTables = async (db: Db) =>
  (await db.query<{ t: string }>("select c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by 1")).rows.map((r) => r.t);
const tableHash = async (db: Db, t: string) =>
  (await db.query<{ n: number; h: string }>(`select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from (select row_to_json(r) x from public.${t} r) s`)).rows[0];

console.log("PGlite: platform stub + všetky migrácie (zdroj)…");
const A = await freshDb();

// ============================================================================= ROLE
const roleSql = read("supabase/ops/esblu-backup-readonly-role.sql");
await A.exec(roleSql);
await A.exec(roleSql); // idempotentné
const tablesA = await publicTables(A);

await check("role: SELECT na každej public tabuľke aj cez RLS (bypassrls), storage + auth metadáta", async () => {
  await A.exec("set role esblu_backup");
  try {
    for (const t of tablesA) await A.query(`select count(*) from public.${t}`);
    for (const t of ["storage.objects", "storage.buckets", "auth.users", "auth.identities"]) await A.query(`select count(*) from ${t}`);
  } finally { await A.exec("reset role"); }
  assert.ok(tablesA.length >= 100, `tabuliek ${tablesA.length}`);
});

await check("role: INSERT/UPDATE/DELETE/TRUNCATE odmietnuté (42501) na KAŽDEJ tabuľke aj po vypnutí read-only režimu", async () => {
  const allowed: string[] = [];
  const targets = [...tablesA.map((t) => `public.${t}`), "storage.objects", "storage.buckets", "auth.users", "auth.identities"];
  for (const t of targets) {
    for (const stmt of [`insert into ${t} default values`, `update ${t} set ctid = ctid where false`, `delete from ${t} where false`, `truncate ${t}`]) {
      const sql = stmt.startsWith("update") ? `update ${t} set ${(await firstCol(t))} = ${(await firstCol(t))} where false` : stmt;
      try {
        await A.exec(`begin; set local role esblu_backup; set local default_transaction_read_only = off; set local transaction_read_only = off; ${sql}; rollback;`);
        allowed.push(`${t}: ${sql.split(" ")[0]}`);
      } catch (e) {
        await A.exec("rollback").catch(() => {});
        const msg = (e as Error).message;
        if (!/permission denied|must be owner/i.test(msg)) allowed.push(`${t}: ${sql.split(" ")[0]} -> iná chyba: ${msg.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(allowed, []);
});
async function firstCol(t: string) {
  const [s, n] = t.split(".");
  return (await A.query<{ a: string }>("select quote_ident(attname) a from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname=$1 and c.relname=$2 and attnum>0 and not attisdropped and attgenerated='' order by attnum limit 1", [s, n])).rows[0].a;
}

await check("role: žiadna SECURITY DEFINER funkcia, žiadne CREATE, žiadne členstvo v inej role, nie superuser", async () => {
  const r = (await A.query<Record<string, unknown>>(`select
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname not in ('pg_catalog','information_schema') and has_function_privilege('esblu_backup', p.oid, 'EXECUTE')) secdef,
    (select count(*)::int from pg_namespace n where has_schema_privilege('esblu_backup', n.oid, 'CREATE')) creat,
    (select count(*)::int from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='esblu_backup') member,
    (select rolsuper or rolcreaterole or rolcreatedb or rolreplication from pg_roles where rolname='esblu_backup') power,
    (select rolbypassrls from pg_roles where rolname='esblu_backup') bypass`)).rows[0];
  assert.deepEqual(r, { secdef: 0, creat: 0, member: 0, power: false, bypass: true });
  // pokus zavolať zapisujúcu RPC a vytvoriť tabuľku
  await assert.rejects(A.exec("begin; set local role esblu_backup; create table public.x(i int); rollback;"), /permission denied/);
  await A.exec("rollback").catch(() => {});
  // PGlite beží pod superuserom (SET ROLE overuje session_user), preto sa členstvo overí katalógom:
  const m = (await A.query<{ n: number }>("select count(*)::int n from pg_roles r where r.rolname <> 'esblu_backup' and pg_has_role('esblu_backup', r.oid, 'MEMBER')")).rows[0].n;
  assert.equal(m, 0, "esblu_backup je členom inej roly (mohol by prepnúť na service_role)");
});

await check("role: nová tabuľka z budúcej migrácie je čitateľná automaticky (default privileges), nie zapisovateľná", async () => {
  // default privileges platia pre rolu postgres (Supabase); v PGlite je migrácia tiež pod postgres
  const who = (await A.query<{ u: string }>("select current_user u")).rows[0].u;
  if (who !== "postgres") return; // v inom prostredí nie je čo overiť
  await A.exec("create table public.zz_future(i int)");
  const p = (await A.query<{ s: boolean; i: boolean }>("select has_table_privilege('esblu_backup','public.zz_future','SELECT') s, has_table_privilege('esblu_backup','public.zz_future','INSERT') i")).rows[0];
  await A.exec("drop table public.zz_future");
  assert.deepEqual(p, { s: true, i: false });
});

// ============================================================================= SYNTETICKÉ DÁTA
const U = { a: "a0000000-0000-4000-8000-000000000001", b: "a0000000-0000-4000-8000-000000000002" };
const C = { a: "c0000000-0000-4000-8000-000000000001", b: "c0000000-0000-4000-8000-000000000002" };
const files: Record<string, Buffer> = {};
async function seed(db: Db) {
  // Syntetické dáta bez obchodných triggerov (limity plánu, onboarding) - testuje sa záloha/obnova, nie onboarding.
  await db.exec("set session_replication_role = replica");
  await db.exec(`
    insert into auth.users (id, email) values ('${U.a}', 'owner-a@example.invalid'), ('${U.b}', 'owner-b@example.invalid');
    insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.a}', 'Syntetická A s.r.o.'), ('${C.b}', '${U.b}', 'Syntetická B s.r.o.');
  `);
  // Členstvá, vozidlá, stroje, sklad: iba stĺpce, ktoré schéma vyžaduje (zistené z katalógu).
  await insertMinimal(db, "company_members", { company_id: C.a, user_id: U.a, role: "owner", status: "active" });
  await insertMinimal(db, "company_members", { company_id: C.b, user_id: U.b, role: "owner", status: "active" });
  for (let i = 0; i < 1500; i++) await insertMinimal(db, "vehicles", { company_id: i % 2 ? C.a : C.b, spz: `BA${String(i).padStart(3, "0")}XY` });
  await insertMinimal(db, "machines", { company_id: C.a, name: "Bager s diakritikou ľščťžýáíé" });
  await insertMinimal(db, "inventory_items", { company_id: C.a, name: "Lopata \"úvodzovky\" a 'apostrof' $$ \\ backslash" });
  const veh = (await db.query<{ id: string }>(`select id::text from public.vehicles where company_id='${C.a}' limit 1`)).rows[0].id;
  for (const [bucket, name, bytes] of [
    ["vehicle-photos", `${C.a}/${veh}/foto-1.webp`, crypto.randomBytes(70000)],
    ["company-logos", `${U.a}/logo.webp`, crypto.randomBytes(3000)],
    ["ai-inbox-documents", `${C.a}/inbox/faktura.pdf`, crypto.randomBytes(12000)],
  ] as Array<[string, string, Buffer]>) {
    files[`${bucket}/${name}`] = bytes;
    await db.query("insert into storage.buckets (id, name, public) values ($1, $1, false) on conflict do nothing", [bucket]).catch(async () => {
      await db.query("insert into storage.buckets (id, public) values ($1, false) on conflict do nothing", [bucket]);
    });
    await db.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, U.a]);
  }
  await db.exec("set session_replication_role = origin");
}
async function insertMinimal(db: Db, t: string, vals: Record<string, unknown>) {
  const cols = (await db.query<{ a: string; typ: string }>(
    `select attname a, format_type(atttypid, atttypmod) typ from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=$1 and attnum>0 and not attisdropped and attnotnull and attgenerated='' and not atthasdef and attidentity=''`, [t])).rows;
  const v: Record<string, unknown> = { ...vals };
  for (const c of cols) if (!(c.a in v)) v[c.a] = c.typ === "uuid" ? crypto.randomUUID() : /int|numeric/.test(c.typ) ? 0 : /bool/.test(c.typ) ? false : /json/.test(c.typ) ? {} : /timestamp|date/.test(c.typ) ? new Date().toISOString() : "x";
  const keys = Object.keys(v);
  await db.query(`insert into public.${t} (${keys.map((k) => `"${k}"`).join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`, keys.map((k) => (typeof v[k] === "object" && v[k] !== null ? JSON.stringify(v[k]) : v[k])));
}

let seedError: string | null = null;
try { await seed(A); } catch (e) { seedError = (e as Error).message; }
await check("syntetické dáta: auth, firmy, členstvá, 1500 vozidiel, stroj, sklad, 3 súbory Storage", () => { assert.equal(seedError, null, seedError ?? ""); });

// ============================================================================= MOCK SUPABASE NAD DB A (iba čítanie)
const KEY = "test_only_mock_key";
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (req.headers.apikey !== KEY) { res.writeHead(401); res.end(); return; }
  let body = ""; for await (const c of req) body += c;
  try {
    if (u.pathname === "/rest/v1/") { res.writeHead(200); res.end(JSON.stringify({ definitions: Object.fromEntries(tablesA.map((t) => [t, {}])) })); return; }
    const tm = u.pathname.match(/^\/rest\/v1\/([a-z0-9_]+)$/);
    if (tm && tablesA.includes(tm[1])) {
      const [from, to] = String(req.headers.range ?? "0-999").split("-").map(Number);
      const total = (await A.query<{ n: number }>(`select count(*)::int n from public.${tm[1]}`)).rows[0].n;
      const rows = (await A.query<{ j: unknown }>(`select row_to_json(r) j from public.${tm[1]} r order by row_to_json(r)::text limit ${to - from + 1} offset ${from}`)).rows.map((r) => r.j);
      res.writeHead(206, { "content-range": `${from}-${from + rows.length - 1}/${total}` }); res.end(JSON.stringify(rows)); return;
    }
    if (u.pathname === "/auth/v1/admin/users") {
      const users = Number(u.searchParams.get("page")) === 1 ? (await A.query("select id, email from auth.users order by id")).rows : [];
      res.writeHead(200); res.end(JSON.stringify({ users })); return;
    }
    if (u.pathname === "/storage/v1/bucket") { res.writeHead(200); res.end(JSON.stringify((await A.query("select id from storage.buckets order by id")).rows)); return; }
    const lm = u.pathname.match(/^\/storage\/v1\/object\/list\/(.+)$/);
    if (lm) {
      const bucket = decodeURIComponent(lm[1]); const prefix = JSON.parse(body || "{}").prefix || "";
      const pre = prefix ? `${prefix}/` : "";
      const names = (await A.query<{ name: string }>("select name from storage.objects where bucket_id=$1 and name like $2 order by name", [bucket, `${pre}%`])).rows.map((r) => r.name);
      const items = new Map<string, unknown>();
      for (const n of names) {
        const [first, ...more] = n.slice(pre.length).split("/");
        const f = files[`${bucket}/${n}`];
        items.set(first, more.length ? { name: first, id: null } : { name: first, id: "x", metadata: { size: f.length, eTag: `"${crypto.createHash("md5").update(f).digest("hex")}"` } });
      }
      res.writeHead(200); res.end(JSON.stringify([...items.values()])); return;
    }
    const om = u.pathname.match(/^\/storage\/v1\/object\/authenticated\/(.+)$/);
    if (om) { const k = om[1].split("/").map(decodeURIComponent).join("/"); res.writeHead(files[k] ? 200 : 404); res.end(files[k]); return; }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end((e as Error).message); }
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "esblu-restore-"));
const PASS = "syntetické heslo zálohy 2026 !!";
const keys = B.initKeys(path.join(tmp, "keys"), PASS);
let restoreDir = "";
let bundle: { tables: Record<string, { count: number }>; objects: Array<{ bucket: string; name: string; sha256: string }> } | null = null;
await check("záloha: skutočný kód + šifrovanie verejným kľúčom nad DB A (súkromný kľúč pri behu NEDOSTUPNÝ)", async () => {
  // súkromný kľúč počas zálohy fyzicky odsunutý - beh ho nesmie potrebovať
  const hidden = path.join(tmp, "offline-private.pem");
  fs.renameSync(keys.priv, hidden);
  const r = await B.runBackup({ ESBLU_TEST_BASE_URL: base, ESBLU_BACKUP_SUPABASE_KEY: KEY, ESBLU_BACKUP_PUBLIC_KEY: keys.pub,
    ESBLU_BACKUP_PUBKEY_SHA256: keys.fingerprint, ESBLU_BACKUP_DIR: path.join(tmp, "out") }, () => {});
  fs.renameSync(hidden, keys.priv);
  const opened = B.openBackup(r.file, fs.readFileSync(keys.priv, "utf8"), PASS);
  bundle = opened.bundle;
  restoreDir = path.join(tmp, "restore");
  B.extractBundle(opened.bundle, restoreDir);
  fs.writeFileSync(path.join(restoreDir, "restore-public-data.sql"), B.buildRestoreSql(opened.bundle));
  assert.equal(r.summary.storage_objects, 3);
});

console.log("PGlite: nová prázdna databáza (schéma z migrácií) pre obnovu…");
const Bdb = await freshDb();
await check("obnova: auth (Admin API ekvivalent) + restore-public-data.sql v jednej transakcii, kontrola počtov v SQL", async () => {
  assert.ok(bundle);
  const users = JSON.parse(fs.readFileSync(path.join(restoreDir, "auth_users.json"), "utf8")) as Array<{ id: string; email: string }>;
  for (const u of users) await Bdb.query("insert into auth.users (id, email) values ($1, $2)", [u.id, u.email]);
  await Bdb.exec(fs.readFileSync(path.join(restoreDir, "restore-public-data.sql"), "utf8"));
});
await check("konzistencia: KAŽDÁ public tabuľka zhodná (počet + MD5 všetkých riadkov); vylúčené tabuľky prázdne", async () => {
  const diff: string[] = [];
  for (const t of tablesA) {
    const a = await tableHash(A, t); const b = await tableHash(Bdb, t);
    const excluded = t in B.EXCLUDED_TABLES || t in B.COUNT_ONLY_TABLES;
    if (excluded) { if (b.n !== 0) diff.push(`${t}: vylúčená, ale obnovená`); continue; }
    if (a.n !== b.n || a.h !== b.h) diff.push(`${t}: ${a.n}/${b.n}`);
  }
  assert.deepEqual(diff, []);
  assert.equal((await tableHash(Bdb, "vehicles")).n, 1500);
});
await check("konzistencia: diakritika, úvodzovky, $$ a spätné lomky v dátach obnovené bit po bite", async () => {
  const r = (await Bdb.query<{ name: string }>("select name from public.inventory_items")).rows[0];
  assert.equal(r.name, "Lopata \"úvodzovky\" a 'apostrof' $$ \\ backslash");
});
await check("sekvencie/identity po obnove pokračujú za maximom (nová položka nekoliduje)", async () => {
  const seqs = (await Bdb.query<{ seq: string; tbl: string; col: string }>(`select s.oid::regclass::text seq, c.oid::regclass::text tbl, a.attname col from pg_class s join pg_depend d on d.objid=s.oid and d.deptype in ('a','i')
    join pg_class c on c.oid=d.refobjid join pg_attribute a on a.attrelid=c.oid and a.attnum=d.refobjsubid join pg_namespace n on n.oid=c.relnamespace where s.relkind='S' and n.nspname='public'`)).rows;
  for (const s of seqs) {
    const m = (await Bdb.query<{ m: string | null; l: string; called: boolean }>(`select (select max(${s.col})::text from ${s.tbl}) m, last_value::text l, is_called called from ${s.seq}`)).rows[0];
    if (m.m !== null) assert.ok(BigInt(m.l) >= BigInt(m.m) && m.called, `${s.seq}: ${m.l} < ${m.m}`);
  }
});
await check("Storage: každý súbor z DB A (storage.objects) je v zálohe a obnovený bajt po bajte (SHA-256)", async () => {
  const objs = (await A.query<{ k: string }>("select bucket_id || '/' || name k from storage.objects order by 1")).rows.map((r) => r.k);
  for (const k of objs) {
    const restored = fs.readFileSync(path.join(restoreDir, "storage", ...k.split("/")));
    assert.ok(restored.equals(files[k]), k);
  }
  assert.equal(objs.length, 3);
});
await check("väzby DB <-> Storage: fotka vozidla v obnovenej DB ukazuje na existujúce vozidlo aj súbor", async () => {
  const k = Object.keys(files).find((x) => x.startsWith("vehicle-photos/"))!;
  const vehId = k.split("/")[2];
  const v = (await Bdb.query<{ n: number }>("select count(*)::int n from public.vehicles where id::text=$1", [vehId])).rows[0].n;
  assert.equal(v, 1);
  assert.ok(fs.existsSync(path.join(restoreDir, "storage", ...k.split("/"))));
});
await check("obnova zlyhá celá (rollback), ak počet obnovených riadkov nesedí", async () => {
  const C2 = await freshDb();
  const bad = fs.readFileSync(path.join(restoreDir, "restore-public-data.sql"), "utf8").replace(/insert into esblu_restore_check values \('vehicles', 1500,/, "insert into esblu_restore_check values ('vehicles', 1501,");
  for (const u of JSON.parse(fs.readFileSync(path.join(restoreDir, "auth_users.json"), "utf8")) as Array<{ id: string; email: string }>) await C2.query("insert into auth.users (id, email) values ($1, $2)", [u.id, u.email]);
  await assert.rejects(C2.exec(bad), /OBNOVA ZLYHALA/);
  await C2.exec("rollback"); // psql -v ON_ERROR_STOP=1 / SQL Editor: zlyhaná transakcia sa celá zruší
  assert.equal((await C2.query<{ n: number }>("select count(*)::int n from public.companies")).rows[0].n, 0, "nič sa nesmie čiastočne zapísať");
  await C2.close();
});
await check("esblu-restore-verify: izolovaná obnova vs. inventúra zdroja (rovnaký odtlačok ako produkčná inventúra) → OK; zmenená inventúra → FAIL", async () => {
  const inv: Inventory = { tables: {}, auth_users: 0, storage: {}, excluded_from_backup: [...Object.keys(B.EXCLUDED_TABLES), ...Object.keys(B.COUNT_ONLY_TABLES)] };
  for (const t of tablesA) { const r = (await A.query<{ n: number; h: string }>(FP_SQL(t))).rows[0]; inv.tables[t] = { rows: r.n, fp: r.h }; }
  inv.auth_users = JSON.parse(fs.readFileSync(path.join(restoreDir, "auth_users.json"), "utf8")).length;
  for (const [k, buf] of Object.entries(files)) { const b = k.split("/")[0]; inv.storage[b] ??= { objects: 0, bytes: 0 }; inv.storage[b].objects++; inv.storage[b].bytes += buf.length; }
  const v1 = await verifyFreshDb("99999999999999");
  const ok = await verifyRestore(v1, restoreDir, inv);
  await v1.close();
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.fpMatch > 0, "aspoň časť tabuliek má zhodný odtlačok");
  const bad: Inventory = JSON.parse(JSON.stringify(inv));
  bad.tables.vehicles.rows += 1; bad.auth_users += 1; const b0 = Object.keys(bad.storage)[0]; bad.storage[b0].bytes += 1;
  const v2 = await verifyFreshDb("99999999999999");
  const ko = await verifyRestore(v2, restoreDir, bad);
  await v2.close();
  assert.equal(ko.errors.length, 3, ko.errors.join("; "));
});
await check("schéma: obnovená DB má rovnaké RLS politiky, funkcie a triggery ako zdroj (z migrácií)", async () => {
  const q = "select (select count(*)::int from pg_policies where schemaname='public') p, (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') f, (select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal) tr";
  const a = (await A.query(q)).rows[0]; const b = (await Bdb.query(q)).rows[0];
  assert.deepEqual(b, a);
});

srv.close();
await A.close(); await Bdb.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nesblu-backup-pglite: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
