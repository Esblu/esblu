-- =============================================================================
-- M1 authz (2026-09-28) — originál príjmu v Storage je nemenný + obnoviteľný
-- review (čítanie VLASTNÉHO rozpracovaného originálu).
-- NEAPLIKOVANÉ. Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
-- ZÁVISLOSŤ: po 20260930120000 (rozsah účtovníka v esblu_can_read_ai_inbox_object
-- — táto migrácia ho preberá doslovne) a 20260930125000 (review stavy).
--
-- PRED (prod katalóg 2026-09-28):
--   ai_inbox_documents_update_own  UPDATE  (foldername[1] = auth.uid())
--     → uploader mohol KEDYKOĽVEK prepísať (upsert/update/move) svoj súbor,
--       aj po potvrdení dokladu: údaje v DB by ostali z fotografie A, owner
--       či účtovník by neskôr otvoril fotografiu B.
--   ai_inbox_documents_insert_own / „AI documents - upload own files"
--     → INSERT do vlastného priečinka bez ohľadu na to, či na cestu už
--       odkazuje záznam (po zmazaní objektu by sa dala nahrať iná fotka
--       pod tú istú cestu existujúceho dokladu).
--   ai-evidence-documents: UPDATE politika neexistuje (prepis nemožný).
--
-- PO:
--   0) DELETE iba nenaviazaného objektu (sekcia 3b) — originál potvrdeného,
--      rozpracovaného aj legacy záznamu sa samostatným Storage DELETE nezmaže,
--   1) žiadny UPDATE v ai-inbox-documents (appka ho nepoužíva — všetky
--      uploady sú upsert: false na novú, jedinečnú cestu
--      `<uid>/<document_id>/<timestamp>-<uuid>.webp`),
--   2) INSERT iba na cestu, na ktorú ešte neodkazuje žiadny záznam
--      (documents / document_attachments / ai_evidence),
--   3) čítanie originálu: doterajšie pravidlá + uploader smie čítať SVOJ
--      originál počas rozpracovaného review (needs_review / extracted,
--      ≤ 24 h, aktívna firma) — kvôli obnoveniu review po páde appky.
--      Po potvrdení platí opäť iba finančné čítanie (owner/účtovník/admin
--      s financiami), zamestnanec finančný originál neotvorí.
--   Upravený obrázok nikdy nenahrádza originál (appka iné cesty nevytvára;
--   originál sa nedá prepísať).
--
-- ROLLBACK:
--   create policy ai_inbox_documents_update_own on storage.objects for update to authenticated
--     using (bucket_id = 'ai-inbox-documents' and (storage.foldername(name))[1] = (auth.uid())::text)
--     with check (bucket_id = 'ai-inbox-documents' and (storage.foldername(name))[1] = (auth.uid())::text);
--   pôvodné INSERT a DELETE politiky bez esblu_storage_object_is_referenced;
--   esblu_can_read_ai_inbox_object z 20260930120000, esblu_can_read_ai_evidence_object z prod.
-- =============================================================================

begin;

-- 1) Je na objekt už naviazaný záznam? (interný helper pre INSERT politiky)
create or replace function public.esblu_storage_object_is_referenced(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select case p_bucket
    when 'ai-inbox-documents' then
      exists (select 1 from public.documents d where d.storage_bucket = p_bucket and d.storage_path = p_name)
      or exists (select 1 from public.document_attachments a where a.storage_bucket = p_bucket and a.storage_path = p_name)
    when 'ai-evidence-documents' then
      exists (select 1 from public.ai_evidence e where e.photo_url = p_name)
    else false
  end;
$function$;
revoke all on function public.esblu_storage_object_is_referenced(text, text) from public, anon;
grant execute on function public.esblu_storage_object_is_referenced(text, text) to authenticated;

-- 2) Žiadny prepis originálu v ai-inbox-documents.
drop policy if exists ai_inbox_documents_update_own on storage.objects;

-- 3) INSERT iba na ešte nenaviazanú cestu vo vlastnom priečinku.
drop policy if exists ai_inbox_documents_insert_own on storage.objects;
create policy ai_inbox_documents_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'ai-inbox-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not public.esblu_storage_object_is_referenced(bucket_id, name)
  );

drop policy if exists "AI documents - upload own files" on storage.objects;
create policy "AI documents - upload own files"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'ai-evidence-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not public.esblu_storage_object_is_referenced(bucket_id, name)
  );

-- 3b) DELETE iba objektu, na ktorý NEODKAZUJE žiadny záznam.
--     Pred: ai_inbox_documents_delete_company / ai_evidence_documents_delete_company
--       → owner/admin (dodací list / finančný doklad s finance.manage) zmazal
--         samostatným Storage DELETE originál potvrdeného (aj legacy)
--         záznamu; DB riadok ostal bez dôkazového podkladu.
--     Po: navyše „nie je naviazaný". Zmazať súbor záznamu jde iba cez
--       existujúci retenčný workflow (lib/document-retention.ts, mazanie
--       evidencie, mazanie prílohy): NAJPRV DB riadok (finančné doklady sa
--       vôbec nemažú — iba archív deleted_at, trigger esblu_retain_*), potom
--       osirelý súbor. Rozpracovaný príjem (riadok existuje) sa tiež nemaže
--       po kúskoch; upratanie neúspešného uploadu (bez riadku) ostáva
--       uploaderovi.
drop policy if exists ai_inbox_documents_delete_company on storage.objects;
create policy ai_inbox_documents_delete_company
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'ai-inbox-documents'
    and public.esblu_can_delete_ai_inbox_object(name)
    and not public.esblu_storage_object_is_referenced(bucket_id, name)
  );

drop policy if exists ai_evidence_documents_delete_company on storage.objects;
create policy ai_evidence_documents_delete_company
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'ai-evidence-documents'
    and public.esblu_can_delete_ai_evidence_object(name)
    and not public.esblu_storage_object_is_referenced(bucket_id, name)
  );

-- 4) Čítanie originálu dokladu (ai-inbox-documents).
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

-- 5) Čítanie originálu evidencie (ai-evidence-documents) — prod logika + review.
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

revoke execute on function public.esblu_can_read_ai_inbox_object(text) from public, anon;
revoke execute on function public.esblu_can_read_ai_evidence_object(text) from public, anon;
grant execute on function public.esblu_can_read_ai_inbox_object(text) to authenticated;
grant execute on function public.esblu_can_read_ai_evidence_object(text) to authenticated;

commit;
