-- =============================================================================
-- NÁVRH (NEAPLIKOVANÝ, nie je v supabase/migrations): „Trezor súborov“ - automatické kópie súborov
-- v tom istom Supabase projekte. 2026-11-20.
--
-- ČO TO JE: prevádzková ochrana proti omylnému / chybnému / hromadnému zmazaniu alebo prepísaniu
-- súborov cez aplikáciu (a cez kompromitovaný používateľský účet). Kópia sa drží ešte 8 dní po
-- zmazaní alebo prepísaní originálu (≥ 7 dní denných záloh DB Supabase -> súbory sedia s každou
-- obnoviteľnou verziou DB).
-- ČO TO NIE JE: nezávislá záloha. Zmazanie projektu, strata / kompromitácia Supabase účtu alebo
-- service_role kľúča, chyba platformy Storage = strata originálov AJ kópií.
--
-- Prístup: bucket bez jedinej RLS politiky -> anon/authenticated nevidia, nečítajú, nemenia ani nemažú
-- nič (RLS predvolene zakazuje). Evidencia v public.storage_vault_entries: RLS zapnuté, bez politík,
-- bez grantov pre klientske roly. RPC iba service_role (cron vo Verceli). Existujúce politiky sa nemenia.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('esblu-file-vault', 'esblu-file-vault', false, null, null)
on conflict (id) do nothing;

create table if not exists public.storage_vault_entries (
  id bigint generated always as identity primary key,
  source_bucket text not null,
  source_name text not null,
  source_object_id uuid not null,
  source_version text not null,                 -- storage.objects.version, inak čas zmeny
  vault_name text not null unique,              -- <bucket>/<version>/<pôvodná cesta> v esblu-file-vault
  size_bytes bigint,
  copied_at timestamptz not null default now(),
  superseded_at timestamptz,                    -- originál bol prepísaný novšou verziou
  source_deleted_at timestamptz,                -- originál zmazaný (používateľ, ukončenie firmy, výmaz účtu)
  purge_after timestamptz,                      -- kedy sa kópia definitívne zmaže
  purged_at timestamptz,
  constraint storage_vault_entries_bucket_check check (source_bucket in
    ('vehicle-photos','machine-photos','inventory-photos','company-logos','ai-inbox-documents','ai-evidence-documents','chat-attachments')),
  constraint storage_vault_entries_version_unique unique (source_bucket, source_name, source_version)
);
comment on table public.storage_vault_entries is
  'Trezor súborov (návrh 2026-11-20): evidencia kópií v buckete esblu-file-vault. Iba server (service_role). '
  'Nie je nezávislá záloha - zdieľa osud projektu.';
alter table public.storage_vault_entries enable row level security;
revoke all on table public.storage_vault_entries from public, anon, authenticated;
grant select, insert, update on table public.storage_vault_entries to service_role;
create index if not exists storage_vault_entries_purge_idx on public.storage_vault_entries (purge_after) where purged_at is null;

-- Retencia po zmazaní/prepísaní originálu (dni). Jedna hodnota na jednom mieste.
create or replace function public.esblu_storage_vault_retention() returns interval
language sql immutable set search_path = '' as $$ select interval '8 days' $$;

-- 1) Nové alebo zmenené originály, ktoré ešte nemajú kópiu (cron ich skopíruje cez Storage API copy).
create or replace function public.esblu_storage_vault_pending(p_limit integer default 200)
returns table (bucket_id text, name text, object_id uuid, version text, size_bytes bigint, vault_name text)
language sql stable security definer set search_path = '' as $$
  select o.bucket_id, o.name, o.id,
         coalesce(nullif(o.version, ''), to_char(o.updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS')) v,
         nullif(o.metadata ->> 'size', '')::bigint,
         o.bucket_id || '/' || coalesce(nullif(o.version, ''), to_char(o.updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS')) || '/' || o.name
  from storage.objects o
  where o.bucket_id in ('vehicle-photos','machine-photos','inventory-photos','company-logos','ai-inbox-documents','ai-evidence-documents','chat-attachments')
    and not exists (
      select 1 from public.storage_vault_entries e
      where e.source_bucket = o.bucket_id and e.source_name = o.name
        and e.source_version = coalesce(nullif(o.version, ''), to_char(o.updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS')))
  order by o.updated_at
  limit greatest(1, least(p_limit, 1000))
$$;

-- 2) Zápis úspešnej kópie (volá cron po Storage copy).
create or replace function public.esblu_storage_vault_record(
  p_bucket text, p_name text, p_object_id uuid, p_version text, p_vault_name text, p_size bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_vault_entries (source_bucket, source_name, source_object_id, source_version, vault_name, size_bytes)
  values (p_bucket, p_name, p_object_id, p_version, p_vault_name, p_size)
  on conflict (source_bucket, source_name, source_version) do nothing;
  -- staršie verzie toho istého súboru sú prepísané -> retenčná lehota beží
  update public.storage_vault_entries e
     set superseded_at = coalesce(e.superseded_at, now()),
         purge_after = coalesce(e.purge_after, now() + public.esblu_storage_vault_retention())
   where e.source_bucket = p_bucket and e.source_name = p_name and e.source_version <> p_version and e.purged_at is null;
end $$;

-- 3) Zmazané originály: retenčná lehota začne bežať (nič sa nemaže hneď).
create or replace function public.esblu_storage_vault_mark_deleted()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.storage_vault_entries e
     set source_deleted_at = now(), purge_after = coalesce(e.purge_after, now() + public.esblu_storage_vault_retention())
   where e.purged_at is null and e.source_deleted_at is null
     and not exists (select 1 from storage.objects o where o.bucket_id = e.source_bucket and o.name = e.source_name);
  get diagnostics n = row_count;
  return n;
end $$;

-- 4) Kópie po lehote. Poistka: najviac p_limit naraz a nikdy nie kópie aktuálnej verzie existujúceho súboru.
create or replace function public.esblu_storage_vault_purge_candidates(p_limit integer default 200)
returns table (id bigint, vault_name text)
language sql stable security definer set search_path = '' as $$
  select e.id, e.vault_name from public.storage_vault_entries e
  where e.purged_at is null and e.purge_after is not null and e.purge_after < now()
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = e.source_bucket and o.name = e.source_name
        and coalesce(nullif(o.version, ''), to_char(o.updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS')) = e.source_version)
  order by e.purge_after
  limit greatest(1, least(p_limit, 500))
$$;

create or replace function public.esblu_storage_vault_mark_purged(p_ids bigint[])
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.storage_vault_entries set purged_at = now() where id = any (p_ids) and purged_at is null and purge_after < now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.esblu_storage_vault_retention() from public, anon, authenticated;
revoke all on function public.esblu_storage_vault_pending(integer) from public, anon, authenticated;
revoke all on function public.esblu_storage_vault_record(text, text, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.esblu_storage_vault_mark_deleted() from public, anon, authenticated;
revoke all on function public.esblu_storage_vault_purge_candidates(integer) from public, anon, authenticated;
revoke all on function public.esblu_storage_vault_mark_purged(bigint[]) from public, anon, authenticated;
grant execute on function public.esblu_storage_vault_retention() to service_role;
grant execute on function public.esblu_storage_vault_pending(integer) to service_role;
grant execute on function public.esblu_storage_vault_record(text, text, uuid, text, text, bigint) to service_role;
grant execute on function public.esblu_storage_vault_mark_deleted() to service_role;
grant execute on function public.esblu_storage_vault_purge_candidates(integer) to service_role;
grant execute on function public.esblu_storage_vault_mark_purged(bigint[]) to service_role;
