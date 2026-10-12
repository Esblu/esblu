-- =============================================================================
-- Multi-company hardening (FORWARD-ONLY, 2026-10-12) — NEAPLIKOVANÉ.
--
-- 1) AKTÍVNA FIRMA PER ZARIADENIE / SESSION (nie globálne na používateľa)
--    20261012140000 ukladala voľbu do user_active_company (1 riadok na
--    používateľa) → prepnutie na mobile prepol aj desktop. Teraz:
--      - kontext = public.session_active_company, kľúč = session_id z JWT
--        (Supabase vydáva session_id do každého access tokenu; každé
--        zariadenie / prihlásenie má vlastnú session; podpísaný token → klient
--        ho nevie podvrhnúť; rovnaký vzor už používa push_devices binding),
--      - esblu_my_active_company_id() číta kontext AKTUÁLNEJ session a vždy
--        overí členstvo; bez kontextu iba jediné členstvo, inak NULL (picker),
--      - user_active_company sa na rozlíšenie NEPOUŽÍVA (ostáva iba ako
--        historická tabuľka z 20261012140000).
--    Funguje pre REST/RPC, Storage aj Realtime (všade sú JWT claims).
--    Autorizácia ostáva členstvo (RLS / SECURITY DEFINER), nie kontext.
--
-- 2) TRIAL PATRÍ PRÁVNEMU SUBJEKTU (krajina + IČO), nie workspace-u
--    - nová firma už NEDOSTANE trial automaticky pri INSERT,
--    - trial sa udelí serverom iba firme s OVERENOU identitou (register /
--      manuálne), ak daný subjekt ešte trial nemal (trial_claims),
--    - prvá firma po registrácii: provizórny trial viazaný na používateľa
--      (1× za život účtu; registrácia je chránená beta allowlistom),
--    - trial_claims NEMÁ FK na companies → história prežije zrušenie firmy,
--      ukladá iba sha256 kľúča (žiadne IČO v čitateľnej podobe),
--    - existujúce firmy: trial_policy = 'legacy', ich trial sa nemení;
--      backfill claimov (deterministický).
--
-- 3) Billing authority = owner (esblu_billing_my_access, 20261012140000) — bez
--    zmeny; owner aktívnej firmy AKTUÁLNEJ session.
--
-- Nič sa nemaže. Rollback: supabase/rollback/20261012150000_session_company_context_and_legal_entity_trial_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Session kontext aktívnej firmy
-- -----------------------------------------------------------------------------
create or replace function public.esblu_request_session_id()
returns uuid
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_raw text := nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '');
begin
  if v_raw is null or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_raw::uuid;
end
$function$;

create table if not exists public.session_active_company (
  session_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  updated_at timestamptz not null default now()
);

create index if not exists session_active_company_user_idx on public.session_active_company (user_id);

-- Odhlásenie / zrušenie session → kontext zaniká (ak auth.sessions existuje).
do $migration$
begin
  if to_regclass('auth.sessions') is not null
     and not exists (select 1 from pg_constraint where conname = 'session_active_company_session_fk') then
    alter table public.session_active_company
      add constraint session_active_company_session_fk
      foreign key (session_id) references auth.sessions (id) on delete cascade;
  end if;
end
$migration$;

comment on table public.session_active_company is
  'Aktívna firma per auth session (zariadenie / prihlásenie). Iba kontext — autorizáciu robí členstvo. '
  'Zapisuje IBA esblu_set_my_active_company / esblu_create_my_company / esblu_ensure_my_owner_company.';

alter table public.session_active_company enable row level security;
revoke all on table public.session_active_company from public, anon, authenticated;
grant select on table public.session_active_company to authenticated;
grant select, insert, update, delete on table public.session_active_company to service_role;

drop policy if exists session_active_company_select_own on public.session_active_company;
create policy session_active_company_select_own on public.session_active_company
  for select to authenticated using (user_id = (select auth.uid()));

comment on table public.user_active_company is
  'DEPRECATED (20261012150000): nepoužíva sa na rozlíšenie aktívnej firmy (globálne na používateľa). '
  'Aktívna firma = session_active_company (per session).';

create or replace function public.esblu_my_active_company_id()
returns uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    -- kontext TEJTO session, iba ak členstvo stále platí (revoke / odchod / zrušená firma → ignoruje sa)
    (select sac.company_id
       from public.session_active_company sac
      where sac.session_id = public.esblu_request_session_id()
        and sac.user_id = auth.uid()
        and exists (
          select 1 from public.company_members cm
          where cm.user_id = sac.user_id
            and cm.company_id = sac.company_id
            and cm.status = 'active')),
    -- inak jediné aktívne členstvo; pri 2+ bez platného kontextu NULL (výber firmy)
    (select (array_agg(cm.company_id))[1]
       from public.company_members cm
      where cm.user_id = auth.uid() and cm.status = 'active'
     having count(*) = 1)
  )
$function$;

comment on function public.esblu_my_active_company_id() is
  'Aktívna firma volajúceho pre AKTUÁLNU session (JWT session_id): platný session kontext, inak jediné '
  'aktívne členstvo, inak NULL. Nikdy LIMIT 1, nikdy globálna voľba používateľa.';

-- Service role: aktívna firma používateľa pre konkrétnu session (route dostane session_id z overeného tokenu).
create or replace function public.esblu_active_membership_for_user(p_user_id uuid, p_session_id uuid)
returns table (company_id uuid, role text, permissions jsonb, active_membership_count integer)
language sql
stable
security definer
set search_path to ''
as $function$
  with mine as (
    select cm.company_id, cm.role, cm.permissions
    from public.company_members cm
    where cm.user_id = p_user_id and cm.status = 'active'
  ),
  chosen as (
    select coalesce(
      (select sac.company_id from public.session_active_company sac
        where p_session_id is not null and sac.session_id = p_session_id and sac.user_id = p_user_id
          and sac.company_id in (select m.company_id from mine m)),
      (select (array_agg(m.company_id))[1] from mine m having count(*) = 1)
    ) as company_id
  )
  select m.company_id, m.role, m.permissions, (select count(*)::integer from mine)
  from mine m join chosen ch on ch.company_id = m.company_id
$function$;

-- Staršia 1-arg verzia: bez session iba jediné členstvo (žiadna globálna voľba).
create or replace function public.esblu_active_membership_for_user(p_user_id uuid)
returns table (company_id uuid, role text, permissions jsonb, active_membership_count integer)
language sql
stable
security definer
set search_path to ''
as $function$
  select * from public.esblu_active_membership_for_user(p_user_id, null::uuid)
$function$;

create or replace function public.esblu_set_my_active_company(p_company_id uuid)
returns table (company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_session uuid := public.esblu_request_session_id();
  v_role text;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  if v_session is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_SESSION_REQUIRED';
  end if;
  -- session_id musí patriť volajúcemu (obrana do hĺbky; token je podpísaný).
  if not exists (select 1 from auth.sessions s where s.id = v_session and s.user_id = v_uid) then
    raise exception using errcode = '42501', message = 'ESBLU_SESSION_MISMATCH';
  end if;

  -- Iba z VLASTNÝCH aktívnych členstiev — cudzie company_id = odmietnuté.
  select cm.role into v_role
  from public.company_members cm
  where cm.user_id = v_uid and cm.company_id = p_company_id and cm.status = 'active';

  if v_role is null then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_A_MEMBER';
  end if;

  -- IBA táto session (zariadenie). Iné zariadenia toho istého používateľa sa nemenia.
  insert into public.session_active_company (session_id, user_id, company_id, updated_at)
  values (v_session, v_uid, p_company_id, now())
  on conflict (session_id) do update
    set company_id = excluded.company_id, updated_at = now()
    where public.session_active_company.user_id = v_uid;

  if not found then
    raise exception using errcode = '42501', message = 'ESBLU_SESSION_MISMATCH';
  end if;

  return query select p_company_id, v_role;
end
$function$;

create or replace function public.esblu_set_session_company_internal(p_user_id uuid, p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_session uuid := public.esblu_request_session_id();
begin
  if v_session is null or p_user_id is null or p_company_id is null then
    return;
  end if;
  if not exists (select 1 from auth.sessions s where s.id = v_session and s.user_id = p_user_id) then
    return;
  end if;
  insert into public.session_active_company (session_id, user_id, company_id, updated_at)
  values (v_session, p_user_id, p_company_id, now())
  on conflict (session_id) do update
    set company_id = excluded.company_id, updated_at = now()
    where public.session_active_company.user_id = p_user_id;
end
$function$;

-- -----------------------------------------------------------------------------
-- 2) Právny subjekt + trial claim
-- -----------------------------------------------------------------------------
alter table public.companies add column if not exists trial_policy text;
-- Existujúce firmy: pôvodný model (trial pri vzniku firmy) — ich trial sa nemení.
update public.companies set trial_policy = 'legacy' where trial_policy is null;
alter table public.companies alter column trial_policy set default 'legal_entity';
alter table public.companies alter column trial_policy set not null;
alter table public.companies drop constraint if exists companies_trial_policy_check;
alter table public.companies add constraint companies_trial_policy_check check (trial_policy in ('legacy', 'legal_entity'));

-- Kanonický identifikátor: krajina + normalizované registračné číslo (SK/CZ: IČO 8 číslic).
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

create or replace function public.esblu_legal_entity_key(p_country text, p_registration_id text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select case when public.esblu_normalize_registration_id(p_country, p_registration_id) is null then null
    else upper(btrim(p_country)) || ':' || public.esblu_normalize_registration_id(p_country, p_registration_id) end
$function$;

-- Identita firmy (workspace → právny subjekt). Viac workspace-ov môže patriť
-- tomu istému subjektu (trial však iba raz).
create table if not exists public.company_legal_identities (
  company_id uuid primary key references public.companies (id) on delete cascade,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  registration_id text not null check (char_length(registration_id) between 2 and 32),
  legal_entity_key text not null,
  verification_status text not null default 'unverified',
  verified_source text null check (verified_source is null or verified_source ~ '^[a-z0-9_:.-]{2,60}$'),
  verified_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint company_legal_identities_status_check check (verification_status in ('unverified', 'verified', 'manual'))
);

create index if not exists company_legal_identities_entity_idx on public.company_legal_identities (legal_entity_key);

alter table public.company_legal_identities enable row level security;
revoke all on table public.company_legal_identities from public, anon, authenticated;
grant select on table public.company_legal_identities to authenticated;
grant select, insert, update, delete on table public.company_legal_identities to service_role;
drop policy if exists company_legal_identities_select_owner on public.company_legal_identities;
create policy company_legal_identities_select_owner on public.company_legal_identities
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = 'owner');

-- Trvalá história trialov: BEZ FK na companies (prežije zrušenie firmy),
-- iba hash kľúča. Retencia = CLIA REVIEW (docs/multi-company-architecture).
create table if not exists public.trial_claims (
  claim_key text primary key,
  claim_kind text not null,
  country_code text null,
  first_company_id uuid null,
  source text not null,
  trial_started_at timestamptz null,
  trial_ends_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint trial_claims_key_format check (claim_key ~ '^(entity|user|override):[0-9a-f]{64}$'),
  constraint trial_claims_kind_check check (claim_kind in ('legal_entity', 'provisional_user', 'manual_override')),
  constraint trial_claims_source_check check (source in ('trial', 'backfill', 'legacy', 'provisional_upgrade', 'manual_override'))
);

comment on table public.trial_claims is
  'Trvalá história trialov podľa právneho subjektu (entity:sha256(krajina:IČO)), provizórneho používateľa '
  '(user:sha256(user_id)) alebo manuálnej výnimky. Bez FK na companies — zrušenie workspace-u históriu nemaže. '
  'Retencia: CLIA REVIEW REQUIRED.';

alter table public.trial_claims enable row level security;
revoke all on table public.trial_claims from public, anon, authenticated;
grant select, insert, update on table public.trial_claims to service_role;

create or replace function public.esblu_claim_key(p_kind text, p_value text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select p_kind || ':' || encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
$function$;

-- Trial guard: nová firma NEDOSTANE trial pri INSERT; trial sa udelí iba
-- serverovou funkciou (GUC esblu.trial_grant v tej istej transakcii) a iba
-- raz (NULL → teraz / +14 dní). Inak nemenné ako doteraz.
create or replace function public.esblu_companies_trial_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    new.trial_started_at := null;
    new.trial_ends_at := null;
    if new.trial_policy is null or new.trial_policy <> 'legal_entity' then
      new.trial_policy := 'legal_entity';
    end if;
    return new;
  end if;

  if new.trial_policy is distinct from old.trial_policy then
    raise exception using errcode = 'P0001', message = 'ESBLU_TRIAL_POLICY_IMMUTABLE';
  end if;

  if new.trial_started_at is distinct from old.trial_started_at
    or new.trial_ends_at is distinct from old.trial_ends_at
  then
    if old.trial_started_at is null and old.trial_ends_at is null
       and new.trial_started_at = now()
       and new.trial_ends_at = now() + interval '14 days'
       and coalesce(current_setting('esblu.trial_grant', true), '') = 'on' then
      return new;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_TRIAL_IMMUTABLE',
      hint = 'Trial firmy sa nedá resetovať ani posunúť. Udeľuje ho iba server (právny subjekt). Predĺženie = grant v company_entitlements.';
  end if;

  return new;
end
$function$;

revoke all on function public.esblu_companies_trial_guard() from public, anon, authenticated;
drop trigger if exists esblu_companies_trial_guard on public.companies;
create trigger esblu_companies_trial_guard
before insert or update of trial_started_at, trial_ends_at, trial_policy on public.companies
for each row execute function public.esblu_companies_trial_guard();

create or replace function public.esblu_grant_company_trial_internal(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform set_config('esblu.trial_grant', 'on', true);
  update public.companies c
  set trial_started_at = now(), trial_ends_at = now() + interval '14 days'
  where c.id = p_company_id and c.trial_started_at is null and c.trial_ends_at is null;
  perform set_config('esblu.trial_grant', '', true);
end
$function$;

-- Server-side rozhodnutie o triale firmy (žiadny vstup z klienta o „novosti").
-- Výsledok: granted | already_has_trial | legacy_no_trial | pending_legal_identity
--           | not_eligible_previous_trial
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

-- Service role (route po overení v registri / operátor): zapíše identitu a vyhodnotí trial.
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

-- Operátor (service role): manuálna výnimka — trial bez ohľadu na históriu subjektu.
create or replace function public.esblu_operator_override_company_trial(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if exists (select 1 from public.companies c where c.id = p_company_id and c.trial_started_at is not null) then
    return 'already_has_trial';
  end if;
  insert into public.trial_claims (claim_key, claim_kind, first_company_id, source, trial_started_at, trial_ends_at)
  values (public.esblu_claim_key('override', p_company_id::text), 'manual_override', p_company_id, 'manual_override', now(), now() + interval '14 days')
  on conflict (claim_key) do nothing;
  perform public.esblu_grant_company_trial_internal(p_company_id);
  return 'manual_override';
end
$function$;

-- Owner / člen: stav trialu aktívnej firmy (iba čítanie, rozhoduje server).
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

-- Backfill (deterministický): existujúce firmy so skutočným trialom → claim.
-- Firma s IČO v profile → claim subjektu; inak provizórny claim ownera.
-- Firmy bez trialu (pred-trial / legacy) s IČO → claim 'legacy' (nový workspace
-- toho istého subjektu trial nedostane). Žiadny trial sa nemení ani nepredlžuje.
insert into public.trial_claims (claim_key, claim_kind, country_code, first_company_id, source, trial_started_at, trial_ends_at)
select distinct on (k.claim_key) k.claim_key, k.kind, k.country, k.company_id, 'backfill', k.started, k.ends
from (
  select
    case when public.esblu_legal_entity_key(coalesce(nullif(b.country_code, ''), 'SK'), b.ico) is not null
      then public.esblu_claim_key('entity', public.esblu_legal_entity_key(coalesce(nullif(b.country_code, ''), 'SK'), b.ico))
      else public.esblu_claim_key('user', c.owner_id::text) end as claim_key,
    case when public.esblu_legal_entity_key(coalesce(nullif(b.country_code, ''), 'SK'), b.ico) is not null
      then 'legal_entity' else 'provisional_user' end as kind,
    case when public.esblu_legal_entity_key(coalesce(nullif(b.country_code, ''), 'SK'), b.ico) is not null
      then upper(coalesce(nullif(b.country_code, ''), 'SK')) end as country,
    c.id as company_id, c.trial_started_at as started, c.trial_ends_at as ends, c.created_at
  from public.companies c
  left join public.company_billing_profile b on b.company_id = c.id
  where c.trial_started_at is not null
) k
order by k.claim_key, k.created_at, k.company_id
on conflict (claim_key) do nothing;

insert into public.trial_claims (claim_key, claim_kind, country_code, first_company_id, source)
select distinct on (k.claim_key) k.claim_key, 'legal_entity', k.country, k.company_id, 'legacy'
from (
  select public.esblu_claim_key('entity', public.esblu_legal_entity_key(coalesce(nullif(b.country_code, ''), 'SK'), b.ico)) as claim_key,
         upper(coalesce(nullif(b.country_code, ''), 'SK')) as country, c.id as company_id, c.created_at
  from public.companies c
  join public.company_billing_profile b on b.company_id = c.id
  where c.trial_started_at is null
    and public.esblu_legal_entity_key(coalesce(nullif(b.country_code, ''), 'SK'), b.ico) is not null
) k
order by k.claim_key, k.created_at, k.company_id
on conflict (claim_key) do nothing;

-- -----------------------------------------------------------------------------
-- 3) Vytvorenie firmy: session kontext + trial podľa subjektu
-- -----------------------------------------------------------------------------
-- Ďalšia vlastná firma: BEZ automatického trialu (čaká na overenú identitu).
create or replace function public.esblu_create_my_company(p_name text)
returns table (company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_company_id uuid;
  v_owned integer;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 200 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_COMPANY_NAME';
  end if;

  if not exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active') then
    raise exception using errcode = 'P0001', message = 'ESBLU_USE_ONBOARDING';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':create_company', 0));

  select count(*) into v_owned
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active' and cm.role = 'owner';

  if v_owned >= 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_LIMIT_REACHED';
  end if;

  if exists (
    select 1 from public.company_members cm
    join public.companies c on c.id = cm.company_id
    where cm.user_id = v_uid and cm.status = 'active' and cm.role = 'owner'
      and lower(btrim(c.name)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_DUPLICATE_COMPANY_NAME';
  end if;

  insert into public.companies (owner_id, name) values (v_uid, v_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_name);

  -- Nová firma je aktívna IBA na tomto zariadení / v tejto session.
  perform public.esblu_set_session_company_internal(v_uid, v_company_id);

  return query select v_company_id, 'owner'::text;
end
$function$;

-- Prvá firma po registrácii: provizórny trial viazaný na používateľa (1× za život
-- účtu). Neskoršia overená identita ho priradí subjektu (provisional_upgrade).
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

-- -----------------------------------------------------------------------------
-- 4) Práva
-- -----------------------------------------------------------------------------
revoke all on function public.esblu_request_session_id() from public, anon;
grant execute on function public.esblu_request_session_id() to authenticated, service_role;
revoke all on function public.esblu_active_membership_for_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.esblu_active_membership_for_user(uuid, uuid) to service_role;
revoke all on function public.esblu_set_session_company_internal(uuid, uuid) from public, anon, authenticated;
revoke all on function public.esblu_grant_company_trial_internal(uuid) from public, anon, authenticated;
revoke all on function public.esblu_try_claim_company_trial(uuid) from public, anon, authenticated;
grant execute on function public.esblu_try_claim_company_trial(uuid) to service_role;
revoke all on function public.esblu_record_company_legal_identity(uuid, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_record_company_legal_identity(uuid, text, text, boolean, text) to service_role;
revoke all on function public.esblu_operator_override_company_trial(uuid) from public, anon, authenticated;
grant execute on function public.esblu_operator_override_company_trial(uuid) to service_role;
revoke all on function public.esblu_my_company_trial_eligibility() from public, anon;
grant execute on function public.esblu_my_company_trial_eligibility() to authenticated, service_role;
grant execute on function public.esblu_normalize_registration_id(text, text) to authenticated, service_role;
grant execute on function public.esblu_legal_entity_key(text, text) to service_role;
revoke all on function public.esblu_claim_key(text, text) from public, anon, authenticated;
grant execute on function public.esblu_claim_key(text, text) to service_role;
