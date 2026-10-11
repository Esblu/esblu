-- =============================================================================
-- ROLLBACK pre 20261011120000_subscriptions_lifecycle_hardening.sql (STAGING ONLY).
-- Vráti funkcie na verziu 20261008120000, nové stavy namapuje na najbližší
-- pôvodný (nároky sa potom prepočítajú tou istou logikou), zruší reconciliation
-- a explain/ops RPC. review_flag stĺpec ponechá (iba metadata). Idempotentné.
-- =============================================================================

begin;

drop function if exists public.esblu_billing_ops_status(uuid);
drop function if exists public.esblu_billing_explain_my_entitlements();
drop function if exists public.esblu_billing_reconcile_requeue(uuid);
drop function if exists public.esblu_billing_reconcile_record(uuid, text, text);
drop function if exists public.esblu_billing_reconcile_candidates(integer);
drop table if exists public.billing_reconciliation;

update public.subscription_accounts set status = case status
  when 'pending' then 'incomplete' when 'grace_period' then 'past_due' when 'account_hold' then 'unpaid'
  when 'refunded' then 'canceled' when 'revoked' then 'canceled' else status end
where status in ('pending', 'grace_period', 'account_hold', 'refunded', 'revoked');

alter table public.subscription_accounts drop constraint if exists subscription_accounts_status_check;
alter table public.subscription_accounts add constraint subscription_accounts_status_check check (status in (
  'none', 'incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'expired'));
alter table public.subscription_accounts drop constraint if exists subscription_accounts_paid_has_plan;
alter table public.subscription_accounts add constraint subscription_accounts_paid_has_plan
  check (status in ('none', 'canceled', 'expired') or plan_code is not null);

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
    end if;
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

  if v_status is null or v_status not in (
    'incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'expired') then
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
  if v_acc.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete')
     and v_acc.provider_subscription_id is not null
     and (v_acc.billing_provider is distinct from v_event.provider
          or v_acc.provider_subscription_id is distinct from v_sub_id)
     -- Výnimka: ten istý provider výslovne nahrádza predplatné (Google
     -- linkedPurchaseToken pri upgrade/downgrade = nový purchaseToken).
     and not (v_acc.billing_provider = v_event.provider
              and v_acc.provider_subscription_id = nullif(p_state ->> 'replaces_subscription_id', ''))
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
     and v_acc.status in ('canceled', 'expired') and v_acc.ended_at is not null
     and v_status not in ('canceled', 'expired') then
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
    ended_at = case when v_status in ('canceled', 'expired')
                    then coalesce(nullif(p_state ->> 'ended_at', '')::timestamptz, v_state_at) end,
    provider_trial_start = nullif(p_state ->> 'trial_start', '')::timestamptz,
    provider_trial_end = nullif(p_state ->> 'trial_end', '')::timestamptz,
    grace_until = case
      when v_status = 'past_due' then coalesce(
        case when a.status = 'past_due' then a.grace_until end,
        v_state_at + make_interval(days => v_grace_days))
      else null end,
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

  return jsonb_build_object(
    'platform', p_platform,
    'storefront', upper(nullif(btrim(coalesce(p_storefront, '')), '')),
    'environment', v_cfg.environment,
    'can_manage', (v_access ->> 'can_manage')::boolean,
    'methods', v_items,
    'view_only', jsonb_array_length(v_items) = 0);
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
    if found and v_acc.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete') then
      raise exception using errcode = 'P0001',
        message = case when v_acc.billing_provider is distinct from v_provider
                       then 'ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER'
                       else 'ESBLU_BILLING_ALREADY_SUBSCRIBED' end;
    end if;
  else
    -- Zmena plánu v obchode, ktorý predplatné vlastní (StoreKit upgrade v skupine /
    -- Play SubscriptionUpdateParams). Iný provider = nepovolené (žiadne 2 predplatné).
    if not found or v_acc.status not in ('active', 'trialing', 'past_due')
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
      'version', coalesce(v_acc.version, 0)
    );
  end if;

  return v_result;
end
$function$;

revoke all on function public.esblu_get_my_subscription() from public, anon;
grant execute on function public.esblu_get_my_subscription() to authenticated, service_role;

drop function if exists public.esblu_billing_manage_here(text, text);
drop function if exists public.esblu_billing_managed_via(text);
drop function if exists public.esblu_billing_status_is_terminal(text);
drop function if exists public.esblu_billing_status_is_entitling(text);
drop function if exists public.esblu_billing_status_is_open(text);
drop function if exists public.esblu_billing_canonical_statuses();

-- Prepočet nárokov pôvodnou logikou.
select public.esblu_billing_sync_entitlements(a.company_id) from public.subscription_accounts a;

commit;
