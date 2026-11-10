-- =============================================================================
-- J10 CLIA GDPR reconciliation — nové verzie informačných dokumentov
-- =============================================================================
-- privacy_policy 1.4 = finálne znenie CLIA „Zásady spracúvania osobných
--   údajov“ (09.11.2026), slovenský originál prevzatý doslovne
--   (legal/privacy/1.4.md); jediný doplnok je odkaz na sekciu „Informácie
--   o cookies“ v mieste zástupného riadku CLIA. required = true → existujúci
--   používatelia potvrdia oboznámenie cez LegalAcceptanceGate (informačné
--   potvrdenie, nie súhlas podľa čl. 6 ods. 1 písm. a) — rovnaký model ako 1.3).
-- cookie_policy 1.1 = reálny inventár technológií (CLIA manuál čl. VI),
--   required = false (informačný dokument, bez potvrdzovania).
--
-- content_hash = sha256 slovenského súboru (rovnako ako predchádzajúce seedy).
-- legal_documents je append-only (UPDATE/DELETE blokuje trigger) → iba INSERT.
-- Idempotentné: on conflict do nothing.
--
-- ROLLBACK (iba staging, pred nasadením kódu s verziou 1.4/1.1):
--   riadky sú chránené triggerom proti DELETE; rollback = nasadiť kód s
--   privacyPolicyVersion "1.3" / cookiePolicyVersion "1.0" a nový riadok
--   označiť ako neaktuálny nie je možné — preto túto migráciu aplikovať až
--   spolu s kódom (rovnaký postup ako 20260909100000).
-- =============================================================================

insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path)
values
  (
    'privacy_policy', '1.4', now(), true,
    'fc8197f0f60e4759b6557b0b491358a046cc85b840b2a710178fc9bd3b7667cf',
    '/ochrana-osobnych-udajov'
  ),
  (
    'cookie_policy', '1.1', now(), false,
    '2f1324300a4be9e80dad9601c0161ea258ebe4ab298160d6a5fc6436a377e1bc',
    '/cookies'
  )
on conflict (type, version) do nothing;
