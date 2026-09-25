-- =============================================================================
-- Asistent — premenovanie priečinka a skladovej položky (potvrdenie).
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. Aplikovať iba po výslovnom schválení cez
-- Supabase MCP apply_migration (supabase/MIGRATIONS.md). NIKDY db push.
-- Kým nie je aplikované, asistent náhľad premenovania nevytvorí (DB allowlist
-- ho odmietne) a povie používateľovi, nech premenuje priamo v UI — nič sa
-- nezmení (fail closed).
--
-- ČO A PREČO
-- ----------
-- FOLDER_RENAME a INVENTORY_ITEM_RENAME idú cez ten istý jednorazový HMAC
-- potvrdzovací tok ako ostatné zápisy. Mení sa IBA allowlist intentov (CHECK
-- + IF vo funkcii). Žiadna tabuľka, stĺpec, RLS politika ani grant sa
-- nerozširuje. Samotné premenovanie robí používateľ pod vlastnou RLS — tou
-- istou ako tlačidlo „Premenovať" v priečinku / úprava položky v Sklade.
-- Funkcia ostáva SECURITY DEFINER so search_path = '' a EXECUTE iba pre
-- authenticated.
-- =============================================================================

begin;

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
    'VEHICLE_DELETE',
    'INBOX_DELETE_UNASSIGNED',
    'FOLDER_RENAME',
    'INVENTORY_ITEM_RENAME'
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
    'VEHICLE_DELETE',
    'INBOX_DELETE_UNASSIGNED',
    'FOLDER_RENAME',
    'INVENTORY_ITEM_RENAME'
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

commit;
