-- =============================================================================
-- P1-5 precheck (READ-ONLY) pred aplikovaním 20261127100000 + 20261128100000 na staging/produkciu.
-- Iba SELECT. Očakávanie: všetky počty v sekcii „blokuje“ = 0.
-- =============================================================================
-- blokuje: nedokončené cleanup joby s cieľmi, ktoré nová ochrana odmietne (billing-documents / einvoice-documents)
select 'pending_jobs_protected_targets' as check_name, count(*) as n
from public.account_deletion_cleanup_jobs j, jsonb_array_elements(coalesce(j.storage_targets, '[]'::jsonb)) x
where (j.storage_status = 'pending' or j.auth_status = 'pending')
  and x.value->>'bucket' in ('billing-documents', 'einvoice-documents');
-- blokuje: ukončenie v stave executing (nedokončená transakcia by nemala existovať)
select 'terminations_executing' as check_name, count(*) as n from public.company_terminations where status = 'executing';
-- info: objekty v einvoice-documents mimo prefixu existujúcej firmy (osirelé po skoršom ukončení — 20261112 súbory nemazal)
select 'einvoice_objects_without_company' as check_name, count(*) as n
from storage.objects o
where o.bucket_id = 'einvoice-documents'
  and not exists (select 1 from public.companies c where left(o.name, 37) = c.id::text || '/');
-- info: existujúce ukončenia a behy exportu (prejdú novými obmedzeniami; nové stĺpce = NULL)
select 'terminations_total' as check_name, count(*) as n from public.company_terminations;
select 'export_runs_total' as check_name, count(*) as n from public.company_export_runs;
-- info: doklady RECIPIENT_MISMATCH (pred LIVE musí byť aplikovaná 20261125100000 — RLS)
select 'recipient_mismatch_rows' as check_name, count(*) as n from public.einvoice_inbound where last_error_code = 'RECIPIENT_MISMATCH';
