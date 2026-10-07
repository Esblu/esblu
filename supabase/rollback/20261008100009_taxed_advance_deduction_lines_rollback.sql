-- Rollback 20261008100009 (zdanená záloha ako mínusový riadok). Iba staging / po výslovnom schválení.
--
-- POZOR: rollback je bezpečný iba vtedy, keď ešte nebola finalizovaná žiadna konečná faktúra s riadkom
-- odpočtu (invoice_items.is_advance_deduction). Finalizované doklady sú nemenné; ich riadky odpočtu sa
-- nesmú mazať. Pred rollbackom:
--   select count(*) from public.invoice_items it join public.invoices i on i.id = it.invoice_id
--   where it.is_advance_deduction and i.document_status = 'finalized';   -- musí byť 0
--
-- Funkcie obnoviť z predchádzajúcich migrácií (spustiť ich definície znova):
--   esblu_finalize_invoice                  ← 20261008100000
--   esblu_invoice_finalize_compliance       ← 20261008100004
--   esblu_lock_advance_deductions           ← 20261008100005
--   esblu_set_invoice_advance_deductions    ← 20261008100000
--   esblu_set_invoice_compliance_fields     ← 20261008100000
--   esblu_invoice_settlement_core, esblu_received_advance_link_guard, esblu_received_advance_match,
--   esblu_a_received_advance_finalize (+ trigger s WHEN new.prepaid_amount is not null),
--   esblu_received_advance_target, esblu_received_advance_refresh_status, esblu_received_advance_link,
--   esblu_block_client_advance_review_change, esblu_einvoice_inbound_create_draft
--                                            ← 20261008100008
--   esblu_einvoice_apply_xml_totals: nahradiť
--     'abs(v_bvat - round(v_taxable * v_rate / 100, 2)) > 0.01'  →  'v_bvat <> round(v_taxable * v_rate / 100, 2)'
--     (rovnaký DO-blok vzor ako v 20261008100009, sekcia 8).
begin;
delete from public.invoice_items it using public.invoices i
 where i.id = it.invoice_id and it.is_advance_deduction and i.document_status = 'draft';
drop trigger if exists esblu_check_untaxed_prepaid on public.invoices;
drop function if exists public.esblu_check_untaxed_prepaid();
drop trigger if exists esblu_block_client_advance_item_change on public.invoice_items;
drop function if exists public.esblu_block_client_advance_item_change();
drop function if exists public.esblu_received_deduction_groups(uuid);
drop index if exists public.received_advance_links_rate_uniq;
delete from public.received_advance_links l using public.invoices f
 where f.id = l.invoice_id and f.document_status = 'draft' and l.vat_category_code is not null;
alter table public.received_advance_links add constraint received_advance_links_invoice_id_advance_invoice_id_key unique (invoice_id, advance_invoice_id);
alter table public.received_advance_links alter column vat_amount set not null;
alter table public.received_advance_links drop column if exists vat_rate, drop column if exists vat_category_code;
alter table public.invoices drop constraint if exists invoices_untaxed_prepaid_check;
alter table public.invoices drop constraint if exists invoices_untaxed_prepaid_reference_check;
alter table public.invoices drop column if exists untaxed_prepaid_reference, drop column if exists untaxed_prepaid_amount;
alter table public.invoice_items drop constraint if exists invoice_items_unit_price_sign_check;
alter table public.invoice_items drop constraint if exists invoice_items_advance_fields_check;
alter table public.invoice_items drop constraint if exists invoice_items_advance_vat_check;
drop index if exists public.invoice_items_advance_invoice_idx;
alter table public.invoice_items drop column if exists advance_vat_amount, drop column if exists advance_invoice_id, drop column if exists is_advance_deduction;
alter table public.invoice_items add constraint invoice_items_unit_price_check check (unit_price >= 0);
-- invoices_advance_review_status_check z 20261008100008 obnoviť až po obnovení funkcií (vyžaduje prepaid_amount):
--   check ((advance_review_status is null) = (prepaid_amount is null) and (advance_review_status is null or advance_review_status in ('review','proposed','linked')))
commit;
