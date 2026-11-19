-- =============================================================================
-- P4 (2026-11-23): automatické opakovanie zlyhaných billing udalostí (backoff, max. pokusy, dead-letter).
-- Iba aditívne; nič sa nemaže. Rollback: supabase/rollback/20261123100000_billing_event_retry_rollback.sql
--
-- Problém (audit 2026-11-19 § 2.3): udalosť, ktorá zlyhala vo webhooku (napr. Stripe API dočasne
-- nedostupné), zachránili iba opakovania Stripe (3 dni) a doťahovanie — a doťahovanie ju pre iný hash
-- tela považovalo za duplicitu. Oprava hashu je v kóde (doťahovanie/retry posiela p_payload_sha256 = null).
-- Táto migrácia pridáva AKTÍVNE opakovanie:
--
--   billing_events.next_retry_at  — kedy sa smie udalosť znova spracovať (backoff / lease),
--   billing_events.dead_letter    — vyčerpané pokusy alebo trvalá chyba → rieši operátor (ops alert),
--   billing_events.dead_lettered_at — kedy (ostáva aj po neskoršom úspechu = auditná stopa).
--
-- Trigger nastavuje plán opakovania pri KAŽDEJ zmene stavu (webhook, doťahovanie, apply_event,
-- close_event — bez zmeny existujúcich funkcií):
--   received → lease 10 min (rozpracovaná / spadnutá funkcia sa po 10 min zopakuje),
--   failed + opakovateľná chyba → backoff 5, 10, 20, 40, 80, 160, 320, 360 min (max 6 h),
--   failed + trvalá chyba alebo attempts ≥ 8 → dead_letter (raz dead-letter = bez automatiky až do úspechu),
--   processed / ignored / stale / conflict → bez opakovania (dead_letter sa zruší, čas ostáva).
-- Opakovanie robí cron doťahovania (lib/billing/event-retry.ts): udalosť znova načíta z API providera
-- (`GET /v1/events/{id}`, telo sa v Esblu neukladá) a spracuje ju tou istou pipeline.
-- =============================================================================

alter table public.billing_events add column if not exists next_retry_at timestamptz null;
alter table public.billing_events add column if not exists dead_letter boolean not null default false;
alter table public.billing_events add column if not exists dead_lettered_at timestamptz null;

comment on column public.billing_events.next_retry_at is
  'P4: najskorší čas ďalšieho automatického pokusu (received = lease 10 min, failed = backoff). null = bez opakovania.';
comment on column public.billing_events.dead_letter is
  'P4: automatické opakovanie zastavené (trvalá chyba / vyčerpané pokusy) — rieši operátor (ops alert EVENT_DEAD_LETTER).';

create index if not exists billing_events_retry_due_idx
  on public.billing_events (provider, environment, next_retry_at)
  where not dead_letter and status in ('received', 'failed');

create index if not exists billing_events_dead_letter_idx
  on public.billing_events (environment, dead_lettered_at)
  where dead_letter;

create or replace function public.esblu_billing_event_max_attempts()
returns integer
language sql
immutable
set search_path to ''
as $function$ select 8 $function$;

-- Trvalé chyby: opakovanie nepomôže (zlý payload, neplatný stav, cudzí identifikátor, iná cena,
-- udalosť už u providera neexistuje). Ostatné (NORMALIZE_FAILED, APPLY_FAILED, DOCUMENT_FAILED,
-- UNKNOWN_COMPANY / UNKNOWN_PRICE — napr. cena ešte nie je v DB) sa opakujú s backoffom.
create or replace function public.esblu_billing_event_error_retryable(p_error_code text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select coalesce(p_error_code, '') not in
    ('MALFORMED_PAYLOAD', 'INVALID_STATE', 'CROSS_TENANT_IDENTIFIER', 'PRICE_MISMATCH', 'EVENT_UNAVAILABLE')
$function$;

create or replace function public.esblu_billing_event_retry_delay(p_attempts integer)
returns interval
language sql
immutable
set search_path to ''
as $function$
  select least(interval '6 hours', interval '5 minutes' * power(2, least(greatest(coalesce(p_attempts, 1), 1), 10) - 1))
$function$;

create or replace function public.esblu_billing_events_retry_plan()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.status = 'received' then
    if tg_op = 'INSERT' or old.status is distinct from 'received' or new.attempts is distinct from old.attempts then
      new.next_retry_at := now() + interval '10 minutes';
    end if;
  elsif new.status = 'failed' then
    if tg_op = 'INSERT' or old.status is distinct from 'failed' or new.error_code is distinct from old.error_code then
      if new.dead_letter or not public.esblu_billing_event_error_retryable(new.error_code)
         or new.attempts >= public.esblu_billing_event_max_attempts() then
        new.dead_letter := true;
        new.dead_lettered_at := coalesce(new.dead_lettered_at, now());
        new.next_retry_at := null;
      else
        new.next_retry_at := now() + public.esblu_billing_event_retry_delay(new.attempts);
      end if;
    end if;
  else
    new.next_retry_at := null;
    new.dead_letter := false;
  end if;
  return new;
end
$function$;

drop trigger if exists esblu_billing_events_retry_plan on public.billing_events;
create trigger esblu_billing_events_retry_plan
  before insert or update of status, attempts, error_code on public.billing_events
  for each row execute function public.esblu_billing_events_retry_plan();

-- Existujúce riadky: zlyhané / rozpracované udalosti dostanú plán (jednorazovo, idempotentne).
update public.billing_events
set next_retry_at = now()
where status in ('received', 'failed') and next_retry_at is null and not dead_letter
  and public.esblu_billing_event_error_retryable(error_code);

-- Kandidáti na opakovanie (iba udalosti providera s ID `evt_…`, ktoré sa dajú znova načítať z API).
-- Vyčerpané rozpracované udalosti → failed/RETRY_EXHAUSTED → dead_letter (trigger). Vybraté riadky
-- dostanú lease 10 min (súbežný beh ich nevezme dvakrát).
create or replace function public.esblu_billing_event_retry_claim(p_provider text, p_environment text, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_env text;
  v_out jsonb;
begin
  select c.environment into v_env from public.billing_runtime_config c where c.id;
  if v_env is null or p_environment is distinct from v_env then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_ENVIRONMENT_MISMATCH';
  end if;

  update public.billing_events e
  set status = 'failed', error_code = 'RETRY_EXHAUSTED', processed_at = now()
  where e.provider = p_provider and e.environment = p_environment and not e.dead_letter
    and e.status = 'received' and e.next_retry_at <= now()
    and e.attempts >= public.esblu_billing_event_max_attempts();

  with due as (
    select e.id
    from public.billing_events e
    where e.provider = p_provider and e.environment = p_environment and not e.dead_letter
      and e.status in ('received', 'failed') and e.next_retry_at <= now()
      and e.provider_event_id ~ '^evt_[A-Za-z0-9]+$'
    order by e.next_retry_at
    limit greatest(1, least(coalesce(p_limit, 20), 50))
    for update skip locked
  ), claimed as (
    update public.billing_events e
    set next_retry_at = now() + interval '10 minutes'
    from due
    where e.id = due.id
    returning e.provider_event_id, e.status, e.attempts, e.error_code
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_event_id', c.provider_event_id, 'status', c.status, 'attempts', c.attempts, 'error_code', c.error_code)), '[]'::jsonb)
  into v_out from claimed c;
  return v_out;
end
$function$;

-- Udalosť, ktorú provider už nevie vrátiť (mimo retencie) alebo ktorú nemožno spracovať → dead-letter.
create or replace function public.esblu_billing_event_dead_letter(p_provider text, p_environment text, p_provider_event_id text, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_error_code is null or p_error_code !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_EVENT_STATUS';
  end if;
  update public.billing_events e
  set status = 'failed', error_code = p_error_code, dead_letter = true,
      dead_lettered_at = coalesce(e.dead_lettered_at, now()), next_retry_at = null, processed_at = now()
  where e.provider = p_provider and e.environment = p_environment and e.provider_event_id = p_provider_event_id
    and e.status in ('received', 'failed');
  return found;
end
$function$;

revoke all on function public.esblu_billing_event_max_attempts() from public, anon, authenticated;
revoke all on function public.esblu_billing_event_error_retryable(text) from public, anon, authenticated;
revoke all on function public.esblu_billing_event_retry_delay(integer) from public, anon, authenticated;
revoke all on function public.esblu_billing_events_retry_plan() from public, anon, authenticated;
revoke all on function public.esblu_billing_event_retry_claim(text, text, integer) from public, anon, authenticated;
revoke all on function public.esblu_billing_event_dead_letter(text, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_event_retry_claim(text, text, integer) to service_role;
grant execute on function public.esblu_billing_event_dead_letter(text, text, text, text) to service_role;
