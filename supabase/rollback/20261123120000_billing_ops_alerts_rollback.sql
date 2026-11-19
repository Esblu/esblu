-- Rollback 20261123120000_billing_ops_alerts (staging/produkcia iba so súhlasom). Spúšťa sa PRED
-- rollbackom 20261123110000 a 20261123100000.
-- Ochrana auditu: neprázdna história alertov / heartbeatov sa NEMAŽE — presunie sa do esblu_audit_archive
-- (<tabuľka>_rb_<UTC timestamp>). Prázdne tabuľky sa zmažú.
begin;
drop function if exists public.esblu_billing_ops_open_summary(text);
drop function if exists public.esblu_billing_ops_mark_notified(uuid, boolean, text, text);
drop function if exists public.esblu_billing_ops_pending(text, integer);
drop function if exists public.esblu_billing_ops_collect(text);
drop function if exists public.esblu_billing_ops_heartbeat(text, text, boolean, text);
drop function if exists public.esblu_billing_ops_raise(text, text, text, integer, integer, jsonb);
drop function if exists public.esblu_billing_ops_clean_details(jsonb);
do $$
declare
  v_table text;
  v_rows bigint;
  v_name text;
  v_stamp text := to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
begin
  foreach v_table in array array['billing_ops_alerts', 'billing_ops_heartbeats'] loop
    if to_regclass('public.' || v_table) is null then
      continue;
    end if;
    execute format('select count(*) from public.%I', v_table) into v_rows;
    if v_rows = 0 then
      execute format('drop table public.%I', v_table);
      continue;
    end if;
    v_name := v_table || '_rb_' || v_stamp;
    execute 'create schema if not exists esblu_audit_archive';
    execute 'revoke all on schema esblu_audit_archive from public, anon, authenticated, service_role';
    execute format('alter table public.%I rename to %I', v_table, v_name);
    execute format('alter table public.%I set schema esblu_audit_archive', v_name);
    execute format('revoke all on table esblu_audit_archive.%I from public, anon, authenticated, service_role', v_name);
    raise notice '% (% riadkov) archivovaná ako esblu_audit_archive.% (nezmazaná)', v_table, v_rows, v_name;
  end loop;
end
$$;
commit;
