-- Rollback 20261111100000_clia_j10_1_dpa_electronic_evidence.sql
-- Fail closed, ak už existujú archivované dôkazy prijatia (nesmú sa stratiť) alebo
-- J10.1 DPA záznamy s novými stĺpcami — vtedy forward-fix, nie rollback.
do $$
begin
  if exists (select 1 from public.legal_acceptance_evidence) then
    raise exception 'ROLLBACK_BLOCKED: legal_acceptance_evidence obsahuje dôkazy prijatia';
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['invoices', 'business_partners', 'einvoice_organizations'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists esblu_require_company_dpa_before_insert on public.%I', t);
    end if;
  end loop;
end $$;

drop policy if exists esblu_storage_company_dpa on storage.objects;
drop function if exists public.esblu_storage_dpa_allowed(text);
drop trigger if exists esblu_archive_legal_acceptance_before_delete on public.user_legal_acceptances;
drop trigger if exists esblu_archive_legal_acceptance_before_delete on public.company_dpa_acceptances;
drop function if exists public.esblu_archive_legal_acceptance();
drop table if exists public.legal_acceptance_evidence;

drop function if exists public.esblu_accept_company_dpa(text, boolean, text);
drop function if exists public.esblu_accept_legal_document_registration(text, text, text);
drop function if exists public.esblu_accept_legal_document_at_gate(text, text, text);

alter table public.company_dpa_acceptances drop constraint if exists company_dpa_acceptances_j10_1_evidence_check;
alter table public.company_dpa_acceptances
  drop column if exists accepted_role,
  drop column if exists authority_confirmed,
  drop column if exists document_content_hash,
  drop column if exists display_locale,
  drop column if exists company_name_snapshot,
  drop column if exists company_registration_id_snapshot,
  drop column if exists processor_acceptance;

-- predchádzajúce definície (20261012140000 / 20260815100000 / 20261110100000)
create or replace function public.esblu_accept_company_dpa(
  p_version text
)
returns public.company_dpa_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_current_version text;
  v_row public.company_dpa_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- company_id AJ rola volajúceho sa odvodzujú VÝHRADNE z jeho vlastného
  -- aktívneho company_members riadku — nikdy z parametra poslaného
  -- klientom. Rovnaký bezpečnostný vzor ako vo zvyšku aplikácie (pozri
  -- lib/company.ts, esblu_create_company_invite a pod.).
  select cm.company_id, cm.role
  into v_company_id, v_role
  from public.company_members cm
  where cm.user_id = v_uid
    and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception 'ESBLU_NO_ACTIVE_MEMBERSHIP';
  end if;

  if v_role <> 'owner' then
    raise exception 'ESBLU_NOT_ACTIVE_OWNER';
  end if;

  -- Aktuálna ÚČINNÁ DPA verzia — iba tá smie byť prijatá. p_version je
  -- vstup od klienta iba na potvrdenie ("prijímam presne TÚTO verziu,
  -- ktorú mi appka zobrazila"), nikdy nie zdroj pravdy o tom, ČO je
  -- aktuálne.
  select ld.version
  into v_current_version
  from public.legal_documents ld
  where ld.type = 'dpa'
    and ld.effective_at <= now()
  order by ld.effective_at desc, ld.created_at desc, ld.version desc
  limit 1;

  if v_current_version is null then
    raise exception 'ESBLU_NO_CURRENT_DPA';
  end if;

  if p_version <> v_current_version then
    raise exception 'ESBLU_NOT_CURRENT_DPA_VERSION';
  end if;

  insert into public.company_dpa_acceptances (
    company_id, document_type, version, accepted_by, acceptance_method
  )
  values (
    v_company_id, 'dpa', v_current_version, v_uid, 'company_dpa_gate'
  )
  on conflict (company_id, document_type, version) do nothing;

  select *
  into v_row
  from public.company_dpa_acceptances
  where company_id = v_company_id
    and document_type = 'dpa'
    and version = v_current_version;

  return v_row;
end;
$function$;
revoke all on function public.esblu_accept_company_dpa(text) from public, anon;
grant execute on function public.esblu_accept_company_dpa(text) to authenticated;
create or replace function public.esblu_accept_legal_document_registration(
  p_document_type text,
  p_version text
)
returns public.user_legal_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.user_legal_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if not exists (
    select 1
    from public.legal_documents ld
    where ld.type = p_document_type
      and ld.version = p_version
  ) then
    raise exception 'ESBLU_UNKNOWN_LEGAL_DOCUMENT_VERSION';
  end if;

  insert into public.user_legal_acceptances (
    user_id, document_type, version, acceptance_method
  )
  values (
    v_uid, p_document_type, p_version, 'registration'
  )
  on conflict (user_id, document_type, version) do nothing;

  select *
  into v_row
  from public.user_legal_acceptances
  where user_id = v_uid
    and document_type = p_document_type
    and version = p_version;

  return v_row;
end;
$function$;
create or replace function public.esblu_accept_legal_document_at_gate(
  p_document_type text,
  p_version text
)
returns public.user_legal_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.user_legal_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if not exists (
    select 1
    from public.legal_documents ld
    where ld.type = p_document_type
      and ld.version = p_version
  ) then
    raise exception 'ESBLU_UNKNOWN_LEGAL_DOCUMENT_VERSION';
  end if;

  insert into public.user_legal_acceptances (
    user_id, document_type, version, acceptance_method
  )
  values (
    v_uid, p_document_type, p_version, 'legal_gate'
  )
  on conflict (user_id, document_type, version) do nothing;

  select *
  into v_row
  from public.user_legal_acceptances
  where user_id = v_uid
    and document_type = p_document_type
    and version = p_version;

  return v_row;
end;
$function$;
revoke all on function public.esblu_accept_legal_document_registration(text, text) from public, anon;
grant execute on function public.esblu_accept_legal_document_registration(text, text) to authenticated;
revoke all on function public.esblu_accept_legal_document_at_gate(text, text) from public, anon;
grant execute on function public.esblu_accept_legal_document_at_gate(text, text) to authenticated;
create or replace function public.esblu_purge_gdpr_technical_retention(p_batch_size integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_batch integer := least(greatest(coalesce(p_batch_size, 5000), 1), 20000);
  v_push_devices integer := 0;
  v_push_subscriptions integer := 0;
  v_deliveries integer := 0;
  v_invites integer := 0;
  v_jobs integer := 0;
  v_confirmations integer := 0;
  v_contexts integer := 0;
  v_media_queue integer := 0;
begin
  delete from public.push_devices d
  where d.id in (
    select x.id from public.push_devices x
    where x.revoked_at is not null and x.revoked_at < now() - interval '30 days'
    order by x.revoked_at limit v_batch
  );
  get diagnostics v_push_devices = row_count;

  delete from public.push_subscriptions s
  where s.id in (
    select x.id from public.push_subscriptions x
    where x.revoked_at is not null and x.revoked_at < now() - interval '30 days'
    order by x.revoked_at limit v_batch
  );
  get diagnostics v_push_subscriptions = row_count;

  delete from public.notification_deliveries n
  where n.id in (
    select x.id from public.notification_deliveries x
    where x.sent_at < now() - interval '90 days'
    order by x.sent_at limit v_batch
  );
  get diagnostics v_deliveries = row_count;

  delete from public.company_invites i
  where i.id in (
    select x.id from public.company_invites x
    where x.accepted_at is null
      and (
        (x.status in ('pending', 'expired') and x.expires_at < now() - interval '30 days')
        or (x.status = 'revoked' and coalesce(x.revoked_at, x.expires_at) < now() - interval '30 days')
      )
    order by x.expires_at limit v_batch
  );
  get diagnostics v_invites = row_count;

  delete from public.account_deletion_cleanup_jobs j
  where j.id in (
    select x.id from public.account_deletion_cleanup_jobs x
    where x.storage_status = 'done' and x.auth_status = 'done'
      and coalesce(x.completed_at, x.updated_at) < now() - interval '90 days'
    order by x.created_at limit v_batch
  );
  get diagnostics v_jobs = row_count;

  delete from public.assistant_action_confirmations c
  where c.id in (
    select x.id from public.assistant_action_confirmations x
    where x.expires_at < now() - interval '1 day'
    order by x.expires_at limit v_batch
  );
  get diagnostics v_confirmations = row_count;

  delete from public.assistant_conversation_contexts c
  where c.expires_at < now() - interval '1 day';
  get diagnostics v_contexts = row_count;

  delete from public.media_deletion_queue q
  where q.id in (
    select x.id from public.media_deletion_queue x
    where x.completed_at is not null and x.completed_at < now() - interval '90 days'
    order by x.completed_at limit v_batch
  );
  get diagnostics v_media_queue = row_count;

  return jsonb_build_object(
    'push_devices', v_push_devices,
    'push_subscriptions', v_push_subscriptions,
    'notification_deliveries', v_deliveries,
    'company_invites', v_invites,
    'account_deletion_jobs', v_jobs,
    'assistant_action_confirmations', v_confirmations,
    'assistant_conversation_contexts', v_contexts,
    'media_deletion_queue', v_media_queue
  );
end
$function$;
revoke all on function public.esblu_purge_gdpr_technical_retention(integer) from public, anon, authenticated;
grant execute on function public.esblu_purge_gdpr_technical_retention(integer) to service_role;
