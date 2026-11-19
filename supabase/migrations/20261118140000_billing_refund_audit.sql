-- =============================================================================
-- Billing — väzba refundácie na faktúru a jej obdobie v audite (FORWARD-ONLY, 2026-11-18)
--
-- Nález (Stripe Test Clock, QA-STRIPE D): udalosť charge.refunded sa v billing_events zapisovala
-- iba ako {"charge_kind":"refund"} — nebolo vidieť, ktorá faktúra a ktoré obdobie sa refundovali,
-- ani či išlo o čiastočnú, staršiu alebo aktuálnu faktúru.
-- Oprava: súhrn eventu nesie predplatné, refundovanú faktúru, obdobie služby faktúry, sumu, menu a
-- rozsah (partial / older_invoice / current_period). Logika stavov a nárokov sa nemení
-- (apply_event = 20261118130000 + rozšírený súhrn; apply_charge = 20261008120000 + rozšírený súhrn).
-- Rollback: supabase/rollback/20261118140000_billing_refund_audit_rollback.sql
-- =============================================================================

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
    'cancel_at_period_end', p_state -> 'cancel_at_period_end',
    -- 2026-11-18: väzba refundácie na faktúru a jej obdobie (audit / párovanie).
    'refund', case when p_state -> 'charge' ->> 'kind' = 'refund' then jsonb_strip_nulls(jsonb_build_object(
      'scope', p_state -> 'charge' ->> 'refund_scope',
      'invoice', p_state -> 'charge' ->> 'refunded_charge_id',
      'invoice_period_start', p_state -> 'charge' ->> 'invoice_period_start',
      'invoice_period_end', p_state -> 'charge' ->> 'invoice_period_end',
      'amount_minor', p_state -> 'charge' -> 'amount_pre_tax_minor',
      'currency', p_state -> 'charge' ->> 'currency')) end));

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

  -- (e2) 2026-11-18: refunded / revoked sú konečné a špecifickejšie než canceled / expired.
  --      Po plnej refundácii aktuálneho obdobia (alebo prehranom spore) Esblu ukončí predplatné
  --      u providera; jeho následná udalosť (Stripe customer.subscription.deleted → canceled)
  --      nesmie prepísať dôvod ukončenia. Poradie: revoked > refunded > canceled / expired.
  --      Nároky ostávajú odvolané (stav sa nemení, sync sa nevolá); event sa uloží ako stale.
  if v_acc.provider_subscription_id is not distinct from v_sub_id
     and v_acc.status in ('refunded', 'revoked')
     and (case v_status when 'revoked' then 3 when 'refunded' then 2 when 'canceled' then 1 when 'expired' then 1 else 0 end)
         < (case v_acc.status when 'revoked' then 3 else 2 end)
  then
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

create or replace function public.esblu_billing_apply_charge(p_event_id uuid, p_provider_subscription_id text, p_charge jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_event record;
  v_acc record;
begin
  select * into v_event from public.billing_events e where e.id = p_event_id for update;
  if not found or v_event.status <> 'received' then
    return jsonb_build_object('result', 'duplicate');
  end if;
  select a.* into v_acc from public.subscription_accounts a
  where a.billing_provider = v_event.provider and a.provider_subscription_id = p_provider_subscription_id;
  if not found then
    update public.billing_events set status = 'failed', error_code = 'UNKNOWN_SUBSCRIPTION', processed_at = now()
    where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'UNKNOWN_SUBSCRIPTION');
  end if;
  perform public.esblu_billing_queue_store_report(v_acc.id, p_charge);
  -- 2026-11-18: súhrn nesie predplatné, refundovanú faktúru, jej obdobie a rozsah (bez osobných údajov).
  update public.billing_events set status = 'processed', company_id = v_acc.company_id, processed_at = now(),
    summary = jsonb_strip_nulls(jsonb_build_object(
      'charge_kind', p_charge ->> 'kind',
      'subscription', p_provider_subscription_id,
      'account_status', v_acc.status,
      'refund', case when p_charge ->> 'kind' = 'refund' then jsonb_strip_nulls(jsonb_build_object(
        'scope', p_charge ->> 'refund_scope',
        'invoice', p_charge ->> 'refunded_charge_id',
        'invoice_period_start', p_charge ->> 'invoice_period_start',
        'invoice_period_end', p_charge ->> 'invoice_period_end',
        'amount_minor', p_charge -> 'amount_pre_tax_minor',
        'currency', p_charge ->> 'currency')) end))
  where id = p_event_id;
  return jsonb_build_object('result', 'applied', 'company_id', v_acc.company_id);
end
$function$;

revoke all on function public.esblu_billing_apply_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_billing_apply_event(uuid, jsonb) to service_role;
revoke all on function public.esblu_billing_apply_charge(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_billing_apply_charge(uuid, text, jsonb) to service_role;
