-- =============================================================================
-- P1-5 staging — CIELENÁ ZÁLOHA (NÁVRH, NESPÚŠŤAŤ bez schválenia kroku W1).
-- Rovnaký mechanizmus ako schválená záloha P14 (esblu_backup_p14_20261123): kópie tabuliek do samostatnej schémy
-- bez prístupu klientov. Iba esblu-test (cjbdijbbcujvmrzezusd). Nemení existujúce dáta.
-- Bajty súborov v Storage táto záloha neobsahuje (iba metadáta storage.objects) — pozri plán, krok O1.
-- =============================================================================
begin;
create schema esblu_backup_p15_20261124;
revoke all on schema esblu_backup_p15_20261124 from public, anon, authenticated, service_role;

create table esblu_backup_p15_20261124.companies as select * from public.companies;
create table esblu_backup_p15_20261124.company_members as select * from public.company_members;
create table esblu_backup_p15_20261124.company_terminations as select * from public.company_terminations;
create table esblu_backup_p15_20261124.company_export_runs as select * from public.company_export_runs;
create table esblu_backup_p15_20261124.account_deletion_cleanup_jobs as select * from public.account_deletion_cleanup_jobs;
create table esblu_backup_p15_20261124.invoices as select * from public.invoices;
create table esblu_backup_p15_20261124.invoice_items as select * from public.invoice_items;
create table esblu_backup_p15_20261124.invoice_events as select * from public.invoice_events;
create table esblu_backup_p15_20261124.invoice_accounting_state_log as select * from public.invoice_accounting_state_log;
create table esblu_backup_p15_20261124.documents as select * from public.documents;
create table esblu_backup_p15_20261124.einvoice_inbound as select * from public.einvoice_inbound;
create table esblu_backup_p15_20261124.einvoice_outbound as select * from public.einvoice_outbound;
create table esblu_backup_p15_20261124.einvoice_events as select * from public.einvoice_events;
create table esblu_backup_p15_20261124.einvoice_mandates as select * from public.einvoice_mandates;
create table esblu_backup_p15_20261124.einvoice_deregistrations as select * from public.einvoice_deregistrations;
create table esblu_backup_p15_20261124.einvoice_organizations as select * from public.einvoice_organizations;
create table esblu_backup_p15_20261124.billing_invoice_documents as select * from public.billing_invoice_documents;
create table esblu_backup_p15_20261124.storage_objects as
  select id, bucket_id, name, metadata, version, created_at, updated_at from storage.objects;
-- definície funkcií a triggerov, ktoré 20261127/20261128 nahrádzajú (obnova = rollback SQL; toto je dôkaz pôvodného stavu)
create table esblu_backup_p15_20261124.function_defs as
  select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (
    'esblu_company_termination_commit', 'esblu_company_termination_export_gate', 'esblu_company_export_begin',
    'esblu_company_export_part', 'esblu_cleanup_jobs_protect_retained_storage');

-- kontrola úplnosti: počty a md5 musia sedieť s živými tabuľkami (výsledok uložiť do reportu)
create table esblu_backup_p15_20261124.completeness as
select t.tbl, t.backup_n, t.live_n, t.backup_n = t.live_n as ok from (
  select 'companies' tbl, (select count(*) from esblu_backup_p15_20261124.companies) backup_n, (select count(*) from public.companies) live_n
  union all select 'invoices', (select count(*) from esblu_backup_p15_20261124.invoices), (select count(*) from public.invoices)
  union all select 'einvoice_inbound', (select count(*) from esblu_backup_p15_20261124.einvoice_inbound), (select count(*) from public.einvoice_inbound)
  union all select 'einvoice_outbound', (select count(*) from esblu_backup_p15_20261124.einvoice_outbound), (select count(*) from public.einvoice_outbound)
  union all select 'einvoice_events', (select count(*) from esblu_backup_p15_20261124.einvoice_events), (select count(*) from public.einvoice_events)
  union all select 'einvoice_mandates', (select count(*) from esblu_backup_p15_20261124.einvoice_mandates), (select count(*) from public.einvoice_mandates)
  union all select 'documents', (select count(*) from esblu_backup_p15_20261124.documents), (select count(*) from public.documents)
  union all select 'storage_objects', (select count(*) from esblu_backup_p15_20261124.storage_objects), (select count(*) from storage.objects)
  union all select 'billing_invoice_documents', (select count(*) from esblu_backup_p15_20261124.billing_invoice_documents), (select count(*) from public.billing_invoice_documents)
) t;
commit;
-- Overenie: select * from esblu_backup_p15_20261124.completeness where not ok;  → 0 riadkov
