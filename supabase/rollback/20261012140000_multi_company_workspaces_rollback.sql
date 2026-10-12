-- Rollback 20261012140000 (iba staging / po schválení).
-- ZABLOKOVANÉ, ak niektorý používateľ má 2+ aktívne členstvá: návrat k modelu
-- „max 1 aktívne členstvo" by inak vyžadoval rozhodnúť, ktoré členstvo zrušiť
-- (strata prístupu / dát) — to sa nerobí automaticky.
do $rb$
begin
  if exists (select 1 from public.company_members where status = 'active' group by user_id having count(*) > 1) then
    raise exception using errcode = 'P0001', message = 'ESBLU_MULTI_COMPANY_ROLLBACK_BLOCKED',
      hint = 'Používateľ s 2+ aktívnymi členstvami — vyrieš manuálne pred rollbackom.';
  end if;
end
$rb$;

-- esblu_accept_company_dpa (pôvodná definícia)
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

-- esblu_assign_company_id (pôvodná definícia)
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

-- esblu_can_delete_inventory_photo_object (pôvodná definícia)
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
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_delete_vehicle_photo_object (pôvodná definícia)
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
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_manage_document (pôvodná definícia)
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
  where cm.user_id = v_uid and cm.status = 'active' and cm.company_id = v_company_id
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

-- esblu_can_read_ai_evidence_object (pôvodná definícia)
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
      and cm.role in ('owner', 'admin', 'employee')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_read_ai_inbox_object (pôvodná definícia)
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
    where cm.user_id = v_uid and cm.status = 'active' and cm.company_id = v_document_company_id
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

-- esblu_can_read_document (pôvodná definícia)
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
  where cm.user_id = v_uid and cm.status = 'active' and cm.company_id = v_company_id
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

-- esblu_consume_ai_scan_quota (pôvodná definícia)
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

-- esblu_can_delete_ai_evidence_object (pôvodná definícia)
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
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_can_delete_ai_inbox_object (pôvodná definícia)
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

-- esblu_can_delete_machine_photo_object (pôvodná definícia)
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
      and cm.company_id = v_company_id
  );
end;
$function$;

-- esblu_enforce_plan_limit (pôvodná definícia)
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

-- esblu_get_company_profile (pôvodná definícia)
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
  limit 1;
$function$;

-- esblu_get_my_company_dpa_status (pôvodná definícia)
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

-- esblu_get_my_company_entitlements (pôvodná definícia)
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

-- esblu_has_finance_manage_in_company (pôvodná definícia)
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
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$$;

-- esblu_has_finance_view_in_company (pôvodná definícia)
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
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$$;

-- esblu_list_my_company_invites (pôvodná definícia)
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

-- esblu_list_my_company_members (pôvodná definícia)
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

-- esblu_my_active_role (pôvodná definícia)
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
  limit 1;
$function$;

-- esblu_my_finance_manage (pôvodná definícia)
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
      limit 1
    ),
    false
  );
$$;

-- esblu_my_finance_view (pôvodná definícia)
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
      limit 1
    ),
    false
  );
$$;

-- esblu_role_can_operate (pôvodná definícia)
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
      limit 1
    ),
    false
  );
$$;

-- esblu_require_my_entitlement (pôvodná definícia)
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

-- esblu_reserve_ai_processing (pôvodná definícia)
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

-- esblu_billing_my_access (pôvodná definícia)
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
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  v_manage := v_member.role = 'owner'
    or (v_member.role = 'admin'
        and coalesce((v_member.permissions -> 'billing' ->> 'manage')::boolean, false));
  v_view := v_manage or coalesce(public.esblu_my_finance_view(), false);

  return jsonb_build_object('company_id', v_member.company_id, 'role', v_member.role,
                            'can_manage', v_manage, 'can_view', v_view);
end
$function$;

-- esblu_create_company_invite (pôvodná definícia)
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

-- esblu_accept_company_invite (pôvodná definícia)
create or replace function public.esblu_accept_company_invite(p_token text)
returns table(company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_email text;
  v_token_hash text;
  v_invite record;
  v_existing_active_count integer;
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

  -- Finančnú rolu musí udeliť AKTUÁLNY owner tej istej firmy. Pozvánka,
  -- ktorú vytvoril admin (pred touto opravou) alebo owner, ktorý už nie je
  -- ownerom, sa neprijme — pozvaný nedostane finančný prístup od niekoho,
  -- kto ho nemá.
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

  select count(*) into v_existing_active_count
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active';

  if v_existing_active_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_invite.company_id::text || ':team_members', 0));

  select count(*) into v_active_members
  from public.company_members m
  where m.company_id = v_invite.company_id and m.status = 'active';

  perform public.esblu_require_entitlement_capacity(v_invite.company_id, 'team_members', v_active_members);

  begin
    insert into public.company_members (company_id, user_id, role, status)
    values (v_invite.company_id, v_uid, v_invite.role, 'active');
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP';
  end;

  update public.company_invites
  set status = 'accepted', accepted_at = now(), accepted_by = v_uid
  where id = v_invite.id;

  return query select v_invite.company_id, v_invite.role;
end;
$function$;

-- esblu_ensure_my_owner_company (pôvodná definícia)
create or replace function public.esblu_ensure_my_owner_company()
returns table(company_id uuid, role text, created boolean)
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
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  select m.company_id, m.role
  into v_existing
  from public.company_members m
  where m.user_id = v_uid
    and m.status = 'active'
  limit 1;

  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_uid;

  if v_email is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;

  v_email := lower(btrim(v_email));

  -- Pozvaný používateľ (napr. po overení e-mailu, ktoré ho vrátilo inam
  -- než na pozvánku) si NESMIE založiť vlastnú firmu — tým by pozvánku už
  -- nikdy neprijal (jedno aktívne členstvo na používateľa). Klient ho
  -- nasmeruje späť na pozvánku.
  if exists (
    select 1 from public.company_invites ci
    where ci.email = v_email
      and ci.status = 'pending'
      and ci.expires_at > now()
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_PENDING_INVITE_EXISTS';
  end if;

  select exists (
    select 1
    from public.beta_allowlist ba
    where ba.email = v_email
      and ba.revoked_at is null
      and ba.consumed_at is null
  ) into v_beta_allowed;

  if not v_beta_allowed then
    raise exception using
      errcode = '42501',
      message = 'ESBLU_BETA_ACCESS_REQUIRED';
  end if;

  select coalesce(nullif(btrim(s.company_name), ''), 'Moja firma')
  into v_company_name
  from public.settings s
  where s.user_id = v_uid
  limit 1;

  v_company_name := coalesce(v_company_name, 'Moja firma');

  begin
    insert into public.companies (owner_id, name)
    values (v_uid, v_company_name)
    returning id into v_company_id;

    insert into public.company_members (company_id, user_id, role, status)
    values (v_company_id, v_uid, 'owner', 'active');

    insert into public.company_billing_profile (company_id, legal_name)
    values (v_company_id, v_company_name);
  exception
    when unique_violation then
      select m.company_id, m.role
      into v_existing
      from public.company_members m
      where m.user_id = v_uid
        and m.status = 'active'
      limit 1;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'ESBLU_OWNER_BOOTSTRAP_RACE_UNRESOLVED';
      end if;

      return query select v_existing.company_id, v_existing.role, false;
      return;
  end;

  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()),
      consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;

-- esblu_get_or_create_direct_conversation (pôvodná definícia)
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
  select cm.company_id into v_other_company_id
  from public.company_members cm
  where cm.user_id = p_other_user_id
    and cm.status = 'active'
  limit 1;

  if v_other_company_id is null or v_other_company_id <> v_company_id then
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

-- esblu_can_manage_company_logo_object (pôvodná definícia)
CREATE OR REPLACE FUNCTION public.esblu_can_manage_company_logo_object(p_object_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_uploader_active_company_count integer;
  v_uploader_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select count(*)
  into v_uploader_active_company_count
  from public.company_members cm
  where cm.user_id::text = v_uploader_uid
    and cm.status = 'active';

  if v_uploader_active_company_count <> 1 then
    return false;
  end if;

  select cm.company_id
  into v_uploader_company_id
  from public.company_members cm
  where cm.user_id::text = v_uploader_uid
    and cm.status = 'active'
  limit 1;

  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_uploader_company_id
  );
end;
$function$;

-- esblu_member_delete_self (pôvodná definícia)
CREATE OR REPLACE FUNCTION public.esblu_member_delete_self(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company_id uuid;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  if p_user_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_USER_ID';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = p_user_id
    and cm.status = 'active'
    and cm.role in ('admin', 'accountant', 'employee')
  limit 1;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NOT_ACTIVE_MEMBER',
      hint = 'Volajúci nemá aktívny company_members riadok s rolou admin/accountant/employee (owner musí použiť esblu_owner_delete_company).';
  end if;

  delete from public.settings where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('settings', v_n);

  delete from public.user_legal_acceptances where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('user_legal_acceptances', v_n);

  delete from public.company_members where user_id = p_user_id and company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('company_members', v_n);

  return jsonb_build_object(
    'company_id', v_company_id,
    'deleted_counts', v_counts
  );
end;
$function$;

-- esblu_owner_delete_company (pôvodná definícia)
create or replace function public.esblu_owner_delete_company(p_owner_user_id uuid)
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
  if p_owner_user_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_USER_ID';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = p_owner_user_id
    and cm.status = 'active'
    and cm.role = 'owner'
  limit 1;

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

  -- Ownerove vlastné user-scoped záznamy (auth.users sa maže mimo tejto
  -- funkcie, cez Admin API, ako posledný krok v API route).
  delete from public.settings where user_id = p_owner_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('settings', v_n);

  delete from public.user_legal_acceptances where user_id = p_owner_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('user_legal_acceptances', v_n);

  return jsonb_build_object(
    'company_id', v_company_id,
    'deleted_counts', v_counts
  );
end;
$function$;

-- esblu_my_active_company_id (pôvodná definícia)
create or replace function public.esblu_my_active_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select cm.company_id
  from public.company_members cm
  where cm.user_id = auth.uid()
    and cm.status = 'active'
  limit 1;
$function$;

drop function if exists public.esblu_owner_delete_company(uuid, uuid);
drop function if exists public.esblu_member_leave_company(uuid, uuid);
drop function if exists public.esblu_user_global_cleanup(uuid);
drop function if exists public.esblu_account_deletion_commit(text, uuid, uuid, boolean);
drop function if exists public.esblu_create_my_company(text);
drop function if exists public.esblu_set_my_active_company(uuid);
drop function if exists public.esblu_list_my_companies();
drop function if exists public.esblu_active_membership_for_user(uuid);
drop function if exists public.esblu_my_active_membership();
drop trigger if exists company_members_owner_guard on public.company_members;
drop function if exists public.esblu_company_members_owner_guard();
drop index if exists public.company_members_user_active_idx;
drop index if exists public.company_members_one_owner_per_company_idx;
create unique index if not exists company_members_one_active_per_user_idx on public.company_members (user_id) where status = 'active';
drop table if exists public.user_active_company;
delete from public.account_deletion_cleanup_jobs where kind = 'global' and storage_status = 'done' and auth_status = 'done';
alter table public.account_deletion_cleanup_jobs drop constraint if exists account_deletion_cleanup_jobs_kind_check;
alter table public.account_deletion_cleanup_jobs add constraint account_deletion_cleanup_jobs_kind_check check (kind in ('owner', 'member'));

-- esblu_account_deletion_commit(text, uuid) z 20261012130000
create or replace function public.esblu_account_deletion_commit(p_kind text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_targets jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_job_id uuid;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('owner', 'member') then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;

  if p_kind = 'owner' then
    select cm.company_id into v_company_id
    from public.company_members cm
    where cm.user_id = p_user_id and cm.status = 'active' and cm.role = 'owner'
    limit 1;
    if v_company_id is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
    end if;

    -- Zámok firmy: súbežné vloženie súboru / checkoutu / predplatného tejto
    -- firmy (FK → companies) počká a po zrušení zlyhá. Cesty nižšie sú preto úplné.
    perform 1 from public.companies c where c.id = v_company_id for update;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', t.bucket, 'path', t.path)), '[]'::jsonb)
    into v_targets
    from (
      select d.storage_bucket as bucket, d.storage_path as path from public.documents d
        where d.company_id = v_company_id and d.storage_bucket is not null and d.storage_path is not null
      union all
      select a.storage_bucket, a.storage_path from public.document_attachments a
        where a.company_id = v_company_id and a.storage_bucket is not null and a.storage_path is not null
      union all
      select 'ai-evidence-documents', e.photo_url from public.ai_evidence e
        where e.company_id = v_company_id and e.photo_url is not null
      union all
      select 'machine-photos', m.file_path from public.machine_photos m
        where m.company_id = v_company_id and m.file_path is not null
      union all
      select 'inventory-photos', i.file_path from public.inventory_photos i
        where i.company_id = v_company_id and i.file_path is not null
      union all
      select 'vehicle-photos', v.storage_path from public.vehicle_photos v
        where v.company_id = v_company_id and v.storage_path is not null
      union all
      select 'company-logos', s.logo_path from public.settings s
        where s.user_id = p_user_id and s.logo_path is not null
      union all
      select 'company-logos', b.logo_path from public.company_billing_profile b
        where b.company_id = v_company_id and b.logo_path is not null
    ) t;

    -- Archivácia, owner_id, predplatné (poistka 20261012120000) — chyba = rollback celej transakcie.
    v_summary := public.esblu_owner_delete_company(p_user_id);
  else
    select cm.company_id into v_company_id
    from public.company_members cm
    where cm.user_id = p_user_id and cm.status = 'active'
    limit 1;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'company-logos', 'path', s.logo_path)), '[]'::jsonb)
    into v_targets
    from public.settings s
    where s.user_id = p_user_id and s.logo_path is not null;

    v_summary := public.esblu_member_delete_self(p_user_id);
  end if;

  insert into public.account_deletion_cleanup_jobs (kind, user_id, company_id, storage_targets, storage_target_count, storage_status)
  values (p_kind, p_user_id, v_company_id, v_targets, jsonb_array_length(v_targets),
          case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end)
  returning id into v_job_id;

  return jsonb_build_object('job_id', v_job_id, 'storage_targets', v_targets, 'summary', v_summary);
end
$function$;
revoke all on function public.esblu_account_deletion_commit(text, uuid) from public, anon, authenticated;
grant execute on function public.esblu_account_deletion_commit(text, uuid) to service_role;
