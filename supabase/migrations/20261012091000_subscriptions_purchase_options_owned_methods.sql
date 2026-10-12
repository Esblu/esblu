-- =============================================================================
-- Subscriptions — purchase_options: zmena plánu pri otvorenom predplatnom
-- (FORWARD-ONLY, 2026-10-12)
--
-- Regresia z 20261011120000: pri otvorenom predplatnom vracal purchase_options
-- prázdne 'methods', takže UI (plán sa číta z kanálov) nevedelo ponúknuť zmenu
-- plánu (Play SubscriptionUpdateParams / StoreKit / Stripe cez /manage).
-- Oprava: pri otvorenom predplatnom sa vrátia IBA kanály providera, ktorý
-- predplatné vlastní, a IBA na platforme, kde sa smie spravovať
-- (esblu_billing_manage_here). Druhý nákup ostáva zakázaný:
-- purchase_allowed=false + create_purchase_intent(mode='new') v DB.
-- Rovnaký podpis funkcie, žiadne dáta sa nemenia.
-- Rollback: supabase/rollback/20261012091000_subscriptions_purchase_options_owned_methods_rollback.sql
-- =============================================================================

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
  v_owned jsonb := '[]'::jsonb;
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
  if v_open then
    select coalesce(jsonb_agg(m), '[]'::jsonb) into v_owned
    from jsonb_array_elements(v_items) m
    where m ->> 'provider' = v_acc.billing_provider
      and public.esblu_billing_manage_here(v_acc.billing_provider, p_platform);
  end if;

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
    -- Otvorené predplatné: iba kanály providera, ktorý ho vlastní (zmena plánu
    -- v tom istom obchode / cez web). Druhý nákup blokuje purchase_allowed=false
    -- + DB (create_purchase_intent mode='new' → ALREADY_SUBSCRIBED / OTHER_PROVIDER).
    'methods', case when v_open then v_owned else v_items end,
    'view_only', case when v_open then jsonb_array_length(v_owned) = 0 else jsonb_array_length(v_items) = 0 end);
end
$function$;

revoke all on function public.esblu_billing_purchase_options(text, text) from public, anon;
grant execute on function public.esblu_billing_purchase_options(text, text) to authenticated, service_role;
