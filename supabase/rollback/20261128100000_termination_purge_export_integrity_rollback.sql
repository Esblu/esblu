-- =============================================================================
-- Rollback 20261128100000_termination_purge_export_integrity (PRIPRAVENÉ — NEAPLIKOVANÉ).
-- Vráti funkcie a triggery do stavu 20261127100000. Evidencia (company_export_run_files,
-- einvoice_misdelivery_incidents, nové stĺpce) sa NEMAŽE (audit).
-- =============================================================================
begin;

drop function if exists public.esblu_cleanup_health(integer);
drop function if exists public.esblu_cleanup_job_confirm_storage(uuid);
drop function if exists public.esblu_company_export_part_files(uuid, uuid, uuid, integer, jsonb, jsonb, text);
drop function if exists public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text, jsonb);

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
begin
  if p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  for r in
    select * from (values
      (1, 'invoices', 'company'), (2, 'invoice_items', 'invoice'), (3, 'invoice_parties', 'invoice'),
      (4, 'invoice_tax_breakdowns', 'invoice'), (5, 'invoice_payments', 'invoice'), (6, 'invoice_events', 'invoice'),
      (7, 'invoice_advance_deductions', 'invoice'), (8, 'invoice_accounting_state', 'company'),
      (9, 'invoice_accounting_state_log', 'company'), (10, 'received_advance_links', 'company'),
      (11, 'documents', 'company'), (12, 'document_attachments', 'company'),
      (13, 'einvoice_inbound', 'inbound'), (14, 'einvoice_outbound', 'company'), (15, 'einvoice_events', 'events'),
      (16, 'einvoice_mandates', 'company')
    ) t(ord, tbl, scope)
    order by ord
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    v_where := case r.scope
      when 'company' then 'x.company_id = $1'
      when 'invoice' then 'x.invoice_id in (select i.id from public.invoices i where i.company_id = $1)'
      when 'inbound' then 'x.company_id = $1 and coalesce(x.last_error_code, '''') <> ''RECIPIENT_MISMATCH'''
      when 'events' then 'x.company_id = $1 and (x.inbound_id is null or exists (select 1 from public.einvoice_inbound i '
                         || 'where i.id = x.inbound_id and coalesce(i.last_error_code, '''') <> ''RECIPIENT_MISMATCH''))'
    end;
    execute format(
      'select count(*), coalesce(string_agg(h, '''' order by h), '''') from (select md5(to_jsonb(x)::text) h from public.%I x where '
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
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_fp jsonb;
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  if p_files_total is null or p_files_total < 0 or p_file_parts is null or p_file_parts < 0
     or (p_files_total = 0) <> (p_file_parts = 0)
     or (p_manifest_sha256 is not null and p_manifest_sha256 !~ '^[0-9a-f]{64}$')
     or (p_expected_fingerprint is not null and p_expected_fingerprint !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  v_fp := public.esblu_company_export_fingerprint(p_company_id);
  if p_expected_fingerprint is not null and p_expected_fingerprint <> v_fp->>'fingerprint' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_DATA_CHANGED';
  end if;
  insert into public.company_export_runs
    (company_id, requested_by, status, schema_version, files_total, file_parts, data_sha256, completed_at,
     data_fingerprint, counts, manifest_sha256)
  values (p_company_id, p_user_id,
          case when p_file_parts = 0 then 'completed' else 'in_progress' end,
          p_schema_version, p_files_total, p_file_parts, lower(p_data_sha256),
          case when p_file_parts = 0 then now() end,
          v_fp->>'fingerprint', v_fp->'counts', p_manifest_sha256)
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text) to service_role;

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
  select public.esblu_company_export_begin(p_user_id, p_company_id, p_schema_version, p_files_total, p_file_parts, p_data_sha256, null::text, null::text);
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) to service_role;

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

drop function if exists public.esblu_company_export_storage_fingerprint(uuid);
drop function if exists public.esblu_company_export_file_list(uuid);

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

  -- Súbory e-faktúr firmy (vrátane PDF prijatých e-faktúr) idú do výmazu — žiadny archív.
  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'einvoice-documents', 'path', x.p)), '[]'::jsonb)
  into v_files
  from (
    select i.xml_storage_path as p from public.einvoice_inbound i where i.company_id = p_company_id and i.xml_storage_path is not null
    union all
    select i.pdf_storage_path from public.einvoice_inbound i where i.company_id = p_company_id and i.pdf_storage_path is not null
    union all
    select o.ubl_storage_path from public.einvoice_outbound o where o.company_id = p_company_id and o.ubl_storage_path is not null
  ) x;

  select coalesce(array_agg(i.id), '{}') into v_inv from public.invoices i where i.company_id = p_company_id;

  delete from public.einvoice_events where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_events', v_n);
  delete from public.einvoice_outbound where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_outbound', v_n);
  delete from public.einvoice_inbound where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_inbound', v_n);
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

  -- Ciele výmazu: zber firmy + súbory e-faktúr; nikdy účtovné kópie Esblu (billing-documents).
  select coalesce(jsonb_agg(distinct x.value), '[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(v_res->'storage_targets', '[]'::jsonb) || v_files) x
  where coalesce(x.value->>'bucket', '') <> 'billing-documents';

  if v_job is not null and v_targets is distinct from coalesce(v_res->'storage_targets', '[]'::jsonb) then
    update public.account_deletion_cleanup_jobs
       set storage_targets = v_targets,
           storage_target_count = jsonb_array_length(v_targets),
           storage_status = case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end,
           completed_at = case when jsonb_array_length(v_targets) = 0 and auth_status = 'done'
                               then coalesce(completed_at, now()) end
     where id = v_job;
  end if;
  select j.storage_status into v_job_storage from public.account_deletion_cleanup_jobs j where j.id = v_job;

  update public.company_terminations
     set status = 'completed',
         completed_at = now(),
         cleanup_job_id = v_job,
         storage_target_count = jsonb_array_length(v_targets),
         deleted_counts = v_counts || coalesce(v_res->'summary'->'deleted_counts', '{}'::jsonb),
         storage_purged_at = case when jsonb_array_length(v_targets) = 0 or v_job_storage = 'done' then now() end
   where id = v_tid;

  perform set_config('esblu.company_termination_id', '', true);

  return jsonb_set(v_res, '{storage_targets}', v_targets)
    || jsonb_build_object('termination_id', v_tid, 'termination_mode', 'customer_delete');
end;
$function$;
revoke all on function public.esblu_company_termination_execute(uuid, uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_execute(uuid, uuid, boolean, text, jsonb) to service_role;

create or replace function public.esblu_cleanup_jobs_protect_retained_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_clean jsonb;
begin
  if new.storage_targets is null or jsonb_typeof(new.storage_targets) <> 'array' then
    return new;
  end if;
  -- Účtovné kópie Esblu (vlastná zákonná povinnosť Esblu) nikdy nie sú cieľom výmazu zákazníckych údajov.
  select coalesce(jsonb_agg(x.value order by x.ord), '[]'::jsonb) into v_clean
  from jsonb_array_elements(new.storage_targets) with ordinality x(value, ord)
  where coalesce(x.value->>'bucket', '') <> 'billing-documents';
  if v_clean is distinct from new.storage_targets then
    new.storage_targets := v_clean;
    new.storage_target_count := jsonb_array_length(v_clean);
    if jsonb_array_length(v_clean) = 0 then
      new.storage_status := 'done';
      if new.auth_status = 'done' then
        new.completed_at := coalesce(new.completed_at, now());
      end if;
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_cleanup_jobs_protect_retained_storage() from public, anon, authenticated, service_role;
drop trigger if exists esblu_cleanup_jobs_protect_retained_storage on public.account_deletion_cleanup_jobs;
create trigger esblu_cleanup_jobs_protect_retained_storage
  before insert or update of storage_targets on public.account_deletion_cleanup_jobs
  for each row execute function public.esblu_cleanup_jobs_protect_retained_storage();

create or replace function public.esblu_company_termination_storage_purged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.storage_status = 'done' and old.storage_status is distinct from 'done' then
    update public.company_terminations t
       set storage_purged_at = coalesce(t.storage_purged_at, now())
     where t.cleanup_job_id = new.id;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_company_termination_storage_purged() from public, anon, authenticated, service_role;
drop trigger if exists esblu_company_termination_storage_purged on public.account_deletion_cleanup_jobs;
create trigger esblu_company_termination_storage_purged
  after update of storage_status on public.account_deletion_cleanup_jobs
  for each row execute function public.esblu_company_termination_storage_purged();

commit;
