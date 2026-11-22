-- Rollback 20261124100000_billing_document_company_link (staging/produkcia iba so súhlasom).
-- Odstráni iba triggery a funkcie. Doplnené company_id a snapshoty odberateľa v billing_invoice_documents
-- sú účtovné údaje Esblu — rollback ich NEMENÍ ani NEMAŽE. Otvorené alerty DOCUMENT_WITHOUT_COMPANY ostávajú v histórii.
begin;
drop trigger if exists esblu_billing_documents_link_company on public.billing_provider_links;
drop trigger if exists esblu_billing_documents_company_consistency on public.billing_invoice_documents;
drop function if exists public.esblu_billing_ops_collect_documents(text);
drop function if exists public.esblu_billing_documents_company_consistency();
drop function if exists public.esblu_billing_documents_link_company();
commit;
