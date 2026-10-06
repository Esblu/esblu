-- Rollback 20261008100005. Iba staging / po výslovnom schválení. Predpoklad: žiadne prijaté opravy
-- v review bez originálu, žiadne vrátenia platieb a žiadny stav 'overpaid' (inak ich najprv vyriešiť).
drop trigger if exists esblu_a_lock_advance_deductions on public.invoices;
drop function if exists public.esblu_lock_advance_deductions();
drop function if exists public.esblu_available_advances(uuid);
drop trigger if exists esblu_invoice_settlement_after_finalize on public.invoices;
drop function if exists public.esblu_invoice_settlement_after_finalize();
drop function if exists public.esblu_add_invoice_refund(uuid, numeric, date, text, text);
drop function if exists public.esblu_invoice_settlement(uuid);
-- esblu_add_invoice_payment / esblu_remove_invoice_payment: obnoviť z 20260916095000 (pôvodný výpočet stavu).
-- esblu_block_payment_on_credit_note: obnoviť z 20261008100000.
drop function if exists public.esblu_recalc_invoice_group_status(uuid);
drop function if exists public.esblu_invoice_settlement_core(uuid);
alter table public.invoices drop constraint if exists invoices_payment_status_check;
alter table public.invoices add constraint invoices_payment_status_check check (payment_status in ('unpaid', 'partially_paid', 'paid'));
alter table public.invoice_payments drop column if exists entry_type;
drop trigger if exists esblu_block_client_correction_review_change on public.invoices;
drop function if exists public.esblu_block_client_correction_review_change();
drop function if exists public.esblu_received_correction_reject(uuid, text);
drop function if exists public.esblu_received_correction_link(uuid, uuid);
drop trigger if exists esblu_received_correction_accept on public.invoices;
drop function if exists public.esblu_received_correction_accept();
-- esblu_einvoice_inbound_create_draft: obnoviť z 20261006100000.
drop function if exists public.esblu_einvoice_inbound_create_correction(uuid, jsonb);
drop function if exists public.esblu_einvoice_resolve_supplier(uuid, jsonb);
drop trigger if exists esblu_invoice_correction_link_guard on public.invoices;
drop function if exists public.esblu_invoice_correction_link_guard();
alter table public.invoices drop constraint if exists invoices_corrects_required_for_notes;
alter table public.invoices add constraint invoices_corrects_required_for_notes check ((kind in ('credit_note', 'debit_note')) = (corrects_invoice_id is not null));
-- Stĺpce correction_review_* / corrected_document_* môžu ostať (nullable); typy udalostí correction_reviewed a payment_refunded tiež.
