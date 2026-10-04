-- =============================================================================
-- Médiá firmy: jednotný bezpečnostný model (READ/UPLOAD/DELETE + fronta mazania) pre buckety
--   vehicle-photos, machine-photos, inventory-photos, company-logos.
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. Aplikovať iba po výslovnom schválení cez
-- Supabase MCP apply_migration (supabase/MIGRATIONS.md). NIKDY db push.
-- Rollback: supabase/rollback/20261005090000_media_storage_access_model_rollback.sql
-- Existujúce súbory sa NEMAŽÚ ani nepresúvajú (orphan cleanup je samostatný
-- postup: scripts/ops/media-orphan-cleanup.mjs).
--
-- NÁLEZY predprodukčného bezpečnostného auditu (2026-10-04):
--   1) buckety boli `public = true` → verejný endpoint vydal súbor bez RLS,
--   2) READ odvodzoval firmu z priečinka nahrávateľa (nie z DB záznamu),
--   3) UPLOAD do inventory-/machine-photos bez kontroly členstva a roly,
--   4) DELETE fotky stroja smel ktorýkoľvek člen (aj účtovník),
--   5) po zmazaní DB záznamu smel súbor zmazať iba pôvodný nahrávateľ →
--      admin mazajúci cudziu fotku nechal v úložisku osirelý súbor.
--
-- CIEĽOVÝ MODEL (zrkadlí RLS samotných modulov, firma vždy z DB):
--   bucket            | READ                  | UPLOAD               | DELETE                | UPDATE
--   vehicle-photos    | owner/admin/employee  | owner/admin/employee | owner/admin           | nikto
--   machine-photos    | owner/admin/employee  | owner/admin          | owner/admin           | nikto
--   inventory-photos  | owner/admin/employee  | owner/admin          | owner/admin           | nikto
--   company-logos     | každý aktívny člen    | finance.manage       | finance.manage        | nikto
--   (finance.manage = owner, účtovník, admin s finančným oprávnením —
--    rovnako ako zápis do company_billing_profile, kde je logo_path)
--   - vždy iba vlastná aktívna firma; anonym nič; UPDATE (upsert/move)
--     appka nepoužíva → zakázaný (náhrada = nový súbor + zmazanie starého),
--   - UPLOAD iba do vlastného priečinka `<uid>/…`; pri fotkách
--     `<uid>/<id vozidla|stroja|položky>/<súbor>` a entita musí patriť do
--     firmy volajúceho — zmena cesty kontrolu neobíde,
--   - nereferencovaný (rozpracovaný) súbor: číta/maže iba nahrávateľ,
--   - ZMAZANIE: zmazanie DB záznamu fotky (aj kaskádou) alebo výmena loga
--     zapíše objekt do public.media_deletion_queue (v tej istej DB
--     transakcii). Kým je objekt vo fronte, smie ho zmazať oprávnený
--     owner/admin (logo: finance.manage) tej firmy — bez ohľadu na to, kto
--     ho nahral. RPC esblu_media_deletion_sweep() vráti ešte nevymazané
--     položky a označí hotové tie, ktoré v úložisku už nie sú. Zlyhanie
--     mazania v Storage teda nikdy nezanechá súbor bez evidencie a opakovanie
--     je bezpečné (idempotentné).
--
-- IDEMPOTENTNÉ: create … if not exists / create or replace / drop … if exists.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Fronta mazania súborov (evidencia, nie mazanie)
-- -----------------------------------------------------------------------------
create table if not exists public.media_deletion_queue (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bucket_id text not null check (bucket_id in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos')),
  object_path text not null check (btrim(object_path) <> ''),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  unique (bucket_id, object_path)
);

comment on table public.media_deletion_queue is
  'Súbory médií, ktorých DB referencia bola odstránená a ktoré treba zmazať zo Storage (20261005090000). Zapisujú iba triggre; klient iba číta cez esblu_media_deletion_sweep().';

alter table public.media_deletion_queue enable row level security;
revoke all on public.media_deletion_queue from public, anon, authenticated;
-- Žiadna klientska politika: prístup iba cez SECURITY DEFINER funkcie nižšie.

create index if not exists media_deletion_queue_pending_idx
  on public.media_deletion_queue (company_id, bucket_id)
  where completed_at is null;

-- -----------------------------------------------------------------------------
-- 2) Pomocné funkcie
-- -----------------------------------------------------------------------------

-- Firma a stav referencií objektu podľa DB (autoritatívne, mimo RLS).
create or replace function public.esblu_media_object_owner(p_bucket text, p_object_name text)
returns table (referenced_rows integer, null_company_rows integer, distinct_companies integer, company_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_ids uuid[];
begin
  if p_bucket = 'vehicle-photos' then
    select count(*), count(*) filter (where vp.company_id is null), count(distinct vp.company_id),
           array_agg(distinct vp.company_id) filter (where vp.company_id is not null)
      into referenced_rows, null_company_rows, distinct_companies, v_ids
      from public.vehicle_photos vp
     where vp.storage_bucket = 'vehicle-photos' and vp.storage_path = p_object_name;
  elsif p_bucket = 'machine-photos' then
    select count(*), count(*) filter (where mp.company_id is null), count(distinct mp.company_id),
           array_agg(distinct mp.company_id) filter (where mp.company_id is not null)
      into referenced_rows, null_company_rows, distinct_companies, v_ids
      from public.machine_photos mp
     where mp.file_path = p_object_name;
  elsif p_bucket = 'inventory-photos' then
    select count(*), count(*) filter (where ip.company_id is null), count(distinct ip.company_id),
           array_agg(distinct ip.company_id) filter (where ip.company_id is not null)
      into referenced_rows, null_company_rows, distinct_companies, v_ids
      from public.inventory_photos ip
     where ip.file_path = p_object_name;
  elsif p_bucket = 'company-logos' then
    select count(*), count(*) filter (where b.company_id is null), count(distinct b.company_id),
           array_agg(distinct b.company_id) filter (where b.company_id is not null)
      into referenced_rows, null_company_rows, distinct_companies, v_ids
      from public.company_billing_profile b
     where b.logo_path = p_object_name;
  else
    referenced_rows := 0; null_company_rows := 0; distinct_companies := 0;
  end if;
  company_id := v_ids[1];
  return next;
end;
$function$;

revoke all on function public.esblu_media_object_owner(text, text) from public, anon, authenticated;

-- Smie volajúci v SVOJEJ aktívnej firme vykonať operáciu nad médiom daného bucketu?
create or replace function public.esblu_media_role_allows(p_bucket text, p_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public.esblu_my_active_role();
begin
  if v_role is null then
    return false;
  end if;

  if p_bucket = 'company-logos' then
    if p_action = 'read' then return true; end if;
    if p_action in ('upload', 'delete') then return public.esblu_my_finance_manage(); end if;
    return false;
  end if;

  if p_bucket not in ('vehicle-photos', 'machine-photos', 'inventory-photos') then
    return false;
  end if;

  if p_action = 'read' then
    return v_role in ('owner', 'admin', 'employee');
  end if;

  if p_action = 'upload' then
    if p_bucket = 'vehicle-photos' then
      return v_role in ('owner', 'admin', 'employee');
    end if;
    return v_role in ('owner', 'admin');
  end if;

  if p_action = 'delete' then
    return v_role in ('owner', 'admin');
  end if;

  return false;
end;
$function$;

revoke all on function public.esblu_media_role_allows(text, text) from public, anon;
grant execute on function public.esblu_media_role_allows(text, text) to authenticated, service_role;

-- Firma, v ktorej fronte objekt čaká na zmazanie (NULL = nečaká).
create or replace function public.esblu_media_deletion_pending_company(p_bucket text, p_object_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select q.company_id
    from public.media_deletion_queue q
   where q.bucket_id = p_bucket
     and q.object_path = p_object_name
     and q.completed_at is null
   limit 1;
$function$;

revoke all on function public.esblu_media_deletion_pending_company(text, text) from public, anon, authenticated;

-- READ
create or replace function public.esblu_can_read_media_object(p_bucket text, p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_ref record;
  v_my_company_id uuid;
begin
  if v_uid is null or p_object_name is null or btrim(p_object_name) = '' then
    return false;
  end if;
  if p_bucket not in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos') then
    return false;
  end if;

  select * into v_ref from public.esblu_media_object_owner(p_bucket, p_object_name);
  v_my_company_id := public.esblu_my_active_company_id();

  if v_ref.referenced_rows = 0 then
    -- Objekt vo fronte mazania (jeho záznam bol zmazaný): viditeľný IBA pre
    -- toho, kto ho smie zmazať v tej firme (Supabase remove() vyžaduje aj
    -- SELECT). Pôvodný nahrávateľ tu už nemá výnimku.
    if public.esblu_media_deletion_pending_company(p_bucket, p_object_name) is not null then
      return public.esblu_media_deletion_pending_company(p_bucket, p_object_name) = v_my_company_id
         and public.esblu_media_role_allows(p_bucket, 'delete');
    end if;
    -- Rozpracovaný upload (nikdy nereferencovaný): iba pôvodný nahrávateľ.
    return (storage.foldername(p_object_name))[1] = v_uid::text;
  end if;

  if v_ref.null_company_rows > 0 or v_ref.distinct_companies <> 1 then
    return false;
  end if;

  if v_my_company_id is null or v_ref.company_id is distinct from v_my_company_id then
    return false;
  end if;

  return public.esblu_media_role_allows(p_bucket, 'read');
end;
$function$;

revoke all on function public.esblu_can_read_media_object(text, text) from public, anon;
grant execute on function public.esblu_can_read_media_object(text, text) to authenticated, service_role;

-- UPLOAD
create or replace function public.esblu_can_upload_media_object(p_bucket text, p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_parts text[];
  v_my_company_id uuid;
  v_entity_id uuid;
  v_entity_ok boolean;
begin
  if v_uid is null or p_object_name is null or btrim(p_object_name) = '' then
    return false;
  end if;

  v_parts := string_to_array(p_object_name, '/');
  if v_parts[1] is distinct from v_uid::text then
    return false;
  end if;
  if exists (select 1 from unnest(v_parts) s where s = '' or s = '.' or s = '..') then
    return false;
  end if;

  v_my_company_id := public.esblu_my_active_company_id();
  if v_my_company_id is null or not public.esblu_media_role_allows(p_bucket, 'upload') then
    return false;
  end if;

  -- Nikdy neprepísať objekt, ktorý už niečo referencuje.
  if (select o.referenced_rows from public.esblu_media_object_owner(p_bucket, p_object_name) o) > 0 then
    return false;
  end if;

  if p_bucket = 'company-logos' then
    -- `<uid>/<súbor>`
    return array_length(v_parts, 1) = 2;
  end if;

  -- Fotky: `<uid>/<id entity>/<súbor>` a entita patrí do mojej firmy.
  if array_length(v_parts, 1) <> 3 or v_parts[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_entity_id := v_parts[2]::uuid;

  if p_bucket = 'vehicle-photos' then
    select exists (select 1 from public.vehicles v where v.id = v_entity_id and v.company_id = v_my_company_id) into v_entity_ok;
  elsif p_bucket = 'machine-photos' then
    select exists (select 1 from public.machines m where m.id = v_entity_id and m.company_id = v_my_company_id) into v_entity_ok;
  elsif p_bucket = 'inventory-photos' then
    select exists (select 1 from public.inventory_items i where i.id = v_entity_id and i.company_id = v_my_company_id) into v_entity_ok;
  else
    v_entity_ok := false;
  end if;

  return coalesce(v_entity_ok, false);
end;
$function$;

revoke all on function public.esblu_can_upload_media_object(text, text) from public, anon;
grant execute on function public.esblu_can_upload_media_object(text, text) to authenticated, service_role;

-- DELETE
create or replace function public.esblu_can_delete_media_object(p_bucket text, p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_ref record;
  v_my_company_id uuid;
begin
  if v_uid is null or p_object_name is null or btrim(p_object_name) = '' then
    return false;
  end if;
  if p_bucket not in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos') then
    return false;
  end if;

  v_my_company_id := public.esblu_my_active_company_id();
  select * into v_ref from public.esblu_media_object_owner(p_bucket, p_object_name);

  if v_ref.referenced_rows = 0 then
    -- a) objekt čaká vo fronte mazania: iba oprávnená rola TEJ firmy
    --    (bez ohľadu na to, kto súbor nahral)
    if public.esblu_media_deletion_pending_company(p_bucket, p_object_name) is not null then
      return public.esblu_media_deletion_pending_company(p_bucket, p_object_name) = v_my_company_id
         and public.esblu_media_role_allows(p_bucket, 'delete');
    end if;
    -- b) vlastný rozpracovaný upload (upratanie po zlyhanom zápise)
    return (storage.foldername(p_object_name))[1] = v_uid::text;
  end if;

  if v_ref.null_company_rows > 0 or v_ref.distinct_companies <> 1 then
    return false;
  end if;
  if v_my_company_id is null or v_ref.company_id is distinct from v_my_company_id then
    return false;
  end if;

  return public.esblu_media_role_allows(p_bucket, 'delete');
end;
$function$;

revoke all on function public.esblu_can_delete_media_object(text, text) from public, anon;
grant execute on function public.esblu_can_delete_media_object(text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3) Triggre: zmazanie / výmena referencie → fronta (v tej istej transakcii)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_enqueue_media_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_bucket text := tg_argv[0];
  v_path text;
  v_new_path text;
  v_company uuid;
begin
  if tg_table_name = 'vehicle_photos' then
    v_path := old.storage_path;
    v_new_path := case when tg_op = 'UPDATE' then new.storage_path end;
    if old.storage_bucket is distinct from 'vehicle-photos' then
      return null;
    end if;
  elsif tg_table_name in ('machine_photos', 'inventory_photos') then
    v_path := old.file_path;
    v_new_path := case when tg_op = 'UPDATE' then new.file_path end;
  elsif tg_table_name = 'company_billing_profile' then
    v_path := old.logo_path;
    v_new_path := case when tg_op = 'UPDATE' then new.logo_path end;
  else
    return null;
  end if;

  v_company := old.company_id;

  if v_path is null or btrim(v_path) = '' or v_company is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and v_new_path is not distinct from v_path then
    return null;
  end if;
  -- Firma už neexistuje (zmazanie firmy) — súbory rieši zrušenie účtu.
  if not exists (select 1 from public.companies c where c.id = v_company) then
    return null;
  end if;
  -- Objekt stále referencuje iný záznam → nemazať.
  if (select o.referenced_rows from public.esblu_media_object_owner(v_bucket, v_path) o) > 0 then
    return null;
  end if;

  insert into public.media_deletion_queue (company_id, bucket_id, object_path, requested_by)
  values (v_company, v_bucket, v_path, auth.uid())
  on conflict (bucket_id, object_path) do update
    set company_id = excluded.company_id,
        requested_by = excluded.requested_by,
        requested_at = now(),
        completed_at = null;

  return null;
end;
$function$;

revoke all on function public.esblu_enqueue_media_deletion() from public, anon, authenticated;

drop trigger if exists esblu_media_deletion_vehicle_photos on public.vehicle_photos;
create trigger esblu_media_deletion_vehicle_photos
  after delete or update of storage_path on public.vehicle_photos
  for each row execute function public.esblu_enqueue_media_deletion('vehicle-photos');

drop trigger if exists esblu_media_deletion_machine_photos on public.machine_photos;
create trigger esblu_media_deletion_machine_photos
  after delete or update of file_path on public.machine_photos
  for each row execute function public.esblu_enqueue_media_deletion('machine-photos');

drop trigger if exists esblu_media_deletion_inventory_photos on public.inventory_photos;
create trigger esblu_media_deletion_inventory_photos
  after delete or update of file_path on public.inventory_photos
  for each row execute function public.esblu_enqueue_media_deletion('inventory-photos');

drop trigger if exists esblu_media_deletion_company_logo on public.company_billing_profile;
create trigger esblu_media_deletion_company_logo
  after delete or update of logo_path on public.company_billing_profile
  for each row execute function public.esblu_enqueue_media_deletion('company-logos');

-- -----------------------------------------------------------------------------
-- 4) RPC: dokončenie / opakovanie mazania (idempotentné)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_media_deletion_sweep(p_limit integer default 100)
returns table (bucket_id text, object_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_company uuid := public.esblu_my_active_company_id();
begin
  if auth.uid() is null or v_company is null then
    return;
  end if;

  -- 1) Hotové: objekt v úložisku už nie je.
  update public.media_deletion_queue q
     set completed_at = now()
   where q.company_id = v_company
     and q.completed_at is null
     and public.esblu_media_role_allows(q.bucket_id, 'delete')
     and not exists (select 1 from storage.objects o where o.bucket_id = q.bucket_id and o.name = q.object_path);

  -- 2) Zostávajúce: vrátiť na zmazanie a zaznamenať pokus.
  return query
  with pending as (
    select q.id
      from public.media_deletion_queue q
     where q.company_id = v_company
       and q.completed_at is null
       and public.esblu_media_role_allows(q.bucket_id, 'delete')
     order by q.requested_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ), touched as (
    update public.media_deletion_queue q
       set attempts = q.attempts + 1, last_attempt_at = now()
      from pending p
     where q.id = p.id
    returning q.bucket_id, q.object_path
  )
  select t.bucket_id, t.object_path from touched t;
end;
$function$;

revoke all on function public.esblu_media_deletion_sweep(integer) from public, anon;
grant execute on function public.esblu_media_deletion_sweep(integer) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5) Storage politiky: jednotný model (staré politiky týchto 4 bucketov preč)
-- -----------------------------------------------------------------------------
drop policy if exists vehicle_photos_select_company on storage.objects;
drop policy if exists vehicle_photos_insert_active_member on storage.objects;
drop policy if exists vehicle_photos_delete_owner_admin on storage.objects;
drop policy if exists machine_photos_select_company on storage.objects;
drop policy if exists machine_photos_insert_own on storage.objects;
drop policy if exists machine_photos_update_own on storage.objects;
drop policy if exists machine_photos_delete_company on storage.objects;
drop policy if exists inventory_photos_select_company on storage.objects;
drop policy if exists "Users can upload inventory photos" on storage.objects;
drop policy if exists "Users can update inventory photos" on storage.objects;
drop policy if exists inventory_photos_delete_company on storage.objects;
drop policy if exists company_logos_select_company on storage.objects;
drop policy if exists company_logos_insert_owner_admin on storage.objects;
drop policy if exists company_logos_update_owner_admin on storage.objects;
drop policy if exists company_logos_delete_owner_admin on storage.objects;

drop policy if exists media_select_scoped on storage.objects;
drop policy if exists media_insert_scoped on storage.objects;
drop policy if exists media_delete_scoped on storage.objects;

create policy media_select_scoped on storage.objects
  for select to authenticated
  using (
    bucket_id in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos')
    and public.esblu_can_read_media_object(bucket_id, name)
  );

create policy media_insert_scoped on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos')
    and public.esblu_can_upload_media_object(bucket_id, name)
  );

create policy media_delete_scoped on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos')
    and public.esblu_can_delete_media_object(bucket_id, name)
  );

-- UPDATE (upsert/move) pre tieto buckety zámerne bez politiky = zakázané.

-- Buckety sa prepínajú na súkromné až v nadväzujúcej migrácii
-- 20261005091000_private_media_buckets.sql (po nasadení appky s podpísanými URL).
