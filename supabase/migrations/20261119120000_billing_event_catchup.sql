-- =============================================================================
-- S12 (2026-11-19): stav doťahovania zmeškaných udalostí providera (Stripe `GET /v1/events`).
-- Iba staging; produkcia čaká na súhlas. Rollback: supabase/rollback/…_rollback.sql
--
--   billing_event_cursors — jeden riadok na (provider, prostredie): účet providera, posledná
--     spracovaná udalosť (ID + čas), lease proti súbehu, posledný úspech / chyba.
--   esblu_billing_event_cursor_claim   — lease (iba jeden beh naraz), kontrola účtu
--   esblu_billing_event_cursor_advance — posun po KAŽDEJ spracovanej udalosti (iba držiteľ lease,
--                                        nikdy dozadu)
--   esblu_billing_event_cursor_release — koniec behu (úspech / chyba, počítadlo zlyhaní)
-- Iba service_role (server). Klient (anon / authenticated) nemá prístup k tabuľke ani k RPC.
-- Neobsahuje osobné údaje ani tajomstvá (iba ID udalosti a účtu providera).
-- =============================================================================

create table if not exists public.billing_event_cursors (
  provider text not null,
  environment text not null,
  account_ref text not null,
  last_event_id text null,
  last_event_created timestamptz null,
  events_processed bigint not null default 0,
  lease_owner uuid null,
  lease_until timestamptz null,
  last_run_at timestamptz null,
  last_success_at timestamptz null,
  last_error_code text null,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_event_cursors_pkey primary key (provider, environment),
  constraint billing_event_cursors_provider_check check (provider in ('stripe')),
  constraint billing_event_cursors_environment_check check (environment in ('test')),
  constraint billing_event_cursors_error_code_check check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$')
);

comment on table public.billing_event_cursors is
  'S12: kurzor doťahovania zmeškaných udalostí providera (Stripe /v1/events). Service-only. '
  'Zmena Stripe účtu vyžaduje vedomý reset riadku operátorom (ACCOUNT_MISMATCH).';

alter table public.billing_event_cursors enable row level security;
revoke all on table public.billing_event_cursors from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.billing_event_cursors to service_role;

create or replace function public.esblu_billing_event_cursor_claim(
  p_provider text, p_environment text, p_account_ref text, p_owner uuid, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row public.billing_event_cursors;
begin
  if p_account_ref is null or p_account_ref !~ '^acct_[A-Za-z0-9]{1,64}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_CURSOR_ACCOUNT_INVALID';
  end if;
  insert into public.billing_event_cursors (provider, environment, account_ref)
  values (p_provider, p_environment, p_account_ref)
  on conflict (provider, environment) do nothing;

  select * into v_row from public.billing_event_cursors c
  where c.provider = p_provider and c.environment = p_environment
  for update;

  if v_row.account_ref <> p_account_ref then
    update public.billing_event_cursors set last_run_at = now(), last_error_code = 'ACCOUNT_MISMATCH',
      consecutive_failures = consecutive_failures + 1, updated_at = now()
    where provider = p_provider and environment = p_environment;
    return jsonb_build_object('result', 'account_mismatch');
  end if;
  if v_row.lease_until is not null and v_row.lease_until > now() and v_row.lease_owner is distinct from p_owner then
    return jsonb_build_object('result', 'busy');
  end if;

  update public.billing_event_cursors
  set lease_owner = p_owner,
      lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 240), 900))),
      last_run_at = now(), updated_at = now()
  where provider = p_provider and environment = p_environment;

  return jsonb_build_object('result', 'claimed', 'last_event_id', v_row.last_event_id,
    'last_event_created', v_row.last_event_created, 'last_success_at', v_row.last_success_at);
end
$function$;
revoke all on function public.esblu_billing_event_cursor_claim(text, text, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.esblu_billing_event_cursor_claim(text, text, text, uuid, integer) to service_role;

create or replace function public.esblu_billing_event_cursor_advance(
  p_provider text, p_environment text, p_owner uuid, p_event_id text, p_event_created timestamptz)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row public.billing_event_cursors;
begin
  select * into v_row from public.billing_event_cursors c
  where c.provider = p_provider and c.environment = p_environment
  for update;
  -- false = lease stratený (iný beh prevzal) → volajúci okamžite skončí
  if not found or v_row.lease_owner is distinct from p_owner or v_row.lease_until is null or v_row.lease_until <= now() then
    return false;
  end if;
  -- Kurzor sa nikdy neposúva dozadu: staršia udalosť (bootstrap po expirácii kurzora) sa spracuje
  -- (dedupe v billing_events), ale pozícia ostáva na najnovšej známej udalosti.
  if v_row.last_event_created is null or p_event_created >= v_row.last_event_created then
    update public.billing_event_cursors
    set last_event_id = p_event_id, last_event_created = p_event_created, updated_at = now()
    where provider = p_provider and environment = p_environment;
  end if;
  update public.billing_event_cursors set events_processed = events_processed + 1
  where provider = p_provider and environment = p_environment;
  return true;
end
$function$;
revoke all on function public.esblu_billing_event_cursor_advance(text, text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.esblu_billing_event_cursor_advance(text, text, uuid, text, timestamptz) to service_role;

create or replace function public.esblu_billing_event_cursor_release(
  p_provider text, p_environment text, p_owner uuid, p_ok boolean, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer;
  v_code text := case when p_error_code ~ '^[A-Z0-9_]{1,80}$' then p_error_code end;
begin
  update public.billing_event_cursors
  set lease_owner = null,
      lease_until = null,
      last_success_at = case when p_ok then now() else last_success_at end,
      last_error_code = v_code,
      consecutive_failures = case when p_ok then 0 else consecutive_failures + 1 end,
      updated_at = now()
  where provider = p_provider and environment = p_environment and lease_owner = p_owner;
  get diagnostics v_count = row_count;
  return v_count = 1;
end
$function$;
revoke all on function public.esblu_billing_event_cursor_release(text, text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_event_cursor_release(text, text, uuid, boolean, text) to service_role;
