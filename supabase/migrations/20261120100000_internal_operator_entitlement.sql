-- =============================================================================
-- Interný (prevádzkovateľský) neobmedzený tarif — jednorazový grant overenej
-- firemnej identite prevádzkovateľa Esblu.
--
-- Závislosti / poradie:
--   * nadväzuje na Stripe/billing vetvu (posledná 20261119140000_billing_live_purchase_allowlist);
--     ID 20261120100000 je jedinečné vo všetkých lokálnych vetvách a nekoliduje
--     s 20261119100000_billing_post_period_protection.
--   * nemení esblu_billing_sync_entitlements ani žiadnu billing funkciu — tie
--     menia iba riadky source = 'subscription'.
--
-- Zásady:
--   * Udeľuje IBA operátor priamo v DB (rola postgres / SQL editor). Funkcia
--     NIE JE dostupná cez Data API: execute je odobratý PUBLIC, anon,
--     authenticated aj service_role (app kľúč ho nevie zavolať).
--   * Nezakladá sa na e-maile, názve firmy ani IČO zadanom používateľom.
--     Operátor musí výslovne zadať company_id + Auth UUID vlastníka (zistené
--     po overení mimo aplikácie) a očakávaný legal_entity_key; funkcia všetko
--     krížovo overí (vlastník, členstvo owner, potvrdený e-mail, registrovo
--     overená identita, žiadna iná firma s rovnakým subjektom).
--   * Jednorazovo: najviac jeden aktívny interný grant v celej DB.
--   * Nároky = bežné company_entitlements (source 'manual', bez limitu, bez
--     valid_until), označené external_ref 'internal_operator_grant:<id>'.
--     Billing sync mení iba source 'subscription' → Stripe ich nikdy neodvolá.
--   * Budúce moduly: nový kľúč v entitlement_catalog sa automaticky pridelí
--     firme s aktívnym interným grantom (trigger).
--   * Technické nákladové limity (ai_scan_limits, rate limity endpointov,
--     eFaktúra rollout/sellable brány, billing live allowlist) sa NEMENIA.
--   * Ostatné firmy, Free/Trial/Paid pravidlá: bez zmeny.
-- =============================================================================

-- ----------------------------------------------------------------------------- 1) audit grantov
create table if not exists public.internal_operator_grants (
  id uuid primary key default gen_random_uuid(),
  -- SET NULL: zrušenie firmy nezmaže auditný záznam o udelení.
  company_id uuid null references public.companies(id) on delete set null,
  legal_entity_key text not null check (legal_entity_key ~ '^[A-Z]{2}:[A-Za-z0-9]{4,32}$'),
  owner_user_id uuid not null,
  approval_ref text not null check (length(btrim(approval_ref)) between 8 and 200),
  granted_at timestamptz not null default now(),
  granted_by text not null default session_user,
  revoked_at timestamptz null,
  revoke_reason text null,
  constraint internal_operator_grants_revoke_check
    check ((revoked_at is null and revoke_reason is null) or (revoked_at is not null and length(btrim(revoke_reason)) > 0))
);

comment on table public.internal_operator_grants is
  'Audit interného neobmedzeného tarifu prevádzkovateľa Esblu. Zápis iba cez esblu_operator_grant_internal_plan / '
  'esblu_operator_revoke_internal_plan (rola postgres). Žiadny prístup cez Data API.';

-- Najviac jeden aktívny interný grant v celej DB (jednorazovosť).
create unique index if not exists internal_operator_grants_single_active_idx
  on public.internal_operator_grants ((true))
  where revoked_at is null and company_id is not null;

alter table public.internal_operator_grants enable row level security;
revoke all on table public.internal_operator_grants from public, anon, authenticated, service_role;
grant select on table public.internal_operator_grants to service_role;

-- ----------------------------------------------------------------------------- 2) ochrana značky v company_entitlements
-- Nárok so značkou interného grantu môže existovať iba pre firmu s aktívnym
-- grantom s presne týmto id (service_role ani nikto iný ho nevie "napodobniť").
create or replace function public.esblu_internal_grant_marker_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text := new.external_ref;
  v_id uuid;
begin
  if v_ref is null or v_ref not like 'internal_operator_grant:%' then
    return new;
  end if;
  begin
    v_id := substr(v_ref, length('internal_operator_grant:') + 1)::uuid;
  exception when others then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_MARKER_INVALID';
  end;
  if new.source <> 'manual' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_MARKER_INVALID';
  end if;
  -- Odvolanie (status <> active) je povolené vždy; aktívny riadok iba s aktívnym grantom.
  if new.status = 'active' and not exists (
    select 1 from public.internal_operator_grants g
    where g.id = v_id and g.company_id = new.company_id and g.revoked_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_MARKER_FORBIDDEN';
  end if;
  return new;
end
$$;
revoke all on function public.esblu_internal_grant_marker_guard() from public, anon, authenticated, service_role;

drop trigger if exists esblu_internal_grant_marker_guard on public.company_entitlements;
create trigger esblu_internal_grant_marker_guard
  before insert or update on public.company_entitlements
  for each row execute function public.esblu_internal_grant_marker_guard();

-- ----------------------------------------------------------------------------- 3) pridelenie
create or replace function public.esblu_operator_grant_internal_plan(
  p_company_id uuid,
  p_owner_user_id uuid,
  p_legal_entity_key text,
  p_approval_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  v_company record;
  v_identity record;
  v_user record;
  v_grant_id uuid;
  v_count integer := 0;
begin
  -- Obrana do hĺbky: nikdy z kontextu Data API (JWT), iba priama DB rola.
  if v_claims_role is not null then
    raise exception using errcode = '42501', message = 'ESBLU_OPERATOR_ONLY';
  end if;
  if p_company_id is null or p_owner_user_id is null or p_legal_entity_key is null
     or p_approval_ref is null or length(btrim(p_approval_ref)) < 8 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_ARGS_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('esblu:internal_operator_grant', 0));

  if exists (select 1 from public.internal_operator_grants g where g.revoked_at is null and g.company_id is not null) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_ALREADY_ISSUED';
  end if;

  select c.id, c.owner_id into v_company from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_NOT_FOUND';
  end if;
  if v_company.owner_id is distinct from p_owner_user_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_OWNER_MISMATCH';
  end if;
  if not exists (
    select 1 from public.company_members m
    where m.company_id = p_company_id and m.user_id = p_owner_user_id and m.role = 'owner' and m.status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_OWNER_NOT_ACTIVE';
  end if;

  select u.id, u.email_confirmed_at, u.deleted_at, u.is_anonymous into v_user
  from auth.users u where u.id = p_owner_user_id;
  if not found or v_user.deleted_at is not null or coalesce(v_user.is_anonymous, false) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_USER_INVALID';
  end if;
  if v_user.email_confirmed_at is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_EMAIL_UNCONFIRMED';
  end if;

  select i.legal_entity_key, i.verification_status into v_identity
  from public.company_legal_identities i where i.company_id = p_company_id;
  if not found or v_identity.verification_status <> 'verified' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_IDENTITY_UNVERIFIED';
  end if;
  if v_identity.legal_entity_key is distinct from p_legal_entity_key then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_IDENTITY_MISMATCH';
  end if;
  -- Ochrana pred napodobnením: IČO si môže zadať ktokoľvek → žiadna iná firma
  -- nesmie niesť ten istý subjekt (operátor musí najprv vyriešiť duplicitu).
  if exists (
    select 1 from public.company_legal_identities i
    where i.legal_entity_key = p_legal_entity_key and i.company_id <> p_company_id
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_IDENTITY_AMBIGUOUS';
  end if;

  insert into public.internal_operator_grants (company_id, legal_entity_key, owner_user_id, approval_ref)
  values (p_company_id, p_legal_entity_key, p_owner_user_id, btrim(p_approval_ref))
  returning id into v_grant_id;

  insert into public.company_entitlements
    (company_id, entitlement_key, source, status, valid_from, valid_until, limit_value, limit_period, external_ref, note, created_by)
  select p_company_id, k.key, 'manual', 'active', now(), null, null, null,
         'internal_operator_grant:' || v_grant_id::text, 'internal operator plan — bez limitu, nevyprší', 'internal_operator_grant'
  from public.entitlement_catalog k;
  get diagnostics v_count = row_count;

  -- Legacy stĺpec (plan_limits 'admin' = bez limitov); klient ho nemôže meniť.
  update public.companies set plan = 'admin' where id = p_company_id;

  return jsonb_build_object('grant_id', v_grant_id, 'company_id', p_company_id, 'entitlements', v_count);
end
$$;
revoke all on function public.esblu_operator_grant_internal_plan(uuid, uuid, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- 4) odvolanie
create or replace function public.esblu_operator_revoke_internal_plan(p_company_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  v_grant record;
  v_count integer := 0;
begin
  if v_claims_role is not null then
    raise exception using errcode = '42501', message = 'ESBLU_OPERATOR_ONLY';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_REASON_REQUIRED';
  end if;
  select g.id into v_grant from public.internal_operator_grants g
  where g.company_id = p_company_id and g.revoked_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_INTERNAL_GRANT_NOT_FOUND';
  end if;

  update public.company_entitlements e set status = 'revoked'
  where e.company_id = p_company_id and e.external_ref = 'internal_operator_grant:' || v_grant.id::text and e.status <> 'revoked';
  get diagnostics v_count = row_count;

  update public.internal_operator_grants set revoked_at = now(), revoke_reason = btrim(p_reason) where id = v_grant.id;
  update public.companies set plan = 'free' where id = p_company_id and plan = 'admin';
  return v_count;
end
$$;
revoke all on function public.esblu_operator_revoke_internal_plan(uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- 5) budúce moduly
create or replace function public.esblu_internal_grant_catalog_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.company_entitlements
    (company_id, entitlement_key, source, status, valid_from, valid_until, limit_value, limit_period, external_ref, note, created_by)
  select g.company_id, new.key, 'manual', 'active', now(), null, null, null,
         'internal_operator_grant:' || g.id::text, 'internal operator plan — bez limitu, nevyprší', 'internal_operator_grant'
  from public.internal_operator_grants g
  where g.revoked_at is null and g.company_id is not null;
  return new;
end
$$;
revoke all on function public.esblu_internal_grant_catalog_sync() from public, anon, authenticated, service_role;

drop trigger if exists esblu_internal_grant_catalog_sync on public.entitlement_catalog;
create trigger esblu_internal_grant_catalog_sync
  after insert on public.entitlement_catalog
  for each row execute function public.esblu_internal_grant_catalog_sync();
