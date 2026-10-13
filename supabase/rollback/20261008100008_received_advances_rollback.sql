-- Rollback 20261008100008 (prijaté zálohy 386 a konečná faktúra s BT-113). Iba staging / po výslovnom schválení.
-- Pred rollbackom: prijaté 386 (direction='received', kind='payment_received_invoice') ostávajú ako doklady;
-- prijaté konečné faktúry s prepaid_amount stratia väzby na zálohy (export ich už neuvedie).
-- Funkcie obnoviť z predchádzajúcich migrácií:
--   esblu_einvoice_inbound_create_draft        ← 20261008100007
--   esblu_einvoice_apply_xml_totals            ← 20261003100000 (BT-113 musí byť 0)
--   esblu_einvoice_received_finalize_guard     ← 20261003100000
--   esblu_invoice_settlement_core              ← 20261008100005
begin;
drop trigger if exists esblu_a_received_advance_finalize on public.invoices;
drop trigger if exists esblu_block_client_advance_review_change on public.invoices;
drop function if exists public.esblu_received_advance_candidates(uuid);
drop function if exists public.esblu_received_advance_reject(uuid, text);
drop function if exists public.esblu_received_advance_unlink(uuid, uuid);
drop function if exists public.esblu_received_advance_link(uuid, uuid, numeric);
drop function if exists public.esblu_received_advance_confirm(uuid);
drop function if exists public.esblu_received_advance_refresh_status(uuid, text, jsonb);
drop function if exists public.esblu_received_advance_target(uuid);
drop function if exists public.esblu_a_received_advance_finalize();
drop function if exists public.esblu_received_advance_match(uuid);
drop table if exists public.received_advance_links;
drop function if exists public.esblu_received_advance_link_guard();
drop function if exists public.esblu_block_client_advance_review_change();
alter table public.invoices
  drop constraint if exists invoices_prepaid_amount_check,
  drop constraint if exists invoices_advance_review_status_check,
  drop constraint if exists invoices_advance_review_reasons_check,
  drop constraint if exists invoices_advance_review_note_check,
  drop constraint if exists invoices_advance_references_check;
alter table public.invoices
  drop column if exists advance_reviewed_by,
  drop column if exists advance_reviewed_at,
  drop column if exists advance_review_note,
  drop column if exists advance_review_reasons,
  drop column if exists advance_review_status,
  drop column if exists advance_references,
  drop column if exists prepaid_amount;
-- Typ udalosti 'advance_reviewed' môže v check constrainte ostať (aditívny); existujúce udalosti sa nemažú.
commit;
