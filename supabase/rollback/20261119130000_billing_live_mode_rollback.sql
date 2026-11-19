-- Rollback 20261119130000_billing_live_mode (staging/produkcia iba so súhlasom).
-- PRED rollbackom musí byť billing_runtime_config.environment = 'test' a žiadny kurzor 'live'
-- (inak constraint zlyhá — zámerne: rollback live prostredia je samostatný postup v rollout dokumente).
begin;
alter table public.billing_runtime_config drop constraint if exists billing_runtime_config_live_guard;
alter table public.billing_runtime_config drop constraint if exists billing_runtime_config_env_check;
alter table public.billing_runtime_config add constraint billing_runtime_config_env_check check (environment = 'test');
alter table public.billing_event_cursors drop constraint if exists billing_event_cursors_environment_check;
alter table public.billing_event_cursors add constraint billing_event_cursors_environment_check check (environment in ('test'));

create or replace function public.esblu_billing_record_event(p_provider text, p_environment text, p_provider_event_id text, p_event_type text, p_provider_created_at timestamp with time zone, p_payload_sha256 text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_row record;
begin
  insert into public.billing_events
    (provider, environment, provider_event_id, event_type, provider_created_at, payload_sha256)
  values
    (p_provider, p_environment, p_provider_event_id, p_event_type, p_provider_created_at, p_payload_sha256)
  on conflict (provider, environment, provider_event_id) do nothing
  returning id, status into v_row;

  if found then
    return jsonb_build_object('event_id', v_row.id, 'duplicate', false);
  end if;

  select e.id, e.status, e.payload_sha256 into v_row
  from public.billing_events e
  where e.provider = p_provider and e.environment = p_environment and e.provider_event_id = p_provider_event_id
  for update;

  -- Rovnaké event ID s iným telom = podvrh / chyba → nikdy nespracovať.
  if v_row.payload_sha256 is not null and p_payload_sha256 is not null
     and v_row.payload_sha256 <> p_payload_sha256 then
    return jsonb_build_object('event_id', v_row.id, 'duplicate', true, 'status', 'payload_mismatch');
  end if;

  if v_row.status in ('received', 'failed') then
    -- Retry po technickej chybe → spracovať znova (bezpečné: apply je idempotentné).
    update public.billing_events set attempts = attempts + 1, status = 'received', error_code = null
    where id = v_row.id;
    return jsonb_build_object('event_id', v_row.id, 'duplicate', false, 'retry', true);
  end if;

  return jsonb_build_object('event_id', v_row.id, 'duplicate', true, 'status', v_row.status);
end
$function$;
revoke all on function public.esblu_billing_record_event(text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_record_event(text, text, text, text, timestamptz, text) to service_role;

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
commit;
