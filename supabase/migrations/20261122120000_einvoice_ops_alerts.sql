-- =============================================================================
-- 20261122120000 — E-Faktúra: perzistentné prevádzkové alerty s deduplikáciou
-- (nedostatočný kredit HTTP 402, webhook usage.limit_exceeded, chyby integrácie:
-- odmietnutý kľúč, zlyhaná deregistrácia, kritické health kandidáty).
-- Audit: docs/audits/efaktura-readiness-audit-2026-11-19.md D-O1 / T7.
-- NEAPLIKOVANÉ. Staging/produkcia iba po výslovnom schválení.
--
--   - einvoice_ops_alerts: jeden OTVORENÝ záznam na dedupe kľúč (code + prostredie +
--     firma alebo „platforma“). Opakovaný výskyt iba zvýši počítadlo a last_seen_at.
--   - esblu_einvoice_ops_alert_raise: upsert + rozhodnutie o notifikácii
--     (nový alert, alebo posledná notifikácia staršia než p_renotify_after_seconds).
--   - esblu_einvoice_ops_alert_resolve / _open_summary.
--   - Žiadny obsah dokladov, IČO, participant ID ani telo webhooku — iba strojové kódy.
--   - DELETE / TRUNCATE nikdy (retencia = rozhodnutie prevádzkovateľa); klient nič nevidí.
-- Rollback: supabase/rollback/20261122120000_einvoice_ops_alerts_rollback.sql
-- =============================================================================

begin;

create table if not exists public.einvoice_ops_alerts (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[A-Z0-9_]{1,80}$'),
  severity text not null check (severity in ('warning', 'critical')),
  provider text null check (provider is null or provider ~ '^[a-z0-9_]{2,40}$'),
  environment text null check (environment is null or environment in ('sandbox', 'live')),
  company_id uuid null,
  detail_code text null check (detail_code is null or detail_code ~ '^[A-Z0-9_]{1,80}$'),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  status text not null default 'open' check (status in ('open', 'resolved')),
  occurrences integer not null default 1 check (occurrences >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  notified_at timestamptz null,
  notify_count integer not null default 0 check (notify_count >= 0),
  resolved_at timestamptz null,
  resolved_by text null check (resolved_by is null or char_length(resolved_by) between 1 and 120),
  constraint einvoice_ops_alerts_resolved_pair check ((status = 'resolved') = (resolved_at is not null))
);

create unique index if not exists einvoice_ops_alerts_one_open
  on public.einvoice_ops_alerts (dedupe_key) where status = 'open';
create index if not exists einvoice_ops_alerts_recent_idx
  on public.einvoice_ops_alerts (last_seen_at desc);

comment on table public.einvoice_ops_alerts is
  'E-Faktúra: prevádzkové alerty (kredit 402, usage.limit_exceeded, chyby integrácie) s deduplikáciou — '
  'jeden otvorený záznam na dedupe_key. Iba strojové kódy. Zápis iba service_role RPC; klient nič. DELETE nikdy.';

alter table public.einvoice_ops_alerts enable row level security;
revoke all on table public.einvoice_ops_alerts from public, anon, authenticated, service_role;
grant select on table public.einvoice_ops_alerts to service_role;

create or replace function public.esblu_einvoice_ops_alerts_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_OPS_ALERT_APPEND_ONLY';
  end if;
  if new.id is distinct from old.id or new.code is distinct from old.code or new.dedupe_key is distinct from old.dedupe_key
     or new.first_seen_at is distinct from old.first_seen_at or new.company_id is distinct from old.company_id
     or new.environment is distinct from old.environment or new.provider is distinct from old.provider
     or old.status = 'resolved' then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_OPS_ALERT_IMMUTABLE';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_ops_alerts_guard() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_ops_alerts_guard on public.einvoice_ops_alerts;
create trigger esblu_einvoice_ops_alerts_guard
  before update or delete on public.einvoice_ops_alerts
  for each row execute function public.esblu_einvoice_ops_alerts_guard();

create or replace function public.esblu_einvoice_ops_alerts_no_truncate()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_OPS_ALERT_APPEND_ONLY';
end;
$function$;
revoke all on function public.esblu_einvoice_ops_alerts_no_truncate() from public, anon, authenticated, service_role;

drop trigger if exists esblu_einvoice_ops_alerts_no_truncate on public.einvoice_ops_alerts;
create trigger esblu_einvoice_ops_alerts_no_truncate
  before truncate on public.einvoice_ops_alerts
  for each statement execute function public.esblu_einvoice_ops_alerts_no_truncate();

create or replace function public.esblu_einvoice_ops_alert_raise(
  p_code text,
  p_severity text,
  p_provider text,
  p_environment text,
  p_company_id uuid,
  p_detail_code text,
  p_renotify_after_seconds integer default 21600
)
returns table (alert_id uuid, created boolean, notify boolean, occurrences integer)
language plpgsql
volatile
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_key text;
  v_row public.einvoice_ops_alerts;
  v_created boolean;
  v_notify boolean;
  v_renotify interval := make_interval(secs => greatest(coalesce(p_renotify_after_seconds, 21600), 300));
begin
  if p_code is null or p_code !~ '^[A-Z0-9_]{1,80}$' or p_severity not in ('warning', 'critical') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_REQUEST';
  end if;
  v_key := p_code || ':' || coalesce(p_environment, '-') || ':' || coalesce(p_company_id::text, 'platform');
  perform pg_advisory_xact_lock(hashtextextended('einvoice_ops_alert:' || v_key, 0));

  select * into v_row from public.einvoice_ops_alerts a where a.dedupe_key = v_key and a.status = 'open' for update;
  if v_row.id is null then
    insert into public.einvoice_ops_alerts (code, severity, provider, environment, company_id, detail_code, dedupe_key,
                                            notified_at, notify_count)
    values (p_code, p_severity, p_provider, p_environment, p_company_id,
            case when p_detail_code ~ '^[A-Z0-9_]{1,80}$' then p_detail_code end, v_key, now(), 1)
    returning * into v_row;
    v_created := true;
    v_notify := true;
  else
    v_created := false;
    v_notify := v_row.notified_at is null or v_row.notified_at < now() - v_renotify
                or (p_severity = 'critical' and v_row.severity = 'warning');
    update public.einvoice_ops_alerts a
       set occurrences = a.occurrences + 1,
           last_seen_at = now(),
           severity = case when p_severity = 'critical' then 'critical' else a.severity end,
           detail_code = coalesce(case when p_detail_code ~ '^[A-Z0-9_]{1,80}$' then p_detail_code end, a.detail_code),
           notified_at = case when v_notify then now() else a.notified_at end,
           notify_count = a.notify_count + case when v_notify then 1 else 0 end
     where a.id = v_row.id
    returning * into v_row;
  end if;
  return query select v_row.id, v_created, v_notify, v_row.occurrences;
end;
$function$;
revoke all on function public.esblu_einvoice_ops_alert_raise(text, text, text, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_ops_alert_raise(text, text, text, text, uuid, text, integer) to service_role;

create or replace function public.esblu_einvoice_ops_alert_resolve(
  p_code text,
  p_environment text,
  p_company_id uuid,
  p_resolved_by text
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
  if p_resolved_by is null or char_length(btrim(p_resolved_by)) not between 1 and 120 then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_OPERATOR_REQUIRED';
  end if;
  update public.einvoice_ops_alerts a
     set status = 'resolved', resolved_at = now(), resolved_by = btrim(p_resolved_by)
   where a.status = 'open'
     and a.dedupe_key = p_code || ':' || coalesce(p_environment, '-') || ':' || coalesce(p_company_id::text, 'platform');
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.esblu_einvoice_ops_alert_resolve(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_ops_alert_resolve(text, text, uuid, text) to service_role;

create or replace function public.esblu_einvoice_ops_alerts_open()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'critical', count(*) filter (where a.severity = 'critical'),
    'warning', count(*) filter (where a.severity = 'warning'),
    'codes', coalesce(jsonb_agg(distinct a.code) filter (where a.code is not null), '[]'::jsonb)
  )
  from public.einvoice_ops_alerts a where a.status = 'open';
$function$;
revoke all on function public.esblu_einvoice_ops_alerts_open() from public, anon, authenticated;
grant execute on function public.esblu_einvoice_ops_alerts_open() to service_role;

commit;
