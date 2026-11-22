-- =============================================================================
-- P1-4 (2026-11-23): karanténa trvalo chybných prijatých e-faktúr + skrytie dokladov adresovaných inému
-- účastníkovi (RECIPIENT_MISMATCH, R3). PRIPRAVENÉ — NEAPLIKOVANÉ (staging aj produkcia iba po samostatnom
-- schválení vlastníka). Iba aditívne; nemení stavový automat, nemennosť originálu ani mapovanie organizácií.
--
-- 1) einvoice_inbound: quarantined_at, quarantine_reason, provider_acknowledged_at (+ index).
-- 2) RLS: firma NEVIDÍ riadok s last_error_code = 'RECIPIENT_MISMATCH' (doklad nie je jej) — ani cez Data API.
-- 3) esblu_einvoice_inbound_quarantine(id, reason): IBA service_role; iba `failed` s uloženým XML (cesta + SHA-256),
--    nikdy RECIPIENT_MISMATCH; idempotentné ('already'); zapíše udalosť do einvoice_events (audit).
-- 4) esblu_einvoice_inbound_quarantine_acked(id): IBA service_role; zaznamená ACK karantény u poskytovateľa
--    (aplikácia ho volá iba pri ESBLU_EINVOICE_INBOUND_QUARANTINE_ACK=enabled — default vypnuté, R2).
-- 5) esblu_einvoice_health: + quarantined, quarantined_unacked, recipient_mismatch (alerty v lib/einvoice/ops/alerts.ts).
-- Rollback: supabase/rollback/20261125100000_einvoice_inbound_quarantine_rollback.sql
-- =============================================================================
begin;

alter table public.einvoice_inbound
  add column if not exists quarantined_at timestamptz,
  add column if not exists quarantine_reason text
    check (quarantine_reason is null or quarantine_reason ~ '^[A-Z0-9_]{1,80}$'),
  add column if not exists provider_acknowledged_at timestamptz;

alter table public.einvoice_inbound drop constraint if exists einvoice_inbound_quarantine_check;
alter table public.einvoice_inbound add constraint einvoice_inbound_quarantine_check check (
  (quarantined_at is null and quarantine_reason is null and provider_acknowledged_at is null)
  or (quarantined_at is not null and quarantine_reason is not null
      and processing_status = 'failed' and xml_storage_path is not null and xml_sha256 is not null
      and quarantine_reason <> 'RECIPIENT_MISMATCH')
) not valid;
alter table public.einvoice_inbound validate constraint einvoice_inbound_quarantine_check;

create index if not exists einvoice_inbound_quarantine_idx
  on public.einvoice_inbound (company_id, quarantined_at desc) where quarantined_at is not null;

-- R3: doklad adresovaný inému účastníkovi nevidí žiadna firma (ostáva iba pre prevádzku cez service_role).
drop policy if exists einvoice_inbound_select_finance on public.einvoice_inbound;
create policy einvoice_inbound_select_finance on public.einvoice_inbound
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id()
         and public.esblu_my_finance_view()
         and coalesce(last_error_code, '') <> 'RECIPIENT_MISMATCH');

create or replace function public.esblu_einvoice_inbound_quarantine(p_inbound_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v public.einvoice_inbound;
begin
  if p_inbound_id is null or p_reason is null or p_reason !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_QUARANTINE_INVALID';
  end if;
  select * into v from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_NOT_FOUND';
  end if;
  if v.quarantined_at is not null then
    return jsonb_build_object('result', 'already');
  end if;
  if v.processing_status <> 'failed' or v.xml_storage_path is null or v.xml_sha256 is null
     or p_reason = 'RECIPIENT_MISMATCH' or coalesce(v.last_error_code, '') = 'RECIPIENT_MISMATCH' then
    return jsonb_build_object('result', 'not_eligible');
  end if;
  update public.einvoice_inbound i
     set quarantined_at = now(), quarantine_reason = p_reason
   where i.id = v.id;
  insert into public.einvoice_events (company_id, inbound_id, from_state, to_state, source, provider_code, metadata)
  values (v.company_id, v.id, 'failed', 'quarantined', 'job', p_reason, jsonb_build_object('environment', v.environment, 'provider', v.provider));
  return jsonb_build_object('result', 'quarantined');
end
$function$;

create or replace function public.esblu_einvoice_inbound_quarantine_acked(p_inbound_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v public.einvoice_inbound;
begin
  select * into v from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if not found or v.quarantined_at is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_QUARANTINE_REQUIRED';
  end if;
  if v.provider_acknowledged_at is not null then
    return jsonb_build_object('result', 'already');
  end if;
  update public.einvoice_inbound i set provider_acknowledged_at = now() where i.id = v.id;
  insert into public.einvoice_events (company_id, inbound_id, from_state, to_state, source, provider_code, metadata)
  values (v.company_id, v.id, 'quarantined', 'quarantine_acknowledged', 'job', 'QUARANTINE_ACK', jsonb_build_object('environment', v.environment, 'provider', v.provider));
  return jsonb_build_object('result', 'acknowledged');
end
$function$;

revoke all on function public.esblu_einvoice_inbound_quarantine(uuid, text) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_inbound_quarantine_acked(uuid) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_quarantine(uuid, text) to service_role;
grant execute on function public.esblu_einvoice_inbound_quarantine_acked(uuid) to service_role;

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

commit;
