-- Rollback 20261008100000_invoicing_sk_compliance.sql (spúšťať ručne, nie ako migráciu).
-- Pozor: ak už existujú doklady kind='proforma' alebo odpočty záloh, najprv ich vyriešiť (proformy sú drafty / nedaňové doklady).
drop trigger if exists esblu_invoice_correction_event on public.invoices;
drop function if exists public.esblu_invoice_correction_event();
drop trigger if exists esblu_invoice_finalize_compliance on public.invoices;
drop function if exists public.esblu_invoice_finalize_compliance();
drop trigger if exists esblu_payment_credit_note_guard on public.invoice_payments;
drop function if exists public.esblu_block_payment_on_credit_note();
drop trigger if exists esblu_invoice_events_append_only on public.invoice_events;
drop function if exists public.esblu_invoice_events_append_only();
drop trigger if exists esblu_parties_insert_guard on public.invoice_parties;
drop trigger if exists esblu_breakdowns_insert_guard on public.invoice_tax_breakdowns;
drop function if exists public.esblu_block_snapshot_insert_when_finalized();
drop trigger if exists esblu_breakdown_exemption_default on public.invoice_tax_breakdowns;
drop function if exists public.esblu_default_breakdown_exemption();
drop function if exists public.esblu_set_invoice_advance_deductions(uuid, jsonb);
drop trigger if exists esblu_advance_deductions_immutability on public.invoice_advance_deductions;
drop function if exists public.esblu_block_finalized_advance_deductions();
drop table if exists public.invoice_advance_deductions;
drop function if exists public.esblu_set_invoice_compliance_fields(uuid, jsonb);
drop function if exists public.esblu_sk_vat_rates(date);
-- esblu_finalize_invoice: znovu spustiť definíciu z 20260923190000_canonical_price_mode.sql (+ granty z 20260921160000).
alter table public.invoices drop constraint if exists invoices_currency_format;
alter table public.invoices drop constraint if exists invoices_fx_rate_source_check;
alter table public.invoices drop constraint if exists invoices_fx_rate_check;
alter table public.invoices drop constraint if exists invoices_correction_reason_check;
alter table public.invoices drop column if exists vat_total_eur, drop column if exists tax_base_eur,
  drop column if exists fx_rate_source, drop column if exists fx_rate_date, drop column if exists fx_rate, drop column if exists correction_reason;
alter table public.invoices drop constraint if exists invoices_proforma_issued_only;
alter table public.invoices drop constraint if exists invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check
  check (kind in ('regular_invoice', 'payment_received_invoice', 'credit_note', 'debit_note'));
