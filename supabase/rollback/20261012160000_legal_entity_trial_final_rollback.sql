-- Rollback 20261012160000 (iba staging / po schválení). Vráti definície z
-- 20261012150000. VEDOMÉ ROZDIELY (dáta sa nemažú, trial sa nevyrába):
--   - provizórny trial viazaný na login sa NEOBNOVUJE pre existujúcich
--     používateľov (zmazané 'user:' claimy sa nerekonštruujú; po rollbacku by
--     ho dostala iba ďalšia novo registrovaná prvá firma — 150000 správanie);
--   - 'legacy_workspace' záznamy ostávajú (constraint = zjednotenie oboch modelov);
--   - stav 'failed' → 'unverified' (150000 ho nepozná); stĺpce pokusov ostávajú.
-- Poradie: 160000 → 150000 → 140000 → 130000 → 120000.

update public.company_legal_identities set verification_status = 'unverified' where verification_status = 'failed';
alter table public.company_legal_identities drop constraint if exists company_legal_identities_last_error_check;
alter table public.company_legal_identities drop constraint if exists company_legal_identities_status_check;
alter table public.company_legal_identities add constraint company_legal_identities_status_check
  check (verification_status in ('unverified', 'verified', 'manual'));

alter table public.trial_claims drop constraint if exists trial_claims_key_format;
alter table public.trial_claims drop constraint if exists trial_claims_kind_check;
alter table public.trial_claims drop constraint if exists trial_claims_source_check;
alter table public.trial_claims add constraint trial_claims_key_format
  check (claim_key ~ '^(entity|user|override|workspace):[0-9a-f]{64}$');
alter table public.trial_claims add constraint trial_claims_kind_check
  check (claim_kind in ('legal_entity', 'provisional_user', 'manual_override', 'legacy_workspace'));
alter table public.trial_claims add constraint trial_claims_source_check
  check (source in ('trial', 'backfill', 'legacy', 'provisional_upgrade', 'existing_trial', 'manual_override'));

drop function if exists public.esblu_my_company_legal_identity();
drop function if exists public.esblu_record_company_legal_identity_attempt(uuid, text, text, text);

create or replace function public.esblu_normalize_registration_id(p_country text, p_registration_id text)
returns text
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_country text := upper(btrim(coalesce(p_country, '')));
  v_raw text := btrim(coalesce(p_registration_id, ''));
  v_digits text;
begin
  if v_country !~ '^[A-Z]{2}$' or v_raw = '' then
    return null;
  end if;
  if v_country in ('SK', 'CZ') then
    if v_raw !~ '^[0-9 ]+$' then return null; end if;
    v_digits := replace(v_raw, ' ', '');
    if char_length(v_digits) < 6 or char_length(v_digits) > 8 then return null; end if;
    v_digits := lpad(v_digits, 8, '0');
    if v_digits = '00000000' then return null; end if;
    return v_digits;
  end if;
  v_digits := upper(regexp_replace(v_raw, '[\s.\-/]', '', 'g'));
  if v_digits !~ '^[A-Z0-9]{2,32}$' then return null; end if;
  return v_digits;
end
$function$;

create or replace function public.esblu_try_claim_company_trial(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company record;
  v_identity record;
  v_key text;
begin
  select c.id, c.trial_policy, c.trial_started_at into v_company
  from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_NOT_FOUND';
  end if;

  select i.* into v_identity from public.company_legal_identities i where i.company_id = p_company_id;
  if found and v_identity.verification_status in ('verified', 'manual') then
    v_key := public.esblu_claim_key('entity', v_identity.legal_entity_key);
  end if;

  if v_company.trial_started_at is not null then
    -- Firma už trial má (provizórny / legacy): zaznamená sa subjekt, aby nový
    -- workspace toho istého subjektu trial nedostal.
    if v_key is not null then
      insert into public.trial_claims (claim_key, claim_kind, country_code, first_company_id, source)
      values (v_key, 'legal_entity', v_identity.country_code, p_company_id,
              case when v_company.trial_policy = 'legacy' then 'legacy' else 'provisional_upgrade' end)
      on conflict (claim_key) do nothing;
    end if;
    return 'already_has_trial';
  end if;

  if v_company.trial_policy = 'legacy' then
    if v_key is not null then
      insert into public.trial_claims (claim_key, claim_kind, country_code, first_company_id, source)
      values (v_key, 'legal_entity', v_identity.country_code, p_company_id, 'legacy')
      on conflict (claim_key) do nothing;
    end if;
    return 'legacy_no_trial';
  end if;

  if v_key is null then
    return 'pending_legal_identity';
  end if;

  -- Súbeh dvoch workspace-ov toho istého subjektu: lock + PK → max 1 claim.
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  insert into public.trial_claims (claim_key, claim_kind, country_code, first_company_id, source, trial_started_at, trial_ends_at)
  values (v_key, 'legal_entity', v_identity.country_code, p_company_id, 'trial', now(), now() + interval '14 days')
  on conflict (claim_key) do nothing;
  if not found then
    return 'not_eligible_previous_trial';
  end if;

  perform public.esblu_grant_company_trial_internal(p_company_id);
  return 'granted';
end
$function$;

create or replace function public.esblu_record_company_legal_identity(
  p_company_id uuid,
  p_country text,
  p_registration_id text,
  p_verified boolean,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_country text := upper(btrim(coalesce(p_country, '')));
  v_reg text := public.esblu_normalize_registration_id(p_country, p_registration_id);
  v_key text := public.esblu_legal_entity_key(p_country, p_registration_id);
  v_existing record;
  v_status text;
  v_trial text;
begin
  if p_company_id is null or v_reg is null or v_key is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_REGISTRATION_ID';
  end if;

  select * into v_existing from public.company_legal_identities i where i.company_id = p_company_id;
  -- Overená identita sa nemení na inú (ochrana proti „premenovaniu subjektu" kvôli trialu).
  if found and v_existing.verification_status in ('verified', 'manual') and v_existing.legal_entity_key <> v_key then
    raise exception using errcode = 'P0001', message = 'ESBLU_LEGAL_IDENTITY_LOCKED';
  end if;

  v_status := case when coalesce(p_verified, false) then 'verified' else 'unverified' end;
  if found and v_existing.verification_status in ('verified', 'manual') then
    v_status := v_existing.verification_status;
  end if;

  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key, verification_status, verified_source, verified_at, updated_at)
  values (p_company_id, v_country, v_reg, v_key, v_status,
          case when v_status = 'verified' then nullif(btrim(coalesce(p_source, '')), '') end,
          case when v_status = 'verified' then now() end, now())
  on conflict (company_id) do update set
    country_code = excluded.country_code,
    registration_id = excluded.registration_id,
    legal_entity_key = excluded.legal_entity_key,
    verification_status = excluded.verification_status,
    verified_source = coalesce(excluded.verified_source, public.company_legal_identities.verified_source),
    verified_at = coalesce(public.company_legal_identities.verified_at, excluded.verified_at),
    updated_at = now();

  v_trial := public.esblu_try_claim_company_trial(p_company_id);
  return jsonb_build_object('company_id', p_company_id, 'verification_status', v_status, 'trial', v_trial);
end
$function$;

create or replace function public.esblu_my_company_trial_eligibility()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid := public.esblu_my_active_company_id();
  v_company record;
  v_identity record;
  v_status text;
begin
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  select c.trial_policy, c.trial_started_at, c.trial_ends_at into v_company from public.companies c where c.id = v_company_id;
  select i.verification_status, i.legal_entity_key into v_identity from public.company_legal_identities i where i.company_id = v_company_id;

  if exists (select 1 from public.trial_claims t where t.claim_key = public.esblu_claim_key('override', v_company_id::text)) then
    v_status := 'manual_override';
  elsif v_company.trial_started_at is not null then
    v_status := case when v_company.trial_ends_at > now() then 'trial_active' else 'trial_used' end;
  elsif v_company.trial_policy = 'legacy' then
    v_status := 'legacy_no_trial';
  elsif v_identity.verification_status is null or v_identity.verification_status = 'unverified' then
    v_status := 'pending_legal_identity';
  elsif exists (select 1 from public.trial_claims t where t.claim_key = public.esblu_claim_key('entity', v_identity.legal_entity_key)) then
    v_status := 'not_eligible_previous_trial';
  else
    v_status := 'eligible';
  end if;

  return jsonb_build_object('company_id', v_company_id, 'status', v_status, 'trial_ends_at', v_company.trial_ends_at,
    'identity', coalesce(v_identity.verification_status, 'missing'));
end
$function$;

create or replace function public.esblu_ensure_my_owner_company()
returns table (company_id uuid, role text, created boolean)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_email text;
  v_existing record;
  v_company_id uuid;
  v_company_name text;
  v_beta_allowed boolean;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select m.company_id, m.role into v_existing
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
  order by (m.company_id = public.esblu_my_active_company_id()) desc nulls last, m.created_at, m.company_id
  limit 1;

  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  if v_email is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;
  v_email := lower(btrim(v_email));

  if exists (
    select 1 from public.company_invites ci
    where ci.email = v_email and ci.status = 'pending' and ci.expires_at > now()
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_PENDING_INVITE_EXISTS';
  end if;

  select exists (
    select 1 from public.beta_allowlist ba
    where ba.email = v_email and ba.revoked_at is null and ba.consumed_at is null
  ) into v_beta_allowed;

  if not v_beta_allowed then
    raise exception using errcode = '42501', message = 'ESBLU_BETA_ACCESS_REQUIRED';
  end if;

  select coalesce(nullif(btrim(s.company_name), ''), 'Moja firma') into v_company_name
  from public.settings s where s.user_id = v_uid;
  v_company_name := coalesce(v_company_name, 'Moja firma');

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':create_company', 0));

  select m.company_id, m.role into v_existing
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
  order by m.created_at, m.company_id
  limit 1;
  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  insert into public.companies (owner_id, name) values (v_uid, v_company_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_company_name);

  -- Provizórny trial: iba ak tento používateľ ešte žiadny nemal.
  insert into public.trial_claims (claim_key, claim_kind, first_company_id, source, trial_started_at, trial_ends_at)
  values (public.esblu_claim_key('user', v_uid::text), 'provisional_user', v_company_id, 'trial', now(), now() + interval '14 days')
  on conflict (claim_key) do nothing;
  if found then
    perform public.esblu_grant_company_trial_internal(v_company_id);
  end if;

  perform public.esblu_set_session_company_internal(v_uid, v_company_id);

  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()), consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;
