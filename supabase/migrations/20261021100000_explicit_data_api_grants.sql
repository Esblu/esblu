-- =============================================================================
-- EXPLICITNÉ DATA API GRANTS (Supabase zmena 2026-10-30)
--
-- PREČO
-- -----
-- Od 30. 10. 2026 Supabase pri existujúcich projektoch prestane automaticky
-- udeľovať Data API grants (SELECT/INSERT/UPDATE/DELETE, EXECUTE, sekvencie)
-- rolám anon / authenticated / service_role na nové objekty v `public`.
-- Nové / preview projekty a `db reset` sa tak správajú už dnes.
--
-- Audit 2026-10-21 (repo vs staging cjbdijbbcujvmrzezusd vs produkcia
-- fkpgvgvsmbpieduoatrt read-only, čistý replay v PGlite bez auto-grantov):
--   * 24 z 92 tabuliek, ktoré appka používa ako `authenticated`, nemalo v
--     repe žiadny grant a fungovalo iba vďaka historickým default privileges
--     (invoices, documents, vehicles, machines, inventory, business_partners …).
--     Čistý replay = `permission denied` (42501) pre appku.
--   * service_role mala na 57 tabuľkách a 156 funkciách prístup iba z
--     default privileges; čistý replay = serverové cesty (zrušenie účtu,
--     cron notifikácie, billing) by zlyhali.
--   * Príliš široké historické auto-granty: authenticated CRUD na
--     ai_scan_limits / ai_scan_usage (bez politík), INSERT/UPDATE/DELETE na
--     invoice_parties / invoice_tax_breakdowns / invoice_payments /
--     invoice_events / invoice_number_sequences (iba SELECT politika),
--     DELETE na company_billing_profile (bez DELETE politiky) a settings
--     (nikdy nebolo zámerom repa); service_role TRUNCATE/REFERENCES/
--     TRIGGER/MAINTAIN.
--
-- ČO ROBÍ
-- -------
-- Deterministicky nastaví CIEĽOVÝ stav (nie diff): pre každú tabuľku v
-- public revoke všetkého od klientskych rolí a explicitné granty podľa
-- matice supabase/grants/public-data-api-grants.json (least privilege podľa
-- reálneho použitia v kóde a existujúcich RLS politík). Idempotentná.
--
-- GRANT ≠ RLS. Táto migrácia NEMENÍ žiadnu politiku, RLS ani FORCE RLS,
-- funkciu, trigger, storage.objects politiku ani dáta. Odoberá iba práva,
-- ktoré RLS aj tak zamietala (žiadna zodpovedajúca politika) alebo ktoré
-- appka nepoužíva; zachováva všetky práva, ktoré appka používa.
--
-- Billing autorita zostáva OWNER-ONLY cez RPC (esblu_billing_*): žiadna
-- billing tabuľka nemá grant pre authenticated. trial_claims, cleanup fronty,
-- webhook/provider/eInvoice interné tabuľky sú service-only.
--
-- PORADIE: musí bežať PO všetkých migráciách až po 20261013100000 vrátane
-- (precondition nižšie zlyhá, ak niektorá tabuľka/RPC chýba alebo existuje
-- tabuľka bez rozhodnutia).
--
-- ROLLBACK: supabase/rollback/20261021100000_explicit_data_api_grants_rollback.sql
-- grants: explicit (táto migrácia je zdroj pravdy pre existujúce tabuľky)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Precondition (fail-closed): v public existujú presne tieto tabuľky.
--    Chýbajúca = predchádzajúca migrácia nebola aplikovaná (poradie!).
--    Neznáma   = tabuľka bez explicitného rozhodnutia o grantoch.
--    (Chýbajúca funkcia z allowlistu v sekcii 3 zlyhá samotným GRANT.)
-- -----------------------------------------------------------------------------
do $precondition$
declare
  v_expected text[] := array[
    'account_deletion_cleanup_jobs', 'accounting_handoff_export_items', 'accounting_handoff_exports', 'ai_evidence',
    'ai_evidence_review_log', 'ai_processing_usage', 'ai_scan_limits', 'ai_scan_usage',
    'assistant_action_confirmations', 'assistant_conversation_contexts', 'beta_allowlist', 'billing_channel_rules',
    'billing_checkout_sessions', 'billing_events', 'billing_provider_links', 'billing_provider_prices',
    'billing_reconciliation', 'billing_region_groups', 'billing_runtime_config', 'billing_store_reports',
    'business_partners', 'chat_attachments', 'chat_conversation_members', 'chat_conversations',
    'chat_message_references', 'chat_messages', 'companies', 'company_billing_profile',
    'company_dpa_acceptances', 'company_entitlements', 'company_invites', 'company_legal_identities',
    'company_members', 'custom_document_categories', 'document_attachments', 'document_download_events',
    'document_export_package_items', 'document_export_packages', 'document_folder_items', 'document_folders',
    'document_links', 'document_review_log', 'documents', 'einvoice_enroll_attempts',
    'einvoice_event_cursors', 'einvoice_events', 'einvoice_inbound', 'einvoice_ops_audit',
    'einvoice_organizations', 'einvoice_outbound', 'einvoice_rollout', 'einvoice_webhook_events',
    'einvoice_webhook_rejections', 'entitlement_catalog', 'esblu_intake_attestations_used', 'fx_rate_import_batches',
    'fx_reference_rates', 'inventory_items', 'inventory_photos', 'invoice_accounting_state',
    'invoice_accounting_state_log', 'invoice_advance_deductions', 'invoice_events', 'invoice_items',
    'invoice_number_sequences', 'invoice_parties', 'invoice_payments', 'invoice_tax_breakdowns',
    'invoices', 'legal_documents', 'machine_photos', 'machine_services',
    'machines', 'media_deletion_queue', 'notification_deliveries', 'notification_preferences',
    'plan_limits', 'push_devices', 'push_subscriptions', 'received_advance_links',
    'session_active_company', 'settings', 'subscription_accounts', 'subscription_plan_entitlements',
    'subscription_plans', 'trial_claims', 'user_active_company', 'user_legal_acceptances',
    'vehicle_photos', 'vehicle_services', 'vehicle_vignettes', 'vehicles'
  ];
  v_missing text;
  v_unknown text;
begin
  select string_agg(e, ', ' order by e) into v_missing
  from unnest(v_expected) e where to_regclass('public.' || e) is null;

  select string_agg(c.relname, ', ' order by c.relname) into v_unknown
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and c.relname <> all (v_expected);

  if v_missing is not null or v_unknown is not null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_GRANTS_PRECONDITION',
      detail = concat_ws(' / ', 'missing tables: ' || v_missing, 'tables without grant decision: ' || v_unknown),
      hint = 'Aplikuj najprv všetky predchádzajúce migrácie; novú tabuľku doplň do supabase/grants/public-data-api-grants.json a do jej vlastnej migrácie.';
  end if;
end
$precondition$;

-- -----------------------------------------------------------------------------
-- 2. Tabuľky — cieľový stav, nie diff: najprv revoke všetkého od klientskych
--    rolí, potom iba granty z matice (supabase/grants/public-data-api-grants.json;
--    trieda A–E a dôvod pre každú tabuľku sú tam). anon: iba legal_documents.
--    service_role: iba DML (bez TRUNCATE/REFERENCES/TRIGGER/MAINTAIN).
-- -----------------------------------------------------------------------------
revoke all on table
  public.account_deletion_cleanup_jobs,
  public.accounting_handoff_export_items,
  public.accounting_handoff_exports,
  public.ai_evidence,
  public.ai_evidence_review_log,
  public.ai_processing_usage,
  public.ai_scan_limits,
  public.ai_scan_usage,
  public.assistant_action_confirmations,
  public.assistant_conversation_contexts,
  public.beta_allowlist,
  public.billing_channel_rules,
  public.billing_checkout_sessions,
  public.billing_events,
  public.billing_provider_links,
  public.billing_provider_prices,
  public.billing_reconciliation,
  public.billing_region_groups,
  public.billing_runtime_config,
  public.billing_store_reports,
  public.business_partners,
  public.chat_attachments,
  public.chat_conversation_members,
  public.chat_conversations,
  public.chat_message_references,
  public.chat_messages,
  public.companies,
  public.company_billing_profile,
  public.company_dpa_acceptances,
  public.company_entitlements,
  public.company_invites,
  public.company_legal_identities,
  public.company_members,
  public.custom_document_categories,
  public.document_attachments,
  public.document_download_events,
  public.document_export_package_items,
  public.document_export_packages,
  public.document_folder_items,
  public.document_folders,
  public.document_links,
  public.document_review_log,
  public.documents,
  public.einvoice_enroll_attempts,
  public.einvoice_event_cursors,
  public.einvoice_events,
  public.einvoice_inbound,
  public.einvoice_ops_audit,
  public.einvoice_organizations,
  public.einvoice_outbound,
  public.einvoice_rollout,
  public.einvoice_webhook_events,
  public.einvoice_webhook_rejections,
  public.entitlement_catalog,
  public.esblu_intake_attestations_used,
  public.fx_rate_import_batches,
  public.fx_reference_rates,
  public.inventory_items,
  public.inventory_photos,
  public.invoice_accounting_state,
  public.invoice_accounting_state_log,
  public.invoice_advance_deductions,
  public.invoice_events,
  public.invoice_items,
  public.invoice_number_sequences,
  public.invoice_parties,
  public.invoice_payments,
  public.invoice_tax_breakdowns,
  public.invoices,
  public.legal_documents,
  public.machine_photos,
  public.machine_services,
  public.machines,
  public.media_deletion_queue,
  public.notification_deliveries,
  public.notification_preferences,
  public.plan_limits,
  public.push_devices,
  public.push_subscriptions,
  public.received_advance_links,
  public.session_active_company,
  public.settings,
  public.subscription_accounts,
  public.subscription_plan_entitlements,
  public.subscription_plans,
  public.trial_claims,
  public.user_active_company,
  public.user_legal_acceptances,
  public.vehicle_photos,
  public.vehicle_services,
  public.vehicle_vignettes,
  public.vehicles
from public, anon, authenticated, service_role;

-- anon
grant select on table
  public.legal_documents
to anon;

-- authenticated
grant select, insert, update, delete on table
  public.ai_evidence,
  public.business_partners,
  public.custom_document_categories,
  public.document_attachments,
  public.document_folders,
  public.document_links,
  public.documents,
  public.inventory_items,
  public.inventory_photos,
  public.invoice_items,
  public.invoices,
  public.machine_photos,
  public.machine_services,
  public.machines,
  public.vehicle_photos,
  public.vehicle_services,
  public.vehicle_vignettes,
  public.vehicles
to authenticated;

grant select, insert, delete on table
  public.document_folder_items
to authenticated;

grant select, insert, update on table
  public.chat_messages,
  public.company_billing_profile,
  public.invoice_accounting_state
to authenticated;

grant select, insert on table
  public.accounting_handoff_export_items,
  public.accounting_handoff_exports,
  public.chat_attachments,
  public.document_export_package_items,
  public.document_export_packages,
  public.document_review_log
to authenticated;

grant select on table
  public.ai_evidence_review_log,
  public.chat_conversation_members,
  public.chat_conversations,
  public.chat_message_references,
  public.companies,
  public.company_dpa_acceptances,
  public.company_legal_identities,
  public.company_members,
  public.document_download_events,
  public.einvoice_events,
  public.einvoice_inbound,
  public.einvoice_organizations,
  public.einvoice_outbound,
  public.einvoice_webhook_events,
  public.fx_rate_import_batches,
  public.fx_reference_rates,
  public.invoice_accounting_state_log,
  public.invoice_advance_deductions,
  public.invoice_events,
  public.invoice_number_sequences,
  public.invoice_parties,
  public.invoice_payments,
  public.invoice_tax_breakdowns,
  public.legal_documents,
  public.plan_limits,
  public.received_advance_links,
  public.session_active_company,
  public.settings,
  public.user_active_company,
  public.user_legal_acceptances
to authenticated;

-- settings: zápis iba vybraných stĺpcov (plan sa klientom nemení — 20260721000100)
grant insert (user_id, company_name, logo_path) on table public.settings to authenticated;
grant update (company_name, logo_path) on table public.settings to authenticated;

-- service_role
grant select, insert, update, delete on table
  public.accounting_handoff_export_items,
  public.accounting_handoff_exports,
  public.ai_evidence,
  public.ai_evidence_review_log,
  public.ai_processing_usage,
  public.ai_scan_limits,
  public.ai_scan_usage,
  public.assistant_action_confirmations,
  public.assistant_conversation_contexts,
  public.beta_allowlist,
  public.billing_channel_rules,
  public.billing_checkout_sessions,
  public.billing_events,
  public.billing_provider_links,
  public.billing_provider_prices,
  public.billing_reconciliation,
  public.billing_region_groups,
  public.billing_runtime_config,
  public.billing_store_reports,
  public.business_partners,
  public.chat_attachments,
  public.chat_conversation_members,
  public.chat_conversations,
  public.chat_message_references,
  public.chat_messages,
  public.companies,
  public.company_billing_profile,
  public.company_dpa_acceptances,
  public.company_entitlements,
  public.company_invites,
  public.company_legal_identities,
  public.company_members,
  public.custom_document_categories,
  public.document_attachments,
  public.document_download_events,
  public.document_export_package_items,
  public.document_export_packages,
  public.document_folder_items,
  public.document_folders,
  public.document_links,
  public.document_review_log,
  public.documents,
  public.einvoice_enroll_attempts,
  public.einvoice_inbound,
  public.einvoice_organizations,
  public.einvoice_outbound,
  public.einvoice_rollout,
  public.einvoice_webhook_events,
  public.einvoice_webhook_rejections,
  public.entitlement_catalog,
  public.esblu_intake_attestations_used,
  public.inventory_items,
  public.inventory_photos,
  public.invoice_accounting_state,
  public.invoice_accounting_state_log,
  public.invoice_advance_deductions,
  public.invoice_events,
  public.invoice_items,
  public.invoice_number_sequences,
  public.invoice_parties,
  public.invoice_payments,
  public.invoice_tax_breakdowns,
  public.invoices,
  public.legal_documents,
  public.machine_photos,
  public.machine_services,
  public.machines,
  public.media_deletion_queue,
  public.notification_deliveries,
  public.notification_preferences,
  public.plan_limits,
  public.push_devices,
  public.push_subscriptions,
  public.received_advance_links,
  public.session_active_company,
  public.settings,
  public.subscription_accounts,
  public.subscription_plan_entitlements,
  public.subscription_plans,
  public.user_active_company,
  public.user_legal_acceptances,
  public.vehicle_photos,
  public.vehicle_services,
  public.vehicle_vignettes,
  public.vehicles
to service_role;

grant select, insert, update on table
  public.account_deletion_cleanup_jobs,
  public.einvoice_event_cursors,
  public.trial_claims
to service_role;

grant select, insert on table
  public.einvoice_events,
  public.einvoice_ops_audit,
  public.fx_rate_import_batches,
  public.fx_reference_rates
to service_role;

-- -----------------------------------------------------------------------------
-- 3. Funkcie: service_role EXECUTE iba na explicitný allowlist (zámer repa).
--    Historicky mala service_role EXECUTE na každej novej funkcii z default
--    privileges projektu; čistý replay po 2026-10-30 to už nedá. Serverové
--    RPC (billing_*, einvoice_*, account deletion, push, fx, legal identity)
--    sú v allowliste; interné SECURITY DEFINER helpery bežia ako vlastník a
--    service_role ich priamo volať nepotrebuje. anon / authenticated / PUBLIC
--    EXECUTE sa NEMENIA — sú v repe explicitné a čistý replay == staging.
-- -----------------------------------------------------------------------------
revoke execute on all functions in schema public from service_role;

grant execute on function
  public.esblu_accept_company_invite(text),
  public.esblu_account_deletion_commit(text,uuid,uuid,boolean),
  public.esblu_active_membership_for_user(uuid),
  public.esblu_active_membership_for_user(uuid,uuid),
  public.esblu_billing_apply_charge(uuid,text,jsonb),
  public.esblu_billing_apply_event(uuid,jsonb),
  public.esblu_billing_attach_checkout_session(uuid,text),
  public.esblu_billing_authorize_manage(),
  public.esblu_billing_blocks_account_deletion(text,text,boolean),
  public.esblu_billing_canonical_statuses(),
  public.esblu_billing_claim_store_reports(integer),
  public.esblu_billing_close_event(uuid,text,text,jsonb),
  public.esblu_billing_complete_store_report(uuid,boolean,text),
  public.esblu_billing_create_checkout_intent(text,text),
  public.esblu_billing_create_purchase_intent(text,text,text,text,text,text,text),
  public.esblu_billing_explain_my_entitlements(),
  public.esblu_billing_issue_account_token(text),
  public.esblu_billing_list_plans(),
  public.esblu_billing_manage_here(text,text),
  public.esblu_billing_managed_via(text),
  public.esblu_billing_method_info(text),
  public.esblu_billing_my_access(),
  public.esblu_billing_my_intent(uuid),
  public.esblu_billing_ops_status(uuid),
  public.esblu_billing_purchase_options(text,text),
  public.esblu_billing_queue_store_report(uuid,jsonb),
  public.esblu_billing_reconcile_candidates(integer),
  public.esblu_billing_reconcile_record(uuid,text,text),
  public.esblu_billing_reconcile_requeue(uuid),
  public.esblu_billing_record_event(text,text,text,text,timestamp with time zone,text),
  public.esblu_billing_resolve_methods(text,text),
  public.esblu_billing_resolve_price(text,text,text,text),
  public.esblu_billing_status_is_entitling(text),
  public.esblu_billing_status_is_open(text),
  public.esblu_billing_status_is_terminal(text),
  public.esblu_billing_sync_entitlements(uuid),
  public.esblu_can_delete_media_object(text,text),
  public.esblu_can_read_media_object(text,text),
  public.esblu_can_upload_media_object(text,text),
  public.esblu_claim_key(text,text),
  public.esblu_company_deletion_retention_blocker(uuid),
  public.esblu_company_plan(uuid),
  public.esblu_create_company_invite(text,text),
  public.esblu_create_my_company(text),
  public.esblu_einvoice_claim_inbound(integer,integer),
  public.esblu_einvoice_claim_outbound(text,integer,integer,integer),
  public.esblu_einvoice_claim_outbound_by_submission(uuid,text,integer),
  public.esblu_einvoice_enroll_attempt_begin(uuid,uuid),
  public.esblu_einvoice_enroll_attempt_finish(uuid,text),
  public.esblu_einvoice_event_cursor_advance(text,text,uuid,bigint,boolean,text),
  public.esblu_einvoice_event_cursor_claim(text,text,integer),
  public.esblu_einvoice_event_cursor_rewind(text,text,bigint,text,text),
  public.esblu_einvoice_event_ops(),
  public.esblu_einvoice_event_requeue(uuid,text,text),
  public.esblu_einvoice_event_resolve(uuid,text,text),
  public.esblu_einvoice_health(integer,integer),
  public.esblu_einvoice_inbound_create_draft(uuid,jsonb),
  public.esblu_einvoice_inbound_register(text,text,text,text,text,jsonb),
  public.esblu_einvoice_inbound_transition(uuid,text,text,text,text,jsonb),
  public.esblu_einvoice_operator_begin(uuid,text,uuid,text,text,integer,integer),
  public.esblu_einvoice_org_apply_enroll(text,text,text,text,text,text,text),
  public.esblu_einvoice_org_participant_event(text,text,text,text,text,text,timestamp with time zone),
  public.esblu_einvoice_org_upsert_provisioned(uuid,text,text,text,text,text,text,text,boolean,jsonb),
  public.esblu_einvoice_outbound_record_transport(uuid,text,text,text),
  public.esblu_einvoice_outbound_transition(uuid,text,text,text,text,jsonb),
  public.esblu_einvoice_outcomes_24h(),
  public.esblu_einvoice_request_outbound(uuid,uuid,text,text,text,integer,text),
  public.esblu_einvoice_rollout_allowed(uuid,text),
  public.esblu_einvoice_storage_consistency(),
  public.esblu_einvoice_webhook_complete(uuid,text,text),
  public.esblu_einvoice_webhook_record(text,text,text,text,text,text),
  public.esblu_einvoice_webhook_rejection_record(text,text,text),
  public.esblu_einvoice_webhook_retention(integer,integer),
  public.esblu_einvoice_webhook_retry(uuid,integer),
  public.esblu_ensure_my_owner_company(),
  public.esblu_finalize_ai_processing(uuid,boolean),
  public.esblu_fx_import_ecb_batch(text,text,date,date,jsonb),
  public.esblu_fx_official_rate(text,date),
  public.esblu_get_my_checkout_status(uuid),
  public.esblu_get_my_company_entitlements(),
  public.esblu_get_my_subscription(),
  public.esblu_legal_entity_key(text,text),
  public.esblu_list_my_companies(),
  public.esblu_media_deletion_sweep(integer),
  public.esblu_media_role_allows(text,text),
  public.esblu_member_delete_self(uuid),
  public.esblu_member_leave_company(uuid,uuid),
  public.esblu_my_active_membership(),
  public.esblu_my_company_legal_identity(),
  public.esblu_my_company_trial_eligibility(),
  public.esblu_normalize_registration_id(text,text),
  public.esblu_operator_grant_team_allowance(uuid,integer,text),
  public.esblu_operator_override_company_trial(uuid),
  public.esblu_owner_delete_company(uuid),
  public.esblu_owner_delete_company(uuid,uuid),
  public.esblu_push_chat_recipients(uuid),
  public.esblu_push_companies_with_targets(),
  public.esblu_push_delivery_targets(uuid,uuid[]),
  public.esblu_push_record_outcome(text,uuid,text),
  public.esblu_push_revoke_ended(),
  public.esblu_record_company_legal_identity(uuid,text,text,boolean,text),
  public.esblu_record_company_legal_identity_attempt(uuid,text,text,text),
  public.esblu_request_session_id(),
  public.esblu_require_my_entitlement(text),
  public.esblu_reserve_ai_processing(text,text,text),
  public.esblu_resolve_entitlement(uuid,text),
  public.esblu_set_my_active_company(uuid),
  public.esblu_try_claim_company_trial(uuid),
  public.esblu_user_global_cleanup(uuid)
to service_role;

-- -----------------------------------------------------------------------------
-- 4. Default privileges: opt-in do nového správania Supabase (2026-10-30) už
--    teraz, aby existujúci projekt (staging/produkcia) a čistý replay mali
--    ROVNAKÝ model — nová tabuľka / funkcia / sekvencia v public nedostane
--    nič automaticky; každá migrácia musí granty uviesť výslovne
--    (scripts/grants-migration-guard-tests.ts). Žiadne GRANT default privileges.
-- -----------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, truncate, references, trigger, maintain on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select, update on sequences from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

comment on schema public is
  'Data API granty su explicitne per tabulka (supabase/grants/public-data-api-grants.json, migracia 20261021100000). Default privileges neudeluju nic anon/authenticated/service_role. RLS urcuje riadky, GRANT urcuje objekt - plati oboje.';
