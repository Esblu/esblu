-- =============================================================================
-- M1 authz follow-up (2026-09-28) — Inbox zložky (custom_document_categories)
-- NEAPLIKOVANÉ. Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
--
-- Pred:
--   custom_document_categories_insert_company  TO public
--     WITH CHECK (company_id = esblu_my_active_company_id() AND created_by = auth.uid())
--   → ktorýkoľvek aktívny člen (aj zamestnanec) mohol priamo cez PostgREST
--     založiť firemnú zložku Inboxu s ľubovoľným názvom a popisom. Zložky sú
--     viditeľné celej firme (select_company) a ponúkajú sa pri triedení
--     dokladov — zamestnanec tak mohol meniť organizačnú štruktúru dokladov
--     (aj finančných), hoci ich spravovať nesmie.
--   UPDATE/DELETE už boli iba owner/admin/accountant (…_manager politiky) a
--   presun dokladov do zložky vyžaduje UPDATE na documents (finance manage
--   pre finančné doklady) — to sa nemení.
--
-- Kto zložky zakladá (overené v kóde): iba asistent, akcia
-- CREATE_DOCUMENT_CATEGORY (lib/intents/actions.ts → createCustomCategory),
-- požiadavka "category_manage" = owner/admin/accountant. UI Inboxu správu
-- zložiek ukazuje iba týmto rolám (canManageFolders). Príjem dokladu
-- zamestnancom (/api/inbox/intake) zložky nezakladá ani nepriraďuje.
--
-- Po: INSERT iba owner/admin/accountant (rovnaká množina ako UPDATE/DELETE
-- a ako brána asistenta), iba do vlastnej aktívnej firmy, created_by = volajúci.
-- Čítanie zložiek sa nemení.
--
-- ROLLBACK:
--   drop policy if exists custom_document_categories_insert_manager on public.custom_document_categories;
--   create policy custom_document_categories_insert_company on public.custom_document_categories
--     for insert with check (company_id = public.esblu_my_active_company_id() and created_by = auth.uid());
-- =============================================================================

begin;

drop policy if exists custom_document_categories_insert_company on public.custom_document_categories;
drop policy if exists custom_document_categories_insert_manager on public.custom_document_categories;

create policy custom_document_categories_insert_manager
  on public.custom_document_categories
  for insert
  to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and created_by = (select auth.uid())
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text, 'accountant'::text])
  );

commit;
