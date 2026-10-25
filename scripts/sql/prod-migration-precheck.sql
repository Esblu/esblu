-- =============================================================================
-- PRODUKČNÝ PRECHECK pred RC migračným oknom (preprod-release-candidate)
--
-- ČISTO READ-ONLY. Spúšťa iba vlastník (alebo Claude na jeho výslovný súhlas)
-- nad projektom `assetpilot` (fkpgvgvsmbpieduoatrt) PRED oknom migrácií.
-- Nič nemení: transakcia je READ ONLY a končí ROLLBACK. Nevypisuje osobné
-- údaje — iba počty, názvy objektov a stavové kódy.
--
-- Doplnok (nie náhrada) k scripts/sql/einvoice-prod-precheck.sql — ten sa
-- spúšťa tiež (detail eFaktúra reťazca: signatúry funkcií, číselné rady).
--
-- Výsledok: každý riadok = kontrola, `status`:
--   STOP → migrácie NESPÚŠŤAŤ (docs/production-migration-runbook-2026-10-22.md §H)
--   WARN → pokračovať iba po vysvetlení rozdielu
--   INFO → prehľad (zapísať do protokolu okna)
--   OK   → v poriadku
--
-- Očakávané hodnoty = read-only snapshot produkcie 2026-10-22 (main 901c46c,
-- posledná migrácia 20261005091000_private_media_buckets). Ak sa produkcia
-- medzitým zmenila (nová migrácia, hotfix), skript MUSÍ hlásiť STOP — to je
-- zámer: runbook sa potom aktualizuje, nie obíde.
--
-- Spustenie (MCP execute_sql vráti výsledok jedného SELECT-u): stačí poslať
-- iba blok SELECT medzi značkami BEGIN-CHECKS / END-CHECKS; psql: celý súbor.
-- =============================================================================

begin;
set transaction read only;

-- BEGIN-CHECKS
with
rc_versions(v) as (values
  ('20260720000000'), ('20261002100000'), ('20261002110000'), ('20261002120000'), ('20261002130000'),
  ('20261002140000'), ('20261002150000'), ('20261003100000'), ('20261005100000'), ('20261005110000'),
  ('20261006100000'), ('20261007100000'), ('20261008100000'), ('20261008100001'), ('20261008100002'),
  ('20261008100003'), ('20261008100004'), ('20261008100005'), ('20261008100006'), ('20261008100007'),
  ('20261008100008'), ('20261008100009'), ('20261008100010'), ('20261008100011'), ('20261008120000'),
  ('20261008130000'), ('20261011120000'), ('20261012090000'), ('20261012091000'), ('20261012120000'),
  ('20261012130000'), ('20261012140000'), ('20261012150000'), ('20261012160000'), ('20261013100000'),
  ('20261021100000'), ('20261022100000'), ('20261023100000'), ('20261025100000'), ('20261025110000'), ('20261026100000'), ('20261026110000'),
  ('20261027100000')
),
legacy(t) as (values
  ('settings'), ('vehicles'), ('vehicle_services'), ('machines'), ('machine_services'),
  ('machine_photos'), ('inventory_items'), ('inventory_photos'), ('ai_evidence')
),
-- 61 tabuliek, ktoré produkcia má PRED oknom (= manifest mínus tabuľky z RC migrácií)
pre_rc(t) as (select unnest(string_to_array(
  'accounting_handoff_export_items,accounting_handoff_exports,ai_evidence,ai_evidence_review_log,ai_processing_usage,'
  'ai_scan_limits,ai_scan_usage,assistant_action_confirmations,assistant_conversation_contexts,beta_allowlist,'
  'business_partners,chat_attachments,chat_conversation_members,chat_conversations,chat_message_references,'
  'chat_messages,companies,company_billing_profile,company_dpa_acceptances,company_entitlements,company_invites,'
  'company_members,custom_document_categories,document_attachments,document_download_events,'
  'document_export_package_items,document_export_packages,document_folder_items,document_folders,document_links,'
  'document_review_log,documents,entitlement_catalog,esblu_intake_attestations_used,inventory_items,'
  'inventory_photos,invoice_accounting_state,invoice_accounting_state_log,invoice_events,invoice_items,'
  'invoice_number_sequences,invoice_parties,invoice_payments,invoice_tax_breakdowns,invoices,legal_documents,'
  'machine_photos,machine_services,machines,media_deletion_queue,notification_deliveries,'
  'notification_preferences,plan_limits,push_devices,push_subscriptions,settings,user_legal_acceptances,'
  'vehicle_photos,vehicle_services,vehicle_vignettes,vehicles', ','))),
-- 36 tabuliek, ktoré vytvárajú RC migrácie — PRED oknom NESMÚ existovať
rc_tables(t) as (select unnest(string_to_array(
  'account_deletion_cleanup_jobs,ai_usage_monthly,billing_channel_rules,billing_checkout_sessions,billing_events,'
  'billing_provider_links,billing_provider_prices,billing_reconciliation,billing_region_groups,'
  'billing_runtime_config,billing_store_reports,company_legal_identities,company_plan_selection,company_usage_counters,company_member_permission_events,'
  'company_member_permissions,einvoice_enroll_attempts,einvoice_event_cursors,einvoice_events,einvoice_inbound,'
  'einvoice_ops_audit,einvoice_organizations,einvoice_outbound,einvoice_rollout,einvoice_webhook_events,'
  'einvoice_webhook_rejections,fx_rate_import_batches,fx_reference_rates,invoice_advance_deductions,'
  'received_advance_links,session_active_company,subscription_accounts,subscription_plan_entitlements,'
  'subscription_plans,trial_claims,user_active_company', ','))),
req_fn(f) as (values
  ('esblu_my_active_company_id'), ('esblu_my_finance_view'), ('esblu_my_finance_manage'),
  ('esblu_can_read_media_object'), ('esblu_can_upload_media_object'), ('esblu_can_delete_media_object'),
  ('esblu_storage_object_is_referenced'), ('esblu_push_revoke_ended'), ('esblu_push_companies_with_targets'),
  ('esblu_finalize_invoice'), ('esblu_save_invoice_draft'), ('esblu_get_invite_preview')
),
expected_buckets(b) as (values
  ('ai-evidence-documents'), ('ai-inbox-documents'), ('chat-attachments'), ('company-logos'),
  ('inventory-photos'), ('machine-photos'), ('vehicle-photos')
),
mig as (
  select count(*) as n,
         (select name from supabase_migrations.schema_migrations order by version desc limit 1) as last_name,
         count(*) filter (where exists (select 1 from rc_versions r where name like r.v || '%')) as rc_applied
  from supabase_migrations.schema_migrations
),
owners as (
  select
    (select count(*) from public.companies c
      where (select count(*) from public.company_members m
             where m.company_id = c.id and m.role = 'owner' and m.status = 'active') <> 1) as not_one_owner,
    (select count(*) from public.companies c
      where not exists (select 1 from public.company_members m
                        where m.company_id = c.id and m.user_id = c.owner_id and m.role = 'owner' and m.status = 'active')) as owner_id_mismatch,
    (select count(*) from (select user_id from public.company_members where status = 'active'
                           group by user_id having count(*) > 1) x) as users_multi_active,
    (select count(*) from public.company_members m
      where not exists (select 1 from public.companies c where c.id = m.company_id)) as orphan_company,
    (select count(*) from public.company_members m
      where not exists (select 1 from auth.users u where u.id = m.user_id)) as orphan_user
),
g as (
  select
    (select coalesce(string_agg(table_name || ':' || privilege_type, ',' order by table_name, privilege_type), '')
       from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon') as anon_privs,
    (select count(*) from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'authenticated') as auth_privs,
    (select count(*) from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'service_role') as svc_privs,
    (select count(*) from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated')
        and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')) as client_dangerous,
    (select coalesce(string_agg(p.proname, ',' order by p.proname), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_definer,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) as definer_no_sp
),
checks(ord, check_name, value, expected, status) as (
  -- 1) migration history
  select 10, 'migration_history_rows', m.n::text, '56',
         case when m.n = 56 then 'OK' else 'STOP' end from mig m
  union all
  select 11, 'migration_history_last', m.last_name, '20261005091000_private_media_buckets',
         case when m.last_name = '20261005091000_private_media_buckets' then 'OK' else 'STOP' end from mig m
  union all
  select 12, 'rc_migrations_already_applied', m.rc_applied::text, '0',
         case when m.rc_applied = 0 then 'OK' else 'STOP' end from mig m
  -- 2) tabuľky
  union all
  select 20, 'legacy_baseline_tables_present', (select count(*) from legacy where to_regclass('public.' || t) is not null)::text, '9',
         case when (select count(*) from legacy where to_regclass('public.' || t) is not null) = 9 then 'OK' else 'STOP' end
  union all
  select 21, 'pre_rc_tables_missing', coalesce((select string_agg(t, ',' order by t) from pre_rc where to_regclass('public.' || t) is null), ''), '',
         case when exists (select 1 from pre_rc where to_regclass('public.' || t) is null) then 'STOP' else 'OK' end
  union all
  select 22, 'rc_tables_already_present', coalesce((select string_agg(t, ',' order by t) from rc_tables where to_regclass('public.' || t) is not null), ''), '',
         case when exists (select 1 from rc_tables where to_regclass('public.' || t) is not null) then 'STOP' else 'OK' end
  union all
  select 23, 'unknown_public_tables',
         coalesce((select string_agg(tablename, ',' order by tablename) from pg_tables
                    where schemaname = 'public' and tablename not in (select t from pre_rc) and tablename not in (select t from rc_tables)), ''), '',
         case when exists (select 1 from pg_tables where schemaname = 'public'
                            and tablename not in (select t from pre_rc) and tablename not in (select t from rc_tables)) then 'STOP' else 'OK' end
  union all
  select 24, 'public_tables_without_rls', (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity)::text, '0',
         case when (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) = 0 then 'OK' else 'STOP' end
  -- 3) politiky
  union all
  select 30, 'public_policy_count', (select count(*) from pg_policies where schemaname = 'public')::text, '114',
         case when (select count(*) from pg_policies where schemaname = 'public') = 114 then 'OK' else 'STOP' end
  union all
  select 31, 'storage_policy_count', (select count(*) from pg_policies where schemaname = 'storage')::text, '11',
         case when (select count(*) from pg_policies where schemaname = 'storage') = 11 then 'OK' else 'STOP' end
  -- 4) grants
  union all
  select 40, 'anon_table_privileges', g.anon_privs, 'legal_documents:SELECT',
         case when g.anon_privs = 'legal_documents:SELECT' then 'OK' else 'STOP' end from g
  union all
  select 41, 'client_truncate_trigger_references', g.client_dangerous::text, '0',
         case when g.client_dangerous = 0 then 'OK' else 'STOP' end from g
  union all
  select 42, 'anon_execute_security_definer', g.anon_definer, 'esblu_get_invite_preview',
         case when g.anon_definer = 'esblu_get_invite_preview' then 'OK' else 'STOP' end from g
  union all
  select 43, 'security_definer_without_search_path', g.definer_no_sp::text, '0',
         case when g.definer_no_sp = 0 then 'OK' else 'STOP' end from g
  union all
  select 44, 'authenticated_table_privilege_count', g.auth_privs::text, '139',
         case when g.auth_privs = 139 then 'OK' else 'WARN' end from g
  union all
  select 45, 'service_role_table_privilege_count', g.svc_privs::text, '427',
         case when g.svc_privs = 427 then 'OK' else 'WARN' end from g
  -- 5) storage
  union all
  select 50, 'public_buckets', coalesce((select string_agg(id, ',' order by id) from storage.buckets where public), ''), '',
         case when exists (select 1 from storage.buckets where public) then 'STOP' else 'OK' end
  union all
  select 51, 'unexpected_buckets',
         coalesce((select string_agg(id, ',' order by id) from storage.buckets where id not in (select b from expected_buckets)), ''), '',
         case when exists (select 1 from storage.buckets where id not in (select b from expected_buckets)) then 'STOP' else 'OK' end
  union all
  select 52, 'missing_buckets',
         coalesce((select string_agg(b, ',' order by b) from expected_buckets where b not in (select id from storage.buckets)), ''), '',
         case when exists (select 1 from expected_buckets where b not in (select id from storage.buckets)) then 'STOP' else 'OK' end
  -- 6) owner / membership invariants (predpoklad backfillu 20261012140000)
  union all
  select 60, 'companies_without_exactly_one_active_owner', o.not_one_owner::text, '0',
         case when o.not_one_owner = 0 then 'OK' else 'STOP' end from owners o
  union all
  select 61, 'companies_owner_id_not_active_owner_member', o.owner_id_mismatch::text, '0',
         case when o.owner_id_mismatch = 0 then 'OK' else 'STOP' end from owners o
  union all
  select 62, 'users_with_more_than_one_active_membership', o.users_multi_active::text, '0',
         case when o.users_multi_active = 0 then 'OK' else 'STOP' end from owners o
  union all
  select 63, 'orphan_memberships_company', o.orphan_company::text, '0',
         case when o.orphan_company = 0 then 'OK' else 'STOP' end from owners o
  union all
  select 64, 'orphan_memberships_user', o.orphan_user::text, '0',
         case when o.orphan_user = 0 then 'OK' else 'STOP' end from owners o
  union all
  select 65, 'membership_role_status_values',
         (select coalesce(string_agg(distinct role || '/' || status, ',' order by role || '/' || status), '') from public.company_members), 'subset of owner|admin|employee|accountant / active|invited|disabled',
         case when exists (select 1 from public.company_members
                            where role not in ('owner', 'admin', 'employee', 'accountant')
                               or status not in ('active', 'invited', 'disabled')) then 'STOP' else 'OK' end
  -- 7) funkcie a rozšírenia
  union all
  select 70, 'required_functions_missing',
         coalesce((select string_agg(f, ',' order by f) from req_fn
                    where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname = 'public' and p.proname = f)), ''), '',
         case when exists (select 1 from req_fn where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                                where n.nspname = 'public' and p.proname = f)) then 'STOP' else 'OK' end
  union all
  select 71, 'pgcrypto_extension', coalesce((select extversion from pg_extension where extname = 'pgcrypto'), ''), 'present',
         case when exists (select 1 from pg_extension where extname = 'pgcrypto') then 'OK' else 'STOP' end
  -- 8) kritické business stavy (billing / eFaktúra / rollback podmienky)
  union all
  select 80, 'company_plan_values',
         (select coalesce(string_agg(plan || '=' || n, ',' order by plan), '') from (select coalesce(plan, '<null>') as plan, count(*) n from public.companies group by 1) s),
         'subset of free|pro|admin',
         case when exists (select 1 from public.companies where plan is null or plan not in ('free', 'pro', 'admin')) then 'STOP' else 'INFO' end
  union all
  select 81, 'finalized_invoices', (select count(*) from public.invoices where finalized_at is not null)::text, 'INFO (rollback 100005/100009 podmienka)', 'INFO'
  union all
  select 82, 'company_entitlements_rows', (select count(*) from public.company_entitlements)::text, 'INFO', 'INFO'
  union all
  select 83, 'companies / active_members / auth_users',
         (select count(*) from public.companies)::text || ' / ' ||
         (select count(*) from public.company_members where status = 'active')::text || ' / ' ||
         (select count(*) from auth.users)::text, 'INFO', 'INFO'
  union all
  select 84, 'storage_objects', (select count(*) from storage.objects)::text, 'INFO (DB záloha NEobsahuje súbory Storage)', 'INFO'
)
select ord, check_name, value, expected, status
from checks
order by case status when 'STOP' then 0 when 'WARN' then 1 when 'INFO' then 3 else 2 end, ord;
-- END-CHECKS

rollback;
