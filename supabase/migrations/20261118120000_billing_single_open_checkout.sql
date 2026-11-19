-- =============================================================================
-- Billing — najviac jeden zaplatiteľný webový checkout na firmu (FORWARD-ONLY, 2026-11-18)
--
-- Problém: dva súbežné pokusy tej istej firmy (dve karty prehliadača, dvaja
-- manažéri, opakovanie po výpadku) vytvorili dva checkout zámery → dve
-- zaplatiteľné Stripe Checkout relácie. DB síce druhé predplatné odmietla
-- (`conflict`), ale druhá karta bola stiahnutá a vyžadovala ručnú refundáciu.
--
-- Oprava:
--   1. esblu_billing_create_purchase_intent: pre webových providerov (stripe, fake)
--      pod existujúcim advisory lockom firmy:
--        - otvorený zámer s rovnakým plánom/intervalom/kanálom/cenou → vráti TEN ISTÝ
--          zámer (`reused: true`); server volá provider s tým istým Idempotency-Key
--          (`esblu-checkout-<id>`) → tá istá relácia (aj po výpadku),
--        - otvorený zámer s iným plánom/kanálom → ESBLU_BILLING_CHECKOUT_IN_PROGRESS,
--        - zámer webového checkoutu platí 1 h (Stripe `expires_at` = rovnaký čas);
--          po expirácii sa automaticky uzavrie.
--   2. Čiastočný unikátny index = DB poistka (najviac 1 zámer created/open na firmu
--      pre stripe/fake). Store kanály (Apple/Google) sa nemenia.
--   3. esblu_billing_attach_checkout_session je idempotentné (rovnaká relácia 2× = OK).
--   4. Zrušenie rozpracovanej platby: esblu_billing_checkout_for_cancel (owner) +
--      esblu_billing_mark_checkout_expired (service_role) — server najprv expiruje
--      reláciu u providera, až potom uzavrie zámer.
-- Ostré platby ostávajú vypnuté (billing_runtime_config.environment = 'test',
-- VERCEL_ENV=production → billing off v kóde).
-- Rollback: supabase/rollback/20261118120000_billing_single_open_checkout_rollback.sql
-- =============================================================================

-- Existujúce duplicity (staging/test dáta): ponechať najnovší otvorený zámer, staršie uzavrieť.
with ranked as (
  select s.id, row_number() over (partition by s.company_id order by s.created_at desc) as rn
  from public.billing_checkout_sessions s
  where s.status in ('created', 'open') and s.provider in ('stripe', 'fake')
)
update public.billing_checkout_sessions s set status = 'expired'
from ranked r
where s.id = r.id and r.rn > 1;

create unique index if not exists billing_checkout_sessions_one_open_web_idx
  on public.billing_checkout_sessions (company_id)
  where status in ('created', 'open') and provider in ('stripe', 'fake');

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
  v_open record;
  v_expires timestamptz := now() + interval '24 hours';
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

  -- 2026-11-18: najviac JEDEN zaplatiteľný webový checkout (Stripe / fake) na firmu.
  -- Súbežné pokusy (dve karty prehliadača, dvaja manažéri, opakovanie po výpadku)
  -- sú serializované advisory lockom vyššie; druhý pokus o ten istý plán dostane
  -- ten istý zámer (reused) → server zavolá provider s tým istým Idempotency-Key
  -- a dostane tú istú reláciu. Iný plán/kanál počas otvorenej relácie = odmietnuté.
  if v_provider in ('stripe', 'fake') and coalesce(p_mode, 'new') = 'new' then
    v_expires := now() + interval '1 hour';
    update public.billing_checkout_sessions s set status = 'expired'
    where s.company_id = v_company_id and s.provider in ('stripe', 'fake')
      and s.status in ('created', 'open') and s.expires_at <= now();

    select s.* into v_open from public.billing_checkout_sessions s
    where s.company_id = v_company_id and s.provider in ('stripe', 'fake') and s.status in ('created', 'open')
    order by s.created_at desc
    limit 1
    for update;

    if found then
      if v_open.provider = v_provider and v_open.environment = v_cfg.environment
         and v_open.plan_code = p_plan_code and v_open.billing_interval = p_interval
         and v_open.platform = p_platform and v_open.purchase_method = p_method
         and v_open.provider_price_id = v_price.provider_price_id
         and (v_open.status = 'open' or v_open.expires_at > now() + interval '31 minutes')
      then
        return jsonb_build_object(
          'checkout_id', v_open.id,
          'company_id', v_company_id,
          'provider', v_provider,
          'environment', v_cfg.environment,
          'method', p_method,
          'reporting', v_open.store_reporting,
          'provider_price_id', v_open.provider_price_id,
          'provider_customer_id', case when v_acc.billing_provider = v_provider then v_acc.provider_customer_id end,
          'account_token', null,
          'replaces_subscription_id', null,
          'expires_at', v_open.expires_at,
          'reused', true);
      elsif v_open.status = 'created' and v_open.expires_at <= now() + interval '31 minutes' then
        -- Relácia u providera nevznikla včas (výpadok) a zámer by už nestihol minimálnu
        -- platnosť Stripe Checkout (30 min) → uzavrieť a založiť nový.
        update public.billing_checkout_sessions set status = 'expired' where id = v_open.id;
      else
        raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_CHECKOUT_IN_PROGRESS';
      end if;
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
     platform, purchase_method, storefront_country, store_token, store_reporting, expires_at)
  values
    (v_company_id, v_uid, v_provider, v_cfg.environment, p_plan_code, p_interval, v_price.provider_price_id,
     p_platform, p_method, v_storefront, p_store_token, v_reporting, v_expires)
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
    'replaces_subscription_id', case when coalesce(p_mode, 'new') = 'change' then v_acc.provider_subscription_id end,
    'expires_at', v_expires,
    'reused', false);
end
$function$;

revoke all on function public.esblu_billing_create_purchase_intent(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.esblu_billing_create_purchase_intent(text, text, text, text, text, text, text) to authenticated, service_role;

-- Idempotentné priradenie relácie: opakovanie s tou istou reláciou je OK.
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
  if found then
    return;
  end if;
  if exists (
    select 1 from public.billing_checkout_sessions s
    where s.id = p_checkout_id and s.provider_session_id = p_provider_session_id
      and s.status in ('open', 'completed')
  ) then
    return;
  end if;
  raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_CHECKOUT_STATE';
end
$function$;

revoke all on function public.esblu_billing_attach_checkout_session(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_attach_checkout_session(uuid, text) to service_role;

-- Zrušenie rozpracovanej platby — krok 1 (prihlásený owner): údaje pre server.
-- Vracia provider identifikátor IBA serveru (route ho neposiela do prehliadača).
create or replace function public.esblu_billing_checkout_for_cancel(p_checkout_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_row record;
begin
  if not (v_access ->> 'can_manage')::boolean then
    raise exception using errcode = '42501', message = 'ESBLU_BILLING_FORBIDDEN';
  end if;
  select s.id, s.provider, s.environment, s.provider_session_id, s.status into v_row
  from public.billing_checkout_sessions s
  where s.id = p_checkout_id and s.company_id = (v_access ->> 'company_id')::uuid;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object('found', true, 'provider', v_row.provider, 'environment', v_row.environment,
                            'provider_session_id', v_row.provider_session_id, 'status', v_row.status);
end
$function$;

revoke all on function public.esblu_billing_checkout_for_cancel(uuid) from public, anon;
grant execute on function public.esblu_billing_checkout_for_cancel(uuid) to authenticated, service_role;

-- Zrušenie — krok 2 (iba server po expirácii u providera): uzavrie zámer.
create or replace function public.esblu_billing_mark_checkout_expired(p_checkout_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_status text;
begin
  update public.billing_checkout_sessions set status = 'expired'
  where id = p_checkout_id and status in ('created', 'open')
  returning status into v_status;
  if v_status is null then
    select s.status into v_status from public.billing_checkout_sessions s where s.id = p_checkout_id;
  end if;
  return v_status;
end
$function$;

revoke all on function public.esblu_billing_mark_checkout_expired(uuid) from public, anon, authenticated;
grant execute on function public.esblu_billing_mark_checkout_expired(uuid) to service_role;
