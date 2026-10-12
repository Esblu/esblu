-- =============================================================================
-- Subscriptions platform — lifecycle hardening (FORWARD-ONLY, 2026-10-11)
--
-- Nadväzuje na 20261008120000_subscriptions_platform.sql (NEMENÍ ju).
-- NEAPLIKOVANÉ na produkciu ani staging — overené iba v PGlite.
--
--  1) Kanonické stavy rozšírené o pending, grace_period, account_hold,
--     refunded, revoked (+ pôvodné incomplete/past_due/unpaid ostávajú kvôli
--     spätnej kompatibilite). cancel_at_period_end je PRÍZNAK, nie stav.
--  2) Jedna pravda pre „otvorený / oprávňujúci / terminálny" stav (helper
--     funkcie) — používa apply_event, sync, purchase intent aj options.
--  3) refunded / revoked = okamžité odvolanie nárokov (dáta ostávajú);
--     review_flag pre spor / čiastočný refund (rozhoduje operátor + CLIA).
--  4) Reconciliation (self-healing): kandidáti, záznam výsledku, backoff,
--     dead-letter. Opravy idú tou istou pipeline (record → apply).
--  5) Vysvetliteľnosť nárokov (esblu_billing_explain_my_entitlements).
--  6) Cross-provider: purchase_options vracia 'current' (managed_via) a
--     blokuje druhý nákup; get_my_subscription vracia managed_via.
--  7) Prevádzkový prehľad bez osobných údajov (esblu_billing_ops_status).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Stavové helpery (IMMUTABLE, bez prístupu k dátam)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_billing_canonical_statuses()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['none', 'pending', 'incomplete', 'trialing', 'active', 'grace_period', 'past_due',
               'account_hold', 'unpaid', 'paused', 'canceled', 'expired', 'refunded', 'revoked']::text[]
$function$;

-- „Otvorené" predplatné = existuje vzťah s providerom, druhý nákup je zakázaný.
create or replace function public.esblu_billing_status_is_open(p_status text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select coalesce(p_status in ('pending', 'incomplete', 'trialing', 'active', 'grace_period', 'past_due',
                               'account_hold', 'unpaid', 'paused'), false)
$function$;

-- Stav, ktorý (v rámci platnosti obdobia/grace) oprávňuje na nároky.
create or replace function public.esblu_billing_status_is_entitling(p_status text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select coalesce(p_status in ('trialing', 'active', 'grace_period', 'past_due'), false)
$function$;

-- Ukončený vzťah — to isté provider ID sa neskorším eventom neoživí.
create or replace function public.esblu_billing_status_is_terminal(p_status text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select coalesce(p_status in ('canceled', 'expired', 'refunded', 'revoked'), false)
$function$;

create or replace function public.esblu_billing_managed_via(p_provider text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select case p_provider
    when 'stripe' then 'web' when 'fake' then 'web'
    when 'google' then 'google_play' when 'apple' then 'app_store'
    when 'manual' then 'esblu_support' end
$function$;

-- Smie táto platforma spravovať (zrušiť/obnoviť/zmeniť) predplatné daného providera?
create or replace function public.esblu_billing_manage_here(p_provider text, p_platform text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_provider in ('stripe', 'fake') then p_platform = 'web' -- appka iba „spravujete cez web"
    when p_provider = 'google' then p_platform = 'android'
    when p_provider = 'apple' then p_platform = 'ios'
    else false end
$function$;

grant execute on function public.esblu_billing_canonical_statuses() to authenticated, service_role;
grant execute on function public.esblu_billing_status_is_open(text) to authenticated, service_role;
grant execute on function public.esblu_billing_status_is_entitling(text) to authenticated, service_role;
grant execute on function public.esblu_billing_status_is_terminal(text) to authenticated, service_role;
grant execute on function public.esblu_billing_managed_via(text) to authenticated, service_role;
grant execute on function public.esblu_billing_manage_here(text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2) subscription_accounts: nové stavy + review_flag
-- -----------------------------------------------------------------------------
alter table public.subscription_accounts drop constraint if exists subscription_accounts_status_check;
alter table public.subscription_accounts add constraint subscription_accounts_status_check
  check (status = any (public.esblu_billing_canonical_statuses()));

alter table public.subscription_accounts add column if not exists review_flag text null;
alter table public.subscription_accounts drop constraint if exists subscription_accounts_review_flag_check;
alter table public.subscription_accounts add constraint subscription_accounts_review_flag_check
  check (review_flag is null or review_flag in ('dispute_open', 'refund_partial', 'refund_reversed'));

alter table public.subscription_accounts drop constraint if exists subscription_accounts_paid_has_plan;
alter table public.subscription_accounts add constraint subscription_accounts_paid_has_plan
  check (status in ('none', 'canceled', 'expired', 'refunded', 'revoked') or plan_code is not null);

comment on column public.subscription_accounts.review_flag is
  'Rizikový príznak (dispute_open / refund_partial / refund_reversed) — nemení nároky, iba operátorský audit.';

-- -----------------------------------------------------------------------------
-- 3) Reconciliation (self-healing). Jeden riadok na predplatné firmy.
-- -----------------------------------------------------------------------------
create table if not exists public.billing_reconciliation (
  account_id uuid primary key references public.subscription_accounts (id) on delete cascade,
  last_checked_at timestamptz null,
  last_result text null,
  last_error_code text null,
  consecutive_failures integer not null default 0,
  next_check_at timestamptz not null default now(),
  dead_letter boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint billing_reconciliation_result_check check (
    last_result is null or last_result in ('in_sync', 'corrected', 'error', 'skipped')),
  constraint billing_reconciliation_error_format check (
    last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  constraint billing_reconciliation_failures_check check (consecutive_failures >= 0)
);

create index if not exists billing_reconciliation_due_idx
  on public.billing_reconciliation (next_check_at) where not dead_letter;

alter table public.billing_reconciliation enable row level security;
revoke all on table public.billing_reconciliation from public, anon, authenticated;
grant select, insert, update, delete on table public.billing_reconciliation to service_role;

-- Kandidáti na overenie u providera: otvorené predplatné, ktorému končí obdobie
-- / grace, alebo ktoré sa dlho neoverilo. Dead-letter sa vynecháva.
create or replace function public.esblu_billing_reconcile_candidates(p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_id', c.id, 'company_id', c.company_id, 'billing_provider', c.billing_provider,
           'provider_environment', c.provider_environment, 'provider_subscription_id', c.provider_subscription_id,
           'provider_customer_id', c.provider_customer_id, 'status', c.status,
           'current_period_end', c.current_period_end, 'cancel_at_period_end', c.cancel_at_period_end,
           'plan_code', c.plan_code) order by c.ord), '[]'::jsonb)
  from (
    select a.*, row_number() over (order by coalesce(r.last_checked_at, '-infinity'::timestamptz), a.id) as ord
    from public.subscription_accounts a
    left join public.billing_reconciliation r on r.account_id = a.id
    where a.provider_subscription_id is not null
      and a.billing_provider in ('stripe', 'apple', 'google', 'fake')
      and coalesce(r.dead_letter, false) = false
      and coalesce(r.next_check_at, '-infinity'::timestamptz) <= now()
      and (public.esblu_billing_status_is_open(a.status)
           -- terminálny stav ešte raz overiť, ak skončil nedávno (neskorý refund/revoke)
           or (public.esblu_billing_status_is_terminal(a.status) and a.ended_at > now() - interval '30 days'))
      and (r.last_checked_at is null
           or r.last_checked_at < now() - interval '24 hours'
           or coalesce(a.grace_until, a.current_period_end) < now() + interval '1 day')
    order by coalesce(r.last_checked_at, '-infinity'::timestamptz), a.id
    limit greatest(1, least(coalesce(p_limit, 50), 500))
  ) c
$function$;

revoke all on function public.esblu_billing_reconcile_candidates(integer) from public, anon, authenticated;
grant execute on function public.esblu_billing_reconcile_candidates(integer) to service_role;

-- Výsledok jedného overenia. Chyba → exponenciálny backoff (15 min · 2^n, max 24 h);
-- po 8 chybách za sebou dead-letter (operátor). Úspech resetuje počítadlo.
create or replace function public.esblu_billing_reconcile_record(
  p_account_id uuid, p_result text, p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row record;
  v_failures integer;
  v_dead boolean;
  v_next timestamptz;
begin
  if p_result is null or p_result not in ('in_sync', 'corrected', 'error', 'skipped') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_RECONCILE_RESULT';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,80}$' then
    p_error_code := 'INVALID_ERROR_CODE';
  end if;

  insert into public.billing_reconciliation (account_id) values (p_account_id)
  on conflict (account_id) do nothing;
  select * into v_row from public.billing_reconciliation r where r.account_id = p_account_id for update;

  if p_result = 'error' then
    v_failures := v_row.consecutive_failures + 1;
    v_dead := v_failures >= 8;
    v_next := now() + least(interval '24 hours', interval '15 minutes' * power(2, v_failures - 1));
  else
    v_failures := 0;
    v_dead := false;
    v_next := now() + interval '24 hours';
  end if;

  update public.billing_reconciliation r set
    last_checked_at = now(), last_result = p_result,
    last_error_code = case when p_result = 'error' then coalesce(p_error_code, 'UNKNOWN') end,
    consecutive_failures = v_failures, dead_letter = v_dead, next_check_at = v_next, updated_at = now()
  where r.account_id = p_account_id;

  return jsonb_build_object('consecutive_failures', v_failures, 'dead_letter', v_dead, 'next_check_at', v_next);
end
$function$;

revoke all on function public.esblu_billing_reconcile_record(uuid, text, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_reconcile_record(uuid, text, text) to service_role;

-- Operátor: vrátiť dead-letter do fronty (po oprave príčiny).
create or replace function public.esblu_billing_reconcile_requeue(p_account_id uuid)
returns void
language sql
security definer
set search_path to ''
as $function$
  update public.billing_reconciliation set dead_letter = false, consecutive_failures = 0,
         next_check_at = now(), last_checked_at = null, updated_at = now()
  where account_id = p_account_id
$function$;

revoke all on function public.esblu_billing_reconcile_requeue(uuid) from public, anon, authenticated;
grant execute on function public.esblu_billing_reconcile_requeue(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 4) Vysvetliteľnosť nárokov: prečo je nárok aktívny, odkiaľ, do kedy.
--    Každý člen firmy vidí kľúč/aktívnosť/zdroj/platnosť (to isté ako
--    esblu_get_my_company_entitlements); referenciu na predplatné a providera
--    iba MANAGE/VIEW rola (owner, billing.manage admin, finance view).
-- -----------------------------------------------------------------------------
create or replace function public.esblu_billing_explain_my_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_company_id uuid := (v_access ->> 'company_id')::uuid;
  v_view boolean := (v_access ->> 'can_view')::boolean;
  v_items jsonb := '[]'::jsonb;
  v_key record;
  v_res jsonb;
  v_g_found boolean;
  v_g_from timestamptz;
  v_g_ref text;
  v_acc record;
begin
  select * into v_acc from public.subscription_accounts a where a.company_id = v_company_id;
  for v_key in select k.key from public.entitlement_catalog k order by k.sort_order loop
    v_res := public.esblu_resolve_entitlement(v_company_id, v_key.key);
    -- Skaláry namiesto record: neinicializovaný record pri firme bez grantov
    -- (nová firma v triale) by v PL/pgSQL vyhodil chybu.
    v_g_found := false;
    v_g_from := null;
    v_g_ref := null;
    if v_res ->> 'entitlement_id' is not null then
      select true, e.valid_from, e.external_ref into v_g_found, v_g_from, v_g_ref
      from public.company_entitlements e where e.id = (v_res ->> 'entitlement_id')::uuid;
      v_g_found := coalesce(v_g_found, false);
    end if;
    v_items := v_items || jsonb_strip_nulls(jsonb_build_object(
      'key', v_key.key,
      'active', (v_res ->> 'active')::boolean,
      'source', v_res ->> 'source',
      'reason', v_res ->> 'reason',
      'limit', v_res -> 'limit',
      'limit_period', v_res ->> 'limit_period',
      'valid_from', v_g_from,
      'valid_until', v_res ->> 'valid_until',
      'explanation', case
        when not (v_res ->> 'active')::boolean then 'not_entitled'
        when v_res ->> 'source' = 'trial' then 'trial_window'
        when v_res ->> 'source' = 'subscription' then 'subscription_' || coalesce(v_acc.status, 'none')
        when v_res ->> 'source' = 'manual' then 'manual_grant'
        when v_res ->> 'source' = 'beta_compat' then 'beta_grant'
        else 'grant' end,
      'reference', case when v_view and v_g_found then v_g_ref end,
      'provider', case when v_view and v_res ->> 'source' = 'subscription' then v_acc.billing_provider end,
      'managed_via', case when v_res ->> 'source' = 'subscription'
                          then public.esblu_billing_managed_via(v_acc.billing_provider) end));
  end loop;

  return jsonb_build_object('company_id', v_company_id, 'server_time', now(),
                            'subscription_status', coalesce(v_acc.status, 'none'), 'entitlements', v_items);
end
$function$;

revoke all on function public.esblu_billing_explain_my_entitlements() from public, anon;
grant execute on function public.esblu_billing_explain_my_entitlements() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5) Prevádzkový prehľad (service_role): iba technické metadáta, žiadne
--    osobné ani platobné údaje, žiadne telá eventov.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_billing_ops_status(p_company_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'account', (select jsonb_build_object('id', a.id, 'status', a.status, 'provider', a.billing_provider,
                         'environment', a.provider_environment, 'review_flag', a.review_flag,
                         'period_end', a.current_period_end, 'grace_until', a.grace_until,
                         'state_at', a.provider_state_at, 'version', a.version)
                from public.subscription_accounts a where a.company_id = p_company_id),
    'reconciliation', (select jsonb_build_object('last_checked_at', r.last_checked_at, 'last_result', r.last_result,
                         'last_error_code', r.last_error_code, 'consecutive_failures', r.consecutive_failures,
                         'dead_letter', r.dead_letter, 'next_check_at', r.next_check_at)
                       from public.billing_reconciliation r
                       join public.subscription_accounts a on a.id = r.account_id
                       where a.company_id = p_company_id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                  'provider', e.provider, 'event_ref', left(encode(sha256(convert_to(e.provider_event_id, 'UTF8')), 'hex'), 16),
                  'type', e.event_type, 'status', e.status, 'attempts', e.attempts, 'error_code', e.error_code,
                  'received_at', e.received_at, 'processed_at', e.processed_at) order by e.received_at desc), '[]'::jsonb)
               from (select * from public.billing_events e where e.company_id = p_company_id
                     order by e.received_at desc limit 50) e))
$function$;

revoke all on function public.esblu_billing_ops_status(uuid) from public, anon, authenticated;
grant execute on function public.esblu_billing_ops_status(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 6) Aktualizované funkcie z 20261008120000 (rovnaké podpisy; zmeny označené)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_billing_sync_entitlements(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_acc record;
  v_until timestamptz;
  v_entitled boolean := false;
  v_ref text;
  v_count integer := 0;
  v_item record;
begin
  select * into v_acc from public.subscription_accounts a where a.company_id = p_company_id;

  if found and v_acc.plan_code is not null then
    v_ref := 'subscription_account:' || v_acc.id::text;
    if v_acc.status in ('active', 'trialing') and v_acc.current_period_end is not null then
      -- Krátky buffer na oneskorený renewal webhook (nie grace pri zlyhaní platby).
      v_until := v_acc.current_period_end + interval '2 days';
      v_entitled := v_until > now();
    elsif v_acc.status = 'past_due' and v_acc.grace_until is not null then
      v_until := v_acc.grace_until;
      v_entitled := v_until > now();
    elsif v_acc.status = 'grace_period' and coalesce(v_acc.grace_until, v_acc.current_period_end) is not null then
      -- Store grace period (Google IN_GRACE_PERIOD / Apple billing retry s grace):
      -- prístup trvá do konca grace podľa providera.
      v_until := coalesce(v_acc.grace_until, v_acc.current_period_end);
      v_entitled := v_until > now();
    end if;
    -- Všetky ostatné stavy (pending, account_hold, unpaid, paused, canceled,
    -- expired, refunded, revoked) → nároky odvolané (dáta ostávajú).
  end if;

  if v_entitled then
    for v_item in
      select pe.entitlement_key, pe.limit_value, pe.limit_period
      from public.subscription_plan_entitlements pe where pe.plan_code = v_acc.plan_code
    loop
      insert into public.company_entitlements
        (company_id, entitlement_key, source, status, valid_from, valid_until, limit_value, limit_period, external_ref, note)
      values
        (p_company_id, v_item.entitlement_key, 'subscription', 'active',
         least(coalesce(v_acc.current_period_start, now()), now()), v_until,
         v_item.limit_value, v_item.limit_period, v_ref, 'plan=' || v_acc.plan_code)
      on conflict (company_id, entitlement_key) where source = 'subscription'
      do update set status = 'active',
                    valid_from = least(public.company_entitlements.valid_from, excluded.valid_from),
                    valid_until = excluded.valid_until,
                    limit_value = excluded.limit_value,
                    limit_period = excluded.limit_period,
                    external_ref = excluded.external_ref,
                    note = excluded.note;
      v_count := v_count + 1;
    end loop;

    -- Downgrade: nároky mimo plánu sa odvolajú (dáta ostávajú).
    update public.company_entitlements e
    set status = 'revoked'
    where e.company_id = p_company_id and e.source = 'subscription' and e.status <> 'revoked'
      and not exists (select 1 from public.subscription_plan_entitlements pe
                      where pe.plan_code = v_acc.plan_code and pe.entitlement_key = e.entitlement_key);
  else
    update public.company_entitlements e
    set status = 'revoked'
    where e.company_id = p_company_id and e.source = 'subscription' and e.status <> 'revoked';
  end if;

  return v_count;
end
$function$;

revoke all on function public.esblu_billing_sync_entitlements(uuid) from public, anon, authenticated;
grant execute on function public.esblu_billing_sync_entitlements(uuid) to service_role;

create or replace function public.esblu_billing_apply_event(p_event_id uuid, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_event record;
  v_company_id uuid;
  v_checkout_id uuid;
  v_checkout_price text;
  v_checkout_status text;
  v_checkout_method text;
  v_checkout_platform text;
  v_checkout_token text;
  v_checkout_reporting text;
  v_price record;
  v_acc record;
  v_state_at timestamptz;
  v_status text;
  v_sub_id text := nullif(p_state ->> 'provider_subscription_id', '');
  v_cust_id text := nullif(p_state ->> 'provider_customer_id', '');
  v_token text := nullif(p_state ->> 'account_token', '');
  v_checkout_ref uuid;
  v_grace_days integer := 7;
  v_result text;
  v_summary jsonb;
begin
  select * into v_event from public.billing_events e where e.id = p_event_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_EVENT_NOT_FOUND';
  end if;
  if v_event.status <> 'received' then
    -- Už spracované (duplicitné doručenie paralelne) → no-op.
    return jsonb_build_object('result', 'duplicate', 'status', v_event.status);
  end if;

  v_status := p_state ->> 'status';
  v_state_at := coalesce((p_state ->> 'state_at')::timestamptz, v_event.provider_created_at, now());
  v_summary := jsonb_strip_nulls(jsonb_build_object(
    'status', v_status, 'subscription', v_sub_id, 'price', p_state ->> 'provider_price_id',
    'period_end', p_state ->> 'current_period_end',
    'cancel_at_period_end', p_state -> 'cancel_at_period_end'));

  if v_status is null or not (v_status = any (public.esblu_billing_canonical_statuses())) or v_status = 'none' then
    update public.billing_events set status = 'failed', error_code = 'INVALID_STATE', summary = v_summary,
      processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'INVALID_STATE');
  end if;

  -- (a) Firma: iba z našich tabuliek.
  begin
    v_checkout_ref := nullif(p_state ->> 'checkout_ref', '')::uuid;
  exception when invalid_text_representation then
    v_checkout_ref := null;
  end;

  if v_checkout_ref is not null then
    select s.id, s.company_id, s.provider_price_id, s.status, s.purchase_method, s.platform, s.store_token, s.store_reporting
    into v_checkout_id, v_company_id, v_checkout_price, v_checkout_status, v_checkout_method, v_checkout_platform,
         v_checkout_token, v_checkout_reporting
    from public.billing_checkout_sessions s
    where s.id = v_checkout_ref and s.provider = v_event.provider and s.environment = v_event.environment;
  end if;

  if v_company_id is null and v_sub_id is not null then
    select l.company_id into v_company_id from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.link_kind = 'subscription' and l.external_id = v_sub_id;
  end if;
  if v_company_id is null and v_token is not null then
    select l.company_id into v_company_id from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.link_kind = 'account_token' and l.external_id = v_token;
  end if;
  if v_company_id is null and v_cust_id is not null then
    select l.company_id into v_company_id from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.link_kind = 'customer' and l.external_id = v_cust_id;
  end if;

  if v_company_id is null then
    update public.billing_events set status = 'failed', error_code = 'UNKNOWN_COMPANY', summary = v_summary,
      processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'UNKNOWN_COMPANY');
  end if;

  -- Identifikátor providera nesmie patriť inej firme (Company A event ≠ Company B).
  if exists (
    select 1 from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.company_id <> v_company_id
      and ((l.link_kind = 'subscription' and l.external_id = v_sub_id)
        or (l.link_kind = 'customer' and l.external_id = v_cust_id)
        or (l.link_kind = 'account_token' and l.external_id = v_token))
  ) then
    update public.billing_events set status = 'failed', error_code = 'CROSS_TENANT_IDENTIFIER',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'CROSS_TENANT_IDENTIFIER');
  end if;

  -- (b) Plán: iba cez server-side mapovanie price → plán.
  select bp.* into v_price from public.billing_provider_prices bp
  where bp.provider = v_event.provider and bp.environment = v_event.environment
    and bp.provider_price_id = p_state ->> 'provider_price_id';
  if not found then
    update public.billing_events set status = 'failed', error_code = 'UNKNOWN_PRICE',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'UNKNOWN_PRICE');
  end if;

  -- Checkout zámer: provider musí predať presne to, čo server schválil.
  if v_checkout_id is not null and v_checkout_price <> v_price.provider_price_id then
    update public.billing_checkout_sessions set status = 'rejected' where id = v_checkout_id;
    update public.billing_events set status = 'failed', error_code = 'PRICE_MISMATCH',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'PRICE_MISMATCH');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':billing', 0));

  insert into public.subscription_accounts (company_id) values (v_company_id)
  on conflict (company_id) do nothing;
  select * into v_acc from public.subscription_accounts a where a.company_id = v_company_id for update;

  -- (c) Jedna firma = jedno predplatné. Iný provider / iné predplatné počas
  --     aktívneho stavu = konflikt pre operátora (žiadny prepis, žiadny zisk nárokov).
  if public.esblu_billing_status_is_open(v_acc.status)
     and v_acc.provider_subscription_id is not null
     and (v_acc.billing_provider is distinct from v_event.provider
          or v_acc.provider_subscription_id is distinct from v_sub_id)
     -- Výnimka: ten istý provider výslovne nahrádza predplatné (Google
     -- linkedPurchaseToken pri upgrade/downgrade = nový purchaseToken).
     -- coalesce: bez replaces_subscription_id by porovnanie s NULL dalo NULL a
     -- NOT(NULL) by ochranu potichu vypol (oprava chyby z 20261008120000).
     and not coalesce(v_acc.billing_provider = v_event.provider
              and v_acc.provider_subscription_id = nullif(p_state ->> 'replaces_subscription_id', ''), false)
  then
    update public.billing_events set status = 'conflict', error_code = 'SECOND_ACTIVE_SUBSCRIPTION',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'conflict', 'error', 'SECOND_ACTIVE_SUBSCRIPTION');
  end if;

  -- (d) Poradie: starší stav toho istého predplatného nikdy neprepíše novší.
  if v_acc.provider_subscription_id is not distinct from v_sub_id
     and v_acc.provider_state_at is not null and v_state_at < v_acc.provider_state_at then
    update public.billing_events set status = 'stale', company_id = v_company_id, summary = v_summary,
      processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'stale');
  end if;

  -- (e) Ukončené predplatné toho istého ID sa nedá oživiť neskorším eventom.
  if v_acc.provider_subscription_id is not distinct from v_sub_id
     and public.esblu_billing_status_is_terminal(v_acc.status) and v_acc.ended_at is not null
     and not public.esblu_billing_status_is_terminal(v_status) then
    update public.billing_events set status = 'stale', error_code = 'TERMINAL_STATE',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'stale', 'error', 'TERMINAL_STATE');
  end if;

  update public.subscription_accounts a set
    plan_code = v_price.plan_code,
    billing_interval = v_price.billing_interval,
    status = v_status,
    billing_provider = v_event.provider,
    provider_environment = v_event.environment,
    provider_customer_id = coalesce(v_cust_id, a.provider_customer_id),
    provider_subscription_id = coalesce(v_sub_id, a.provider_subscription_id),
    current_period_start = nullif(p_state ->> 'current_period_start', '')::timestamptz,
    current_period_end = nullif(p_state ->> 'current_period_end', '')::timestamptz,
    cancel_at_period_end = coalesce((p_state ->> 'cancel_at_period_end')::boolean, false),
    canceled_at = nullif(p_state ->> 'canceled_at', '')::timestamptz,
    ended_at = case when public.esblu_billing_status_is_terminal(v_status)
                    then coalesce(nullif(p_state ->> 'ended_at', '')::timestamptz, v_state_at) end,
    provider_trial_start = nullif(p_state ->> 'trial_start', '')::timestamptz,
    provider_trial_end = nullif(p_state ->> 'trial_end', '')::timestamptz,
    -- Grace: provider (Apple gracePeriodExpiresDate / Google expiryTime počas
    -- IN_GRACE_PERIOD) má prednosť; Stripe past_due = 7 dní od prvého zlyhania.
    grace_until = case
      when v_status in ('past_due', 'grace_period') then coalesce(
        nullif(p_state ->> 'grace_until', '')::timestamptz,
        case when a.status = v_status then a.grace_until end,
        v_state_at + make_interval(days => v_grace_days))
      else null end,
    -- Rizikový príznak (spor/čiastočný refund) — iba ak ho event výslovne nesie.
    review_flag = case when p_state ? 'review_flag' then nullif(p_state ->> 'review_flag', '') else a.review_flag end,
    -- Kanál vzniku: z nášho nákupného zámeru; nové predplatné bez zámeru
    -- (napr. nákup priamo v App Store / Play) = natívny kanál obchodu.
    purchase_method = case
      when v_checkout_id is not null then v_checkout_method
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then case v_event.provider when 'apple' then 'apple_iap' when 'google' then 'google_play' else null end
      else a.purchase_method end,
    purchase_platform = case
      when v_checkout_id is not null then v_checkout_platform
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then case v_event.provider when 'apple' then 'ios' when 'google' then 'android' else null end
      else a.purchase_platform end,
    store_reporting = case
      when v_checkout_id is not null then coalesce(v_checkout_reporting, 'none')
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then 'none'
      else a.store_reporting end,
    store_token = case
      when v_checkout_id is not null then v_checkout_token
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then null
      else a.store_token end,
    provider_state_at = v_state_at,
    last_event_id = p_event_id,
    version = a.version + 1,
    updated_at = now()
  where a.id = v_acc.id;

  -- Väzby (idempotentne; unique constraint chráni pred cudzou firmou).
  if v_sub_id is not null then
    insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
    values (v_company_id, v_event.provider, v_event.environment, 'subscription', v_sub_id)
    on conflict do nothing;
  end if;
  if v_cust_id is not null then
    insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
    values (v_company_id, v_event.provider, v_event.environment, 'customer', v_cust_id)
    on conflict do nothing;
  end if;
  if v_token is not null then
    insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
    values (v_company_id, v_event.provider, v_event.environment, 'account_token', v_token)
    on conflict do nothing;
  end if;

  if v_checkout_id is not null and v_checkout_status in ('created', 'open') then
    update public.billing_checkout_sessions set status = 'completed', completed_at = now()
    where id = v_checkout_id;
  end if;

  -- (f) Až teraz prepočet nárokov.
  perform public.esblu_billing_sync_entitlements(v_company_id);

  -- (g) Platba predplatného kúpeného kanálom s reportingom obchodu → outbox.
  if jsonb_typeof(p_state -> 'charge') = 'object' then
    perform public.esblu_billing_queue_store_report(v_acc.id, p_state -> 'charge');
  end if;

  update public.billing_events set status = 'processed', company_id = v_company_id, summary = v_summary,
    processed_at = now(), error_code = null where id = p_event_id;

  v_result := 'applied';
  return jsonb_build_object('result', v_result, 'company_id', v_company_id, 'plan_code', v_price.plan_code,
                            'status', v_status);
end
$function$;

revoke all on function public.esblu_billing_apply_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_billing_apply_event(uuid, jsonb) to service_role;

create or replace function public.esblu_billing_purchase_options(p_platform text, p_storefront text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_cfg record;
  v_methods text[];
  v_items jsonb := '[]'::jsonb;
  v_method text;
  v_provider text;
  v_acc record;
  v_open boolean := false;
begin
  if p_platform is null or p_platform not in ('web', 'android', 'ios') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PLATFORM_INVALID';
  end if;
  select * into v_cfg from public.billing_runtime_config c where c.id;
  v_methods := public.esblu_billing_resolve_methods(p_platform, p_storefront);

  foreach v_method in array v_methods loop
    v_provider := public.esblu_billing_method_info(v_method) ->> 'provider';
    if v_provider = 'web' then
      v_provider := nullif(v_cfg.web_provider, 'none');
    end if;
    if v_method = 'view_only' or v_provider is null then
      continue;
    end if;
    v_items := v_items || jsonb_build_object(
      'method', v_method,
      'provider', v_provider,
      'reporting', public.esblu_billing_method_info(v_method) ->> 'reporting',
      'plans', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'plan_code', p.plan_code,
                 'intervals', (
                   select coalesce(jsonb_agg(jsonb_build_object(
                            'interval', bp.billing_interval,
                            -- Store product ID je verejný (StoreKit/Play ho potrebujú); Stripe price nie.
                            'store_product_id', case when v_provider in ('apple', 'google') then bp.provider_price_id end)
                          order by bp.billing_interval), '[]'::jsonb)
                   from public.billing_provider_prices bp
                   where bp.plan_code = p.plan_code and bp.provider = v_provider
                     and bp.environment = v_cfg.environment and bp.active),
                 'entitlements', (
                   select coalesce(jsonb_agg(jsonb_build_object('key', pe.entitlement_key, 'limit', pe.limit_value,
                                                                'limit_period', pe.limit_period)
                                             order by pe.entitlement_key), '[]'::jsonb)
                   from public.subscription_plan_entitlements pe where pe.plan_code = p.plan_code))
               order by p.sort_order), '[]'::jsonb)
        from public.subscription_plans p
        where (p.status = 'approved' or (p.status = 'test_fixture' and v_cfg.environment = 'test'))
          and exists (select 1 from public.billing_provider_prices bp
                      where bp.plan_code = p.plan_code and bp.provider = v_provider
                        and bp.environment = v_cfg.environment and bp.active)));
  end loop;

  select a.status, a.billing_provider, a.cancel_at_period_end, a.current_period_end
  into v_acc
  from public.subscription_accounts a where a.company_id = (v_access ->> 'company_id')::uuid;
  v_open := found and public.esblu_billing_status_is_open(v_acc.status);

  return jsonb_build_object(
    -- Buy anywhere, use everywhere: ak firma už má otvorené predplatné, žiadny
    -- kanál neponúkne druhý nákup — UI ukáže, kde sa predplatné spravuje.
    'current', case when v_open then jsonb_build_object(
        'status', v_acc.status,
        'managed_via', public.esblu_billing_managed_via(v_acc.billing_provider),
        'manage_here', public.esblu_billing_manage_here(v_acc.billing_provider, p_platform),
        'cancel_at_period_end', v_acc.cancel_at_period_end) end,
    'purchase_allowed', not v_open and jsonb_array_length(v_items) > 0,
    'blocked_reason', case when v_open then 'ALREADY_SUBSCRIBED' end,
    'platform', p_platform,
    'storefront', upper(nullif(btrim(coalesce(p_storefront, '')), '')),
    'environment', v_cfg.environment,
    'can_manage', (v_access ->> 'can_manage')::boolean,
    'methods', case when v_open then '[]'::jsonb else v_items end,
    'view_only', v_open or jsonb_array_length(v_items) = 0);
end
$function$;

revoke all on function public.esblu_billing_purchase_options(text, text) from public, anon;
grant execute on function public.esblu_billing_purchase_options(text, text) to authenticated, service_role;

create or replace function public.esblu_billing_create_purchase_intent(
  p_plan_code text, p_interval text, p_platform text, p_method text,
  p_storefront text, p_mode text, p_store_token text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_access jsonb := public.esblu_billing_my_access();
  v_company_id uuid := (v_access ->> 'company_id')::uuid;
  v_cfg record;
  v_info jsonb;
  v_provider text;
  v_reporting text;
  v_plan record;
  v_price record;
  v_acc record;
  v_id uuid;
  v_recent integer;
  v_token text;
  v_storefront text := upper(nullif(btrim(coalesce(p_storefront, '')), ''));
begin
  if not (v_access ->> 'can_manage')::boolean then
    raise exception using errcode = '42501', message = 'ESBLU_BILLING_FORBIDDEN';
  end if;
  if p_platform is null or p_platform not in ('web', 'android', 'ios') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PLATFORM_INVALID';
  end if;
  if p_interval is null or p_interval not in ('month', 'year') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_INTERVAL_INVALID';
  end if;
  if coalesce(p_mode, 'new') not in ('new', 'change') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_MODE_INVALID';
  end if;
  if v_storefront is not null and v_storefront !~ '^[A-Z]{2}$' then
    v_storefront := null;
  end if;

  select * into v_cfg from public.billing_runtime_config c where c.id;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DISABLED';
  end if;

  -- Kanál musí povoliť KONFIGURÁCIA pre túto platformu a storefront.
  if p_method is null or not (p_method = any (public.esblu_billing_resolve_methods(p_platform, v_storefront)))
     or p_method = 'view_only' then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_METHOD_NOT_ALLOWED';
  end if;

  v_info := public.esblu_billing_method_info(p_method);
  v_provider := v_info ->> 'provider';
  v_reporting := v_info ->> 'reporting';
  if v_provider = 'web' then
    if v_cfg.web_provider = 'none' then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DISABLED';
    end if;
    v_provider := v_cfg.web_provider;
  end if;

  if (v_info ->> 'needs_store_token')::boolean
     and (p_store_token is null or char_length(p_store_token) not between 8 and 4096
          or p_store_token !~ '^[A-Za-z0-9_.:=+/-]+$') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_STORE_TOKEN_REQUIRED';
  end if;

  select * into v_plan from public.subscription_plans p where p.plan_code = p_plan_code;
  if not found
    or not (v_plan.status = 'approved' or (v_plan.status = 'test_fixture' and v_cfg.environment = 'test'))
  then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PLAN_NOT_PURCHASABLE';
  end if;

  select * into v_price from public.billing_provider_prices bp
  where bp.provider = v_provider and bp.environment = v_cfg.environment
    and bp.plan_code = p_plan_code and bp.billing_interval = p_interval and bp.active;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PRICE_NOT_CONFIGURED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':billing', 0));
  select * into v_acc from public.subscription_accounts a where a.company_id = v_company_id;

  if coalesce(p_mode, 'new') = 'new' then
    if found and public.esblu_billing_status_is_open(v_acc.status) then
      raise exception using errcode = 'P0001',
        message = case when v_acc.billing_provider is distinct from v_provider
                       then 'ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER'
                       else 'ESBLU_BILLING_ALREADY_SUBSCRIBED' end;
    end if;
  else
    -- Zmena plánu v obchode, ktorý predplatné vlastní (StoreKit upgrade v skupine /
    -- Play SubscriptionUpdateParams). Iný provider = nepovolené (žiadne 2 predplatné).
    if not found or v_acc.status not in ('active', 'trialing', 'past_due', 'grace_period')
       or v_acc.billing_provider is distinct from v_provider or v_provider not in ('apple', 'google') then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_CHANGE_NOT_ALLOWED';
    end if;
  end if;

  select count(*) into v_recent from public.billing_checkout_sessions s
  where s.company_id = v_company_id and s.created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_RATE_LIMITED';
  end if;

  if v_provider in ('apple', 'google') then
    select l.external_id into v_token from public.billing_provider_links l
    where l.company_id = v_company_id and l.provider = v_provider and l.environment = v_cfg.environment
      and l.link_kind = 'account_token'
    limit 1;
    if v_token is null then
      v_token := gen_random_uuid()::text;
      insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
      values (v_company_id, v_provider, v_cfg.environment, 'account_token', v_token);
    end if;
  end if;

  insert into public.billing_checkout_sessions
    (company_id, created_by, provider, environment, plan_code, billing_interval, provider_price_id,
     platform, purchase_method, storefront_country, store_token, store_reporting)
  values
    (v_company_id, v_uid, v_provider, v_cfg.environment, p_plan_code, p_interval, v_price.provider_price_id,
     p_platform, p_method, v_storefront, p_store_token, v_reporting)
  returning id into v_id;

  return jsonb_build_object(
    'checkout_id', v_id,
    'company_id', v_company_id,
    'provider', v_provider,
    'environment', v_cfg.environment,
    'method', p_method,
    'reporting', v_reporting,
    'provider_price_id', v_price.provider_price_id,
    'provider_customer_id', case when v_acc.billing_provider = v_provider then v_acc.provider_customer_id end,
    'account_token', v_token,
    'replaces_subscription_id', case when coalesce(p_mode, 'new') = 'change' then v_acc.provider_subscription_id end);
end
$function$;

revoke all on function public.esblu_billing_create_purchase_intent(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.esblu_billing_create_purchase_intent(text, text, text, text, text, text, text) to authenticated, service_role;

create or replace function public.esblu_get_my_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_company_id uuid := (v_access ->> 'company_id')::uuid;
  v_acc record;
  v_company record;
  v_plan_items jsonb;
  v_result jsonb;
begin
  select * into v_acc from public.subscription_accounts a where a.company_id = v_company_id;
  select c.trial_started_at, c.trial_ends_at into v_company from public.companies c where c.id = v_company_id;

  select coalesce(jsonb_agg(jsonb_build_object('key', pe.entitlement_key, 'limit', pe.limit_value,
                                               'limit_period', pe.limit_period)
                            order by k.sort_order), '[]'::jsonb)
  into v_plan_items
  from public.subscription_plan_entitlements pe
  join public.entitlement_catalog k on k.key = pe.entitlement_key
  where pe.plan_code = v_acc.plan_code;

  v_result := jsonb_build_object(
    'server_time', now(),
    'can_manage', (v_access ->> 'can_manage')::boolean,
    'can_view_details', (v_access ->> 'can_view')::boolean,
    'plan_code', v_acc.plan_code,
    'status', coalesce(v_acc.status, 'none'),
    'cancel_at_period_end', coalesce(v_acc.cancel_at_period_end, false),
    -- Kde sa predplatné spravuje (web / Google Play / App Store) — bez identifikátorov.
    'managed_via', public.esblu_billing_managed_via(v_acc.billing_provider),
    'entitles', public.esblu_billing_status_is_entitling(coalesce(v_acc.status, 'none')),
    'plan_entitlements', coalesce(v_plan_items, '[]'::jsonb),
    'trial', jsonb_build_object(
      'ends_at', v_company.trial_ends_at,
      'active', coalesce(now() >= v_company.trial_started_at and now() < v_company.trial_ends_at, false))
  );

  if (v_access ->> 'can_view')::boolean then
    v_result := v_result || jsonb_build_object(
      'billing_interval', v_acc.billing_interval,
      'billing_provider', v_acc.billing_provider,
      'current_period_start', v_acc.current_period_start,
      'current_period_end', v_acc.current_period_end,
      'grace_until', v_acc.grace_until,
      'canceled_at', v_acc.canceled_at,
      'review_flag', v_acc.review_flag,
      'version', coalesce(v_acc.version, 0)
    );
  end if;

  return v_result;
end
$function$;

revoke all on function public.esblu_get_my_subscription() from public, anon;
grant execute on function public.esblu_get_my_subscription() to authenticated, service_role;
-- Konec. Rollback: supabase/rollback/20261011120000_subscriptions_lifecycle_hardening_rollback.sql
