-- Rollback 20261006100000_einvoice_supplier_dic_feed_cursor.sql (spúšťať ručne, nie ako migráciu).
-- (3) opakovanie spracovania udalostí
drop function if exists public.esblu_einvoice_webhook_retry(uuid, integer);
alter table public.einvoice_webhook_events drop constraint if exists einvoice_webhook_events_attempts_check;
alter table public.einvoice_webhook_events drop column if exists attempts;
-- (2) kurzor feedu
drop function if exists public.esblu_einvoice_event_cursor_advance(text, text, uuid, bigint, boolean, text);
drop function if exists public.esblu_einvoice_event_cursor_claim(text, text, integer);
drop table if exists public.einvoice_event_cursors;
-- (1) DIČ dodávateľa: znovu spustiť definíciu esblu_einvoice_inbound_create_draft
--     z 20261003100000_einvoice_inbound_draft_totals.sql (sekcia 4). Kľúč supplier.dic
--     sa potom ignoruje; už založení partneri s DIČ ostávajú (bežný údaj partnera).
