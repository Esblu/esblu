-- =============================================================================
-- E-Faktúra — predprodukčný hardening (aditívne a vratné). NEAPLIKOVAŤ do produkcie bez schválenia.
--
-- (1) Udalosti webhook/feed: auditovateľný stav po vyčerpaní pokusov
--     - exhausted_at: nastaví sa, keď spracovanie zlyhá 5× (rovnaký limit ako webhook_retry),
--     - resolved_at / resolution_code / resolved_by: operátor udalosť uzavrie (bez payloadu),
--     - retencia (90 dní) NEMAŽE zlyhané a neuzavreté udalosti → nič sa potichu nestratí,
--     - manuálny requeue (reset pokusov) a rewind kurzora feedu — iba service_role, auditované,
--     - súhrn pre monitoring bez payloadu (esblu_einvoice_event_ops).
-- (2) Limit pokusov o aktiváciu príjmu FS kódom (Esblu-side, nad rámec poskytovateľa):
--     firma: 5 / 15 min a 20 / 24 h; používateľ: 10 / 1 h naprieč firmami.
--     Ukladá sa iba firma, používateľ, čas a výsledok — NIKDY kód ani jeho hash.
-- Všetko iba service_role (RLS bez politík pre authenticated/anon).
-- Rollback: supabase/rollback/20261007100000_einvoice_event_ops_enroll_limit_rollback.sql
-- =============================================================================

-- (1a) Stĺpce ------------------------------------------------------------------------------
alter table public.einvoice_webhook_events
  add column if not exists exhausted_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_code text,
  add column if not exists resolved_by text;
alter table public.einvoice_webhook_events drop constraint if exists einvoice_webhook_events_resolution_code_check;
alter table public.einvoice_webhook_events add constraint einvoice_webhook_events_resolution_code_check
  check (resolution_code is null or resolution_code ~ '^[A-Z0-9_]{1,60}$');
alter table public.einvoice_webhook_events drop constraint if exists einvoice_webhook_events_resolved_by_check;
alter table public.einvoice_webhook_events add constraint einvoice_webhook_events_resolved_by_check
  check (resolved_by is null or resolved_by ~ '^[A-Za-z0-9._@-]{1,80}$');
create index if not exists einvoice_webhook_events_exhausted_idx
  on public.einvoice_webhook_events (exhausted_at) where exhausted_at is not null and resolved_at is null;

-- Audit operátorských zásahov do udalostí (bez payloadu, bez tajomstiev).
create table if not exists public.einvoice_ops_audit (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor text not null check (actor ~ '^[A-Za-z0-9._@-]{1,80}$'),
  action text not null check (action in ('event_requeue', 'event_resolve', 'cursor_rewind')),
  target text not null check (char_length(target) between 1 and 200),
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{1,60}$'),
  detail jsonb check (detail is null or (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 512))
);
alter table public.einvoice_ops_audit enable row level security;
revoke all on table public.einvoice_ops_audit from public, anon, authenticated;
grant select, insert on table public.einvoice_ops_audit to service_role;

-- (1b) webhook_complete: pri 5. zlyhaní označiť vyčerpanie ------------------------------
create or replace function public.esblu_einvoice_webhook_complete(p_webhook_event_id uuid, p_status text, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path to ''
as $function$
begin
  if p_status not in ('processed', 'ignored', 'failed', 'rejected') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_WEBHOOK_STATUS_INVALID';
  end if;
  if p_code is not null and p_code !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_WEBHOOK_CODE_INVALID';
  end if;
  update public.einvoice_webhook_events w
  set processing_status = p_status, error = p_code, processed_at = now(),
      exhausted_at = case when p_status = 'failed' and w.attempts >= 5 then coalesce(w.exhausted_at, now()) else w.exhausted_at end
  where w.id = p_webhook_event_id and w.processing_status = 'received';
end;
$function$;
revoke all on function public.esblu_einvoice_webhook_complete(uuid, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_webhook_complete(uuid, text, text) to service_role;

-- (1c) webhook_retry: odmietnutie po limite = vyčerpané (auditovateľné) ----------------
create or replace function public.esblu_einvoice_webhook_retry(p_webhook_event_id uuid, p_max integer default 5)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_max is null or p_max not between 1 and 20 then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  update public.einvoice_webhook_events w
     set processing_status = 'received', attempts = w.attempts + 1, error = null, processed_at = null
   where w.id = p_webhook_event_id and w.processing_status = 'failed' and w.attempts < p_max
  returning w.id into v_id;
  if v_id is null then
    update public.einvoice_webhook_events w set exhausted_at = coalesce(w.exhausted_at, now())
     where w.id = p_webhook_event_id and w.processing_status = 'failed' and w.attempts >= p_max;
  end if;
  return v_id is not null;
end;
$function$;
revoke all on function public.esblu_einvoice_webhook_retry(uuid, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_webhook_retry(uuid, integer) to service_role;

-- (1d) Manuálny requeue: zlyhaná (aj vyčerpaná) udalosť smie ďalší pokus ----------------
--   Payload sa neukladá → spracovanie znova príde z poskytovateľa: feed (rewind kurzora)
--   alebo nové doručenie webhooku. Requeue iba resetuje počítadlo a audituje zásah.
create or replace function public.esblu_einvoice_event_requeue(p_webhook_event_id uuid, p_actor text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v public.einvoice_webhook_events%rowtype;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._@-]{1,80}$' or p_reason is null or p_reason !~ '^[A-Z0-9_]{1,60}$' then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  update public.einvoice_webhook_events w
     set attempts = 1, exhausted_at = null, resolved_at = null, resolution_code = null, resolved_by = null
   where w.id = p_webhook_event_id and w.processing_status = 'failed'
  returning * into v;
  if v.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_EVENT_NOT_REQUEUEABLE';
  end if;
  insert into public.einvoice_ops_audit (actor, action, target, reason_code, detail)
  values (p_actor, 'event_requeue', v.id::text, p_reason, jsonb_build_object('event', left(v.event, 120), 'source', case when v.delivery_id like 'feed:%' then 'feed' else 'webhook' end));
  return jsonb_build_object('id', v.id, 'event', v.event, 'source', case when v.delivery_id like 'feed:%' then 'feed' else 'webhook' end);
end;
$function$;

-- (1e) Uzavretie operátorom (napr. vyriešené ručne / neaplikovateľné) -------------------
create or replace function public.esblu_einvoice_event_resolve(p_webhook_event_id uuid, p_actor text, p_resolution text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._@-]{1,80}$' or p_resolution is null or p_resolution !~ '^[A-Z0-9_]{1,60}$' then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  update public.einvoice_webhook_events w
     set resolved_at = now(), resolution_code = p_resolution, resolved_by = p_actor
   where w.id = p_webhook_event_id and w.processing_status = 'failed' and w.resolved_at is null
  returning w.id into v_id;
  if v_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_EVENT_NOT_RESOLVABLE';
  end if;
  insert into public.einvoice_ops_audit (actor, action, target, reason_code) values (p_actor, 'event_resolve', v_id::text, p_resolution);
  return true;
end;
$function$;

-- (1f) Rewind kurzora feedu (iba dozadu, iba keď nebeží žiadny beh) ----------------------
create or replace function public.esblu_einvoice_event_cursor_rewind(p_provider text, p_environment text, p_to bigint, p_actor text, p_reason text)
returns bigint
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_old bigint;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._@-]{1,80}$' or p_reason is null or p_reason !~ '^[A-Z0-9_]{1,60}$' or p_to is null or p_to < 0 then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  select c.last_event_id into v_old from public.einvoice_event_cursors c
   where c.provider = p_provider and c.environment = p_environment
     and (c.locked_until is null or c.locked_until < now())
   for update;
  if v_old is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_CURSOR_BUSY_OR_MISSING';
  end if;
  if p_to >= v_old then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_CURSOR_REWIND_FORWARD';
  end if;
  update public.einvoice_event_cursors c set last_event_id = p_to, last_error_code = null, updated_at = now()
   where c.provider = p_provider and c.environment = p_environment;
  insert into public.einvoice_ops_audit (actor, action, target, reason_code, detail)
  values (p_actor, 'cursor_rewind', p_provider || ':' || p_environment, p_reason, jsonb_build_object('from', v_old, 'to', p_to));
  return p_to;
end;
$function$;

-- (1g) Retencia: zlyhané a neuzavreté udalosti sa NEMAŽÚ ---------------------------------
create or replace function public.esblu_einvoice_webhook_retention(p_older_than_days integer, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_days integer := greatest(coalesce(p_older_than_days, 90), 30);
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_events integer;
  v_rejections integer;
begin
  with d as (
    select w.id from public.einvoice_webhook_events w
    where w.received_at < now() - make_interval(days => v_days)
      and (w.processing_status in ('processed', 'ignored', 'rejected')
           or (w.processing_status = 'failed' and w.resolved_at is not null))
    order by w.received_at
    limit v_limit
  )
  delete from public.einvoice_webhook_events w using d where w.id = d.id;
  get diagnostics v_events = row_count;

  with d as (
    select r.provider, r.environment, r.reason, r.bucket_start from public.einvoice_webhook_rejections r
    where r.bucket_start < now() - make_interval(days => v_days)
    order by r.bucket_start
    limit v_limit
  )
  delete from public.einvoice_webhook_rejections r using d
  where r.provider = d.provider and r.environment = d.environment and r.reason = d.reason and r.bucket_start = d.bucket_start;
  get diagnostics v_rejections = row_count;

  return jsonb_build_object('older_than_days', v_days, 'webhook_events_deleted', v_events, 'rejection_buckets_deleted', v_rejections);
end;
$function$;

-- (1h) Súhrn pre monitoring (iba počty a kódy, žiadny payload ani firma) ------------------
create or replace function public.esblu_einvoice_event_ops()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'generated_at', now(),
    'failed_retryable', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'failed' and w.exhausted_at is null and w.resolved_at is null),
    'exhausted_unresolved', (select count(*) from public.einvoice_webhook_events w where w.exhausted_at is not null and w.resolved_at is null),
    'oldest_exhausted_age_seconds', coalesce((select extract(epoch from now() - min(w.exhausted_at))::bigint from public.einvoice_webhook_events w where w.exhausted_at is not null and w.resolved_at is null), 0),
    'exhausted_by_event', coalesce((select jsonb_object_agg(e, n) from (select left(w.event, 60) e, count(*) n from public.einvoice_webhook_events w where w.exhausted_at is not null and w.resolved_at is null group by 1) x), '{}'::jsonb),
    'stuck_received_15m', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'received' and w.received_at < now() - interval '15 minutes'),
    'cursors', coalesce((select jsonb_agg(jsonb_build_object(
        'provider', c.provider, 'environment', c.environment, 'last_event_id', c.last_event_id,
        'last_run_age_seconds', case when c.last_run_at is null then null else extract(epoch from now() - c.last_run_at)::bigint end,
        'last_error_code', c.last_error_code, 'locked', (c.locked_until is not null and c.locked_until > now())))
      from public.einvoice_event_cursors c), '[]'::jsonb)
  );
$function$;

revoke all on function public.esblu_einvoice_event_requeue(uuid, text, text) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_event_resolve(uuid, text, text) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_event_cursor_rewind(text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_webhook_retention(integer, integer) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_event_ops() from public, anon, authenticated;
grant execute on function public.esblu_einvoice_event_requeue(uuid, text, text) to service_role;
grant execute on function public.esblu_einvoice_event_resolve(uuid, text, text) to service_role;
grant execute on function public.esblu_einvoice_event_cursor_rewind(text, text, bigint, text, text) to service_role;
grant execute on function public.esblu_einvoice_webhook_retention(integer, integer) to service_role;
grant execute on function public.esblu_einvoice_event_ops() to service_role;

-- (2) Limit pokusov o aktiváciu príjmu (FS kód) -------------------------------------------
create table if not exists public.einvoice_enroll_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null,
  attempted_at timestamptz not null default now(),
  outcome text check (outcome is null or outcome ~ '^[A-Z0-9_]{1,60}$')
);
create index if not exists einvoice_enroll_attempts_company_idx on public.einvoice_enroll_attempts (company_id, attempted_at desc);
create index if not exists einvoice_enroll_attempts_user_idx on public.einvoice_enroll_attempts (user_id, attempted_at desc);
alter table public.einvoice_enroll_attempts enable row level security;
revoke all on table public.einvoice_enroll_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.einvoice_enroll_attempts to service_role;

-- Atomicky: kontrola limitov + záznam pokusu (advisory lock na firmu). Vráti allowed a retry_after.
create or replace function public.esblu_einvoice_enroll_attempt_begin(p_company_id uuid, p_user_id uuid)
returns table (allowed boolean, attempt_id uuid, retry_after_seconds integer, reason text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_c15 integer;
  v_c24 integer;
  v_u60 integer;
  v_oldest timestamptz;
  v_id uuid;
begin
  if p_company_id is null or p_user_id is null then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('einvoice_enroll:' || p_company_id::text, 0));
  select count(*) into v_c15 from public.einvoice_enroll_attempts a where a.company_id = p_company_id and a.attempted_at > now() - interval '15 minutes';
  if v_c15 >= 5 then
    select min(a.attempted_at) into v_oldest from public.einvoice_enroll_attempts a where a.company_id = p_company_id and a.attempted_at > now() - interval '15 minutes';
    return query select false, null::uuid, greatest(1, ceil(extract(epoch from (v_oldest + interval '15 minutes') - now()))::integer), 'COMPANY_15M';
    return;
  end if;
  select count(*) into v_c24 from public.einvoice_enroll_attempts a where a.company_id = p_company_id and a.attempted_at > now() - interval '24 hours';
  if v_c24 >= 20 then
    select min(a.attempted_at) into v_oldest from public.einvoice_enroll_attempts a where a.company_id = p_company_id and a.attempted_at > now() - interval '24 hours';
    return query select false, null::uuid, greatest(1, ceil(extract(epoch from (v_oldest + interval '24 hours') - now()))::integer), 'COMPANY_24H';
    return;
  end if;
  select count(*) into v_u60 from public.einvoice_enroll_attempts a where a.user_id = p_user_id and a.attempted_at > now() - interval '1 hour';
  if v_u60 >= 10 then
    select min(a.attempted_at) into v_oldest from public.einvoice_enroll_attempts a where a.user_id = p_user_id and a.attempted_at > now() - interval '1 hour';
    return query select false, null::uuid, greatest(1, ceil(extract(epoch from (v_oldest + interval '1 hour') - now()))::integer), 'USER_1H';
    return;
  end if;
  insert into public.einvoice_enroll_attempts (company_id, user_id) values (p_company_id, p_user_id) returning id into v_id;
  -- Udržiavanie: staršie než 30 dní (iba táto firma, ohraničene).
  delete from public.einvoice_enroll_attempts a
   where a.id in (select x.id from public.einvoice_enroll_attempts x where x.company_id = p_company_id and x.attempted_at < now() - interval '30 days' limit 100);
  return query select true, v_id, 0, null::text;
end;
$function$;

create or replace function public.esblu_einvoice_enroll_attempt_finish(p_attempt_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_outcome is null or p_outcome !~ '^[A-Z0-9_]{1,60}$' then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  update public.einvoice_enroll_attempts a set outcome = p_outcome where a.id = p_attempt_id and a.outcome is null;
end;
$function$;

revoke all on function public.esblu_einvoice_enroll_attempt_begin(uuid, uuid) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_enroll_attempt_finish(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_enroll_attempt_begin(uuid, uuid) to service_role;
grant execute on function public.esblu_einvoice_enroll_attempt_finish(uuid, text) to service_role;
