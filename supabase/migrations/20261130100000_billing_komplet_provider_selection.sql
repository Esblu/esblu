-- =============================================================================
-- 20261130100000 — Billing: kompozícia plánu pre zaplatený Komplet zo Stripe + poistka LIVE cien.
-- =============================================================================
-- Nález (príprava Stripe LIVE, 2026-11-27): nároky kanonických plánov (esblu_complete, esblu_complete_secondary,
-- esblu_modular) sa počítajú z public.company_plan_selection; riadok vytváral iba esblu_staging_mock_set_plan
-- (source='staging_mock'). Skutočný nákup cez Stripe Checkout riadok nevytvorí → esblu_billing_plan_targets vráti
-- prázdnu množinu → zaplatené predplatné NEDÁ žiadne nároky (S12–S17 mali kompozíciu vopred z mocku).
--
-- Oprava (iba aditívna, bez zmeny tabuliek):
--   1) esblu_billing_sync_entitlements: pri oprávnenom účte s plánom Komplet doplní / zosúladí riadok
--      company_plan_selection (plan_kind='complete', tier podľa plan_code, source='provider'). Riadky staging_mock
--      sa nemenia. Modulárny plán sa neodvodzuje.
--   2) Poistka: LIVE cena (billing_provider_prices.environment='live') pre esblu_modular a esblu_complete_secondary
--      je zakázaná, kým nie je implementovaný výber modulov v checkoute a overenie cenovej úrovne pri nákupe
--      (ESBLU_BILLING_PLAN_NOT_LIVE_SELLABLE). Test ceny (staging, Stripe TEST) nie sú dotknuté.
-- Rollback: supabase/rollback/20261130100000_billing_komplet_provider_selection_rollback.sql
-- =============================================================================

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
    -- 20261130100000: zaplatený Komplet zo Stripe (provider) má kompozíciu Komplet aj bez staging mocku.
    -- Bez riadku company_plan_selection by esblu_billing_plan_targets nevrátil nič (fail closed) a platiaci
    -- zákazník by po skončení trialu stratil prístup. Modulárny plán sa neodvodzuje (výber modulov nepoznáme).
    if v_acc.plan_code in ('esblu_complete', 'esblu_complete_secondary') then
      insert into public.company_plan_selection as s (company_id, plan_kind, price_tier, source)
      values (p_company_id, 'complete',
              case when v_acc.plan_code = 'esblu_complete_secondary' then 'secondary' else 'primary' end, 'provider')
      on conflict (company_id) do update
        set plan_kind = 'complete', price_tier = excluded.price_tier, modules = '{}',
            updated_at = now(), version = s.version + 1
        where s.source = 'provider' and (s.plan_kind <> 'complete' or s.price_tier <> excluded.price_tier);
    end if;

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

create or replace function public.esblu_billing_live_price_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.environment = 'live' and new.active
     and new.plan_code in ('esblu_modular', 'esblu_complete_secondary') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PLAN_NOT_LIVE_SELLABLE';
  end if;
  return new;
end
$function$;
revoke all on function public.esblu_billing_live_price_guard() from public, anon, authenticated, service_role;

drop trigger if exists esblu_billing_live_price_guard on public.billing_provider_prices;
create trigger esblu_billing_live_price_guard
  before insert or update on public.billing_provider_prices
  for each row execute function public.esblu_billing_live_price_guard();
