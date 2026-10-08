-- =============================================================================
-- ROLLBACK pre 20261008120000_subscriptions_platform.sql (STAGING ONLY).
--
-- Migrácia je čisto aditívna: nemení existujúce tabuľky ani funkcie okrem
-- nového čiastočného unique indexu na company_entitlements. Rollback preto:
--   1. zruší nové RPC (žiadny klient ich potom nevolá → billing vypnutý),
--   2. zruší čiastočný index,
--   3. NEMAŽE riadky company_entitlements source='subscription' — vypršia
--      samé cez valid_until (fail closed). Ak ich treba ukončiť hneď, odkomentuj
--      krok 3b (iba status='revoked', žiadny DELETE, business dáta sa nemenia),
--   4. billing tabuľky zhodí IBA ak je nastavené esblu.rollback_drop_billing_tables
--      = 'yes' (na stagingu po exporte auditných dát). Default = ponechať.
-- Idempotentné (if exists).
-- =============================================================================

begin;

drop function if exists public.esblu_billing_issue_account_token(text);
drop function if exists public.esblu_billing_apply_event(uuid, jsonb);
drop function if exists public.esblu_billing_close_event(uuid, text, text, jsonb);
drop function if exists public.esblu_billing_record_event(text, text, text, text, timestamptz, text);
drop function if exists public.esblu_billing_sync_entitlements(uuid);
drop function if exists public.esblu_billing_resolve_price(text, text, text, text);
drop function if exists public.esblu_billing_authorize_manage();
drop function if exists public.esblu_billing_attach_checkout_session(uuid, text);
drop function if exists public.esblu_billing_create_checkout_intent(text, text);
drop function if exists public.esblu_billing_list_plans();
drop function if exists public.esblu_get_my_checkout_status(uuid);
drop function if exists public.esblu_get_my_subscription();
drop function if exists public.esblu_billing_my_access();

drop index if exists public.company_entitlements_subscription_unique_idx;

-- 3b) Voliteľné okamžité ukončenie nárokov z predplatného (bez mazania):
-- update public.company_entitlements set status = 'revoked'
-- where source = 'subscription' and status <> 'revoked';

do $rb$
begin
  if coalesce(current_setting('esblu.rollback_drop_billing_tables', true), '') = 'yes' then
    drop table if exists public.billing_events;
    drop table if exists public.billing_checkout_sessions;
    drop table if exists public.billing_provider_links;
    drop table if exists public.subscription_accounts;
    drop table if exists public.billing_provider_prices;
    drop table if exists public.subscription_plan_entitlements;
    drop table if exists public.subscription_plans;
    drop table if exists public.billing_runtime_config;
  end if;
end
$rb$;

commit;
