-- =============================================================================
-- NÁVRH (NEAPLIKOVANÝ, nie je v supabase/migrations): „Trezor súborov“ - prevádzkové kópie súborov
-- v tom istom Supabase projekte. 2026-11-20, v2.
--
-- ČO TO JE: ochrana proti omylnému / chybnému / hromadnému zmazaniu alebo prepísaniu súborov cez
-- aplikáciu, kompromitovaný používateľský účet alebo chybu serverovej úlohy. Kópia vzniká do ~1 min
-- po nahratí (trigger -> fronta -> cron každú minútu), hodinová kontrola dopĺňa chýbajúce.
-- Bežné zmazanie / prepísanie: kópia ešte 8 dní (≥ 7 dní denných záloh DB). Definitívny výmaz
-- (zrušenie účtu, ukončenie firmy): kópie sa mažú v tom istom cleanup jobe (lehota 0 - na rozhodnutie CLIA).
-- ČO TO NIE JE: nezávislá záloha ani zákonný účtovný archív. Strata projektu / účtu Supabase /
-- service_role kľúča alebo chyba platformy = strata originálov AJ kópií.
--
-- Prístup: bucket bez RLS politiky; tabuľky RLS bez politík a bez grantov pre klientov; RPC iba service_role;
-- trigger je SECURITY DEFINER a NIKDY neblokuje nahratie súboru. Existujúce politiky sa nemenia.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('esblu-file-vault', 'esblu-file-vault', false, null, null)
on conflict (id) do nothing;

-- Pokryté buckety (všetky súkromné buckety Esblu okrem samotného trezora). Jedno miesto pravdy.
create or replace function public.esblu_storage_vault_buckets() returns text[]
language sql immutable set search_path = '' as $$
  select array['vehicle-photos','machine-photos','inventory-photos','company-logos','ai-inbox-documents',
               'ai-evidence-documents','chat-attachments','einvoice-documents','billing-documents']::text[]
$$;
create or replace function public.esblu_storage_vault_retention() returns interval
language sql immutable set search_path = '' as $$ select interval '8 days' $$;          -- bežné zmazanie / prepísanie
create or replace function public.esblu_storage_vault_erasure_delay() returns interval
language sql immutable set search_path = '' as $$ select interval '0 days' $$;          -- definitívny výmaz (CLIA)
create or replace function public.esblu_storage_vault_version(p_version text, p_updated_at timestamptz) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(p_version, ''), to_char(p_updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS'))
$$;

create table if not exists public.storage_vault_entries (
  id bigint generated always as identity primary key,
  source_bucket text not null,
  source_name text not null,
  source_object_id uuid not null,
  source_version text not null,
  vault_name text not null unique,                 -- <bucket>/<verzia>/<pôvodná cesta>
  size_bytes bigint,
  etag text,
  copied_at timestamptz not null default now(),
  superseded_at timestamptz,
  source_deleted_at timestamptz,
  erasure_requested_at timestamptz,                -- definitívny výmaz (nie bežné zmazanie)
  erasure_reason text,
  purge_after timestamptz,
  purged_at timestamptz,
  constraint storage_vault_entries_version_unique unique (source_bucket, source_name, source_version),
  constraint storage_vault_entries_reason_check check (erasure_reason is null or erasure_reason ~ '^[A-Z0-9_]{1,60}$')
);
create table if not exists public.storage_vault_queue (
  id bigint generated always as identity primary key,
  source_bucket text not null,
  source_name text not null,
  source_object_id uuid,
  source_version text not null,
  enqueued_at timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_owner uuid,
  lease_until timestamptz,
  last_error text,
  done_at timestamptz,
  outcome text,
  constraint storage_vault_queue_unique unique (source_bucket, source_name, source_version),
  constraint storage_vault_queue_error_check check (last_error is null or last_error ~ '^[A-Z0-9_:]{1,80}$')
);
create table if not exists public.storage_vault_guard (
  id boolean primary key default true check (id),
  purge_paused_until timestamptz,
  pause_reason text,
  last_mass_delete_count integer,
  updated_at timestamptz not null default now()
);
insert into public.storage_vault_guard (id) values (true) on conflict do nothing;

comment on table public.storage_vault_entries is 'Trezor súborov (návrh): evidencia prevádzkových kópií v buckete esblu-file-vault. Iba server. Nie je nezávislá záloha ani zákonný archív.';
do $$ declare t text; begin
  foreach t in array array['storage_vault_entries','storage_vault_queue','storage_vault_guard'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on table public.%I to service_role', t);
  end loop;
end $$;
create index if not exists storage_vault_entries_purge_idx on public.storage_vault_entries (purge_after) where purged_at is null;
create index if not exists storage_vault_queue_due_idx on public.storage_vault_queue (next_attempt_at) where done_at is null;

-- -----------------------------------------------------------------------------
-- Trigger: nahratie / prepísanie súboru -> fronta. Nikdy neblokuje upload (chýbajúcu kópiu doplní kontrola).
-- -----------------------------------------------------------------------------
create or replace function public.esblu_storage_vault_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.bucket_id = any (public.esblu_storage_vault_buckets()) then
      insert into public.storage_vault_queue (source_bucket, source_name, source_object_id, source_version)
      values (new.bucket_id, new.name, new.id, public.esblu_storage_vault_version(new.version, new.updated_at))
      on conflict (source_bucket, source_name, source_version) do nothing;
    end if;
  exception when others then
    null;
  end;
  return null;
end $$;
drop trigger if exists esblu_storage_vault_enqueue on storage.objects;
create trigger esblu_storage_vault_enqueue after insert or update of version, name, metadata on storage.objects
  for each row execute function public.esblu_storage_vault_enqueue();

-- -----------------------------------------------------------------------------
-- Worker (cron každú minútu): claim -> Storage copy -> record (overenie) / fail (backoff).
-- -----------------------------------------------------------------------------
create or replace function public.esblu_storage_vault_claim(p_owner uuid, p_limit integer default 50)
returns table (queue_id bigint, bucket_id text, name text, version text, vault_name text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with picked as (
    select q.id from public.storage_vault_queue q
    where q.done_at is null and q.next_attempt_at <= now() and q.attempts < 10
      and (q.lease_until is null or q.lease_until < now())
    order by q.next_attempt_at
    limit greatest(1, least(p_limit, 200))
    for update skip locked
  )
  update public.storage_vault_queue q set lease_owner = p_owner, lease_until = now() + interval '5 minutes'
  from picked where q.id = picked.id
  returning q.id, q.source_bucket, q.source_name, q.source_version, q.source_bucket || '/' || q.source_version || '/' || q.source_name;
end $$;

-- Overenie po kópii: originál má stále TÚ ISTÚ verziu a kópia má rovnakú veľkosť aj eTag.
-- Výsledky: ok | stale (originál medzičasom zmenený/zmazaný -> worker kópiu zahodí) | mismatch (worker kópiu zahodí, retry).
create or replace function public.esblu_storage_vault_record(p_queue_id bigint, p_owner uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare q public.storage_vault_queue; s record; v record; vname text;
begin
  select * into q from public.storage_vault_queue where id = p_queue_id and lease_owner = p_owner and done_at is null for update;
  if not found then return 'not_leased'; end if;
  vname := q.source_bucket || '/' || q.source_version || '/' || q.source_name;
  select o.id, o.metadata into s from storage.objects o
   where o.bucket_id = q.source_bucket and o.name = q.source_name
     and public.esblu_storage_vault_version(o.version, o.updated_at) = q.source_version;
  if not found then
    update public.storage_vault_queue set done_at = now(), outcome = 'stale', lease_owner = null, lease_until = null where id = q.id;
    return 'stale';
  end if;
  select o.metadata into v from storage.objects o where o.bucket_id = 'esblu-file-vault' and o.name = vname;
  if not found or (v.metadata ->> 'size') is distinct from (s.metadata ->> 'size')
     or (v.metadata ->> 'eTag') is distinct from (s.metadata ->> 'eTag') then
    update public.storage_vault_queue set attempts = attempts + 1, last_error = 'COPY_MISMATCH',
      next_attempt_at = now() + least(interval '6 hours', interval '1 minute' * power(2, attempts)), lease_owner = null, lease_until = null
     where id = q.id;
    return 'mismatch';
  end if;
  insert into public.storage_vault_entries (source_bucket, source_name, source_object_id, source_version, vault_name, size_bytes, etag)
  values (q.source_bucket, q.source_name, s.id, q.source_version, vname, nullif(s.metadata ->> 'size', '')::bigint, s.metadata ->> 'eTag')
  on conflict (source_bucket, source_name, source_version) do nothing;
  update public.storage_vault_entries e
     set superseded_at = coalesce(e.superseded_at, now()), purge_after = coalesce(e.purge_after, now() + public.esblu_storage_vault_retention())
   where e.source_bucket = q.source_bucket and e.source_name = q.source_name and e.source_version <> q.source_version and e.purged_at is null;
  update public.storage_vault_queue set done_at = now(), outcome = 'ok', lease_owner = null, lease_until = null where id = q.id;
  return 'ok';
end $$;

create or replace function public.esblu_storage_vault_fail(p_queue_id bigint, p_owner uuid, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.storage_vault_queue
     set attempts = attempts + 1, last_error = case when p_error ~ '^[A-Z0-9_:]{1,80}$' then p_error else 'COPY_FAILED' end,
         next_attempt_at = now() + least(interval '6 hours', interval '1 minute' * power(2, attempts)), lease_owner = null, lease_until = null
   where id = p_queue_id and lease_owner = p_owner and done_at is null
$$;

-- -----------------------------------------------------------------------------
-- Hodinová kontrola: doplní chýbajúce kópie do fronty, označí zmazané originály, poistka hromadného zmazania.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_storage_vault_reconcile(p_mass_delete_min integer default 20, p_mass_delete_ratio numeric default 0.2)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_missing integer; v_deleted integer; v_live integer; v_paused boolean := false;
begin
  insert into public.storage_vault_queue (source_bucket, source_name, source_object_id, source_version)
  select o.bucket_id, o.name, o.id, public.esblu_storage_vault_version(o.version, o.updated_at)
    from storage.objects o
   where o.bucket_id = any (public.esblu_storage_vault_buckets())
     and not exists (select 1 from public.storage_vault_entries e where e.source_bucket = o.bucket_id and e.source_name = o.name
                       and e.source_version = public.esblu_storage_vault_version(o.version, o.updated_at))
  on conflict (source_bucket, source_name, source_version) do update
     set done_at = null, outcome = null, attempts = 0, next_attempt_at = now()
   where public.storage_vault_queue.done_at is not null or public.storage_vault_queue.attempts >= 10;
  get diagnostics v_missing = row_count;

  update public.storage_vault_entries e
     set source_deleted_at = now(), purge_after = coalesce(e.purge_after, now() + public.esblu_storage_vault_retention())
   where e.purged_at is null and e.source_deleted_at is null
     and not exists (select 1 from storage.objects o where o.bucket_id = e.source_bucket and o.name = e.source_name);
  get diagnostics v_deleted = row_count;

  select count(*) into v_live from storage.objects o where o.bucket_id = any (public.esblu_storage_vault_buckets());
  if v_deleted >= p_mass_delete_min and v_deleted > p_mass_delete_ratio * (v_live + v_deleted) then
    update public.storage_vault_guard set purge_paused_until = now() + interval '48 hours', pause_reason = 'MASS_DELETE',
           last_mass_delete_count = v_deleted, updated_at = now();
    v_paused := true;
  end if;
  return jsonb_build_object('enqueued', v_missing, 'source_deleted', v_deleted, 'live_objects', v_live, 'mass_delete_pause', v_paused,
    'dead_queue', (select count(*) from public.storage_vault_queue where done_at is null and attempts >= 10),
    'oldest_pending_minutes', (select coalesce(extract(epoch from now() - min(enqueued_at)) / 60, 0)::int from public.storage_vault_queue where done_at is null));
end $$;

-- Definitívny výmaz (volá cleanup job zrušenia účtu / ukončenia firmy s TÝMI ISTÝMI cieľmi ako originály).
create or replace function public.esblu_storage_vault_erase(p_targets jsonb, p_reason text)
returns table (id bigint, vault_name text) language plpgsql security definer set search_path = '' as $$
begin
  if p_reason !~ '^[A-Z0-9_]{1,60}$' then raise exception 'ESBLU_VAULT_ERASE_REASON'; end if;
  update public.storage_vault_queue q set done_at = now(), outcome = 'erased', lease_owner = null, lease_until = null
   from jsonb_to_recordset(p_targets) t(bucket text, path text)
   where q.done_at is null and q.source_bucket = t.bucket and q.source_name = t.path;
  return query
  update public.storage_vault_entries e
     set erasure_requested_at = coalesce(e.erasure_requested_at, now()), erasure_reason = coalesce(e.erasure_reason, p_reason),
         purge_after = now() + public.esblu_storage_vault_erasure_delay()
    from jsonb_to_recordset(p_targets) t(bucket text, path text)
   where e.purged_at is null and e.source_bucket = t.bucket and e.source_name = t.path
  returning e.id, e.vault_name;
end $$;

-- Kópie na zmazanie: po lehote, nikdy aktuálna verzia existujúceho súboru, limit; pri pozastavení
-- (hromadné zmazanie) iba definitívne výmazy.
create or replace function public.esblu_storage_vault_purge_candidates(p_limit integer default 200)
returns table (id bigint, vault_name text)
language sql stable security definer set search_path = '' as $$
  select e.id, e.vault_name from public.storage_vault_entries e
  where e.purged_at is null and e.purge_after is not null and e.purge_after <= now()
    and (e.erasure_requested_at is not null
         or coalesce((select g.purge_paused_until from public.storage_vault_guard g), '-infinity') < now())
    and not exists (select 1 from storage.objects o where o.bucket_id = e.source_bucket and o.name = e.source_name
                      and public.esblu_storage_vault_version(o.version, o.updated_at) = e.source_version)
  order by e.erasure_requested_at nulls last, e.purge_after
  limit greatest(1, least(p_limit, 500))
$$;

create or replace function public.esblu_storage_vault_mark_purged(p_ids bigint[])
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.storage_vault_entries set purged_at = now() where id = any (p_ids) and purged_at is null and purge_after <= now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.esblu_storage_vault_resume_purge()
returns void language sql security definer set search_path = '' as $$
  update public.storage_vault_guard set purge_paused_until = null, pause_reason = null, updated_at = now()
$$;

-- Obnova: verzie zmazaných / prepísaných súborov podľa bucketu, prefixu cesty a času (operátor).
create or replace function public.esblu_storage_vault_restore_plan(p_bucket text, p_prefix text, p_since timestamptz)
returns table (id bigint, source_bucket text, source_name text, source_version text, vault_name text, size_bytes bigint, etag text)
language sql stable security definer set search_path = '' as $$
  select distinct on (e.source_bucket, e.source_name) e.id, e.source_bucket, e.source_name, e.source_version, e.vault_name, e.size_bytes, e.etag
  from public.storage_vault_entries e
  where e.purged_at is null and e.erasure_requested_at is null
    and e.source_bucket = p_bucket and e.source_name like replace(replace(p_prefix, '%', '\%'), '_', '\_') || '%'
    and (e.source_deleted_at >= p_since or e.superseded_at >= p_since)
  order by e.source_bucket, e.source_name, e.copied_at desc
$$;

do $$ declare f text; begin
  foreach f in array array[
    'esblu_storage_vault_buckets()','esblu_storage_vault_retention()','esblu_storage_vault_erasure_delay()',
    'esblu_storage_vault_version(text, timestamptz)','esblu_storage_vault_enqueue()',
    'esblu_storage_vault_claim(uuid, integer)','esblu_storage_vault_record(bigint, uuid)','esblu_storage_vault_fail(bigint, uuid, text)',
    'esblu_storage_vault_reconcile(integer, numeric)','esblu_storage_vault_erase(jsonb, text)',
    'esblu_storage_vault_purge_candidates(integer)','esblu_storage_vault_mark_purged(bigint[])',
    'esblu_storage_vault_resume_purge()','esblu_storage_vault_restore_plan(text, text, timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
