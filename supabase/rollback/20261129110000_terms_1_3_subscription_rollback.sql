-- Rollback 20261129110000_terms_1_3_subscription.sql
-- Povolené iba ak VOP 1.3 ešte nikto neprijal a nebolo k nim odoslané oznámenie — dôkaz sa nikdy nemaže.
-- Pred rollbackom vrátiť kód na termsVersion "1.2".
do $$
begin
  if exists (select 1 from public.user_legal_acceptances where document_type = 'terms' and version = '1.3')
     or exists (select 1 from public.company_dpa_acceptances where document_type = 'terms' and version = '1.3')
     or exists (select 1 from public.company_terms_notices where terms_version = '1.3') then
    raise exception 'ROLLBACK_BLOCKED: VOP 1.3 už majú prijatia alebo oznámenia';
  end if;
end $$;
alter table public.legal_documents disable trigger esblu_legal_documents_no_delete;
delete from public.legal_documents where (type, version) = ('terms', '1.3');
alter table public.legal_documents enable trigger esblu_legal_documents_no_delete;
