-- =============================================================================
-- Rollback 20261127100000_company_termination_customer_delete (PRIPRAVENÉ — NEAPLIKOVANÉ).
-- Obnoví predchádzajúce správanie podľa prostredia:
--   - s esblu_retention (staging po 20261121100000): commit = wrapper na archív, cleanup ochrana vrátane archívu,
--   - bez esblu_retention (produkcia): commit = pôvodný výmaz z 20261112110000, cleanup trigger sa odstráni.
-- Nové stĺpce a evidenčné záznamy (company_terminations, company_export_runs) sa NEMAŽÚ (audit).
-- =============================================================================
begin;

drop trigger if exists esblu_company_termination_storage_purged on public.account_deletion_cleanup_jobs;
drop function if exists public.esblu_company_termination_storage_purged();
drop function if exists public.esblu_company_termination_execute(uuid, uuid, boolean, text, jsonb);
drop function if exists public.esblu_company_termination_preflight(uuid, uuid, text, jsonb);
drop function if exists public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text);

-- pôvodný begin (20261113110000) — bez odtlačku
create or replace function public.esblu_company_export_begin(
  p_user_id uuid,
  p_company_id uuid,
  p_schema_version text,
  p_files_total integer,
  p_file_parts integer,
  p_data_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  if p_files_total is null or p_files_total < 0 or p_file_parts is null or p_file_parts < 0
     or (p_files_total = 0) <> (p_file_parts = 0) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  insert into public.company_export_runs (company_id, requested_by, status, schema_version, files_total, file_parts, data_sha256, completed_at)
  values (p_company_id, p_user_id,
          case when p_file_parts = 0 then 'completed' else 'in_progress' end,
          p_schema_version, p_files_total, p_file_parts, lower(p_data_sha256),
          case when p_file_parts = 0 then now() end)
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) to service_role;
drop function if exists public.esblu_company_export_fingerprint(uuid);

create or replace function public.esblu_company_termination_export_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run uuid;
begin
  if new.status = 'executing' and new.export_mode = 'exported' then
    select r.id into v_run
    from public.company_export_runs r
    where r.company_id = new.company_id
      and r.requested_by = new.requested_by
      and r.status = 'completed'
      and r.missing_files = 0
      and r.completed_at > now() - interval '24 hours'
    order by r.completed_at desc
    limit 1;
    if v_run is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_VERIFIED';
    end if;
    new.export_run_id := v_run;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_company_termination_export_gate() from public, anon, authenticated;

alter table public.company_terminations drop constraint if exists company_terminations_mode_check;
alter table public.company_terminations add constraint company_terminations_mode_check check (
  termination_mode is null or termination_mode in ('archive', 'synthetic_test_data_purge', 'customer_delete')
);

create or replace function public.esblu_company_termination_commit(
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean,
  p_export_mode text
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
  v_xml jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_res jsonb;
  v_job uuid;
  v_targets jsonb;
begin
  if p_user_id is null or p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_export_mode is null or p_export_mode not in ('exported', 'waived') then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    select * into v_done from public.company_terminations t
    where t.company_id = p_company_id and t.requested_by = p_user_id and t.status = 'completed'
    order by t.completed_at desc limit 1;
    if v_done.id is not null then
      return jsonb_build_object(
        'already_completed', true, 'termination_id', v_done.id, 'job_id', v_done.cleanup_job_id,
        'storage_targets', '[]'::jsonb, 'summary', null, 'delete_account', false
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

  insert into public.company_terminations (company_id, requested_by, status, export_mode)
  values (p_company_id, p_user_id, 'executing', p_export_mode)
  returning id into v_tid;
  perform set_config('esblu.company_termination_id', v_tid::text, true);

  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'einvoice-documents', 'path', x.p)), '[]'::jsonb)
  into v_xml
  from (
    select i.xml_storage_path as p from public.einvoice_inbound i where i.company_id = p_company_id and i.xml_storage_path is not null
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

  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(v_res->'storage_targets', '[]'::jsonb) || v_xml) x;

  if jsonb_array_length(v_xml) > 0 and v_job is not null then
    update public.account_deletion_cleanup_jobs
       set storage_targets = v_targets,
           storage_target_count = jsonb_array_length(v_targets),
           storage_status = 'pending',
           completed_at = null
     where id = v_job;
  end if;

  update public.company_terminations
     set status = 'completed',
         completed_at = now(),
         cleanup_job_id = v_job,
         storage_target_count = jsonb_array_length(v_targets),
         deleted_counts = v_counts || coalesce(v_res->'summary'->'deleted_counts', '{}'::jsonb)
   where id = v_tid;

  perform set_config('esblu.company_termination_id', '', true);

  return jsonb_set(v_res, '{storage_targets}', v_targets) || jsonb_build_object('termination_id', v_tid);
end;
$function$;

comment on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) is
  'VOP 20.6 / DPA (service_role only): ukončenie firmy vrátane finalizovaných dokladov a e-faktúr v JEDNEJ '
  'transakcii po potvrdení Vlastníka a exporte (exported) alebo výslovnom vzdaní sa exportu (waived). '
  'Storage sa maže až po commite z cleanup jobu. Idempotentné (already_completed).';

revoke all on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) to service_role;

-- Prostredie s retenčným archívom (staging): obnoviť stav po 20261121100000.
do $do$
begin
  if to_regprocedure('esblu_retention.termination_execute(uuid, uuid, boolean, text, text, text, text)') is not null then
    execute $sql$
      create or replace function public.esblu_company_termination_commit(
        p_user_id uuid, p_company_id uuid, p_delete_account boolean, p_export_mode text)
      returns jsonb language plpgsql security definer set search_path = '' as $function$
      begin
        return esblu_retention.termination_execute(p_user_id, p_company_id, p_delete_account, p_export_mode, 'archive', null, null);
      end;
      $function$;
    $sql$;
  end if;
  if to_regclass('esblu_retention.archived_records') is not null then
    execute $sql$
      create or replace function public.esblu_cleanup_jobs_protect_retained_storage()
      returns trigger language plpgsql security definer set search_path = '' as $function$
      declare
        v_clean jsonb;
      begin
        if new.storage_targets is null or jsonb_typeof(new.storage_targets) <> 'array' then
          return new;
        end if;
        select coalesce(jsonb_agg(x.value order by x.ord), '[]'::jsonb) into v_clean
        from jsonb_array_elements(new.storage_targets) with ordinality x(value, ord)
        where coalesce(x.value->>'bucket', '') <> 'billing-documents'
          and not exists (select 1 from esblu_retention.archived_records r, jsonb_array_elements(r.storage_objects) o
                          where o.value->>'bucket' = x.value->>'bucket' and o.value->>'path' = x.value->>'path');
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
    $sql$;
  else
    drop trigger if exists esblu_cleanup_jobs_protect_retained_storage on public.account_deletion_cleanup_jobs;
    drop function if exists public.esblu_cleanup_jobs_protect_retained_storage();
  end if;
end;
$do$;

revoke all on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) to service_role;

commit;
