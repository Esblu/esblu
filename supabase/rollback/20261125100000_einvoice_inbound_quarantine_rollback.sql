-- Rollback 20261125100000_einvoice_inbound_quarantine (staging/produkcia iba so súhlasom vlastníka).
-- Vráti RLS politiku a health na pôvodný tvar, odstráni funkcie a stĺpce karantény (prevádzkové údaje, nie originály).
-- Originály XML, stavy a einvoice_events (append-only) ostávajú nedotknuté.
begin;
-- 1) health späť na definíciu z 20261002140000 (pred odstránením stĺpcov, na ktoré sa odkazuje)
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
           public.esblu_einvoice_inbound_category(n.processing_status, n.dedupe_matched_on) as category
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
      'ack_pending_too_long', (select count(*) from i, stuck_minutes s where status in ('ack_pending', 'draft_created', 'duplicate') and updated_at < now() - make_interval(mins => s.a)),
      'stuck', (select count(*) from i, stuck_minutes s where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending') and updated_at < now() - make_interval(mins => s.m)),
      'oldest_stuck_age_seconds', (select coalesce(floor(extract(epoch from now() - min(updated_at))), 0)::bigint from i where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending'))
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

drop function if exists public.esblu_einvoice_inbound_quarantine_acked(uuid);
drop function if exists public.esblu_einvoice_inbound_quarantine(uuid, text);
drop policy if exists einvoice_inbound_select_finance on public.einvoice_inbound;
create policy einvoice_inbound_select_finance on public.einvoice_inbound
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());
drop policy if exists einvoice_events_select_finance on public.einvoice_events;
create policy einvoice_events_select_finance on public.einvoice_events
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());
drop index if exists public.einvoice_inbound_quarantine_idx;
alter table public.einvoice_inbound drop constraint if exists einvoice_inbound_quarantine_check;
alter table public.einvoice_inbound
  drop column if exists provider_acknowledged_at,
  drop column if exists quarantine_reason,
  drop column if exists quarantined_at;
-- P1-4 stav skenu (prevádzkové údaje; doklady sa nemenia)
drop function if exists public.esblu_einvoice_org_record_inbound_scan(text, text, text, boolean, text);
drop function if exists public.esblu_einvoice_inbound_scan_order(text, text);
drop table if exists public.einvoice_inbound_scan_state;
commit;
