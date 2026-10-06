-- =============================================================================
-- Kostra schémy pre lokálny test E-Faktúry v PGlite (PostgreSQL vo WASM) —
-- scripts/einvoice-pglite-tests.ts. NIKDY sa nespúšťa proti Supabase.
--
-- Na rozdiel od m1-authz-baseline.sql tu NIE sú ručne prepísané fakturačné
-- tabuľky: test na túto kostru aplikuje DOSLOVNE celý fakturačný reťazec
-- migrácií z repa (20260916094000 … 20260929100000) a potom migrácie
-- E-Faktúry (20261002100000, 20261002110000). Kostra obsahuje iba to, čo
-- Supabase / skoršie (predfakturačné) migrácie dodávajú:
--   - roly anon / authenticated / service_role, predvolené GRANTy ako v Supabase,
--   - auth.users, auth.uid(), auth.role() z request.jwt.claims,
--   - storage.buckets / storage.objects / storage.foldername (stub),
--   - companies, company_members, settings a pomocné funkcie esblu_my_*
--     (doslovne z prod — rovnaké ako v m1-authz-baseline.sql),
--   - minimálne stuby tabuliek iných modulov, na ktoré fakturačné migrácie
--     odkazujú v DDL (documents, document_links, ai_evidence, machine_*, …),
--   - companies.plan, plan_limits, ai_scan_limits a esblu_company_plan —
--     predpoklady skutočnej migrácie nárokov 20260928100000, ktorú test
--     spúšťa doslovne (trial firmy, katalóg, resolver, trigger fakturácie).
-- Vynechaná je iba 20260920123000 (EXECUTE granty trigger funkcií iných modulov).
-- =============================================================================

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema auth;
create schema extensions;
create schema storage;
create extension pgcrypto schema extensions;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role' $$;
grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;
grant execute on all functions in schema extensions to anon, authenticated;
grant execute on function auth.uid(), auth.role() to anon, authenticated;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language sql immutable as $f$ select string_to_array(name, '/') $f$;
alter table storage.objects enable row level security;
create table public.companies (id uuid primary key default gen_random_uuid(), name text not null, plan text not null default 'free', created_at timestamptz default now());
create table public.company_members (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), user_id uuid not null, role text not null, status text not null default 'active', permissions jsonb not null default '{}', created_at timestamptz default now());
-- Invarianty z prod (20260814…): jedno členstvo na firmu a najviac JEDNO aktívne členstvo na používateľa.
create unique index company_members_unique_company_user on public.company_members (company_id, user_id);
create unique index company_members_one_active_per_user_idx on public.company_members (user_id) where status = 'active';
-- Pomocné funkcie (doslovne z prod) -------------------------------------------
create or replace function public.esblu_my_active_company_id() returns uuid language sql stable security definer set search_path to '' as $f$
  select cm.company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_my_active_role() returns text language sql stable security definer set search_path to '' as $f$
  select cm.role from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_my_finance_manage() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_my_finance_view() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false) or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_role_can_operate() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select cm.role in ('owner', 'admin', 'employee') from public.company_members cm
    where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_document_requires_finance(p_document_type text, p_status text) returns boolean language sql immutable set search_path to '' as $f$
  select coalesce(p_document_type, '') in ('invoice', 'receipt', 'delivery_note') or coalesce(p_status, '') in ('uploaded', 'processing');
$f$;
create or replace function public.esblu_evidence_is_delivery_note(p_kind text, p_label text) returns boolean language sql immutable set search_path to '' as $f$
  select case when p_kind is not null then p_kind = 'delivery_note'
    else lower(coalesce(p_label, '')) in ('delivery_note', 'dodací list', 'dodaci list', 'lieferschein', 'delivery note') end;
$f$;

create or replace function public.esblu_assign_company_id() returns trigger language plpgsql security definer set search_path to '' as $f$
declare v_company_id uuid;
begin
  select cm.company_id into v_company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
  if v_company_id is null then raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP:' || tg_table_schema || '.' || tg_table_name; end if;
  new.company_id := v_company_id;
  return new;
end;
$f$;
create or replace function public.esblu_lock_company_id_on_update() returns trigger language plpgsql security definer set search_path to '' as $f$
begin new.company_id := old.company_id; return new; end;
$f$;
create table public.settings (id uuid primary key default gen_random_uuid(), user_id uuid unique, company_name text, logo_path text, plan text);
create table public.vehicles (id uuid primary key default gen_random_uuid(), company_id uuid not null, spz text);
create table public.machines (id uuid primary key default gen_random_uuid(), company_id uuid not null, name text);

create table public.custom_document_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  name text not null,
  canonical_slug text not null,
  description text,
  created_by uuid,
  created_at timestamptz default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  storage_bucket text not null,
  storage_path text not null,
  original_filename text,
  mime_type text,
  file_size bigint,
  document_type text not null default 'other'
    check (document_type = any (array['weigh_ticket','delivery_note','invoice','receipt','insurance','service_document','vehicle_registration','other'])),
  status text not null default 'uploaded'
    check (status = any (array['uploaded','processing','extracted','needs_review','confirmed','failed'])),
  ai_model text,
  ai_raw_output jsonb,
  extracted_fields jsonb,
  field_confidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz,
  note text,
  company_id uuid not null,
  archived_from_inbox_at timestamptz,
  custom_category_id uuid references public.custom_document_categories(id) on delete set null,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  unique (storage_bucket, storage_path)
);

create table public.document_links (id uuid primary key default gen_random_uuid(), user_id uuid not null, company_id uuid, document_id uuid not null references public.documents(id) on delete cascade, vehicle_id uuid, machine_id uuid, link_type text not null default 'related', confidence numeric, confirmed_by_user boolean not null default false, created_at timestamptz not null default now());
alter table public.document_links add column inventory_item_id uuid, add column vehicle_service_id uuid, add column machine_service_id uuid;
create table public.document_attachments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete cascade,
  company_id uuid,
  user_id uuid,
  storage_bucket text not null,
  storage_path text not null,
  unique (storage_bucket, storage_path)
);

create table public.legal_documents (id uuid primary key default gen_random_uuid(), slug text);
create table public.ai_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  spz text, document_type text, movement_type text, supplier text, document_number text,
  material text, quantity numeric, unit text, brutto numeric, tara numeric, netto numeric,
  construction_site text, customer text, document_date date, document_time text,
  photo_url text, raw_text text, created_at timestamptz default now(),
  material_original text, material_category text, document_language text,
  review_status text default 'pending', confidence_score numeric,
  source_location text, destination_location text,
  machine_id uuid references public.machines(id) on delete set null,
  machine_label text,
  company_id uuid not null references public.companies(id),
  evidence_kind text check (evidence_kind is null or evidence_kind = any (array['weigh_ticket','delivery_note'])),
  deleted_at timestamptz
);
create table public.machine_services (id uuid primary key default gen_random_uuid(), company_id uuid, machine_id uuid);
create table public.machine_photos (id uuid primary key default gen_random_uuid(), company_id uuid, machine_id uuid);
create table public.company_invites (id uuid primary key default gen_random_uuid(), company_id uuid, email text, role text, token text, status text, invited_by uuid, expires_at timestamptz, accepted_at timestamptz, created_at timestamptz default now());
-- Nároky (company_entitlements, entitlement_catalog, resolver, trigger fakturácie)
-- vytvára SKUTOČNÁ migrácia 20260928100000 v reťazci testu. Tu iba objekty,
-- ktoré táto migrácia predpokladá zo starších (predfakturačných) migrácií.
create table public.plan_limits (plan text primary key, vehicles integer, machines integer, inventory_items integer);
insert into public.plan_limits (plan, vehicles, machines, inventory_items) values ('free', 2, 2, 5), ('pro', null, null, null);
create table public.ai_scan_limits (endpoint text primary key, max_per_hour integer, max_per_day integer);
create or replace function public.esblu_company_plan(p_company_id uuid) returns text language sql stable security definer set search_path to '' as $f$
  select c.plan from public.companies c where c.id = p_company_id;
$f$;
create table public.beta_allowlist (email text primary key);
