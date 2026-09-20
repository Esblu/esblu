-- =============================================================================
-- 20260921140000_finance_write_integrity_and_quota_lockdown.sql
--
-- Follow-up k 20260921120000. Dva nálezy, oba potvrdené testom pred opravou.
--
-- NÁLEZ 1 — WRITE STRANA FINANČNÝCH DOKUMENTOV NEBOLA GATOVANÁ
-- ------------------------------------------------------------
-- Predchádzajúca migrácia zúžila SELECT na documents/document_links/
-- document_attachments a UPDATE/DELETE na documents. WRITE politiky na
-- document_links a document_attachments však zostali na pôvodnom modeli
-- "owner alebo admin":
--
--   document_links_update_owner_admin       role in (owner, admin)
--   document_links_delete_owner_admin       role in (owner, admin)
--   document_attachments_update_owner_admin role in (owner, admin)
--   document_attachments_delete_owner_admin role in (owner, admin)
--   esblu_can_delete_ai_inbox_object()      role in (owner, admin)
--
-- Admin bez finance teda faktúru nevidel, ale vedel jej odpojiť zdrojový
-- dokument, zmazať prílohu a odstrániť súbor zo storage. Čítanie bolo
-- chránené, integrita účtovného podkladu nie.
--
-- PRAVIDLO, KTORÉ SA ZAVÁDZA:
--   finančný dokument  READ   owner / finance.view / finance.manage
--                      WRITE  owner / finance.manage
--   rola admin sama osebe NIE JE oprávnenie na finančný dokument
--   nefinančný dokument  presne dnešné správanie, bez zmeny
--
-- NÁLEZ 2 — CALLER SI URČOVAL VLASTNÝ ABUSE CEILING
-- -------------------------------------------------
-- esblu_consume_ai_scan_quota(p_endpoint text, p_max_per_hour integer
-- DEFAULT 60, p_max_per_day integer DEFAULT 240) bola grantnutá roli
-- authenticated. Limity boli ARGUMENTY, takže prihlásený používateľ mohol
-- cez PostgREST zavolať RPC priamo s 999999 a strop neplatil.
--
-- Overené pred opravou: 61. volanie s defaultmi skončilo na
-- ESBLU_AI_SCAN_RATE_LIMIT, to isté volanie s p_max_per_hour = 999999
-- prešlo (used_last_hour = 61).
--
-- Praktický dopad bol užší, než sa môže zdať — /api/scan-document posiela
-- iba p_endpoint, takže aplikačná cesta strop dodržiavala a k OpenAI sa
-- útočník takto nedostal. Zostávali ale dve reálne veci: (a) bezpečnostný
-- strop v argumente NIE JE autoritatívny a ktorýkoľvek budúci volajúci ho
-- mohol ticho oslabiť, (b) priame volanie RPC dovoľovalo neobmedzene
-- vkladať riadky do ai_scan_usage. Bezpečnostná hodnota nesmie byť
-- parameter volajúceho, bodka.
--
-- ČO SA NEMENÍ (overené auditom)
-- ------------------------------
--   • esblu_finalize_vehicle_document() — tvrdo obmedzená na document_type
--     in ('insurance','vehicle_registration'), teda výhradne nefinančné
--     typy. Finančný dokument cez ňu prejsť nemôže; netreba ju meniť.
--   • esblu_create_received_invoice_draft() — SECURITY DEFINER, vlastnú
--     finance.manage kontrolu už má.
--   • INSERT na documents, SELECT politiky z 20260921120000, invoices RLS,
--     finalize, payment model, ai_evidence.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. finance.manage voči konkrétnej firme
-- ---------------------------------------------------------------------------
-- Náprotivok esblu_has_finance_view_in_company() z 20260921120000. Potrebný
-- rovnako: storage helper pracuje s firmou DOKUMENTU, nie s aktívnou firmou
-- volajúceho, a pri členstve vo viacerých firmách to nie je tá istá otázka.
create or replace function public.esblu_has_finance_manage_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    (
      select
        cm.role = 'owner'
        or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$function$;

comment on function public.esblu_has_finance_manage_in_company(uuid) is
  'finance.manage voči KONKRÉTNEJ firme (nie aktívnej). Owner vždy, inak explicitné permissions.finance.manage. company_id volajúci iba pomenúva — identitu určuje auth.uid().';

revoke execute on function public.esblu_has_finance_manage_in_company(uuid) from public;
revoke execute on function public.esblu_has_finance_manage_in_company(uuid) from anon;
grant execute on function public.esblu_has_finance_manage_in_company(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. "Smiem MENIŤ väzby tohto dokumentu?"
-- ---------------------------------------------------------------------------
-- Zápisový náprotivok esblu_can_read_document(). Pri nefinančnom dokumente
-- odpovedá presne ako doteraz (stačí členstvo — rolu owner/admin naďalej
-- vyžaduje samotná politika), pri finančnom vyžaduje finance.manage.
--
-- Uploader výnimka tu ZÁMERNE NIE JE. Pri čítaní dáva zmysel, aby človek
-- videl vlastný rozpracovaný upload; pri mazaní väzieb účtovného podkladu
-- nie.
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
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;

  select d.company_id, d.document_type, d.status
    into v_company_id, v_type, v_status
  from public.documents d
  where d.id = p_document_id;

  if v_company_id is null then
    return false;
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.company_id = v_company_id
  ) then
    return false;
  end if;

  if not public.esblu_document_requires_finance(v_type, v_status) then
    return true;
  end if;

  return public.esblu_has_finance_manage_in_company(v_company_id);
end;
$function$;

comment on function public.esblu_can_manage_document(uuid) is
  'Zápisová kontrola nad väzbami dokumentu: aktívne členstvo vo firme dokumentu a pri finančne citlivom doklade navyše finance.manage. Bez uploader výnimky — vidieť vlastný upload je jedna vec, mazať väzby účtovného podkladu druhá.';

revoke execute on function public.esblu_can_manage_document(uuid) from public;
revoke execute on function public.esblu_can_manage_document(uuid) from anon;
grant execute on function public.esblu_can_manage_document(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. document_links — INSERT / UPDATE / DELETE
-- ---------------------------------------------------------------------------
-- Pôvodné predikáty sú zachované doslova; pribúda výhradne
-- esblu_can_manage_document(document_id). Nefinančné väzby (vozidlo, stroj,
-- sklad, servisy) sa preto správajú presne ako pred touto migráciou.
drop policy if exists document_links_insert_company on public.document_links;

create policy document_links_insert_company
  on public.document_links
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_can_manage_document(document_id)
    and exists (
      select 1 from public.documents d
      where d.id = document_links.document_id
        and d.company_id = public.esblu_my_active_company_id()
        and d.deleted_at is null
    )
    and (
      (vehicle_id is not null and exists (
        select 1 from public.vehicles v
        where v.id = document_links.vehicle_id and v.company_id = public.esblu_my_active_company_id()))
      or (machine_id is not null and exists (
        select 1 from public.machines m
        where m.id = document_links.machine_id and m.company_id = public.esblu_my_active_company_id()))
      or (inventory_item_id is not null and exists (
        select 1 from public.inventory_items i
        where i.id = document_links.inventory_item_id and i.company_id = public.esblu_my_active_company_id()))
      or (vehicle_service_id is not null and exists (
        select 1 from public.vehicle_services vs
        where vs.id = document_links.vehicle_service_id and vs.company_id = public.esblu_my_active_company_id()))
      or (machine_service_id is not null and exists (
        select 1 from public.machine_services ms
        where ms.id = document_links.machine_service_id and ms.company_id = public.esblu_my_active_company_id()))
    )
  );

drop policy if exists document_links_update_owner_admin on public.document_links;

create policy document_links_update_owner_admin
  on public.document_links
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and public.esblu_can_manage_document(document_id)
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and public.esblu_can_manage_document(document_id)
    and exists (
      select 1 from public.documents d
      where d.id = document_links.document_id
        and d.company_id = public.esblu_my_active_company_id()
        and d.deleted_at is null
    )
    and (
      (vehicle_id is not null and exists (
        select 1 from public.vehicles v
        where v.id = document_links.vehicle_id and v.company_id = public.esblu_my_active_company_id()))
      or (machine_id is not null and exists (
        select 1 from public.machines m
        where m.id = document_links.machine_id and m.company_id = public.esblu_my_active_company_id()))
      or (inventory_item_id is not null and exists (
        select 1 from public.inventory_items i
        where i.id = document_links.inventory_item_id and i.company_id = public.esblu_my_active_company_id()))
      or (vehicle_service_id is not null and exists (
        select 1 from public.vehicle_services vs
        where vs.id = document_links.vehicle_service_id and vs.company_id = public.esblu_my_active_company_id()))
      or (machine_service_id is not null and exists (
        select 1 from public.machine_services ms
        where ms.id = document_links.machine_service_id and ms.company_id = public.esblu_my_active_company_id()))
    )
  );

drop policy if exists document_links_delete_owner_admin on public.document_links;

create policy document_links_delete_owner_admin
  on public.document_links
  for delete
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and public.esblu_can_manage_document(document_id)
  );


-- ---------------------------------------------------------------------------
-- 4. document_attachments — INSERT / UPDATE / DELETE
-- ---------------------------------------------------------------------------
drop policy if exists document_attachments_insert_company on public.document_attachments;

create policy document_attachments_insert_company
  on public.document_attachments
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_can_manage_document(document_id)
    and exists (
      select 1 from public.documents d
      where d.id = document_attachments.document_id
        and d.company_id = public.esblu_my_active_company_id()
        and d.deleted_at is null
    )
  );

drop policy if exists document_attachments_update_owner_admin on public.document_attachments;

create policy document_attachments_update_owner_admin
  on public.document_attachments
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and public.esblu_can_manage_document(document_id)
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and public.esblu_can_manage_document(document_id)
    and exists (
      select 1 from public.documents d
      where d.id = document_attachments.document_id
        and d.company_id = public.esblu_my_active_company_id()
    )
  );

drop policy if exists document_attachments_delete_owner_admin on public.document_attachments;

create policy document_attachments_delete_owner_admin
  on public.document_attachments
  for delete
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and public.esblu_can_manage_document(document_id)
  );


-- ---------------------------------------------------------------------------
-- 5. Storage DELETE — ai-inbox-documents
-- ---------------------------------------------------------------------------
-- Zmazať súbor faktúry je to isté ako zmazať účtovný podklad. Bez tejto
-- zmeny by admin bez finance riadok v document_attachments odstrániť nevedel,
-- ale samotný objekt v storage áno.
--
-- Zachované: väzba cez documents aj document_attachments a pravidlo, že
-- nereferencovaný objekt patrí výhradne nahrávateľovi.
create or replace function public.esblu_can_delete_ai_inbox_object(p_object_name text)
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

    -- O finančnej citlivosti prílohy rozhoduje RODIČOVSKÝ dokument.
    return public.esblu_can_manage_document(v_attachment_document_id);
  end if;

  return v_uploader_uid = v_uid::text;
end;
$function$;

comment on function public.esblu_can_delete_ai_inbox_object(text) is
  'Storage DELETE gate pre bucket ai-inbox-documents: owner/admin vo firme dokumentu a pri finančne citlivom doklade navyše finance.manage. Bez toho by admin bez finance nevedel zmazať riadok prílohy, ale samotný súbor faktúry áno.';

revoke execute on function public.esblu_can_delete_ai_inbox_object(text) from public;
revoke execute on function public.esblu_can_delete_ai_inbox_object(text) from anon;
grant execute on function public.esblu_can_delete_ai_inbox_object(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. AI scan quota — strop preč z argumentov volajúceho
-- ---------------------------------------------------------------------------
-- Privátna konfigurácia. RLS zapnuté a ZÁMERNE bez jedinej politiky, takže
-- klient (anon aj authenticated) sem nemá prístup ani na čítanie. Hodnoty
-- mení výhradne migrácia alebo service_role.
create table if not exists public.ai_scan_limits (
  endpoint text primary key,
  max_per_hour integer not null check (max_per_hour > 0),
  max_per_day integer not null check (max_per_day > 0),
  updated_at timestamptz not null default now()
);

comment on table public.ai_scan_limits is
  'Privátna konfigurácia technických stropov pre AI scan endpointy. RLS zapnuté bez politík — authenticated klient hodnoty nevie prečítať ani zmeniť. NIE JE to cenník ani produktový plán, iba abuse ceiling.';

alter table public.ai_scan_limits enable row level security;

insert into public.ai_scan_limits (endpoint, max_per_hour, max_per_day)
values ('scan-document', 60, 240)
on conflict (endpoint) do nothing;

-- KRITICKÉ: starú trojargumentovú verziu treba DROPNÚŤ, nie iba nahradiť.
-- CREATE OR REPLACE s inou signatúrou by vytvoril druhý overload a pôvodná,
-- zraniteľná funkcia by zostala volateľná.
drop function if exists public.esblu_consume_ai_scan_quota(text, integer, integer);

create or replace function public.esblu_consume_ai_scan_quota(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NOT_AUTHENTICATED';
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

  -- Endpoint je allowlist, nie voľný text: volajúci nesmie vyrobiť vlastnú
  -- "vedierko" hodnotu, ktorá by mala vlastné, prázdne počítadlo.
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

  -- Konkrétne hodnoty stropu sa ZÁMERNE nevracajú — klientovi stačí vedieť,
  -- koľko spotreboval, nie kde presne je hranica.
  return jsonb_build_object(
    'company_id', v_company_id,
    'used_last_hour', v_hour_count + 1,
    'used_last_day', v_day_count + 1
  );
end;
$function$;

comment on function public.esblu_consume_ai_scan_quota(text) is
  'Abuse guard pre AI scan endpointy. Limity sa čítajú z privátnej public.ai_scan_limits — volajúci ich NEVIE ovplyvniť (predchádzajúca verzia ich brala ako argumenty a dala sa obísť hodnotou 999999). Vyžaduje auth.uid() a aktívne členstvo, company_id odvodzuje z auth.uid(), počíta atomicky cez pg_advisory_xact_lock. Endpoint musí byť v allowliste. Fail-closed.';

revoke execute on function public.esblu_consume_ai_scan_quota(text) from public;
revoke execute on function public.esblu_consume_ai_scan_quota(text) from anon;
grant execute on function public.esblu_consume_ai_scan_quota(text) to authenticated;

commit;
