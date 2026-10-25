-- Rollback 20261025110000_notification_deliveries_chat_retention.sql
drop function if exists public.esblu_purge_chat_notification_deliveries(integer, integer);
