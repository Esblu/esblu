-- =============================================================================
-- M1 authz final hardening (2026-09-28) — documents INSERT podľa roly a tvaru
-- NEAPLIKOVANÉ. Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
-- PORADIE: 20260930125000 (RPC) → Vault kľúč + ESBLU_INTAKE_ATTEST_SECRET →
-- nasadenie kódu app/api/inbox/intake/route.ts (INSERT bez polí + podpísané
-- RPC) → AŽ POTOM táto migrácia. Starý kód vkladá príjem s poľami a táto
-- politika by ho odmietla.
--
-- PRED (prod katalóg 2026-09-28):
--   documents_insert_company  TO authenticated
--     WITH CHECK (company_id = esblu_my_active_company_id())
--   + BEFORE INSERT triggre: esblu_assign_company_id (prepíše company_id na
--     aktívnu firmu volajúceho), esblu_require_company_dpa_current.
--   Každý aktívny člen (aj zamestnanec) si teda priamo cez PostgREST volil
--   VŠETKY ostatné stĺpce: user_id (za iného člena), document_type (ľubovoľný
--   typ), status (aj 'confirmed'), ai_model, ai_raw_output, extracted_fields
--   (dodávateľ, sumy, čísla), field_confidence, note, custom_category_id,
--   archived_from_inbox_at (doklad rovno „zmizne" z Inboxu), deleted_at,
--   created_at/updated_at (spätný dátum), storage_bucket/storage_path
--   (aj cesta k cudziemu súboru v Storage — riadok documents potom podľa
--   esblu_can_read_ai_inbox_object sprístupní ten súbor, ak jeho typ
--   označí ako nefinančný).
--
-- PO: spoločný základ pre KAŽDÚ rolu
--   - company_id = aktívna firma (trigger ho aj tak prepíše),
--   - user_id = auth.uid() (nikdy za iného),
--   - storage_bucket = 'ai-inbox-documents' a prvý segment storage_path =
--     auth.uid() (iba vlastný súbor — rovnaké pravidlo ako Storage INSERT),
--   - deleted_at, archived_from_inbox_at, updated_at = NULL,
--   - created_at = teraz (−5 min … +1 min; klienti ho neposielajú),
--   - custom_category_id NULL alebo zložka vlastnej firmy,
-- a práve jedna z vetiev:
--   A) FINANČNÝ SPRÁVCA (esblu_my_finance_manage: owner, accountant, admin
--      s finance.manage): invoice / receipt / delivery_note, ľubovoľný
--      platný stav a vyťažené polia — to je ich vlastná kontrola dokladu
--      (Inbox „prijatá faktúra", „ostatné doklady").
--   B) PRÍJEM (každý aktívny člen — zamestnanec, admin bez financií alebo
--      iba s finance.view): invoice / receipt, status = 'needs_review',
--      ai_model / ai_raw_output / extracted_fields / field_confidence = NULL,
--      bez zložky. Vyťažené údaje zo zapečateného skenu pripojí VÝHRADNE
--      esblu_attach_intake_extraction s HMAC podpisom servera (20260930125000;
--      bez service_role). Klient teda nemôže podvrhnúť dodávateľa ani sumy,
--      zvoliť stav ani typ.
--      (Dodací list zamestnanca ide do ai_evidence, nie sem.)
--   C) PREVÁDZKOVÝ DOKLAD (owner, admin): insurance / vehicle_registration /
--      service_document / other — PZP, TP, servisné doklady z Inboxu a
--      z formulára vozidla. Zamestnanec ani účtovník NIE.
-- UPDATE/DELETE politiky sa nemenia (zamestnanec ich nemá).
--
-- ROLLBACK:
--   drop policy if exists documents_insert_scoped on public.documents;
--   create policy documents_insert_company on public.documents
--     for insert to authenticated with check (company_id = public.esblu_my_active_company_id());
-- =============================================================================

begin;

drop policy if exists documents_insert_company on public.documents;
drop policy if exists documents_insert_scoped on public.documents;

create policy documents_insert_scoped
  on public.documents
  for insert
  to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and user_id = (select auth.uid())
    and storage_bucket = 'ai-inbox-documents'
    and split_part(storage_path, '/', 1) = (select auth.uid())::text
    and deleted_at is null
    and archived_from_inbox_at is null
    and updated_at is null
    and created_at >= now() - interval '5 minutes'
    and created_at <= now() + interval '1 minute'
    and (
      custom_category_id is null
      or exists (
        select 1 from public.custom_document_categories c
        where c.id = documents.custom_category_id
          and c.company_id = public.esblu_my_active_company_id()
      )
    )
    and (
      -- A) finančný správca
      (
        document_type = any (array['invoice'::text, 'receipt'::text, 'delivery_note'::text])
        and public.esblu_my_finance_manage()
      )
      -- B) príjem bez čítania — minimálny tvar
      or (
        document_type = any (array['invoice'::text, 'receipt'::text])
        and status = 'needs_review'
        -- hash originálu je povinný: atestácia a potvrdenie sa naň viažu
        and content_sha256 is not null
        and ai_model is null
        and ai_raw_output is null
        and extracted_fields is null
        and field_confidence is null
        and custom_category_id is null
      )
      -- C) prevádzkový doklad
      or (
        document_type = any (array['insurance'::text, 'vehicle_registration'::text, 'service_document'::text, 'other'::text])
        and (select public.esblu_my_active_role()) = any (array['owner'::text, 'admin'::text])
      )
    )
  );

commit;
