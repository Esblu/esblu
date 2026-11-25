-- =============================================================================
-- 20261129100000: Zásady spracúvania osobných údajov 1.5 (Resend)
-- =============================================================================
-- Znenie CLIA „GDPR_ESBLU 2.0“ (Zásady, posledná aktualizácia 23.11.2026) prenesené do 1.4: Google prihlásenie aj
-- v aplikácii Android; v časti Zasielanie oznámení príjemca Plus Five Five, Inc. (Resend) a prenos do USA (SCC + DPF).
-- Supabase Auth odosiela autentifikačné e-maily cez SMTP Resend od 17. 11. 2026.
-- required = true → existujúci používatelia potvrdia oboznámenie cez LegalAcceptanceGate (rovnaký model ako 1.4).
-- content_hash = sha256(legal/privacy/1.5.md). legal_documents je append-only → iba INSERT, idempotentné.
-- Poradie: migrácia spolu s kódom (privacyPolicyVersion "1.5"). Rollback: kód s verziou 1.4; riadok 1.5 ostáva
-- (append-only, bez dopadu, kým ho kód nepožaduje).
-- =============================================================================

insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path)
values (
  'privacy_policy', '1.5', now(), true,
  '3de5c1581070ba391505055e699eae15d38ba617a357ba4ce0678eb2703b51ce',
  '/ochrana-osobnych-udajov'
)
on conflict (type, version) do nothing;
