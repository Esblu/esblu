-- Rollback 20261121100000_retention_archive_company_termination (staging / produkcia iba so súhlasom).
--
-- POZOR: rollback vracia PÔVODNÉ správanie z 20261112110000 — bežné ukončenie firmy
-- (exported / waived) bude znova MAZAŤ finalizované doklady, e-faktúry a XML.
-- Preferovaný postup pri chybe je forward-fix, nie rollback.
--
-- Čo rollback robí:
--   1) public.esblu_company_termination_commit → telo z 20261112110000 (bez archívu),
--   2) drop public.esblu_company_termination_synthetic_purge (výnimka zanikne s ním),
--   3) drop esblu_retention.termination_execute / archive_company_documents / archive_rows
--      / purge_expired / approve_retention_period (žiadne automatické mazanie archívu po rollbacku).
--
-- Čo rollback NIKDY nerobí (ochrana archivovaných dokladov a auditu):
--   - nemaže schému esblu_retention, tabuľky retention_periods, archived_companies,
--     archived_records, purge_runs, access_log ani ich riadky; append-only / immutability
--     triggery ostávajú,
--   - ponechá operátorské čítanie: operator_list_archives, export_archive, set_legal_hold
--     (+ assert_operator, log_access, compute_retention_until) — archív sa dá stále
--     vydať úradu / účtovníkovi a každý prístup sa loguje,
--   - nemaže stĺpce company_terminations (termination_mode, operator_reference,
--     justification, archive_id, archived_counts) — sú súčasťou auditu.
-- Opätovná forward migrácia je idempotentná (create if not exists / or replace).
begin;

drop function if exists public.esblu_company_termination_synthetic_purge(uuid, uuid, boolean, text, boolean, text, text);

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

drop function if exists esblu_retention.termination_execute(uuid, uuid, boolean, text, text, text, text);
drop function if exists esblu_retention.archive_company_documents(uuid, uuid);
drop function if exists esblu_retention.archive_rows(uuid, text, text, text, text, text, text, uuid, uuid[]);
drop function if exists esblu_retention.purge_expired(text, boolean, date, integer);
drop function if exists esblu_retention.approve_retention_period(text, integer, text, text);

do $$
begin
  if to_regclass('esblu_retention.archived_records') is not null then
    raise notice 'esblu_retention: archív ponechaný (% záznamov, % firiem) — rollback nič nemaže',
      (select count(*) from esblu_retention.archived_records),
      (select count(*) from esblu_retention.archived_companies);
  end if;
end
$$;

commit;
