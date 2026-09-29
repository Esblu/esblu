-- =============================================================================
-- M1 authz (2026-09-29) — Human Chat: zápis a čítanie iba v konverzácii,
-- ktorej je volajúci oprávneným účastníkom.
-- NEAPLIKOVANÉ. Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
-- ZÁVISLOSŤ: po 20260930100000 (esblu_attach_chat_message_reference — táto
-- migrácia ju preberá doslovne a pridáva kontrolu konverzácie).
--
-- PRED (prod katalóg 2026-09-29):
--   chat_messages_insert_member WITH CHECK
--     company_id = aktívna firma AND author_id = auth.uid() AND (
--       EXISTS (company channel s c.id = chat_messages.conversation_id a aktívnou firmou)
--       OR EXISTS (SELECT 1 FROM chat_conversation_members m
--                  WHERE m.conversation_id = m.conversation_id   -- ← TAUTOLÓGIA
--                    AND m.user_id = auth.uid()))
--   Druhá vetva neviaže členstvo na cieľovú konverzáciu: stačí BYŤ členom
--   ĽUBOVOĽNEJ konverzácie. esblu_mark_conversation_read vkladá riadok
--   členstva aj pre firemný kanál (read pointer), takže prakticky každý
--   používateľ, ktorý kedy otvoril firemný chat, spĺňa podmienku.
--   Exploit:
--     a) zamestnanec/účtovník vloží správu do CUDZEJ direct konverzácie
--        (napr. owner ↔ iný zamestnanec) vo svojej firme — príjemcovia ju
--        uvidia v súkromnom vlákne (SELECT im to povolí, sú členmi),
--     b) vloží správu do konverzácie INEJ firmy (conversation_id cudzej
--        firmy, company_id = jeho firma; kontrola c.company_id chýba) —
--        cudzí tenant ju nevidí, ale esblu_get_my_unread_counts ju počíta
--        (nefiltruje company_id) → cross-tenant spam/signál,
--     c) prílohy (chat_attachments + Storage chat-attachments) a referencie
--        stoja na „vlastnej správe" → dedia tú istú dieru.
--   Súvisiace slabiny:
--     - SELECT politiky (správy, prílohy, referencie, Storage) pri firemnom
--       kanáli nekontrolujú c.company_id a pri direct iba riadok členstva,
--     - chat_conversations SELECT pri direct nekontroluje firmu,
--     - esblu_mark_conversation_read pri direct nekontroluje firmu,
--     - esblu_get_my_unread_counts nefiltruje company_id správ,
--     - chat_attachments INSERT neviaže bucket/cestu na správu.
--
-- PO: jediný DB zdroj pravdy esblu_chat_can_access_conversation(conversation):
--   - volajúci má aktívne členstvo vo firme (esblu_my_active_company_id),
--   - konverzácia patrí tej istej firme,
--   - company channel → každý aktívny člen firmy (owner/admin/accountant/
--     employee — Human Chat pre všetky roly, nezávisle od AI oprávnení),
--   - direct → iba ak je volajúci jedným z dvoch účastníkov
--     (direct_user_low/high) A má riadok členstva v tej istej firme.
--   Owner/admin NEMAJÚ prístup k cudzím direct konverzáciám.
--   Používajú ho všetky chat politiky (správy, prílohy, referencie,
--   konverzácie, Storage) aj RPC (referencia, prečítanie, unread).
--
-- ROLLBACK: pôvodné politiky a funkcie z prod katalógu 2026-09-29 (texty
--   v PRED; funkcie esblu_mark_conversation_read / esblu_get_my_unread_counts
--   z prod, esblu_attach_chat_message_reference z 20260930100000), potom
--   drop function esblu_chat_can_access_conversation(uuid).
-- =============================================================================

begin;

-- 1) Jediný zdroj pravdy ---------------------------------------------------------
create or replace function public.esblu_chat_can_access_conversation(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.chat_conversations c
    where c.id = p_conversation_id
      and auth.uid() is not null
      and c.company_id = public.esblu_my_active_company_id()
      and (
        c.type = 'company'
        or (
          c.type = 'direct'
          and auth.uid() in (c.direct_user_low, c.direct_user_high)
          and exists (
            select 1 from public.chat_conversation_members m
            where m.conversation_id = c.id
              and m.user_id = auth.uid()
              and m.company_id = c.company_id
          )
        )
      )
  );
$function$;
revoke all on function public.esblu_chat_can_access_conversation(uuid) from public, anon;
grant execute on function public.esblu_chat_can_access_conversation(uuid) to authenticated;

-- 2) chat_messages -----------------------------------------------------------------
drop policy if exists chat_messages_insert_member on public.chat_messages;
create policy chat_messages_insert_member
  on public.chat_messages
  for insert
  to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and author_id = (select auth.uid())
    and deleted_at is null
    and public.esblu_chat_can_access_conversation(conversation_id)
  );

drop policy if exists chat_messages_select_company on public.chat_messages;
create policy chat_messages_select_company
  on public.chat_messages
  for select
  to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_chat_can_access_conversation(conversation_id)
  );

drop policy if exists chat_messages_update_own on public.chat_messages;
create policy chat_messages_update_own
  on public.chat_messages
  for update
  to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and author_id = (select auth.uid())
    and deleted_at is null
    and public.esblu_chat_can_access_conversation(conversation_id)
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and author_id = (select auth.uid())
    and public.esblu_chat_can_access_conversation(conversation_id)
  );
-- DELETE: žiadna politika ani grant (mazanie = soft delete cez UPDATE).

-- 3) chat_conversations -------------------------------------------------------------
drop policy if exists chat_conversations_select_member on public.chat_conversations;
create policy chat_conversations_select_member
  on public.chat_conversations
  for select
  to authenticated
  using (public.esblu_chat_can_access_conversation(id));

-- 4) chat_attachments ---------------------------------------------------------------
drop policy if exists chat_attachments_insert_own_message on public.chat_attachments;
create policy chat_attachments_insert_own_message
  on public.chat_attachments
  for insert
  to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and storage_bucket = 'chat-attachments'
    and exists (
      select 1 from public.chat_messages m
      where m.id = chat_attachments.message_id
        and m.author_id = (select auth.uid())
        and m.company_id = public.esblu_my_active_company_id()
        and m.deleted_at is null
        and public.esblu_chat_can_access_conversation(m.conversation_id)
        -- cesta = <firma>/<konverzácia>/<správa>/<náhodný názov>
        and split_part(chat_attachments.storage_path, '/', 1) = m.company_id::text
        and split_part(chat_attachments.storage_path, '/', 2) = m.conversation_id::text
        and split_part(chat_attachments.storage_path, '/', 3) = m.id::text
    )
  );

drop policy if exists chat_attachments_select_company on public.chat_attachments;
create policy chat_attachments_select_company
  on public.chat_attachments
  for select
  to authenticated
  using (
    exists (
      select 1 from public.chat_messages m
      where m.id = chat_attachments.message_id
        and m.company_id = public.esblu_my_active_company_id()
        and public.esblu_chat_can_access_conversation(m.conversation_id)
    )
  );

-- 5) chat_message_references (zápis iba cez RPC) --------------------------------------
drop policy if exists chat_message_references_select_company on public.chat_message_references;
create policy chat_message_references_select_company
  on public.chat_message_references
  for select
  to authenticated
  using (
    exists (
      select 1 from public.chat_messages m
      where m.id = chat_message_references.message_id
        and m.company_id = public.esblu_my_active_company_id()
        and public.esblu_chat_can_access_conversation(m.conversation_id)
    )
  );

-- 6) Storage chat-attachments ---------------------------------------------------------
drop policy if exists chat_attachments_insert_own_message on storage.objects;
create policy chat_attachments_insert_own_message
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and exists (
      select 1 from public.chat_messages m
      where m.id::text = (storage.foldername(objects.name))[3]
        and (storage.foldername(objects.name))[1] = m.company_id::text
        and (storage.foldername(objects.name))[2] = m.conversation_id::text
        and m.author_id = (select auth.uid())
        and m.company_id = public.esblu_my_active_company_id()
        and m.deleted_at is null
        and public.esblu_chat_can_access_conversation(m.conversation_id)
    )
  );

drop policy if exists chat_attachments_select_conversation_member on storage.objects;
create policy chat_attachments_select_conversation_member
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'chat-attachments'
    and exists (
      select 1 from public.chat_messages m
      where m.id::text = (storage.foldername(objects.name))[3]
        and (storage.foldername(objects.name))[2] = m.conversation_id::text
        and m.company_id = public.esblu_my_active_company_id()
        and public.esblu_chat_can_access_conversation(m.conversation_id)
    )
  );

-- 7) RPC ------------------------------------------------------------------------------
-- 7a) Referencia: 20260930100000 doslovne + prístup ku konverzácii správy.
create or replace function public.esblu_attach_chat_message_reference(
  p_message_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
returns public.chat_message_references
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_message_company_id uuid;
  v_message_author_id uuid;
  v_message_deleted_at timestamptz;
  v_message_conversation_id uuid;
  v_entity_ok boolean := false;
  v_row public.chat_message_references;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if p_entity_type not in (
    'vehicle', 'machine', 'inventory_item', 'document', 'vehicle_service', 'machine_service'
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ENTITY_TYPE:' || coalesce(p_entity_type, '');
  end if;

  select m.company_id, m.author_id, m.deleted_at, m.conversation_id
    into v_message_company_id, v_message_author_id, v_message_deleted_at, v_message_conversation_id
  from public.chat_messages m
  where m.id = p_message_id;

  if v_message_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MESSAGE_NOT_FOUND';
  end if;

  if v_message_company_id <> v_company_id or v_message_author_id <> v_uid then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN_NOT_MESSAGE_AUTHOR';
  end if;

  -- M1 chat: autor musí mať prístup ku konverzácii správy (aj po odchode z nej).
  if not public.esblu_chat_can_access_conversation(v_message_conversation_id) then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN_NOT_MESSAGE_AUTHOR';
  end if;

  if v_message_deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MESSAGE_DELETED';
  end if;

  -- M1 audit: prevádzkové entity (vozidlo, stroj, sklad, servis) pripne iba
  -- rola, ktorá ich smie čítať (esblu_role_can_operate — owner/admin/
  -- employee). Účtovník inak vedel skúšaním UUID zistiť existenciu vozidla.
  if p_entity_type <> 'document' and not public.esblu_role_can_operate() then
    raise exception using errcode = 'P0001', message = 'ESBLU_ENTITY_NOT_FOUND_OR_FORBIDDEN';
  end if;

  if p_entity_type = 'vehicle' then
    select exists (
      select 1 from public.vehicles v where v.id = p_entity_id and v.company_id = v_company_id
    ) into v_entity_ok;
  elsif p_entity_type = 'machine' then
    select exists (
      select 1 from public.machines mm where mm.id = p_entity_id and mm.company_id = v_company_id
    ) into v_entity_ok;
  elsif p_entity_type = 'inventory_item' then
    select exists (
      select 1 from public.inventory_items ii where ii.id = p_entity_id and ii.company_id = v_company_id
    ) into v_entity_ok;
  elsif p_entity_type = 'document' then
    -- M1 audit: iba doklad, ktorý autor sám smie čítať (finančný doklad
    -- zamestnanec ani admin bez financií nepripne a ani nezistí jeho existenciu).
    select exists (
      select 1 from public.documents d
      where d.id = p_entity_id and d.company_id = v_company_id and d.deleted_at is null
    ) and public.esblu_can_read_document(p_entity_id)
    into v_entity_ok;
  elsif p_entity_type = 'vehicle_service' then
    select exists (
      select 1 from public.vehicle_services vs where vs.id = p_entity_id and vs.company_id = v_company_id
    ) into v_entity_ok;
  elsif p_entity_type = 'machine_service' then
    select exists (
      select 1 from public.machine_services ms where ms.id = p_entity_id and ms.company_id = v_company_id
    ) into v_entity_ok;
  end if;

  if not v_entity_ok then
    raise exception using errcode = 'P0001', message = 'ESBLU_ENTITY_NOT_FOUND_OR_FORBIDDEN';
  end if;

  insert into public.chat_message_references (message_id, company_id, entity_type, entity_id)
  values (p_message_id, v_company_id, p_entity_type, p_entity_id)
  returning * into v_row;

  return v_row;
end;
$function$;

revoke execute on function public.esblu_attach_chat_message_reference(uuid, text, uuid) from public, anon;
grant execute on function public.esblu_attach_chat_message_reference(uuid, text, uuid) to authenticated;

-- 7b) Prečítanie: prístup cez zdroj pravdy (predtým direct bez kontroly firmy).
create or replace function public.esblu_mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  v_company_id := public.esblu_my_active_company_id();

  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_chat_can_access_conversation(p_conversation_id) then
    raise exception using
      errcode = '42501',
      message = 'ESBLU_CONVERSATION_NOT_FOUND_OR_FORBIDDEN';
  end if;

  -- Read pointer. Pri firemnom kanáli vzniká riadok členstva — ten však už
  -- NIČ neoprávňuje (direct prístup vyžaduje aj direct_user_low/high).
  insert into public.chat_conversation_members (conversation_id, company_id, user_id, last_read_at)
  values (p_conversation_id, v_company_id, v_uid, now())
  on conflict (conversation_id, user_id)
    do update set last_read_at = excluded.last_read_at;
end;
$function$;

revoke all on function public.esblu_mark_conversation_read(uuid) from public, anon;
grant execute on function public.esblu_mark_conversation_read(uuid) to authenticated;

-- 7c) Unread: iba prístupné konverzácie a správy aktívnej firmy.
create or replace function public.esblu_get_my_unread_counts()
returns table(conversation_id uuid, conversation_type text, unread_count bigint)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
begin
  if v_uid is null then
    return;
  end if;

  v_company_id := public.esblu_my_active_company_id();

  if v_company_id is null then
    return;
  end if;

  return query
  with my_conversations as (
    select c.id, c.type
    from public.chat_conversations c
    where c.company_id = v_company_id
      and public.esblu_chat_can_access_conversation(c.id)
  ),
  read_pointers as (
    select m.conversation_id, m.last_read_at
    from public.chat_conversation_members m
    where m.user_id = v_uid
  )
  select
    mc.id,
    mc.type,
    (
      select count(*)
      from public.chat_messages msg
      where msg.conversation_id = mc.id
        and msg.company_id = v_company_id
        and msg.deleted_at is null
        and msg.author_id is distinct from v_uid
        and msg.created_at > coalesce(rp.last_read_at, 'epoch'::timestamptz)
    )
  from my_conversations mc
  left join read_pointers rp on rp.conversation_id = mc.id;
end;
$function$;

revoke all on function public.esblu_get_my_unread_counts() from public, anon;
grant execute on function public.esblu_get_my_unread_counts() to authenticated;

commit;
