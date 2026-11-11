-- =============================================================================
-- J10.1 — DPA 1.3 = Zmluva o spracúvaní osobných údajov CLIA (09.11.2026)
-- s minimálnymi úpravami pre elektronické uzatvorenie podľa stanoviska CLIA
-- z 11.11.2026 (čl. I Prevádzkovateľ, 10.1, 11.4, 11.7, podpisová časť) —
-- diff: docs/clia-gdpr-reconciliation-2026-11-10.md §18.3.
-- required = false (DPA nie je osobné potvrdenie); company-level gate si
-- novú účinnú verziu vyžiada od ownera každej firmy (CompanyDpaGate +
-- DB guard esblu_require_company_dpa_current).
-- content_hash = sha256 legal/dpa/1.3.md (SK originál; EN/DE = preklady
-- tej istej verzie, nemajú vlastný riadok).
-- Rollback: supabase/rollback/20261111110000_clia_j10_1_dpa_1_3_rollback.sql
-- =============================================================================
insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path)
values ('dpa', '1.3', now(), false, '07f769ca52b5fe4dd728e8d575b07a40ae046c844d011a968c4d01ab28a42839', '/dpa')
on conflict (type, version) do nothing;
