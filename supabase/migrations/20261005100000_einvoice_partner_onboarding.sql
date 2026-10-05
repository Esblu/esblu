-- =============================================================================
-- E-Faktúra — API partner onboarding (eFaktura.sk Agent API, partner kľúč).
--
-- Aditívne a vratné (rollback: supabase/rollback/20261005100000_einvoice_partner_onboarding_rollback.sql).
-- NEAPLIKOVAŤ do produkcie bez schválenia — E-Faktúra nie je v produkcii.
--
--   1) einvoice_organizations: stav PRÍJMU oddelene od odosielania
--        reception_status  NULL = legacy (mäkký sandbox auto-enroll pred 2. 10. 2026)
--                          pending | active | send_only | failed | deactivated
--        reception_held_by AP host / subjekt certifikátu iného poskytovateľa (firemný údaj)
--      Overovací kód FS ani migračný kód sa NIKDY neukladajú.
--   2) esblu_einvoice_org_upsert_provisioned — mapovanie firma ↔ org po POST /organizations
--   3) esblu_einvoice_org_apply_enroll       — výsledok POST /peppol/enroll
--   4) esblu_einvoice_org_participant_event  — webhook participant.* (idempotentné,
--        odolné voči starým / preusporiadaným udalostiam)
-- Všetky RPC: SECURITY DEFINER, iba service_role, firma IBA z mapovania.
-- =============================================================================

-- 1) Stĺpce -------------------------------------------------------------------------
alter table public.einvoice_organizations
  add column if not exists reception_status text,
  add column if not exists reception_held_by text,
  add column if not exists reception_error_code text,
  add column if not exists enrolled_at timestamptz,
  add column if not exists participant_event_at timestamptz;

alter table public.einvoice_organizations drop constraint if exists einvoice_organizations_reception_status_check;
alter table public.einvoice_organizations add constraint einvoice_organizations_reception_status_check check (
  reception_status is null or reception_status in ('pending', 'active', 'send_only', 'failed', 'deactivated')
);
alter table public.einvoice_organizations drop constraint if exists einvoice_organizations_reception_held_by_check;
alter table public.einvoice_organizations add constraint einvoice_organizations_reception_held_by_check check (
  reception_held_by is null or char_length(reception_held_by) <= 250
);
alter table public.einvoice_organizations drop constraint if exists einvoice_organizations_reception_error_code_check;
alter table public.einvoice_organizations add constraint einvoice_organizations_reception_error_code_check check (
  reception_error_code is null or reception_error_code ~ '^[A-Z0-9_]{1,80}$'
);

-- 2) Mapovanie po založení organizácie u poskytovateľa ------------------------------
create or replace function public.esblu_einvoice_org_upsert_provisioned(
  p_company_id uuid,
  p_provider text,
  p_environment text,
  p_provider_org_id text,
  p_participant_id text,
  p_org_status text,
  p_peppol_status text,
  p_claim_status text,
  p_peppol_eligible boolean,
  p_snapshot jsonb
)
returns table (organization_id uuid, created boolean, reception_status text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_existing public.einvoice_organizations%rowtype;
begin
  if p_company_id is null or p_provider_org_id is null or p_environment not in ('sandbox', 'live') then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  -- Snapshot: iba firemné identifikačné údaje (bez tajomstiev, bez tokenov).
  if p_snapshot is not null and (
    jsonb_typeof(p_snapshot) <> 'object'
    or (p_snapshot - array['legal_name', 'ico', 'dic', 'ic_dph', 'street', 'city', 'postal_code', 'country_code']) <> '{}'::jsonb
  ) then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;

  select * into v_existing from public.einvoice_organizations o
  where o.company_id = p_company_id and o.environment = p_environment
  for update;

  if found then
    -- Identita je nemenná (trigger guard); iná org u poskytovateľa = chyba, nie prepis.
    if v_existing.provider <> p_provider
       or (v_existing.provider_org_id is not null and v_existing.provider_org_id <> p_provider_org_id) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_ORGANIZATION_IDENTITY_IMMUTABLE';
    end if;
    update public.einvoice_organizations o set
      provider_org_id = p_provider_org_id,
      participant_id = coalesce(p_participant_id, o.participant_id),
      org_status = left(p_org_status, 80),
      peppol_status = left(p_peppol_status, 80),
      claim_status = left(p_claim_status, 80),
      peppol_eligible = coalesce(p_peppol_eligible, o.peppol_eligible),
      onboarding_snapshot = coalesce(p_snapshot, o.onboarding_snapshot)
    where o.id = v_existing.id;
    return query select v_existing.id, false, (select o.reception_status from public.einvoice_organizations o where o.id = v_existing.id);
    return;
  end if;

  return query
  insert into public.einvoice_organizations as o (
    company_id, provider, environment, provider_org_id, participant_id,
    org_status, peppol_status, claim_status, peppol_eligible, onboarding_snapshot, reception_status
  ) values (
    p_company_id, p_provider, p_environment, p_provider_org_id, p_participant_id,
    left(p_org_status, 80), left(p_peppol_status, 80), left(p_claim_status, 80),
    coalesce(p_peppol_eligible, false), p_snapshot, 'pending'
  )
  returning o.id, true, o.reception_status;
end;
$function$;
revoke all on function public.esblu_einvoice_org_upsert_provisioned(uuid, text, text, text, text, text, text, text, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.esblu_einvoice_org_upsert_provisioned(uuid, text, text, text, text, text, text, text, boolean, jsonb)
  to service_role;

-- 3) Výsledok enroll ------------------------------------------------------------------
--   p_outcome: enrolled | skipped | send_only | failed
--   Zlyhanie (napr. neplatný FS kód) NIKDY nezhorší už aktívny príjem.
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
    -- Odosielanie: enrolled aj send_only (docs: „sending through eFaktúra is enabled").
    peppol_eligible = case when p_outcome in ('enrolled', 'send_only') then (coalesce(p_participant_id, o.participant_id) is not null) else o.peppol_eligible end,
    reception_held_by = case when p_outcome = 'send_only' then left(p_held_by, 250) when p_outcome = 'enrolled' then null else o.reception_held_by end,
    reception_error_code = case when p_outcome = 'failed' then p_error_code when p_outcome = 'send_only' then 'PARTICIPANT_HELD_ELSEWHERE' else null end,
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

-- 4) Webhook participant.* ------------------------------------------------------------
--   activated   → active (participant_id, odosielanie povolené)
--   failed      → PARTICIPANT_HELD_ELSEWHERE = send_only; iné = failed (aktívny príjem sa nezhorší)
--   deactivated → deactivated (odosielanie aj príjem vypnuté)
--   Udalosť staršia než posledná spracovaná sa ignoruje (preusporiadanie / replay).
create or replace function public.esblu_einvoice_org_participant_event(
  p_provider text,
  p_environment text,
  p_provider_org_id text,
  p_event text,
  p_participant_id text,
  p_code text,
  p_occurred_at timestamptz
)
returns table (company_id uuid, applied boolean, reception_status text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_org public.einvoice_organizations%rowtype;
  v_status text;
  v_code text := case when p_code ~ '^[A-Z0-9_]{1,80}$' then p_code else null end;
begin
  if p_event not in ('participant.activated', 'participant.failed', 'participant.deactivated') then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  select * into v_org from public.einvoice_organizations o
  where o.provider = p_provider and o.environment = p_environment
    and o.provider_org_id = p_provider_org_id and p_provider_org_id is not null
  for update;
  if not found then
    return query select null::uuid, false, null::text;
    return;
  end if;
  if p_occurred_at is not null and v_org.participant_event_at is not null and p_occurred_at < v_org.participant_event_at then
    return query select v_org.company_id, false, v_org.reception_status;
    return;
  end if;

  v_status := case
    when p_event = 'participant.activated' then 'active'
    when p_event = 'participant.deactivated' then 'deactivated'
    when v_code = 'PARTICIPANT_HELD_ELSEWHERE' then case when v_org.reception_status = 'active' then 'active' else 'send_only' end
    else case when v_org.reception_status = 'active' then 'active' else 'failed' end
  end;

  update public.einvoice_organizations o set
    reception_status = v_status,
    participant_id = case when p_event = 'participant.activated' and p_participant_id ~ '^[0-9]{4}:[^\s:]{1,200}$'
                          then p_participant_id else o.participant_id end,
    peppol_eligible = case
      when p_event = 'participant.activated' then (coalesce(case when p_participant_id ~ '^[0-9]{4}:[^\s:]{1,200}$' then p_participant_id end, o.participant_id) is not null)
      when p_event = 'participant.deactivated' then false
      else o.peppol_eligible end,
    reception_held_by = case when p_event = 'participant.activated' then null else o.reception_held_by end,
    reception_error_code = case
      when p_event = 'participant.activated' then null
      when p_event = 'participant.failed' and v_status <> 'active' then coalesce(v_code, 'PARTICIPANT_FAILED')
      else o.reception_error_code end,
    enrolled_at = case when p_event = 'participant.activated' then coalesce(o.enrolled_at, now()) else o.enrolled_at end,
    participant_event_at = coalesce(p_occurred_at, now())
  where o.id = v_org.id;

  return query select v_org.company_id, true, v_status;
end;
$function$;
revoke all on function public.esblu_einvoice_org_participant_event(text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.esblu_einvoice_org_participant_event(text, text, text, text, text, text, timestamptz)
  to service_role;
