-- Rollback 20261122110000_einvoice_deregistration_jobs (staging/produkcia iba so súhlasom).
-- Poradie rollbacku: 20261122120000 → 20261122110000 → 20261122100000 (deregistrácia volá esblu_einvoice_mandate_revoke).
-- POZOR: po rollbacku sa ukončenie firmy s registráciou u poskytovateľa opäť blokuje
-- (ESBLU_EINVOICE_PROVIDER_ENROLLED) a deaktivácia ide iba manuálne (runbook).
-- Ochrana dôkazov: einvoice_deregistrations s riadkami (vrátane org_snapshot zmazaných mapovaní)
-- sa NEMAŽE — presunie sa do esblu_audit_archive. Prázdna tabuľka sa zmaže.
-- Zmazané riadky einvoice_organizations sa NEOBNOVUJÚ (registrácia u poskytovateľa je ukončená;
-- mapovanie ostáva v archivovanom org_snapshot).
begin;
drop function if exists public.esblu_einvoice_deregistration_status(uuid, text);
drop function if exists public.esblu_einvoice_deregistration_requeue(uuid, text);
drop function if exists public.esblu_einvoice_deregistration_finish(uuid, text, text, text, text, integer);
drop function if exists public.esblu_einvoice_deregistration_claim(text, text, integer, integer, uuid);
drop function if exists public.esblu_einvoice_deregistration_request(uuid, text, text, uuid, text);
do $$
declare
  v_rows bigint;
  v_name text;
begin
  if to_regclass('public.einvoice_deregistrations') is null then
    return;
  end if;
  execute 'select count(*) from public.einvoice_deregistrations' into v_rows;
  if v_rows = 0 then
    execute 'drop table public.einvoice_deregistrations';
    return;
  end if;
  v_name := 'einvoice_deregistrations_rb_' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  execute 'create schema if not exists esblu_audit_archive';
  execute 'revoke all on schema esblu_audit_archive from public, anon, authenticated, service_role';
  execute format('drop policy if exists %I on public.einvoice_deregistrations', 'einvoice_deregistrations_select_finance_manage');
  execute format('drop policy if exists %I on public.einvoice_deregistrations', 'einvoice_deregistrations_select_finance');
  execute format('alter table public.einvoice_deregistrations rename to %I', v_name);
  execute format('alter table public.%I set schema esblu_audit_archive', v_name);
  execute format('revoke all on table esblu_audit_archive.%I from public, anon, authenticated, service_role', v_name);
  raise notice 'einvoice_deregistrations (% riadkov) archivovaná ako esblu_audit_archive.% (nezmazaná)', v_rows, v_name;
end
$$;

do $$
begin
  if to_regclass('public.einvoice_deregistrations') is null and not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname in ('esblu_einvoice_deregistrations_guard', 'esblu_einvoice_deregistrations_no_truncate')
  ) then
    drop function if exists public.esblu_einvoice_deregistrations_guard();
    drop function if exists public.esblu_einvoice_deregistrations_no_truncate();
  end if;
end
$$;
commit;
