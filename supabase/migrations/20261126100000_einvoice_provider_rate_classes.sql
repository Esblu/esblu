-- =============================================================================
-- 20261126100000 (P1-4 pokračovanie): SPOLOČNÝ limit požiadaviek pre celý partnerský kľúč eFaktura.sk.
-- PRIPRAVENÉ — NEAPLIKOVANÉ (staging aj produkcia iba po samostatnom schválení). Iba aditívne.
--
-- Partnerský kľúč má ≥ 100 req/min spolu pre odosielanie, reconcile, príjem, feed, onboarding a údržbu.
-- Kvóty tried (pevné rozdelenie, súčet = celkový strop 90/min → rezerva 10 pod limitom poskytovateľa):
--   interactive 10 (overenie príjemcu, preflight, onboarding, mandát — akcie používateľa)
--   outbound 25    (odoslanie faktúr + dohľadanie podania — REZERVA, iné triedy ju nemôžu minúť)
--   reconcile 10   (stav a dôkaz doručenia odoslaných)
--   inbound_event 15 / inbound_poll 25 (príjem z udalostí / pravidelný sken)
--   background 5   (feed udalostí, deregistrácia)
-- Okno: kĺzavé (vážená predchádzajúca minúta + aktuálna) → žiadny dvojnásobný nápor na hranici minúty.
-- 429 od poskytovateľa → esblu_einvoice_rate_cooldown: všetky triedy čakajú (Retry-After, inak 30 s, max 1 h).
-- Rozhodnutie je atomické (pg_advisory_xact_lock na provider+prostredie). Kvóty sa menia v tabuľke bez deployu.
-- Health: provider.rate_denied_1h (+ outbound/interactive), provider.cooldown_active, provider.provider_429_24h;
-- inbound.rate_limited_1h zahŕňa aj triedy príjmu.
-- Rollback: supabase/rollback/20261126100000_einvoice_provider_rate_classes_rollback.sql
-- =============================================================================
begin;

create table if not exists public.einvoice_provider_rate_limits (
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  class text not null check (class in ('total', 'interactive', 'outbound', 'reconcile', 'inbound_event', 'inbound_poll', 'background')),
  per_minute integer not null check (per_minute between 0 and 1000),
  updated_at timestamptz not null default now(),
  primary key (provider, environment, class)
);
alter table public.einvoice_provider_rate_limits enable row level security;
revoke all on table public.einvoice_provider_rate_limits from public, anon, authenticated;
grant select on table public.einvoice_provider_rate_limits to service_role;

insert into public.einvoice_provider_rate_limits (provider, environment, class, per_minute)
select 'efaktura_sk', e.env, c.class, c.per_minute
from (values ('sandbox'), ('live')) as e(env)
cross join (values ('total', 90), ('interactive', 10), ('outbound', 25), ('reconcile', 10),
                   ('inbound_event', 15), ('inbound_poll', 25), ('background', 5)) as c(class, per_minute)
on conflict (provider, environment, class) do nothing;

create table if not exists public.einvoice_provider_rate_usage (
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  window_start timestamptz not null,
  class text not null check (class in ('interactive', 'outbound', 'reconcile', 'inbound_event', 'inbound_poll', 'background')),
  used integer not null default 0 check (used >= 0),
  denied integer not null default 0 check (denied >= 0),
  primary key (provider, environment, window_start, class)
);
alter table public.einvoice_provider_rate_usage enable row level security;
revoke all on table public.einvoice_provider_rate_usage from public, anon, authenticated;
grant select on table public.einvoice_provider_rate_usage to service_role;

create table if not exists public.einvoice_provider_rate_state (
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  blocked_until timestamptz,
  last_429_at timestamptz,
  count_429 integer not null default 0 check (count_429 >= 0),
  primary key (provider, environment)
);
alter table public.einvoice_provider_rate_state enable row level security;
revoke all on table public.einvoice_provider_rate_state from public, anon, authenticated;
grant select on table public.einvoice_provider_rate_state to service_role;

-- 'ok' | 'class_limit' | 'total_limit' | 'cooldown' | 'unconfigured' (bez kvót pre provider/prostredie → povolené)
create or replace function public.esblu_einvoice_rate_acquire_class(p_provider text, p_environment text, p_class text, p_cost integer)
returns text
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_cur timestamptz := date_trunc('minute', v_now);
  v_prev timestamptz := date_trunc('minute', v_now) - interval '1 minute';
  v_weight numeric := 1 - extract(epoch from (v_now - date_trunc('minute', v_now))) / 60.0;
  v_class_limit integer;
  v_total_limit integer;
  v_class_used numeric;
  v_total_used numeric;
  v_result text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,40}$' or p_environment is null or p_environment not in ('sandbox', 'live')
     or p_class is null or p_class not in ('interactive', 'outbound', 'reconcile', 'inbound_event', 'inbound_poll', 'background')
     or p_cost is null or p_cost < 1 or p_cost > 100 then
    raise exception 'EINVOICE_RATE_INVALID' using errcode = '22023';
  end if;
  -- jedno rozhodnutie naraz pre provider+prostredie (súbežné procesy a inštancie)
  perform pg_advisory_xact_lock(hashtextextended('esblu_einvoice_rate:' || p_provider || ':' || p_environment, 0));

  select l.per_minute into v_class_limit from public.einvoice_provider_rate_limits l
   where l.provider = p_provider and l.environment = p_environment and l.class = p_class;
  select l.per_minute into v_total_limit from public.einvoice_provider_rate_limits l
   where l.provider = p_provider and l.environment = p_environment and l.class = 'total';

  if exists (select 1 from public.einvoice_provider_rate_state s
              where s.provider = p_provider and s.environment = p_environment and s.blocked_until > v_now) then
    v_result := 'cooldown';
  elsif v_class_limit is null or v_total_limit is null then
    v_result := 'unconfigured';
  else
    select coalesce(sum(case when u.window_start = v_cur then u.used else u.used * v_weight end), 0) into v_class_used
      from public.einvoice_provider_rate_usage u
     where u.provider = p_provider and u.environment = p_environment and u.class = p_class and u.window_start in (v_prev, v_cur);
    select coalesce(sum(case when u.window_start = v_cur then u.used else u.used * v_weight end), 0) into v_total_used
      from public.einvoice_provider_rate_usage u
     where u.provider = p_provider and u.environment = p_environment and u.window_start in (v_prev, v_cur);
    if v_class_used + p_cost > v_class_limit then
      v_result := 'class_limit';
    elsif v_total_used + p_cost > v_total_limit then
      v_result := 'total_limit';
    else
      v_result := 'ok';
    end if;
  end if;

  if v_result in ('ok', 'unconfigured') then
    insert into public.einvoice_provider_rate_usage as u (provider, environment, window_start, class, used)
    values (p_provider, p_environment, v_cur, p_class, p_cost)
    on conflict (provider, environment, window_start, class) do update set used = least(u.used + excluded.used, 1000000);
  else
    insert into public.einvoice_provider_rate_usage as u (provider, environment, window_start, class, denied)
    values (p_provider, p_environment, v_cur, p_class, 1)
    on conflict (provider, environment, window_start, class) do update set denied = least(u.denied + 1, 1000000);
  end if;

  delete from public.einvoice_provider_rate_usage u
   where u.provider = p_provider and u.environment = p_environment and u.window_start < v_cur - interval '2 days';
  return v_result;
end;
$function$;

-- 429 od poskytovateľa: všetky triedy počkajú (najviac 1 h). Nikdy neskracuje už nastavené čakanie.
create or replace function public.esblu_einvoice_rate_cooldown(p_provider text, p_environment text, p_seconds integer)
returns timestamptz
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_until timestamptz;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,40}$' or p_environment is null or p_environment not in ('sandbox', 'live') then
    raise exception 'EINVOICE_RATE_INVALID' using errcode = '22023';
  end if;
  v_until := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_seconds, 30), 1), 3600));
  insert into public.einvoice_provider_rate_state as s (provider, environment, blocked_until, last_429_at, count_429)
  values (p_provider, p_environment, v_until, clock_timestamp(), 1)
  on conflict (provider, environment) do update set
    blocked_until = greatest(coalesce(s.blocked_until, v_until), v_until),
    last_429_at = clock_timestamp(),
    count_429 = case when s.last_429_at > clock_timestamp() - interval '24 hours' then least(s.count_429 + 1, 1000000) else 1 end
  returning blocked_until into v_until;
  return v_until;
end;
$function$;

revoke all on function public.esblu_einvoice_rate_acquire_class(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_rate_cooldown(text, text, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_rate_acquire_class(text, text, text, integer) to service_role;
grant execute on function public.esblu_einvoice_rate_cooldown(text, text, integer) to service_role;

create or replace function public.esblu_einvoice_health(p_stuck_minutes integer, p_ack_pending_minutes integer)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with o as (
    select e.state, e.updated_at, e.send_outcome_unknown, e.provider_submission_id,
           public.esblu_einvoice_outbound_category(e.state, e.provider_submission_id, e.next_retry_at, e.last_error_code) as category
    from public.einvoice_outbound e
  ),
  i as (
    select n.processing_status as status, n.updated_at,
           public.esblu_einvoice_inbound_category(n.processing_status, n.dedupe_matched_on) as category,
           n.last_error_code, n.quarantined_at, n.provider_acknowledged_at
    from public.einvoice_inbound n
  ),
  stuck_minutes as (select greatest(coalesce(p_stuck_minutes, 60), 1) as m, greatest(coalesce(p_ack_pending_minutes, 60), 1) as a)
  select jsonb_build_object(
    'generated_at', now(),
    'outbound', jsonb_build_object(
      'queued', (select count(*) from o where state = 'queued'),
      'sending', (select count(*) from o where state = 'sending'),
      'sent', (select count(*) from o where state = 'sent'),
      'deferred', (select count(*) from o where state = 'deferred'),
      'delivered', (select count(*) from o where state = 'delivered'),
      'rejected', (select count(*) from o where state = 'rejected'),
      'failed', (select count(*) from o where state = 'failed'),
      'retryable', (select count(*) from o where category = 'retryable'),
      'reconciliation_required', (select count(*) from o where category = 'reconciliation_required'),
      'retry_exhausted_unknown', (select count(*) from o where category = 'retry_exhausted_unknown'),
      'unknown_send_outcome', (select count(*) from o where send_outcome_unknown and provider_submission_id is null and state not in ('failed', 'rejected', 'delivered')),
      'stuck', (select count(*) from o, stuck_minutes s where state in ('queued', 'sending', 'sent', 'deferred') and updated_at < now() - make_interval(mins => s.m)),
      'oldest_stuck_age_seconds', (select coalesce(floor(extract(epoch from now() - min(updated_at))), 0)::bigint from o where state in ('queued', 'sending', 'sent', 'deferred'))
    ),
    'inbound', jsonb_build_object(
      'received', (select count(*) from i where status = 'received'),
      'stored', (select count(*) from i where status = 'stored'),
      'parsed', (select count(*) from i where status = 'parsed'),
      'draft_created', (select count(*) from i where status = 'draft_created'),
      'duplicate', (select count(*) from i where category = 'duplicate'),
      'ack_pending', (select count(*) from i where category = 'ack_pending'),
      'acknowledged', (select count(*) from i where category = 'acknowledged'),
      'failed', (select count(*) from i where status = 'failed'),
      -- P1-4: karanténa a doklady adresované inému účastníkovi (R3 — incident, nikdy nesprístupnené firme)
      'quarantined', (select count(*) from i where status = 'failed' and quarantined_at is not null),
      'quarantined_unacked', (select count(*) from i where status = 'failed' and quarantined_at is not null and provider_acknowledged_at is null),
      'recipient_mismatch', (select count(*) from i where status = 'failed' and last_error_code = 'RECIPIENT_MISMATCH'),
      'ack_pending_too_long', (select count(*) from i, stuck_minutes s where status in ('ack_pending', 'draft_created', 'duplicate') and updated_at < now() - make_interval(mins => s.a)),
      'stuck', (select count(*) from i, stuck_minutes s where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending') and updated_at < now() - make_interval(mins => s.m)),
      'oldest_stuck_age_seconds', (select coalesce(floor(extract(epoch from now() - min(updated_at))), 0)::bigint from i where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending')),
      -- P1-4: organizácie s aktívnym príjmom bez úplného skenu zoznamu > 2 h (nové doklady by mohli čakať neviditeľne)
      'scan_overdue', (select count(*) from public.einvoice_organizations g
                        left join public.einvoice_inbound_scan_state ss
                          on ss.provider = g.provider and ss.environment = g.environment and ss.provider_org_id = g.provider_org_id
                        where g.peppol_eligible and g.provider_org_id is not null
                          and (g.reception_status is null or g.reception_status = 'active')
                          and g.created_at < now() - interval '2 hours'
                          -- bez záznamu sa počíta až keď poll s novým kódom už beží (nasadenie kódu po migrácii
                          -- tak nevyvolá falošný kritický alert)
                          and (case when ss.provider_org_id is null
                                    then exists (select 1 from public.einvoice_inbound_scan_state x
                                                  where x.provider = g.provider and x.environment = g.environment)
                                    else coalesce(ss.last_complete_at, '-infinity'::timestamptz) < now() - interval '2 hours' end)),
      'scan_incomplete', (select count(*) from public.einvoice_inbound_scan_state ss where ss.incomplete_streak > 0),
      'rate_limited_1h', (select coalesce(sum(rw.denied), 0) from public.einvoice_provider_rate_window rw where rw.window_start > now() - interval '1 hour')
                         + (select coalesce(sum(ru.denied), 0) from public.einvoice_provider_rate_usage ru
                             where ru.window_start > now() - interval '1 hour' and ru.class in ('inbound_event', 'inbound_poll'))
    ),
    -- 20261126100000: spoločný limit partnerského kľúča (všetky triedy volaní)
    'provider', jsonb_build_object(
      'rate_denied_1h', (select coalesce(sum(ru.denied), 0) from public.einvoice_provider_rate_usage ru where ru.window_start > now() - interval '1 hour'),
      'rate_denied_outbound_1h', (select coalesce(sum(ru.denied), 0) from public.einvoice_provider_rate_usage ru where ru.window_start > now() - interval '1 hour' and ru.class = 'outbound'),
      'rate_denied_interactive_1h', (select coalesce(sum(ru.denied), 0) from public.einvoice_provider_rate_usage ru where ru.window_start > now() - interval '1 hour' and ru.class = 'interactive'),
      'cooldown_active', (select count(*) from public.einvoice_provider_rate_state rs where rs.blocked_until > now()),
      'provider_429_24h', (select coalesce(sum(rs.count_429), 0) from public.einvoice_provider_rate_state rs where rs.last_429_at > now() - interval '24 hours')
    ),
    'webhook', jsonb_build_object(
      'failures_24h', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'failed' and w.received_at > now() - interval '24 hours'),
      'rejected_24h', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'rejected' and w.received_at > now() - interval '24 hours'),
      'unprocessed_older_15m', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'received' and w.received_at < now() - interval '15 minutes'),
      'signature_failures_1h', (select coalesce(sum(r.count), 0) from public.einvoice_webhook_rejections r where r.reason = 'INVALID_SIGNATURE' and r.bucket_start > now() - interval '1 hour'),
      'replays_1h', (select coalesce(sum(r.count), 0) from public.einvoice_webhook_rejections r where r.reason = 'REPLAYED_WEBHOOK' and r.bucket_start > now() - interval '1 hour')
    )
  );
$function$;
revoke all on function public.esblu_einvoice_health(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_health(integer, integer) to service_role;

commit;
