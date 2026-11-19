-- Rollback 20261123100000_billing_event_retry (staging/produkcia iba so súhlasom).
-- Ochrana auditu: stĺpce next_retry_at / dead_letter / dead_lettered_at sa NEMAŽÚ (záznam o dead-letter
-- udalostiach ostáva; stĺpce sú nullable / default, starý kód ich ignoruje). Odstráni sa iba automatika
-- (trigger, RPC, indexy). Opätovné nasadenie migrácie je idempotentné.
begin;
drop trigger if exists esblu_billing_events_retry_plan on public.billing_events;
drop function if exists public.esblu_billing_event_retry_claim(text, text, integer);
drop function if exists public.esblu_billing_event_dead_letter(text, text, text, text);
drop function if exists public.esblu_billing_events_retry_plan();
drop function if exists public.esblu_billing_event_retry_delay(integer);
drop function if exists public.esblu_billing_event_error_retryable(text);
drop function if exists public.esblu_billing_event_max_attempts();
drop index if exists public.billing_events_retry_due_idx;
drop index if exists public.billing_events_dead_letter_idx;
commit;
