-- =============================================================================
-- 20261122110000 — E-Faktúra: bezpečné ukončenie registrácie firmy u poskytovateľa
-- (eFaktura.sk POST /v1/agent/organizations/{id}/peppol/deactivate) ako
-- idempotentný job s retry a stavovým automatom.
-- Audit: docs/audits/efaktura-readiness-audit-2026-11-19.md D-G2.
-- Dokumentácia: docs/einvoice-mandate-and-safety-2026-11-19.md
-- NEAPLIKOVANÉ. Staging/produkcia iba po výslovnom schválení.
--
-- Stavový automat (vynútený triggerom):
--   requested ─claim→ in_progress ─┬→ completed            (terminálne)
--   retry_wait ─claim→ in_progress ├→ retry_wait (backoff)
--   in_progress (lease vypršal) ─claim→ in_progress
--                                  └→ failed (permanentná chyba / vyčerpané pokusy)
--   failed ─operátor requeue→ requested
-- Idempotencia: najviac jeden otvorený job na (provider, environment, provider_org_id);
-- opakovaná požiadavka vráti existujúci job. Poskytovateľ: 404 = už neexistuje → completed.
--
-- Po úspechu (completed): mandáty už boli odvolané pri požiadavke (kind = deregistration),
-- riadok einvoice_organizations sa ZMAŽE až po uložení jeho snapshotu do jobu
-- (org_snapshot: provider_org_id, participant_id, stavy, onboarding_snapshot, časy) —
-- tým sa odblokuje ukončenie firmy (esblu_company_deletion_retention_blocker /
-- esblu_company_termination_commit kontrolujú existenciu registrácie) BEZ zmeny týchto
-- funkcií. Mapovanie firma ↔ org ostáva v jobe ako dôkaz.
-- Tabuľka bez FK na firmu (prežije výmaz firmy, ARCHIVOVATEĽNÁ); DELETE / TRUNCATE nikdy.
-- Rollback: supabase/rollback/20261122110000_einvoice_deregistration_jobs_rollback.sql
-- =============================================================================

begin;

create table if not exists public.einvoice_deregistrations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  provider_org_id text not null check (char_length(provider_org_id) between 1 and 200),
  participant_id text null check (participant_id is null or participant_id ~ '^[0-9]{4}:[^\s:]{1,200}$'),
  reason text not null check (reason in ('company_termination', 'owner_request', 'operator')),
  requested_by uuid null,
  requested_by_operator text null check (requested_by_operator is null or char_length(requested_by_operator) between 1 and 120),
  state text not null default 'requested' check (state in ('requested', 'in_progress', 'retry_wait', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  max_attempts integer not null default 12 check (max_attempts between 1 and 100),
  next_attempt_at timestamptz null default now(),
  locked_until timestamptz null,
  last_error_code text null check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  provider_outcome text null check (provider_outcome is null or provider_outcome ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  provider_response_sha256 text null check (provider_response_sha256 is null or provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  requeue_count integer not null default 0 check (requeue_count between 0 and 100),
  last_requeued_by text null check (last_requeued_by is null or char_length(last_requeued_by) between 1 and 120),
  last_requeued_at timestamptz null,
  org_snapshot jsonb null check (org_snapshot is null or (jsonb_typeof(org_snapshot) = 'object' and octet_length(org_snapshot::text) <= 16384)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint einvoice_deregistrations_requester check (requested_by is not null or requested_by_operator is not null),
  constraint einvoice_deregistrations_completed_pair check ((state = 'completed') = (completed_at is not null))
);

create unique index if not exists einvoice_deregistrations_one_open
  on public.einvoice_deregistrations (provider, environment, provider_org_id)
  where state not in ('completed', 'failed');
create index if not exists einvoice_deregistrations_company_idx
  on public.einvoice_deregistrations (company_id, created_at desc);
create index if not exists einvoice_deregistrations_work_idx
  on public.einvoice_deregistrations (next_attempt_at)
  where state in ('requested', 'retry_wait', 'in_progress');

comment on table public.einvoice_deregistrations is
  'E-Faktúra: job ukončenia registrácie firmy u poskytovateľa (peppol/deactivate) so stavovým automatom a retry. '
  'Bez FK na firmu — prežije výmaz firmy, ARCHIVOVATEĽNÉ (kľúč company_id). Po completed obsahuje snapshot '
  'zmazaného mapovania einvoice_organizations. DELETE nikdy. Zápis iba service_role RPC.';

alter table public.einvoice_deregistrations enable row level security;
revoke all on table public.einvoice_deregistrations from public, anon, authenticated, service_role;
grant select on table public.einvoice_deregistrations to authenticated;
grant select on table public.einvoice_deregistrations to service_role;

drop policy if exists einvoice_deregistrations_select_finance on public.einvoice_deregistrations;
create policy einvoice_deregistrations_select_finance on public.einvoice_deregistrations
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

-- Stavový automat + nemennosť -------------------------------------------------------------
create or replace function public.esblu_einvoice_deregistrations_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_DEREGISTRATION_APPEND_ONLY';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'requested' or new.attempts <> 0 or new.completed_at is not null then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_DEREGISTRATION_INVALID_INSERT';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.provider is distinct from old.provider
     or new.environment is distinct from old.environment
     or new.provider_org_id is distinct from old.provider_org_id
     or new.participant_id is distinct from old.participant_id
     or new.reason is distinct from old.reason
     or new.requested_by is distinct from old.requested_by
     or new.requested_by_operator is distinct from old.requested_by_operator
     or new.created_at is distinct from old.created_at
     or (old.org_snapshot is not null and new.org_snapshot is distinct from old.org_snapshot) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_DEREGISTRATION_IMMUTABLE';
  end if;
  if old.state = 'completed' then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_DEREGISTRATION_TERMINAL';
  end if;
  if new.state is distinct from old.state and not (
       (old.state in ('requested', 'retry_wait') and new.state = 'in_progress')
    or (old.state = 'in_progress' and new.state in ('retry_wait', 'completed', 'failed'))
    or (old.state = 'failed' and new.state = 'requested')
  ) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_DEREGISTRATION_INVALID_TRANSITION',
      detail = old.state || ' -> ' || new.state;
  end if;
  if new.attempts < old.attempts then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_DEREGISTRATION_IMMUTABLE';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_deregistrations_guard() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_deregistrations_guard on public.einvoice_deregistrations;
create trigger esblu_einvoice_deregistrations_guard
  before insert or update or delete on public.einvoice_deregistrations
  for each row execute function public.esblu_einvoice_deregistrations_guard();

create or replace function public.esblu_einvoice_deregistrations_no_truncate()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_DEREGISTRATION_APPEND_ONLY';
end;
$function$;
revoke all on function public.esblu_einvoice_deregistrations_no_truncate() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_deregistrations_no_truncate on public.einvoice_deregistrations;
create trigger esblu_einvoice_deregistrations_no_truncate
  before truncate on public.einvoice_deregistrations
  for each statement execute function public.esblu_einvoice_deregistrations_no_truncate();

-- Požiadavka (idempotentná) -----------------------------------------------------------------
-- company_termination / owner_request: aktér musí byť aktívny OWNER firmy (companies.owner_id).
-- operator: p_operator = identifikátor operátora / ticketu (text), bez používateľa appky.
-- Odvolá mandáty firmy v prostredí (kind = deregistration) — od tejto chvíle sa nič nové neodošle.
create or replace function public.esblu_einvoice_deregistration_request(
  p_company_id uuid,
  p_environment text,
  p_reason text,
  p_actor_user_id uuid,
  p_operator text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_org public.einvoice_organizations;
  v_job public.einvoice_deregistrations;
begin
  if p_company_id is null or p_environment is null or p_environment not in ('sandbox', 'live') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_REQUEST';
  end if;
  if p_reason is null or p_reason not in ('company_termination', 'owner_request', 'operator') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_REQUEST';
  end if;
  if p_reason = 'operator' then
    if p_operator is null or char_length(btrim(p_operator)) not between 1 and 120 then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_OPERATOR_REQUIRED';
    end if;
  else
    if p_actor_user_id is null
       or not exists (select 1 from public.company_members cm
                      where cm.user_id = p_actor_user_id and cm.company_id = p_company_id
                        and cm.status = 'active' and cm.role = 'owner')
       or not exists (select 1 from public.companies c where c.id = p_company_id and c.owner_id = p_actor_user_id) then
      raise exception using errcode = '42501', message = 'ESBLU_NOT_ACTIVE_OWNER';
    end if;
  end if;

  select * into v_org from public.einvoice_organizations o
  where o.company_id = p_company_id and o.environment = p_environment
  for update;

  if v_org.id is null or v_org.provider_org_id is null then
    -- Nič nie je registrované. Ak existuje dokončený job, vráti sa (idempotencia po výmaze mapovania).
    select * into v_job from public.einvoice_deregistrations d
    where d.company_id = p_company_id and d.environment = p_environment and d.state = 'completed'
    order by d.completed_at desc limit 1;
    return jsonb_build_object('job_id', v_job.id, 'state', coalesce(v_job.state, 'not_registered'), 'created', false);
  end if;

  select * into v_job from public.einvoice_deregistrations d
  where d.provider = v_org.provider and d.environment = v_org.environment
    and d.provider_org_id = v_org.provider_org_id and d.state not in ('completed', 'failed');
  if v_job.id is null then
    insert into public.einvoice_deregistrations (
      company_id, provider, environment, provider_org_id, participant_id, reason, requested_by, requested_by_operator
    ) values (
      p_company_id, v_org.provider, v_org.environment, v_org.provider_org_id, v_org.participant_id, p_reason,
      case when p_reason = 'operator' then null else p_actor_user_id end,
      case when p_reason = 'operator' then btrim(p_operator) end
    )
    returning * into v_job;
    perform public.esblu_einvoice_mandate_revoke(
      p_company_id, p_environment, 'deregistration',
      case when p_reason = 'operator' then null else p_actor_user_id end,
      upper(p_reason)
    );
    return jsonb_build_object('job_id', v_job.id, 'state', v_job.state, 'created', true);
  end if;
  return jsonb_build_object('job_id', v_job.id, 'state', v_job.state, 'created', false);
end;
$function$;
revoke all on function public.esblu_einvoice_deregistration_request(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_deregistration_request(uuid, text, text, uuid, text) to service_role;

-- Claim (SKIP LOCKED + lease) iba pre poskytovateľa a prostredie tohto nasadenia.
-- p_job_id = iba tento job (okamžitý pokus z route).
create or replace function public.esblu_einvoice_deregistration_claim(
  p_provider text,
  p_environment text,
  p_limit integer,
  p_lease_seconds integer,
  p_job_id uuid default null
)
returns setof public.einvoice_deregistrations
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 10);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
begin
  return query
  with c as (
    select d.id from public.einvoice_deregistrations d
    where (p_job_id is null or d.id = p_job_id)
      and d.provider = p_provider and d.environment = p_environment
      and (
        (d.state in ('requested', 'retry_wait') and coalesce(d.next_attempt_at, now()) <= now())
        or (d.state = 'in_progress' and d.locked_until is not null and d.locked_until < now())
      )
      and d.attempts < d.max_attempts
    order by d.next_attempt_at nulls first, d.created_at
    limit v_limit
    for update skip locked
  )
  update public.einvoice_deregistrations d
     set state = 'in_progress',
         attempts = d.attempts + 1,
         locked_until = now() + v_lease
  from c where d.id = c.id
  returning d.*;
end;
$function$;
revoke all on function public.esblu_einvoice_deregistration_claim(text, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_deregistration_claim(text, text, integer, integer, uuid) to service_role;

-- Výsledok pokusu. p_outcome: completed | retry | failed.
create or replace function public.esblu_einvoice_deregistration_finish(
  p_job_id uuid,
  p_outcome text,
  p_error_code text,
  p_provider_outcome text,
  p_provider_response_sha256 text,
  p_retry_after_seconds integer default null
)
returns public.einvoice_deregistrations
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_job public.einvoice_deregistrations;
  v_org public.einvoice_organizations;
  v_delay integer;
begin
  select * into v_job from public.einvoice_deregistrations d where d.id = p_job_id for update;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_DEREGISTRATION_NOT_FOUND';
  end if;
  if v_job.state <> 'in_progress' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_DEREGISTRATION_NOT_IN_PROGRESS';
  end if;
  if p_outcome = 'completed' then
    select * into v_org from public.einvoice_organizations o
    where o.provider = v_job.provider and o.environment = v_job.environment and o.provider_org_id = v_job.provider_org_id
    for update;
    update public.einvoice_deregistrations d
       set state = 'completed', completed_at = now(), locked_until = null, next_attempt_at = null,
           last_error_code = null,
           provider_outcome = p_provider_outcome,
           provider_response_sha256 = p_provider_response_sha256,
           org_snapshot = case when v_org.id is null then d.org_snapshot else jsonb_build_object(
             'organization_id', v_org.id,
             'provider_org_id', v_org.provider_org_id,
             'participant_id', v_org.participant_id,
             'org_status', v_org.org_status,
             'peppol_status', v_org.peppol_status,
             'claim_status', v_org.claim_status,
             'peppol_eligible', v_org.peppol_eligible,
             'reception_status', v_org.reception_status,
             'onboarding_snapshot', v_org.onboarding_snapshot,
             'created_at', v_org.created_at,
             'updated_at', v_org.updated_at
           ) end
     where d.id = p_job_id
    returning * into v_job;
    if v_org.id is not null then
      -- Mapovanie je uložené v jobe (org_snapshot); registrácia u poskytovateľa je ukončená.
      perform public.esblu_einvoice_mandate_revoke(v_job.company_id, v_job.environment, 'deregistration', null, 'PROVIDER_DEACTIVATED');
      delete from public.einvoice_organizations o where o.id = v_org.id;
    end if;
    return v_job;
  end if;
  if p_error_code is null or p_error_code !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_REQUEST';
  end if;
  if p_outcome = 'retry' and v_job.attempts < v_job.max_attempts then
    -- Exponenciálny backoff 2^n min, strop 6 h; Retry-After poskytovateľa (≤ 1 h) má prednosť, ak je dlhší.
    v_delay := least(21600, (60 * power(2, least(v_job.attempts, 10)))::integer);
    v_delay := greatest(v_delay, least(coalesce(p_retry_after_seconds, 0), 3600));
    update public.einvoice_deregistrations d
       set state = 'retry_wait', locked_until = null, last_error_code = p_error_code,
           next_attempt_at = now() + make_interval(secs => v_delay)
     where d.id = p_job_id
    returning * into v_job;
    return v_job;
  end if;
  if p_outcome in ('retry', 'failed') then
    update public.einvoice_deregistrations d
       set state = 'failed', locked_until = null, next_attempt_at = null,
           last_error_code = case when p_outcome = 'retry' then 'EINVOICE_DEREGISTRATION_RETRY_EXHAUSTED' else p_error_code end
     where d.id = p_job_id
    returning * into v_job;
    return v_job;
  end if;
  raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_REQUEST';
end;
$function$;
revoke all on function public.esblu_einvoice_deregistration_finish(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_deregistration_finish(uuid, text, text, text, text, integer) to service_role;

-- Operátor: failed → requested (nové pokusy). Auditný text povinný.
create or replace function public.esblu_einvoice_deregistration_requeue(p_job_id uuid, p_operator text)
returns public.einvoice_deregistrations
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_job public.einvoice_deregistrations;
begin
  if p_operator is null or char_length(btrim(p_operator)) not between 1 and 120 then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_OPERATOR_REQUIRED';
  end if;
  update public.einvoice_deregistrations d
     set state = 'requested', next_attempt_at = now(), max_attempts = least(100, d.attempts + 12),
         requeue_count = d.requeue_count + 1, last_requeued_by = btrim(p_operator), last_requeued_at = now()
   where d.id = p_job_id and d.state = 'failed'
  returning * into v_job;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_DEREGISTRATION_NOT_FAILED';
  end if;
  return v_job;
end;
$function$;
revoke all on function public.esblu_einvoice_deregistration_requeue(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_deregistration_requeue(uuid, text) to service_role;

-- Stav pre route / UI (service_role): posledný job firmy v prostredí + či je firma ešte registrovaná.
create or replace function public.esblu_einvoice_deregistration_status(p_company_id uuid, p_environment text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'registered', exists (select 1 from public.einvoice_organizations o
                          where o.company_id = p_company_id and o.environment = p_environment and o.provider_org_id is not null),
    'job', (select jsonb_build_object('id', d.id, 'state', d.state, 'attempts', d.attempts, 'last_error_code', d.last_error_code,
                                      'next_attempt_at', d.next_attempt_at, 'completed_at', d.completed_at)
            from public.einvoice_deregistrations d
            where d.company_id = p_company_id and d.environment = p_environment
            order by d.created_at desc limit 1)
  );
$function$;
revoke all on function public.esblu_einvoice_deregistration_status(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_deregistration_status(uuid, text) to service_role;

commit;
