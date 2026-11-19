-- =============================================================================
-- S13 (2026-11-19): plánované PREDČASNÉ ukončenie k zvolenému dátumu (Stripe `cancel_at`
-- uprostred obdobia) — prístup iba do toho dátumu, BEZ 48 h ochrannej lehoty.
-- Iba staging; produkcia čaká na súhlas. Rollback: supabase/rollback/…_rollback.sql
--
-- Predtým normalizácia Stripe zmenila `cancel_at` uprostred obdobia na cancel_at_period_end=true
-- a dátum zahodila → nároky do current_period_end + 48 h (pri chýbajúcom webhooku o skončení)
-- a UI ukazovalo nesprávny koniec.
--
-- Pravidlá (jedna funkcia esblu_billing_access_until, kotva vždy z dát providera):
--   active / trialing, bez plánovaného konca      → current_period_end + 48 h
--   active / trialing, scheduled_end_at nastavený → least(scheduled_end_at, current_period_end + 48 h)
--                                                    (bez rezervy; po dátume prístup končí aj bez webhooku)
--   canceled / expired, riadny koniec obdobia      → current_period_end + 48 h (ended_at ≥ cpe − 5 min,
--                                                    nie trial, NIE plánovaný predčasný koniec)
--   canceled / expired, scheduled_end_at nastavený → žiadny (predčasné ukončenie, bez rezervy)
--   canceled / expired uprostred obdobia            → žiadny (okamžité ukončenie, dunning)
--   past_due / grace_period                        → grace_until (bez zmeny, nesčítava sa)
--   refunded / revoked / ostatné                   → žiadny
-- Dáta sa nemažú; mení sa iba status / valid_until v company_entitlements.
-- =============================================================================

alter table public.subscription_accounts add column if not exists scheduled_end_at timestamptz null;
comment on column public.subscription_accounts.scheduled_end_at is
  'Plánované predčasné ukončenie k zvolenému dátumu (Stripe cancel_at uprostred obdobia). '
  'Null = žiadne (riadne obnovovanie alebo zrušenie ku koncu obdobia). Prístup končí k tomuto dátumu bez 48 h lehoty.';

create or replace function public.esblu_billing_access_until(
  p_status text, p_current_period_end timestamptz, p_ended_at timestamptz, p_trial_end timestamptz,
  p_scheduled_end timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_current_period_end is null then null
    when p_status in ('active', 'trialing') and p_scheduled_end is not null
      then least(p_scheduled_end, p_current_period_end + interval '48 hours')
    when p_status in ('active', 'trialing') then p_current_period_end + interval '48 hours'
    when p_status in ('canceled', 'expired') and p_scheduled_end is not null then null
    when p_status in ('canceled', 'expired')
         and p_ended_at is not null
         and p_ended_at >= p_current_period_end - interval '5 minutes'
         and not (p_trial_end is not null and p_trial_end >= p_current_period_end - interval '5 minutes')
      then p_current_period_end + interval '48 hours'
    else null
  end
$function$;
revoke all on function public.esblu_billing_access_until(text, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.esblu_billing_access_until(text, timestamptz, timestamptz, timestamptz, timestamptz) to service_role;

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
    if v_acc.status in ('active', 'trialing', 'canceled', 'expired') then
      -- Zaplatené obdobie + 48 h ochranná lehota (riadny koniec / zrušené obnovovanie /
      -- oneskorený webhook obnovy). Ukončenie uprostred obdobia → null → bez prístupu.
      v_until := public.esblu_billing_access_until(
        v_acc.status, v_acc.current_period_end, v_acc.ended_at, v_acc.provider_trial_end, v_acc.scheduled_end_at);
      v_entitled := v_until is not null and v_until > now();
    elsif v_acc.status = 'past_due' and v_acc.grace_until is not null then
      -- Neúspešná platba: iba lehota providera, 48 h sa nepripočítava.
      v_until := v_acc.grace_until;
      v_entitled := v_until > now();
    elsif v_acc.status = 'grace_period' and coalesce(v_acc.grace_until, v_acc.current_period_end) is not null then
      v_until := coalesce(v_acc.grace_until, v_acc.current_period_end);
      v_entitled := v_until > now();
    end if;
    -- Všetky ostatné stavy (refunded, revoked, unpaid, account_hold, ...) → nároky odvolané (dáta ostávajú).
  end if;

  if v_entitled then
    for v_item in
      select t.entitlement_key, t.limit_value, t.limit_period
      from public.esblu_billing_plan_targets(p_company_id, v_acc.plan_code) t
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

    -- Downgrade: nároky mimo plánu sa odvolajú (dáta ostávajú, nič sa nemaže).
    update public.company_entitlements e
    set status = 'revoked'
    where e.company_id = p_company_id and e.source = 'subscription' and e.status <> 'revoked'
      and not exists (select 1 from public.esblu_billing_plan_targets(p_company_id, v_acc.plan_code) t
                      where t.entitlement_key = e.entitlement_key);
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
  v_access_until timestamptz;
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

  -- Skutočný koniec prístupu z predplatného = to, čo vynucuje server (aktívne a platné nároky).
  select max(e.valid_until) into v_access_until
  from public.company_entitlements e
  where e.company_id = v_company_id and e.source = 'subscription' and e.status = 'active'
    and e.valid_until > now();

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
    'access_until', v_access_until,
    'post_period_protection', coalesce(v_acc.status in ('canceled', 'expired') and v_access_until is not null, false),
    'scheduled_end_at', v_acc.scheduled_end_at,
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
    'scheduled_end_at', p_state ->> 'scheduled_end_at',
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
    -- 2026-11-19 (S13): plánované predčasné ukončenie k zvolenému dátumu (Stripe cancel_at uprostred
    -- obdobia). Každý stav nesie úplný snímok → chýbajúci kľúč = žiadny plánovaný predčasný koniec.
    scheduled_end_at = nullif(p_state ->> 'scheduled_end_at', '')::timestamptz,
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
           'scheduled_end_at', c.scheduled_end_at,
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
           -- S13: aj blížiaci sa plánovaný predčasný koniec → overiť skôr (chýbajúci webhook o skončení)
           or coalesce(a.grace_until, least(a.scheduled_end_at, a.current_period_end), a.current_period_end) < now() + interval '1 day')
    order by coalesce(r.last_checked_at, '-infinity'::timestamptz), a.id
    limit greatest(1, least(coalesce(p_limit, 50), 500))
  ) c
$function$;
revoke all on function public.esblu_billing_reconcile_candidates(integer) from public, anon, authenticated;
grant execute on function public.esblu_billing_reconcile_candidates(integer) to service_role;

-- Predchádzajúci 4-parametrový helper esblu_billing_post_period_protection_until ostáva (service-only,
-- nič ho už nevolá) — aby opakovaný beh migrácie 20261119100000 nemenil ACL; odstráni ho až budúci cleanup.

