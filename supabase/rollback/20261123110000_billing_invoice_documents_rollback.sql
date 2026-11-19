-- Rollback 20261123110000_billing_invoice_documents (staging/produkcia iba so súhlasom).
-- PORADIE: najprv rollback 20261123120000_billing_ops_alerts (jeho funkcie čítajú tieto tabuľky).
-- Ochrana auditu / účtovných dát: neprázdne tabuľky (účtovné kópie dokladov, refundácie, balance
-- transactions, export log, admini) sa NEMAŽÚ — presunú sa do neexponovanej schémy esblu_audit_archive
-- ako <tabuľka>_rb_<UTC timestamp> (vrátane nemenného snapshotu odberateľa customer_*). Prázdne tabuľky
-- sa zmažú. Ochrana pred DELETE/TRUNCATE (esblu_billing_accounting_record_retained) na presunutých
-- tabuľkách OSTÁVA — funkcia sa presunie do esblu_audit_archive. Bucket billing-documents sa zmaže iba
-- ak je prázdny (archivované PDF ostávajú).
begin;
drop function if exists public.esblu_billing_is_ops_admin();
drop function if exists public.esblu_billing_accounting_export(text, timestamptz, timestamptz, uuid);
drop function if exists public.esblu_billing_upsert_balance_transactions(text, jsonb);
drop function if exists public.esblu_billing_document_archive_result(uuid, boolean, text, text, text);
drop function if exists public.esblu_billing_document_archive_claim(text, integer);
drop function if exists public.esblu_billing_refunds_without_credit_note(text, interval);
drop function if exists public.esblu_billing_record_refund_observation(text, text, bigint, text, timestamptz);
drop function if exists public.esblu_billing_upsert_document(text, text, jsonb);
drop function if exists public.esblu_billing_document_status_rank(text, text);
drop trigger if exists esblu_billing_documents_company_freeze on public.companies;
drop function if exists public.esblu_billing_documents_company_freeze();
drop trigger if exists esblu_billing_documents_guard on public.billing_invoice_documents;
drop function if exists public.esblu_billing_documents_guard();
drop function if exists public.esblu_billing_customer_identity(uuid);
do $$
declare
  v_table text;
  v_rows bigint;
  v_name text;
  v_stamp text := to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
begin
  foreach v_table in array array['billing_invoice_documents', 'billing_refund_observations', 'billing_balance_transactions',
                                 'billing_accounting_export_log', 'billing_ops_admins'] loop
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
  -- Ochrana presunutých účtovných tabuliek ostáva; funkcia bez triggerov sa zmaže.
  if to_regprocedure('public.esblu_billing_accounting_record_retained()') is not null then
    if exists (select 1 from pg_trigger t where t.tgfoid = 'public.esblu_billing_accounting_record_retained()'::regprocedure) then
      execute 'create schema if not exists esblu_audit_archive';
      execute 'revoke all on schema esblu_audit_archive from public, anon, authenticated, service_role';
      execute format('alter function public.esblu_billing_accounting_record_retained() rename to %I', 'esblu_billing_accounting_record_retained_rb_' || v_stamp);
      execute format('alter function public.%I() set schema esblu_audit_archive', 'esblu_billing_accounting_record_retained_rb_' || v_stamp);
    else
      drop function public.esblu_billing_accounting_record_retained();
    end if;
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'billing-documents') then
    delete from storage.buckets where id = 'billing-documents';
  else
    raise notice 'bucket billing-documents obsahuje archivované PDF — ponechaný';
  end if;
end
$$;
commit;
