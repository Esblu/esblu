-- =============================================================================
-- 20261129100000: Zásady spracúvania osobných údajov 1.5 (Resend)
-- =============================================================================
-- Jediná obsahová zmena oproti 1.4 (finálne znenie CLIA 09.11.2026): v častiach Registrácia, Prihlasovanie a
-- Zasielanie oznámení je doplnený príjemca Plus Five Five, Inc. (Resend) a informácia o prenose (EU-US DPF + SCC).
-- Supabase Auth odosiela autentifikačné e-maily cez SMTP Resend od 17. 11. 2026.
-- required = true → existujúci používatelia potvrdia oboznámenie cez LegalAcceptanceGate (rovnaký model ako 1.4).
-- content_hash = sha256(legal/privacy/1.5.md). legal_documents je append-only → iba INSERT, idempotentné.
-- Poradie: migrácia spolu s kódom (privacyPolicyVersion "1.5"). Rollback: kód s verziou 1.4; riadok 1.5 ostáva
-- (append-only, bez dopadu, kým ho kód nepožaduje).
-- =============================================================================

insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path)
values (
  'privacy_policy', '1.5', now(), true,
  'c488c7dca4f20e45f9ffd26dcb1dc161f98b3d723e2276e20989edc0bf5201fa',
  '/ochrana-osobnych-udajov'
)
on conflict (type, version) do nothing;
