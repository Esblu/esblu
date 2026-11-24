-- =============================================================================
-- P1-5 staging — OBNOVA zo zálohy esblu_backup_p15_20261124 (NÁVRH, NESPÚŠŤAŤ bez osobitného schválenia).
-- Iba esblu-test (cjbdijbbcujvmrzezusd). Použitie: iba ak snímka izolácie po teste ≠ snímka pred testom.
--
-- Poradie obnovy:
--   1) funkcie / triggery: rollback SQL (najprv 20261128, potom 20261127) — obnoví stav s esblu_retention
--        supabase/rollback/20261128100000_termination_purge_export_integrity_rollback.sql
--        supabase/rollback/20261127100000_company_termination_customer_delete_rollback.sql
--      kontrola: pg_get_functiondef(...) = esblu_backup_p15_20261124.function_defs.definition
--   2) dáta: chýbajúce riadky existujúcich firiem späť (iba INSERT … ON CONFLICT DO NOTHING; nič sa neprepisuje
--      ani nemaže). Stĺpce = prienik zálohy a živej tabuľky (migrácie pridávajú stĺpce).
--   3) Storage: záloha obsahuje iba metadáta storage.objects, NIE bajty — súbory sa z nej obnoviť nedajú
--      (pozri návrh nezávislej šifrovanej kópie v reporte zálohy).
-- =============================================================================
begin;
-- Insert triggery (oprávnenia, DPA, nárok na fakturáciu) by obnovu historických riadkov odmietli (overené offline:
-- ENTITLEMENT_DENIED). Obnova preto beží v režime replica (triggery sa nespúšťajú). Ak rola postgres na stagingu
-- tento parameter nastaviť nesmie, alternatíva (osobitné schválenie): v tej istej transakcii
-- `alter table public.<t> disable trigger user` → insert → `enable trigger user`.
set local session_replication_role = replica;
do $$
declare
  t text;
  cols text;
  n bigint;
begin
  -- rodičia pred deťmi (FK)
  foreach t in array array['companies', 'company_members', 'invoices', 'invoice_items', 'invoice_events',
    'invoice_accounting_state_log', 'documents', 'einvoice_organizations', 'einvoice_outbound', 'einvoice_inbound',
    'einvoice_events', 'einvoice_mandates', 'einvoice_deregistrations', 'company_export_runs', 'company_terminations',
    'account_deletion_cleanup_jobs', 'billing_invoice_documents'] loop
    select string_agg(quote_ident(b.column_name), ', ' order by b.ordinal_position) into cols
    from information_schema.columns b
    join information_schema.columns l on l.table_schema = 'public' and l.table_name = t and l.column_name = b.column_name
    where b.table_schema = 'esblu_backup_p15_20261124' and b.table_name = t
      and l.is_generated = 'NEVER' and l.identity_generation is null;
    execute format('insert into public.%1$I (%2$s) select %2$s from esblu_backup_p15_20261124.%1$I on conflict do nothing', t, cols);
    get diagnostics n = row_count;
    raise notice 'restore %: % riadkov doplnených', t, n;
  end loop;
end $$;
-- Kontrola po obnove: scripts/sql/p15-staging-isolation-snapshot.sql = baseline b3917b95420abdbd3b4ad50cbbece2a2
commit;
