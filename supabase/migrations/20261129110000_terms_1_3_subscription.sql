-- =============================================================================
-- 20261129110000: VOP 1.3 — podmienky plateného predplatného
-- =============================================================================
-- Zmeny oproti 1.2 (iba doplnenia / spresnenia, číslovanie ostatných článkov bez zmeny):
--   10.4 objednanie v Aplikácii (zobrazenie ceny, obdobia, automatického predĺženia), 10.5 účinnosť po úhrade,
--   11.4 ceny v EUR a DPH, 12.2 Stripe a strhávanie pri predĺžení, 12.6 neúspešná platba (7 dní),
--   12.7 reklamácie (30 dní), 16.4 ochranná lehota 48 h, 16.5 refundácie, 16.6 účinok úplnej refundácie.
-- Rovnaký model ako 1.2: firemné prijatie Vlastníkom (required=false), oznámenie s lehotou 30 dní
-- (VOP 1.2 čl. 39.2) — do jej uplynutia platí pre firmu 1.2, potom Aplikácia vyžiada prijatie 1.3.
-- content_hash = sha256(legal/terms/1.3.md). legal_documents je append-only → iba INSERT, idempotentné.
-- Rollback: supabase/rollback/20261129110000_terms_1_3_subscription_rollback.sql (fail closed pri prijatiach 1.3).
-- =============================================================================

insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path, reaccept_notice_days)
values ('terms', '1.3', now(), false, '691d4455b831540c9ac5cb63cff155cab7ac38265f4f549fd7505eceae4a5111', '/podmienky-pouzivania', 30)
on conflict (type, version) do nothing;
