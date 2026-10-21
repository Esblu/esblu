-- =============================================================================
-- GRANTS CLEANUP: settings.locale + policy hygiene (TO public → TO authenticated)
--
-- 1. settings.locale — tichá chyba
-- --------------------------------
-- lib/i18n/LocaleProvider.tsx zapisuje jazyk UI priamo cez Data API:
--   update public.settings set locale = … where user_id = auth.uid()
-- Stĺpec pridala 20260819090000_add_settings_locale.sql, ale stĺpcový grant
-- z 20260721000100 povoľuje authenticated UPDATE iba (company_name, logo_path)
-- → každý zápis jazyka končil `42501 permission denied` a appka chybu
-- zahodila. `settings` je PER-USER tabuľka (1 riadok na auth používateľa,
-- unique user_id, bez company_id, politika auth.uid() = user_id; 20260814160000
-- ju zámerne vynecháva z company RLS) a jazyk je preferencia človeka, nie firmy
-- — miesto uloženia je správne, chýba iba grant. Pridáva sa VÝHRADNE stĺpec
-- locale; plan ani iné stĺpce klient meniť nemôže. Hodnotu stráži
-- settings_locale_check (sk/de/en/NULL).
--
-- 2. Policy hygiene
-- -----------------
-- 27 politík na business tabuľkách bolo `TO public` (implicitne aj anon),
-- hoci všetky stoja na auth.uid() / esblu_my_active_company_id() a anon na
-- týchto tabuľkách nemá žiadny grant. Prakticky bezpečné, ale nehygienické:
-- anon request dostal „permission denied for function esblu_…“ (planner narazil
-- na helper v politike) a ochrana stála iba na jednej vrstve. Mení sa IBA zoznam
-- rolí (ALTER POLICY … TO authenticated) — USING / WITH CHECK zostávajú presne
-- rovnaké. service_role RLS obchádza (BYPASSRLS), vlastník tabuľky tiež → bez
-- dopadu na server. Žiadna z politík nepatrí verejnému flow (legal_documents
-- má vlastnú politiku TO anon, authenticated; pozvánky idú cez SECURITY DEFINER
-- RPC) — žiadna `TO public` politika v public schéme nezostáva.
--
-- Bez zmeny dát, bez zmeny business logiky. Idempotentné.
-- ROLLBACK: supabase/rollback/20261022100000_grants_locale_and_policy_hygiene_rollback.sql
-- grants: explicit (settings.locale UPDATE pre authenticated; manifest aktualizovaný)
-- =============================================================================

-- 1. settings.locale
grant update (locale) on table public.settings to authenticated;

-- 2. TO public → TO authenticated (iba rola; podmienky bez zmeny)
alter policy business_partners_delete_finance on public.business_partners to authenticated;
alter policy business_partners_insert_finance on public.business_partners to authenticated;
alter policy business_partners_select_finance on public.business_partners to authenticated;
alter policy business_partners_update_finance on public.business_partners to authenticated;

alter policy company_billing_profile_insert_finance on public.company_billing_profile to authenticated;
alter policy company_billing_profile_select_finance on public.company_billing_profile to authenticated;
alter policy company_billing_profile_update_finance on public.company_billing_profile to authenticated;

alter policy custom_document_categories_select_company on public.custom_document_categories to authenticated;

alter policy document_attachments_insert_company on public.document_attachments to authenticated;
alter policy document_attachments_select_company on public.document_attachments to authenticated;

alter policy document_links_insert_company on public.document_links to authenticated;
alter policy document_links_select_company on public.document_links to authenticated;

alter policy documents_select_company on public.documents to authenticated;

alter policy invoice_events_select_finance on public.invoice_events to authenticated;

alter policy invoice_items_delete_finance_draft on public.invoice_items to authenticated;
alter policy invoice_items_insert_finance_draft on public.invoice_items to authenticated;
alter policy invoice_items_select_finance on public.invoice_items to authenticated;
alter policy invoice_items_update_finance_draft on public.invoice_items to authenticated;

alter policy invoice_number_sequences_select_finance on public.invoice_number_sequences to authenticated;
alter policy invoice_parties_select_finance on public.invoice_parties to authenticated;
alter policy invoice_payments_select_finance on public.invoice_payments to authenticated;
alter policy invoice_tax_breakdowns_select_finance on public.invoice_tax_breakdowns to authenticated;

alter policy invoices_delete_finance_draft on public.invoices to authenticated;
alter policy invoices_insert_finance_draft on public.invoices to authenticated;
alter policy invoices_select_finance on public.invoices to authenticated;
alter policy invoices_update_finance_draft on public.invoices to authenticated;

alter policy "Users can manage own settings" on public.settings to authenticated;

-- Fail-closed: v public schéme nesmie zostať žiadna politika TO public.
do $hygiene$
declare v text;
begin
  select string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname) into v
  from pg_policies where schemaname = 'public' and 'public' = any (roles);
  if v is not null then
    raise exception using errcode = 'P0001', message = 'ESBLU_POLICY_HYGIENE_PUBLIC_ROLE_LEFT', detail = v;
  end if;
end
$hygiene$;
