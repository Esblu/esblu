-- =============================================================================
-- E-Faktúra — Phase 6: bezpečný rollout (allowlist firiem, fail-closed) a
-- serverové brány worker claimov.
-- NEAPLIKOVANÉ. Do produkcie iba cez MCP apply_migration po výslovnom
-- schválení (supabase/MIGRATIONS.md §9). Nikdy `supabase db push`.
-- Závisí od 20261002100000 … 20261002140000.
--
-- Čo pridáva:
--   1) public.einvoice_rollout — allowlist (company_id, environment). Predvolene
--      PRÁZDNA = nikto nič neodošle ani nespracuje (default DENY). Zapisuje IBA
--      operátor (SQL / service_role); klient tabuľku nevidí (RLS bez politík,
--      žiadne granty pre anon/authenticated).
--   2) esblu_einvoice_rollout_allowed(company, environment) — jediná pravda,
--      používa ju trigger aj claimy. Stage 'paused' = kill switch.
--   3) BEFORE INSERT trigger na einvoice_outbound — nový pokus (prvé odoslanie
--      aj operátorský retry) pre nepovolenú firmu/prostredie zlyhá v DB,
--      nezávisle od UI a TS.
--   4) esblu_einvoice_claim_outbound (send): navyše rollout + nárok `einvoice`
--      (po strate nároku sa neodošle nič, čo ešte neodišlo; riadok s neistým
--      výsledkom smie iba zopakovať TEN ISTÝ Idempotency-Key).
--      Reconcile (iba čítanie stavu u poskytovateľa) ostáva bez zmeny.
--   5) esblu_einvoice_claim_inbound: navyše rollout (nepovolená firma = doklad
--      ostáva u poskytovateľa nepotvrdený a spracuje sa až po povolení).
--   6) einvoice_organizations: live organizácia nikdy s participant schémou
--      9915 (= Peppol TEST sieť) — ochrana proti zámene prostredí.
--   7) esblu_einvoice_my_rollout(environment) — boolean pre UI (iba vlastná
--      aktívna firma, iba s finance.view), aby UI vedelo zobraziť oznam.
--
-- Historické čítanie (RLS select, UBL/XML download, časová os) sa NEMENÍ.
--
-- ROLLBACK (bez straty business dát):
--   drop trigger esblu_einvoice_outbound_rollout_gate on public.einvoice_outbound;
--   drop function esblu_einvoice_outbound_rollout_gate(), esblu_einvoice_my_rollout(text);
--   esblu_einvoice_claim_outbound vrátiť z 20261002120000, esblu_einvoice_claim_inbound
--   z 20261002130000; alter table einvoice_organizations drop constraint
--   einvoice_organizations_participant_env_scheme;
--   drop function esblu_einvoice_rollout_allowed(uuid, text); drop table einvoice_rollout.
-- =============================================================================

begin;

-- 1) Allowlist -----------------------------------------------------------------------------
create table if not exists public.einvoice_rollout (
  company_id uuid not null references public.companies(id) on delete cascade,
  environment text not null check (environment in ('sandbox', 'live')),
  -- internal = Esblu interná firma, pilot = 1–3 pilotné firmy, beta = limited beta,
  -- ga = general availability, paused = kill switch (nič nové sa neodošle ani nespracuje).
  stage text not null check (stage in ('internal', 'pilot', 'beta', 'ga', 'paused')),
  note text check (note is null or char_length(note) <= 500),
  -- Kto zmenu urobil (operátor, ticket) — text, nie UUID používateľa appky.
  changed_by text not null check (char_length(changed_by) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, environment)
);

alter table public.einvoice_rollout enable row level security;
alter table public.einvoice_rollout force row level security;
revoke all on table public.einvoice_rollout from public, anon, authenticated;
grant select, insert, update, delete on table public.einvoice_rollout to service_role;

-- 2) Jediná pravda pre bránu --------------------------------------------------------------
create or replace function public.esblu_einvoice_rollout_allowed(p_company_id uuid, p_environment text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce((
    select r.stage <> 'paused'
    from public.einvoice_rollout r
    where r.company_id = p_company_id and r.environment = p_environment
  ), false);
$function$;
revoke all on function public.esblu_einvoice_rollout_allowed(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_rollout_allowed(uuid, text) to service_role;

-- 3) Nový pokus iba pre povolenú firmu ----------------------------------------------------
create or replace function public.esblu_einvoice_outbound_rollout_gate()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.esblu_einvoice_rollout_allowed(new.company_id, new.environment) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ROLLOUT_NOT_ENABLED';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_outbound_rollout_gate() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_outbound_rollout_gate on public.einvoice_outbound;
create trigger esblu_einvoice_outbound_rollout_gate
  before insert on public.einvoice_outbound
  for each row execute function public.esblu_einvoice_outbound_rollout_gate();

-- 4) Claim odosielania: rollout + nárok ---------------------------------------------------
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
        -- Phase 6: rollout allowlist (kill switch) — bez povolenia sa nič neodošle.
        and public.esblu_einvoice_rollout_allowed(e.company_id, e.environment)
        -- Phase 6: po strate nároku sa NEODOŠLE nič, čo ešte neodišlo. Riadok s
        -- neistým výsledkom (už mohol odísť) smie iba zopakovať TEN ISTÝ
        -- Idempotency-Key — poskytovateľ vráti uloženú odpoveď, druhé odoslanie
        -- nevznikne (docs connector: "never sends twice").
        and (
          e.send_in_flight or e.send_outcome_unknown
          or coalesce((public.esblu_resolve_entitlement(e.company_id, 'einvoice') ->> 'active')::boolean, false)
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
        -- Pád workera počas pokusu → riadok sa po lease znovu zoberie.
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

-- 5) Claim príjmu: rollout ----------------------------------------------------------------
create or replace function public.esblu_einvoice_claim_inbound(p_limit integer, p_lease_seconds integer)
returns setof public.einvoice_inbound
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
    select i.id from public.einvoice_inbound i
    where i.processing_status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending')
      and i.next_retry_at is not null and i.next_retry_at <= now()
      and (i.locked_until is null or i.locked_until < now())
      and i.retry_count < 12
      -- Phase 6: rollout allowlist — nepovolená firma: doklad ostáva u
      -- poskytovateľa nepotvrdený (bez ACK) a spracuje sa po povolení.
      and i.company_id is not null
      and public.esblu_einvoice_rollout_allowed(i.company_id, i.environment)
    order by i.next_retry_at, i.received_at
    limit v_limit
    for update skip locked
  )
  update public.einvoice_inbound i
  set locked_until = now() + v_lease,
      retry_count = i.retry_count + 1,
      -- pád workera → po lease sa riadok znovu zoberie
      next_retry_at = now() + v_lease
  from c where i.id = c.id
  returning i.*;
end;
$function$;

revoke all on function public.esblu_einvoice_claim_inbound(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_claim_inbound(integer, integer) to service_role;

-- 6) Participant schéma podľa prostredia ---------------------------------------------------
alter table public.einvoice_organizations drop constraint if exists einvoice_organizations_participant_env_scheme;
alter table public.einvoice_organizations add constraint einvoice_organizations_participant_env_scheme check (
  participant_id is null or environment = 'sandbox' or participant_id !~ '^9915:'
);

-- 7) Stav rolloutu pre UI (iba vlastná aktívna firma, iba finance.view) --------------------
create or replace function public.esblu_einvoice_my_rollout(p_environment text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_company uuid := public.esblu_my_active_company_id();
begin
  if v_company is null or not public.esblu_my_finance_view() then
    return false;
  end if;
  if p_environment is null or p_environment not in ('sandbox', 'live') then
    return false;
  end if;
  return public.esblu_einvoice_rollout_allowed(v_company, p_environment);
end;
$function$;
revoke all on function public.esblu_einvoice_my_rollout(text) from public, anon;
grant execute on function public.esblu_einvoice_my_rollout(text) to authenticated;

commit;
