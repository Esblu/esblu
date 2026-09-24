-- =============================================================================
-- ROLE SCOPE HARDENING PRE HLAS AJ UI
--
-- Hlasový asistent nesmie mať viac práv než UI a databáza. Tu sa zosúlaďuje
-- databáza s produktovým modelom rolí, aby sa pravidlo dalo vynútiť na
-- jednom mieste — v RLS — a nie iba v Intent Engine.
--
-- 1. SKLAD: zamestnanec IBA ČÍTA
--    Doteraz esblu_role_can_operate() (owner/admin/employee) pustilo
--    zamestnanca aj k INSERT/UPDATE/DELETE na inventory_items a
--    inventory_photos. Produktové pravidlo: zamestnanec sklad vidí, ale
--    položku nezaloží, neupraví, nezmení množstvo ani nezmaže. Čítanie
--    zostáva bez zmeny.
--
-- 2. DODACIE LISTY SÚ FINANČNÝ PODKLAD
--    Zamestnanec dodací list smie odfotiť a odoslať, potom ho už neprezerá.
--    Dodací list žije na dvoch miestach:
--      • public.documents (document_type = 'delivery_note')
--      • public.ai_evidence (Inbox — spolu s vážnymi lístkami)
--    ai_evidence.document_type obsahuje PRELOŽENÝ popisok („Dodací list",
--    „Lieferschein", „Delivery note"), nie kód. Preto pribúda kanonický
--    stĺpec evidence_kind a helper, ktorý pri starších riadkoch bez neho
--    rozpozná popisok. Vážne lístky zostávajú prevádzkové.
--
-- 3. POTVRDENIA HLASOVÝCH ZÁPISOV
--    Allowlist esblu_create_action_confirmation sa rozširuje o nové zápisy
--    (sklad, stroje, vozidlá, zmazanie priečinka). Telo funkcie je inak
--    totožné s 20260926100000.
--
-- ČO SA NEMENÍ
--   • stroje, servisy strojov a vozidiel — dnešné pravidlá (esblu_role_can_operate)
--   • vozidlá — zápis owner/admin ako doteraz
--   • INSERT dokumentov a ai_evidence pre zamestnanca — príjem dokladov ostáva
--   • žiadne nové granty, žiadny anon EXECUTE
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Sklad — zápis iba owner/admin
-- -----------------------------------------------------------------------------

drop policy if exists inventory_items_insert_operational on public.inventory_items;
drop policy if exists inventory_items_update_operational on public.inventory_items;
drop policy if exists inventory_items_delete_operational on public.inventory_items;
drop policy if exists inventory_items_insert_manager on public.inventory_items;
drop policy if exists inventory_items_update_manager on public.inventory_items;
drop policy if exists inventory_items_delete_manager on public.inventory_items;

create policy inventory_items_insert_manager on public.inventory_items
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  );

create policy inventory_items_update_manager on public.inventory_items
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  );

create policy inventory_items_delete_manager on public.inventory_items
  for delete to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  );

drop policy if exists inventory_photos_insert_operational on public.inventory_photos;
drop policy if exists inventory_photos_update_operational on public.inventory_photos;
drop policy if exists inventory_photos_delete_operational on public.inventory_photos;
drop policy if exists inventory_photos_insert_manager on public.inventory_photos;
drop policy if exists inventory_photos_update_manager on public.inventory_photos;
drop policy if exists inventory_photos_delete_manager on public.inventory_photos;

create policy inventory_photos_insert_manager on public.inventory_photos
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  );

create policy inventory_photos_update_manager on public.inventory_photos
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  );

create policy inventory_photos_delete_manager on public.inventory_photos
  for delete to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
  );

-- Storage: zmazať referencovanú fotku skladu smie už iba owner/admin tej
-- firmy. Nereferencovaný (zlyhaný) upload naďalej smie zmazať jeho autor.
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

revoke all on function public.esblu_can_delete_inventory_photo_object(text) from public, anon;
grant execute on function public.esblu_can_delete_inventory_photo_object(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Dodacie listy — finančný podklad
-- -----------------------------------------------------------------------------

-- 2a. documents: jediná definícia finančne citlivého dokumentu.
create or replace function public.esblu_document_requires_finance(p_document_type text, p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_document_type, '') in ('invoice', 'receipt', 'delivery_note')
      or coalesce(p_status, '') in ('uploaded', 'processing');
$$;

comment on function public.esblu_document_requires_finance(text, text) is
  'Finančne citlivý dokument: faktúra, bloček, dodací list, alebo ešte neklasifikovaný upload. Jediná definícia pre RLS aj storage.';

-- 2b. ai_evidence: kanonický druh záznamu.
alter table public.ai_evidence
  add column if not exists evidence_kind text;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.ai_evidence'::regclass
                   and conname = 'ai_evidence_evidence_kind_check') then
    alter table public.ai_evidence
      add constraint ai_evidence_evidence_kind_check
      check (evidence_kind is null or evidence_kind in ('weigh_ticket', 'delivery_note'));
  end if;
end $$;

comment on column public.ai_evidence.evidence_kind is
  'Kanonický druh záznamu (weigh_ticket | delivery_note). document_type obsahuje iba preložený popisok. Dodací list je finančný podklad.';

-- Dodací list? Kanonický stĺpec má prednosť; staršie riadky bez neho sa
-- rozpoznajú podľa popisku vo všetkých jazykoch appky.
create or replace function public.esblu_evidence_is_delivery_note(p_kind text, p_label text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_kind is not null then p_kind = 'delivery_note'
    else lower(coalesce(p_label, '')) in (
      'delivery_note', 'dodací list', 'dodaci list', 'lieferschein', 'delivery note'
    )
  end;
$$;

revoke all on function public.esblu_evidence_is_delivery_note(text, text) from public, anon;
grant execute on function public.esblu_evidence_is_delivery_note(text, text) to authenticated;

drop policy if exists ai_evidence_select_operational on public.ai_evidence;
drop policy if exists ai_evidence_select_scoped on public.ai_evidence;
create policy ai_evidence_select_scoped on public.ai_evidence
  for select to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and (
      (
        not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)
        and public.esblu_role_can_operate()
      )
      or (
        public.esblu_evidence_is_delivery_note(evidence_kind, document_type)
        and public.esblu_my_finance_view()
      )
    )
  );

drop policy if exists ai_evidence_update_owner_admin on public.ai_evidence;
drop policy if exists ai_evidence_update_scoped on public.ai_evidence;
create policy ai_evidence_update_scoped on public.ai_evidence
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
    and (
      not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)
      or public.esblu_my_finance_manage()
    )
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
    and (
      not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)
      or public.esblu_my_finance_manage()
    )
  );

drop policy if exists ai_evidence_delete_owner_admin on public.ai_evidence;
drop policy if exists ai_evidence_delete_scoped on public.ai_evidence;
create policy ai_evidence_delete_scoped on public.ai_evidence
  for delete to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() in ('owner', 'admin')
    and (
      not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)
      or public.esblu_my_finance_manage()
    )
  );

-- 2c. Storage fotky z ai_evidence: dodací list iba s finance.view vo firme,
-- vážny lístok iba prevádzkové roly (účtovník vážne lístky nevidí ani ako
-- riadky). Nereferencovaný upload: iba jeho autor.
create or replace function public.esblu_can_read_ai_evidence_object(p_object_name text)
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
  v_is_delivery_note boolean;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select
    count(*),
    count(*) filter (where ae.company_id is null),
    count(distinct ae.company_id)
  into v_referenced_row_count, v_null_company_count, v_distinct_company_count
  from public.ai_evidence ae
  where ae.photo_url = p_object_name;

  if v_referenced_row_count = 0 then
    return v_uploader_uid = v_uid::text;
  end if;

  if v_null_company_count > 0 or v_distinct_company_count <> 1 then
    return false;
  end if;

  select ae.company_id,
         bool_or(public.esblu_evidence_is_delivery_note(ae.evidence_kind, ae.document_type))
  into v_company_id, v_is_delivery_note
  from public.ai_evidence ae
  where ae.photo_url = p_object_name and ae.company_id is not null
  group by ae.company_id;

  if v_is_delivery_note then
    return public.esblu_has_finance_view_in_company(v_company_id);
  end if;

  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.role in ('owner', 'admin', 'employee')
      and cm.company_id = v_company_id
  );
end;
$function$;

revoke all on function public.esblu_can_read_ai_evidence_object(text) from public, anon;
grant execute on function public.esblu_can_read_ai_evidence_object(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Potvrdenia hlasových zápisov
-- -----------------------------------------------------------------------------

alter table public.assistant_action_confirmations
  drop constraint if exists assistant_action_confirmations_intent_check;
alter table public.assistant_action_confirmations
  add constraint assistant_action_confirmations_intent_check
  check (intent in (
    'CREATE_DOCUMENT_CATEGORY',
    'RENAME_DOCUMENT_CATEGORY',
    'ASSIGN_DOCUMENTS_TO_CATEGORY',
    'DELETE_DOCUMENT_CATEGORY',
    'MOVE_DOCUMENTS_TO_CATEGORY',
    'FOLDER_CREATE',
    'FOLDER_ADD_ITEMS',
    'FOLDER_REMOVE_ITEMS',
    'FOLDER_DELETE',
    'INVENTORY_ITEM_CREATE',
    'INVENTORY_QUANTITY_ADJUST',
    'INVENTORY_ITEM_DELETE',
    'MACHINE_CREATE',
    'MACHINE_SERVICE_ADD',
    'MACHINE_DELETE',
    'VEHICLE_CREATE',
    'VEHICLE_SERVICE_ADD',
    'VEHICLE_DELETE'
  ));

create or replace function public.esblu_create_action_confirmation(
  p_intent text,
  p_canonical_args jsonb,
  p_expected_count integer,
  p_nonce text,
  p_server_proof text,
  p_expires_at_epoch bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_id uuid;
  v_expires_at timestamptz;
  v_pending_count integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_intent is null or p_intent not in (
    'CREATE_DOCUMENT_CATEGORY',
    'RENAME_DOCUMENT_CATEGORY',
    'ASSIGN_DOCUMENTS_TO_CATEGORY',
    'DELETE_DOCUMENT_CATEGORY',
    'MOVE_DOCUMENTS_TO_CATEGORY',
    'FOLDER_CREATE',
    'FOLDER_ADD_ITEMS',
    'FOLDER_REMOVE_ITEMS',
    'FOLDER_DELETE',
    'INVENTORY_ITEM_CREATE',
    'INVENTORY_QUANTITY_ADJUST',
    'INVENTORY_ITEM_DELETE',
    'MACHINE_CREATE',
    'MACHINE_SERVICE_ADD',
    'MACHINE_DELETE',
    'VEHICLE_CREATE',
    'VEHICLE_SERVICE_ADD',
    'VEHICLE_DELETE'
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ACTION_INTENT';
  end if;

  if p_canonical_args is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_CANONICAL_ARGS';
  end if;

  if p_expected_count is not null and p_expected_count < 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_EXPECTED_COUNT';
  end if;

  if p_nonce is null or p_nonce !~ '^[0-9a-f]{16,128}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_NONCE';
  end if;

  if p_server_proof is null or p_server_proof !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_SERVER_PROOF';
  end if;

  if p_expires_at_epoch is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_EXPIRY';
  end if;

  v_expires_at := to_timestamp(p_expires_at_epoch);
  if v_expires_at <= now() or v_expires_at > now() + interval '6 minutes' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_EXPIRY';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  select count(*) into v_pending_count
  from public.assistant_action_confirmations
  where user_id = v_uid
    and consumed_at is null
    and expires_at > now();

  if v_pending_count >= 20 then
    raise exception using errcode = 'P0001', message = 'ESBLU_TOO_MANY_PENDING_CONFIRMATIONS';
  end if;

  insert into public.assistant_action_confirmations (
    user_id, company_id, intent, canonical_args, expected_count, nonce, server_proof, expires_at
  ) values (
    v_uid, v_company_id, p_intent, p_canonical_args, p_expected_count, p_nonce, p_server_proof, v_expires_at
  )
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.esblu_create_action_confirmation(text, jsonb, integer, text, text, bigint) from public, anon;
grant execute on function public.esblu_create_action_confirmation(text, jsonb, integer, text, text, bigint) to authenticated;
