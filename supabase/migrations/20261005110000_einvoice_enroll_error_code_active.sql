-- =============================================================================
-- E-Faktúra — oprava esblu_einvoice_org_apply_enroll (nález staging E2E 5. 10. 2026).
--
-- Neplatný FS kód pri UŽ AKTÍVNOM príjme stav správne nezhoršil (ostáva active),
-- ale zapísal reception_error_code = VERIFICATION_TOKEN_INVALID → UI by pri aktívnom
-- príjme zobrazilo chybu. Pri zachovanom active sa kód chyby už nemení.
-- Iba CREATE OR REPLACE tej istej signatúry (granty ostávajú: iba service_role).
-- Rollback: znovu spustiť definíciu z 20261005100000_einvoice_partner_onboarding.sql (sekcia 3).
-- =============================================================================
create or replace function public.esblu_einvoice_org_apply_enroll(
  p_provider text,
  p_environment text,
  p_provider_org_id text,
  p_outcome text,
  p_participant_id text,
  p_held_by text,
  p_error_code text
)
returns table (company_id uuid, reception_status text, peppol_eligible boolean)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_org public.einvoice_organizations%rowtype;
  v_status text;
begin
  if p_outcome not in ('enrolled', 'skipped', 'send_only', 'failed') then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  select * into v_org from public.einvoice_organizations o
  where o.provider = p_provider and o.environment = p_environment
    and o.provider_org_id = p_provider_org_id and p_provider_org_id is not null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ESBLU_EINVOICE_ORGANIZATION_NOT_FOUND';
  end if;

  v_status := case p_outcome
    when 'enrolled' then 'active'
    when 'skipped' then 'pending'
    when 'send_only' then 'send_only'
    else case when v_org.reception_status = 'active' then 'active' else 'failed' end
  end;

  update public.einvoice_organizations o set
    reception_status = v_status,
    participant_id = case when p_outcome in ('enrolled', 'send_only') then coalesce(p_participant_id, o.participant_id) else o.participant_id end,
    peppol_eligible = case when p_outcome in ('enrolled', 'send_only') then (coalesce(p_participant_id, o.participant_id) is not null) else o.peppol_eligible end,
    reception_held_by = case when p_outcome = 'send_only' then left(p_held_by, 250) when p_outcome = 'enrolled' then null else o.reception_held_by end,
    reception_error_code = case
      when p_outcome = 'failed' then case when v_status = 'active' then o.reception_error_code else p_error_code end
      when p_outcome = 'send_only' then 'PARTICIPANT_HELD_ELSEWHERE'
      else null end,
    enrolled_at = case when p_outcome = 'enrolled' then coalesce(o.enrolled_at, now()) else o.enrolled_at end
  where o.id = v_org.id;

  return query select o.company_id, o.reception_status, o.peppol_eligible
    from public.einvoice_organizations o where o.id = v_org.id;
end;
$function$;
revoke all on function public.esblu_einvoice_org_apply_enroll(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.esblu_einvoice_org_apply_enroll(text, text, text, text, text, text, text)
  to service_role;
