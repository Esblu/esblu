-- Rollback 20261111110000_clia_j10_1_dpa_1_3.sql — iba ak DPA 1.3 ešte žiadna firma neprijala.
do $$
begin
  if exists (select 1 from public.company_dpa_acceptances where document_type = 'dpa' and version = '1.3') then
    raise exception 'ROLLBACK_BLOCKED: dpa 1.3 už má prijatia';
  end if;
end $$;
alter table public.legal_documents disable trigger esblu_legal_documents_no_delete;
delete from public.legal_documents where type = 'dpa' and version = '1.3';
alter table public.legal_documents enable trigger esblu_legal_documents_no_delete;
