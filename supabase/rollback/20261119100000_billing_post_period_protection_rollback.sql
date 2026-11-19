-- Rollback 20261119100000_billing_post_period_protection (staging/produkcia iba so súhlasom).
-- Obnoví stav z 20261026100000 (sync) a 20261011120000 (get_my_subscription); odstráni pomocnú funkciu.
-- Po rollbacku: canceled/expired → nároky okamžite odvolané (aj počas 48 h). Spustiť resync dotknutých firiem:
--   select public.esblu_billing_sync_entitlements(company_id) from public.subscription_accounts where status in ('canceled','expired');
begin;
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
      v_until := coalesce(v_acc.grace_until, v_acc.current_period_end);
      v_entitled := v_until > now();
    end if;
    -- Všetky ostatné stavy → nároky odvolané (dáta ostávajú).
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

drop function if exists public.esblu_billing_post_period_protection_until(text, timestamptz, timestamptz, timestamptz);
commit;
