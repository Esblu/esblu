-- =============================================================================
-- P1-5 staging — snímka izolácie (READ-ONLY). Spúšťa sa PRED a PO každom kroku, ktorý zapisuje alebo maže.
-- Výsledok PRED a PO sa musí pre všetky firmy mimo zoznamu testovacích UUID zhodovať riadok po riadku.
-- Nepoužíva nové funkcie z 20261127/20261128 (funguje pred aj po migrácii).
-- Parameter: zoznam UUID syntetických firiem P15 (vytvorených v kroku W2), ktoré sa smú meniť.
--   pred spustením nahradiť '{}' v CTE excluded zoznamom UUID (pred W2 ostáva prázdne pole)
-- =============================================================================
with excluded as (select unnest('{}'::uuid[]) id),
companies as (select c.id from public.companies c where c.id not in (select id from excluded))
select c.id as company_id,
  (select count(*) from public.invoices i where i.company_id = c.id) as invoices,
  (select md5(coalesce(string_agg(md5(to_jsonb(i)::text), '' order by i.id), '')) from public.invoices i where i.company_id = c.id) as invoices_md5,
  (select count(*) from public.einvoice_inbound i where i.company_id = c.id) as inbound,
  (select md5(coalesce(string_agg(i.id::text || coalesce(i.xml_sha256, ''), '' order by i.id), '')) from public.einvoice_inbound i where i.company_id = c.id) as inbound_md5,
  (select count(*) from public.einvoice_outbound o where o.company_id = c.id) as outbound,
  (select count(*) from public.einvoice_events e where e.company_id = c.id) as events,
  (select count(*) from public.einvoice_mandates m where m.company_id = c.id) as mandates,
  (select count(*) from public.documents d where d.company_id = c.id) as documents,
  (select count(*) from public.company_members m where m.company_id = c.id) as members,
  (select count(*) from storage.objects o where left(o.name, 37) = c.id::text || '/') as objects,
  (select md5(coalesce(string_agg(o.bucket_id || o.name || o.id::text || o.updated_at::text, '' order by o.bucket_id, o.name), ''))
     from storage.objects o where left(o.name, 37) = c.id::text || '/') as objects_md5
from companies c
union all
select null, (select count(*) from public.billing_invoice_documents), null, null, null, null, null, null, null, null,
  (select count(*) from storage.objects where bucket_id = 'billing-documents'),
  (select md5(coalesce(string_agg(name || id::text || updated_at::text, '' order by name), '')) from storage.objects where bucket_id = 'billing-documents')
order by 1 nulls last;
