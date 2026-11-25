-- =============================================================================
-- P1-5 skupina D — snímka chránených údajov (READ-ONLY). Spúšťa Claude cez SQL PRED a PO každom kroku výmazu.
-- Všetky hodnoty musia byť PRED = PO (okrem riadkov firmy, ktorá sa práve maže — tie tu nie sú).
--   A) 16 pôvodných firiem: doklady (celé riadky), e-faktúry, udalosti, objekty, účty — rovnaký výpočet ako skupina C
--      (referencia 2026-11-24: b3917b95…, objekty mimo P15 2b33662b…, účty 8aaff21a…).
--   B) QA-P15-ISO: počty + md5 obsahu tabuliek a objektov.
--   C) billing-documents: objekty + billing_invoice_documents.
--   D) zoznam P15 firiem, ktoré ešte existujú (kontrola, že zmizla iba schválená).
-- =============================================================================
with orig as (
  select c.id as company_id,
    (select md5(coalesce(string_agg(md5(to_jsonb(i)::text), '' order by i.id), '')) from public.invoices i where i.company_id = c.id) as invoices_md5,
    (select md5(coalesce(string_agg(o.bucket_id || o.name || o.id::text || o.updated_at::text, '' order by o.bucket_id, o.name), ''))
       from storage.objects o where left(o.name, 37) = c.id::text || '/') as objects_md5
  from public.companies c where c.id::text not like 'f151%'),
iso as (select 'f1510000-0000-4000-8000-000000000003'::uuid id)
select
  (select count(*) from orig) orig_companies,
  (select md5(string_agg(company_id::text || invoices_md5 || objects_md5, '' order by company_id)) from orig) orig_snapshot_md5,
  (select count(*) from storage.objects where name not like 'f151%') non_p15_objects,
  (select md5(string_agg(bucket_id || name || id::text || updated_at::text, '' order by bucket_id, name)) from storage.objects where name not like 'f151%') non_p15_objects_md5,
  (select count(*) from auth.users where id::text not like 'f150%') users_other,
  (select md5(string_agg(id::text || coalesce(email, '') || coalesce(last_sign_in_at::text, ''), ',' order by id)) from auth.users where id::text not like 'f150%') users_other_md5,
  (select count(*) from public.billing_invoice_documents) billing_docs,
  (select md5(string_agg(to_jsonb(b)::text, ',' order by b.id)) from public.billing_invoice_documents b) billing_docs_md5,
  (select count(*) from storage.objects where bucket_id = 'billing-documents') billing_objects,
  (select md5(string_agg(name || id::text || updated_at::text, ',' order by name)) from storage.objects where bucket_id = 'billing-documents') billing_objects_md5,
  (select jsonb_build_object(
     'company', (select md5(to_jsonb(c)::text) from public.companies c where c.id = iso.id),
     'members', (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by m.user_id), '')) from public.company_members m where m.company_id = iso.id),
     'invoices', (select md5(coalesce(string_agg(to_jsonb(i)::text, ',' order by i.id), '')) from public.invoices i where i.company_id = iso.id),
     'inbound', (select md5(coalesce(string_agg(to_jsonb(i)::text, ',' order by i.id), '')) from public.einvoice_inbound i where i.company_id = iso.id),
     'outbound', (select md5(coalesce(string_agg(to_jsonb(o)::text, ',' order by o.id), '')) from public.einvoice_outbound o where o.company_id = iso.id),
     'events', (select count(*) from public.einvoice_events e where e.company_id = iso.id),
     'mandates', (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by m.id), '')) from public.einvoice_mandates m where m.company_id = iso.id),
     'documents', (select md5(coalesce(string_agg(to_jsonb(d)::text, ',' order by d.id), '')) from public.documents d where d.company_id = iso.id),
     'objects', (select md5(coalesce(string_agg(o.bucket_id || o.name || o.id::text || o.updated_at::text || coalesce(o.metadata->>'eTag', ''), ',' order by o.bucket_id, o.name), ''))
                 from storage.objects o where left(o.name, 37) = iso.id::text || '/'),
     'object_count', (select count(*) from storage.objects o where left(o.name, 37) = iso.id::text || '/'),
     'owner', (select md5(id::text || coalesce(email, '') || coalesce(last_sign_in_at::text, '')) from auth.users where id = 'f1500000-0000-4000-8000-000000000103')
   ) from iso) iso_snapshot,
  (select string_agg(name, ',' order by name) from public.companies where id::text like 'f151%') p15_companies_left,
  (select count(*) from storage.objects where name like 'f151%') p15_objects_left,
  (select count(*) from supabase_migrations.schema_migrations) migrations;
