-- =============================================================================
-- Subscriptions — redakcia store purchase tokenu v audit logu (FORWARD-ONLY, 2026-10-12)
--
-- Nález zo staging validácie 2026-10-11: billing_events.summary.subscription
-- obsahoval celý Google Play purchaseToken (bearer identifikátor nákupu).
-- Token MUSÍ ostať v billing_provider_links (overenie / reconciliation cez
-- Play Developer API), ale audit log ho nepotrebuje → ukladá sa iba
-- 'sha256:<24 hex>' (stále korelovateľné, nereverzibilné).
-- Stripe / Apple / fake identifikátory nie sú bearer tokeny → bez zmeny.
-- Backfill = redakcia existujúcich riadkov (nič sa nemaže).
-- Rollback: supabase/rollback/20261012090000_subscriptions_event_token_redaction_rollback.sql
-- =============================================================================

create or replace function public.esblu_billing_redact_event_summary()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.provider = 'google'
     and new.summary ->> 'subscription' is not null
     and new.summary ->> 'subscription' !~ '^sha256:[0-9a-f]{24}$' then
    new.summary := jsonb_set(new.summary, '{subscription}',
      to_jsonb('sha256:' || left(encode(sha256(convert_to(new.summary ->> 'subscription', 'UTF8')), 'hex'), 24)));
  end if;
  return new;
end
$function$;

revoke all on function public.esblu_billing_redact_event_summary() from public, anon, authenticated;

drop trigger if exists billing_events_redact_summary on public.billing_events;
create trigger billing_events_redact_summary
  before insert or update of summary on public.billing_events
  for each row execute function public.esblu_billing_redact_event_summary();

-- Backfill (redakcia, idempotentná): trigger prepíše hodnotu pri update.
update public.billing_events
set summary = summary
where provider = 'google'
  and summary ->> 'subscription' is not null
  and summary ->> 'subscription' !~ '^sha256:[0-9a-f]{24}$';
