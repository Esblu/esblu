-- =============================================================================
-- P4 (2026-11-23): bezpečný monitoring a ops alerty pre billing (Stripe test/live).
-- Iba aditívne. Rollback: supabase/rollback/20261123120000_billing_ops_alerts_rollback.sql
-- (história alertov sa pri rollbacku NEMAŽE — presunie sa do esblu_audit_archive).
--
--   billing_ops_alerts     — deduplikované alerty: 1 riadok na (kód, prostredie, časové okno).
--                            Počítadlo výskytov, prah (counting → open), stav doručenia (e-mail),
--                            auto-resolve podmienkových alertov. Detail = IBA kódy a čísla
--                            (sanitizácia v DB): žiadne ID firiem, zákazníkov, e-maily, sumy ani tajomstvá.
--   billing_ops_heartbeats — posledný beh / úspech cronov (stripe_events, reconcile, documents).
--   esblu_billing_ops_raise    — signál (webhook podpis, nezhoda API verzie, cron) → upsert s prahom.
--   esblu_billing_ops_collect  — vyhodnotenie stavu DB: zlyhané a dead-letter udalosti, oneskorenie
--                                doťahovania, nezhody reconciliation, zlyhané crony, refundácie bez
--                                dobropisu, zlyhaný archív PDF.
--   esblu_billing_ops_pending / esblu_billing_ops_mark_notified — doručenie (lib/billing/ops-alerts.ts).
-- Iba service_role. Klient (anon / authenticated) nemá prístup.
-- =============================================================================

create table if not exists public.billing_ops_alerts (
  id uuid primary key default gen_random_uuid(),
  environment text not null,
  code text not null,
  severity text not null,
  dedupe_key text not null,
  bucket_start timestamptz not null,
  occurrences integer not null default 0,
  threshold integer not null default 1,
  state text not null default 'counting',
  details jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  opened_at timestamptz null,
  resolved_at timestamptz null,
  notified_at timestamptz null,
  notify_attempts integer not null default 0,
  notify_channel text null,
  notify_error text null,
  created_at timestamptz not null default now(),
  constraint billing_ops_alerts_env_check check (environment in ('test', 'live')),
  constraint billing_ops_alerts_code_check check (code ~ '^[A-Z0-9_]{1,60}$'),
  constraint billing_ops_alerts_severity_check check (severity in ('warning', 'critical')),
  constraint billing_ops_alerts_state_check check (state in ('counting', 'open', 'resolved')),
  constraint billing_ops_alerts_dedupe_check check (dedupe_key ~ '^[A-Za-z0-9_:.-]{1,120}$'),
  constraint billing_ops_alerts_details_check check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 2048),
  constraint billing_ops_alerts_channel_check check (notify_channel is null or notify_channel in ('email', 'none')),
  constraint billing_ops_alerts_error_check check (notify_error is null or notify_error ~ '^[A-Z0-9_]{1,80}$'),
  constraint billing_ops_alerts_dedupe_unique unique (dedupe_key)
);
create index if not exists billing_ops_alerts_open_idx on public.billing_ops_alerts (environment, state, severity) where state = 'open';

create table if not exists public.billing_ops_heartbeats (
  job text not null,
  environment text not null,
  last_run_at timestamptz null,
  last_ok_at timestamptz null,
  consecutive_failures integer not null default 0,
  last_error_code text null,
  constraint billing_ops_heartbeats_pkey primary key (job, environment),
  constraint billing_ops_heartbeats_job_check check (job in ('stripe_events', 'reconcile', 'documents', 'ops_monitor')),
  constraint billing_ops_heartbeats_env_check check (environment in ('test', 'live')),
  constraint billing_ops_heartbeats_error_check check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$')
);

alter table public.billing_ops_alerts enable row level security;
alter table public.billing_ops_heartbeats enable row level security;
revoke all on table public.billing_ops_alerts, public.billing_ops_heartbeats from public, anon, authenticated, service_role;
grant select on table public.billing_ops_alerts, public.billing_ops_heartbeats to service_role;

-- Detail alertu: iba kľúče [a-z_] a hodnoty = čísla, boolean alebo kódy [A-Z0-9_] (max 12 polí).
create or replace function public.esblu_billing_ops_clean_details(p_details jsonb)
returns jsonb
language sql
immutable
set search_path to ''
as $function$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  from (
    select d.key, d.value
    from jsonb_each(case when jsonb_typeof(p_details) = 'object' then p_details else '{}'::jsonb end) d
    where d.key ~ '^[a-z_]{1,40}$'
      and (jsonb_typeof(d.value) in ('number', 'boolean')
           or (jsonb_typeof(d.value) = 'string' and (d.value #>> '{}') ~ '^[A-Z0-9_]{0,60}$'))
    order by d.key
    limit 12
  ) e
$function$;

create or replace function public.esblu_billing_ops_raise(
  p_environment text, p_code text, p_severity text, p_bucket_minutes integer, p_threshold integer, p_details jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_bucket_sec integer := greatest(5, least(coalesce(p_bucket_minutes, 60), 10080)) * 60;
  v_bucket timestamptz := to_timestamp(floor(extract(epoch from now()) / v_bucket_sec) * v_bucket_sec);
  v_threshold integer := greatest(1, least(coalesce(p_threshold, 1), 100000));
  v_row public.billing_ops_alerts;
begin
  if p_environment is null or p_environment not in ('test', 'live') or p_code is null or p_code !~ '^[A-Z0-9_]{1,60}$'
     or p_severity is null or p_severity not in ('warning', 'critical') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_OPS_ALERT_INVALID';
  end if;
  insert into public.billing_ops_alerts as a (environment, code, severity, dedupe_key, bucket_start, occurrences, threshold, state, details, opened_at)
  values (p_environment, p_code, p_severity,
          p_code || ':' || p_environment || ':' || to_char(v_bucket at time zone 'UTC', 'YYYYMMDDHH24MI'),
          v_bucket, 1, v_threshold, case when v_threshold <= 1 then 'open' else 'counting' end,
          public.esblu_billing_ops_clean_details(p_details), case when v_threshold <= 1 then now() end)
  on conflict (dedupe_key) do update set
    occurrences = a.occurrences + 1,
    last_seen_at = now(),
    details = public.esblu_billing_ops_clean_details(p_details),
    severity = case when excluded.severity = 'critical' then 'critical' else a.severity end,
    state = case when a.occurrences + 1 >= a.threshold then 'open' else a.state end,
    opened_at = case when a.occurrences + 1 >= a.threshold and a.state <> 'open' then now() else a.opened_at end,
    resolved_at = case when a.occurrences + 1 >= a.threshold then null else a.resolved_at end
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'state', v_row.state, 'occurrences', v_row.occurrences);
end
$function$;

create or replace function public.esblu_billing_ops_heartbeat(p_job text, p_environment text, p_ok boolean, p_error_code text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.billing_ops_heartbeats as h (job, environment, last_run_at, last_ok_at, consecutive_failures, last_error_code)
  values (p_job, p_environment, now(), case when p_ok then now() end, case when p_ok then 0 else 1 end,
          case when p_ok then null when p_error_code ~ '^[A-Z0-9_]{1,80}$' then p_error_code else 'CRON_FAILED' end)
  on conflict (job, environment) do update set
    last_run_at = now(),
    last_ok_at = case when p_ok then now() else h.last_ok_at end,
    consecutive_failures = case when p_ok then 0 else h.consecutive_failures + 1 end,
    last_error_code = excluded.last_error_code;
end
$function$;

-- Vyhodnotenie stavu DB (volá cron billing-ops-monitor). Podmienkové alerty, ktoré už neplatia,
-- sa automaticky uzavrú (resolved). Žiadne identifikátory v detailoch — iba počty a kódy.
create or replace function public.esblu_billing_ops_collect(p_environment text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_codes constant text[] := array['EVENT_PROCESSING_FAILED', 'EVENT_DEAD_LETTER', 'CATCHUP_LAG', 'CATCHUP_ACCOUNT_MISMATCH',
    'CATCHUP_CURSOR_EXPIRED', 'RECONCILE_DEAD_LETTER', 'RECONCILE_MISMATCH', 'RECONCILE_ERRORS', 'CRON_STRIPE_EVENTS_FAILING',
    'CRON_RECONCILE_FAILING', 'CRON_DOCUMENTS_FAILING', 'REFUND_WITHOUT_CREDIT_NOTE', 'DOCUMENT_ARCHIVE_FAILED'];
  v_raised text[] := '{}';
  v_n bigint;
  v_m bigint;
  v_code text;
  v_cur public.billing_event_cursors;
  v_hb public.billing_ops_heartbeats;
  v_resolved integer;
begin
  if p_environment is null or p_environment not in ('test', 'live') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_OPS_ALERT_INVALID';
  end if;

  -- 1) zlyhané / zaseknuté udalosti (opakujú sa automaticky) a dead-letter (rieši operátor)
  select count(*) filter (where e.status = 'failed'),
         count(*) filter (where e.status = 'received' and e.received_at < now() - interval '30 minutes')
    into v_n, v_m
  from public.billing_events e
  where e.environment = p_environment and not e.dead_letter and e.status in ('failed', 'received');
  if v_n + v_m > 0 then
    select e.error_code into v_code from public.billing_events e
    where e.environment = p_environment and not e.dead_letter and e.status = 'failed' and e.error_code is not null
    group by e.error_code order by count(*) desc limit 1;
    perform public.esblu_billing_ops_raise(p_environment, 'EVENT_PROCESSING_FAILED', 'warning', 360, 1,
      jsonb_build_object('failed', v_n, 'stuck_received', v_m, 'top_error', coalesce(v_code, 'NONE')));
    v_raised := array_append(v_raised, 'EVENT_PROCESSING_FAILED'::text);
  end if;
  select count(*) into v_n from public.billing_events e
  where e.environment = p_environment and e.dead_letter and e.status in ('failed', 'received');
  if v_n > 0 then
    perform public.esblu_billing_ops_raise(p_environment, 'EVENT_DEAD_LETTER', 'critical', 1440, 1, jsonb_build_object('count', v_n));
    v_raised := array_append(v_raised, 'EVENT_DEAD_LETTER'::text);
  end if;

  -- 2) doťahovanie (kurzor)
  select * into v_cur from public.billing_event_cursors c where c.provider = 'stripe' and c.environment = p_environment;
  if found then
    if coalesce(v_cur.last_success_at, v_cur.created_at) < now() - interval '1 hour' then
      perform public.esblu_billing_ops_raise(p_environment, 'CATCHUP_LAG', 'critical', 360, 1, jsonb_build_object(
        'minutes_since_success', floor(extract(epoch from now() - coalesce(v_cur.last_success_at, v_cur.created_at)) / 60),
        'consecutive_failures', v_cur.consecutive_failures, 'last_error', coalesce(v_cur.last_error_code, 'NONE')));
      v_raised := array_append(v_raised, 'CATCHUP_LAG'::text);
    end if;
    if v_cur.last_error_code = 'ACCOUNT_MISMATCH' then
      perform public.esblu_billing_ops_raise(p_environment, 'CATCHUP_ACCOUNT_MISMATCH', 'critical', 1440, 1, '{}'::jsonb);
      v_raised := array_append(v_raised, 'CATCHUP_ACCOUNT_MISMATCH'::text);
    elsif v_cur.last_error_code = 'CURSOR_EXPIRED' then
      perform public.esblu_billing_ops_raise(p_environment, 'CATCHUP_CURSOR_EXPIRED', 'warning', 1440, 1, '{}'::jsonb);
      v_raised := array_append(v_raised, 'CATCHUP_CURSOR_EXPIRED'::text);
    end if;
  end if;

  -- 3) reconciliation (iba účty prostredia)
  select count(*) filter (where r.dead_letter),
         count(*) filter (where not r.dead_letter and r.last_result = 'corrected' and r.last_checked_at > now() - interval '6 hours')
    into v_n, v_m
  from public.billing_reconciliation r
  join public.subscription_accounts a on a.id = r.account_id
  where a.provider_environment = p_environment;
  if v_n > 0 then
    perform public.esblu_billing_ops_raise(p_environment, 'RECONCILE_DEAD_LETTER', 'critical', 1440, 1, jsonb_build_object('count', v_n));
    v_raised := array_append(v_raised, 'RECONCILE_DEAD_LETTER'::text);
  end if;
  if v_m > 0 then
    perform public.esblu_billing_ops_raise(p_environment, 'RECONCILE_MISMATCH', 'warning', 360, 1, jsonb_build_object('corrected_6h', v_m));
    v_raised := array_append(v_raised, 'RECONCILE_MISMATCH'::text);
  end if;
  select count(*) into v_n
  from public.billing_reconciliation r join public.subscription_accounts a on a.id = r.account_id
  where a.provider_environment = p_environment and not r.dead_letter and r.last_result = 'error' and r.consecutive_failures >= 3;
  if v_n > 0 then
    perform public.esblu_billing_ops_raise(p_environment, 'RECONCILE_ERRORS', 'warning', 360, 1, jsonb_build_object('count', v_n));
    v_raised := array_append(v_raised, 'RECONCILE_ERRORS'::text);
  end if;

  -- 4) crony (heartbeat)
  for v_hb in select * from public.billing_ops_heartbeats h where h.environment = p_environment and h.job <> 'ops_monitor' loop
    if (v_hb.job = 'stripe_events' and (v_hb.consecutive_failures >= 2 or coalesce(v_hb.last_ok_at, '-infinity') < now() - interval '1 hour'))
       or (v_hb.job = 'reconcile' and (v_hb.consecutive_failures >= 2 or coalesce(v_hb.last_ok_at, '-infinity') < now() - interval '13 hours'))
       or (v_hb.job = 'documents' and (v_hb.consecutive_failures >= 3 or coalesce(v_hb.last_ok_at, '-infinity') < now() - interval '26 hours')) then
      v_code := 'CRON_' || upper(v_hb.job) || '_FAILING';
      perform public.esblu_billing_ops_raise(p_environment, v_code, case when v_hb.job = 'documents' then 'warning' else 'critical' end,
        case when v_hb.job = 'stripe_events' then 360 else 720 end, 1,
        jsonb_build_object('consecutive_failures', v_hb.consecutive_failures, 'last_error', coalesce(v_hb.last_error_code, 'NONE'),
          'minutes_since_ok', case when v_hb.last_ok_at is null then -1 else floor(extract(epoch from now() - v_hb.last_ok_at) / 60) end));
      v_raised := array_append(v_raised, v_code::text);
    end if;
  end loop;

  -- 5) doklady: refundácia bez dobropisu (> 24 h), zlyhávajúci archív PDF
  select count(*) into v_n from public.esblu_billing_refunds_without_credit_note(p_environment, interval '24 hours');
  if v_n > 0 then
    perform public.esblu_billing_ops_raise(p_environment, 'REFUND_WITHOUT_CREDIT_NOTE', 'warning', 1440, 1, jsonb_build_object('count', v_n));
    v_raised := array_append(v_raised, 'REFUND_WITHOUT_CREDIT_NOTE'::text);
  end if;
  select count(*) into v_n from public.billing_invoice_documents d
  where d.environment = p_environment and d.pdf_archived_at is null and d.pdf_url is not null and d.pdf_archive_attempts >= 5;
  if v_n > 0 then
    perform public.esblu_billing_ops_raise(p_environment, 'DOCUMENT_ARCHIVE_FAILED', 'warning', 1440, 1, jsonb_build_object('count', v_n));
    v_raised := array_append(v_raised, 'DOCUMENT_ARCHIVE_FAILED'::text);
  end if;

  update public.billing_ops_alerts a set state = 'resolved', resolved_at = now()
  where a.environment = p_environment and a.state in ('open', 'counting')
    and a.code = any (v_codes) and not (a.code = any (v_raised));
  get diagnostics v_resolved = row_count;
  return jsonb_build_object('raised', to_jsonb(v_raised), 'resolved', v_resolved);
end
$function$;

create or replace function public.esblu_billing_ops_pending(p_environment text, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'environment', a.environment, 'code', a.code, 'severity', a.severity,
    'occurrences', a.occurrences, 'first_seen_at', a.first_seen_at, 'last_seen_at', a.last_seen_at, 'details', a.details)
    order by (a.severity = 'critical') desc, a.opened_at), '[]'::jsonb)
  from (
    select * from public.billing_ops_alerts a
    where a.environment = p_environment and a.state = 'open' and a.notified_at is null and a.notify_attempts < 5
    order by (a.severity = 'critical') desc, a.opened_at
    limit greatest(1, least(coalesce(p_limit, 20), 50))
  ) a
$function$;

create or replace function public.esblu_billing_ops_mark_notified(p_id uuid, p_ok boolean, p_channel text, p_error_code text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.billing_ops_alerts a set
    notified_at = case when p_ok then now() else a.notified_at end,
    notify_channel = case when p_channel in ('email', 'none') then p_channel else a.notify_channel end,
    notify_attempts = a.notify_attempts + case when p_ok then 0 else 1 end,
    notify_error = case when p_ok then null when p_error_code ~ '^[A-Z0-9_]{1,80}$' then p_error_code else 'NOTIFY_FAILED' end
  where a.id = p_id;
end
$function$;

create or replace function public.esblu_billing_ops_open_summary(p_environment text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'critical', count(*) filter (where a.severity = 'critical'),
    'warning', count(*) filter (where a.severity = 'warning'),
    'codes', coalesce(jsonb_agg(distinct a.code), '[]'::jsonb))
  from public.billing_ops_alerts a
  where a.environment = p_environment and a.state = 'open'
$function$;

revoke all on function public.esblu_billing_ops_clean_details(jsonb) from public, anon, authenticated;
revoke all on function public.esblu_billing_ops_raise(text, text, text, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.esblu_billing_ops_heartbeat(text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.esblu_billing_ops_collect(text) from public, anon, authenticated;
revoke all on function public.esblu_billing_ops_pending(text, integer) from public, anon, authenticated;
revoke all on function public.esblu_billing_ops_mark_notified(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.esblu_billing_ops_open_summary(text) from public, anon, authenticated;
grant execute on function public.esblu_billing_ops_raise(text, text, text, integer, integer, jsonb) to service_role;
grant execute on function public.esblu_billing_ops_heartbeat(text, text, boolean, text) to service_role;
grant execute on function public.esblu_billing_ops_collect(text) to service_role;
grant execute on function public.esblu_billing_ops_pending(text, integer) to service_role;
grant execute on function public.esblu_billing_ops_mark_notified(uuid, boolean, text, text) to service_role;
grant execute on function public.esblu_billing_ops_open_summary(text) to service_role;
