-- Rollback 20261110110000_clia_privacy_1_4_cookies_1_1.sql
-- legal_documents je append-only (trigger esblu_legal_documents_no_delete). Rollback je prípustný
-- IBA ak ešte nikto 1.4 / 1.1 nepotvrdil (inak by vznikla acceptance bez dokumentu) — preto fail closed.
-- Pred rollbackom vrátiť kód na privacyPolicyVersion "1.3" / cookiePolicyVersion "1.0".
do $$
begin
  if exists (select 1 from public.user_legal_acceptances where document_type = 'privacy_policy' and version = '1.4') then
    raise exception 'ROLLBACK_BLOCKED: privacy_policy 1.4 už má potvrdenia';
  end if;
end $$;
alter table public.legal_documents disable trigger esblu_legal_documents_no_delete;
delete from public.legal_documents where (type, version) in (('privacy_policy', '1.4'), ('cookie_policy', '1.1'));
alter table public.legal_documents enable trigger esblu_legal_documents_no_delete;
