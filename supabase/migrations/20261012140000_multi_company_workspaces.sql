-- =============================================================================
-- Multi-company / workspace model (FORWARD-ONLY, 2026-10-12) — NEAPLIKOVANÉ.
--
-- USER != COMPANY. Jeden auth používateľ môže byť aktívnym členom N firiem,
-- v každej s inou rolou (owner / admin / accountant / employee). Medzi firmami
-- sa prepína (bez odhlásenia).
--
-- Pred touto migráciou:
--   - unikátny index company_members_one_active_per_user_idx = max 1 aktívne
--     členstvo na používateľa,
--   - esblu_my_active_company_id() a ~30 ďalších funkcií hľadali „moje"
--     členstvo cez `where user_id = auth.uid() and status = 'active' limit 1`
--     (deterministické iba vďaka indexu vyššie).
--
-- Po migrácii:
--   - public.user_active_company = explicitná, serverom validovaná voľba
--     aktívnej firmy (1 riadok na používateľa). Zapisuje IBA
--     esblu_set_my_active_company / esblu_create_my_company / prijatie pozvánky.
--   - esblu_my_active_company_id(): uložená voľba, AK používateľ v tej firme
--     stále má aktívne členstvo; inak jediné aktívne členstvo; inak NULL
--     (2+ členstvá bez platnej voľby → klient ukáže výber firmy). Nikdy LIMIT 1.
--   - všetky funkcie „môjho členstva" filtrujú aj company_id = aktívna firma,
--     takže RLS aj SECURITY DEFINER RPC pracujú VÝHRADNE v aktívnej firme;
--     členstvo (company_members) ostáva finálnou autoritou.
--   - presne jeden aktívny owner na firmu (unikátny index + guard proti
--     odobratiu poslednej owner role).
--   - billing authority = OWNER (esblu_billing_my_access): admin s
--     permissions.billing.manage už nesmie kupovať / meniť predplatné
--     (explicitná zmena politiky, pozri docs/multi-company-architecture-2026-10-12.md).
--   - zrušenie: odchod z firmy ≠ zrušenie firmy ≠ zrušenie globálneho účtu.
--
-- Backfill: každé existujúce aktívne členstvo (max 1 na používateľa) sa zapíše
-- ako aktívna firma → existujúci používatelia fungujú bez zmeny.
-- Nič sa nemaže. Rollback: supabase/rollback/20261012140000_multi_company_workspaces_rollback.sql
-- (možný iba kým žiadny používateľ nemá 2+ aktívne členstvá).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Aktívna firma používateľa (preferencia so serverovou validáciou)
-- -----------------------------------------------------------------------------
create table if not exists public.user_active_company (
  user_id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  updated_at timestamptz not null default now()
);

comment on table public.user_active_company is
  'Voľba aktívnej firmy (workspace) používateľa. Iba preferencia: platí len ak má používateľ v firme '
  'aktívne členstvo (esblu_my_active_company_id). Zapisujú IBA SECURITY DEFINER RPC.';

alter table public.user_active_company enable row level security;
revoke all on table public.user_active_company from public, anon, authenticated;
grant select on table public.user_active_company to authenticated;
grant select, insert, update, delete on table public.user_active_company to service_role;

drop policy if exists user_active_company_select_own on public.user_active_company;
create policy user_active_company_select_own on public.user_active_company
  for select to authenticated using (user_id = (select auth.uid()));

-- Backfill (deterministický): existujúce jediné aktívne členstvo = aktívna firma.
insert into public.user_active_company (user_id, company_id)
select cm.user_id, (array_agg(cm.company_id order by cm.created_at, cm.company_id))[1]
from public.company_members cm
where cm.status = 'active'
group by cm.user_id
on conflict (user_id) do nothing;

-- -----------------------------------------------------------------------------
-- 2) Členstvá: N firiem na používateľa, presne 1 aktívny owner na firmu
-- -----------------------------------------------------------------------------
drop index if exists public.company_members_one_active_per_user_idx;

create unique index if not exists company_members_one_owner_per_company_idx
  on public.company_members (company_id)
  where role = 'owner' and status = 'active';

create index if not exists company_members_user_active_idx
  on public.company_members (user_id, company_id)
  where status = 'active';

-- Posledného aktívneho ownera nemožno zmeniť na inú rolu ani deaktivovať
-- (ownership transfer zatiaľ neexistuje). Zrušenie celej firmy (DELETE) je
-- samostatný flow (esblu_owner_delete_company) a týmto guardom nie je dotknuté.
create or replace function public.esblu_company_members_owner_guard()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if old.role = 'owner' and old.status = 'active'
     and (new.role is distinct from 'owner' or new.status is distinct from 'active' or new.company_id is distinct from old.company_id)
     and coalesce(current_setting('esblu.allow_owner_change', true), '') <> 'on' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_COMPANY_MUST_KEEP_OWNER',
      hint = 'Firma musí mať práve jedného aktívneho ownera; prevod vlastníctva zatiaľ nie je podporovaný.';
  end if;
  return new;
end
$function$;

revoke all on function public.esblu_company_members_owner_guard() from public, anon, authenticated;

drop trigger if exists company_members_owner_guard on public.company_members;
create trigger company_members_owner_guard
  before update on public.company_members
  for each row execute function public.esblu_company_members_owner_guard();

-- -----------------------------------------------------------------------------
-- 3) Centrálne rozlíšenie aktívnej firmy
-- -----------------------------------------------------------------------------
create or replace function public.esblu_my_active_company_id()
returns uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    -- uložená voľba, iba ak členstvo stále platí (revoke / odchod → ignoruje sa)
    (select uac.company_id
       from public.user_active_company uac
      where uac.user_id = auth.uid()
        and exists (
          select 1 from public.company_members cm
          where cm.user_id = uac.user_id
            and cm.company_id = uac.company_id
            and cm.status = 'active')),
    -- inak jediné aktívne členstvo; pri 2+ bez voľby NULL (výber firmy v appke)
    (select (array_agg(cm.company_id))[1]
       from public.company_members cm
      where cm.user_id = auth.uid() and cm.status = 'active'
     having count(*) = 1)
  )
$function$;

comment on function public.esblu_my_active_company_id() is
  'Aktívna firma volajúceho: platná uložená voľba (user_active_company) alebo jediné aktívne členstvo; '
  'pri 2+ členstvách bez platnej voľby NULL. Nikdy LIMIT 1.';

create or replace function public.esblu_my_active_membership()
returns table (company_id uuid, role text, permissions jsonb, company_name text)
language sql
stable
security definer
set search_path to ''
as $function$
  select cm.company_id, cm.role, cm.permissions, c.name
  from public.company_members cm
  join public.companies c on c.id = cm.company_id
  where cm.user_id = auth.uid()
    and cm.status = 'active'
    and cm.company_id = public.esblu_my_active_company_id()
$function$;

-- Service role (API routes): aktívna firma konkrétneho používateľa — rovnaké pravidlo.
create or replace function public.esblu_active_membership_for_user(p_user_id uuid)
returns table (company_id uuid, role text, permissions jsonb, active_membership_count integer)
language sql
stable
security definer
set search_path to ''
as $function$
  with mine as (
    select cm.company_id, cm.role, cm.permissions
    from public.company_members cm
    where cm.user_id = p_user_id and cm.status = 'active'
  ),
  chosen as (
    select coalesce(
      (select uac.company_id from public.user_active_company uac
        where uac.user_id = p_user_id and uac.company_id in (select m.company_id from mine m)),
      (select (array_agg(m.company_id))[1] from mine m having count(*) = 1)
    ) as company_id
  )
  select m.company_id, m.role, m.permissions, (select count(*)::integer from mine)
  from mine m join chosen ch on ch.company_id = m.company_id
$function$;

create or replace function public.esblu_list_my_companies()
returns table (company_id uuid, company_name text, role text, is_active boolean, joined_at timestamptz)
language sql
stable
security definer
set search_path to ''
as $function$
  select cm.company_id, c.name, cm.role,
         cm.company_id = public.esblu_my_active_company_id(),
         cm.created_at
  from public.company_members cm
  join public.companies c on c.id = cm.company_id
  where cm.user_id = auth.uid() and cm.status = 'active'
  order by lower(c.name), cm.created_at
$function$;

create or replace function public.esblu_set_my_active_company(p_company_id uuid)
returns table (company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  -- Iba z VLASTNÝCH aktívnych členstiev — cudzie company_id = odmietnuté.
  select cm.role into v_role
  from public.company_members cm
  where cm.user_id = v_uid and cm.company_id = p_company_id and cm.status = 'active';

  if v_role is null then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_A_MEMBER';
  end if;

  insert into public.user_active_company (user_id, company_id, updated_at)
  values (v_uid, p_company_id, now())
  on conflict (user_id) do update set company_id = excluded.company_id, updated_at = now();

  return query select p_company_id, v_role;
end
$function$;

-- Ďalšia vlastná firma existujúceho používateľa (bez novej registrácie).
-- Trial / nároky nová firma dostane rovnakou existujúcou logikou ako každá
-- nová firma (trigger esblu_companies_trial_guard). Žiadny pricing.
create or replace function public.esblu_create_my_company(p_name text)
returns table (company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_company_id uuid;
  v_owned integer;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 200 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_COMPANY_NAME';
  end if;

  -- Prvá firma ide cez onboarding (esblu_ensure_my_owner_company: beta allowlist,
  -- pozvánky). Toto je iba ĎALŠIA firma už aktívneho používateľa.
  if not exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active') then
    raise exception using errcode = 'P0001', message = 'ESBLU_USE_ONBOARDING';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':create_company', 0));

  select count(*) into v_owned
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active' and cm.role = 'owner';

  -- Ochrana proti zneužitiu (nie pricing): max 10 vlastných firiem.
  if v_owned >= 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_LIMIT_REACHED';
  end if;

  if exists (
    select 1 from public.company_members cm
    join public.companies c on c.id = cm.company_id
    where cm.user_id = v_uid and cm.status = 'active' and cm.role = 'owner'
      and lower(btrim(c.name)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_DUPLICATE_COMPANY_NAME';
  end if;

  insert into public.companies (owner_id, name) values (v_uid, v_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_name);

  insert into public.user_active_company (user_id, company_id, updated_at)
  values (v_uid, v_company_id, now())
  on conflict (user_id) do update set company_id = excluded.company_id, updated_at = now();

  return query select v_company_id, 'owner'::text;
end
$function$;

-- -----------------------------------------------------------------------------
-- 4) Funkcie „môjho členstva": filter na AKTÍVNU firmu (pôvodné telá z produkcie /
--    repa, jediná zmena = `and <alias>.company_id = public.esblu_my_active_company_id()`;
--    esblu_billing_my_access navyše owner-only billing)
-- -----------------------------------------------------------------------------

-- esblu_accept_company_dpa: 1× membership filter → aktívna firma
create or replace function public.esblu_accept_company_dpa(
  p_version text
)
returns public.company_dpa_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_current_version text;
  v_row public.company_dpa_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- company_id AJ rola volajúceho sa odvodzujú VÝHRADNE z jeho vlastného
  -- aktívneho company_members riadku — nikdy z parametra poslaného
  -- klientom. Rovnaký bezpečnostný vzor ako vo zvyšku aplikácie (pozri
  -- lib/company.ts, esblu_create_company_invite a pod.).
  select cm.company_id, cm.role
  into v_company_id, v_role
  from public.company_members cm
  where cm.user_id = v_uid
    and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception 'ESBLU_NO_ACTIVE_MEMBERSHIP';
  end if;

  if v_role <> 'owner' then
    raise exception 'ESBLU_NOT_ACTIVE_OWNER';
  end if;

  -- Aktuálna ÚČINNÁ DPA verzia — iba tá smie byť prijatá. p_version je
  -- vstup od klienta iba na potvrdenie ("prijímam presne TÚTO verziu,
  -- ktorú mi appka zobrazila"), nikdy nie zdroj pravdy o tom, ČO je
  -- aktuálne.
  select ld.version
  into v_current_version
  from public.legal_documents ld
  where ld.type = 'dpa'
    and ld.effective_at <= now()
  order by ld.effective_at desc, ld.created_at desc, ld.version desc
  limit 1;

  if v_current_version is null then
    raise exception 'ESBLU_NO_CURRENT_DPA';
  end if;

  if p_version <> v_current_version then
    raise exception 'ESBLU_NOT_CURRENT_DPA_VERSION';
  end if;

  insert into public.company_dpa_acceptances (
    company_id, document_type, version, accepted_by, acceptance_method
  )
  values (
    v_company_id, 'dpa', v_current_version, v_uid, 'company_dpa_gate'
  )
  on conflict (company_id, document_type, version) do nothing;

  select *
  into v_row
  from public.company_dpa_acceptances
  where company_id = v_company_id
    and document_type = 'dpa'
    and version = v_current_version;

  return v_row;
end;
$function$;

-- esblu_assign_company_id: 1× membership filter → aktívna firma
create or replace function public.esblu_assign_company_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  select cm.company_id
  into v_company_id
  from public.company_members cm
  where cm.user_id = auth.uid()
    and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP:' || tg_table_schema || '.' || tg_table_name,
      hint = 'Prihlásený používateľ nemá aktívne členstvo v žiadnej firme, záznam nie je možné vytvoriť.';
  end if;

  new.company_id := v_company_id;
  return new;
end;
$function$;

-- esblu_can_delete_inventory_photo_object: 1× membership filter → aktívna firma
create or replace function public.esblu_can_delete_inventory_photo_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_referenced_row_count integer;
  v_null_company_count integer;
  v_distinct_company_count integer;
  v_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select
    count(*),
    count(*) filter (where ip.company_id is null),
    count(distinct ip.company_id)
  into v_referenced_row_count, v_null_company_count, v_distinct_company_count
  from public.inventory_photos ip
  where ip.file_path = p_object_name;

  if v_referenced_row_count = 0 then
    return v_uploader_uid = v_uid::text;
  end if;

  if v_null_company_count > 0 or v_distinct_company_count <> 1 then
    return false;
  end if;

  select ip.company_id into v_company_id
  from public.inventory_photos ip
  where ip.file_path = p_object_name and ip.company_id is not null
  limit 1;

  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_delete_vehicle_photo_object: 1× membership filter → aktívna firma
create or replace function public.esblu_can_delete_vehicle_photo_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_referenced_row_count integer;
  v_null_company_count integer;
  v_distinct_company_count integer;
  v_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  -- SECURITY DEFINER, beží MIMO vehicle_photos_select_company RLS — výsledok
  -- je autoritatívny bez ohľadu na to, čo by caller bežne videl. Zámerne bez
  -- MAX(uuid) — iba count-based agregáty (COUNT je nad uuid vždy podporovaný
  -- bez závislosti na existencii operátorovej triedy/aggregate pre MAX).
  select
    count(*),
    count(*) filter (where vp.company_id is null),
    count(distinct vp.company_id)
  into
    v_referenced_row_count,
    v_null_company_count,
    v_distinct_company_count
  from public.vehicle_photos vp
  where vp.storage_bucket = 'vehicle-photos'
    and vp.storage_path = p_object_name;

  if v_referenced_row_count = 0 then
    -- Draft/nereferencovaný upload (zlyhaný INSERT) — iba pôvodný
    -- nahrávateľ, bez ohľadu na rolu (INSERT smie ktokoľvek aktívny).
    return v_uploader_uid = v_uid::text;
  end if;

  if v_null_company_count > 0 or v_distinct_company_count <> 1 then
    -- Objekt JE referencovaný, ale dáta sú nekonzistentné — fail-closed,
    -- nikdy nespadnúť do draft/uploader fallbacku.
    return false;
  end if;

  -- Až TERAZ, keď je autoritatívne potvrdené (žiadny NULL, presne 1
  -- distinct), je bezpečné načítať tú jednu hodnotu samostatným SELECTom.
  -- LIMIT 1 tu nerozhoduje o tenant ownership — iba číta už jednoznačne
  -- potvrdenú hodnotu.
  select vp.company_id
  into v_company_id
  from public.vehicle_photos vp
  where vp.storage_bucket = 'vehicle-photos'
    and vp.storage_path = p_object_name
    and vp.company_id is not null
  limit 1;

  -- Presne jedna jednoznačná company_id → DELETE iba pre aktívneho
  -- owner/admin tej firmy (zrkadlí vehicle_photos_delete_owner_admin).
  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_manage_document: 1× membership filter → aktívna firma
create or replace function public.esblu_can_manage_document(p_document_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_type text;
  v_status text;
  v_user_id uuid;
  v_role text;
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;

  select d.company_id, d.document_type, d.status, d.user_id
    into v_company_id, v_type, v_status, v_user_id
  from public.documents d
  where d.id = p_document_id;

  if v_company_id is null then
    return false;
  end if;

  select cm.role into v_role
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id() and cm.company_id = v_company_id
  limit 1;

  if v_role is null then
    return false;
  end if;

  -- M1 accountant: nefinančný doklad nikdy (ani vlastný).
  if v_role = 'accountant'
     and not public.esblu_document_requires_finance(v_type, v_status) then
    return false;
  end if;

  if not public.esblu_document_requires_finance(v_type, v_status) then
    return true;
  end if;

  return public.esblu_has_finance_manage_in_company(v_company_id);
end;
$function$;

-- esblu_can_read_ai_evidence_object: 1× membership filter → aktívna firma
create or replace function public.esblu_can_read_ai_evidence_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_referenced_row_count integer;
  v_null_company_count integer;
  v_distinct_company_count integer;
  v_company_id uuid;
  v_is_delivery_note boolean;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select count(*), count(*) filter (where ae.company_id is null), count(distinct ae.company_id)
    into v_referenced_row_count, v_null_company_count, v_distinct_company_count
  from public.ai_evidence ae
  where ae.photo_url = p_object_name;

  if v_referenced_row_count = 0 then
    return v_uploader_uid = v_uid::text;
  end if;

  if v_null_company_count > 0 or v_distinct_company_count <> 1 then
    return false;
  end if;

  -- Uploader: vlastný rozpracovaný review (≤ 24 h, aktívna firma) — obnovenie po páde appky.
  if exists (
    select 1 from public.ai_evidence ae
    where ae.photo_url = p_object_name
      and ae.user_id = v_uid
      and ae.company_id = public.esblu_my_active_company_id()
      and ae.review_status in ('needs_review', 'extracted')
      and ae.created_at >= now() - interval '24 hours'
  ) then
    return true;
  end if;

  select ae.company_id, bool_or(public.esblu_evidence_is_delivery_note(ae.evidence_kind, ae.document_type))
    into v_company_id, v_is_delivery_note
  from public.ai_evidence ae
  where ae.photo_url = p_object_name and ae.company_id is not null
  group by ae.company_id;

  if v_is_delivery_note then
    return public.esblu_has_finance_view_in_company(v_company_id);
  end if;

  return exists (
    select 1 from public.company_members cm
    where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      and cm.role in ('owner', 'admin', 'employee')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_read_ai_inbox_object: 1× membership filter → aktívna firma
create or replace function public.esblu_can_read_ai_inbox_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_document_id uuid;
  v_document_company_id uuid;
  v_document_type text;
  v_document_status text;
  v_document_user_id uuid;
  v_document_created_at timestamptz;
  v_attachment_document_id uuid;
  v_role text;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select d.id, d.company_id, d.document_type, d.status, d.user_id, d.created_at
    into v_document_id, v_document_company_id, v_document_type, v_document_status, v_document_user_id, v_document_created_at
  from public.documents d
  where d.storage_bucket = 'ai-inbox-documents' and d.storage_path = p_object_name
  limit 1;

  if v_document_id is not null then
    select cm.role into v_role
    from public.company_members cm
    where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id() and cm.company_id = v_document_company_id
    limit 1;

    if v_role is null then
      return false;
    end if;

    -- M1 accountant (20260930120000): nefinančný doklad nikdy.
    if v_role = 'accountant'
       and not public.esblu_document_requires_finance(v_document_type, v_document_status) then
      return false;
    end if;

    if not public.esblu_document_requires_finance(v_document_type, v_document_status) then
      return true;
    end if;

    if public.esblu_has_finance_view_in_company(v_document_company_id) then
      return true;
    end if;

    -- Uploader: vlastný doklad v príjme / rozpracovanom review (obnovenie po páde appky).
    if v_document_user_id = v_uid and (
         coalesce(v_document_status, '') in ('uploaded', 'processing')
         or (v_document_status in ('needs_review', 'extracted')
             and v_document_type in ('invoice', 'receipt')
             and v_document_created_at >= now() - interval '24 hours')) then
      return true;
    end if;

    return false;
  end if;

  select da.document_id into v_attachment_document_id
  from public.document_attachments da
  where da.storage_bucket = 'ai-inbox-documents' and da.storage_path = p_object_name
  limit 1;

  if v_attachment_document_id is not null then
    return public.esblu_can_read_document(v_attachment_document_id);
  end if;

  return v_uploader_uid = v_uid::text;
end;
$function$;

-- esblu_can_read_document: 1× membership filter → aktívna firma
create or replace function public.esblu_can_read_document(p_document_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_type text;
  v_status text;
  v_user_id uuid;
  v_role text;
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;

  select d.company_id, d.document_type, d.status, d.user_id
    into v_company_id, v_type, v_status, v_user_id
  from public.documents d
  where d.id = p_document_id;

  if v_company_id is null then
    return false;
  end if;

  select cm.role into v_role
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id() and cm.company_id = v_company_id
  limit 1;

  if v_role is null then
    return false;
  end if;

  -- M1 accountant: nefinančný doklad nikdy (ani vlastný).
  if v_role = 'accountant'
     and not public.esblu_document_requires_finance(v_type, v_status) then
    return false;
  end if;

  if not public.esblu_document_requires_finance(v_type, v_status) then
    return true;
  end if;

  if public.esblu_has_finance_view_in_company(v_company_id) then
    return true;
  end if;

  return coalesce(v_status, '') in ('uploaded', 'processing') and v_user_id = v_uid;
end;
$function$;

-- esblu_consume_ai_scan_quota: 1× membership filter → aktívna firma
CREATE OR REPLACE FUNCTION public.esblu_consume_ai_scan_quota(p_endpoint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_endpoint text;
  v_max_per_hour integer;
  v_max_per_day integer;
  v_hour_count integer;
  v_day_count integer;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_AUTHENTICATED';
  end if;

  select cm.company_id
    into v_company_id
  from public.company_members cm
  where cm.user_id = v_uid
    and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY',
      hint = 'Používateľ nemá aktívne členstvo v žiadnej firme.';
  end if;

  v_endpoint := btrim(coalesce(p_endpoint, ''));

  select l.max_per_hour, l.max_per_day
    into v_max_per_hour, v_max_per_day
  from public.ai_scan_limits l
  where l.endpoint = v_endpoint;

  if v_max_per_hour is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_AI_SCAN_ENDPOINT_UNKNOWN',
      hint = 'Pre tento endpoint nie je nakonfigurovaný technický limit.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_company_id::text || ':ai_scan_usage', 0)
  );

  select count(*) into v_hour_count
  from public.ai_scan_usage u
  where u.company_id = v_company_id
    and u.created_at > now() - interval '1 hour';

  select count(*) into v_day_count
  from public.ai_scan_usage u
  where u.company_id = v_company_id
    and u.created_at > now() - interval '24 hours';

  if v_hour_count >= v_max_per_hour or v_day_count >= v_max_per_day then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_AI_SCAN_RATE_LIMIT',
      hint = 'Prekročený technický limit počtu skenov pre firmu. Skúste to neskôr.';
  end if;

  insert into public.ai_scan_usage (company_id, user_id, endpoint)
  values (v_company_id, v_uid, v_endpoint);

  return jsonb_build_object(
    'company_id', v_company_id,
    'used_last_hour', v_hour_count + 1,
    'used_last_day', v_day_count + 1
  );
end;
$function$;

-- esblu_can_delete_ai_evidence_object: 1× membership filter → aktívna firma
CREATE OR REPLACE FUNCTION public.esblu_can_delete_ai_evidence_object(p_object_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_referenced_row_count integer;
  v_null_company_count integer;
  v_distinct_company_count integer;
  v_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select
    count(*),
    count(*) filter (where ae.company_id is null),
    count(distinct ae.company_id)
  into
    v_referenced_row_count,
    v_null_company_count,
    v_distinct_company_count
  from public.ai_evidence ae
  where ae.photo_url = p_object_name;

  if v_referenced_row_count = 0 then
    return v_uploader_uid = v_uid::text;
  end if;

  if v_null_company_count > 0
     or v_distinct_company_count <> 1 then
    return false;
  end if;

  select ae.company_id
  into v_company_id
  from public.ai_evidence ae
  where ae.photo_url = p_object_name
    and ae.company_id is not null
  limit 1;

  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_delete_ai_inbox_object: 2× membership filter → aktívna firma
CREATE OR REPLACE FUNCTION public.esblu_can_delete_ai_inbox_object(p_object_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_document_id uuid;
  v_document_company_id uuid;
  v_document_type text;
  v_document_status text;
  v_attachment_document_id uuid;
  v_attachment_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select d.id, d.company_id, d.document_type, d.status
    into v_document_id, v_document_company_id, v_document_type, v_document_status
  from public.documents d
  where d.storage_bucket = 'ai-inbox-documents'
    and d.storage_path = p_object_name
  limit 1;

  if v_document_id is not null then
    if not exists (
      select 1 from public.company_members cm
      where cm.user_id = v_uid
        and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
        and cm.role in ('owner', 'admin')
        and cm.company_id = v_document_company_id
    ) then
      return false;
    end if;

    if not public.esblu_document_requires_finance(v_document_type, v_document_status) then
      return true;
    end if;

    return public.esblu_has_finance_manage_in_company(v_document_company_id);
  end if;

  select da.document_id, da.company_id
    into v_attachment_document_id, v_attachment_company_id
  from public.document_attachments da
  where da.storage_bucket = 'ai-inbox-documents'
    and da.storage_path = p_object_name
  limit 1;

  if v_attachment_document_id is not null then
    if not exists (
      select 1 from public.company_members cm
      where cm.user_id = v_uid
        and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
        and cm.role in ('owner', 'admin')
        and cm.company_id = v_attachment_company_id
    ) then
      return false;
    end if;

    return public.esblu_can_manage_document(v_attachment_document_id);
  end if;

  return v_uploader_uid = v_uid::text;
end;
$function$;

-- esblu_can_delete_machine_photo_object: 1× membership filter → aktívna firma
CREATE OR REPLACE FUNCTION public.esblu_can_delete_machine_photo_object(p_object_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_referenced_row_count integer;
  v_null_company_count integer;
  v_distinct_company_count integer;
  v_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select
    count(*),
    count(*) filter (where mp.company_id is null),
    count(distinct mp.company_id)
  into
    v_referenced_row_count,
    v_null_company_count,
    v_distinct_company_count
  from public.machine_photos mp
  where mp.file_path = p_object_name;

  if v_referenced_row_count = 0 then
    return v_uploader_uid = v_uid::text;
  end if;

  if v_null_company_count > 0 or v_distinct_company_count <> 1 then
    return false;
  end if;

  select mp.company_id
  into v_company_id
  from public.machine_photos mp
  where mp.file_path = p_object_name
    and mp.company_id is not null
  limit 1;

  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_enforce_plan_limit: 1× membership filter → aktívna firma
create or replace function public.esblu_enforce_plan_limit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  authenticated_user_id uuid := auth.uid();
  request_role text := coalesce(auth.role(), '');
  is_privileged boolean := false;
  v_company_id uuid;
  v_key text;
  current_usage bigint;
begin
  if new.user_id is null then
    raise exception using errcode = '23502', message = 'PLAN_LIMIT_USER_MISSING';
  end if;

  is_privileged :=
    request_role = 'service_role'
    or session_user in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin');

  if not is_privileged
    and (authenticated_user_id is null or new.user_id is distinct from authenticated_user_id)
  then
    raise exception using errcode = '42501', message = 'PLAN_LIMIT_USER_MISMATCH';
  end if;

  v_key := case tg_table_name
    when 'vehicles' then 'vehicles'
    when 'machines' then 'machines'
    when 'inventory_items' then 'inventory'
    when 'ai_evidence' then 'ai_documents'
  end;

  if tg_table_schema <> 'public' or v_key is null then
    raise exception using
      errcode = 'P0001',
      message = 'PLAN_LIMIT_UNSUPPORTED_RESOURCE:' || tg_table_schema || '.' || tg_table_name;
  end if;

  if is_privileged and new.company_id is not null then
    v_company_id := new.company_id;
  else
    select cm.company_id into v_company_id
    from public.company_members cm
    where cm.user_id = authenticated_user_id and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
    limit 1;
  end if;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP:' || tg_table_schema || '.' || tg_table_name;
  end if;

  new.company_id := v_company_id;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':' || tg_table_name, 0));

  if v_key = 'ai_documents' then
    -- Záznamy AI evidencie nie sú kvóta (kvóta = AI spracovania v ledgri);
    -- vyžaduje sa iba aktívny modul. Počet uložených riadkov sa nepočíta.
    perform public.esblu_require_entitlement_capacity(v_company_id, v_key, null);
    return new;
  end if;

  execute format('select count(*) from public.%I where company_id = $1', tg_table_name)
    into current_usage using v_company_id;

  perform public.esblu_require_entitlement_capacity(v_company_id, v_key, current_usage);
  return new;
end
$function$;

-- esblu_get_company_profile: 1× membership filter → aktívna firma
create or replace function public.esblu_get_company_profile()
returns table(company_name text, logo_path text)
language sql
stable security definer
set search_path to ''
as $function$
  select bp.legal_name, bp.logo_path
  from public.company_members my_cm
  join public.company_billing_profile bp
    on bp.company_id = my_cm.company_id
  where my_cm.user_id = auth.uid()
    and my_cm.status = 'active'
      and my_cm.company_id = public.esblu_my_active_company_id()
  limit 1;
$function$;

-- esblu_get_my_company_dpa_status: 1× membership filter → aktívna firma
create or replace function public.esblu_get_my_company_dpa_status()
returns table (
  company_id uuid,
  current_dpa_version text,
  has_current_acceptance boolean,
  accepted_at timestamptz,
  my_role text
)
language sql
stable
security definer
set search_path = ''
as $function$
  with my_membership as (
    select cm.company_id, cm.role
    from public.company_members cm
    where cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
    limit 1
  ),
  current_dpa as (
    select ld.version
    from public.legal_documents ld
    where ld.type = 'dpa'
      and ld.effective_at <= now()
    order by ld.effective_at desc, ld.created_at desc, ld.version desc
    limit 1
  )
  select
    mm.company_id,
    cd.version,
    (cda.id is not null),
    cda.accepted_at,
    mm.role
  from my_membership mm
  cross join current_dpa cd
  left join public.company_dpa_acceptances cda
    on cda.company_id = mm.company_id
   and cda.document_type = 'dpa'
   and cda.version = cd.version;
$function$;

-- esblu_get_my_company_entitlements: 1× membership filter → aktívna firma
create or replace function public.esblu_get_my_company_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company record;
  v_items jsonb;
  v_ai_trial_used bigint;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select c.id, c.trial_started_at, c.trial_ends_at into v_company
  from public.company_members cm
  join public.companies c on c.id = cm.company_id
  where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  select jsonb_agg(
           (public.esblu_resolve_entitlement(v_company.id, k.key) - 'entitlement_id')
           order by k.sort_order)
  into v_items
  from public.entitlement_catalog k;

  select count(*) into v_ai_trial_used
  from public.ai_processing_usage u
  where u.company_id = v_company.id and u.entitlement_source = 'trial'
    and u.status in ('reserved', 'succeeded');

  return jsonb_build_object(
    'company_id', v_company.id,
    'server_time', now(),
    'trial', jsonb_build_object(
      'started_at', v_company.trial_started_at,
      'ends_at', v_company.trial_ends_at,
      'active', coalesce(now() < v_company.trial_ends_at, false),
      'ai_processing_used', v_ai_trial_used
    ),
    'entitlements', coalesce(v_items, '[]'::jsonb)
  );
end
$function$;

-- esblu_has_finance_manage_in_company: 1× membership filter → aktívna firma
create or replace function public.esblu_has_finance_manage_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$$;

-- esblu_has_finance_view_in_company: 1× membership filter → aktívna firma
create or replace function public.esblu_has_finance_view_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false)
            or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$$;

-- esblu_list_my_company_invites: 1× membership filter → aktívna firma
create or replace function public.esblu_list_my_company_invites()
returns table (
  invite_id uuid,
  email text,
  role text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  accepted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_caller_role text;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  select m.company_id, m.role into v_company_id, v_caller_role
  from public.company_members m
  where m.user_id = v_uid
    and m.status = 'active'
      and m.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    return;
  end if;

  if v_caller_role not in ('owner', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;

  return query
  select
    ci.id,
    ci.email,
    ci.role,
    case
      when ci.status = 'pending' and ci.expires_at <= now() then 'expired'
      else ci.status
    end,
    ci.created_at,
    ci.expires_at,
    ci.accepted_at
  from public.company_invites ci
  where ci.company_id = v_company_id
  order by ci.created_at desc;
end;
$function$;

-- esblu_list_my_company_members: 1× membership filter → aktívna firma
create or replace function public.esblu_list_my_company_members()
returns table (
  member_id uuid,
  user_id uuid,
  email text,
  role text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_caller_role text;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  select m.company_id, m.role into v_company_id, v_caller_role
  from public.company_members m
  where m.user_id = v_uid
    and m.status = 'active'
      and m.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    -- Volajúci ešte nemá žiadnu firmu (napr. pred dokončením owner
    -- bootstrapu) — nie je to chyba, iba prázdny zoznam.
    return;
  end if;

  if v_caller_role not in ('owner', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;

  return query
  select m.id, m.user_id, u.email::text, m.role, m.status, m.created_at
  from public.company_members m
  join auth.users u on u.id = m.user_id
  where m.company_id = v_company_id
  order by
    case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    m.created_at;
end;
$function$;

-- esblu_my_active_role: 1× membership filter → aktívna firma
create or replace function public.esblu_my_active_role()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select cm.role
  from public.company_members cm
  where cm.user_id = auth.uid()
    and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;
$function$;

-- esblu_my_finance_manage: 1× membership filter → aktívna firma
create or replace function public.esblu_my_finance_manage()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      limit 1
    ),
    false
  );
$$;

-- esblu_my_finance_view: 1× membership filter → aktívna firma
create or replace function public.esblu_my_finance_view()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false)
            or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      limit 1
    ),
    false
  );
$$;

-- esblu_role_can_operate: 1× membership filter → aktívna firma
create or replace function public.esblu_role_can_operate()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select cm.role in ('owner', 'admin', 'employee')
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
      limit 1
    ),
    false
  );
$$;

-- esblu_require_my_entitlement: 1× membership filter → aktívna firma
create or replace function public.esblu_require_my_entitlement(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_ent jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  v_ent := public.esblu_resolve_entitlement(v_company_id, p_key);
  if coalesce((v_ent ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial(coalesce(v_ent ->> 'reason', 'ENTITLEMENT_REQUIRED'), p_key);
  end if;

  return jsonb_build_object('key', p_key, 'active', true, 'source', v_ent ->> 'source');
end
$function$;

-- esblu_reserve_ai_processing: 1× membership filter → aktívna firma
create or replace function public.esblu_reserve_ai_processing(
  p_endpoint text, p_idempotency_key text, p_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_existing record;
  v_ent jsonb;
  v_limit integer;
  v_period text;
  v_source text;
  v_ent_id uuid;
  v_used bigint;
  v_usage_id uuid;
  v_found boolean := false;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_endpoint is null or p_endpoint not in ('scan-document', 'scan-vehicle-registration', 'scan-vehicle-doc') then
    raise exception using errcode = 'P0001', message = 'ESBLU_AI_ENDPOINT_UNKNOWN';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_AI_IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_AI_CONTENT_HASH_INVALID';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':ai_processing', 0));

  select u.* into v_existing
  from public.ai_processing_usage u
  where u.company_id = v_company_id and u.idempotency_key = p_idempotency_key
  for update;
  v_found := found;

  if v_found then
    if v_existing.content_sha256 <> p_content_sha256 or v_existing.user_id <> v_uid
      or v_existing.endpoint <> p_endpoint then
      raise exception using errcode = 'P0001', message = 'ESBLU_AI_IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.attempts >= 3 or v_existing.reserved_at < now() - interval '24 hours' then
      raise exception using errcode = 'P0001', message = 'ESBLU_AI_IDEMPOTENCY_EXPIRED';
    end if;
    if v_existing.status in ('reserved', 'succeeded') then
      update public.ai_processing_usage
      set attempts = attempts + 1, status = 'reserved', finalized_at = null
      where id = v_existing.id;
      return jsonb_build_object('usage_id', v_existing.id, 'reused', true, 'source', v_existing.entitlement_source);
    end if;
    -- 'failed' → nový pokus sa započíta, ak je kapacita (nižšie).
  end if;

  v_ent := public.esblu_resolve_entitlement(v_company_id, 'ai_documents');
  if coalesce((v_ent ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial(coalesce(v_ent ->> 'reason', 'ENTITLEMENT_REQUIRED'), 'ai_documents');
  end if;

  v_limit := (v_ent ->> 'limit')::integer;
  v_period := v_ent ->> 'limit_period';
  v_source := v_ent ->> 'source';
  v_ent_id := nullif(v_ent ->> 'entitlement_id', '')::uuid;

  if v_limit is not null then
    if v_source = 'trial' then
      select count(*) into v_used from public.ai_processing_usage u
      where u.company_id = v_company_id and u.entitlement_source = 'trial'
        and u.status in ('reserved', 'succeeded');
    elsif v_period = 'month' then
      select count(*) into v_used from public.ai_processing_usage u
      where u.company_id = v_company_id and u.entitlement_id = v_ent_id
        and u.status in ('reserved', 'succeeded')
        and u.reserved_at >= date_trunc('month', now());
    else
      select count(*) into v_used from public.ai_processing_usage u
      where u.company_id = v_company_id and u.entitlement_id = v_ent_id
        and u.status in ('reserved', 'succeeded');
    end if;

    if v_used >= v_limit then
      perform public.esblu_raise_entitlement_denial('AI_PROCESSING_LIMIT_REACHED', 'ai_documents', v_limit, v_used);
    end if;
  end if;

  if v_found then
    update public.ai_processing_usage
    set attempts = attempts + 1, status = 'reserved', finalized_at = null,
        entitlement_source = v_source, entitlement_id = v_ent_id, reserved_at = now()
    where id = v_existing.id
    returning id into v_usage_id;
  else
    insert into public.ai_processing_usage
      (company_id, user_id, endpoint, idempotency_key, content_sha256, entitlement_source, entitlement_id)
    values
      (v_company_id, v_uid, p_endpoint, p_idempotency_key, p_content_sha256, v_source, v_ent_id)
    returning id into v_usage_id;
  end if;

  return jsonb_build_object('usage_id', v_usage_id, 'reused', false, 'source', v_source,
    'limit', v_limit, 'used', coalesce(v_used, 0) + 1);
end
$function$;

-- esblu_billing_my_access: 1× membership filter → aktívna firma
create or replace function public.esblu_billing_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_member record;
  v_manage boolean;
  v_view boolean;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select cm.company_id, cm.role, cm.permissions into v_member
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  -- Multi-company (2026-10-12): billing authority = IBA owner aktívnej firmy.
  -- Admin s permissions.billing.manage (staršia politika) už nekupuje ani
  -- nespravuje predplatné — explicitná zmena, pozri docs/multi-company-architecture.
  v_manage := v_member.role = 'owner';
  v_view := v_manage or coalesce(public.esblu_my_finance_view(), false);

  return jsonb_build_object('company_id', v_member.company_id, 'role', v_member.role,
                            'can_manage', v_manage, 'can_view', v_view);
end
$function$;

-- esblu_create_company_invite: 1× membership filter → aktívna firma
create or replace function public.esblu_create_company_invite(p_email text, p_role text)
returns table(invite_id uuid, token text, expires_at timestamp with time zone, email text, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_caller_role text;
  v_email text;
  v_role text;
  v_raw_token text;
  v_token_hash text;
  v_invite_id uuid;
  v_expires_at timestamptz;
  v_existing_member_count integer;
  v_existing_pending_count integer;
  v_seats_used bigint;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  v_role := lower(btrim(coalesce(p_role, '')));

  if v_role not in ('admin', 'accountant', 'employee') then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_INVITE_ROLE:' || coalesce(p_role, '');
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));

  if v_email = '' or v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_INVITE_EMAIL';
  end if;

  select m.company_id, m.role into v_company_id, v_caller_role
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
      and m.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null or v_caller_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;

  -- Rola 'accountant' nesie finančný prístup (esblu_my_finance_view/manage).
  -- Udeliť ho smie iba owner — admin nemá finančnú autoritu implicitne,
  -- takže ju nesmie ani odovzdať (inak by pozval vlastnú druhú schránku).
  if v_role = 'accountant' and v_caller_role <> 'owner' then
    raise exception using errcode = '42501', message = 'ESBLU_INVITE_ROLE_NOT_PERMITTED';
  end if;

  select count(*) into v_existing_member_count
  from public.company_members m
  join auth.users u on u.id = m.user_id
  where m.company_id = v_company_id and m.status = 'active' and lower(u.email) = v_email;

  if v_existing_member_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_MEMBER';
  end if;

  select count(*) into v_existing_pending_count
  from public.company_invites ci
  where ci.company_id = v_company_id and ci.email = v_email
    and ci.status = 'pending' and ci.expires_at > now();

  if v_existing_pending_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_PENDING';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':team_members', 0));

  select
    (select count(*) from public.company_members m
      where m.company_id = v_company_id and m.status = 'active')
    + (select count(*) from public.company_invites ci
      where ci.company_id = v_company_id and ci.status = 'pending' and ci.expires_at > now())
  into v_seats_used;

  perform public.esblu_require_entitlement_capacity(v_company_id, 'team_members', v_seats_used);

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_expires_at := now() + interval '7 days';

  insert into public.company_invites (company_id, email, role, invited_by, token_hash, status, expires_at)
  values (v_company_id, v_email, v_role, v_uid, v_token_hash, 'pending', v_expires_at)
  returning id into v_invite_id;

  return query select v_invite_id, v_raw_token, v_expires_at, v_email, v_role;
end;
$function$;

-- esblu_owner_delete_company(p_owner_user_id, p_company_id): repo telo (20260827100000) + explicitná firma,
-- bez mazania user-scoped settings / právnych súhlasov (owner môže byť členom ďalších firiem).
create or replace function public.esblu_owner_delete_company(p_owner_user_id uuid, p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
  v_owner_id_check uuid;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  if p_owner_user_id is null or p_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_USER_ID';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = p_owner_user_id
    and cm.status = 'active'
    and cm.role = 'owner'
    and cm.company_id = p_company_id;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NOT_ACTIVE_OWNER',
      hint = 'Volajúci nemá aktívny company_members riadok s rolou owner.';
  end if;

  select c.owner_id into v_owner_id_check
  from public.companies c
  where c.id = v_company_id;

  if v_owner_id_check is null or v_owner_id_check <> p_owner_user_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_OWNER_MISMATCH',
      hint = 'companies.owner_id nesúhlasí s company_members rolou owner pre tohto používateľa — zastavené pred zmazaním, over dáta manuálne.';
  end if;

  -- NOVÉ (20260827100000): chat tabuľky, presné poradie child → parent.
  -- chat_conversations.company_id je ON DELETE RESTRICT na companies
  -- (rovnaký vzor ako vehicle_photos/vehicle_vignettes), takže musí byť
  -- prázdna PRED zmazaním companies riadku nižšie. FK cascade
  -- (conversation_id/message_id) by DB riadky zmazal aj sám, explicitný
  -- DELETE tu je konzistentný so zvyškom funkcie a dáva presný počet do
  -- deleted_counts.
  delete from public.chat_message_references where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('chat_message_references', v_n);

  delete from public.chat_attachments where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('chat_attachments', v_n);

  delete from public.chat_messages where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('chat_messages', v_n);

  delete from public.chat_conversation_members where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('chat_conversation_members', v_n);

  delete from public.chat_conversations where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('chat_conversations', v_n);

  -- Business tabuľky, presné poradie kvôli FK (child pred parent).
  delete from public.document_attachments where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('document_attachments', v_n);

  delete from public.document_links where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('document_links', v_n);

  delete from public.document_review_log where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('document_review_log', v_n);

  delete from public.documents where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('documents', v_n);

  delete from public.inventory_photos where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('inventory_photos', v_n);

  delete from public.inventory_items where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('inventory_items', v_n);

  delete from public.machine_photos where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('machine_photos', v_n);

  delete from public.machine_services where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('machine_services', v_n);

  delete from public.machines where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('machines', v_n);

  delete from public.vehicle_photos where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('vehicle_photos', v_n);

  delete from public.vehicle_vignettes where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('vehicle_vignettes', v_n);

  delete from public.vehicle_services where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('vehicle_services', v_n);

  delete from public.vehicles where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('vehicles', v_n);

  delete from public.ai_evidence where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('ai_evidence', v_n);

  -- Firemné/právne záznamy.
  delete from public.company_invites where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('company_invites', v_n);

  delete from public.company_dpa_acceptances where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('company_dpa_acceptances', v_n);

  -- Memberships (VŠETCI členovia — owner, admin, employee) + company.
  delete from public.company_members where company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('company_members', v_n);

  delete from public.companies where id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('companies', v_n);

  -- Multi-company: user-scoped záznamy (settings, právne súhlasy) sa tu NEmažú —
  -- owner môže byť členom ďalších firiem. Globálne údaje maže iba
  -- esblu_user_global_cleanup pri zrušení celého Esblu účtu.

  return jsonb_build_object(
    'company_id', v_company_id,
    'deleted_counts', v_counts
  );
end;
$function$;

-- esblu_get_or_create_direct_conversation: repo telo (20260827100000) + overenie druhej strany v aktívnej firme.
create or replace function public.esblu_get_or_create_direct_conversation(
  p_other_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_other_company_id uuid;
  v_low uuid;
  v_high uuid;
  v_conversation_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_other_user_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_USER_ID';
  end if;

  if p_other_user_id = v_uid then
    raise exception using errcode = 'P0001', message = 'ESBLU_CANNOT_MESSAGE_SELF';
  end if;

  v_company_id := public.esblu_my_active_company_id();

  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  -- Druhá strana MUSÍ byť aktívny člen TEJ ISTEJ firmy — nikdy sa nedôveruje
  -- iba tomu, že klient poslal nejaké UUID.
  -- Multi-company: členstvo druhej strany sa overí PRÁVE v aktívnej firme
  -- volajúceho (nie „jej" jediná firma cez LIMIT 1).
  if not exists (
    select 1 from public.company_members cm
    where cm.user_id = p_other_user_id
      and cm.company_id = v_company_id
      and cm.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_SAME_COMPANY';
  end if;

  v_low := least(v_uid, p_other_user_id);
  v_high := greatest(v_uid, p_other_user_id);

  select id into v_conversation_id
  from public.chat_conversations
  where type = 'direct'
    and company_id = v_company_id
    and direct_user_low = v_low
    and direct_user_high = v_high;

  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  begin
    insert into public.chat_conversations (
      company_id, type, direct_user_low, direct_user_high, created_by
    )
    values (v_company_id, 'direct', v_low, v_high, v_uid)
    returning id into v_conversation_id;

    insert into public.chat_conversation_members (conversation_id, company_id, user_id)
    values
      (v_conversation_id, v_company_id, v_uid),
      (v_conversation_id, v_company_id, p_other_user_id);
  exception
    when unique_violation then
      select id into v_conversation_id
      from public.chat_conversations
      where type = 'direct'
        and company_id = v_company_id
        and direct_user_low = v_low
        and direct_user_high = v_high;
  end;

  return v_conversation_id;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5) Pozvánky: existujúci používateľ dostane ĎALŠIE členstvo
-- -----------------------------------------------------------------------------
create or replace function public.esblu_accept_company_invite(p_token text)
returns table (company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_email text;
  v_token_hash text;
  v_invite record;
  v_existing record;
  v_had_active integer;
  v_active_members bigint;
  v_inviter_is_owner boolean;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TOKEN';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  if v_email is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;

  v_email := lower(btrim(v_email));
  v_token_hash := encode(extensions.digest(btrim(p_token), 'sha256'), 'hex');

  select ci.* into v_invite
  from public.company_invites ci
  where ci.token_hash = v_token_hash
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TOKEN';
  end if;

  if v_invite.status = 'accepted' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_ACCEPTED';
  end if;

  if v_invite.status = 'revoked' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_REVOKED';
  end if;

  if v_invite.status = 'expired' or v_invite.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_EXPIRED';
  end if;

  if v_invite.email <> v_email then
    raise exception using errcode = '42501', message = 'ESBLU_INVITE_EMAIL_MISMATCH';
  end if;

  if v_invite.role = 'accountant' then
    select exists (
      select 1 from public.company_members m
      where m.company_id = v_invite.company_id
        and m.user_id = v_invite.invited_by
        and m.status = 'active'
        and m.role = 'owner'
    ) into v_inviter_is_owner;

    if not v_inviter_is_owner then
      raise exception using errcode = '42501', message = 'ESBLU_INVITE_ROLE_NOT_PERMITTED';
    end if;
  end if;

  -- Multi-company: členstvá v INÝCH firmách (aj owner) sa nemenia. Odmietne sa
  -- iba duplicitné členstvo v TEJ ISTEJ firme (rola sa nikdy neprepíše).
  select m.status, m.role into v_existing
  from public.company_members m
  where m.company_id = v_invite.company_id and m.user_id = v_uid;

  if found and v_existing.status = 'active' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_MEMBER';
  end if;

  select count(*) into v_had_active
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active';

  perform pg_advisory_xact_lock(hashtextextended(v_invite.company_id::text || ':team_members', 0));

  select count(*) into v_active_members
  from public.company_members m
  where m.company_id = v_invite.company_id and m.status = 'active';

  perform public.esblu_require_entitlement_capacity(v_invite.company_id, 'team_members', v_active_members);

  if found and v_existing.status is not null then
    -- Neaktívny (napr. disabled) riadok v tej istej firme → znovu aktivovať s rolou z pozvánky.
    update public.company_members m
    set status = 'active', role = v_invite.role
    where m.company_id = v_invite.company_id and m.user_id = v_uid;
  else
    insert into public.company_members (company_id, user_id, role, status)
    values (v_invite.company_id, v_uid, v_invite.role, 'active');
  end if;

  update public.company_invites
  set status = 'accepted', accepted_at = now(), accepted_by = v_uid
  where id = v_invite.id;

  -- Prvé členstvo → rovno aktívna firma. Inak sa aktívna firma NEMENÍ
  -- (appka ponúkne „Prepnúť do firmy").
  if v_had_active = 0 then
    insert into public.user_active_company (user_id, company_id, updated_at)
    values (v_uid, v_invite.company_id, now())
    on conflict (user_id) do update set company_id = excluded.company_id, updated_at = now();
  end if;

  return query select v_invite.company_id, v_invite.role;
end;
$function$;

-- Bootstrap PRVEJ firmy po registrácii (beta allowlist / pozvánky bez zmeny).
-- Ak používateľ už má členstvo, vráti aktívnu (alebo deterministicky najstaršiu) firmu.
create or replace function public.esblu_ensure_my_owner_company()
returns table (company_id uuid, role text, created boolean)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_email text;
  v_existing record;
  v_company_id uuid;
  v_company_name text;
  v_beta_allowed boolean;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select m.company_id, m.role into v_existing
  from public.company_members m
  where m.user_id = v_uid
    and m.status = 'active'
  order by (m.company_id = public.esblu_my_active_company_id()) desc nulls last, m.created_at, m.company_id
  limit 1;

  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  if v_email is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;

  v_email := lower(btrim(v_email));

  if exists (
    select 1 from public.company_invites ci
    where ci.email = v_email and ci.status = 'pending' and ci.expires_at > now()
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_PENDING_INVITE_EXISTS';
  end if;

  select exists (
    select 1 from public.beta_allowlist ba
    where ba.email = v_email and ba.revoked_at is null and ba.consumed_at is null
  ) into v_beta_allowed;

  if not v_beta_allowed then
    raise exception using errcode = '42501', message = 'ESBLU_BETA_ACCESS_REQUIRED';
  end if;

  select coalesce(nullif(btrim(s.company_name), ''), 'Moja firma') into v_company_name
  from public.settings s
  where s.user_id = v_uid;

  v_company_name := coalesce(v_company_name, 'Moja firma');

  -- Súbeh dvoch bootstrapov toho istého používateľa (bez unikátneho indexu na
  -- user_id) serializuje advisory lock; druhý nájde členstvo prvého.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':create_company', 0));

  select m.company_id, m.role into v_existing
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
  order by m.created_at, m.company_id
  limit 1;

  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  insert into public.companies (owner_id, name) values (v_uid, v_company_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_company_name);

  insert into public.user_active_company (user_id, company_id, updated_at)
  values (v_uid, v_company_id, now())
  on conflict (user_id) do update set company_id = excluded.company_id, updated_at = now();

  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()), consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;

-- 6) Chat: esblu_get_or_create_direct_conversation — pozri nižšie (repo telo + overenie v aktívnej firme)

-- -----------------------------------------------------------------------------
-- 7) Logo firmy v Storage: firma z DB záznamu / aktívnej firmy (nie „jediné
--    členstvo nahrávateľa", čo pri multi-company zlyhávalo)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_can_manage_company_logo_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid := public.esblu_my_active_company_id();
  v_uploader_uid text;
begin
  if v_uid is null or v_company_id is null then
    return false;
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.user_id = v_uid and cm.status = 'active'
      and cm.company_id = v_company_id and cm.role in ('owner', 'admin')
  ) then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  -- Logo referencované inou firmou → nikdy.
  if exists (select 1 from public.company_billing_profile b where b.logo_path = p_object_name and b.company_id <> v_company_id) then
    return false;
  end if;

  -- Aktuálne logo aktívnej firmy, alebo súbor nahraný členom aktívnej firmy.
  return exists (select 1 from public.company_billing_profile b where b.logo_path = p_object_name and b.company_id = v_company_id)
      or exists (
        select 1 from public.company_members cm
        where cm.user_id::text = v_uploader_uid and cm.company_id = v_company_id and cm.status = 'active'
      );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 8) Odchod z firmy ≠ zrušenie firmy ≠ zrušenie globálneho účtu
-- -----------------------------------------------------------------------------

-- A. Člen (admin / accountant / employee) opúšťa JEDNU firmu. Firemné dáta,
--    ktoré vytvoril (faktúry, dokumenty, fotky, vozidlá, stroje, sklad,
--    partneri, chat správy, audit) ostávajú firme — maže sa iba prístup.
create or replace function public.esblu_member_leave_company(p_user_id uuid, p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  if p_user_id is null or p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_USER_ID';
  end if;

  select cm.role into v_role
  from public.company_members cm
  where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active';

  if v_role is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_MEMBER';
  end if;

  if v_role = 'owner' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_OWNER_CANNOT_LEAVE',
      hint = 'Owner firmu neopúšťa — firmu môže iba zrušiť (prevod vlastníctva zatiaľ nie je podporovaný).';
  end if;

  -- Prístup ku konverzáciám tejto firmy (správy ostávajú firme).
  delete from public.chat_conversation_members where user_id = p_user_id and company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('chat_conversation_members', v_n);

  delete from public.company_members where user_id = p_user_id and company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('company_members', v_n);

  delete from public.user_active_company where user_id = p_user_id and company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('user_active_company', v_n);

  return jsonb_build_object('company_id', p_company_id, 'role', v_role, 'deleted_counts', v_counts);
end;
$function$;

-- Kompatibilita (staršie volania bez company_id): deterministické IBA pri
-- jedinom členstve; inak sa vyžaduje explicitná firma (žiadne LIMIT 1).
create or replace function public.esblu_member_delete_self(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_total integer;
  v_result jsonb;
  v_n bigint;
  v_counts jsonb;
begin
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_USER_ID';
  end if;

  select count(*), (array_agg(cm.company_id))[1] into v_total, v_company_id
  from public.company_members cm
  where cm.user_id = p_user_id and cm.status = 'active';

  if v_total <> 1 then
    raise exception using
      errcode = 'P0001',
      message = case when v_total = 0 then 'ESBLU_NOT_ACTIVE_MEMBER' else 'ESBLU_COMPANY_ID_REQUIRED' end;
  end if;

  v_result := public.esblu_member_leave_company(p_user_id, v_company_id);
  v_counts := coalesce(v_result -> 'deleted_counts', '{}'::jsonb);

  -- Pôvodná sémantika (jediná firma = zrušenie účtu): user-scoped záznamy.
  delete from public.settings where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('settings', v_n);
  delete from public.user_legal_acceptances where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('user_legal_acceptances', v_n);

  return jsonb_build_object('company_id', v_company_id, 'deleted_counts', v_counts);
end;
$function$;

-- B. Owner ruší KONKRÉTNU firmu: esblu_owner_delete_company(p_owner_user_id, p_company_id)
--    — pozri vyššie (repo telo + filter firmy, bez mazania user-scoped údajov).
--    Kompatibilná 1-arg verzia: iba pri práve jednej vlastnenej firme.
create or replace function public.esblu_owner_delete_company(p_owner_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_owned integer;
  v_company_id uuid;
  v_result jsonb;
begin
  if p_owner_user_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_USER_ID';
  end if;

  select count(*), (array_agg(cm.company_id))[1] into v_owned, v_company_id
  from public.company_members cm
  where cm.user_id = p_owner_user_id and cm.status = 'active' and cm.role = 'owner';

  if v_owned = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
  end if;
  if v_owned > 1 then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_ID_REQUIRED';
  end if;

  v_result := public.esblu_owner_delete_company(p_owner_user_id, v_company_id);

  -- Pôvodná sémantika iba ak owner nemá žiadne ďalšie členstvo.
  if not exists (select 1 from public.company_members cm where cm.user_id = p_owner_user_id and cm.status = 'active') then
    delete from public.settings where user_id = p_owner_user_id;
    delete from public.user_legal_acceptances where user_id = p_owner_user_id;
  end if;

  return v_result;
end;
$function$;

-- C. Zrušenie GLOBÁLNEHO Esblu účtu (login). Povolené iba ak používateľ
--    nevlastní žiadnu firmu a nie je autorom záznamov, ktoré DB povinne
--    uchováva s odkazom na neho (FK bez ON DELETE: faktúry, platby, udalosti
--    faktúr, DPA súhlas). Zruší všetky zostávajúce (ne-owner) členstvá.
create or replace function public.esblu_user_global_cleanup(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_author boolean := false;
  v_part boolean;
begin
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_USER_ID';
  end if;

  if exists (select 1 from public.company_members cm where cm.user_id = p_user_id and cm.status = 'active' and cm.role = 'owner')
     or exists (select 1 from public.companies c where c.owner_id = p_user_id) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_USER_OWNS_COMPANY',
      hint = 'Globálny účet nemožno zrušiť, kým používateľ vlastní firmu — najprv ju treba zrušiť.';
  end if;

  -- Záznamy s povinným odkazom na autora (FK NO ACTION / RESTRICT) — zrušenie
  -- loginu by zlyhalo alebo by narušilo integritu. Právne riešenie
  -- (pseudonymizácia autora) = GDPR/CLIA otázka; dovtedy fail closed.
  if to_regclass('public.invoices') is not null then
    execute 'select exists (select 1 from public.invoices i where i.created_by = $1 or i.finalized_by = $1 or i.updated_by = $1)'
      into v_part using p_user_id;
    v_author := v_author or coalesce(v_part, false);
  end if;
  if to_regclass('public.invoice_payments') is not null then
    execute 'select exists (select 1 from public.invoice_payments p where p.recorded_by = $1)' into v_part using p_user_id;
    v_author := v_author or coalesce(v_part, false);
  end if;
  if to_regclass('public.invoice_events') is not null then
    execute 'select exists (select 1 from public.invoice_events e where e.actor_user_id = $1)' into v_part using p_user_id;
    v_author := v_author or coalesce(v_part, false);
  end if;
  if to_regclass('public.company_dpa_acceptances') is not null then
    execute 'select exists (select 1 from public.company_dpa_acceptances a where a.accepted_by = $1)' into v_part using p_user_id;
    v_author := v_author or coalesce(v_part, false);
  end if;

  if v_author then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_RETAINED_RECORDS_AUTHOR',
      hint = 'Používateľ je autorom účtovných / zmluvných záznamov firmy, ktoré sa uchovávajú. Členstvo môže opustiť; zrušenie loginu vyžaduje CLIA rozhodnutie.';
  end if;

  delete from public.chat_conversation_members where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('chat_conversation_members', v_n);

  delete from public.company_members where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('company_members', v_n);

  delete from public.user_active_company where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('user_active_company', v_n);

  delete from public.settings where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('settings', v_n);

  delete from public.user_legal_acceptances where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('user_legal_acceptances', v_n);

  return jsonb_build_object('deleted_counts', v_counts);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 9) Zrušenie (DB najprv, Storage po commite) — firma explicitne, 3 druhy
-- -----------------------------------------------------------------------------
alter table public.account_deletion_cleanup_jobs drop constraint if exists account_deletion_cleanup_jobs_kind_check;
alter table public.account_deletion_cleanup_jobs add constraint account_deletion_cleanup_jobs_kind_check
  check (kind in ('owner', 'member', 'global'));

drop function if exists public.esblu_account_deletion_commit(text, uuid);

create or replace function public.esblu_account_deletion_commit(
  p_kind text,
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_targets jsonb := '[]'::jsonb;
  v_user_targets jsonb := '[]'::jsonb;
  v_summary jsonb := '{}'::jsonb;
  v_global jsonb := null;
  v_remaining integer;
  v_delete_account boolean := coalesce(p_delete_account, false) or p_kind = 'global';
  v_job_id uuid;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('owner', 'member', 'global') then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_kind in ('owner', 'member') and p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_ID_REQUIRED';
  end if;

  if p_kind = 'owner' then
    if not exists (
      select 1 from public.company_members cm
      where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active' and cm.role = 'owner'
    ) then
      raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
    end if;

    -- Zámok firmy: súbežné súbory / checkouty / predplatné tejto firmy počkajú
    -- a po zrušení zlyhajú na FK → zoznam ciest je úplný.
    perform 1 from public.companies c where c.id = p_company_id for update;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', t.bucket, 'path', t.path)), '[]'::jsonb)
    into v_targets
    from (
      select d.storage_bucket as bucket, d.storage_path as path from public.documents d
        where d.company_id = p_company_id and d.storage_bucket is not null and d.storage_path is not null
      union all
      select a.storage_bucket, a.storage_path from public.document_attachments a
        where a.company_id = p_company_id and a.storage_bucket is not null and a.storage_path is not null
      union all
      select 'ai-evidence-documents', e.photo_url from public.ai_evidence e
        where e.company_id = p_company_id and e.photo_url is not null
      union all
      select 'machine-photos', m.file_path from public.machine_photos m
        where m.company_id = p_company_id and m.file_path is not null
      union all
      select 'inventory-photos', i.file_path from public.inventory_photos i
        where i.company_id = p_company_id and i.file_path is not null
      union all
      select 'vehicle-photos', v.storage_path from public.vehicle_photos v
        where v.company_id = p_company_id and v.storage_path is not null
      union all
      select 'company-logos', b.logo_path from public.company_billing_profile b
        where b.company_id = p_company_id and b.logo_path is not null
    ) t;

    -- archivácia, owner_id, poistka predplatného (20261012120000) → chyba = rollback
    v_summary := public.esblu_owner_delete_company(p_user_id, p_company_id);
  elsif p_kind = 'member' then
    v_summary := public.esblu_member_leave_company(p_user_id, p_company_id);
  end if;

  select count(*) into v_remaining
  from public.company_members cm
  where cm.user_id = p_user_id and cm.status = 'active';

  if v_delete_account then
    if p_kind <> 'global' and v_remaining > 0 then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_ACCOUNT_HAS_OTHER_COMPANIES',
        hint = 'Používateľ je stále členom ďalšej firmy — login sa nezruší.';
    end if;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'company-logos', 'path', s.logo_path)), '[]'::jsonb)
    into v_user_targets
    from public.settings s
    where s.user_id = p_user_id and s.logo_path is not null;

    -- vlastní firmu / autor uchovávaných záznamov → výnimka → rollback CELÉHO zrušenia
    v_global := public.esblu_user_global_cleanup(p_user_id);
  end if;

  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into v_targets
  from jsonb_array_elements(v_targets || v_user_targets) x;

  insert into public.account_deletion_cleanup_jobs
    (kind, user_id, company_id, storage_targets, storage_target_count, storage_status, auth_status, completed_at)
  values (
    p_kind, p_user_id, p_company_id, v_targets, jsonb_array_length(v_targets),
    case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end,
    case when v_delete_account then 'pending' else 'done' end,
    case when jsonb_array_length(v_targets) = 0 and not v_delete_account then now() end
  )
  returning id into v_job_id;

  return jsonb_build_object(
    'job_id', v_job_id,
    'storage_targets', v_targets,
    'summary', v_summary,
    'global', v_global,
    'delete_account', v_delete_account,
    'remaining_memberships', v_remaining
  );
end;
$function$;

comment on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) is
  'Multi-company zrušenie: owner = zruší firmu p_company_id, member = opustí firmu, global = zruší login '
  '(iba bez vlastnených firiem). DB + cleanup job v 1 transakcii; Storage/auth až po commite.';

-- -----------------------------------------------------------------------------
-- 10) Práva
-- -----------------------------------------------------------------------------
revoke all on function public.esblu_my_active_membership() from public, anon;
grant execute on function public.esblu_my_active_membership() to authenticated, service_role;
revoke all on function public.esblu_list_my_companies() from public, anon;
grant execute on function public.esblu_list_my_companies() to authenticated, service_role;
revoke all on function public.esblu_set_my_active_company(uuid) from public, anon;
grant execute on function public.esblu_set_my_active_company(uuid) to authenticated, service_role;
revoke all on function public.esblu_create_my_company(text) from public, anon;
grant execute on function public.esblu_create_my_company(text) to authenticated, service_role;

revoke all on function public.esblu_active_membership_for_user(uuid) from public, anon, authenticated;
grant execute on function public.esblu_active_membership_for_user(uuid) to service_role;
revoke all on function public.esblu_member_leave_company(uuid, uuid) from public, anon, authenticated;
grant execute on function public.esblu_member_leave_company(uuid, uuid) to service_role;
revoke all on function public.esblu_owner_delete_company(uuid, uuid) from public, anon, authenticated;
grant execute on function public.esblu_owner_delete_company(uuid, uuid) to service_role;
revoke all on function public.esblu_owner_delete_company(uuid) from public, anon, authenticated;
grant execute on function public.esblu_owner_delete_company(uuid) to service_role;
revoke all on function public.esblu_member_delete_self(uuid) from public, anon, authenticated;
grant execute on function public.esblu_member_delete_self(uuid) to service_role;
revoke all on function public.esblu_user_global_cleanup(uuid) from public, anon, authenticated;
grant execute on function public.esblu_user_global_cleanup(uuid) to service_role;
revoke all on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) to service_role;
