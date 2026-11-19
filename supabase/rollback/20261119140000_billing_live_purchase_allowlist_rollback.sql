-- Rollback 20261119140000_billing_live_purchase_allowlist (staging/produkcia iba so súhlasom).
-- POZOR: po rollbacku v live prostredí smie LIVE nákup vytvoriť KAŽDÁ firma — pred rollbackom nastaviť
-- billing_runtime_config.web_provider = 'none' (pozastavený predaj).
-- Ochrana záznamu (2026-11-19, ops/esblu8-readiness): allowlist je záznam schválení LIVE nákupu.
-- Prázdna tabuľka sa zmaže; neprázdna sa presunie do neexponovanej schémy esblu_audit_archive
-- (billing_live_purchase_allowlist_rb_<UTC timestamp>), nič sa nemaže.
begin;
drop trigger if exists esblu_billing_checkout_live_guard on public.billing_checkout_sessions;
drop function if exists public.esblu_billing_checkout_live_guard();
drop function if exists public.esblu_billing_my_live_purchase_allowed();
drop function if exists public.esblu_billing_live_purchase_allowed(uuid);
do $$
declare
  v_rows bigint;
  v_name text;
begin
  if to_regclass('public.billing_live_purchase_allowlist') is null then
    return;
  end if;
  execute 'select count(*) from public.billing_live_purchase_allowlist' into v_rows;
  if v_rows = 0 then
    execute 'drop table public.billing_live_purchase_allowlist';
    return;
  end if;
  v_name := 'billing_live_purchase_allowlist_rb_' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  execute 'create schema if not exists esblu_audit_archive';
  execute 'revoke all on schema esblu_audit_archive from public, anon, authenticated, service_role';
  execute format('alter table public.billing_live_purchase_allowlist rename to %I', v_name);
  execute format('alter table public.%I set schema esblu_audit_archive', v_name);
  execute format('revoke all on table esblu_audit_archive.%I from public, anon, authenticated, service_role', v_name);
  raise notice 'billing_live_purchase_allowlist (% riadkov) archivovaná ako esblu_audit_archive.% (nezmazaná)', v_rows, v_name;
end
$$;
alter table public.billing_runtime_config drop constraint if exists billing_runtime_config_live_scope_check;
alter table public.billing_runtime_config drop column if exists live_purchase_scope;
commit;
