-- =============================================================================
-- M1 authz follow-up (2026-09-28) — ÚČTOVNÍK = iba finančné doklady
-- NEAPLIKOVANÉ. Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
-- Samostatná migrácia zámerne: mení to, čo účtovník vidí v Inboxe — schváliť
-- ako produktové rozhodnutie nezávisle od 20260930100000 / 110000.
--
-- AUTORITATÍVNY MODEL: účtovník je finance-scoped. Human Chat áno, AI asistent
-- iba financie/účtovníctvo, žiadne vozidlá/stroje/sklad.
--
-- Pred (overené v prod katalógu 2026-09-28):
--   documents_select_company  (NOT requires_finance) OR finance_view OR vlastný
--     uploaded/processing  → účtovník čítal VŠETKY nefinančné doklady firmy:
--     technické preukazy (vehicle_registration), PZP (insurance), servisné
--     doklady (service_document), vážne lístky (weigh_ticket), „other" —
--     vrátane extracted_fields (ŠPZ, VIN, poistné čísla, údaje držiteľa),
--     súborov v Storage (esblu_can_read_ai_inbox_object) a ich väzieb na
--     vozidlá/stroje (document_links cez esblu_can_read_document).
--   documents_update/delete_finance_manager  role ∈ {owner, admin, accountant}
--     AND (NOT requires_finance OR finance_manage) → účtovník mohol nefinančné
--     prevádzkové doklady aj upravovať a mazať.
--   esblu_can_manage_document → účtovník smel pripájať prílohy/väzby
--     k nefinančným dokladom.
--   (vehicles/machines/inventory/vehicle_services/… sú už iba can_operate —
--   účtovník ich nevidí; ai_evidence: vážne lístky iba can_operate, dodacie
--   listy iba finance_view — bez zmeny.)
--
-- Po: pre rolu 'accountant' platí na documents, prílohách, väzbách a súboroch
-- navyše podmienka rozsahu:
--     esblu_document_requires_finance(type, status)  — faktúra, bloček,
--                                                       dodací list, alebo
--                                                       doklad v príjme
--                                                       (uploaded/processing).
-- ŽIADNA výnimka „vlastný nefinančný upload": po 20260930130000 účtovník
-- nefinančný doklad ani nevytvorí (INSERT typov insurance/vehicle_registration/
-- service_document/other iba owner/admin) a vlastný doklad v príjme
-- (uploaded/processing) je finančný podľa definície → vidí ho aj tak.
-- Potvrdenie nahratia teda nepotrebuje trvalé čítacie právo.
-- Pre owner/admin/employee sa NEMENÍ NIČ (podmienka je `role is distinct from
-- 'accountant' OR …`). Finančné pravidlá (finance_view/manage) ostávajú.
--
-- VÝKON: rola sa v politikách číta cez (select …) → InitPlan, raz na dotaz,
-- nie na riadok. Pomocné funkcie sú SECURITY DEFINER s pevným search_path,
-- nečítajú documents cez RLS → žiadna rekurzia.
--
-- ROLLBACK: pôvodné definície politík sú v 20260921120000 / 20260922100000;
-- pôvodné telá funkcií = tento súbor bez blokov označených „M1 accountant".
-- =============================================================================

begin;

-- documents: SELECT --------------------------------------------------------------
drop policy if exists documents_select_company on public.documents;
create policy documents_select_company
  on public.documents
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and (
      (not public.esblu_document_requires_finance(document_type, status))
      or public.esblu_my_finance_view()
      or (status = any (array['uploaded'::text, 'processing'::text]) and user_id = (select auth.uid()))
    )
    -- M1 accountant
    and (
      (select public.esblu_my_active_role()) is distinct from 'accountant'
      or public.esblu_document_requires_finance(document_type, status)
    )
  );

-- documents: UPDATE --------------------------------------------------------------
drop policy if exists documents_update_finance_manager on public.documents;
create policy documents_update_finance_manager
  on public.documents
  for update
  to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text, 'accountant'::text])
    and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_manage())
    -- M1 accountant
    and (
      (select public.esblu_my_active_role()) is distinct from 'accountant'
      or public.esblu_document_requires_finance(document_type, status)
    )
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text, 'accountant'::text])
    and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_manage())
    -- M1 accountant
    and (
      (select public.esblu_my_active_role()) is distinct from 'accountant'
      or public.esblu_document_requires_finance(document_type, status)
    )
  );

-- documents: DELETE --------------------------------------------------------------
drop policy if exists documents_delete_finance_manager on public.documents;
create policy documents_delete_finance_manager
  on public.documents
  for delete
  to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text, 'accountant'::text])
    and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_manage())
    -- M1 accountant
    and (
      (select public.esblu_my_active_role()) is distinct from 'accountant'
      or public.esblu_document_requires_finance(document_type, status)
    )
  );

-- esblu_can_read_document (document_links / document_attachments / labels) --------
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

-- esblu_can_manage_document --------------------------------------------------------
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

-- esblu_can_read_ai_inbox_object (Storage ai-inbox-documents) ----------------------
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
  v_attachment_document_id uuid;
  v_role text;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  select d.id, d.company_id, d.document_type, d.status, d.user_id
    into v_document_id, v_document_company_id, v_document_type, v_document_status, v_document_user_id
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

    -- M1 accountant: nefinančný doklad nikdy (ani vlastný).
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

    return coalesce(v_document_status, '') in ('uploaded', 'processing') and v_document_user_id = v_uid;
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

-- CREATE OR REPLACE zachová GRANT/REVOKE; pre istotu bez anon.
revoke execute on function public.esblu_can_read_document(uuid) from public, anon;
revoke execute on function public.esblu_can_manage_document(uuid) from public, anon;
revoke execute on function public.esblu_can_read_ai_inbox_object(text) from public, anon;
grant execute on function public.esblu_can_read_document(uuid) to authenticated;
grant execute on function public.esblu_can_manage_document(uuid) to authenticated;
grant execute on function public.esblu_can_read_ai_inbox_object(text) to authenticated;

commit;
