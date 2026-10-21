-- =============================================================================
-- ROLLBACK pre 20261022100000_grants_locale_and_policy_hygiene.sql
-- Vráti stĺpcový grant settings.locale (zápis jazyka znova potichu zlyhá) a
-- 27 politík späť na TO public. Podmienky politík sa nemenili. Idempotentný.
-- =============================================================================
revoke update (locale) on table public.settings from authenticated;

alter policy business_partners_delete_finance on public.business_partners to public;
alter policy business_partners_insert_finance on public.business_partners to public;
alter policy business_partners_select_finance on public.business_partners to public;
alter policy business_partners_update_finance on public.business_partners to public;
alter policy company_billing_profile_insert_finance on public.company_billing_profile to public;
alter policy company_billing_profile_select_finance on public.company_billing_profile to public;
alter policy company_billing_profile_update_finance on public.company_billing_profile to public;
alter policy custom_document_categories_select_company on public.custom_document_categories to public;
alter policy document_attachments_insert_company on public.document_attachments to public;
alter policy document_attachments_select_company on public.document_attachments to public;
alter policy document_links_insert_company on public.document_links to public;
alter policy document_links_select_company on public.document_links to public;
alter policy documents_select_company on public.documents to public;
alter policy invoice_events_select_finance on public.invoice_events to public;
alter policy invoice_items_delete_finance_draft on public.invoice_items to public;
alter policy invoice_items_insert_finance_draft on public.invoice_items to public;
alter policy invoice_items_select_finance on public.invoice_items to public;
alter policy invoice_items_update_finance_draft on public.invoice_items to public;
alter policy invoice_number_sequences_select_finance on public.invoice_number_sequences to public;
alter policy invoice_parties_select_finance on public.invoice_parties to public;
alter policy invoice_payments_select_finance on public.invoice_payments to public;
alter policy invoice_tax_breakdowns_select_finance on public.invoice_tax_breakdowns to public;
alter policy invoices_delete_finance_draft on public.invoices to public;
alter policy invoices_insert_finance_draft on public.invoices to public;
alter policy invoices_select_finance on public.invoices to public;
alter policy invoices_update_finance_draft on public.invoices to public;
alter policy "Users can manage own settings" on public.settings to public;
