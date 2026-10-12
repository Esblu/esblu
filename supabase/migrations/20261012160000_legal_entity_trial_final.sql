-- =============================================================================
-- Trial = OVERENÝ PRÁVNY SUBJEKT — finálne pravidlo (FORWARD-ONLY, 2026-10-12)
-- NEAPLIKOVANÉ (staging ani produkcia).
--
-- Mení 20261012150000 (historická migrácia sa nemení):
--   1) ODSTRÁNENÝ provizórny trial viazaný na login (esblu_ensure_my_owner_company
--      už trial neudeľuje; claimy 'provisional_user' / kľúče 'user:' zrušené).
--      Trial nepatrí používateľovi ani workspace-u — iba overenému subjektu
--      (krajina + normalizované registračné číslo; SK = IČO).
--   2) Firma bez IČO: žiadny trial, žiadny trial nárok (stav pending_legal_identity).
--   3) Stav overenia 'failed' (register: neexistuje / zaniknutý) + evidencia
--      pokusov; register nedostupný = 'unverified' (opakovateľné). Pokus NIKDY
--      neudelí trial ani nevyrobí overenú identitu.
--   4) esblu_my_company_legal_identity(): údaje pre Nastavenia firmy
--      (owner upravuje, admin/accountant iba čítajú, employee bez prístupu).
--   5) Robustnejšia normalizácia (medzery vrátane NBSP, oddeľovače, prefix „IČO:").
--
-- Existujúce (legacy) trialy: bez zmeny, bez resetu, bez predĺženia; trial
-- história každej takej firmy = 'legacy_workspace' záznam (audit, nie pravidlo).
-- Rollback: supabase/rollback/20261012160000_legal_entity_trial_final_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Normalizácia (nadmnožina 20261012150000 — rovnaký výsledok pre platné vstupy)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_normalize_registration_id(p_country text, p_registration_id text)
returns text
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_country text := upper(btrim(coalesce(p_country, '')));
  v_raw text := coalesce(p_registration_id, '');
  v_digits text;
begin
  if v_country !~ '^[A-Z]{2}$' then
    return null;
  end if;
  -- všetky medzery vrátane NBSP (U+00A0) a úzkej NBSP (U+202F)
  v_raw := regexp_replace(v_raw, '[[:space:]' || chr(160) || chr(8239) || ']', '', 'g');
  if v_raw = '' then
    return null;
  end if;
  if v_country in ('SK', 'CZ') then
    -- úvodný popis „IČO:", „ICO", „IČ:", „IC." (iba SK/CZ)
    v_raw := regexp_replace(v_raw, '^(IČO|ICO|IČ|IC)[:.]?', '', 'i');
    v_digits := regexp_replace(v_raw, '[-./]', '', 'g');
    if v_digits !~ '^[0-9]{6,8}$' then return null; end if;
    v_digits := lpad(v_digits, 8, '0');
    if v_digits = '00000000' then return null; end if;
    return v_digits;
  end if;
  v_digits := upper(regexp_replace(v_raw, '[-./]', '', 'g'));
  if v_digits !~ '^[A-Z0-9]{2,32}$' then return null; end if;
  return v_digits;
end
$function$;

-- -----------------------------------------------------------------------------
-- 2) Trial história: bez provizórneho modelu
-- -----------------------------------------------------------------------------
alter table public.trial_claims drop constraint if exists trial_claims_key_format;
alter table public.trial_claims drop constraint if exists trial_claims_kind_check;
alter table public.trial_claims drop constraint if exists trial_claims_source_check;

-- Každá firma, ktorá trial reálne mala (legacy aj 150000), má audit záznam
-- workspace-u. Iba evidencia — o nároku rozhoduje výhradne 'entity:' kľúč.
insert into public.trial_claims (claim_key, claim_kind, first_company_id, source, trial_started_at, trial_ends_at)
select public.esblu_claim_key('workspace', c.id::text), 'legacy_workspace', c.id, 'backfill', c.trial_started_at, c.trial_ends_at
from public.companies c
where c.trial_started_at is not null
on conflict (claim_key) do nothing;

-- Provizórne claimy viazané na login sa ruší (nič ich nečíta; trial firmy,
-- ktorá ho dostala, ostáva v companies.trial_* + legacy_workspace zázname).
delete from public.trial_claims where claim_kind = 'provisional_user' or claim_key like 'user:%';
update public.trial_claims set source = 'existing_trial' where source = 'provisional_upgrade';

alter table public.trial_claims add constraint trial_claims_key_format
  check (claim_key ~ '^(entity|workspace|override):[0-9a-f]{64}$');
alter table public.trial_claims add constraint trial_claims_kind_check
  check (claim_kind in ('legal_entity', 'legacy_workspace', 'manual_override'));
alter table public.trial_claims add constraint trial_claims_source_check
  check (source in ('trial', 'backfill', 'legacy', 'existing_trial', 'manual_override'));

comment on table public.trial_claims is
  'Trvalá história trialov. Nárok rozhoduje IBA entity:sha256(krajina:reg.č.) (overený právny subjekt). '
  'workspace:sha256(company_id) = audit trialu existujúcej firmy, override: = operátor. Bez FK na companies '
  '(zrušenie workspace-u históriu nemaže). Žiadne kľúče podľa používateľa. Retencia: CLIA REVIEW REQUIRED.';

-- -----------------------------------------------------------------------------
-- 3) Identita: stav 'failed' + pokusy
-- -----------------------------------------------------------------------------
alter table public.company_legal_identities add column if not exists last_attempt_at timestamptz null;
alter table public.company_legal_identities add column if not exists last_error text null;
alter table public.company_legal_identities add column if not exists attempt_count integer not null default 0;
alter table public.company_legal_identities drop constraint if exists company_legal_identities_status_check;
alter table public.company_legal_identities add constraint company_legal_identities_status_check
  check (verification_status in ('unverified', 'verified', 'manual', 'failed'));
alter table public.company_legal_identities drop constraint if exists company_legal_identities_last_error_check;
alter table public.company_legal_identities add constraint company_legal_identities_last_error_check
  check (last_error is null or last_error in ('not_found', 'terminated', 'unavailable'));

-- -----------------------------------------------------------------------------
-- 4) Rozhodnutie o triale (server)
-- -----------------------------------------------------------------------------
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
    -- Firma už trial mala (legacy / skorší grant): subjekt sa zaznamená, aby
    -- iný workspace toho istého subjektu trial nedostal. Trial sa nemení.
    if v_key is not null then
      insert into public.trial_claims (claim_key, claim_kind, country_code, first_company_id, source)
      values (v_key, 'legal_entity', v_identity.country_code, p_company_id,
              case when v_company.trial_policy = 'legacy' then 'legacy' else 'existing_trial' end)
      on conflict (claim_key) do nothing;
    end if;
    return 'already_has_trial';
  end if;

  if v_company.trial_policy = 'legacy' then
    -- Pred-trial (beta) firma: model sa nemení (beta granty), subjekt sa zaznamená.
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

  -- Súbeh: lock na kľúč subjektu + PK trial_claims → max 1 claim a 1 aktivácia.
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

-- Service role (route po ÚSPEŠNOM overení v registri / operátor).
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
  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_NOT_FOUND';
  end if;

  -- Súbeh dvoch overení tej istej firmy: serializácia na riadku identity.
  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':legal_identity', 0));

  select * into v_existing from public.company_legal_identities i where i.company_id = p_company_id;
  -- Overená identita je zamknutá: iné IČO = samostatný právny / biznis postup, nie prepis.
  if found and v_existing.verification_status in ('verified', 'manual') and v_existing.legal_entity_key <> v_key then
    raise exception using errcode = 'P0001', message = 'ESBLU_LEGAL_IDENTITY_LOCKED';
  end if;

  v_status := case when coalesce(p_verified, false) then 'verified' else 'unverified' end;
  if found and v_existing.verification_status in ('verified', 'manual') then
    v_status := v_existing.verification_status;
  end if;

  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key, verification_status,
    verified_source, verified_at, updated_at, last_attempt_at, last_error, attempt_count)
  values (p_company_id, v_country, v_reg, v_key, v_status,
          case when v_status = 'verified' then nullif(btrim(coalesce(p_source, '')), '') end,
          case when v_status = 'verified' then now() end, now(), now(), null, 1)
  on conflict (company_id) do update set
    country_code = excluded.country_code,
    registration_id = excluded.registration_id,
    legal_entity_key = excluded.legal_entity_key,
    verification_status = excluded.verification_status,
    verified_source = coalesce(public.company_legal_identities.verified_source, excluded.verified_source),
    verified_at = coalesce(public.company_legal_identities.verified_at, excluded.verified_at),
    updated_at = now(),
    last_attempt_at = now(),
    last_error = null,
    attempt_count = public.company_legal_identities.attempt_count + 1;

  v_trial := public.esblu_try_claim_company_trial(p_company_id);
  return jsonb_build_object('company_id', p_company_id, 'verification_status', v_status, 'trial', v_trial);
end
$function$;

-- Service role: NEÚSPEŠNÝ pokus o overenie. Nikdy neudelí trial, nikdy nevyrobí
-- overenú identitu, overenú identitu nezmení.
--   unavailable → 'unverified' (opakovateľné), not_found / terminated → 'failed'
create or replace function public.esblu_record_company_legal_identity_attempt(
  p_company_id uuid,
  p_country text,
  p_registration_id text,
  p_outcome text
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
begin
  if p_outcome is null or p_outcome not in ('not_found', 'terminated', 'unavailable') then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ATTEMPT_OUTCOME';
  end if;
  if p_company_id is null or v_reg is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_REGISTRATION_ID';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':legal_identity', 0));

  select * into v_existing from public.company_legal_identities i where i.company_id = p_company_id;
  if found and v_existing.verification_status in ('verified', 'manual') then
    -- overená identita sa neúspešným pokusom nemení
    return jsonb_build_object('company_id', p_company_id, 'verification_status', v_existing.verification_status, 'trial', 'unchanged');
  end if;

  v_status := case when p_outcome = 'unavailable' then 'unverified' else 'failed' end;

  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key, verification_status,
    updated_at, last_attempt_at, last_error, attempt_count)
  values (p_company_id, v_country, v_reg, v_key, v_status, now(), now(), p_outcome, 1)
  on conflict (company_id) do update set
    country_code = excluded.country_code,
    registration_id = excluded.registration_id,
    legal_entity_key = excluded.legal_entity_key,
    verification_status = excluded.verification_status,
    updated_at = now(),
    last_attempt_at = now(),
    last_error = excluded.last_error,
    attempt_count = public.company_legal_identities.attempt_count + 1;

  return jsonb_build_object('company_id', p_company_id, 'verification_status', v_status, 'trial', 'pending_legal_identity');
end
$function$;

-- Stav trialu aktívnej firmy (failed / unverified = pending).
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
  elsif v_identity.verification_status is null or v_identity.verification_status not in ('verified', 'manual') then
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

-- Nastavenia firmy → „Identita firmy". Owner upravuje (can_edit), admin /
-- accountant iba čítajú, employee bez prístupu. Firma = aktívna firma TEJTO session.
create or replace function public.esblu_my_company_legal_identity()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid := public.esblu_my_active_company_id();
  v_role text := public.esblu_my_active_role();
  v_name text;
  v_identity record;
  v_trial jsonb;
begin
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if v_role is null or v_role not in ('owner', 'admin', 'accountant') then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN';
  end if;

  select c.name into v_name from public.companies c where c.id = v_company_id;
  select i.country_code, i.registration_id, i.verification_status, i.verified_at, i.last_error, i.last_attempt_at
    into v_identity
  from public.company_legal_identities i where i.company_id = v_company_id;
  v_trial := public.esblu_my_company_trial_eligibility();

  return jsonb_build_object(
    'company_id', v_company_id,
    'company_name', v_name,
    'country_code', v_identity.country_code,
    'registration_id', v_identity.registration_id,
    'verification_status', coalesce(v_identity.verification_status, 'missing'),
    'verified_at', v_identity.verified_at,
    'last_error', v_identity.last_error,
    'last_attempt_at', v_identity.last_attempt_at,
    'trial_status', v_trial ->> 'status',
    'trial_ends_at', v_trial -> 'trial_ends_at',
    'can_edit', v_role = 'owner'
  );
end
$function$;

-- -----------------------------------------------------------------------------
-- 5) Prvá firma po registrácii: BEZ trialu (žiadny trial viazaný na login)
-- -----------------------------------------------------------------------------
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

  -- Beta allowlist je IBA brána registrácie (nie trial). Beta prístup k
  -- funkciám = explicitný manuálny grant v company_entitlements (operátor).
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

  -- Trial NEVZNIKÁ (trigger ho pri INSERT nikdy nenastaví) — iba po overení IČO.
  insert into public.companies (owner_id, name) values (v_uid, v_company_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_company_name);

  perform public.esblu_set_session_company_internal(v_uid, v_company_id);

  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()), consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6) Práva
-- -----------------------------------------------------------------------------
revoke all on function public.esblu_record_company_legal_identity_attempt(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_record_company_legal_identity_attempt(uuid, text, text, text) to service_role;
revoke all on function public.esblu_my_company_legal_identity() from public, anon;
grant execute on function public.esblu_my_company_legal_identity() to authenticated, service_role;
revoke all on function public.esblu_try_claim_company_trial(uuid) from public, anon, authenticated;
revoke all on function public.esblu_record_company_legal_identity(uuid, text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.esblu_my_company_trial_eligibility() from public, anon;
grant execute on function public.esblu_my_company_trial_eligibility() to authenticated, service_role;
