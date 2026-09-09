begin;

-- =============================================================================
-- Esblu — prechod identifikácie prevádzkovateľa z fyzickej osoby (Jaroslav
-- Juriš) na právnickú osobu Esblu s. r. o.
-- =============================================================================
-- Kontext: Esblu odteraz prevádzkuje spoločnosť Esblu s. r. o., so sídlom
-- Karpatské námestie 10A, 831 06 Bratislava – mestská časť Rača, Slovenská
-- republika, IČO: 57 815 941 (predtým fyzická osoba Jaroslav Juriš). DIČ ani
-- IČ DPH sa neuvádzajú (nie sú pre aktuálny rozsah reálne potrebné). Deň
-- zápisu spoločnosti do obchodného registra sa vedome neuvádza — nie je
-- súčasťou tejto zmeny a nie je potrebný pre žiadny z právnych textov.
--
-- Jediná obsahová zmena oproti predchádzajúcim verziám je táto identifikácia
-- prevádzkovateľa (meno, právna forma, sídlo, IČO) v úvodnej vete/sekcii —
-- zvyšok právneho obsahu je bezo zmeny. Nové .md súbory (legal/terms/1.1.md,
-- legal/privacy/1.3.md, legal/dpa/1.2.md + .en.md/.de.md preklady) sú
-- nemenné obsahové súbory (rovnaký vzor ako predchádzajúce verzie).
-- content_hash nižšie je SHA-256 presne slovenského zdrojového súboru
-- (overiteľné príkazom `sha256sum legal/<typ>/<verzia>.md`) — vypočítané cez
-- pgcrypto digest() nad identickým textovým obsahom, ktorý bol zapísaný do
-- príslušného .md súboru v tomto commite.
--
-- required=true pre terms a privacy_policy (rovnako ako pri všetkých
-- predchádzajúcich obsahových zmenách týchto dvoch dokumentov) — existujúci
-- používatelia dostanú po tejto migrácii pri ďalšom prihlásení blokujúci
-- modal (LegalAcceptanceGate) na potvrdenie novej verzie. Toto je ZÁMERNÉ,
-- štandardné správanie existujúceho legal acceptance modelu, nie nová
-- vlastnosť zavedená touto migráciou (pozri precedens v migrácii
-- 20260816120000_add_privacy_policy_v1_2_namecheap.sql).
--
-- required=false pre dpa (rovnako ako pri v1.0/v1.1 — DPA je informačný/B2B
-- dokument bez osobnej acceptance povinnosti pre bežného používateľa).
--
-- effective_at je zámerne now() (rovnaký vzor ako pri predchádzajúcich
-- verziách) — vyhodnotí sa v momente reálnej aplikácie tejto migrácie.
--
-- Historické verzie (terms 1.0, privacy 1.0/1.1/1.2, dpa 1.0/1.1) zostávajú
-- v tabuľke nezmenené — legal_documents je append-only (UPDATE/DELETE
-- zablokované DB triggerom), takže tento krok iba PRIDÁVA tri nové riadky.
-- =============================================================================

insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path)
values
  (
    'terms', '1.1', now(), true,
    'dd7aca8182836036eca20ef007ef9673be747d4fdfa3489f03004065236ddb0f',
    '/podmienky-pouzivania'
  ),
  (
    'privacy_policy', '1.3', now(), true,
    'ceb4de69c580309bc14f99708cbfd79365b1307806203eeb91151af1fb49870c',
    '/ochrana-osobnych-udajov'
  ),
  (
    'dpa', '1.2', now(), false,
    'e45c51e8f49428d40078c77847cfe1937c262b952ddc92c9d8e913a235c02754',
    '/dpa'
  )
on conflict (type, version) do nothing;

commit;
