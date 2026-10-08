-- =============================================================================
-- eFaktúra — PRODUKČNÝ PRECHECK pred migráciami 20261002100000 … 20261008100011
--
-- ČISTO READ-ONLY. Spúšťa iba vlastník (alebo na jeho výslovný súhlas) nad projektom
-- `assetpilot` (fkpgvgvsmbpieduoatrt), PRED oknom migrácií. Nič nemení: transakcia je READ ONLY
-- a končí ROLLBACK. Neobsahuje ani nevypisuje osobné údaje — iba počty a identifikátory riadkov
-- (uuid) pri nálezoch.
--
-- Výsledok: každý riadok = kontrola, `status`:
--   STOP  → migrácie NESPÚŠŤAŤ, najprv analyzovať (detailné dotazy v časti B),
--   WARN  → migrácia prejde, ale je potrebný krok v runbooku / komunikácia,
--   INFO  → iba prehľad,
--   OK    → v poriadku.
-- Overené (read-only): staging 8. 10. 2026 (očakávané STOP — staging je už zmigrovaný) a PGlite simulácia produkcie
-- (schéma pred reťazcom): všetky kontroly OK/INFO — scripts/einvoice-prod-precheck-tests.ts.
-- =============================================================================

begin;
set transaction read only;

-- A) SÚHRN -------------------------------------------------------------------------------------
with
mig as (
  select max(version) as last_version, count(*) filter (where name like '2026100%' and name like '%einvoice%') as einvoice_applied
  from supabase_migrations.schema_migrations
),
-- Očakávané signatúry existujúcich funkcií, ktoré reťazec mení cez CREATE OR REPLACE
-- (referencia: staging po replayi repa; zmena návratového typu alebo odobratie DEFAULT = chyba migrácie).
expected(proname, args, result) as (values
  ('esblu_add_invoice_payment', 'p_invoice_id uuid, p_paid_amount numeric, p_paid_at date DEFAULT CURRENT_DATE, p_payment_method text DEFAULT NULL::text, p_note text DEFAULT NULL::text', 'jsonb'),
  ('esblu_block_invoice_snapshot_mutation', '', 'trigger'),
  ('esblu_create_received_invoice_draft', 'p_supplier_business_partner_id uuid, p_supplier_invoice_number text, p_issue_date date, p_items jsonb, p_due_date date DEFAULT NULL::date, p_delivery_date date DEFAULT NULL::date, p_tax_point_date date DEFAULT NULL::date, p_currency text DEFAULT ''EUR''::text, p_iban text DEFAULT NULL::text, p_bic text DEFAULT NULL::text, p_payment_reference text DEFAULT NULL::text, p_variable_symbol text DEFAULT NULL::text, p_buyer_reference text DEFAULT NULL::text, p_purchase_order_reference text DEFAULT NULL::text, p_received_at date DEFAULT NULL::date, p_source_document_id uuid DEFAULT NULL::uuid, p_dedupe_fingerprint text DEFAULT NULL::text', 'jsonb'),
  ('esblu_enforce_invoicing_entitlement', '', 'trigger'),
  ('esblu_finalize_invoice', 'p_invoice_id uuid', 'jsonb'),
  ('esblu_my_finance_manage', '', 'boolean'),
  ('esblu_my_finance_view', '', 'boolean'),
  ('esblu_remove_invoice_payment', 'p_payment_id uuid', 'jsonb'),
  ('esblu_save_invoice_draft', 'p_invoice_id uuid, p_header jsonb, p_items jsonb, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone', 'SETOF invoices')
),
actual as (
  select p.proname, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select proname from expected)
),
sig as (
  select e.proname,
         count(a.*) as n,
         bool_or(a.args = e.args and a.result = e.result) as match
  from expected e left join actual a on a.proname = e.proname
  group by e.proname
),
-- Stĺpce a tabuľky, ktoré reťazec vytvára — v produkcii ešte nesmú existovať (inak drift).
new_cols(tbl, col) as (values
  ('company_billing_profile', 'vat_payer_status'),
  ('invoices', 'correction_reason'), ('invoices', 'fx_rate'), ('invoices', 'fx_rate_date'), ('invoices', 'fx_rate_source'),
  ('invoices', 'tax_base_eur'), ('invoices', 'vat_total_eur'), ('invoices', 'fx_tax_point_date'), ('invoices', 'fx_reference_rate_id'),
  ('invoices', 'corrected_document_reference'), ('invoices', 'correction_review_status'), ('invoices', 'prepaid_amount'),
  ('invoices', 'advance_review_status'), ('invoice_payments', 'entry_type'),
  ('invoices', 'untaxed_prepaid_amount'), ('invoice_items', 'is_advance_deduction'), ('invoice_items', 'advance_invoice_id'),
  ('einvoice_outbound', 'sbdh_instance_identifier'), ('einvoice_outbound', 'as4_message_id')
),
-- 20261008100011: úplné zoznamy objektov, ktoré reťazec VYTVÁRA (generované zo súborov migrácií).
new_tables(t) as (values
  ('einvoice_enroll_attempts'), ('einvoice_event_cursors'), ('einvoice_events'), ('einvoice_inbound'),
  ('einvoice_ops_audit'), ('einvoice_organizations'), ('einvoice_outbound'), ('einvoice_rollout'),
  ('einvoice_webhook_events'), ('einvoice_webhook_rejections'), ('fx_rate_import_batches'), ('fx_rate_publication_exceptions'),
  ('fx_reference_rates'), ('invoice_advance_deductions'), ('received_advance_links')
),
new_funcs(f) as (values
  ('esblu_a_received_advance_finalize'), ('esblu_add_invoice_refund'), ('esblu_available_advances'), ('esblu_block_client_advance_item_change'),
  ('esblu_block_client_advance_review_change'), ('esblu_block_client_correction_review_change'), ('esblu_block_finalized_advance_deductions'), ('esblu_block_payment_on_credit_note'),
  ('esblu_block_snapshot_insert_when_finalized'), ('esblu_check_untaxed_prepaid'), ('esblu_default_breakdown_exemption'), ('esblu_easter_sunday'),
  ('esblu_einvoice_actor_context'), ('esblu_einvoice_apply_xml_totals'), ('esblu_einvoice_claim_inbound'), ('esblu_einvoice_claim_outbound'),
  ('esblu_einvoice_claim_outbound_by_submission'), ('esblu_einvoice_enroll_attempt_begin'), ('esblu_einvoice_enroll_attempt_finish'), ('esblu_einvoice_event_cursor_advance'),
  ('esblu_einvoice_event_cursor_claim'), ('esblu_einvoice_event_cursor_rewind'), ('esblu_einvoice_event_ops'), ('esblu_einvoice_event_requeue'),
  ('esblu_einvoice_event_resolve'), ('esblu_einvoice_events_guard'), ('esblu_einvoice_health'), ('esblu_einvoice_inbound_category'),
  ('esblu_einvoice_inbound_create_correction'), ('esblu_einvoice_inbound_create_draft'), ('esblu_einvoice_inbound_guard'), ('esblu_einvoice_inbound_register'),
  ('esblu_einvoice_inbound_transition'), ('esblu_einvoice_inbound_xml_totals_guard'), ('esblu_einvoice_log_state_change'), ('esblu_einvoice_my_rollout'),
  ('esblu_einvoice_operator_begin'), ('esblu_einvoice_org_apply_enroll'), ('esblu_einvoice_org_company'), ('esblu_einvoice_org_participant_event'),
  ('esblu_einvoice_org_upsert_provisioned'), ('esblu_einvoice_organization_guard'), ('esblu_einvoice_outbound_category'), ('esblu_einvoice_outbound_guard'),
  ('esblu_einvoice_outbound_record_transport'), ('esblu_einvoice_outbound_rollout_gate'), ('esblu_einvoice_outbound_transition'), ('esblu_einvoice_outcomes_24h'),
  ('esblu_einvoice_received_finalize_guard'), ('esblu_einvoice_request_outbound'), ('esblu_einvoice_resolve_supplier'), ('esblu_einvoice_rollout_allowed'),
  ('esblu_einvoice_storage_consistency'), ('esblu_einvoice_touch_updated_at'), ('esblu_einvoice_webhook_complete'), ('esblu_einvoice_webhook_record'),
  ('esblu_einvoice_webhook_rejection_record'), ('esblu_einvoice_webhook_retention'), ('esblu_einvoice_webhook_retry'), ('esblu_fx_append_only'),
  ('esblu_fx_import_ecb_batch'), ('esblu_fx_is_publication_day'), ('esblu_fx_official_rate'), ('esblu_fx_reference_rate_date'),
  ('esblu_invoice_correction_event'), ('esblu_invoice_correction_link_guard'), ('esblu_invoice_events_append_only'), ('esblu_invoice_finalize_compliance'),
  ('esblu_invoice_settlement'), ('esblu_invoice_settlement_after_finalize'), ('esblu_invoice_settlement_core'), ('esblu_lock_advance_deductions'),
  ('esblu_recalc_invoice_group_status'), ('esblu_received_advance_candidates'), ('esblu_received_advance_confirm'), ('esblu_received_advance_link'),
  ('esblu_received_advance_link_guard'), ('esblu_received_advance_match'), ('esblu_received_advance_refresh_status'), ('esblu_received_advance_reject'),
  ('esblu_received_advance_target'), ('esblu_received_advance_unlink'), ('esblu_received_correction_accept'), ('esblu_received_correction_link'),
  ('esblu_received_correction_reject'), ('esblu_received_deduction_groups'), ('esblu_received_invoice_draft_core'), ('esblu_require_invoice_creation_entitlement'),
  ('esblu_set_invoice_advance_deductions'), ('esblu_set_invoice_compliance_fields'), ('esblu_sk_vat_rates')
),
new_triggers(t) as (values
  ('esblu_a_lock_advance_deductions'), ('esblu_a_received_advance_finalize'), ('esblu_block_client_advance_item_change'), ('esblu_block_client_advance_review_change'),
  ('esblu_block_client_correction_review_change'), ('esblu_breakdown_exemption_default'), ('esblu_breakdowns_insert_guard'), ('esblu_check_untaxed_prepaid'),
  ('esblu_einvoice_received_finalize_guard'), ('esblu_invoice_correction_event'), ('esblu_invoice_correction_link_guard'), ('esblu_invoice_events_append_only'),
  ('esblu_invoice_finalize_compliance'), ('esblu_invoice_settlement_after_finalize'), ('esblu_parties_insert_guard'), ('esblu_payment_credit_note_guard'),
  ('esblu_received_correction_accept')
),
-- Objekty, na ktoré sa reťazec SPOLIEHA (musia v produkcii existovať pred migráciami).
req_tables(t) as (values
  ('companies'), ('company_members'), ('business_partners'), ('company_billing_profile'),
  ('invoices'), ('invoice_items'), ('invoice_tax_breakdowns'), ('invoice_parties'),
  ('invoice_payments'), ('invoice_events'), ('invoice_number_sequences'), ('documents'),
  ('document_links'), ('entitlement_catalog')
),
req_cols(t, c) as (values
  ('invoices', 'direction'), ('invoices', 'kind'), ('invoices', 'document_status'), ('invoices', 'payment_status'),
  ('invoices', 'corrects_invoice_id'), ('invoices', 'currency'), ('invoices', 'rounding_amount'),
  ('invoices', 'supplier_invoice_number'), ('invoices', 'customer_business_partner_id'), ('invoices', 'supplier_business_partner_id'),
  ('invoice_items', 'unit_price'), ('invoice_items', 'quantity'), ('invoice_items', 'price_mode'), ('invoice_items', 'vat_category_code'),
  ('invoice_items', 'line_net_amount'), ('invoice_items', 'line_vat_amount'), ('invoice_items', 'line_gross_amount'),
  ('invoice_number_sequences', 'series_key'), ('invoice_number_sequences', 'prefix'), ('invoice_number_sequences', 'next_number'),
  ('invoice_number_sequences', 'padding'), ('invoice_number_sequences', 'suffix')
),
req_funcs(f) as (values
  ('esblu_my_active_company_id'), ('esblu_my_active_role'), ('esblu_my_finance_manage'), ('esblu_my_finance_view'),
  ('esblu_require_entitlement_capacity'), ('esblu_resolve_entitlement'), ('esblu_add_invoice_payment'), ('esblu_remove_invoice_payment'),
  ('esblu_save_invoice_draft'), ('esblu_create_received_invoice_draft'), ('esblu_finalize_invoice'),
  ('esblu_enforce_invoicing_entitlement'), ('esblu_block_invoice_snapshot_mutation')
),
vat_mismatch as (
  select i.id
  from public.invoices i
  join lateral (select sum(b.taxable_amount) as t, sum(b.vat_amount) as v, count(*) as n
                from public.invoice_tax_breakdowns b where b.invoice_id = i.id) s on true
  where i.document_status = 'finalized' and s.n > 0
    and (i.subtotal_amount is distinct from s.t or i.vat_total_amount is distinct from s.v)
),
num as (
  -- Čísla dokladov podľa formátu Esblu: PREFIX + ROK + poradie (napr. FA20260004).
  select i.company_id, substring(i.invoice_number from '^([A-Z]+)') as prefix,
         (substring(i.invoice_number from '^[A-Z]+([0-9]{4})'))::int as yr,
         (substring(i.invoice_number from '^[A-Z]+[0-9]{4}([0-9]+)$'))::int as seq
  from public.invoices i
  where i.direction = 'issued' and i.invoice_number ~ '^[A-Z]+[0-9]{4}[0-9]+$'
)
select * from (
  select 1 as ord, 'migration_state' as check_name,
         case when (select last_version from mig) = '20261005091000' and (select einvoice_applied from mig) = 0 then 'OK' else 'STOP' end as status,
         (select format('posledná=%s, eFaktúra aplikované=%s (očakávané 20261005091000 / 0)', last_version, einvoice_applied) from mig) as detail
  union all
  select 2, 'einvoice_objects_absent',
         case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and (c.relname like 'einvoice\_%' or c.relname like 'fx\_rate%' or c.relname in ('received_advance_links', 'invoice_advance_deductions'))) = 0 then 'OK' else 'STOP' end,
         'tabuľky einvoice_* / fx_* / received_advance_links / invoice_advance_deductions nesmú existovať'
  union all
  select 3, 'new_columns_absent',
         case when exists (select 1 from information_schema.columns c join new_cols nc on nc.tbl = c.table_name and nc.col = c.column_name where c.table_schema = 'public') then 'STOP' else 'OK' end,
         coalesce((select string_agg(c.table_name || '.' || c.column_name, ', ') from information_schema.columns c join new_cols nc on nc.tbl = c.table_name and nc.col = c.column_name where c.table_schema = 'public'), 'žiadne')
  union all
  select 4, 'function_signature_drift',
         case when exists (select 1 from sig where n > 0 and not coalesce(match, false)) then 'STOP'
              when exists (select 1 from sig where n = 0) then 'WARN' else 'OK' end,
         coalesce((select string_agg(proname || case when n = 0 then ' (chýba)' else ' (iná signatúra/DEFAULT/návratový typ)' end, ', ') from sig where n = 0 or not coalesce(match, false)), 'všetky zhodné')
  union all
  select 5, 'invoice_events_event_type_check',
         case when (select count(*) from pg_constraint where conrelid = 'public.invoice_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%event_type%') = 1 then 'OK' else 'STOP' end,
         'DO bloky 20261008100005/100008 vyžadujú práve 1 CHECK nad event_type'
  union all
  select 6, 'ck_items_vat_category',
         case when (select count(*) from public.invoice_items where vat_category_code not in ('S','Z','E','AE','K','G','O')) = 0 then 'OK' else 'STOP' end,
         (select count(*)::text from public.invoice_items where vat_category_code not in ('S','Z','E','AE','K','G','O'))
  union all
  select 7, 'ck_tax_breakdowns_vat_category',
         case when (select count(*) from public.invoice_tax_breakdowns where vat_category_code not in ('S','Z','E','AE','K','G','O')) = 0 then 'OK' else 'STOP' end,
         (select count(*)::text from public.invoice_tax_breakdowns where vat_category_code not in ('S','Z','E','AE','K','G','O'))
  union all
  select 8, 'ck_invoices_kind',
         case when (select count(*) from public.invoices where kind not in ('regular_invoice','payment_received_invoice','credit_note','debit_note','proforma')) = 0 then 'OK' else 'STOP' end,
         (select count(*)::text from public.invoices where kind not in ('regular_invoice','payment_received_invoice','credit_note','debit_note','proforma'))
  union all
  select 9, 'ck_invoices_payment_status',
         case when (select count(*) from public.invoices where payment_status not in ('unpaid','partially_paid','paid','overpaid')) = 0 then 'OK' else 'STOP' end,
         (select count(*)::text from public.invoices where payment_status not in ('unpaid','partially_paid','paid','overpaid'))
  union all
  select 10, 'ck_corrections_reference',
         case when (select count(*) from public.invoices where (kind in ('credit_note','debit_note')) <> (corrects_invoice_id is not null)) = 0 then 'OK' else 'STOP' end,
         (select count(*)::text from public.invoices where (kind in ('credit_note','debit_note')) <> (corrects_invoice_id is not null))
  union all
  select 11, 'corrections_target_valid',
         case when (select count(*) from public.invoices c join public.invoices o on o.id = c.corrects_invoice_id
                    where o.company_id <> c.company_id or o.direction <> c.direction or o.kind in ('credit_note','debit_note')) = 0 then 'OK' else 'WARN' end,
         'oprava na doklad inej firmy/smeru alebo na inú opravu (guard sa uplatní až pri ďalšej zmene väzby): ' ||
         (select count(*)::text from public.invoices c join public.invoices o on o.id = c.corrects_invoice_id
          where o.company_id <> c.company_id or o.direction <> c.direction or o.kind in ('credit_note','debit_note'))
  union all
  select 12, 'duplicate_invoice_numbers',
         case when (select count(*) from (select company_id, invoice_number from public.invoices where invoice_number is not null group by 1, 2 having count(*) > 1) d) = 0 then 'OK' else 'STOP' end,
         (select count(*)::text from (select company_id, invoice_number from public.invoices where invoice_number is not null group by 1, 2 having count(*) > 1) d)
  union all
  select 13, 'number_sequence_behind_existing',
         case when exists (select 1 from num x join public.invoice_number_sequences s
                             on s.company_id = x.company_id and s.year = x.yr and s.prefix = x.prefix
                           where x.seq >= s.next_number) then 'STOP' else 'OK' end,
         'počítadlo série je za už použitým číslom (kolízia pri ďalšej finalizácii)'
  union all
  select 14, 'finalized_vat_header_vs_breakdown',
         case when (select count(*) from vat_mismatch) = 0 then 'OK' else 'WARN' end,
         'finalizované doklady s hlavičkou DPH ≠ rozpis (migrácia ich nemení; nahlásiť účtovníčke): ' ||
         (select count(*)::text from vat_mismatch)
  union all
  select 15, 'finalized_items_vs_header',
         case when (select count(*) from public.invoices i
                    where i.document_status = 'finalized'
                      and i.subtotal_amount is distinct from (select coalesce(sum(it.line_net_amount), 0) from public.invoice_items it where it.invoice_id = i.id)) = 0 then 'OK' else 'WARN' end,
         'finalizované doklady so súčtom riadkov ≠ základ v hlavičke: ' ||
         (select count(*)::text from public.invoices i
          where i.document_status = 'finalized'
            and i.subtotal_amount is distinct from (select coalesce(sum(it.line_net_amount), 0) from public.invoice_items it where it.invoice_id = i.id))
  union all
  select 16, 'currency_format',
         case when (select count(*) from public.invoices where currency !~ '^[A-Z]{3}$') = 0 then 'OK' else 'WARN' end,
         'obmedzenie je NOT VALID (existujúce riadky sa nekontrolujú); počet: ' || (select count(*)::text from public.invoices where currency !~ '^[A-Z]{3}$')
  union all
  select 17, 'foreign_currency_drafts',
         case when (select count(*) from public.invoices where direction = 'issued' and document_status = 'draft' and currency <> 'EUR') = 0 then 'OK' else 'WARN' end,
         'vydané koncepty v cudzej mene — finalizácia po migrácii vyžaduje import kurzov ECB (runbook M-3): ' ||
         (select count(*)::text from public.invoices where direction = 'issued' and document_status = 'draft' and currency <> 'EUR')
  union all
  select 18, 'foreign_currency_finalized',
         'INFO',
         'finalizované doklady v cudzej mene (bez dopadu — nemenné): ' ||
         (select count(*)::text from public.invoices where document_status = 'finalized' and currency <> 'EUR')
  union all
  select 19, 'issued_drafts_new_finalize_rules',
         case when (select count(*) from public.invoices where direction = 'issued' and document_status = 'draft') = 0 then 'OK' else 'WARN' end,
         'vydané koncepty, ktoré budú finalizované podľa nových pravidiel (§ 74 polia, kurz, opravy): ' ||
         (select count(*)::text from public.invoices where direction = 'issued' and document_status = 'draft')
  union all
  select 20, 'proforma_received',
         case when (select count(*) from public.invoices where kind = 'proforma' and direction <> 'issued') = 0 then 'OK' else 'STOP' end,
         (select count(*)::text from public.invoices where kind = 'proforma' and direction <> 'issued')
  union all
  select 21, 'payments_on_credit_notes',
         case when (select count(*) from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.kind = 'credit_note') = 0 then 'OK' else 'WARN' end,
         'existujúce úhrady na dobropise (nový trigger blokuje iba nové): ' ||
         (select count(*)::text from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.kind = 'credit_note')
  union all
  select 22, 'storage_bucket_absent',
         case when (select count(*) from storage.buckets where id = 'einvoice-documents') = 0 then 'OK' else 'WARN' end,
         'bucket einvoice-documents (migrácia ho vytvára, ON CONFLICT DO NOTHING)'
  union all
  select 23, 'invoice_counts',
         'INFO',
         (select format('faktúry: %s (finalizované %s, koncepty %s, prijaté %s, opravy %s)',
                        count(*), count(*) filter (where document_status = 'finalized'), count(*) filter (where document_status = 'draft'),
                        count(*) filter (where direction = 'received'), count(*) filter (where kind in ('credit_note','debit_note')))
          from public.invoices)
  union all
  select 24, 'items_negative_unit_price',
         case when (select count(*) from public.invoice_items where unit_price < 0) = 0 then 'OK' else 'STOP' end,
         '20261008100009: záporná cena je povolená iba pre riadok odpočtu zálohy — ' ||
         (select count(*)::text from public.invoice_items where unit_price < 0)
  union all
  select 25, 'items_unit_price_check',
         case when (select count(*) from pg_constraint where conrelid = 'public.invoice_items'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) ~ '^CHECK \(\(unit_price >= ') = 1 then 'OK' else 'WARN' end,
         '20261008100009 nahrádza pôvodný CHECK (unit_price >= 0) — očakávaný práve 1'
  union all
  select 26, 'new_tables_absent',
         case when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace join new_tables x on x.t = c.relname
                           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')) then 'STOP' else 'OK' end,
         coalesce((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace join new_tables x on x.t = c.relname
                   where n.nspname = 'public'), 'žiadna z ' || (select count(*) from new_tables)::text)
  union all
  select 27, 'new_functions_absent',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace join new_funcs x on x.f = p.proname
                           where n.nspname = 'public') then 'STOP' else 'OK' end,
         coalesce((select string_agg(distinct p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace join new_funcs x on x.f = p.proname
                   where n.nspname = 'public'), 'žiadna z ' || (select count(*) from new_funcs)::text)
  union all
  select 28, 'new_triggers_absent',
         case when exists (select 1 from pg_trigger t join new_triggers x on x.t = t.tgname where not t.tgisinternal) then 'WARN' else 'OK' end,
         'migrácie ich vytvárajú s DROP IF EXISTS (prepíšu sa) — existujúci = drift: ' ||
         coalesce((select string_agg(t.tgname, ', ') from pg_trigger t join new_triggers x on x.t = t.tgname where not t.tgisinternal), 'žiadny')
  union all
  select 29, 'required_objects_present',
         case when exists (select 1 from req_tables r where to_regclass('public.' || r.t) is null)
                or exists (select 1 from req_cols r where not exists (select 1 from information_schema.columns c
                            where c.table_schema = 'public' and c.table_name = r.t and c.column_name = r.c))
                or exists (select 1 from req_funcs r where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname = r.f))
                or to_regprocedure('auth.uid()') is null
                or to_regclass('storage.buckets') is null
              then 'STOP' else 'OK' end,
         coalesce(nullif(concat_ws(', ',
           (select string_agg('tabuľka ' || r.t, ', ') from req_tables r where to_regclass('public.' || r.t) is null),
           (select string_agg('stĺpec ' || r.t || '.' || r.c, ', ') from req_cols r where not exists (select 1 from information_schema.columns c
              where c.table_schema = 'public' and c.table_name = r.t and c.column_name = r.c)),
           (select string_agg('funkcia ' || r.f, ', ') from req_funcs r where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = r.f)),
           case when to_regprocedure('auth.uid()') is null then 'auth.uid()' end,
           case when to_regclass('storage.buckets') is null then 'storage.buckets' end), ''), 'všetky závislosti prítomné')
  union all
  select 30, 'rls_enabled_invoicing',
         case when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname in ('invoices', 'invoice_items', 'invoice_tax_breakdowns', 'invoice_parties',
                                 'invoice_payments', 'invoice_events', 'business_partners', 'company_billing_profile') and not c.relrowsecurity)
              then 'STOP' else 'OK' end,
         'RLS musí byť zapnuté na fakturačných tabuľkách (nové politiky a RPC s tým počítajú): ' ||
         coalesce((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname in ('invoices', 'invoice_items', 'invoice_tax_breakdowns', 'invoice_parties',
                         'invoice_payments', 'invoice_events', 'business_partners', 'company_billing_profile') and not c.relrowsecurity), 'všetky zapnuté')
  union all
  select 31, 'numbering_new_series',
         case when exists (select 1 from public.invoices where direction = 'issued' and invoice_number ~ '^PF[0-9]')
                or exists (select 1 from public.invoice_number_sequences where series_key = 'proforma' or prefix = 'PF')
              then 'STOP' else 'OK' end,
         '20261008100000 zavádza sériu PF (proforma) — existujúce čísla/série PF by kolidovali: ' ||
         (select count(*)::text from public.invoices where direction = 'issued' and invoice_number ~ '^PF[0-9]') || ' / ' ||
         (select count(*)::text from public.invoice_number_sequences where series_key = 'proforma' or prefix = 'PF')
  union all
  select 32, 'numbering_prefix_per_series',
         case when exists (select 1 from public.invoice_number_sequences
                           where (series_key = 'regular' and coalesce(prefix, '') not in ('FA', ''))
                              or (series_key = 'credit_note' and coalesce(prefix, '') not in ('DO', ''))
                              or (series_key = 'debit_note' and coalesce(prefix, '') not in ('ID', ''))) then 'WARN' else 'OK' end,
         'série s iným prefixom než FA/DO/ID (migrácia ich nemení; nové doklady pokračujú v existujúcej sérii)'
  union all
  select 33, 'finalized_proforma_tax_numbered',
         case when (select count(*) from public.invoices where kind = 'proforma' and document_status = 'finalized') = 0 then 'OK' else 'WARN' end,
         'finalizované proformy z čias pred oddelenou sériou PF (nemenné; nahlásiť účtovníčke, nie sú daňový doklad): ' ||
         (select count(*)::text from public.invoices where kind = 'proforma' and document_status = 'finalized')
  union all
  select 34, 'received_invoices_overview',
         'INFO',
         (select format('prijaté: %s (koncepty %s, finalizované %s); bez dodávateľa %s; bez čísla dodávateľa %s',
                        count(*), count(*) filter (where document_status = 'draft'), count(*) filter (where document_status = 'finalized'),
                        count(*) filter (where supplier_business_partner_id is null), count(*) filter (where coalesce(btrim(supplier_invoice_number), '') = ''))
          from public.invoices where direction = 'received')
  union all
  select 35, 'payment_received_invoices_overview',
         'INFO',
         'faktúry k prijatej platbe (kind=payment_received_invoice) — existujúce sa nemenia; odpočty záloh vznikajú iba v novom modeli: ' ||
         (select count(*)::text from public.invoices where kind = 'payment_received_invoice')
  union all
  select 36, 'drafts_with_items_breaking_new_checks',
         case when (select count(*) from public.invoice_items it join public.invoices i on i.id = it.invoice_id
                    where i.document_status = 'draft' and it.unit_price < 0) = 0 then 'OK' else 'STOP' end,
         'koncepty so zápornou cenou (nový CHECK unit_price_sign_check): ' ||
         (select count(*)::text from public.invoice_items it join public.invoices i on i.id = it.invoice_id
          where i.document_status = 'draft' and it.unit_price < 0)
) r
order by ord;

-- B) DETAIL pri STOP/WARN (odkomentovať potrebný dotaz; vracia iba uuid a kódy) ----------------
-- select id, company_id, kind, direction from public.invoices
--   where kind not in ('regular_invoice','payment_received_invoice','credit_note','debit_note','proforma')
--      or payment_status not in ('unpaid','partially_paid','paid','overpaid')
--      or (kind in ('credit_note','debit_note')) <> (corrects_invoice_id is not null)
--      or (kind = 'proforma' and direction <> 'issued');
-- select invoice_id, vat_category_code from public.invoice_items where vat_category_code not in ('S','Z','E','AE','K','G','O');
-- select p.proname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in
--   ('esblu_add_invoice_payment','esblu_create_received_invoice_draft','esblu_finalize_invoice','esblu_save_invoice_draft','esblu_remove_invoice_payment');
-- select pg_get_functiondef('public.esblu_my_finance_manage()'::regprocedure), pg_get_functiondef('public.esblu_my_finance_view()'::regprocedure);  -- uložiť pre rollback 100002

rollback;
