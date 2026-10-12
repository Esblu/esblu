-- Rollback 20261012150000 (iba staging / po schválení). Vracia definície z
-- 20261012140000 (aktívna firma globálne na používateľa) a trial guard z
-- 20260928100000 (trial pri vzniku firmy).
--
-- DÁTA SA NEMAŽÚ: trial_claims a company_legal_identities ostávajú (história
-- trialov; ich zmazanie by umožnilo opakovaný trial) — iba sa prestanú
-- používať. companies.trial_policy ostáva (neškodný stĺpec).
-- Session kontext: posledná voľba každého používateľa sa prenesie do
-- user_active_company, potom sa session_active_company zruší (je to iba
-- preferencia, nie autorizácia).
-- Firmy vytvorené pod 150000 bez trialu ostanú bez trialu (rollback trial
-- nevyrába ani neresetuje).

insert into public.user_active_company (user_id, company_id, updated_at)
select distinct on (sac.user_id) sac.user_id, sac.company_id, sac.updated_at
from public.session_active_company sac
join public.company_members cm on cm.user_id = sac.user_id and cm.company_id = sac.company_id and cm.status = 'active'
order by sac.user_id, sac.updated_at desc
on conflict (user_id) do update set company_id = excluded.company_id, updated_at = excluded.updated_at;

create or replace function public.esblu_my_active_company_id()
returns uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    -- uložená voľba, iba ak členstvo stále platí (revoke / odchod → ignoruje sa)
    (select uac.company_id
       from public.user_active_company uac
      where uac.user_id = auth.uid()
        and exists (
          select 1 from public.company_members cm
          where cm.user_id = uac.user_id
            and cm.company_id = uac.company_id
            and cm.status = 'active')),
    -- inak jediné aktívne členstvo; pri 2+ bez voľby NULL (výber firmy v appke)
    (select (array_agg(cm.company_id))[1]
       from public.company_members cm
      where cm.user_id = auth.uid() and cm.status = 'active'
     having count(*) = 1)
  )
$function$;

create or replace function public.esblu_active_membership_for_user(p_user_id uuid)
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
      (select uac.company_id from public.user_active_company uac
        where uac.user_id = p_user_id and uac.company_id in (select m.company_id from mine m)),
      (select (array_agg(m.company_id))[1] from mine m having count(*) = 1)
    ) as company_id
  )
  select m.company_id, m.role, m.permissions, (select count(*)::integer from mine)
  from mine m join chosen ch on ch.company_id = m.company_id
$function$;

create or replace function public.esblu_set_my_active_company(p_company_id uuid)
returns table (company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  -- Iba z VLASTNÝCH aktívnych členstiev — cudzie company_id = odmietnuté.
  select cm.role into v_role
  from public.company_members cm
  where cm.user_id = v_uid and cm.company_id = p_company_id and cm.status = 'active';

  if v_role is null then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_A_MEMBER';
  end if;

  insert into public.user_active_company (user_id, company_id, updated_at)
  values (v_uid, p_company_id, now())
  on conflict (user_id) do update set company_id = excluded.company_id, updated_at = now();

  return query select p_company_id, v_role;
end
$function$;

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

  -- Prvá firma ide cez onboarding (esblu_ensure_my_owner_company: beta allowlist,
  -- pozvánky). Toto je iba ĎALŠIA firma už aktívneho používateľa.
  if not exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active') then
    raise exception using errcode = 'P0001', message = 'ESBLU_USE_ONBOARDING';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':create_company', 0));

  select count(*) into v_owned
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active' and cm.role = 'owner';

  -- Ochrana proti zneužitiu (nie pricing): max 10 vlastných firiem.
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

  insert into public.user_active_company (user_id, company_id, updated_at)
  values (v_uid, v_company_id, now())
  on conflict (user_id) do update set company_id = excluded.company_id, updated_at = now();

  return query select v_company_id, 'owner'::text;
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
  where m.user_id = v_uid
    and m.status = 'active'
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
  from public.settings s
  where s.user_id = v_uid;

  v_company_name := coalesce(v_company_name, 'Moja firma');

  -- Súbeh dvoch bootstrapov toho istého používateľa (bez unikátneho indexu na
  -- user_id) serializuje advisory lock; druhý nájde členstvo prvého.
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

  insert into public.user_active_company (user_id, company_id, updated_at)
  values (v_uid, v_company_id, now())
  on conflict (user_id) do update set company_id = excluded.company_id, updated_at = now();

  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()), consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;

create or replace function public.esblu_companies_trial_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    -- Klient ani RPC nemôžu trial nastaviť — vždy serverový čas vzniku firmy.
    new.trial_started_at := now();
    new.trial_ends_at := now() + interval '14 days';
    return new;
  end if;

  -- Nemenné aj pre NULL: pred-entitlement firme sa trial nedá dodatočne
  -- „vyrobiť" (ani resetovať/posunúť už bežiaci).
  if new.trial_started_at is distinct from old.trial_started_at
    or new.trial_ends_at is distinct from old.trial_ends_at
  then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_TRIAL_IMMUTABLE',
      hint = 'Trial firmy sa nedá resetovať ani posunúť. Predĺženie = grant v company_entitlements.';
  end if;

  return new;
end
$function$;

revoke all on function public.esblu_companies_trial_guard() from public, anon, authenticated;
drop trigger if exists esblu_companies_trial_guard on public.companies;
create trigger esblu_companies_trial_guard
before insert or update of trial_started_at, trial_ends_at on public.companies
for each row execute function public.esblu_companies_trial_guard();

alter table public.companies alter column trial_policy drop not null;
alter table public.companies alter column trial_policy drop default;

drop function if exists public.esblu_my_company_trial_eligibility();
drop function if exists public.esblu_operator_override_company_trial(uuid);
drop function if exists public.esblu_record_company_legal_identity(uuid, text, text, boolean, text);
drop function if exists public.esblu_try_claim_company_trial(uuid);
drop function if exists public.esblu_grant_company_trial_internal(uuid);
drop function if exists public.esblu_set_session_company_internal(uuid, uuid);
drop function if exists public.esblu_active_membership_for_user(uuid, uuid);

drop policy if exists company_legal_identities_select_owner on public.company_legal_identities;
revoke all on table public.company_legal_identities from authenticated;

drop table if exists public.session_active_company;
-- esblu_request_session_id, esblu_normalize_registration_id, esblu_legal_entity_key,
-- esblu_claim_key ostávajú (bezstavové helpery, nikto iný ich nevolá).

comment on table public.user_active_company is
  'Voľba aktívnej firmy (workspace) používateľa. Iba preferencia: platí len ak má používateľ v firme '
  'aktívne členstvo (esblu_my_active_company_id). Zapisujú IBA SECURITY DEFINER RPC.';
