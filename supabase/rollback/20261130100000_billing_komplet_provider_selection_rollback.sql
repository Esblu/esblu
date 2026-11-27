-- Rollback 20261130100000: vráti esblu_billing_sync_entitlements na znenie z 20261119130000 a odstráni poistku LIVE cien.
-- Riadky company_plan_selection so source='provider' sa NEMAŽÚ (sú to údaje o zaplatenom pláne).
-- POZOR: po rollbacku platené Komplet predplatné bez staging mocku opäť nedostane nároky — iba ak nie je LIVE predaj.

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

  -- S15: nároky iba z účtu AKTUÁLNEHO prostredia DB (test ↔ live sa nikdy nemiešajú).
  if found and v_acc.plan_code is not null
     and (v_acc.provider_environment is null
          or v_acc.provider_environment = (select c.environment from public.billing_runtime_config c where c.id)) then
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

drop trigger if exists esblu_billing_live_price_guard on public.billing_provider_prices;
drop function if exists public.esblu_billing_live_price_guard();
