-- Rollback 20261119120000_billing_event_catchup (staging/produkcia iba so súhlasom).
-- Pred rollbackom vypnúť cron /api/cron/billing-stripe-events (vercel.json), inak by vracal CURSOR_CLAIM_FAILED.
-- Tabuľka obsahuje iba technický kurzor (bez osobných údajov); zmazanie = ďalší beh začne bootstrapom (dedupe udalostí platí).
begin;
drop function if exists public.esblu_billing_event_cursor_release(text, text, uuid, boolean, text);
drop function if exists public.esblu_billing_event_cursor_advance(text, text, uuid, text, timestamptz);
drop function if exists public.esblu_billing_event_cursor_claim(text, text, text, uuid, integer);
drop table if exists public.billing_event_cursors;
commit;
