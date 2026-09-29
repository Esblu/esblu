-- =============================================================================
-- M1 pre-commit authorization audit (2026-09-28) — NEAPLIKOVANÉ.
-- Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (projekt assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
--
-- 1) document_review_log — ÚNIK FINANČNÝCH METADÁT
--    Doterajšia SELECT politika: company_id = esblu_my_active_company_id().
--    Každý aktívny člen firmy (aj zamestnanec, aj admin bez financií) si teda
--    mohol priamo cez PostgREST (vlastný JWT, žiadny service_role) prečítať
--    audit log KAŽDÉHO dokladu vrátane faktúr, bločkov a dodacích listov:
--    field_name, old_value, new_value a document_snapshot (dodávateľ, sumy,
--    čísla dokladov) — hoci samotný riadok v `documents` mu RLS skryje.
--    Appka tabuľku iba zapisuje (ai-evidencia, vozidla), nikde ju nečíta,
--    takže sprísnenie nemení žiadne UI správanie.
--    Nové pravidlo: log k existujúcemu dokladu vidí IBA ten, kto smie čítať
--    samotný doklad (esblu_can_read_document — rovnaká logika ako documents
--    SELECT, vrátane rozsahu účtovníka po 20260930120000). Log k už
--    neexistujúcemu dokladu (document_id po ON DELETE SET NULL prázdne)
--    vidí iba finance.view (typ dokladu sa už nedá overiť → finančná opatrnosť).
--    ZÁPIS sa sprísňuje tiež (sekcia 1b nižšie): klient smie vložiť iba
--    'created' k vlastnému práve nahranému dokladu, nič iné; UPDATE/DELETE/
--    TRUNCATE oprávnenia sa odoberajú.
--
-- 2) esblu_attach_chat_message_reference — orákulum existencie dokladu
--    SECURITY DEFINER funkcia pre typ 'document' overovala iba
--    company_id + deleted_at, nie právo čítať doklad. Zamestnanec tak vedel
--    (a) zistiť, či UUID je finančný doklad firmy (ENTITY_NOT_FOUND vs. OK),
--    (b) pripnúť do chatu kartu finančného dokladu. Obsah karty sa síce
--    načítava cez RLS (ostane „nedostupné"), ale referencia nesmie vzniknúť
--    na doklad, ktorý autor sám nesmie vidieť. Zmena: pre 'document' sa
--    navyše vyžaduje esblu_can_read_document(p_entity_id); pre prevádzkové
--    entity (vehicle, machine, inventory_item, vehicle_service,
--    machine_service) esblu_role_can_operate() — rovnaké pravidlo ako ich
--    SELECT RLS (účtovník ich nevidí, teda ani nepripne ani nezistí ich
--    existenciu). Chyba je vždy tá istá ESBLU_ENTITY_NOT_FOUND_OR_FORBIDDEN.
--    Signatúra a oprávnenia sú bez zmeny.
--
-- ROLLBACK (ručne, ak by bolo treba):
--   drop policy if exists document_review_log_select_readable on public.document_review_log;
--   create policy document_review_log_select_company on public.document_review_log
--     for select to authenticated using (company_id = public.esblu_my_active_company_id());
--   drop policy if exists document_review_log_insert_own_created on public.document_review_log;
--   create policy document_review_log_insert_company on public.document_review_log
--     for insert to authenticated with check (
--       company_id = public.esblu_my_active_company_id() and document_id is not null
--       and document_ref = document_id
--       and exists (select 1 from public.documents d
--                   where d.id = document_review_log.document_id
--                     and d.company_id = public.esblu_my_active_company_id()));
--   grant update, delete, truncate on table public.document_review_log to authenticated;
--   drop function if exists public.esblu_can_log_document_created(uuid);
--   + pôvodné telo esblu_attach_chat_message_reference z 20260827100000_add_chat_core.sql
--     (vetva 'document' bez esblu_can_read_document).
-- =============================================================================

begin;

-- 1) document_review_log --------------------------------------------------------
-- 1a) ČÍTANIE
drop policy if exists document_review_log_select_company on public.document_review_log;
drop policy if exists document_review_log_select_readable on public.document_review_log;

create policy document_review_log_select_readable
  on public.document_review_log
  for select
  to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and (
      (document_id is not null and public.esblu_can_read_document(document_id))
      or (document_id is null and public.esblu_my_finance_view())
    )
  );

-- 1b) ZÁPIS — integrita auditu (M1 authz follow-up)
--
-- Pred: document_review_log_insert_company kontrolovala iba firmu, že
-- document_id = document_ref a že doklad vo firme existuje. user_id, action,
-- field_name, old_value, new_value, document_snapshot aj created_at boli
-- úplne v rukách volajúceho. Ktorýkoľvek člen firmy (zamestnanec, admin bez
-- financií) teda mohol k ĽUBOVOĽNÉMU dokladu firmy — aj k faktúre, ktorú
-- nesmie ani vidieť — vložiť podvrhnutú históriu: „confirmed"/"field_edited"
-- s vymyslenými hodnotami, pod cudzím user_id a so spätným dátumom.
-- UPDATE/DELETE politiky neexistujú (RLS ich zakazuje), no tabuľkové
-- oprávnenia UPDATE/DELETE pre authenticated boli udelené.
--
-- Kto do logu legitímne zapisuje (overené v kóde aj v DB):
--   - klient, akcia 'created', HNEĎ po vložení vlastného dokladu
--     (app/ai-evidencia/page.tsx ×2, app/vozidla/page.tsx) — bez polí,
--   - esblu_finalize_vehicle_document (SECURITY DEFINER) — akcia 'linked',
--   - esblu_owner_delete_company (SECURITY DEFINER) — mazanie pri zrušení firmy.
-- Príjem dokladu zamestnancom (/api/inbox/intake) do logu nepíše.
--
-- Po: klient smie vložiť JEDINÝ typ záznamu — 'created' k dokladu, ktorý
-- sám nahral pred chvíľou (≤ 15 min), vo svojej aktívnej firme, pod svojím
-- user_id, s aktuálnym časom, bez akýchkoľvek hodnôt/snímok a iba raz na
-- doklad. Všetko ostatné (confirmed, field_edited, linked, …) ide výhradne
-- cez SECURITY DEFINER funkcie, ktoré si oprávnenie overujú samy.
-- Nevyžaduje sa čítacie právo na doklad (zamestnancov vlastný bloček po
-- spracovaní už čítať nesmie) — rozhoduje vlastníctvo a čerstvosť.
create or replace function public.esblu_can_log_document_created(p_document_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_user_id uuid;
  v_created_at timestamptz;
  v_deleted_at timestamptz;
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;

  select d.company_id, d.user_id, d.created_at, d.deleted_at
    into v_company_id, v_user_id, v_created_at, v_deleted_at
  from public.documents d
  where d.id = p_document_id;

  if v_company_id is null
     or v_company_id is distinct from public.esblu_my_active_company_id()
     or v_user_id is distinct from v_uid
     or v_deleted_at is not null
     or v_created_at < now() - interval '15 minutes' then
    return false;
  end if;

  return not exists (
    select 1 from public.document_review_log l
    where l.document_ref = p_document_id and l.action = 'created'
  );
end;
$function$;

revoke all on function public.esblu_can_log_document_created(uuid) from public, anon;
grant execute on function public.esblu_can_log_document_created(uuid) to authenticated;

drop policy if exists document_review_log_insert_company on public.document_review_log;
drop policy if exists document_review_log_insert_own_created on public.document_review_log;

create policy document_review_log_insert_own_created
  on public.document_review_log
  for insert
  to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and user_id = (select auth.uid())
    and action = 'created'
    and field_name is null
    and old_value is null
    and new_value is null
    and document_snapshot is null
    and document_id is not null
    and document_ref = document_id
    and created_at >= now() - interval '1 minute'
    and created_at <= now() + interval '1 minute'
    and public.esblu_can_log_document_created(document_id)
  );

-- Audit sa klientom nikdy nemení ani nemaže (RLS to už zakazuje — toto je
-- obrana do hĺbky pre prípad budúcej omylom pridanej politiky).
revoke update, delete, truncate on table public.document_review_log from anon, authenticated;

-- 2) esblu_attach_chat_message_reference ---------------------------------------
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

  select m.company_id, m.author_id, m.deleted_at
    into v_message_company_id, v_message_author_id, v_message_deleted_at
  from public.chat_messages m
  where m.id = p_message_id;

  if v_message_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MESSAGE_NOT_FOUND';
  end if;

  if v_message_company_id <> v_company_id or v_message_author_id <> v_uid then
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

-- CREATE OR REPLACE zachová existujúce GRANT/REVOKE; pre istotu zopakované
-- rovnako ako 20260923200000_revoke_anon_execute_on_definer_functions.sql.
revoke execute on function public.esblu_attach_chat_message_reference(uuid, text, uuid) from public, anon;
grant execute on function public.esblu_attach_chat_message_reference(uuid, text, uuid) to authenticated;

commit;
