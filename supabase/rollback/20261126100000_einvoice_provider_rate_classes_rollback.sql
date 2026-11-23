-- Rollback 20261126100000_einvoice_provider_rate_classes (staging/produkcia iba so súhlasom vlastníka).
-- Health sa vráti na definíciu z 20261125100000; odstránia sa funkcie a tabuľky spoločného limitu (prevádzkové
-- počítadlá, nie doklady). Aplikácia je bez nich fail-open (platia limity behov a starší limiter príjmu).
begin;
create or replace function public.esblu_einvoice_health(p_stuck_minutes integer, p_ack_pending_minutes integer)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with o as (
    select e.state, e.updated_at, e.send_outcome_unknown, e.provider_submission_id,
           public.esblu_einvoice_outbound_category(e.state, e.provider_submission_id, e.next_retry_at, e.last_error_code) as category
    from public.einvoice_outbound e
  ),
  i as (
    select n.processing_status as status, n.updated_at,
           public.esblu_einvoice_inbound_category(n.processing_status, n.dedupe_matched_on) as category,
           n.last_error_code, n.quarantined_at, n.provider_acknowledged_at
    from public.einvoice_inbound n
  ),
  stuck_minutes as (select greatest(coalesce(p_stuck_minutes, 60), 1) as m, greatest(coalesce(p_ack_pending_minutes, 60), 1) as a)
  select jsonb_build_object(
    'generated_at', now(),
    'outbound', jsonb_build_object(
      'queued', (select count(*) from o where state = 'queued'),
      'sending', (select count(*) from o where state = 'sending'),
      'sent', (select count(*) from o where state = 'sent'),
      'deferred', (select count(*) from o where state = 'deferred'),
      'delivered', (select count(*) from o where state = 'delivered'),
      'rejected', (select count(*) from o where state = 'rejected'),
      'failed', (select count(*) from o where state = 'failed'),
      'retryable', (select count(*) from o where category = 'retryable'),
      'reconciliation_required', (select count(*) from o where category = 'reconciliation_required'),
      'retry_exhausted_unknown', (select count(*) from o where category = 'retry_exhausted_unknown'),
      'unknown_send_outcome', (select count(*) from o where send_outcome_unknown and provider_submission_id is null and state not in ('failed', 'rejected', 'delivered')),
      'stuck', (select count(*) from o, stuck_minutes s where state in ('queued', 'sending', 'sent', 'deferred') and updated_at < now() - make_interval(mins => s.m)),
      'oldest_stuck_age_seconds', (select coalesce(floor(extract(epoch from now() - min(updated_at))), 0)::bigint from o where state in ('queued', 'sending', 'sent', 'deferred'))
    ),
    'inbound', jsonb_build_object(
      'received', (select count(*) from i where status = 'received'),
      'stored', (select count(*) from i where status = 'stored'),
      'parsed', (select count(*) from i where status = 'parsed'),
      'draft_created', (select count(*) from i where status = 'draft_created'),
      'duplicate', (select count(*) from i where category = 'duplicate'),
      'ack_pending', (select count(*) from i where category = 'ack_pending'),
      'acknowledged', (select count(*) from i where category = 'acknowledged'),
      'failed', (select count(*) from i where status = 'failed'),
      -- P1-4: karanténa a doklady adresované inému účastníkovi (R3 — incident, nikdy nesprístupnené firme)
      'quarantined', (select count(*) from i where status = 'failed' and quarantined_at is not null),
      'quarantined_unacked', (select count(*) from i where status = 'failed' and quarantined_at is not null and provider_acknowledged_at is null),
      'recipient_mismatch', (select count(*) from i where status = 'failed' and last_error_code = 'RECIPIENT_MISMATCH'),
      'ack_pending_too_long', (select count(*) from i, stuck_minutes s where status in ('ack_pending', 'draft_created', 'duplicate') and updated_at < now() - make_interval(mins => s.a)),
      'stuck', (select count(*) from i, stuck_minutes s where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending') and updated_at < now() - make_interval(mins => s.m)),
      'oldest_stuck_age_seconds', (select coalesce(floor(extract(epoch from now() - min(updated_at))), 0)::bigint from i where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending')),
      -- P1-4: organizácie s aktívnym príjmom bez úplného skenu zoznamu > 2 h (nové doklady by mohli čakať neviditeľne)
      'scan_overdue', (select count(*) from public.einvoice_organizations g
                        left join public.einvoice_inbound_scan_state ss
                          on ss.provider = g.provider and ss.environment = g.environment and ss.provider_org_id = g.provider_org_id
                        where g.peppol_eligible and g.provider_org_id is not null
                          and (g.reception_status is null or g.reception_status = 'active')
                          and g.created_at < now() - interval '2 hours'
                          -- bez záznamu sa počíta až keď poll s novým kódom už beží (nasadenie kódu po migrácii
                          -- tak nevyvolá falošný kritický alert)
                          and (case when ss.provider_org_id is null
                                    then exists (select 1 from public.einvoice_inbound_scan_state x
                                                  where x.provider = g.provider and x.environment = g.environment)
                                    else coalesce(ss.last_complete_at, '-infinity'::timestamptz) < now() - interval '2 hours' end)),
      'scan_incomplete', (select count(*) from public.einvoice_inbound_scan_state ss where ss.incomplete_streak > 0),
      'rate_limited_1h', (select coalesce(sum(rw.denied), 0) from public.einvoice_provider_rate_window rw where rw.window_start > now() - interval '1 hour')
    ),
    'webhook', jsonb_build_object(
      'failures_24h', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'failed' and w.received_at > now() - interval '24 hours'),
      'rejected_24h', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'rejected' and w.received_at > now() - interval '24 hours'),
      'unprocessed_older_15m', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'received' and w.received_at < now() - interval '15 minutes'),
      'signature_failures_1h', (select coalesce(sum(r.count), 0) from public.einvoice_webhook_rejections r where r.reason = 'INVALID_SIGNATURE' and r.bucket_start > now() - interval '1 hour'),
      'replays_1h', (select coalesce(sum(r.count), 0) from public.einvoice_webhook_rejections r where r.reason = 'REPLAYED_WEBHOOK' and r.bucket_start > now() - interval '1 hour')
    )
  );
$function$;
revoke all on function public.esblu_einvoice_health(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_health(integer, integer) to service_role;
drop function if exists public.esblu_einvoice_rate_acquire_class(text, text, text, integer);
drop function if exists public.esblu_einvoice_rate_cooldown(text, text, integer);
drop table if exists public.einvoice_provider_rate_usage;
drop table if exists public.einvoice_provider_rate_state;
drop table if exists public.einvoice_provider_rate_limits;
commit;
