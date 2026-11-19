-- =============================================================================
-- 20261122100000 — E-Faktúra: trvalý dôkaz elektronického poverenia klienta
-- (mandát) + tvrdé pravidlo „bez účinného mandátu sa nič neodošle“.
-- Audit: docs/audits/efaktura-readiness-audit-2026-11-19.md D-M1, D-M2, D-M3, T1.
-- Dokumentácia: docs/einvoice-mandate-and-safety-2026-11-19.md
-- NEAPLIKOVANÉ. Staging/produkcia iba po výslovnom schválení (MCP apply_migration).
--
-- 1) public.einvoice_mandates — append-only dôkaz poverenia:
--      firma, prostredie, poskytovateľ, rozsah (send / receive), udeľujúci používateľ
--      (user id + SNAPSHOT mena / e-mailu / role v čase udelenia), verzia a SHA-256
--      zobrazeného textu vyhlásenia, jazyk, výslovné potvrdenie oprávnenia konať za
--      firmu, časy (granted / effective / revoked), kto a prečo odvolal, dôkazy
--      (request id, SHA-256 IP a User-Agent — pseudonymizované, nikdy surové),
--      SHA-256 odpovede poskytovateľa na enroll / overenie organizácie.
--      NIKDY overovací kód FS ani jeho hash.
--    Bez FK na companies (ako company_terminations / company_export_runs) — dôkaz
--    prežije výmaz firmy a je ARCHIVOVATEĽNÝ (pozri dokumentáciu, retenčný archív
--    rieši samostatná úloha). INSERT iba cez RPC, UPDATE iba write-once prechody
--    (effective_*, revoked_*), DELETE / TRUNCATE nikdy (ani service_role).
-- 2) esblu_einvoice_mandate_effective(company, env, scope) — jediná pravda.
-- 3) BEFORE INSERT na einvoice_outbound: nový pokus bez účinného mandátu 'send'
--    zlyhá v DB (ESBLU_EINVOICE_MANDATE_REQUIRED) nezávisle od UI / TS.
-- 4) BEFORE UPDATE na einvoice_outbound: čerstvé odoslanie (prechod do in-flight
--    bez predošlého neistého výsledku) bez mandátu zlyhá (obranná vrstva).
-- 5) esblu_einvoice_claim_outbound('send'): navyše mandát — nič sa neodošle po
--    odvolaní. Výnimka (rovnaká ako pri náraku): riadok s neistým výsledkom smie
--    zopakovať IBA TEN ISTÝ Idempotency-Key (poskytovateľ vráti uloženú odpoveď,
--    druhé odoslanie nevznikne).
-- 6) participant.deactivated (reception_status → deactivated) automaticky odvolá
--    mandáty firmy v danom prostredí (provider_event, PARTICIPANT_DEACTIVATED).
-- 7) RPC (service_role): _grant, _confirm, _revoke; klient: esblu_einvoice_my_mandate.
-- RLS: SELECT iba aktívna firma + finance.manage (owner / accountant / admin s
-- oprávnením). Employee ani iný tenant nič.
-- Rollback: supabase/rollback/20261122100000_einvoice_mandates_rollback.sql
--   (tabuľka s riadkami sa NEZMAŽE — presun do esblu_audit_archive).
-- =============================================================================

begin;

-- 1) Tabuľka ------------------------------------------------------------------------------
create table if not exists public.einvoice_mandates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  scope text[] not null,
  granted_by_user_id uuid not null,
  granted_by_name text null check (granted_by_name is null or char_length(granted_by_name) <= 200),
  granted_by_email text null check (granted_by_email is null or char_length(granted_by_email) <= 320),
  granted_by_role text not null check (granted_by_role ~ '^[a-z_]{1,40}$'),
  statement_version text not null check (statement_version ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  statement_sha256 text not null check (statement_sha256 ~ '^[0-9a-f]{64}$'),
  statement_locale text not null check (statement_locale ~ '^[a-z]{2}$'),
  authority_confirmed boolean not null check (authority_confirmed),
  grant_channel text not null check (grant_channel in ('enroll', 'regrant', 'operator_backfill')),
  provider_org_id text null check (provider_org_id is null or char_length(provider_org_id) between 1 and 200),
  participant_id text null check (participant_id is null or participant_id ~ '^[0-9]{4}:[^\s:]{1,200}$'),
  request_id text null check (request_id is null or request_id ~ '^[\x21-\x7e]{1,200}$'),
  ip_sha256 text null check (ip_sha256 is null or ip_sha256 ~ '^[0-9a-f]{64}$'),
  user_agent_sha256 text null check (user_agent_sha256 is null or user_agent_sha256 ~ '^[0-9a-f]{64}$'),
  granted_at timestamptz not null default now(),
  effective_at timestamptz null,
  effective_scope text[] null,
  provider_outcome text null check (provider_outcome is null or provider_outcome ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  provider_response_sha256 text null check (provider_response_sha256 is null or provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz null,
  revoked_by_kind text null check (revoked_by_kind is null or revoked_by_kind in ('user', 'operator', 'provider_event', 'deregistration', 'system')),
  revoked_by_user_id uuid null,
  revocation_reason_code text null check (revocation_reason_code is null or revocation_reason_code ~ '^[A-Z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  constraint einvoice_mandates_scope_check check (
    cardinality(scope) between 1 and 2 and scope <@ array['send', 'receive']::text[]
  ),
  constraint einvoice_mandates_effective_pair check ((effective_at is null) = (effective_scope is null)),
  constraint einvoice_mandates_effective_scope_check check (
    effective_scope is null or (cardinality(effective_scope) between 1 and 2 and effective_scope <@ scope)
  ),
  constraint einvoice_mandates_revoked_pair check (
    (revoked_at is null) = (revoked_by_kind is null) and (revoked_at is null) = (revocation_reason_code is null)
  )
);

create index if not exists einvoice_mandates_company_idx
  on public.einvoice_mandates (company_id, environment, granted_at desc);
create index if not exists einvoice_mandates_active_idx
  on public.einvoice_mandates (company_id, environment)
  where effective_at is not null and revoked_at is null;

comment on table public.einvoice_mandates is
  'E-Faktúra: append-only dôkaz elektronického poverenia (mandátu) klienta. Bez FK na firmu — prežije výmaz '
  'firmy, ARCHIVOVATEĽNÉ (kľúč company_id). Snapshot udeľujúceho (meno / e-mail / rola), verzia + SHA-256 textu '
  'vyhlásenia, pseudonymizované dôkazy (SHA-256), SHA-256 odpovede poskytovateľa. Nikdy overovací kód FS. '
  'INSERT iba RPC, UPDATE iba write-once effective_* / revoked_*, DELETE nikdy. Retencia = rozhodnutie prevádzkovateľa / CLIA.';

alter table public.einvoice_mandates enable row level security;
revoke all on table public.einvoice_mandates from public, anon, authenticated, service_role;
grant select on table public.einvoice_mandates to authenticated;
grant select on table public.einvoice_mandates to service_role;

drop policy if exists einvoice_mandates_select_finance_manage on public.einvoice_mandates;
create policy einvoice_mandates_select_finance_manage on public.einvoice_mandates
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

-- Append-only / write-once guard ----------------------------------------------------------
create or replace function public.esblu_einvoice_mandates_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_APPEND_ONLY';
  end if;
  if tg_op = 'INSERT' then
    if new.effective_at is not null or new.revoked_at is not null then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_INVALID_INSERT';
    end if;
    new.granted_at := now();
    new.created_at := now();
    return new;
  end if;
  -- UPDATE: identita a dôkaz udelenia nemenné.
  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.provider is distinct from old.provider
     or new.environment is distinct from old.environment
     or new.scope is distinct from old.scope
     or new.granted_by_user_id is distinct from old.granted_by_user_id
     or new.granted_by_name is distinct from old.granted_by_name
     or new.granted_by_email is distinct from old.granted_by_email
     or new.granted_by_role is distinct from old.granted_by_role
     or new.statement_version is distinct from old.statement_version
     or new.statement_sha256 is distinct from old.statement_sha256
     or new.statement_locale is distinct from old.statement_locale
     or new.authority_confirmed is distinct from old.authority_confirmed
     or new.grant_channel is distinct from old.grant_channel
     or new.provider_org_id is distinct from old.provider_org_id
     or new.request_id is distinct from old.request_id
     or new.ip_sha256 is distinct from old.ip_sha256
     or new.user_agent_sha256 is distinct from old.user_agent_sha256
     or new.granted_at is distinct from old.granted_at
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_IMMUTABLE';
  end if;
  -- participant_id: iba doplnenie (null → hodnota), nikdy zmena.
  if old.participant_id is not null and new.participant_id is distinct from old.participant_id then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_IMMUTABLE';
  end if;
  -- effective_*: write-once a iba kým nie je odvolaný.
  if old.effective_at is not null and (
       new.effective_at is distinct from old.effective_at
       or new.effective_scope is distinct from old.effective_scope
       or new.provider_outcome is distinct from old.provider_outcome
       or new.provider_response_sha256 is distinct from old.provider_response_sha256) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_IMMUTABLE';
  end if;
  if old.effective_at is null and new.effective_at is not null and old.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_MANDATE_REVOKED';
  end if;
  if old.effective_at is null and new.effective_at is null and (
       new.provider_outcome is distinct from old.provider_outcome
       or new.provider_response_sha256 is distinct from old.provider_response_sha256) and old.revoked_at is not null then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_IMMUTABLE';
  end if;
  -- revoked_*: write-once.
  if old.revoked_at is not null and (
       new.revoked_at is distinct from old.revoked_at
       or new.revoked_by_kind is distinct from old.revoked_by_kind
       or new.revoked_by_user_id is distinct from old.revoked_by_user_id
       or new.revocation_reason_code is distinct from old.revocation_reason_code) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_IMMUTABLE';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_mandates_guard() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_mandates_guard on public.einvoice_mandates;
create trigger esblu_einvoice_mandates_guard
  before insert or update or delete on public.einvoice_mandates
  for each row execute function public.esblu_einvoice_mandates_guard();

create or replace function public.esblu_einvoice_mandates_no_truncate()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_MANDATE_APPEND_ONLY';
end;
$function$;
revoke all on function public.esblu_einvoice_mandates_no_truncate() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_mandates_no_truncate on public.einvoice_mandates;
create trigger esblu_einvoice_mandates_no_truncate
  before truncate on public.einvoice_mandates
  for each statement execute function public.esblu_einvoice_mandates_no_truncate();

-- 2) Pomocné funkcie ----------------------------------------------------------------------
-- finance.manage pre (používateľ, firma) bez závislosti od session — rovnaké pravidlo ako
-- esblu_my_finance_manage (20261012140000): employee nikdy, owner/accountant áno, admin podľa oprávnenia.
create or replace function public.esblu_einvoice_member_finance_manage(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce((
    select case
             when cm.role = 'employee' then false
             when cm.role in ('owner', 'accountant') then true
             else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
           end
    from public.company_members cm
    where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active'
    limit 1
  ), false);
$function$;
revoke all on function public.esblu_einvoice_member_finance_manage(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.esblu_einvoice_mandate_effective(p_company_id uuid, p_environment text, p_scope text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1 from public.einvoice_mandates m
    where m.company_id = p_company_id
      and m.environment = p_environment
      and m.effective_at is not null and m.effective_at <= now()
      and m.revoked_at is null
      and p_scope = any (m.effective_scope)
  );
$function$;
revoke all on function public.esblu_einvoice_mandate_effective(uuid, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_mandate_effective(uuid, text, text) to service_role;

-- Klient (UI / app-level kontrola): stav mandátu VLASTNEJ aktívnej firmy, iba s finance.view.
create or replace function public.esblu_einvoice_my_mandate(p_environment text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_company uuid := public.esblu_my_active_company_id();
  v_row public.einvoice_mandates;
  v_scope text[];
begin
  if v_company is null or not coalesce(public.esblu_my_finance_view(), false) then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN';
  end if;
  select array(select distinct s from public.einvoice_mandates m, unnest(m.effective_scope) s
               where m.company_id = v_company and m.environment = p_environment
                 and m.effective_at is not null and m.effective_at <= now() and m.revoked_at is null
               order by s)
    into v_scope;
  select * into v_row from public.einvoice_mandates m
  where m.company_id = v_company and m.environment = p_environment
  order by m.granted_at desc limit 1;
  return jsonb_build_object(
    'effective_scope', to_jsonb(coalesce(v_scope, '{}'::text[])),
    'latest', case when v_row.id is null then null else jsonb_build_object(
      'granted_at', v_row.granted_at,
      'effective_at', v_row.effective_at,
      'revoked_at', v_row.revoked_at,
      'revoked_by_kind', v_row.revoked_by_kind,
      'revocation_reason_code', v_row.revocation_reason_code,
      'statement_version', v_row.statement_version,
      'scope', to_jsonb(v_row.scope)
    ) end
  );
end;
$function$;
revoke all on function public.esblu_einvoice_my_mandate(text) from public, anon;
grant execute on function public.esblu_einvoice_my_mandate(text) to authenticated, service_role;

-- 7) RPC: udelenie (service_role; route overí JWT, aktívnu firmu a finance.manage; RPC to overí znova).
create or replace function public.esblu_einvoice_mandate_grant(
  p_actor_user_id uuid,
  p_company_id uuid,
  p_environment text,
  p_scope text[],
  p_statement_version text,
  p_statement_sha256 text,
  p_statement_locale text,
  p_authority_confirmed boolean,
  p_grant_channel text,
  p_request_id text,
  p_ip_sha256 text,
  p_user_agent_sha256 text
)
returns uuid
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_org record;
  v_user record;
  v_role text;
  v_id uuid;
begin
  if p_actor_user_id is null or p_company_id is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  if p_environment is null or p_environment not in ('sandbox', 'live') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_ENVIRONMENT';
  end if;
  if not public.esblu_einvoice_member_finance_manage(p_actor_user_id, p_company_id) then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  if p_authority_confirmed is distinct from true then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_MANDATE_AUTHORITY_REQUIRED';
  end if;
  select o.provider, o.provider_org_id, o.participant_id into v_org
  from public.einvoice_organizations o
  where o.company_id = p_company_id and o.environment = p_environment;
  if v_org.provider is null or v_org.provider_org_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ORGANIZATION_NOT_READY';
  end if;
  select cm.role into v_role from public.company_members cm
  where cm.user_id = p_actor_user_id and cm.company_id = p_company_id and cm.status = 'active' limit 1;
  select u.email,
         nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), '') as name
    into v_user
  from auth.users u where u.id = p_actor_user_id;

  insert into public.einvoice_mandates (
    company_id, provider, environment, scope, granted_by_user_id, granted_by_name, granted_by_email, granted_by_role,
    statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel,
    provider_org_id, participant_id, request_id, ip_sha256, user_agent_sha256
  ) values (
    p_company_id, v_org.provider, p_environment, p_scope, p_actor_user_id,
    left(v_user.name, 200), left(v_user.email, 320), v_role,
    p_statement_version, p_statement_sha256, p_statement_locale, true, p_grant_channel,
    v_org.provider_org_id, v_org.participant_id, p_request_id, p_ip_sha256, p_user_agent_sha256
  )
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.esblu_einvoice_mandate_grant(uuid, uuid, text, text[], text, text, text, boolean, text, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_mandate_grant(uuid, uuid, text, text[], text, text, text, boolean, text, text, text, text) to service_role;

-- Potvrdenie poskytovateľom (enroll / overenie organizácie) → mandát účinný. Idempotentné.
create or replace function public.esblu_einvoice_mandate_confirm(
  p_mandate_id uuid,
  p_effective_scope text[],
  p_provider_outcome text,
  p_provider_response_sha256 text,
  p_participant_id text
)
returns public.einvoice_mandates
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_row public.einvoice_mandates;
begin
  select * into v_row from public.einvoice_mandates m where m.id = p_mandate_id for update;
  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_MANDATE_NOT_FOUND';
  end if;
  if v_row.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_MANDATE_REVOKED';
  end if;
  if v_row.effective_at is not null then
    return v_row;
  end if;
  update public.einvoice_mandates m
     set effective_at = now(),
         effective_scope = p_effective_scope,
         provider_outcome = p_provider_outcome,
         provider_response_sha256 = p_provider_response_sha256,
         participant_id = coalesce(m.participant_id,
           case when p_participant_id ~ '^[0-9]{4}:[^\s:]{1,200}$' then p_participant_id end)
   where m.id = p_mandate_id
  returning * into v_row;
  return v_row;
end;
$function$;
revoke all on function public.esblu_einvoice_mandate_confirm(uuid, text[], text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_mandate_confirm(uuid, text[], text, text, text) to service_role;

-- Odvolanie: všetky neodvolané mandáty firmy v prostredí (alebo jeden konkrétny).
-- kind = user → aktér musí mať finance.manage. Vracia počet odvolaných. Idempotentné.
create or replace function public.esblu_einvoice_mandate_revoke(
  p_company_id uuid,
  p_environment text,
  p_kind text,
  p_actor_user_id uuid,
  p_reason_code text,
  p_mandate_id uuid default null
)
returns integer
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_n integer;
begin
  if p_company_id is null or p_environment is null or p_environment not in ('sandbox', 'live') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_REQUEST';
  end if;
  if p_kind is null or p_kind not in ('user', 'operator', 'provider_event', 'deregistration', 'system') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_REQUEST';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_MANDATE_REASON_REQUIRED';
  end if;
  if p_kind = 'user' and not public.esblu_einvoice_member_finance_manage(p_actor_user_id, p_company_id) then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  update public.einvoice_mandates m
     set revoked_at = now(),
         revoked_by_kind = p_kind,
         revoked_by_user_id = p_actor_user_id,
         revocation_reason_code = p_reason_code
   where m.company_id = p_company_id
     and m.environment = p_environment
     and m.revoked_at is null
     and (p_mandate_id is null or m.id = p_mandate_id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.esblu_einvoice_mandate_revoke(uuid, text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_mandate_revoke(uuid, text, text, uuid, text, uuid) to service_role;

-- 6) participant.deactivated → odvolanie mandátov (D-M3) ---------------------------------
create or replace function public.esblu_einvoice_org_deactivated_revokes_mandates()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.reception_status = 'deactivated' and old.reception_status is distinct from 'deactivated' then
    update public.einvoice_mandates m
       set revoked_at = now(), revoked_by_kind = 'provider_event', revoked_by_user_id = null,
           revocation_reason_code = 'PARTICIPANT_DEACTIVATED'
     where m.company_id = new.company_id and m.environment = new.environment and m.revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_org_deactivated_revokes_mandates() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_org_deactivated_revokes_mandates on public.einvoice_organizations;
-- reception_status pochádza z 20261005100000 (v produkcii/stagingu existuje); podmienené kvôli
-- čiastkovým testovacím replayom bez partner onboardingu.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'einvoice_organizations' and column_name = 'reception_status') then
    create trigger esblu_einvoice_org_deactivated_revokes_mandates
      after update of reception_status on public.einvoice_organizations
      for each row execute function public.esblu_einvoice_org_deactivated_revokes_mandates();
  end if;
end
$$;

-- 3) + 4) Brána odosielania v DB ---------------------------------------------------------
create or replace function public.esblu_einvoice_outbound_mandate_gate()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if not public.esblu_einvoice_mandate_effective(new.company_id, new.environment, 'send') then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_MANDATE_REQUIRED';
    end if;
    return new;
  end if;
  -- UPDATE: čerstvé odoslanie = prechod do in-flight bez ID podania a bez predošlého
  -- neistého výsledku. Replay toho istého kľúča (neistý výsledok) ostáva povolený.
  if new.send_in_flight and not coalesce(old.send_in_flight, false)
     and not coalesce(old.send_outcome_unknown, false)
     and new.provider_submission_id is null
     and not public.esblu_einvoice_mandate_effective(new.company_id, new.environment, 'send') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_MANDATE_REQUIRED';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_outbound_mandate_gate() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_outbound_mandate_gate on public.einvoice_outbound;
create trigger esblu_einvoice_outbound_mandate_gate
  before insert or update of send_in_flight on public.einvoice_outbound
  for each row execute function public.esblu_einvoice_outbound_mandate_gate();

-- 5) Claim odosielania: rollout + nárok + MANDÁT (telo = 20261002150000 + jedna podmienka) --
create or replace function public.esblu_einvoice_claim_outbound(
  p_mode text,
  p_limit integer,
  p_lease_seconds integer,
  p_reconcile_after_seconds integer default 300
)
returns setof public.einvoice_outbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 10);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
  v_after interval := make_interval(secs => greatest(coalesce(p_reconcile_after_seconds, 300), 0));
begin
  if p_mode = 'send' then
    perform set_config('esblu.einvoice_event_source', 'job', true);
    return query
    with c as (
      select e.id from public.einvoice_outbound e
      where e.state in ('queued', 'sending')
        and e.provider_submission_id is null
        and e.next_retry_at is not null and e.next_retry_at <= now()
        and (e.locked_until is null or e.locked_until < now())
        and e.retry_count < 8
        and e.ubl_sha256 is not null and e.ubl_storage_path is not null
        and public.esblu_einvoice_rollout_allowed(e.company_id, e.environment)
        and (
          e.send_in_flight or e.send_outcome_unknown
          or coalesce((public.esblu_resolve_entitlement(e.company_id, 'einvoice') ->> 'active')::boolean, false)
        )
        -- 20261122100000: bez účinného mandátu 'send' sa nič nové neodošle (replay toho
        -- istého Idempotency-Key pri neistom výsledku ostáva povolený — nevznikne druhé odoslanie).
        and (
          e.send_in_flight or e.send_outcome_unknown
          or public.esblu_einvoice_mandate_effective(e.company_id, e.environment, 'send')
        )
      order by e.next_retry_at, e.created_at
      limit v_limit
      for update skip locked
    )
    update public.einvoice_outbound o
    set state = 'sending',
        retry_count = o.retry_count + 1,
        last_attempt_at = now(),
        locked_until = now() + v_lease,
        next_retry_at = now() + v_lease,
        send_outcome_unknown = o.send_outcome_unknown or o.send_in_flight,
        send_in_flight = true
    from c where o.id = c.id
    returning o.*;
    perform set_config('esblu.einvoice_event_source', '', true);
    return;
  end if;

  if p_mode = 'reconcile' then
    perform set_config('esblu.einvoice_event_source', 'reconcile', true);
    return query
    with c as (
      select e.id from public.einvoice_outbound e
      where (e.locked_until is null or e.locked_until < now())
        and (
          (e.provider_submission_id is not null and e.state in ('sending', 'sent', 'deferred')
            and e.updated_at <= now() - v_after)
          or (e.provider_submission_id is null and e.state = 'sending' and e.retry_count >= 8
            and e.next_retry_at is not null)
        )
      order by e.updated_at
      limit v_limit
      for update skip locked
    )
    update public.einvoice_outbound o
    set locked_until = now() + v_lease
    from c where o.id = c.id
    returning o.*;
    perform set_config('esblu.einvoice_event_source', '', true);
    return;
  end if;

  raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_CLAIM_MODE';
end;
$function$;

revoke all on function public.esblu_einvoice_claim_outbound(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_claim_outbound(text, integer, integer, integer) to service_role;

commit;
