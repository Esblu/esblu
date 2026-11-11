-- Rollback 20261112100000_b2b_terms_1_2_company_acceptance.sql
-- Povolené iba ak VOP 1.2 ešte nikto (firma ani používateľ) neprijal —
-- dôkaz prijatia sa nikdy nemaže rollbackom.
do $$
begin
  if exists (select 1 from public.company_dpa_acceptances where document_type = 'terms')
     or exists (select 1 from public.user_legal_acceptances where document_type = 'terms' and version = '1.2')
     or exists (select 1 from public.legal_acceptance_evidence where scope = 'company_terms') then
    raise exception 'ROLLBACK_BLOCKED: VOP 1.2 už majú prijatia';
  end if;
end $$;

drop function if exists public.esblu_accept_company_terms(text, boolean, boolean, text);
drop function if exists public.esblu_get_my_company_terms_status();

-- esblu_accept_company_dpa: späť na J10.1 verziu (bez poradia VOP → DPA)
create or replace function public.esblu_accept_company_dpa(
  p_version text,
  p_authority_confirmed boolean default false,
  p_locale text default null
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
  v_hash text;
  v_name text;
  v_reg text;
  v_row public.company_dpa_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

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

  -- CLIA 11.11.2026: musí byť preukázateľné oprávnenie konať za Zákazníka →
  -- rola owner (server) + výslovné vyhlásenie osoby (checkbox v DPA gate).
  if coalesce(p_authority_confirmed, false) is not true then
    raise exception 'ESBLU_DPA_AUTHORITY_NOT_CONFIRMED';
  end if;

  select ld.version, ld.content_hash
  into v_current_version, v_hash
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

  select c.name into v_name from public.companies c where c.id = v_company_id;
  select coalesce(
           (select li.registration_id from public.company_legal_identities li where li.company_id = v_company_id),
           (select bp.ico from public.company_billing_profile bp where bp.company_id = v_company_id)
         )
  into v_reg;

  insert into public.company_dpa_acceptances (
    company_id, document_type, version, accepted_by, acceptance_method,
    accepted_role, authority_confirmed, document_content_hash, display_locale,
    company_name_snapshot, company_registration_id_snapshot, processor_acceptance
  )
  values (
    v_company_id, 'dpa', v_current_version, v_uid, 'company_dpa_gate',
    v_role, true, v_hash,
    case when p_locale in ('sk', 'en', 'de') then p_locale end,
    v_name, v_reg, 'esblu_electronic_offer_dpa_10_1'
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

revoke all on function public.esblu_accept_company_dpa(text, boolean, text) from public, anon;
grant execute on function public.esblu_accept_company_dpa(text, boolean, text) to authenticated;

-- archivácia: späť na J10.1 verziu
create or replace function public.esblu_archive_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_table_name = 'user_legal_acceptances' then
    insert into public.legal_acceptance_evidence
      (scope, user_id, user_email, document_type, version, accepted_at, acceptance_method, details)
    values (
      'user', old.user_id,
      (select u.email from auth.users u where u.id = old.user_id),
      old.document_type, old.version, old.accepted_at, old.acceptance_method,
      coalesce(old.metadata, '{}'::jsonb)
    );
  else
    insert into public.legal_acceptance_evidence
      (scope, user_id, user_email, company_id, company_name, company_registration_id,
       document_type, version, accepted_at, acceptance_method, accepted_role, details)
    values (
      'company_dpa', old.accepted_by,
      (select u.email from auth.users u where u.id = old.accepted_by),
      old.company_id,
      coalesce(old.company_name_snapshot, (select c.name from public.companies c where c.id = old.company_id)),
      old.company_registration_id_snapshot,
      old.document_type, old.version, old.accepted_at, old.acceptance_method, old.accepted_role,
      jsonb_strip_nulls(jsonb_build_object(
        'authority_confirmed', old.authority_confirmed,
        'document_content_hash', old.document_content_hash,
        'display_locale', old.display_locale,
        'processor_acceptance', old.processor_acceptance
      ))
    );
  end if;
  return old;
end
$function$;

revoke all on function public.esblu_archive_legal_acceptance() from public, anon, authenticated;

alter table public.legal_acceptance_evidence drop constraint if exists legal_acceptance_evidence_scope_check;
alter table public.legal_acceptance_evidence
  add constraint legal_acceptance_evidence_scope_check check (scope in ('user', 'company_dpa'));

alter table public.company_dpa_acceptances drop constraint if exists company_dpa_acceptances_terms_evidence_check;
alter table public.company_dpa_acceptances drop column if exists b2b_confirmed;
alter table public.company_dpa_acceptances drop constraint if exists company_dpa_acceptances_acceptance_method_check;
alter table public.company_dpa_acceptances
  add constraint company_dpa_acceptances_acceptance_method_check check (acceptance_method in ('company_dpa_gate'));
alter table public.company_dpa_acceptances drop constraint if exists company_dpa_acceptances_document_type_check;
alter table public.company_dpa_acceptances
  add constraint company_dpa_acceptances_document_type_check check (document_type = 'dpa');

alter table public.legal_documents disable trigger esblu_legal_documents_no_delete;
delete from public.legal_documents where type = 'terms' and version = '1.2';
alter table public.legal_documents enable trigger esblu_legal_documents_no_delete;
