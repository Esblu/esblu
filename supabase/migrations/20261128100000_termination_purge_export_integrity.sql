-- =============================================================================
-- P1-5 bezpečnostné opravy po kontrole 2a8aea3 (2026-11-23). PRIPRAVENÉ — NEAPLIKOVANÉ.
-- Nadväzuje na 20261127100000 (tiež neaplikovaná). Funguje s 20261121100000 aj bez nej.
--
-- F1 Definitívny výmaz súborov:
--    - cleanup job ukončenia nesie termination_id; ciele v einvoice-documents sú povolené IBA pre takýto job
--      a IBA pod prefixom „<company_id>/“ (izolácia tenantov), billing-documents nikdy — inak chyba (nie tiché
--      preskočenie),
--    - výmaz zahŕňa aj osirelé objekty pod prefixom firmy (storage.objects),
--    - storage_purged_at zapíše IBA esblu_cleanup_job_confirm_storage po overení, že žiadny cieľ ani objekt pod
--      prefixom už v storage.objects neexistuje; inak job ostane pending so zvyškom cieľov (obnoviteľné),
--    - job ukončenia nemožno ručne označiť za hotový ani rozšíriť o nové ciele.
-- F2 Úplnosť exportu: odtlačok dát pokrýva VŠETKY exportované tabuľky; súbory sú viazané na beh
--    (company_export_run_files: identita, umiestnenie, snímka objektu v Storage, SHA-256); brána porovná aj
--    odtlačok Storage → zmena súboru alebo zoznamu po exporte = ESBLU_TERMINATION_EXPORT_STALE.
-- F3 Deregistrácia: odvolanie mandátu deregistračným jobom ukončenia (deregistration / COMPANY_TERMINATION) je
--    očakávaná zmena a odtlačok nemení; akékoľvek iné odvolanie alebo zmena mandátu odtlačok zmení.
--    Technické stĺpce prenosu e-faktúr (lease, retry, updated_at) sa do odtlačku nezapočítavajú.
-- F4 Originály: SHA-256 stiahnutého XML/UBL sa v DB porovná s nemennou hodnotou (xml_sha256 / ubl_sha256);
--    nesúlad = beh failed (FILES_CORRUPT) → ukončenie zablokované.
-- F5 R3: pred výmazom dokladu RECIPIENT_MISMATCH minimálny incidentový záznam (hash ID u poskytovateľa, hash
--    obsahu, veľkosť, čas) bez obsahu, cesty a strán dokladu; prístup iba service_role na čítanie.
-- Rollback: supabase/rollback/20261128100000_termination_purge_export_integrity_rollback.sql
-- =============================================================================
begin;

-- ----------------------------------------------------------------------------- 0. stĺpce
alter table public.account_deletion_cleanup_jobs add column if not exists termination_id uuid null;
alter table public.account_deletion_cleanup_jobs add column if not exists storage_verified_at timestamptz null;
alter table public.company_terminations add column if not exists storage_targets_sha256 text null;
alter table public.company_terminations add column if not exists storage_verified_count integer null;
alter table public.company_export_runs add column if not exists storage_fingerprint text null;
alter table public.company_export_runs add column if not exists files_bound boolean not null default false;

alter table public.company_terminations drop constraint if exists company_terminations_storage_proof_check;
alter table public.company_terminations add constraint company_terminations_storage_proof_check check (
  (storage_targets_sha256 is null or storage_targets_sha256 ~ '^[0-9a-f]{64}$')
  and (storage_verified_count is null or storage_verified_count >= 0)
) not valid;
alter table public.company_terminations validate constraint company_terminations_storage_proof_check;
alter table public.company_export_runs drop constraint if exists company_export_runs_storage_fp_check;
alter table public.company_export_runs add constraint company_export_runs_storage_fp_check check (
  storage_fingerprint is null or storage_fingerprint ~ '^[0-9a-f]{64}$'
) not valid;
alter table public.company_export_runs validate constraint company_export_runs_storage_fp_check;
create index if not exists account_deletion_cleanup_jobs_termination_idx
  on public.account_deletion_cleanup_jobs (termination_id) where termination_id is not null;

-- ----------------------------------------------------------------------------- 1. súbory viazané na beh exportu
create table if not exists public.company_export_run_files (
  run_id uuid not null references public.company_export_runs (id) on delete cascade,
  idx integer not null,
  part_index integer not null,
  bucket text not null,
  path text not null,
  storage_object_id uuid null,
  storage_updated_at timestamptz null,
  storage_etag text null,
  expected_sha256 text null,
  sha256 text null,
  size_bytes bigint null,
  primary key (run_id, idx),
  constraint company_export_run_files_key unique (run_id, bucket, path),
  constraint company_export_run_files_sha_check check (
    (expected_sha256 is null or expected_sha256 ~ '^[0-9a-f]{64}$') and (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
    and idx >= 0 and part_index >= 0 and (size_bytes is null or size_bytes >= 0)
  )
);
comment on table public.company_export_run_files is
  'Súbory exportného behu (identita, umiestnenie, snímka objektu v Storage, SHA-256). Bez obsahu. Iba service_role RPC.';
alter table public.company_export_run_files enable row level security;
revoke all on table public.company_export_run_files from public, anon, authenticated;
grant select on table public.company_export_run_files to service_role;

-- ----------------------------------------------------------------------------- 2. zoznam súborov firmy (DB pravda)
-- Rovnaké zdroje ako COMPANY_EXPORT_FILE_SOURCES (lib/company-export.ts; test kontroluje zhodu). Bez R3.
create or replace function public.esblu_company_export_file_list(p_company_id uuid)
returns table (bucket text, path text, expected_sha256 text)
language sql
stable
security definer
set search_path = ''
as $function$
  select s.bucket, s.path, max(s.sha)
  from (
    select d.storage_bucket::text, d.storage_path::text, null::text from public.documents d where d.company_id = p_company_id
    union all select a.storage_bucket::text, a.storage_path::text, null from public.document_attachments a where a.company_id = p_company_id
    union all select c.storage_bucket::text, c.storage_path::text, null from public.chat_attachments c where c.company_id = p_company_id
    union all select 'ai-evidence-documents', e.photo_url::text, null from public.ai_evidence e where e.company_id = p_company_id
    union all select 'machine-photos', m.file_path::text, null from public.machine_photos m where m.company_id = p_company_id
    union all select 'inventory-photos', i.file_path::text, null from public.inventory_photos i where i.company_id = p_company_id
    union all select 'vehicle-photos', v.storage_path::text, null from public.vehicle_photos v where v.company_id = p_company_id
    union all select 'company-logos', b.logo_path::text, null from public.company_billing_profile b where b.company_id = p_company_id
    union all select 'einvoice-documents', n.xml_storage_path, n.xml_sha256 from public.einvoice_inbound n
      where n.company_id = p_company_id and coalesce(n.last_error_code, '') <> 'RECIPIENT_MISMATCH'
    union all select 'einvoice-documents', n.pdf_storage_path, null from public.einvoice_inbound n
      where n.company_id = p_company_id and coalesce(n.last_error_code, '') <> 'RECIPIENT_MISMATCH'
    union all select 'einvoice-documents', o.ubl_storage_path, o.ubl_sha256 from public.einvoice_outbound o where o.company_id = p_company_id
  ) s (bucket, path, sha)
  where coalesce(s.bucket, '') <> '' and coalesce(s.path, '') <> ''
  group by s.bucket, s.path;
$function$;
revoke all on function public.esblu_company_export_file_list(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_export_file_list(uuid) to service_role;

-- Odtlačok stavu Storage pre zoznam súborov firmy: cesta + identita objektu (id, updated_at, eTag, veľkosť).
-- Výmena súboru na rovnakej ceste (aj pri rovnakom počte) ho zmení.
create or replace function public.esblu_company_export_storage_fingerprint(p_company_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select encode(sha256(convert_to(coalesce(string_agg(
           f.bucket || chr(31) || f.path || chr(31) || coalesce(o.id::text, '-') || chr(31) || coalesce(o.updated_at::text, '-')
           || chr(31) || coalesce(o.metadata->>'eTag', '') || chr(31) || coalesce(o.metadata->>'size', ''),
           chr(30) order by f.bucket, f.path), ''), 'UTF8')), 'hex')
  from public.esblu_company_export_file_list(p_company_id) f
  left join storage.objects o on o.bucket_id = f.bucket and o.name = f.path;
$function$;
revoke all on function public.esblu_company_export_storage_fingerprint(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_export_storage_fingerprint(uuid) to service_role;

-- ----------------------------------------------------------------------------- 3. odtlačok dát — všetky tabuľky exportu
create or replace function public.esblu_company_export_fingerprint(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  r record;
  v_n bigint;
  v_h text;
  v_parts text := '';
  v_counts jsonb := '{}'::jsonb;
  v_where text;
  v_expr text;
begin
  if p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  -- Rovnaký zoznam ako COMPANY_EXPORT_TABLES (lib/company-export.ts; test kontroluje zhodu).
  for r in
    select * from (values
      (1, 'companies', 'self'),
      (2, 'company_billing_profile', 'company'),
      (3, 'company_legal_identities', 'company'),
      (4, 'company_members', 'company'),
      (5, 'company_member_permissions', 'company'),
      (6, 'company_dpa_acceptances', 'company'),
      (7, 'custom_document_categories', 'company'),
      (8, 'business_partners', 'company'),
      (9, 'vehicles', 'company'),
      (10, 'vehicle_services', 'company'),
      (11, 'vehicle_vignettes', 'company'),
      (12, 'vehicle_photos', 'company'),
      (13, 'machines', 'company'),
      (14, 'machine_services', 'company'),
      (15, 'machine_photos', 'company'),
      (16, 'inventory_items', 'company'),
      (17, 'inventory_photos', 'company'),
      (18, 'documents', 'company'),
      (19, 'document_attachments', 'company'),
      (20, 'document_links', 'company'),
      (21, 'document_folders', 'company'),
      (22, 'document_folder_items', 'company'),
      (23, 'document_review_log', 'company'),
      (24, 'ai_evidence', 'company'),
      (25, 'ai_evidence_review_log', 'company'),
      (26, 'chat_conversations', 'company'),
      (27, 'chat_conversation_members', 'company'),
      (28, 'chat_messages', 'company'),
      (29, 'chat_message_references', 'company'),
      (30, 'chat_attachments', 'company'),
      (31, 'invoices', 'company'),
      (32, 'invoice_number_sequences', 'company'),
      (33, 'invoice_accounting_state', 'company'),
      (34, 'invoice_accounting_state_log', 'company'),
      (35, 'received_advance_links', 'company'),
      (36, 'einvoice_inbound', 'inbound'),
      (37, 'einvoice_outbound', 'outbound'),
      (38, 'einvoice_events', 'events'),
      (39, 'einvoice_mandates', 'mandates'),
      (40, 'invoice_items', 'invoice'),
      (41, 'invoice_parties', 'invoice'),
      (42, 'invoice_tax_breakdowns', 'invoice'),
      (43, 'invoice_payments', 'invoice'),
      (44, 'invoice_events', 'invoice'),
      (45, 'invoice_advance_deductions', 'invoice')
    ) t(ord, tbl, scope)
    order by ord
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    v_expr := 'to_jsonb(x)';
    v_where := case r.scope
      when 'self' then 'x.id = $1'
      when 'company' then 'x.company_id = $1'
      when 'invoice' then 'x.invoice_id in (select i.id from public.invoices i where i.company_id = $1)'
      when 'inbound' then 'x.company_id = $1 and coalesce(x.last_error_code, '''') <> ''RECIPIENT_MISMATCH'''
      when 'outbound' then 'x.company_id = $1'
      when 'events' then 'x.company_id = $1 and (x.inbound_id is null or exists (select 1 from public.einvoice_inbound i '
                         || 'where i.id = x.inbound_id and coalesce(i.last_error_code, '''') <> ''RECIPIENT_MISMATCH''))'
      when 'mandates' then 'x.company_id = $1'
    end;
    -- Technické stĺpce prenosu (lease / retry / touch) nie sú zákaznícke údaje.
    if r.scope = 'inbound' then
      v_expr := '(to_jsonb(x) - ''updated_at'' - ''retry_count'' - ''next_retry_at'' - ''locked_until'')';
    elsif r.scope = 'outbound' then
      v_expr := '(to_jsonb(x) - ''updated_at'' - ''retry_count'' - ''next_retry_at'' - ''locked_until'' - ''last_attempt_at'''
                || ' - ''status_checked_at'' - ''send_in_flight'')';
    elsif r.scope = 'mandates' then
      -- F3: odvolanie deregistračným jobom ukončenia firmy je očakávané (nemení odtlačok); iné odvolanie áno.
      v_expr := '((to_jsonb(x) - ''revoked_at'' - ''revoked_by_kind'' - ''revoked_by_user_id'' - ''revocation_reason_code'')'
                || ' || jsonb_build_object(''unexpected_revocation'', case when x.revoked_at is null then null'
                || ' when x.revoked_by_kind = ''deregistration'' and x.revocation_reason_code = ''COMPANY_TERMINATION'''
                || ' and exists (select 1 from public.einvoice_deregistrations d where d.company_id = x.company_id'
                || ' and d.reason = ''company_termination'') then null'
                || ' else jsonb_build_object(''at'', x.revoked_at, ''kind'', x.revoked_by_kind, ''by'', x.revoked_by_user_id,'
                || ' ''code'', x.revocation_reason_code) end))';
    end if;
    execute format(
      'select count(*), coalesce(string_agg(h, '''' order by h), '''') from (select md5(' || v_expr || '::text) h from public.%I x where '
      || v_where || ') s', r.tbl)
      into v_n, v_h using p_company_id;
    v_counts := v_counts || jsonb_build_object(r.tbl, v_n);
    v_parts := v_parts || r.tbl || ':' || v_n::text || ':' || md5(v_h) || ';';
  end loop;
  return jsonb_build_object('fingerprint', encode(sha256(convert_to(v_parts, 'UTF8')), 'hex'), 'counts', v_counts);
end;
$function$;
revoke all on function public.esblu_company_export_fingerprint(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_export_fingerprint(uuid) to service_role;

-- ----------------------------------------------------------------------------- 4. begin so zoznamom súborov

create or replace function public.esblu_company_export_begin(
  p_user_id uuid,
  p_company_id uuid,
  p_schema_version text,
  p_files_total integer,
  p_file_parts integer,
  p_data_sha256 text,
  p_manifest_sha256 text,
  p_expected_fingerprint text,
  p_files jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_fp jsonb;
  v_n integer;
  v_db integer;
  v_diff integer;
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  if p_files_total is null or p_files_total < 0 or p_file_parts is null or p_file_parts < 0
     or (p_files_total = 0) <> (p_file_parts = 0)
     or (p_manifest_sha256 is not null and p_manifest_sha256 !~ '^[0-9a-f]{64}$')
     or (p_expected_fingerprint is not null and p_expected_fingerprint !~ '^[0-9a-f]{64}$')
     or (p_files is not null and jsonb_typeof(p_files) <> 'array') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  v_fp := public.esblu_company_export_fingerprint(p_company_id);
  if p_expected_fingerprint is not null and p_expected_fingerprint <> v_fp->>'fingerprint' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_DATA_CHANGED';
  end if;
  if p_files is not null then
    v_n := jsonb_array_length(p_files);
    if v_n <> p_files_total or p_file_parts <> (case when v_n = 0 then 0 else (v_n + 99) / 100 end)
       or exists (select 1 from jsonb_array_elements(p_files) f
                  where jsonb_typeof(f) <> 'object' or coalesce(f->>'bucket', '') = '' or coalesce(f->>'path', '') = '') then
      raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
    end if;
    -- Zoznam servera (TS) musí presne zodpovedať zoznamu v DB (žiadny chýbajúci ani cudzí súbor).
    select count(*) into v_db from public.esblu_company_export_file_list(p_company_id);
    select count(*) into v_diff from (
      (select f->>'bucket', f->>'path' from jsonb_array_elements(p_files) f
       except select l.bucket, l.path from public.esblu_company_export_file_list(p_company_id) l)
      union all
      (select l.bucket, l.path from public.esblu_company_export_file_list(p_company_id) l
       except select f->>'bucket', f->>'path' from jsonb_array_elements(p_files) f)
    ) d;
    if v_db <> v_n or v_diff > 0 then
      raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_FILES_MISMATCH';
    end if;
  end if;
  insert into public.company_export_runs
    (company_id, requested_by, status, schema_version, files_total, file_parts, data_sha256, completed_at,
     data_fingerprint, counts, manifest_sha256, files_bound, storage_fingerprint)
  values (p_company_id, p_user_id,
          case when p_file_parts = 0 then 'completed' else 'in_progress' end,
          p_schema_version, p_files_total, p_file_parts, lower(p_data_sha256),
          case when p_file_parts = 0 then now() end,
          v_fp->>'fingerprint', v_fp->'counts', p_manifest_sha256,
          p_files is not null,
          case when p_files is not null then public.esblu_company_export_storage_fingerprint(p_company_id) end)
  returning id into v_id;
  if p_files is not null then
    insert into public.company_export_run_files
      (run_id, idx, part_index, bucket, path, storage_object_id, storage_updated_at, storage_etag, expected_sha256)
    select v_id, (f.ord - 1)::integer, ((f.ord - 1) / 100)::integer, f.value->>'bucket', f.value->>'path',
           o.id, o.updated_at, o.metadata->>'eTag', l.expected_sha256
    from jsonb_array_elements(p_files) with ordinality f(value, ord)
    join public.esblu_company_export_file_list(p_company_id) l on l.bucket = f.value->>'bucket' and l.path = f.value->>'path'
    left join storage.objects o on o.bucket_id = f.value->>'bucket' and o.name = f.value->>'path';
  end if;
  return v_id;
end;
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text, jsonb) to service_role;

create or replace function public.esblu_company_export_begin(
  p_user_id uuid,
  p_company_id uuid,
  p_schema_version text,
  p_files_total integer,
  p_file_parts integer,
  p_data_sha256 text
)
returns uuid
language sql
security definer
set search_path = ''
as $function$
  select public.esblu_company_export_begin(p_user_id, p_company_id, p_schema_version, p_files_total, p_file_parts, p_data_sha256,
                                           null::text, null::text, null::jsonb);
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) to service_role;

-- Variant z 20261127100000 (bez zoznamu súborov) ostáva kvôli spätnej kompatibilite → beh bez väzby súborov,
-- ktorý na ukončenie firmy nestačí (brána vyžaduje files_bound).
create or replace function public.esblu_company_export_begin(
  p_user_id uuid,
  p_company_id uuid,
  p_schema_version text,
  p_files_total integer,
  p_file_parts integer,
  p_data_sha256 text,
  p_manifest_sha256 text,
  p_expected_fingerprint text
)
returns uuid
language sql
security definer
set search_path = ''
as $function$
  select public.esblu_company_export_begin(p_user_id, p_company_id, p_schema_version, p_files_total, p_file_parts, p_data_sha256,
                                           p_manifest_sha256, p_expected_fingerprint, null::jsonb);
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text) to service_role;

-- Pôvodná dávka (bez zoznamu) — pre beh so súbormi viazanými na beh sa odmietne.
create or replace function public.esblu_company_export_part(
  p_export_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_index integer,
  p_files_total integer,
  p_part_sha256 text,
  p_missing integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.company_export_runs;
  v_done integer[];
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  -- 20261128100000: beh so súbormi viazanými na beh sa dokončuje iba cez esblu_company_export_part_files.
  if exists (select 1 from public.company_export_runs r where r.id = p_export_id and r.files_bound) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_FILES_BOUND';
  end if;
  select * into v_run from public.company_export_runs r where r.id = p_export_id for update;
  if v_run.id is null or v_run.company_id <> p_company_id or v_run.requested_by <> p_user_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_NOT_FOUND';
  end if;
  if v_run.status <> 'in_progress' or v_run.created_at < now() - interval '24 hours' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_NOT_IN_PROGRESS';
  end if;
  if p_index is null or p_index < 0 or p_index >= v_run.file_parts
     or p_part_sha256 is null or p_part_sha256 !~ '^[0-9a-f]{64}$' or p_missing is null or p_missing < 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  if p_files_total is distinct from v_run.files_total then
    update public.company_export_runs set status = 'failed', error_code = 'FILES_CHANGED' where id = v_run.id;
    return 'failed';
  end if;
  if p_missing > 0 then
    update public.company_export_runs
      set status = 'failed', error_code = 'FILES_MISSING', missing_files = missing_files + p_missing,
          part_sha256 = part_sha256 || jsonb_build_object(p_index::text, p_part_sha256)
      where id = v_run.id;
    return 'failed';
  end if;
  v_done := (select array_agg(distinct x order by x) from unnest(v_run.parts_done || p_index) x);
  update public.company_export_runs
    set parts_done = v_done,
        part_sha256 = part_sha256 || jsonb_build_object(p_index::text, p_part_sha256),
        status = case when cardinality(v_done) = v_run.file_parts then 'completed' else 'in_progress' end,
        completed_at = case when cardinality(v_done) = v_run.file_parts then now() end
    where id = v_run.id;
  return case when cardinality(v_done) = v_run.file_parts then 'completed' else 'in_progress' end;
end;
$function$;
revoke all on function public.esblu_company_export_part(uuid, uuid, uuid, integer, integer, text, integer) from public, anon, authenticated;
grant execute on function public.esblu_company_export_part(uuid, uuid, uuid, integer, integer, text, integer) to service_role;

-- ----------------------------------------------------------------------------- 5. dávka súborov s identitou a SHA-256
create or replace function public.esblu_company_export_part_files(
  p_export_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_index integer,
  p_files jsonb,
  p_missing jsonb,
  p_part_sha256 text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.company_export_runs;
  v_done integer[];
  v_expected integer;
  v_given integer;
  v_diff integer;
  v_missing jsonb := coalesce(p_missing, '[]'::jsonb);
  v_complete boolean;
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  select * into v_run from public.company_export_runs r where r.id = p_export_id for update;
  if v_run.id is null or v_run.company_id <> p_company_id or v_run.requested_by <> p_user_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_NOT_FOUND';
  end if;
  if v_run.status <> 'in_progress' or v_run.created_at < now() - interval '24 hours' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_NOT_IN_PROGRESS';
  end if;
  if not v_run.files_bound or p_index is null or p_index < 0 or p_index >= v_run.file_parts
     or p_part_sha256 is null or p_part_sha256 !~ '^[0-9a-f]{64}$'
     or p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_typeof(v_missing) <> 'array'
     or exists (select 1 from jsonb_array_elements(p_files) f
                where coalesce(f->>'bucket', '') = '' or coalesce(f->>'path', '') = ''
                   or coalesce(f->>'sha256', '') !~ '^[0-9a-f]{64}$'
                   or coalesce(f->>'bytes', '') !~ '^[0-9]{1,15}$') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;

  -- Identita a umiestnenie: dávka = presne súbory tohto behu pre tento index.
  select count(*) into v_expected from public.company_export_run_files f where f.run_id = v_run.id and f.part_index = p_index;
  select count(*) into v_given from (
    select f->>'bucket', f->>'path' from jsonb_array_elements(p_files) f
    union all select m->>'bucket', m->>'path' from jsonb_array_elements(v_missing) m
  ) g;
  select count(*) into v_diff from (
    (select f->>'bucket' b, f->>'path' p from jsonb_array_elements(p_files) f
     union select m->>'bucket', m->>'path' from jsonb_array_elements(v_missing) m)
    except select rf.bucket, rf.path from public.company_export_run_files rf where rf.run_id = v_run.id and rf.part_index = p_index
  ) d;
  if v_given <> v_expected or v_diff > 0 then
    update public.company_export_runs set status = 'failed', error_code = 'FILES_CHANGED' where id = v_run.id;
    return 'failed';
  end if;
  if jsonb_array_length(v_missing) > 0 then
    update public.company_export_runs
      set status = 'failed', error_code = 'FILES_MISSING', missing_files = missing_files + jsonb_array_length(v_missing),
          part_sha256 = part_sha256 || jsonb_build_object(p_index::text, p_part_sha256)
      where id = v_run.id;
    return 'failed';
  end if;
  -- Originály e-faktúr: SHA-256 stiahnutých bajtov = nemenná hodnota v DB.
  if exists (
    select 1 from public.company_export_run_files rf
    join jsonb_array_elements(p_files) f on f->>'bucket' = rf.bucket and f->>'path' = rf.path
    where rf.run_id = v_run.id and rf.part_index = p_index and rf.expected_sha256 is not null
      and rf.expected_sha256 <> lower(f->>'sha256')
  ) then
    update public.company_export_runs set status = 'failed', error_code = 'FILES_CORRUPT' where id = v_run.id;
    return 'failed';
  end if;
  -- Súbor sa počas exportu zmenil (iný objekt / čas zmeny / eTag) alebo už predtým zaznamenaný SHA-256 nesedí.
  if exists (
    select 1 from public.company_export_run_files rf
    left join storage.objects o on o.bucket_id = rf.bucket and o.name = rf.path
    where rf.run_id = v_run.id and rf.part_index = p_index
      and (o.id is distinct from rf.storage_object_id or o.updated_at is distinct from rf.storage_updated_at
           or (o.metadata->>'eTag') is distinct from rf.storage_etag)
  ) or exists (
    select 1 from public.company_export_run_files rf
    join jsonb_array_elements(p_files) f on f->>'bucket' = rf.bucket and f->>'path' = rf.path
    where rf.run_id = v_run.id and rf.part_index = p_index and rf.sha256 is not null and rf.sha256 <> lower(f->>'sha256')
  ) then
    update public.company_export_runs set status = 'failed', error_code = 'FILES_CHANGED' where id = v_run.id;
    return 'failed';
  end if;

  update public.company_export_run_files rf
     set sha256 = lower(f->>'sha256'), size_bytes = (f->>'bytes')::bigint
    from jsonb_array_elements(p_files) f
   where rf.run_id = v_run.id and rf.part_index = p_index and rf.bucket = f->>'bucket' and rf.path = f->>'path';

  v_done := (select array_agg(distinct x order by x) from unnest(v_run.parts_done || p_index) x);
  v_complete := cardinality(v_done) = v_run.file_parts
    and not exists (select 1 from public.company_export_run_files rf where rf.run_id = v_run.id and rf.sha256 is null);
  update public.company_export_runs
    set parts_done = v_done,
        part_sha256 = part_sha256 || jsonb_build_object(p_index::text, p_part_sha256),
        status = case when v_complete then 'completed' else 'in_progress' end,
        completed_at = case when v_complete then now() end
    where id = v_run.id;
  return case when v_complete then 'completed' else 'in_progress' end;
end;
$function$;
revoke all on function public.esblu_company_export_part_files(uuid, uuid, uuid, integer, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_part_files(uuid, uuid, uuid, integer, jsonb, jsonb, text) to service_role;

-- ----------------------------------------------------------------------------- 6. brána (export + súbory + Storage)
create or replace function public.esblu_company_termination_export_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.company_export_runs;
  v_fp text;
  v_has_documents boolean;
  v_last_sign_in timestamptz;
begin
  if new.status <> 'executing' then
    return new;
  end if;

  -- O3: firma s finalizovanými dokladmi alebo e-faktúrami nesmie byť vymazaná bez overeného exportu.
  v_has_documents :=
       exists (select 1 from public.invoices i where i.company_id = new.company_id and i.document_status <> 'draft')
    or (to_regclass('public.einvoice_inbound') is not null
        and exists (select 1 from public.einvoice_inbound e where e.company_id = new.company_id
                    and coalesce(e.last_error_code, '') <> 'RECIPIENT_MISMATCH'))
    or (to_regclass('public.einvoice_outbound') is not null
        and exists (select 1 from public.einvoice_outbound o where o.company_id = new.company_id));
  if new.export_mode = 'waived' and v_has_documents
     and coalesce(new.termination_mode, '') <> 'synthetic_test_data_purge' then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_REQUIRED';
  end if;

  if new.export_mode = 'exported' then
    select * into v_run
    from public.company_export_runs r
    where r.company_id = new.company_id
      and r.requested_by = new.requested_by
      and r.status = 'completed'
      and r.missing_files = 0
      and r.completed_at > now() - interval '24 hours'
    order by r.completed_at desc
    limit 1;
    if v_run.id is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_VERIFIED';
    end if;
    v_fp := public.esblu_company_export_fingerprint(new.company_id)->>'fingerprint';
    if v_run.data_fingerprint is null or v_run.data_fingerprint <> v_fp then
      -- Údaje sa po exporte zmenili (alebo beh nemá odtlačok — starší kód) → nový export.
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_STALE';
    end if;
    -- 20261128100000: súbory viazané na beh (identita, umiestnenie, SHA-256) a nezmenený stav Storage.
    if v_run.files_bound is distinct from true
       or v_run.storage_fingerprint is null
       or v_run.storage_fingerprint <> public.esblu_company_export_storage_fingerprint(new.company_id)
       or exists (select 1 from public.company_export_run_files f where f.run_id = v_run.id and f.sha256 is null) then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_STALE';
    end if;
    new.export_run_id := v_run.id;
    new.export_fingerprint := v_fp;
  end if;

  if coalesce(new.termination_mode, '') = 'customer_delete' then
    if new.authority_confirmed is distinct from true
       or new.ack_text_version is null or new.ack_text_sha256 is null
       or new.confirmed_at is null
       or new.confirmed_at < now() - interval '15 minutes'
       or new.confirmed_at > now() + interval '1 minute' then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_ACK_REQUIRED';
    end if;
    select u.last_sign_in_at into v_last_sign_in from auth.users u where u.id = new.requested_by;
    if v_last_sign_in is null or v_last_sign_in < now() - interval '30 minutes' then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_REAUTH_REQUIRED';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_company_termination_export_gate() from public, anon, authenticated;

-- ----------------------------------------------------------------------------- 7. R3 incidentový záznam
create table if not exists public.einvoice_misdelivery_incidents (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  environment text not null,
  provider_received_id_sha256 text not null,
  xml_sha256 text null,
  xml_size_bytes bigint null,
  received_at timestamptz null,
  detected_error_code text not null default 'RECIPIENT_MISMATCH',
  mailbox_company_id uuid not null,
  termination_id uuid null,
  resolution text not null default 'deleted_on_company_termination',
  recorded_at timestamptz not null default now(),
  constraint einvoice_misdelivery_incidents_key unique (provider, environment, provider_received_id_sha256, mailbox_company_id),
  constraint einvoice_misdelivery_incidents_check check (
    provider_received_id_sha256 ~ '^[0-9a-f]{64}$' and (xml_sha256 is null or xml_sha256 ~ '^[0-9a-f]{64}$')
    and detected_error_code = 'RECIPIENT_MISMATCH' and resolution in ('deleted_on_company_termination')
  )
);
comment on table public.einvoice_misdelivery_incidents is
  'R3: minimálny záznam o doklade adresovanom inému účastníkovi pred jeho výmazom. Bez obsahu, cesty, strán a čísla '
  'dokladu. Iba čítanie service_role (prevádzka). Retencia: návrh docs/p15-retention-proposal-2026-11-23.md.';
alter table public.einvoice_misdelivery_incidents enable row level security;
revoke all on table public.einvoice_misdelivery_incidents from public, anon, authenticated, service_role;
grant select on table public.einvoice_misdelivery_incidents to service_role;

-- ----------------------------------------------------------------------------- 8. výmaz (job naviazaný na ukončenie)
drop trigger if exists esblu_company_termination_storage_purged on public.account_deletion_cleanup_jobs;
drop function if exists public.esblu_company_termination_storage_purged();

create or replace function public.esblu_company_termination_execute(
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean,
  p_export_mode text,
  p_ack jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tid uuid;
  v_done public.company_terminations;
  v_inv uuid[];
  v_files jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_res jsonb;
  v_job uuid;
  v_targets jsonb;
  v_job_storage text;
  v_mismatch bigint;
  v_prefix text := p_company_id::text || '/';
begin
  if p_user_id is null or p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_export_mode is null or p_export_mode not in ('exported', 'waived') then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED';
  end if;
  if p_ack is null or jsonb_typeof(p_ack) <> 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_ACK_REQUIRED';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    select * into v_done from public.company_terminations t
    where t.company_id = p_company_id and t.requested_by = p_user_id and t.status = 'completed'
    order by t.completed_at desc limit 1;
    if v_done.id is not null then
      return jsonb_build_object(
        'already_completed', true, 'termination_id', v_done.id, 'job_id', v_done.cleanup_job_id,
        'storage_targets', '[]'::jsonb, 'summary', null, 'delete_account', false,
        'termination_mode', v_done.termination_mode
      );
    end if;
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active' and cm.role = 'owner'
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.owner_id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_OWNER_MISMATCH';
  end if;
  if to_regclass('public.einvoice_organizations') is not null and exists (
    select 1 from public.einvoice_organizations o where o.company_id = p_company_id and o.provider_org_id is not null
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_PROVIDER_ENROLLED';
  end if;

  -- Brána (trigger) overí export, odtlačok dát, potvrdenie oprávnenej osoby a čerstvé prihlásenie.
  insert into public.company_terminations
    (company_id, requested_by, status, export_mode, termination_mode,
     ack_text_version, ack_text_sha256, authority_confirmed, confirmed_at, request_ip_sha256, user_agent_sha256)
  values (p_company_id, p_user_id, 'executing', p_export_mode, 'customer_delete',
          p_ack->>'text_version', lower(p_ack->>'text_sha256'),
          case when jsonb_typeof(p_ack->'authority_confirmed') = 'boolean' then (p_ack->>'authority_confirmed')::boolean end,
          nullif(p_ack->>'confirmed_at', '')::timestamptz,
          lower(nullif(p_ack->>'ip_sha256', '')), lower(nullif(p_ack->>'user_agent_sha256', '')))
  returning id into v_tid;
  perform set_config('esblu.company_termination_id', v_tid::text, true);

  -- Súbory e-faktúr firmy idú do výmazu — žiadny archív. Okrem ciest z riadkov (XML, PDF, UBL; aj karanténa a
  -- R3) aj VŠETKY objekty pod prefixom firmy v einvoice-documents (osirelé súbory). Prefix = ID firmy → izolácia.
  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'einvoice-documents', 'path', x.p)), '[]'::jsonb)
  into v_files
  from (
    select i.xml_storage_path as p from public.einvoice_inbound i where i.company_id = p_company_id and i.xml_storage_path is not null
    union all
    select i.pdf_storage_path from public.einvoice_inbound i where i.company_id = p_company_id and i.pdf_storage_path is not null
    union all
    select o.ubl_storage_path from public.einvoice_outbound o where o.company_id = p_company_id and o.ubl_storage_path is not null
    union all
    select so.name from storage.objects so where so.bucket_id = 'einvoice-documents' and left(so.name, length(v_prefix)) = v_prefix
  ) x
  where left(x.p, length(v_prefix)) = v_prefix and position('..' in x.p) = 0;
  if exists (
    select 1 from (
      select i.xml_storage_path p from public.einvoice_inbound i where i.company_id = p_company_id
      union all select i.pdf_storage_path from public.einvoice_inbound i where i.company_id = p_company_id
      union all select o.ubl_storage_path from public.einvoice_outbound o where o.company_id = p_company_id
    ) y where y.p is not null and (left(y.p, length(v_prefix)) <> v_prefix or position('..' in y.p) > 0)
  ) then
    -- Súbor mimo prefixu firmy by sa nevymazal a nesmie sa ani potichu preskočiť → zastaviť (fail closed).
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_STORAGE_PATH_INVALID';
  end if;

  -- R3: minimálny incidentový záznam pred výmazom dokladu adresovaného inému účastníkovi (bez obsahu, cesty,
  -- odosielateľa, príjemcu ani čísla dokladu — iba hash identifikátora u poskytovateľa a hash obsahu).
  insert into public.einvoice_misdelivery_incidents
    (provider, environment, provider_received_id_sha256, xml_sha256, xml_size_bytes, received_at, mailbox_company_id, termination_id)
  select i.provider, i.environment,
         encode(sha256(convert_to('esblu-misdelivery:v1:' || i.provider || ':' || i.environment || ':' || i.provider_received_id, 'UTF8')), 'hex'),
         i.xml_sha256, i.xml_size_bytes, i.received_at, i.company_id, v_tid
  from public.einvoice_inbound i
  where i.company_id = p_company_id and i.last_error_code = 'RECIPIENT_MISMATCH'
  on conflict (provider, environment, provider_received_id_sha256, mailbox_company_id) do nothing;
  select count(*) into v_mismatch from public.einvoice_inbound i where i.company_id = p_company_id and i.last_error_code = 'RECIPIENT_MISMATCH';

  select coalesce(array_agg(i.id), '{}') into v_inv from public.invoices i where i.company_id = p_company_id;

  delete from public.einvoice_events where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_events', v_n);
  delete from public.einvoice_outbound where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_outbound', v_n);
  delete from public.einvoice_inbound where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_inbound', v_n);
  v_counts := v_counts || jsonb_build_object('einvoice_inbound_recipient_mismatch', v_mismatch);
  delete from public.received_advance_links where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('received_advance_links', v_n);
  delete from public.invoice_advance_deductions where invoice_id = any(v_inv) or advance_invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_advance_deductions', v_n);
  delete from public.invoice_items where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_items', v_n);
  delete from public.invoice_events where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_events', v_n);
  delete from public.invoice_parties where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_parties', v_n);
  delete from public.invoice_tax_breakdowns where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_tax_breakdowns', v_n);
  delete from public.invoices where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoices', v_n);

  v_res := public.esblu_account_deletion_commit('owner', p_user_id, p_company_id, coalesce(p_delete_account, false));
  v_job := nullif(v_res->>'job_id', '')::uuid;

  -- Ciele výmazu: zber firmy + súbory e-faktúr. Účtovné kópie Esblu (billing-documents) nie sú údaje zákazníka —
  -- zber ich nikdy neobsahuje; ak by sa objavili, trigger cleanup jobu zastaví celú transakciu (nie tiché preskočenie).
  select coalesce(jsonb_agg(distinct x.value), '[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(v_res->'storage_targets', '[]'::jsonb) || v_files) x;
  if v_job is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_CLEANUP_JOB_MISSING';
  end if;

  -- Job sa naviaže na ukončenie (oprávňuje výmaz v einvoice-documents iba pod prefixom firmy).
  update public.account_deletion_cleanup_jobs
     set termination_id = v_tid,
         company_id = p_company_id,
         storage_targets = v_targets,
         storage_target_count = jsonb_array_length(v_targets),
         storage_status = case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end,
         storage_verified_at = case when jsonb_array_length(v_targets) = 0 then now() end,
         completed_at = case when jsonb_array_length(v_targets) = 0 and auth_status = 'done'
                             then coalesce(completed_at, now()) end,
         updated_at = now()
   where id = v_job;

  update public.company_terminations
     set status = 'completed',
         completed_at = now(),
         cleanup_job_id = v_job,
         storage_target_count = jsonb_array_length(v_targets),
         storage_targets_sha256 = (
           select encode(sha256(convert_to(coalesce(string_agg(x.value->>'bucket' || chr(31) || (x.value->>'path'), chr(30)
                                                              order by x.value->>'bucket', x.value->>'path'), ''), 'UTF8')), 'hex')
           from jsonb_array_elements(v_targets) x),
         deleted_counts = v_counts || coalesce(v_res->'summary'->'deleted_counts', '{}'::jsonb),
         -- Preukázateľný výmaz: iba ak nie je čo mazať; inak až esblu_cleanup_job_confirm_storage po overení Storage.
         storage_purged_at = case when jsonb_array_length(v_targets) = 0 then now() end,
         storage_verified_count = case when jsonb_array_length(v_targets) = 0 then 0 end
   where id = v_tid;

  perform set_config('esblu.company_termination_id', '', true);

  return jsonb_set(v_res, '{storage_targets}', v_targets)
    || jsonb_build_object('termination_id', v_tid, 'termination_mode', 'customer_delete');
end;
$function$;
revoke all on function public.esblu_company_termination_execute(uuid, uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_execute(uuid, uuid, boolean, text, jsonb) to service_role;

-- ----------------------------------------------------------------------------- 9. ochrana cieľov cleanup jobu
create or replace function public.esblu_cleanup_jobs_protect_retained_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_verify boolean := coalesce(current_setting('esblu.cleanup_verify_job', true), '') = new.id::text;
begin
  if tg_op = 'UPDATE' and old.termination_id is not null and new.termination_id is distinct from old.termination_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_CLEANUP_JOB_IMMUTABLE';
  end if;
  -- Ciele sa kontrolujú pri vzniku jobu a pri každej zmene cieľov alebo naviazania (nie pri iných zmenách
  -- staršieho jobu, napr. auth_status).
  if new.storage_targets is not null and jsonb_typeof(new.storage_targets) = 'array'
     and (tg_op = 'INSERT' or new.storage_targets is distinct from old.storage_targets
          or new.termination_id is distinct from old.termination_id or new.company_id is distinct from old.company_id) then
    -- Účtovné kópie Esblu nikdy (chyba, nie tiché preskočenie).
    if exists (select 1 from jsonb_array_elements(new.storage_targets) x where x.value->>'bucket' = 'billing-documents') then
      raise exception using errcode = 'P0001', message = 'ESBLU_CLEANUP_TARGET_PROTECTED';
    end if;
    -- einvoice-documents iba pre job autorizovaného ukončenia a iba pod prefixom tej istej firmy.
    if exists (select 1 from jsonb_array_elements(new.storage_targets) x where x.value->>'bucket' = 'einvoice-documents') then
      if new.termination_id is null or new.company_id is null
         or not exists (select 1 from public.company_terminations t
                        where t.id = new.termination_id and t.company_id = new.company_id
                          and t.status in ('executing', 'completed') and t.termination_mode = 'customer_delete')
         or exists (select 1 from jsonb_array_elements(new.storage_targets) x
                    where x.value->>'bucket' = 'einvoice-documents'
                      and (left(x.value->>'path', length(new.company_id::text) + 1) <> new.company_id::text || '/'
                           or position('..' in x.value->>'path') > 0)) then
        raise exception using errcode = 'P0001', message = 'ESBLU_CLEANUP_TARGET_PROTECTED';
      end if;
    end if;
  end if;
  -- Job ukončenia: po naviazaní sa ciele môžu iba zmenšovať a „hotovo“ zapíše iba overenie Storage.
  if tg_op = 'UPDATE' and old.termination_id is not null and not v_verify then
    if exists (select 1 from jsonb_array_elements(coalesce(new.storage_targets, '[]'::jsonb)) x
               where not (old.storage_targets @> jsonb_build_array(x.value))) then
      raise exception using errcode = 'P0001', message = 'ESBLU_CLEANUP_TARGETS_IMMUTABLE';
    end if;
    if new.storage_status = 'done' and old.storage_status is distinct from 'done' then
      raise exception using errcode = 'P0001', message = 'ESBLU_CLEANUP_UNVERIFIED';
    end if;
    if new.storage_verified_at is distinct from old.storage_verified_at then
      raise exception using errcode = 'P0001', message = 'ESBLU_CLEANUP_UNVERIFIED';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_cleanup_jobs_protect_retained_storage() from public, anon, authenticated, service_role;

drop trigger if exists esblu_cleanup_jobs_protect_retained_storage on public.account_deletion_cleanup_jobs;
create trigger esblu_cleanup_jobs_protect_retained_storage
  before insert or update on public.account_deletion_cleanup_jobs
  for each row execute function public.esblu_cleanup_jobs_protect_retained_storage();

-- ----------------------------------------------------------------------------- 10. overenie výmazu v Storage
-- Volá cleanup (route aj cron) po výmaze. Hotovo IBA ak žiadny cieľ (a pri ukončení ani žiadny objekt pod prefixom
-- firmy v einvoice-documents) neexistuje v storage.objects. Inak job ostane pending so zvyškom cieľov.
create or replace function public.esblu_cleanup_job_confirm_storage(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.account_deletion_cleanup_jobs;
  v_remaining jsonb;
  v_prefix text;
begin
  select * into v_job from public.account_deletion_cleanup_jobs j where j.id = p_job_id for update;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_CLEANUP_JOB_NOT_FOUND';
  end if;
  if v_job.storage_status = 'done' then
    return jsonb_build_object('done', true, 'remaining', 0, 'already', true);
  end if;
  select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_remaining
  from jsonb_array_elements(coalesce(v_job.storage_targets, '[]'::jsonb)) x
  where exists (select 1 from storage.objects o where o.bucket_id = x.value->>'bucket' and o.name = x.value->>'path');
  if v_job.termination_id is not null and v_job.company_id is not null then
    v_prefix := v_job.company_id::text || '/';
    select v_remaining || coalesce(jsonb_agg(jsonb_build_object('bucket', 'einvoice-documents', 'path', o.name)), '[]'::jsonb)
    into v_remaining
    from storage.objects o
    where o.bucket_id = 'einvoice-documents' and left(o.name, length(v_prefix)) = v_prefix
      and not (v_remaining @> jsonb_build_array(jsonb_build_object('bucket', 'einvoice-documents', 'path', o.name)));
  end if;
  perform set_config('esblu.cleanup_verify_job', p_job_id::text, true);
  if jsonb_array_length(v_remaining) = 0 then
    update public.account_deletion_cleanup_jobs
       set storage_status = 'done', storage_targets = '[]'::jsonb, storage_verified_at = now(),
           completed_at = case when auth_status = 'done' then coalesce(completed_at, now()) else completed_at end,
           last_error_code = case when auth_status = 'done' then null else last_error_code end,
           updated_at = now()
     where id = p_job_id;
    if v_job.termination_id is not null then
      update public.company_terminations
         set storage_purged_at = coalesce(storage_purged_at, now()),
             storage_verified_count = coalesce(storage_verified_count, v_job.storage_target_count)
       where id = v_job.termination_id;
    end if;
    perform set_config('esblu.cleanup_verify_job', '', true);
    return jsonb_build_object('done', true, 'remaining', 0);
  end if;
  update public.account_deletion_cleanup_jobs
     set storage_targets = v_remaining, storage_status = 'pending', last_error_code = 'ESBLU_STORAGE_NOT_PURGED', updated_at = now()
   where id = p_job_id;
  perform set_config('esblu.cleanup_verify_job', '', true);
  return jsonb_build_object('done', false, 'remaining', jsonb_array_length(v_remaining));
end;
$function$;
revoke all on function public.esblu_cleanup_job_confirm_storage(uuid) from public, anon, authenticated;
grant execute on function public.esblu_cleanup_job_confirm_storage(uuid) to service_role;

-- Monitoring: joby po vyčerpaní pokusov a ukončenia bez overeného výmazu súborov (iba počty).
create or replace function public.esblu_cleanup_health(p_max_attempts integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'exhausted', (select count(*) from public.account_deletion_cleanup_jobs j
                  where (j.storage_status = 'pending' or j.auth_status = 'pending') and j.attempts >= p_max_attempts),
    'termination_unpurged_24h', (select count(*) from public.company_terminations t
                  where t.status = 'completed' and t.termination_mode = 'customer_delete'
                    and t.storage_purged_at is null and t.completed_at < now() - interval '24 hours'));
$function$;
revoke all on function public.esblu_cleanup_health(integer) from public, anon, authenticated;
grant execute on function public.esblu_cleanup_health(integer) to service_role;

commit;
