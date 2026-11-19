-- Rollback 20261122120000_einvoice_ops_alerts (staging/produkcia iba so súhlasom).
-- Poradie rollbacku: 20261122120000 → 20261122110000 → 20261122100000 (deregistrácia volá esblu_einvoice_mandate_revoke).
-- Ochrana záznamu: einvoice_ops_alerts s riadkami sa NEMAŽE — presunie sa do esblu_audit_archive.
-- Prázdna tabuľka sa zmaže. Aplikácia bez tabuľky alerty iba loguje (best effort).
begin;
drop function if exists public.esblu_einvoice_ops_alerts_open();
drop function if exists public.esblu_einvoice_ops_alert_resolve(text, text, uuid, text);
drop function if exists public.esblu_einvoice_ops_alert_raise(text, text, text, text, uuid, text, integer);
do $$
declare
  v_rows bigint;
  v_name text;
begin
  if to_regclass('public.einvoice_ops_alerts') is null then
    return;
  end if;
  execute 'select count(*) from public.einvoice_ops_alerts' into v_rows;
  if v_rows = 0 then
    execute 'drop table public.einvoice_ops_alerts';
    return;
  end if;
  v_name := 'einvoice_ops_alerts_rb_' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  execute 'create schema if not exists esblu_audit_archive';
  execute 'revoke all on schema esblu_audit_archive from public, anon, authenticated, service_role';
  execute format('drop policy if exists %I on public.einvoice_ops_alerts', 'einvoice_ops_alerts_select_finance_manage');
  execute format('drop policy if exists %I on public.einvoice_ops_alerts', 'einvoice_ops_alerts_select_finance');
  execute format('alter table public.einvoice_ops_alerts rename to %I', v_name);
  execute format('alter table public.%I set schema esblu_audit_archive', v_name);
  execute format('revoke all on table esblu_audit_archive.%I from public, anon, authenticated, service_role', v_name);
  raise notice 'einvoice_ops_alerts (% riadkov) archivovaná ako esblu_audit_archive.% (nezmazaná)', v_rows, v_name;
end
$$;

do $$
begin
  if to_regclass('public.einvoice_ops_alerts') is null and not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname in ('esblu_einvoice_ops_alerts_guard', 'esblu_einvoice_ops_alerts_no_truncate')
  ) then
    drop function if exists public.esblu_einvoice_ops_alerts_guard();
    drop function if exists public.esblu_einvoice_ops_alerts_no_truncate();
  end if;
end
$$;
commit;
