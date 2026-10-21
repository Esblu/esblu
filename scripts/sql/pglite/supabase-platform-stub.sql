-- =============================================================================
-- Minimálna kostra Supabase PLATFORMY (nie Esblu schémy) pre čistý replay
-- VŠETKÝCH repo migrácií v PGlite — scripts/grants-replay-pglite-tests.ts.
-- NIKDY sa nespúšťa proti Supabase.
--
-- Obsahuje iba to, čo Supabase vytvorí pri založení projektu a čo migrácie
-- používajú: roly, schémy auth / storage / extensions / vault, auth.uid() /
-- auth.role() / auth.jwt(), auth.users / auth.sessions, storage.buckets /
-- storage.objects / storage.foldername(), pgcrypto v extensions a publikáciu
-- supabase_realtime.
--
-- ZÁMERNE CHÝBA: akékoľvek default privileges pre anon / authenticated /
-- service_role v schéme public. Presne tak vyzerá nový / preview / resetovaný
-- projekt po zmene Supabase 2026-10-30 (Data API grants už nie sú automatické).
-- Viď supabase/GRANTS.md.
-- =============================================================================

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator noinherit login;
create role supabase_admin nologin;
create role supabase_auth_admin nologin;
create role supabase_storage_admin nologin;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create schema storage;
create schema extensions;
create schema vault;
create extension pgcrypto schema extensions;

-- Supabase: public je Data API schéma; USAGE majú klientske roly vždy.
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- auth
-- -----------------------------------------------------------------------------
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '')
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  is_anonymous boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  not_after timestamptz,
  aal text
);
grant select on auth.users to service_role;

-- -----------------------------------------------------------------------------
-- storage
-- -----------------------------------------------------------------------------
create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  version text,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant select, insert, update, delete on storage.objects, storage.buckets to anon, authenticated, service_role;

create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
create function storage.filename(name text) returns text language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;
create function storage.extension(name text) returns text language plpgsql immutable as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $$;
grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- vault (stub — bez práv pre klientske roly, rovnako ako v Supabase)
-- -----------------------------------------------------------------------------
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);

-- -----------------------------------------------------------------------------
-- Realtime publikácia (chat migrácia do nej pridáva tabuľky)
-- -----------------------------------------------------------------------------
create publication supabase_realtime;
