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
-- Overené na stagingu (syntax a sémantika, read-only) 7. 10. 2026.
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
