-- =============================================================================
-- J10/J10.1 — PRODUKČNÝ READ-ONLY PRECHECK retenčnej purge (CLIA 09.11.2026)
-- =============================================================================
-- Spúšťať IBA ako celok: BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;
-- Výstup = iba agregáty (počet, najstarší/najnovší čas) — žiadne riadky,
-- e-maily ani obsah (docs/ai-dev-tool-access-policy.md). Tabuľky, ktoré
-- produkcia ešte nemá (RC migrácie), vrátia stav 'table_absent'.
-- Purge NESPÚŠŤA. Po prechecku musí nasledovať výslovný súhlas vlastníka.
-- =============================================================================
begin;
set transaction read only;

with cat(ord, category, tbl, cond, ts, data_class, legal_hold_note) as (values
  (1,  'push_devices revoked > 30 d',            'public.push_devices',               'revoked_at < now() - interval ''30 days''', 'revoked_at', 'technical identifiers (controller)', 'none'),
  (2,  'push_subscriptions revoked > 30 d',      'public.push_subscriptions',         'revoked_at < now() - interval ''30 days''', 'revoked_at', 'technical identifiers (controller)', 'none'),
  (3,  'notification_deliveries > 90 d (all)',   'public.notification_deliveries',    'sent_at < now() - interval ''90 days''', 'sent_at', 'delivery metadata (controller)', 'none'),
  (4,  'notification_deliveries deadline > 90 d','public.notification_deliveries',    'kind = ''deadline'' and sent_at < now() - interval ''90 days''', 'sent_at', 'delivery metadata (controller)', 're-reminder side effect only'),
  (5,  'company_invites unaccepted > 30 d',      'public.company_invites',            'accepted_at is null and ((status in (''pending'',''expired'') and expires_at < now() - interval ''30 days'') or (status = ''revoked'' and coalesce(revoked_at, expires_at) < now() - interval ''30 days''))', 'expires_at', 'registration invitations (controller)', 'none'),
  (6,  'account_deletion_cleanup_jobs done > 90 d','public.account_deletion_cleanup_jobs','storage_status = ''done'' and auth_status = ''done'' and coalesce(completed_at, updated_at) < now() - interval ''90 days''', 'created_at', 'technical log (controller)', 'none'),
  (7,  'assistant_action_confirmations expired > 1 d','public.assistant_action_confirmations','expires_at < now() - interval ''1 day''', 'expires_at', 'technical (customer command args)', 'none'),
  (8,  'assistant_conversation_contexts expired > 1 d','public.assistant_conversation_contexts','expires_at < now() - interval ''1 day''', 'expires_at', 'technical (customer command context)', 'none'),
  (9,  'media_deletion_queue completed > 90 d',  'public.media_deletion_queue',       'completed_at < now() - interval ''90 days''', 'completed_at', 'technical (storage paths)', 'none'),
  (10, 'auth.users unconfirmed, no membership > 30 d','auth.users u',                 'email_confirmed_at is null and phone_confirmed_at is null and last_sign_in_at is null and created_at < now() - interval ''30 days'' and not exists (select 1 from public.company_members cm where cm.user_id = u.id) and not exists (select 1 from public.companies c where c.owner_id = u.id)', 'created_at', 'failed registrations (controller)', 'none'),
  (11, 'trial_claims > 5 r.',                    'public.trial_claims',               'coalesce(trial_ends_at, created_at) < now() - interval ''5 years''', 'created_at', 'contract/anti-abuse hash', 'none expected'),
  (12, 'ai_scan_usage > 90 d',                   'public.ai_scan_usage',              'created_at < now() - interval ''90 days''', 'created_at', 'technical abuse log', 'none'),
  (13, 'ai_processing_usage pseudonymize > 90 d','public.ai_processing_usage',        'status <> ''reserved'' and user_id <> ''00000000-0000-0000-0000-000000000000''::uuid and coalesce(finalized_at, reserved_at) < now() - interval ''90 days''', 'reserved_at', 'quota record (user_id only pseudonymized, row kept)', 'none — billing counts kept'),
  (14, 'legal_acceptance_evidence > 5 r.',       'public.legal_acceptance_evidence',  'archived_at < now() - interval ''5 years''', 'archived_at', 'contract evidence', 'check open claims before purge'),
  (20, 'INFO: user_legal_acceptances (kept)',    'public.user_legal_acceptances',     'true', 'accepted_at', 'contract evidence — not purged', 'archived on account deletion (J10.1)'),
  (21, 'INFO: company_dpa_acceptances (kept)',   'public.company_dpa_acceptances',    'true', 'accepted_at', 'contract evidence — not purged', 'archived on company deletion (J10.1)'),
  (22, 'INFO: invoices (never purged)',          'public.invoices',                   'true', 'created_at', 'ACCOUNTING — customer content', 'statutory 10 y / guards unchanged')
)
select c.ord, c.category, c.data_class, c.legal_hold_note,
  case when to_regclass(split_part(c.tbl, ' ', 1)) is null then 'table_absent' else 'ok' end as status,
  case when to_regclass(split_part(c.tbl, ' ', 1)) is null then null else
    ((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where %s', c.tbl, c.cond), false, true, '')))[1])::text::bigint end as rows_affected,
  case when to_regclass(split_part(c.tbl, ' ', 1)) is null then null else
    ((xpath('/row/mn/text()', query_to_xml(format('select min(%s) as mn from %s where %s', c.ts, c.tbl, c.cond), false, true, '')))[1])::text end as oldest,
  case when to_regclass(split_part(c.tbl, ' ', 1)) is null then null else
    ((xpath('/row/mx/text()', query_to_xml(format('select max(%s) as mx from %s where %s', c.ts, c.tbl, c.cond), false, true, '')))[1])::text end as newest
from cat c
order by c.ord;

rollback;
