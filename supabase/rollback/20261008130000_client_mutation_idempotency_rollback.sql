-- Rollback 20261008130000_client_mutation_idempotency (STAGING ONLY).
-- Zhodí iba index a stĺpec client_mutation_id — business dáta sa nemenia.
-- Klient bez stĺpca: insert s client_mutation_id by zlyhal (PGRST204) →
-- pred rollbackom nasadiť klienta bez kľúča (alebo ponechať stĺpec a zhodiť iba index).
begin;
do $rb$
declare
  t text;
begin
  foreach t in array array['invoices', 'business_partners', 'vehicles', 'machines', 'inventory_items', 'document_folders', 'chat_messages']
  loop
    execute format('drop index if exists public.%I', t || '_client_mutation_uidx');
    execute format('alter table if exists public.%I drop column if exists client_mutation_id', t);
  end loop;
end
$rb$;
commit;
