-- Rollback 20261113100000_einvoice_webhook_body_sha256_idx.sql — odstráni iba index (bez zmeny dát).
drop index if exists public.einvoice_webhook_events_body_lookup_idx;
