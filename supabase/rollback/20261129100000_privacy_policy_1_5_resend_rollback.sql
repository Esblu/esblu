-- Rollback 20261129100000_privacy_policy_1_5_resend.sql
-- legal_documents je append-only (trigger esblu_legal_documents_no_delete). Rollback je prípustný
-- IBA ak ešte nikto 1.5 nepotvrdil (inak by vznikla acceptance bez dokumentu) — preto fail closed.
-- Pred rollbackom vrátiť kód na privacyPolicyVersion "1.4".
do $$
begin
  if exists (select 1 from public.user_legal_acceptances where document_type = 'privacy_policy' and version = '1.5') then
    raise exception 'ROLLBACK_BLOCKED: privacy_policy 1.5 už má potvrdenia';
  end if;
end $$;
alter table public.legal_documents disable trigger esblu_legal_documents_no_delete;
delete from public.legal_documents where (type, version) = ('privacy_policy', '1.5');
alter table public.legal_documents enable trigger esblu_legal_documents_no_delete;
