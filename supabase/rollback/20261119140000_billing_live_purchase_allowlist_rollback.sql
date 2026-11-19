-- Rollback 20261119140000_billing_live_purchase_allowlist (staging/produkcia iba so súhlasom).
-- POZOR: po rollbacku v live prostredí smie LIVE nákup vytvoriť KAŽDÁ firma — pred rollbackom nastaviť
-- billing_runtime_config.web_provider = 'none' (pozastavený predaj).
begin;
drop trigger if exists esblu_billing_checkout_live_guard on public.billing_checkout_sessions;
drop function if exists public.esblu_billing_checkout_live_guard();
drop function if exists public.esblu_billing_my_live_purchase_allowed();
drop function if exists public.esblu_billing_live_purchase_allowed(uuid);
drop table if exists public.billing_live_purchase_allowlist;
alter table public.billing_runtime_config drop constraint if exists billing_runtime_config_live_scope_check;
alter table public.billing_runtime_config drop column if exists live_purchase_scope;
commit;
