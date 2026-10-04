// =============================================================================
// Médiá firmy (vehicle-/machine-/inventory-photos, company-logos) — SKUTOČNÝ
// PostgreSQL test (PGlite) pre
//   supabase/migrations/20261005090000_media_storage_access_model.sql
//   supabase/migrations/20261005091000_private_media_buckets.sql
// a rollbacky v supabase/rollback/ (20261005090000_*, 20261005091000_*).
//
// Schéma: prod stĺpce (overené 2026-10-04), prod pomocné funkcie a VŠETKÝCH 15
// PRED-migračných storage politík týchto bucketov doslovne z prod.
// Supabase Storage sa modeluje tak, ako reálne funguje:
//   - verejný endpoint vydá súbor bez RLS iff storage.buckets.public = true,
//   - createSignedUrl / download = SELECT cez RLS ako caller,
//   - upload = INSERT cez RLS, remove = DELETE … RETURNING cez RLS.
// NIKDY sa nepripája na Supabase.
//
// SPUSTENIE (PGlite nie je závislosť projektu):
//   npm i --no-save @electric-sql/pglite@0.5.8
//   npm run test:storage-media-db
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MIGRATION_MODEL = "supabase/migrations/20261005090000_media_storage_access_model.sql";
const MIGRATION_FLIP = "supabase/migrations/20261005091000_private_media_buckets.sql";
const ROLLBACK = "supabase/rollback/20261005090000_media_storage_access_model_rollback.sql";
const ROLLBACK_FLIP = "supabase/rollback/20261005091000_private_media_buckets_rollback.sql";

type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

async function loadPglite(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  const crypto = dir ? pathToFileURL(path.join(dir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto";
  try {
    const { PGlite } = await import(main);
    const { pgcrypto } = await import(crypto);
    return new PGlite({ extensions: { pgcrypto } }) as Db;
  } catch (error) {
    console.error("PGlite nie je nainštalovaný: npm i --no-save @electric-sql/pglite@0.5.8  (alebo PGLITE_DIR=…)");
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Supabase stuby + prod-verná schéma
// -----------------------------------------------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create schema storage;
  create function auth.uid() returns uuid language sql stable as $f$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
  $f$;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;

  create table storage.buckets (id text primary key, public boolean not null default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id),
    name text not null,
    owner uuid default auth.uid(),
    created_at timestamptz not null default now(),
    unique (bucket_id, name)
  );
  create function storage.foldername(name text) returns text[] language sql immutable as $f$
    select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
  $f$;
  grant execute on function storage.foldername(text) to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  grant select on storage.buckets to anon, authenticated;
  alter table storage.objects enable row level security;

  insert into storage.buckets (id, public) values
    ('vehicle-photos', true), ('machine-photos', true), ('inventory-photos', true), ('company-logos', true),
    ('ai-inbox-documents', false), ('ai-evidence-documents', false), ('chat-attachments', false);

  create table public.companies (id uuid primary key, name text not null);
  create table public.company_members (
    company_id uuid not null references public.companies(id),
    user_id uuid not null,
    role text not null,
    status text not null default 'active',
    permissions jsonb not null default '{}'
  );
  create table public.vehicles (id uuid primary key, company_id uuid not null, spz text not null);
  create table public.machines (id uuid primary key, company_id uuid not null, name text);
  create table public.inventory_items (id uuid primary key, company_id uuid not null, name text);
  create table public.vehicle_photos (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete restrict,
    vehicle_id uuid not null references public.vehicles(id) on delete cascade,
    user_id uuid, storage_bucket text not null, storage_path text not null);
  create table public.machine_photos (
    id uuid primary key default gen_random_uuid(), user_id uuid, machine_id uuid, file_path text,
    company_id uuid not null references public.companies(id) on delete restrict);
  create table public.inventory_photos (
    id uuid primary key default gen_random_uuid(),
    inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
    user_id uuid, file_path text not null,
    company_id uuid not null references public.companies(id) on delete restrict);
  create table public.company_billing_profile (company_id uuid primary key references public.companies(id), legal_name text, logo_path text);

  -- Moduly: zjednodušené RLS zrkadliace prod (SELECT prevádzka; zápis owner/admin; vozidlá aj employee; logo finance.manage)
  grant select, insert, update, delete on public.vehicle_photos, public.machine_photos, public.inventory_photos, public.company_billing_profile to authenticated;
  grant select on public.company_members, public.vehicles, public.machines, public.inventory_items to authenticated;
`);

// Prod pomocné funkcie (pg_get_functiondef 2026-10-04).
await db.exec(`
  create or replace function public.esblu_my_active_company_id() returns uuid language sql stable security definer set search_path to '' as $function$
    select cm.company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
  $function$;
  create or replace function public.esblu_my_active_role() returns text language sql stable security definer set search_path to '' as $function$
    select cm.role from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
  $function$;
  create or replace function public.esblu_role_can_operate() returns boolean language sql stable security definer set search_path to '' as $function$
    select coalesce((select cm.role in ('owner', 'admin', 'employee') from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
  $function$;
  create or replace function public.esblu_my_finance_manage() returns boolean language sql stable security definer set search_path to '' as $function$
    select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
      else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
      from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
  $function$;
  grant execute on function public.esblu_my_active_company_id(), public.esblu_my_active_role(), public.esblu_role_can_operate(), public.esblu_my_finance_manage() to authenticated;

  alter table public.vehicle_photos enable row level security;
  alter table public.machine_photos enable row level security;
  alter table public.inventory_photos enable row level security;
  alter table public.company_billing_profile enable row level security;
  create policy vp_select on public.vehicle_photos for select to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
  create policy vp_delete on public.vehicle_photos for delete to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
  create policy mp_select on public.machine_photos for select to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
  create policy mp_delete on public.machine_photos for delete to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
  create policy ip_select on public.inventory_photos for select to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
  create policy ip_delete on public.inventory_photos for delete to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
  create policy cbp_select on public.company_billing_profile for select to authenticated using (company_id = public.esblu_my_active_company_id());
  create policy cbp_update on public.company_billing_profile for update to authenticated
    using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage())
    with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());
`);

// Prod delete funkcie (doslovne logika, pg_get_functiondef 2026-10-04).
const refDelete = (fn: string, table: string, col: string, extra: string, roles: string) => `
  create or replace function public.${fn}(p_object_name text) returns boolean language plpgsql stable security definer set search_path to '' as $function$
  declare v_uid uuid := auth.uid(); v_uploader_uid text; v_referenced_row_count integer; v_null_company_count integer; v_distinct_company_count integer; v_company_id uuid;
  begin
    if v_uid is null then return false; end if;
    v_uploader_uid := (storage.foldername(p_object_name))[1];
    select count(*), count(*) filter (where t.company_id is null), count(distinct t.company_id)
      into v_referenced_row_count, v_null_company_count, v_distinct_company_count
      from public.${table} t where ${extra} t.${col} = p_object_name;
    if v_referenced_row_count = 0 then return v_uploader_uid = v_uid::text; end if;
    if v_null_company_count > 0 or v_distinct_company_count <> 1 then return false; end if;
    select t.company_id into v_company_id from public.${table} t where ${extra} t.${col} = p_object_name and t.company_id is not null limit 1;
    return exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active' ${roles} and cm.company_id = v_company_id);
  end;
  $function$;
  grant execute on function public.${fn}(text) to authenticated;`;
await db.exec(
  refDelete("esblu_can_delete_vehicle_photo_object", "vehicle_photos", "storage_path", "t.storage_bucket = 'vehicle-photos' and", "and cm.role in ('owner', 'admin')") +
    refDelete("esblu_can_delete_inventory_photo_object", "inventory_photos", "file_path", "", "and cm.role in ('owner', 'admin')") +
    // prod: machine — ktorýkoľvek aktívny člen (nález)
    refDelete("esblu_can_delete_machine_photo_object", "machine_photos", "file_path", "", "")
);
await db.exec(`
  create or replace function public.esblu_can_manage_company_logo_object(p_object_name text) returns boolean language plpgsql stable security definer set search_path to '' as $function$
  declare v_uid uuid := auth.uid(); v_uploader_uid text; v_uploader_active_company_count integer; v_uploader_company_id uuid;
  begin
    if v_uid is null then return false; end if;
    v_uploader_uid := (storage.foldername(p_object_name))[1];
    select count(*) into v_uploader_active_company_count from public.company_members cm where cm.user_id::text = v_uploader_uid and cm.status = 'active';
    if v_uploader_active_company_count <> 1 then return false; end if;
    select cm.company_id into v_uploader_company_id from public.company_members cm where cm.user_id::text = v_uploader_uid and cm.status = 'active' limit 1;
    return exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active' and cm.role in ('owner', 'admin') and cm.company_id = v_uploader_company_id);
  end;
  $function$;
  grant execute on function public.esblu_can_manage_company_logo_object(text) to authenticated;
`);

// PRED-migračné prod politiky — prevzaté z rollback súboru (ten ich obsahuje doslovne z prod).
{
  const rb = read(ROLLBACK);
  const start = rb.indexOf("create policy vehicle_photos_select_company");
  assert.ok(start > 0, "rollback neobsahuje pôvodné politiky");
  await db.exec(rb.slice(start));
}

// -----------------------------------------------------------------------------
// Dáta
// -----------------------------------------------------------------------------
const CA = "aaaaaaaa-0000-4000-8000-000000000001";
const CB = "bbbbbbbb-0000-4000-8000-000000000001";
const U = {
  ownerA: "aaaaaaaa-1111-4000-8000-000000000001",
  adminA: "aaaaaaaa-1111-4000-8000-000000000002",
  employeeA: "aaaaaaaa-1111-4000-8000-000000000003",
  accountantA: "aaaaaaaa-1111-4000-8000-000000000004",
  movedAtoB: "aaaaaaaa-1111-4000-8000-000000000005",
  financeAdminA: "aaaaaaaa-1111-4000-8000-000000000006",
  inactiveA: "aaaaaaaa-1111-4000-8000-000000000007",
  ownerB: "bbbbbbbb-1111-4000-8000-000000000001",
  employeeB: "bbbbbbbb-1111-4000-8000-000000000002",
  outsider: "cccccccc-1111-4000-8000-000000000001",
};
const VEH_A = "aaaaaaaa-2222-4000-8000-000000000001";
const VEH_B = "bbbbbbbb-2222-4000-8000-000000000001";
const MACH_A = "aaaaaaaa-3333-4000-8000-000000000001";
const ITEM_A = "aaaaaaaa-4444-4000-8000-000000000001";
const ITEM_A2 = "aaaaaaaa-4444-4000-8000-000000000002";

const OBJ = {
  vehicleA: `${U.employeeA}/${VEH_A}/photo-1.webp`,
  vehicleByMoved: `${U.movedAtoB}/${VEH_A}/photo-2.webp`,
  machineA: `${U.employeeA}/${MACH_A}/photo-1.webp`,
  inventoryA: `${U.ownerA}/${ITEM_A}/photo-1.webp`,
  inventoryA2: `${U.adminA}/${ITEM_A2}/photo-1.webp`,
  logoA: `${U.ownerA}/1790000000000-company-logo.webp`,
  pendingEmployeeA: `${U.employeeA}/${VEH_A}/pending.webp`,
  inconsistent: `${U.ownerA}/${MACH_A}/dup.webp`,
  orphanLegacy: `${U.employeeA}/${MACH_A}/legacy-orphan.webp`,
};

await db.exec(`
  insert into public.companies values ('${CA}', 'Firma A'), ('${CB}', 'Firma B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${CA}', '${U.ownerA}', 'owner', 'active', '{}'),
    ('${CA}', '${U.adminA}', 'admin', 'active', '{}'),
    ('${CA}', '${U.financeAdminA}', 'admin', 'active', '{"finance":{"manage":true}}'),
    ('${CA}', '${U.employeeA}', 'employee', 'active', '{}'),
    ('${CA}', '${U.accountantA}', 'accountant', 'active', '{}'),
    ('${CA}', '${U.inactiveA}', 'admin', 'removed', '{}'),
    ('${CA}', '${U.movedAtoB}', 'employee', 'removed', '{}'),
    ('${CB}', '${U.movedAtoB}', 'employee', 'active', '{}'),
    ('${CB}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${CB}', '${U.employeeB}', 'employee', 'active', '{}');
  insert into public.vehicles values ('${VEH_A}', '${CA}', 'BA111AA'), ('${VEH_B}', '${CB}', 'BA222BB');
  insert into public.machines values ('${MACH_A}', '${CA}', 'Bager');
  insert into public.inventory_items values ('${ITEM_A}', '${CA}', 'Lopata'), ('${ITEM_A2}', '${CA}', 'Krompáč');

  insert into storage.objects (bucket_id, name, owner) values
    ('vehicle-photos', '${OBJ.vehicleA}', '${U.employeeA}'),
    ('vehicle-photos', '${OBJ.vehicleByMoved}', '${U.movedAtoB}'),
    ('vehicle-photos', '${OBJ.pendingEmployeeA}', '${U.employeeA}'),
    ('machine-photos', '${OBJ.machineA}', '${U.employeeA}'),
    ('machine-photos', '${OBJ.inconsistent}', '${U.ownerA}'),
    ('machine-photos', '${OBJ.orphanLegacy}', '${U.employeeA}'),
    ('inventory-photos', '${OBJ.inventoryA}', '${U.ownerA}'),
    ('inventory-photos', '${OBJ.inventoryA2}', '${U.adminA}'),
    ('company-logos', '${OBJ.logoA}', '${U.ownerA}');

  insert into public.vehicle_photos (company_id, vehicle_id, user_id, storage_bucket, storage_path) values
    ('${CA}', '${VEH_A}', '${U.employeeA}', 'vehicle-photos', '${OBJ.vehicleA}'),
    ('${CA}', '${VEH_A}', '${U.movedAtoB}', 'vehicle-photos', '${OBJ.vehicleByMoved}');
  insert into public.machine_photos (company_id, machine_id, user_id, file_path) values
    ('${CA}', '${MACH_A}', '${U.employeeA}', '${OBJ.machineA}'),
    ('${CA}', '${MACH_A}', '${U.ownerA}', '${OBJ.inconsistent}'),
    ('${CB}', '${MACH_A}', '${U.ownerA}', '${OBJ.inconsistent}');
  insert into public.inventory_photos (company_id, inventory_item_id, user_id, file_path) values
    ('${CA}', '${ITEM_A}', '${U.ownerA}', '${OBJ.inventoryA}'),
    ('${CA}', '${ITEM_A2}', '${U.adminA}', '${OBJ.inventoryA2}');
  insert into public.company_billing_profile (company_id, legal_name, logo_path) values
    ('${CA}', 'Firma A s.r.o.', '${OBJ.logoA}'), ('${CB}', 'Firma B s.r.o.', null);
`);

// -----------------------------------------------------------------------------
// Model prístupu Supabase Storage
// -----------------------------------------------------------------------------
async function as<T>(uid: string | null, fn: () => Promise<T>, commit = false): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : JSON.stringify({ role: "anon" })]);
    await db.exec(`set local role ${uid ? "authenticated" : "anon"}`);
    const result = await fn();
    await db.exec(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
const canSelect = (uid: string | null, bucket: string, name: string) =>
  as(uid, async () => (await db.query<{ n: number }>("select count(*)::int as n from storage.objects where bucket_id = $1 and name = $2", [bucket, name])).rows[0].n === 1);
const canInsert = (uid: string | null, bucket: string, name: string) =>
  as(uid, async () => {
    try {
      await db.query("insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]);
      return true;
    } catch {
      return false;
    }
  });
/** Supabase remove() = DELETE … RETURNING; 0 riadkov = nepovolené alebo neexistuje. */
const removeObject = (uid: string | null, bucket: string, name: string, commit = false) =>
  as(uid, async () => (await db.query("delete from storage.objects where bucket_id = $1 and name = $2 returning id", [bucket, name])).rows.length === 1, commit);
const canDelete = (uid: string | null, bucket: string, name: string) => removeObject(uid, bucket, name, false);
const canUpdate = (uid: string | null, bucket: string, name: string) =>
  as(uid, async () => (await db.query("update storage.objects set owner = owner where bucket_id = $1 and name = $2 returning id", [bucket, name])).rows.length === 1);
async function publicEndpointServes(bucket: string, name: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    "select (b.public and exists (select 1 from storage.objects o where o.bucket_id = b.id and o.name = $2)) as ok from storage.buckets b where b.id = $1",
    [bucket, name]
  );
  return rows[0]?.ok === true;
}
async function objectExists(bucket: string, name: string): Promise<boolean> {
  return (await db.query<{ n: number }>("select count(*)::int as n from storage.objects where bucket_id = $1 and name = $2", [bucket, name])).rows[0].n === 1;
}

const PROTECTED: [string, string][] = [
  ["vehicle-photos", OBJ.vehicleA],
  ["machine-photos", OBJ.machineA],
  ["inventory-photos", OBJ.inventoryA],
  ["company-logos", OBJ.logoA],
];

// =============================================================================
// PRED migráciou — dokumentuje nálezy
// =============================================================================
await check("PRED: verejný endpoint vydá súbory bez prihlásenia", async () => {
  for (const [bucket, name] of PROTECTED) assert.equal(await publicEndpointServes(bucket, name), true, bucket);
});
await check("PRED: firma podľa priečinka nahrávateľa — po presune vidí firma B fotku firmy A", async () => {
  assert.equal(await canSelect(U.ownerB, "vehicle-photos", OBJ.vehicleByMoved), true);
});
await check("PRED: cudzí používateľ smel nahrať do inventory-/machine-photos (vlastný priečinok)", async () => {
  assert.equal(await canInsert(U.employeeB, "inventory-photos", `${U.employeeB}/${ITEM_A}/x.webp`), true);
  assert.equal(await canInsert(U.outsider, "machine-photos", `${U.outsider}/${MACH_A}/x.webp`), true);
});
await check("PRED: účtovník smel zmazať fotku stroja", async () => {
  assert.equal(await canDelete(U.accountantA, "machine-photos", OBJ.machineA), true);
});

// =============================================================================
// Migrácia
// =============================================================================
// Krok 1: prístupový model (buckety ešte verejné) — stará appka ešte funguje.
await db.exec(read(MIGRATION_MODEL));
await check("KROK 1 (model, buckety ešte verejné): verejné URL fungujú, nové pravidlá už platia", async () => {
  assert.equal(await publicEndpointServes("vehicle-photos", OBJ.vehicleA), true);
  assert.equal(await canInsert(U.employeeB, "inventory-photos", `${U.employeeB}/${ITEM_A}/y.webp`), false);
  assert.equal(await canDelete(U.accountantA, "machine-photos", OBJ.machineA), false);
});
// Krok 2: prepnutie na súkromné.
await db.exec(read(MIGRATION_FLIP));
await check("migrácie sú idempotentné", async () => {
  await db.exec(read(MIGRATION_MODEL));
  await db.exec(read(MIGRATION_FLIP));
});
await check("ROLLBACK prepnutia: iba buckety znova verejné, model ostáva; potom znova súkromné", async () => {
  await db.exec(read(ROLLBACK_FLIP));
  assert.equal(await publicEndpointServes("company-logos", OBJ.logoA), true);
  assert.equal(await canInsert(U.outsider, "machine-photos", `${U.outsider}/${MACH_A}/z.webp`), false);
  await db.exec(read(MIGRATION_FLIP));
  assert.equal(await publicEndpointServes("company-logos", OBJ.logoA), false);
});
await check("migrácia nezmazala žiadny súbor (ani nereferencovaný)", async () => {
  assert.equal(await objectExists("machine-photos", OBJ.orphanLegacy), true);
  assert.equal((await db.query<{ n: number }>("select count(*)::int as n from storage.objects")).rows[0].n, 9);
});
await check("PO: všetky buckety súkromné", async () => {
  const { rows } = await db.query<{ public: boolean }>("select public from storage.buckets");
  assert.ok(rows.every((row) => row.public === false));
});

// ----------------------------------------------------------------- READ
await check("READ: anonym nič (verejný endpoint ani API)", async () => {
  for (const [bucket, name] of PROTECTED) {
    assert.equal(await publicEndpointServes(bucket, name), false, bucket);
    assert.equal(await canSelect(null, bucket, name), false, bucket);
  }
});
await check("READ: owner/admin/employee firmy A — fotky aj logo", async () => {
  for (const uid of [U.ownerA, U.adminA, U.employeeA]) {
    for (const [bucket, name] of PROTECTED) assert.equal(await canSelect(uid, bucket, name), true, `${uid} ${bucket}`);
  }
});
await check("READ: účtovník — iba logo", async () => {
  assert.equal(await canSelect(U.accountantA, "company-logos", OBJ.logoA), true);
  for (const [bucket, name] of PROTECTED.filter(([b]) => b !== "company-logos")) assert.equal(await canSelect(U.accountantA, bucket, name), false, bucket);
});
await check("READ: cudzia firma, neaktívny člen — nič", async () => {
  for (const uid of [U.ownerB, U.employeeB, U.inactiveA, U.outsider]) {
    for (const [bucket, name] of PROTECTED) assert.equal(await canSelect(uid, bucket, name), false, `${uid} ${bucket}`);
  }
});
await check("READ: firma podľa DB záznamu — presunutý nahrávateľ ani firma B nevidia fotku A", async () => {
  assert.equal(await canSelect(U.movedAtoB, "vehicle-photos", OBJ.vehicleByMoved), false);
  assert.equal(await canSelect(U.ownerB, "vehicle-photos", OBJ.vehicleByMoved), false);
  assert.equal(await canSelect(U.ownerA, "vehicle-photos", OBJ.vehicleByMoved), true);
});
await check("READ: rozpracovaný upload vidí iba nahrávateľ; nekonzistentné referencie nikto", async () => {
  assert.equal(await canSelect(U.employeeA, "vehicle-photos", OBJ.pendingEmployeeA), true);
  assert.equal(await canSelect(U.ownerA, "vehicle-photos", OBJ.pendingEmployeeA), false);
  for (const uid of [U.ownerA, U.ownerB]) assert.equal(await canSelect(uid, "machine-photos", OBJ.inconsistent), false);
});

// ----------------------------------------------------------------- UPLOAD
const newPath = (uid: string, entity: string) => `${uid}/${entity}/${Math.random().toString(36).slice(2)}.webp`;
await check("UPLOAD: anonym nemôže", async () => {
  assert.equal(await canInsert(null, "vehicle-photos", newPath(U.ownerA, VEH_A)), false);
  assert.equal(await canInsert(null, "company-logos", `${U.ownerA}/x-company-logo.webp`), false);
});
await check("UPLOAD vozidlá: owner/admin/employee A k vozidlu A áno; účtovník nie", async () => {
  for (const uid of [U.ownerA, U.adminA, U.employeeA]) assert.equal(await canInsert(uid, "vehicle-photos", newPath(uid, VEH_A)), true, uid);
  assert.equal(await canInsert(U.accountantA, "vehicle-photos", newPath(U.accountantA, VEH_A)), false);
});
await check("UPLOAD stroje/sklad: owner/admin áno; employee a účtovník nie (zrkadlí RLS *_photos)", async () => {
  for (const uid of [U.ownerA, U.adminA]) {
    assert.equal(await canInsert(uid, "machine-photos", newPath(uid, MACH_A)), true, `machine ${uid}`);
    assert.equal(await canInsert(uid, "inventory-photos", newPath(uid, ITEM_A)), true, `inventory ${uid}`);
  }
  for (const uid of [U.employeeA, U.accountantA]) {
    assert.equal(await canInsert(uid, "machine-photos", newPath(uid, MACH_A)), false, `machine ${uid}`);
    assert.equal(await canInsert(uid, "inventory-photos", newPath(uid, ITEM_A)), false, `inventory ${uid}`);
  }
});
await check("UPLOAD logo: finance.manage (owner, účtovník, admin s oprávnením) áno; admin bez neho a employee nie", async () => {
  for (const uid of [U.ownerA, U.accountantA, U.financeAdminA]) assert.equal(await canInsert(uid, "company-logos", `${uid}/1-company-logo.webp`), true, uid);
  for (const uid of [U.adminA, U.employeeA]) assert.equal(await canInsert(uid, "company-logos", `${uid}/1-company-logo.webp`), false, uid);
});
await check("UPLOAD: cudzia firma ani neaktívny člen nemôže", async () => {
  assert.equal(await canInsert(U.ownerB, "vehicle-photos", newPath(U.ownerB, VEH_A)), false);
  assert.equal(await canInsert(U.ownerB, "inventory-photos", newPath(U.ownerB, ITEM_A)), false);
  assert.equal(await canInsert(U.inactiveA, "machine-photos", newPath(U.inactiveA, MACH_A)), false);
  assert.equal(await canInsert(U.outsider, "machine-photos", newPath(U.outsider, MACH_A)), false);
});
await check("UPLOAD: podvrhnutá cesta nepomôže (cudzí priečinok, cudzia entita, zlá hĺbka, '..', prepis referencovaného)", async () => {
  assert.equal(await canInsert(U.employeeA, "vehicle-photos", newPath(U.ownerA, VEH_A)), false, "cudzí priečinok");
  assert.equal(await canInsert(U.ownerA, "vehicle-photos", newPath(U.ownerA, VEH_B)), false, "vozidlo firmy B");
  assert.equal(await canInsert(U.ownerA, "vehicle-photos", `${U.ownerA}/x.webp`), false, "bez entity");
  assert.equal(await canInsert(U.ownerA, "vehicle-photos", `${U.ownerA}/${VEH_A}/a/b.webp`), false, "príliš hlboko");
  assert.equal(await canInsert(U.ownerA, "vehicle-photos", `${U.ownerA}/not-a-uuid/x.webp`), false, "nie UUID");
  assert.equal(await canInsert(U.ownerA, "vehicle-photos", `${U.ownerA}/../${VEH_A}/x.webp`), false, "..");
  assert.equal(await canInsert(U.ownerA, "company-logos", `${U.ownerA}/${VEH_A}/x.webp`), false, "logo zlá hĺbka");
  assert.equal(await canInsert(U.employeeA, "chat-attachments", `${U.employeeA}/x.webp`), false, "iný bucket");
});
await check("UPDATE (upsert/move): zakázané pre všetkých", async () => {
  for (const uid of [U.ownerA, U.adminA, U.employeeA]) {
    for (const [bucket, name] of PROTECTED) assert.equal(await canUpdate(uid, bucket, name), false, `${uid} ${bucket}`);
  }
});

// ----------------------------------------------------------------- DELETE
await check("DELETE: anonym, cudzia firma, neaktívny — nie", async () => {
  for (const uid of [null, U.ownerB, U.employeeB, U.inactiveA]) {
    for (const [bucket, name] of PROTECTED) assert.equal(await canDelete(uid, bucket, name), false, `${uid} ${bucket}`);
  }
});
await check("DELETE fotiek: owner/admin A aj súbor nahraný iným členom; employee a účtovník nie", async () => {
  for (const uid of [U.ownerA, U.adminA]) {
    assert.equal(await canDelete(uid, "vehicle-photos", OBJ.vehicleA), true, `vehicle ${uid}`);
    assert.equal(await canDelete(uid, "machine-photos", OBJ.machineA), true, `machine ${uid}`);
    assert.equal(await canDelete(uid, "inventory-photos", OBJ.inventoryA2), true, `inventory ${uid}`);
  }
  for (const uid of [U.employeeA, U.accountantA]) {
    assert.equal(await canDelete(uid, "vehicle-photos", OBJ.vehicleA), false, `vehicle ${uid}`);
    assert.equal(await canDelete(uid, "machine-photos", OBJ.machineA), false, `machine ${uid}`);
    assert.equal(await canDelete(uid, "inventory-photos", OBJ.inventoryA), false, `inventory ${uid}`);
  }
});
await check("DELETE loga: finance.manage áno; admin bez oprávnenia a employee nie", async () => {
  for (const uid of [U.ownerA, U.accountantA, U.financeAdminA]) assert.equal(await canDelete(uid, "company-logos", OBJ.logoA), true, uid);
  for (const uid of [U.adminA, U.employeeA]) assert.equal(await canDelete(uid, "company-logos", OBJ.logoA), false, uid);
});
await check("DELETE: vlastný rozpracovaný upload smie zmazať nahrávateľ; nekonzistentný nikto", async () => {
  assert.equal(await canDelete(U.employeeA, "vehicle-photos", OBJ.pendingEmployeeA), true);
  assert.equal(await canDelete(U.ownerA, "vehicle-photos", OBJ.pendingEmployeeA), false);
  assert.equal(await canDelete(U.ownerA, "machine-photos", OBJ.inconsistent), false);
});
await check("DELETE: starý nereferencovaný súbor (nie vo fronte) admin nezmaže — to rieši samostatný cleanup", async () => {
  assert.equal(await canDelete(U.ownerA, "machine-photos", OBJ.orphanLegacy), false);
});

// ----------------------------------------------------------------- ORPHAN / fronta
const sweep = (uid: string) =>
  as(uid, async () => (await db.query<{ bucket_id: string; object_path: string }>("select * from public.esblu_media_deletion_sweep(100)")).rows, true);
const queued = async (bucket: string, name: string) =>
  (await db.query<{ completed_at: string | null; company_id: string; attempts: number }>("select completed_at, company_id, attempts from public.media_deletion_queue where bucket_id = $1 and object_path = $2", [bucket, name])).rows[0];

await check("ORPHAN: admin zmaže záznam fotky nahratej zamestnancom → súbor je vo fronte a admin ho úspešne zmaže", async () => {
  await as(U.adminA, async () => {
    const { rows } = await db.query("delete from public.vehicle_photos where storage_path = $1 returning id", [OBJ.vehicleA]);
    assert.equal(rows.length, 1);
  }, true);
  const q = await queued("vehicle-photos", OBJ.vehicleA);
  assert.ok(q && q.completed_at === null && q.company_id === CA, "chýba záznam vo fronte");
  assert.equal(await removeObject(U.adminA, "vehicle-photos", OBJ.vehicleA, true), true, "admin musí vedieť zmazať súbor");
  assert.deepEqual(await sweep(U.adminA), []);
  assert.ok((await queued("vehicle-photos", OBJ.vehicleA)).completed_at !== null, "sweep má položku uzavrieť");
  assert.equal(await objectExists("vehicle-photos", OBJ.vehicleA), false);
});

await check("ORPHAN: zlyhanie Storage po zmazaní záznamu nezostane ticho — položka čaká, retry je idempotentný", async () => {
  await as(U.ownerA, async () => {
    await db.query("delete from public.machine_photos where file_path = $1", [OBJ.machineA]);
  }, true);
  // Storage delete „zlyhal" (neprebehol). Súbor existuje a je evidovaný.
  assert.equal(await objectExists("machine-photos", OBJ.machineA), true);
  const pending = await sweep(U.ownerA);
  assert.deepEqual(pending, [{ bucket_id: "machine-photos", object_path: OBJ.machineA }]);
  assert.equal((await queued("machine-photos", OBJ.machineA)).attempts, 1);
  // Cudzia firma ani zamestnanec frontu nevidia ani nevyužijú.
  assert.deepEqual(await sweep(U.ownerB), []);
  assert.deepEqual(await sweep(U.employeeA), []);
  assert.equal(await canDelete(U.employeeA, "machine-photos", OBJ.machineA), false);
  assert.equal(await canDelete(U.ownerB, "machine-photos", OBJ.machineA), false);
  // Retry: zmazanie + sweep; druhé zmazanie aj sweep sú bezpečné no-op.
  assert.equal(await removeObject(U.adminA, "machine-photos", OBJ.machineA, true), true);
  assert.equal(await removeObject(U.adminA, "machine-photos", OBJ.machineA, true), false);
  assert.deepEqual(await sweep(U.adminA), []);
  assert.deepEqual(await sweep(U.adminA), []);
  assert.ok((await queued("machine-photos", OBJ.machineA)).completed_at !== null);
});

await check("ORPHAN: zmazanie položky skladu kaskádou zaradí všetky jej fotky do fronty", async () => {
  await as(U.ownerA, async () => {
    await db.query("delete from public.inventory_photos where inventory_item_id = $1", [ITEM_A2]);
  }, true);
  assert.ok(await queued("inventory-photos", OBJ.inventoryA2));
  assert.deepEqual(await sweep(U.ownerA), [{ bucket_id: "inventory-photos", object_path: OBJ.inventoryA2 }]);
  assert.equal(await removeObject(U.ownerA, "inventory-photos", OBJ.inventoryA2, true), true);
  assert.deepEqual(await sweep(U.ownerA), []);
});

await check("ORPHAN: výmena loga zaradí staré logo do fronty; zmaže ho iba finance.manage", async () => {
  await db.exec(`insert into storage.objects (bucket_id, name, owner) values ('company-logos', '${U.ownerA}/2-company-logo.webp', '${U.ownerA}')`);
  await as(U.ownerA, async () => {
    await db.query("update public.company_billing_profile set logo_path = $1 where company_id = $2", [`${U.ownerA}/2-company-logo.webp`, CA]);
  }, true);
  assert.ok(await queued("company-logos", OBJ.logoA));
  assert.equal(await canDelete(U.adminA, "company-logos", OBJ.logoA), false);
  assert.equal(await removeObject(U.accountantA, "company-logos", OBJ.logoA, true), true);
  assert.deepEqual(await sweep(U.accountantA), []);
  // nové logo ostáva čitateľné pre člena firmy
  assert.equal(await canSelect(U.employeeA, "company-logos", `${U.ownerA}/2-company-logo.webp`), true);
});

await check("ORPHAN: fronta nie je priamo dostupná klientovi", async () => {
  const blocked = await as(U.ownerA, async () => {
    try {
      await db.query("select * from public.media_deletion_queue");
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true);
  const blockedInsert = await as(U.ownerA, async () => {
    try {
      await db.query("insert into public.media_deletion_queue (company_id, bucket_id, object_path) values ($1, 'machine-photos', $2)", [CA, OBJ.orphanLegacy]);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blockedInsert, true);
});

// =============================================================================
// Rollback
// =============================================================================
await check("ROLLBACK: presný pôvodný stav (verejné buckety, 15 politík, nové objekty preč, súbory nedotknuté)", async () => {
  const before = (await db.query<{ n: number }>("select count(*)::int as n from storage.objects")).rows[0].n;
  await db.exec(read(ROLLBACK));
  for (const [bucket] of PROTECTED) {
    const { rows } = await db.query<{ public: boolean }>("select public from storage.buckets where id = $1", [bucket]);
    assert.equal(rows[0].public, true, bucket);
  }
  const pol = await db.query<{ policyname: string }>("select policyname from pg_policies where schemaname = 'storage' order by 1");
  assert.deepEqual(pol.rows.map((r) => r.policyname), [
    "Users can update inventory photos",
    "Users can upload inventory photos",
    "company_logos_delete_owner_admin",
    "company_logos_insert_owner_admin",
    "company_logos_select_company",
    "company_logos_update_owner_admin",
    "inventory_photos_delete_company",
    "inventory_photos_select_company",
    "machine_photos_delete_company",
    "machine_photos_insert_own",
    "machine_photos_select_company",
    "machine_photos_update_own",
    "vehicle_photos_delete_owner_admin",
    "vehicle_photos_insert_active_member",
    "vehicle_photos_select_company",
  ]);
  const leftovers = await db.query<{ n: number }>(
    "select count(*)::int as n from pg_proc where proname in ('esblu_can_read_media_object','esblu_can_upload_media_object','esblu_can_delete_media_object','esblu_media_role_allows','esblu_media_object_owner','esblu_enqueue_media_deletion','esblu_media_deletion_sweep','esblu_media_deletion_pending_company')"
  );
  assert.equal(leftovers.rows[0].n, 0);
  assert.equal((await db.query<{ t: string | null }>("select to_regclass('public.media_deletion_queue')::text as t")).rows[0].t, null);
  assert.equal((await db.query<{ n: number }>("select count(*)::int as n from storage.objects")).rows[0].n, before);
  // a migrácie sa dajú znova aplikovať
  await db.exec(read(MIGRATION_MODEL));
  await db.exec(read(MIGRATION_FLIP));
  assert.equal(await publicEndpointServes("company-logos", `${U.ownerA}/2-company-logo.webp`), false);
});

console.log(`storage-media-db: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
