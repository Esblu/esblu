-- Rollback 20261118120000_billing_single_open_checkout — IBA staging. Dáta sa nemažú.
drop function if exists public.esblu_billing_mark_checkout_expired(uuid);
drop function if exists public.esblu_billing_checkout_for_cancel(uuid);
drop index if exists public.billing_checkout_sessions_one_open_web_idx;

-- Pôvodná definícia z 20261011120000_subscriptions_lifecycle_hardening.sql
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

-- Pôvodná definícia z 20261008120000_subscriptions_platform.sql
-- Server (service_role) priradí provider session ID k zámeru.
create or replace function public.esblu_billing_attach_checkout_session(
  p_checkout_id uuid, p_provider_session_id text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.billing_checkout_sessions
  set provider_session_id = p_provider_session_id, status = 'open'
  where id = p_checkout_id and status = 'created' and provider_session_id is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_CHECKOUT_STATE';
  end if;
end
$function$;

revoke all on function public.esblu_billing_attach_checkout_session(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_attach_checkout_session(uuid, text) to service_role;
