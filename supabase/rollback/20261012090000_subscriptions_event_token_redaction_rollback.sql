-- Rollback 20261012090000 (iba staging). Odstráni redakčný trigger; už
-- redigované hodnoty sa NEOBNOVUJÚ (token je v billing_provider_links).
drop trigger if exists billing_events_redact_summary on public.billing_events;
drop function if exists public.esblu_billing_redact_event_summary();
