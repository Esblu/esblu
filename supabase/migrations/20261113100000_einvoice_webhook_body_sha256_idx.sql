-- =============================================================================
-- E-Faktúra — index pre replay / dedupe lookup podľa tela webhooku (S3, 2026-11-13).
--
-- Query (lib/einvoice/inbound/supabase-store.ts → webhookBodySeen):
--   select id from public.einvoice_webhook_events
--    where provider = $1 and environment = $2 and body_sha256 = $3
--      and delivery_id <> $4 and processing_status in ('processed','ignored','rejected')
--    limit 1;
-- Rovnosť na (provider, environment, body_sha256) → kombinovaný B-tree index v tomto
-- poradí. delivery_id / processing_status sa filtrujú na pár riadkoch s rovnakým hashom.
--
-- NIE UNIQUE: rovnaké telo pod iným X-Webhook-Id je legitímne (replay z portálu
-- eFaktura.sk, opakovanie po zlyhanom spracovaní) a musí sa dať zaznamenať.
-- Žiadna zmena dát, žiadna zmena RLS/grantov. Rollback: supabase/rollback/…_rollback.sql
-- =============================================================================

create index if not exists einvoice_webhook_events_body_lookup_idx
  on public.einvoice_webhook_events (provider, environment, body_sha256);
