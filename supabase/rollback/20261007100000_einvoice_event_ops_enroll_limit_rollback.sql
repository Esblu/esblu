-- Rollback 20261007100000_einvoice_event_ops_enroll_limit.sql (spúšťať ručne, nie ako migráciu).
-- (2) limit aktivácie
drop function if exists public.esblu_einvoice_enroll_attempt_finish(uuid, text);
drop function if exists public.esblu_einvoice_enroll_attempt_begin(uuid, uuid);
drop table if exists public.einvoice_enroll_attempts;
-- (1) operácie udalostí
drop function if exists public.esblu_einvoice_event_ops();
drop function if exists public.esblu_einvoice_event_cursor_rewind(text, text, bigint, text, text);
drop function if exists public.esblu_einvoice_event_resolve(uuid, text, text);
drop function if exists public.esblu_einvoice_event_requeue(uuid, text, text);
drop table if exists public.einvoice_ops_audit;
drop index if exists public.einvoice_webhook_events_exhausted_idx;
-- esblu_einvoice_webhook_complete a esblu_einvoice_webhook_retention: znovu spustiť definície
-- z 20261002130000_einvoice_inbound_flow.sql (sekcia webhook_complete) a
-- 20261002140000_einvoice_operations.sql (sekcia 7); esblu_einvoice_webhook_retry z 20261006100000 (3).
alter table public.einvoice_webhook_events drop constraint if exists einvoice_webhook_events_resolved_by_check;
alter table public.einvoice_webhook_events drop constraint if exists einvoice_webhook_events_resolution_code_check;
alter table public.einvoice_webhook_events
  drop column if exists resolved_by,
  drop column if exists resolution_code,
  drop column if exists resolved_at,
  drop column if exists exhausted_at;
