-- =============================================================================
-- 20261008100005 — dokončenie účtovného toku po právno-účtovnom audite.
--
-- (1) PRIJATÉ OPRAVNÉ DOKLADY cez Peppol (CreditNote 381/81/83 → dobropis, Invoice 383 → ťarchopis):
--     * koncept prijatej opravy vzniká VŽDY v stave review (correction_review_status = 'review');
--       účtovne platným sa stane až finalizáciou používateľom s finance.manage („prijať“), alebo
--       ho používateľ zamietne (rejected). Nič sa neaplikuje automaticky.
--     * väzba na originál: BT-25 (+ BT-26) → iba prijatá faktúra TEJ ISTEJ firmy, TOHO ISTÉHO
--       dodávateľa, druh regular_invoice / payment_received_invoice; jednoznačná zhoda → prepojí,
--       inak koncept bez väzby + dôvod (ORIGINAL_REFERENCE_MISSING / ORIGINAL_NOT_FOUND / ORIGINAL_AMBIGUOUS).
--     * DB guard na KAŽDÚ väzbu corrects_invoice_id (vydané aj prijaté): rovnaká firma, rovnaký smer,
--       pri prijatých rovnaký dodávateľ, cieľ nie je proforma ani iný opravný doklad.
--     * replay/duplicita: SHA-256 XML (už v create_draft), transport ID poskytovateľa a
--       (dodávateľ, druh, číslo) → nikdy druhá oprava.
-- (2) ÚHRADY: vrátenie platby (entry_type = 'refund'), stav 'overpaid', saldo celej skupiny
--     (originál + finalizované dobropisy/ťarchopisy + odpočty záloh) → payment_status sa prepočíta
--     pri úhrade, vrátení, finalizácii opravy aj konečnej faktúry. Platba nikdy nemení obsah dokladu.
--     Úhrada na proformu sa neeviduje (eviduje sa na faktúre k prijatej platbe).
-- (3) ZÁLOHY: zoznam dostupných záloh s zostatkom (esblu_available_advances), zámok záloh pri
--     finalizácii konečnej faktúry (súbežný dvojitý odpočet), DPH zálohy nesmie prekročiť zálohu,
--     odpočty spolu nesmú prekročiť sumu konečnej faktúry.
-- Rollback: supabase/rollback/20261008100005_invoicing_corrections_payments_advances_rollback.sql
-- =============================================================================

-- 0) Nové typy udalostí (aditívne, bez straty existujúcich) --------------------------------------
do $migration$
declare
  v_con record; v_found integer := 0; v_conname text; v_existing text[]; v_all text[]; v_type text; v_after text;
begin
  for v_con in
    select c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c
    where c.conrelid = 'public.invoice_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%event_type%'
  loop
    v_found := v_found + 1;
    v_conname := v_con.conname;
    select coalesce(array_agg(x.m[1] order by x.ord), array[]::text[]) into v_existing
    from regexp_matches(v_con.def, '''([^'']+)''', 'g') with ordinality as x(m, ord);
  end loop;
  if v_found <> 1 or cardinality(v_existing) = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_MIGRATION_INVOICE_EVENTS_CHECK_UNEXPECTED:' || v_found::text;
  end if;
  v_all := v_existing;
  foreach v_type in array array['correction_reviewed', 'payment_refunded'] loop
    if not (v_type = any (v_all)) then v_all := v_all || v_type; end if;
  end loop;
  execute format('alter table public.invoice_events drop constraint %I', v_conname);
  execute format('alter table public.invoice_events add constraint invoice_events_event_type_check check (event_type in (%s))',
    (select string_agg(quote_literal(t.v), ', ' order by t.ord) from unnest(v_all) with ordinality as t(v, ord)));
  select pg_get_constraintdef(c.oid) into v_after from pg_constraint c
  where c.conrelid = 'public.invoice_events'::regclass and c.conname = 'invoice_events_event_type_check';
  foreach v_type in array v_existing loop
    if position('''' || v_type || '''' in v_after) = 0 then
      raise exception using errcode = 'P0001', message = 'ESBLU_MIGRATION_INVOICE_EVENTS_TYPE_LOST:' || v_type;
    end if;
  end loop;
end
$migration$;

-- 1) Stĺpce a obmedzenia opráv ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists corrected_document_reference text,
  add column if not exists corrected_document_issue_date date,
  add column if not exists correction_review_status text,
  add column if not exists correction_review_reasons text[],
  add column if not exists correction_review_note text,
  add column if not exists correction_reviewed_at timestamptz,
  add column if not exists correction_reviewed_by uuid;
alter table public.invoices drop constraint if exists invoices_corrected_reference_check;
alter table public.invoices add constraint invoices_corrected_reference_check
  check (corrected_document_reference is null or char_length(corrected_document_reference) between 1 and 200);
alter table public.invoices drop constraint if exists invoices_correction_review_status_check;
alter table public.invoices add constraint invoices_correction_review_status_check
  check (correction_review_status is null
         or (correction_review_status in ('review', 'accepted', 'rejected') and direction = 'received' and kind in ('credit_note', 'debit_note')));
alter table public.invoices drop constraint if exists invoices_correction_review_reasons_check;
alter table public.invoices add constraint invoices_correction_review_reasons_check
  check (correction_review_reasons is null or (cardinality(correction_review_reasons) <= 20
         and (cardinality(correction_review_reasons) = 0 or array_to_string(correction_review_reasons, ',') ~ '^[A-Z0-9_]{1,60}(,[A-Z0-9_]{1,60})*$')));
alter table public.invoices drop constraint if exists invoices_correction_review_note_check;
alter table public.invoices add constraint invoices_correction_review_note_check
  check (correction_review_note is null or char_length(correction_review_note) between 3 and 500);
-- Prijatá oprava môže byť KONCEPT bez nájdeného originálu; finalizovaná oprava ho musí mať vždy.
alter table public.invoices drop constraint if exists invoices_corrects_required_for_notes;
alter table public.invoices add constraint invoices_corrects_required_for_notes check (
  ((kind in ('credit_note', 'debit_note')) = (corrects_invoice_id is not null))
  or (kind in ('credit_note', 'debit_note') and corrects_invoice_id is null and direction = 'received' and document_status = 'draft')
);

-- 2) Guard každej väzby na opravovaný doklad --------------------------------------------------------
create or replace function public.esblu_invoice_correction_link_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_t record;
begin
  if new.corrects_invoice_id is null then
    return new;
  end if;
  select t.company_id, t.direction, t.kind, t.supplier_business_partner_id into v_t
  from public.invoices t where t.id = new.corrects_invoice_id;
  -- Iná firma = „neexistuje“ (žiadny únik existencie cudzieho dokladu).
  if v_t.company_id is null or v_t.company_id <> new.company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTED_INVOICE_NOT_FOUND';
  end if;
  if v_t.kind = 'proforma' then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_OF_PROFORMA',
      hint = 'Proforma nie je daňový doklad — neopravuje sa dobropisom ani ťarchopisom.';
  end if;
  if v_t.kind in ('credit_note', 'debit_note') then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_TARGET_INVALID',
      hint = 'Opravný doklad sa viaže na pôvodnú faktúru, nie na iný opravný doklad.';
  end if;
  if v_t.direction <> new.direction then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTED_INVOICE_DIRECTION_MISMATCH';
  end if;
  if new.direction = 'received' and v_t.supplier_business_partner_id is distinct from new.supplier_business_partner_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_SUPPLIER_MISMATCH',
      hint = 'Prijatá oprava musí byť od toho istého dodávateľa ako pôvodná faktúra.';
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_invoice_correction_link_guard() from public, anon, authenticated;
drop trigger if exists esblu_invoice_correction_link_guard on public.invoices;
create trigger esblu_invoice_correction_link_guard
  before insert or update of corrects_invoice_id, supplier_business_partner_id, company_id, direction on public.invoices
  for each row execute function public.esblu_invoice_correction_link_guard();

-- 3) Dodávateľ z XML (spoločné pre faktúry aj opravy) — rovnaká logika ako 20261006100000 --------------
create or replace function public.esblu_einvoice_resolve_supplier(p_company_id uuid, p_supplier jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_ico text := nullif(btrim(coalesce(p_supplier ->> 'ico', '')), '');
  v_vat text := nullif(upper(regexp_replace(coalesce(p_supplier ->> 'vat_id', ''), '[\s.\-/]', '', 'g')), '');
  v_dic text := nullif(btrim(coalesce(p_supplier ->> 'dic', '')), '');
  v_endpoint text := nullif(btrim(coalesce(p_supplier ->> 'endpoint_id', '')), '');
  v_endpoint_scheme text := nullif(btrim(coalesce(p_supplier ->> 'endpoint_scheme', '')), '');
  v_name text := nullif(btrim(coalesce(p_supplier ->> 'legal_name', '')), '');
  v_country text := nullif(upper(btrim(coalesce(p_supplier ->> 'country_code', ''))), '');
  v_partner uuid;
begin
  if v_ico is not null and v_ico !~ '^[0-9]{8}$' then v_ico := null; end if;
  if v_endpoint is not null and (v_endpoint_scheme is null or v_endpoint_scheme !~ '^[0-9]{4}$') then v_endpoint := null; end if;
  if v_dic is not null and (v_dic !~ '^[0-9]{10}$' or coalesce(v_country, 'SK') <> 'SK') then v_dic := null; end if;
  if (v_ico is null and v_vat is null and v_endpoint is null) or v_name is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_SUPPLIER_UNIDENTIFIED';
  end if;
  if v_ico is not null then
    select bp.id into v_partner from public.business_partners bp where bp.company_id = p_company_id and bp.ico = v_ico limit 1;
  end if;
  if v_partner is null and v_vat is not null then
    select bp.id into v_partner from public.business_partners bp
    where bp.company_id = p_company_id
      and (upper(regexp_replace(coalesce(bp.ic_dph, ''), '[\s.\-/]', '', 'g')) = v_vat
           or upper(regexp_replace(coalesce(bp.vat_identifier, ''), '[\s.\-/]', '', 'g')) = v_vat)
    order by bp.created_at limit 1;
  end if;
  if v_partner is null and v_dic is not null then
    select bp.id into v_partner from public.business_partners bp where bp.company_id = p_company_id and bp.dic = v_dic order by bp.created_at limit 1;
  end if;
  if v_partner is null and v_endpoint is not null then
    select bp.id into v_partner from public.business_partners bp
    where bp.company_id = p_company_id and bp.electronic_address = v_endpoint and bp.electronic_address_scheme_id = v_endpoint_scheme
    order by bp.created_at limit 1;
  end if;
  if v_partner is null then
    insert into public.business_partners (
      company_id, kind, legal_name, ico, dic, ic_dph, vat_identifier,
      address_line1, address_line2, city, postal_code, country_code, electronic_address, electronic_address_scheme_id
    ) values (
      p_company_id, 'supplier', left(v_name, 300), v_ico, v_dic,
      case when v_vat ~ '^SK[0-9]{10}$' then v_vat end,
      case when v_vat is not null and v_vat !~ '^SK[0-9]{10}$' then v_vat end,
      nullif(btrim(coalesce(p_supplier ->> 'address_line1', '')), ''),
      nullif(btrim(coalesce(p_supplier ->> 'address_line2', '')), ''),
      nullif(btrim(coalesce(p_supplier ->> 'city', '')), ''),
      nullif(btrim(coalesce(p_supplier ->> 'postal_code', '')), ''),
      case when v_country ~ '^[A-Z]{2}$' then v_country end,
      case when v_endpoint_scheme is not null then v_endpoint end,
      case when v_endpoint is not null then v_endpoint_scheme end
    )
    on conflict do nothing
    returning id into v_partner;
    if v_partner is null then
      select bp.id into v_partner from public.business_partners bp where bp.company_id = p_company_id and bp.ico = v_ico limit 1;
    end if;
  end if;
  return v_partner;
end;
$function$;
revoke all on function public.esblu_einvoice_resolve_supplier(uuid, jsonb) from public, anon, authenticated;

-- 4) Prijatá oprava z XML → koncept v stave review ---------------------------------------------------
create or replace function public.esblu_einvoice_inbound_create_correction(p_inbound_id uuid, p_draft jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_in public.einvoice_inbound;
  v_kind text := p_draft ->> 'document_kind';
  v_corr jsonb := coalesce(p_draft -> 'correction', '{}'::jsonb);
  v_ref text := nullif(btrim(coalesce(v_corr ->> 'original_number', '')), '');
  v_ref_date date;
  v_reason text := nullif(btrim(coalesce(v_corr ->> 'reason', '')), '');
  v_partner uuid;
  v_number text := btrim(coalesce(p_draft ->> 'invoice_number', ''));
  v_norm text;
  v_existing uuid;
  v_orig uuid;
  v_orig_status text;
  v_matches integer := 0;
  v_reasons text[] := array[]::text[];
  v_invoice_id uuid;
  v_item jsonb;
  v_position integer := 0;
  v_description text; v_quantity numeric(18, 6); v_unit_price numeric(18, 6);
  v_cat text; v_rate numeric(7, 4); v_line_net numeric(18, 2); v_line_vat numeric(18, 2);
  v_totals jsonb;
begin
  if v_kind not in ('credit_note', 'debit_note') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_CORRECTION_KIND_INVALID';
  end if;
  select * into v_in from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if v_in.id is null or v_in.processing_status <> 'parsed' or v_in.xml_sha256 is null or v_in.xml_storage_path is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_STATE';
  end if;
  if v_number = '' then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER';
  end if;
  if (v_corr ->> 'original_issue_date') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_ref_date := (v_corr ->> 'original_issue_date')::date;
  end if;
  if v_reason is not null and char_length(v_reason) not between 3 and 500 then
    v_reason := case when char_length(v_reason) > 500 then left(v_reason, 500) else null end;
  end if;

  perform set_config('esblu.einvoice_event_source', 'job', true);
  v_partner := public.esblu_einvoice_resolve_supplier(v_in.company_id, coalesce(p_draft -> 'supplier', '{}'::jsonb));

  -- Replay / duplicita: transport ID poskytovateľa alebo rovnaký (dodávateľ, druh, číslo) v RÁMCI FIRMY.
  select i.id into v_existing from public.invoices i
  where i.company_id = v_in.company_id and i.transport_provider = v_in.provider and i.transport_message_id = v_in.provider_received_id
  limit 1;
  v_norm := upper(regexp_replace(v_number, '[\s\-/]', '', 'g'));
  if v_existing is null then
    select i.id into v_existing from public.invoices i
    where i.company_id = v_in.company_id and i.direction = 'received' and i.kind = v_kind
      and i.supplier_business_partner_id = v_partner
      and upper(regexp_replace(coalesce(i.supplier_invoice_number, ''), '[\s\-/]', '', 'g')) = v_norm
    order by i.created_at limit 1;
  end if;
  if v_existing is not null then
    update public.einvoice_inbound i
    set processing_status = 'duplicate', invoice_id = v_existing, dedupe_matched_on = 'correction_identity',
        last_error_code = null, next_retry_at = now() + interval '2 minutes'
    where i.id = v_in.id;
    perform set_config('esblu.einvoice_event_source', '', true);
    return jsonb_build_object('status', 'duplicate', 'invoice_id', v_existing, 'matched_on', 'correction_identity');
  end if;

  -- Originál: iba tá istá firma + ten istý dodávateľ + jednoznačné číslo (a dátum, ak je v XML).
  if v_ref is null then
    v_reasons := array_append(v_reasons, 'ORIGINAL_REFERENCE_MISSING');
  else
    select count(*), min(i.id::text)::uuid into v_matches, v_orig
    from public.invoices i
    where i.company_id = v_in.company_id and i.direction = 'received'
      and i.kind in ('regular_invoice', 'payment_received_invoice')
      and i.supplier_business_partner_id = v_partner
      and upper(regexp_replace(coalesce(i.supplier_invoice_number, ''), '[\s\-/]', '', 'g')) = upper(regexp_replace(v_ref, '[\s\-/]', '', 'g'))
      and (v_ref_date is null or i.issue_date = v_ref_date);
    if v_matches = 0 then
      v_orig := null; v_reasons := array_append(v_reasons, 'ORIGINAL_NOT_FOUND');
    elsif v_matches > 1 then
      v_orig := null; v_reasons := array_append(v_reasons, 'ORIGINAL_AMBIGUOUS');
    else
      select i.document_status into v_orig_status from public.invoices i where i.id = v_orig;
      if v_orig_status <> 'finalized' then v_reasons := array_append(v_reasons, 'ORIGINAL_NOT_FINALIZED'); end if;
    end if;
  end if;
  if v_reason is null then v_reasons := array_append(v_reasons, 'CORRECTION_REASON_MISSING'); end if;
  if coalesce(v_corr ->> 'type_review', '') = 'true' then v_reasons := array_append(v_reasons, 'CORRECTION_TYPE_REVIEW'); end if;

  if p_draft -> 'items' is null or jsonb_typeof(p_draft -> 'items') <> 'array' or jsonb_array_length(p_draft -> 'items') = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NO_ITEMS';
  end if;

  insert into public.invoices (
    company_id, direction, kind, document_status, issue_date, due_date, delivery_date,
    currency, iban, payment_reference, buyer_reference, purchase_order_reference,
    supplier_business_partner_id, supplier_invoice_number, received_at, source,
    transport_provider, transport_message_id,
    corrects_invoice_id, corrected_document_reference, corrected_document_issue_date, correction_reason,
    correction_review_status, correction_review_reasons
  ) values (
    v_in.company_id, 'received', v_kind, 'draft',
    (p_draft ->> 'issue_date')::date, nullif(p_draft ->> 'due_date', '')::date, nullif(p_draft ->> 'delivery_date', '')::date,
    coalesce(nullif(btrim(coalesce(p_draft ->> 'currency', '')), ''), 'EUR'),
    nullif(btrim(coalesce(p_draft ->> 'iban', '')), ''), nullif(btrim(coalesce(p_draft ->> 'payment_reference', '')), ''),
    nullif(btrim(coalesce(p_draft ->> 'buyer_reference', '')), ''), nullif(btrim(coalesce(p_draft ->> 'purchase_order_reference', '')), ''),
    v_partner, v_number, (v_in.received_at at time zone 'UTC')::date, 'efaktura_peppol',
    v_in.provider, v_in.provider_received_id,
    v_orig, left(v_ref, 200), v_ref_date, v_reason,
    'review', v_reasons
  ) returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_draft -> 'items') loop
    v_position := v_position + 1;
    v_description := btrim(coalesce(v_item ->> 'description', ''));
    begin
      v_quantity := (v_item ->> 'quantity')::numeric;
      v_unit_price := (v_item ->> 'unit_price')::numeric;
    exception when others then
      raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ITEM';
    end;
    v_cat := coalesce(v_item ->> 'vat_category_code', '');
    if v_description = '' or v_quantity is null or v_quantity <= 0 or v_unit_price is null or v_unit_price < 0
       or not (v_cat = any (array['S', 'Z', 'E', 'AE', 'K', 'G', 'O'])) then
      raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ITEM', hint = 'Položka č. ' || v_position;
    end if;
    if v_cat = 'S' then
      v_rate := (v_item ->> 'vat_rate')::numeric;
      if v_rate is null or v_rate < 0 then raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_S_VAT_RATE'; end if;
    else
      v_rate := 0;
    end if;
    v_line_net := round(v_quantity * v_unit_price, 2);
    v_line_vat := case when v_cat = 'S' then round(v_line_net * v_rate / 100, 2) else 0 end;
    insert into public.invoice_items (invoice_id, position, description, quantity, unit, unit_code, unit_price,
      vat_category_code, vat_rate, line_net_amount, line_vat_amount, line_gross_amount)
    values (v_invoice_id, v_position, left(v_description, 500), v_quantity, 'ks', nullif(btrim(coalesce(v_item ->> 'unit_code', '')), ''),
      v_unit_price, v_cat, v_rate, v_line_net, v_line_vat, v_line_net + v_line_vat);
  end loop;

  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (v_invoice_id, 'created', null, 'system',
    jsonb_build_object('direction', 'received', 'source', 'efaktura_peppol', 'kind', v_kind, 'supplier_invoice_number', v_number,
      'corrected_document_reference', v_ref, 'linked_original', v_orig is not null, 'review_reasons', to_jsonb(v_reasons)));

  v_totals := public.esblu_einvoice_apply_xml_totals(v_invoice_id, p_draft -> 'totals', p_draft ->> 'payment_means_code');
  update public.einvoice_inbound i
  set processing_status = 'draft_created', invoice_id = v_invoice_id, draft_created_at = now(), xml_totals = v_totals,
      last_error_code = null, next_retry_at = now() + interval '2 minutes'
  where i.id = v_in.id;
  perform set_config('esblu.einvoice_event_source', '', true);
  return jsonb_build_object('status', 'created', 'invoice_id', v_invoice_id, 'kind', v_kind,
    'original_linked', v_orig is not null, 'review_reasons', to_jsonb(v_reasons));
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_create_correction(uuid, jsonb) from public, anon, authenticated;

-- 5) create_draft: opravy idú do review toku; faktúry bez zmeny správania (dodávateľ cez resolver) --------
create or replace function public.esblu_einvoice_inbound_create_draft(p_inbound_id uuid, p_draft jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_in public.einvoice_inbound;
  v_dup record;
  v_partner uuid;
  v_result jsonb;
  v_status text;
  v_totals jsonb;
begin
  select * into v_in from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if v_in.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_NOT_FOUND';
  end if;
  if v_in.processing_status <> 'parsed' or v_in.xml_sha256 is null or v_in.xml_storage_path is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_STATE';
  end if;
  if p_draft is null or jsonb_typeof(p_draft -> 'totals') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_REQUIRED';
  end if;

  perform set_config('esblu.einvoice_event_source', 'job', true);

  -- Dedupe 1: rovnaké XML (SHA-256) už vo FIRME spracované → prepojiť existujúci koncept (aj pri opravách).
  select i.id, i.invoice_id into v_dup
  from public.einvoice_inbound i
  where i.company_id = v_in.company_id and i.xml_sha256 = v_in.xml_sha256
    and i.id <> v_in.id and i.invoice_id is not null
  order by i.received_at
  limit 1;
  if v_dup.id is not null then
    update public.einvoice_inbound i
    set processing_status = 'duplicate', invoice_id = v_dup.invoice_id, dedupe_matched_on = 'xml_sha256',
        last_error_code = null, next_retry_at = now() + interval '2 minutes'
    where i.id = v_in.id;
    perform set_config('esblu.einvoice_event_source', '', true);
    return jsonb_build_object('status', 'duplicate', 'invoice_id', v_dup.invoice_id, 'matched_on', 'xml_sha256');
  end if;

  if coalesce(p_draft ->> 'document_kind', 'regular_invoice') in ('credit_note', 'debit_note') then
    perform set_config('esblu.einvoice_event_source', '', true);
    return public.esblu_einvoice_inbound_create_correction(p_inbound_id, p_draft);
  end if;

  v_partner := public.esblu_einvoice_resolve_supplier(v_in.company_id, coalesce(p_draft -> 'supplier', '{}'::jsonb));

  v_result := public.esblu_received_invoice_draft_core(
    v_in.company_id, null, 'efaktura_peppol', v_in.provider, v_in.provider_received_id,
    v_partner,
    p_draft ->> 'invoice_number',
    nullif(p_draft ->> 'issue_date', '')::date,
    p_draft -> 'items',
    nullif(p_draft ->> 'due_date', '')::date,
    nullif(p_draft ->> 'delivery_date', '')::date,
    null,
    p_draft ->> 'currency',
    p_draft ->> 'iban',
    p_draft ->> 'bic',
    p_draft ->> 'payment_reference',
    null,
    p_draft ->> 'buyer_reference',
    p_draft ->> 'purchase_order_reference',
    (v_in.received_at at time zone 'UTC')::date,
    null,
    null
  );

  v_status := case when v_result ->> 'status' = 'created' then 'draft_created' else 'duplicate' end;
  if v_status = 'draft_created' then
    v_totals := public.esblu_einvoice_apply_xml_totals((v_result ->> 'invoice_id')::uuid, p_draft -> 'totals', p_draft ->> 'payment_means_code');
  end if;

  update public.einvoice_inbound i
  set processing_status = v_status,
      invoice_id = coalesce((v_result ->> 'invoice_id')::uuid, (v_result ->> 'existing_invoice_id')::uuid),
      dedupe_matched_on = case when v_status = 'duplicate' then v_result ->> 'matched_on' end,
      draft_created_at = case when v_status = 'draft_created' then now() else i.draft_created_at end,
      xml_totals = case when v_status = 'draft_created' then v_totals else i.xml_totals end,
      last_error_code = null,
      next_retry_at = now() + interval '2 minutes'
  where i.id = v_in.id;
  perform set_config('esblu.einvoice_event_source', '', true);

  return jsonb_build_object(
    'status', case when v_status = 'draft_created' then 'created' else 'duplicate' end,
    'invoice_id', coalesce(v_result ->> 'invoice_id', v_result ->> 'existing_invoice_id'),
    'matched_on', v_result ->> 'matched_on'
  );
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) to service_role;

-- 6) Prijatie (finalizácia) prijatej opravy ----------------------------------------------------------
create or replace function public.esblu_received_correction_accept()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_orig public.invoices%rowtype;
  v_credited numeric(18, 2);
  v_debited numeric(18, 2);
begin
  if new.correction_review_status = 'rejected' then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_REJECTED',
      hint = 'Zamietnutý opravný doklad sa nedá prijať.';
  end if;
  if new.corrects_invoice_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_ORIGINAL_REQUIRED',
      hint = 'Najprv priraďte pôvodnú faktúru toho istého dodávateľa.';
  end if;
  if new.correction_reason is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_REASON_REQUIRED';
  end if;
  select * into v_orig from public.invoices o where o.id = new.corrects_invoice_id;
  if v_orig.currency <> new.currency then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_CURRENCY_MISMATCH';
  end if;
  if new.kind = 'credit_note' then
    select coalesce(sum(c.total_amount), 0) into v_credited from public.invoices c
     where c.corrects_invoice_id = v_orig.id and c.kind = 'credit_note' and c.document_status = 'finalized' and c.id <> new.id;
    select coalesce(sum(d.total_amount), 0) into v_debited from public.invoices d
     where d.corrects_invoice_id = v_orig.id and d.kind = 'debit_note' and d.document_status = 'finalized';
    if v_credited + new.total_amount > v_orig.total_amount + v_debited then
      raise exception using errcode = 'P0001', message = 'ESBLU_CREDIT_EXCEEDS_ORIGINAL';
    end if;
  end if;
  new.correction_review_status := 'accepted';
  new.correction_reviewed_at := now();
  new.correction_reviewed_by := auth.uid();
  return new;
end;
$function$;
revoke execute on function public.esblu_received_correction_accept() from public, anon, authenticated;
drop trigger if exists esblu_received_correction_accept on public.invoices;
create trigger esblu_received_correction_accept
  before update of document_status on public.invoices
  for each row
  when (old.document_status = 'draft' and new.document_status = 'finalized' and new.direction = 'received'
        and new.kind in ('credit_note', 'debit_note'))
  execute function public.esblu_received_correction_accept();

-- 7) Review akcie používateľa (finance.manage, aktívna firma, iba koncept prijatej opravy) ----------------
create or replace function public.esblu_received_correction_link(p_invoice_id uuid, p_original_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
begin
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if v_inv.id is null or v_inv.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv.document_status <> 'draft' or v_inv.direction <> 'received' or v_inv.kind not in ('credit_note', 'debit_note')
     or v_inv.correction_review_status is distinct from 'review' then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_NOT_IN_REVIEW';
  end if;
  -- Guard (esblu_invoice_correction_link_guard) vynúti firmu, smer, dodávateľa a druh cieľa.
  update public.invoices i
  set corrects_invoice_id = p_original_id,
      correction_review_reasons = array(select r from unnest(coalesce(i.correction_review_reasons, array[]::text[])) r
                                        where r not in ('ORIGINAL_REFERENCE_MISSING', 'ORIGINAL_NOT_FOUND', 'ORIGINAL_AMBIGUOUS')),
      updated_at = now(), updated_by = auth.uid()
  where i.id = p_invoice_id;
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'correction_reviewed', auth.uid(), 'user', jsonb_build_object('action', 'linked', 'original_invoice_id', p_original_id));
end;
$function$;
revoke all on function public.esblu_received_correction_link(uuid, uuid) from public, anon;
grant execute on function public.esblu_received_correction_link(uuid, uuid) to authenticated;

create or replace function public.esblu_received_correction_reject(p_invoice_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  if v_note is null or char_length(v_note) not between 3 and 500 then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_REVIEW_NOTE_REQUIRED';
  end if;
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if v_inv.id is null or v_inv.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv.document_status <> 'draft' or v_inv.correction_review_status is distinct from 'review' then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_NOT_IN_REVIEW';
  end if;
  update public.invoices i
  set correction_review_status = 'rejected', correction_review_note = v_note,
      correction_reviewed_at = now(), correction_reviewed_by = auth.uid(), updated_at = now(), updated_by = auth.uid()
  where i.id = p_invoice_id;
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'correction_reviewed', auth.uid(), 'user', jsonb_build_object('action', 'rejected'));
end;
$function$;
revoke all on function public.esblu_received_correction_reject(uuid, text) from public, anon;
grant execute on function public.esblu_received_correction_reject(uuid, text) to authenticated;

-- Polia review nesmie meniť klient priamo (iba RPC a triggre).
create or replace function public.esblu_block_client_correction_review_change()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.correction_review_status is not null or new.correction_review_reasons is not null or new.correction_reviewed_at is not null
       or new.correction_reviewed_by is not null or new.corrected_document_reference is not null or new.corrected_document_issue_date is not null then
      raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_REVIEW_FIELDS_PROTECTED';
    end if;
  elsif new.correction_review_status is distinct from old.correction_review_status
     or new.correction_review_reasons is distinct from old.correction_review_reasons
     or new.correction_reviewed_at is distinct from old.correction_reviewed_at
     or new.correction_reviewed_by is distinct from old.correction_reviewed_by
     or new.corrected_document_reference is distinct from old.corrected_document_reference
     or new.corrected_document_issue_date is distinct from old.corrected_document_issue_date
     -- Väzbu prijatej opravy z review mení iba RPC esblu_received_correction_link.
     or (old.correction_review_status is not null and new.corrects_invoice_id is distinct from old.corrects_invoice_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_REVIEW_FIELDS_PROTECTED';
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_block_client_correction_review_change() from public, anon, authenticated;
drop trigger if exists esblu_block_client_correction_review_change on public.invoices;
create trigger esblu_block_client_correction_review_change before insert or update on public.invoices
  for each row execute function public.esblu_block_client_correction_review_change();

-- 8) Úhrady: vrátenie, preplatok, saldo skupiny -------------------------------------------------------
alter table public.invoice_payments add column if not exists entry_type text not null default 'payment';
alter table public.invoice_payments drop constraint if exists invoice_payments_entry_type_check;
alter table public.invoice_payments add constraint invoice_payments_entry_type_check check (entry_type in ('payment', 'refund'));
alter table public.invoices drop constraint if exists invoices_payment_status_check;
alter table public.invoices add constraint invoices_payment_status_check
  check (payment_status in ('unpaid', 'partially_paid', 'paid', 'overpaid'));

create or replace function public.esblu_invoice_settlement_core(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
  v_root public.invoices%rowtype;
  v_prepaid numeric(18, 2);
  v_credits numeric(18, 2);
  v_debits numeric(18, 2);
  v_paid numeric(18, 2);
  v_refunded numeric(18, 2);
  v_due numeric(18, 2);
  v_balance numeric(18, 2);
  v_status text;
begin
  select * into v_inv from public.invoices i where i.id = p_invoice_id;
  if v_inv.id is null then return null; end if;
  if v_inv.kind in ('credit_note', 'debit_note') and v_inv.corrects_invoice_id is not null then
    select * into v_root from public.invoices i where i.id = v_inv.corrects_invoice_id;
  else
    v_root := v_inv;
  end if;
  select coalesce(sum(d.taxable_amount + d.vat_amount), 0) into v_prepaid from public.invoice_advance_deductions d where d.invoice_id = v_root.id;
  select coalesce(sum(c.total_amount) filter (where c.kind = 'credit_note'), 0), coalesce(sum(c.total_amount) filter (where c.kind = 'debit_note'), 0)
    into v_credits, v_debits
  from public.invoices c where c.corrects_invoice_id = v_root.id and c.document_status = 'finalized';
  select coalesce(sum(p.paid_amount) filter (where p.entry_type = 'payment'), 0), coalesce(sum(p.paid_amount) filter (where p.entry_type = 'refund'), 0)
    into v_paid, v_refunded
  from public.invoice_payments p
  where p.invoice_id = v_root.id
     or p.invoice_id in (select c.id from public.invoices c where c.corrects_invoice_id = v_root.id and c.document_status = 'finalized');
  v_due := v_root.total_amount - v_prepaid + v_debits - v_credits;
  v_balance := v_due - (v_paid - v_refunded);
  v_status := case
    when v_balance < 0 then 'overpaid'
    when v_balance = 0 then 'paid'
    when v_paid - v_refunded > 0 then 'partially_paid'
    else 'unpaid' end;
  return jsonb_build_object(
    'root_invoice_id', v_root.id, 'currency', v_root.currency,
    'original_total', v_root.total_amount, 'advances_deducted', v_prepaid,
    'credit_notes_total', v_credits, 'debit_notes_total', v_debits,
    'amount_due', v_due, 'paid', v_paid, 'refunded', v_refunded,
    'balance', v_balance, 'payment_status', v_status);
end;
$function$;
revoke all on function public.esblu_invoice_settlement_core(uuid) from public, anon, authenticated;

-- Pre UI: iba finance.view v aktívnej firme.
create or replace function public.esblu_invoice_settlement(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.esblu_my_finance_view() or not exists (
       select 1 from public.invoices i where i.id = p_invoice_id and i.company_id = public.esblu_my_active_company_id()) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  return public.esblu_invoice_settlement_core(p_invoice_id);
end;
$function$;
revoke all on function public.esblu_invoice_settlement(uuid) from public, anon;
grant execute on function public.esblu_invoice_settlement(uuid) to authenticated;

-- Prepočet stavu úhrady celej skupiny (originál + finalizované opravy). Mení IBA payment_status.
create or replace function public.esblu_recalc_invoice_group_status(p_invoice_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_s jsonb := public.esblu_invoice_settlement_core(p_invoice_id);
  v_root uuid;
  v_status text;
begin
  if v_s is null then return null; end if;
  v_root := (v_s ->> 'root_invoice_id')::uuid;
  v_status := v_s ->> 'payment_status';
  update public.invoices i set payment_status = v_status, updated_at = now()
  where (i.id = v_root or (i.corrects_invoice_id = v_root and i.document_status = 'finalized'))
    and i.document_status = 'finalized' and i.payment_status is distinct from v_status;
  return v_status;
end;
$function$;
revoke all on function public.esblu_recalc_invoice_group_status(uuid) from public, anon, authenticated;

create or replace function public.esblu_add_invoice_payment(p_invoice_id uuid, p_paid_amount numeric, p_paid_at date default current_date, p_payment_method text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_inv record;
  v_payment_id uuid;
  v_status text;
begin
  if p_invoice_id is null or p_paid_amount is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ARGUMENT';
  end if;
  if p_paid_amount <= 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_PAID_AMOUNT';
  end if;
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select i.company_id, i.document_status into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if v_inv.company_id is null or v_inv.company_id <> v_company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv.document_status <> 'finalized' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FINALIZED', hint = 'Platby sa evidujú iba k finalizovanej faktúre.';
  end if;
  insert into public.invoice_payments (invoice_id, paid_amount, paid_at, payment_method, note, recorded_by, entry_type)
  values (p_invoice_id, p_paid_amount, coalesce(p_paid_at, current_date), p_payment_method, p_note, auth.uid(), 'payment')
  returning id into v_payment_id;
  v_status := public.esblu_recalc_invoice_group_status(p_invoice_id);
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'payment_recorded', auth.uid(), 'user',
    jsonb_build_object('payment_id', v_payment_id, 'paid_amount', p_paid_amount, 'new_payment_status', v_status));
  return jsonb_build_object('payment_id', v_payment_id, 'payment_status', v_status,
    'total_paid', (public.esblu_invoice_settlement_core(p_invoice_id) ->> 'paid')::numeric);
end;
$function$;
revoke execute on function public.esblu_add_invoice_payment(uuid, numeric, date, text, text) from public, anon;
grant execute on function public.esblu_add_invoice_payment(uuid, numeric, date, text, text) to authenticated;

create or replace function public.esblu_add_invoice_refund(p_invoice_id uuid, p_amount numeric, p_refunded_at date default current_date, p_payment_method text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid := public.esblu_my_active_company_id();
  v_inv record;
  v_net numeric(18, 2);
  v_id uuid;
  v_status text;
begin
  if p_invoice_id is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_PAID_AMOUNT';
  end if;
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select i.company_id, i.document_status into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if v_inv.company_id is null or v_inv.company_id <> v_company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv.document_status <> 'finalized' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FINALIZED';
  end if;
  select coalesce(sum(case when p.entry_type = 'payment' then p.paid_amount else -p.paid_amount end), 0) into v_net
  from public.invoice_payments p where p.invoice_id = p_invoice_id;
  if p_amount > v_net then
    raise exception using errcode = 'P0001', message = 'ESBLU_REFUND_EXCEEDS_PAID',
      hint = 'Vrátiť možno najviac sumu prijatú k tomuto dokladu.';
  end if;
  insert into public.invoice_payments (invoice_id, paid_amount, paid_at, payment_method, note, recorded_by, entry_type)
  values (p_invoice_id, p_amount, coalesce(p_refunded_at, current_date), p_payment_method, p_note, auth.uid(), 'refund')
  returning id into v_id;
  v_status := public.esblu_recalc_invoice_group_status(p_invoice_id);
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'payment_refunded', auth.uid(), 'user', jsonb_build_object('payment_id', v_id, 'amount', p_amount, 'new_payment_status', v_status));
  return jsonb_build_object('payment_id', v_id, 'payment_status', v_status);
end;
$function$;
revoke all on function public.esblu_add_invoice_refund(uuid, numeric, date, text, text) from public, anon;
grant execute on function public.esblu_add_invoice_refund(uuid, numeric, date, text, text) to authenticated;

create or replace function public.esblu_remove_invoice_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_invoice_id uuid;
  v_inv_company_id uuid;
  v_status text;
begin
  if p_payment_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ARGUMENT';
  end if;
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select p.invoice_id into v_invoice_id from public.invoice_payments p where p.id = p_payment_id;
  if v_invoice_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_PAYMENT_NOT_FOUND';
  end if;
  select i.company_id into v_inv_company_id from public.invoices i where i.id = v_invoice_id for update;
  if v_inv_company_id is null or v_inv_company_id <> v_company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  delete from public.invoice_payments where id = p_payment_id and invoice_id = v_invoice_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_PAYMENT_NOT_FOUND';
  end if;
  v_status := public.esblu_recalc_invoice_group_status(v_invoice_id);
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (v_invoice_id, 'payment_removed', auth.uid(), 'user', jsonb_build_object('payment_id', p_payment_id, 'new_payment_status', v_status));
  return jsonb_build_object('invoice_id', v_invoice_id, 'payment_status', v_status,
    'total_paid', (public.esblu_invoice_settlement_core(v_invoice_id) ->> 'paid')::numeric);
end;
$function$;
revoke execute on function public.esblu_remove_invoice_payment(uuid) from public, anon;
grant execute on function public.esblu_remove_invoice_payment(uuid) to authenticated;

-- Úhrada na dobropis ani na proformu sa neeviduje.
create or replace function public.esblu_block_payment_on_credit_note()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_kind text;
begin
  select i.kind into v_kind from public.invoices i where i.id = new.invoice_id;
  if v_kind = 'credit_note' then
    raise exception using errcode = 'P0001', message = 'ESBLU_PAYMENT_ON_CREDIT_NOTE';
  end if;
  if v_kind = 'proforma' then
    raise exception using errcode = 'P0001', message = 'ESBLU_PAYMENT_ON_PROFORMA',
      hint = 'Prijatú platbu evidujte na faktúre k prijatej platbe (daňový doklad), nie na proforme.';
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_block_payment_on_credit_note() from public, anon, authenticated;

-- Po finalizácii opravy alebo konečnej faktúry sa prepočíta saldo skupiny.
create or replace function public.esblu_invoice_settlement_after_finalize()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform public.esblu_recalc_invoice_group_status(coalesce(new.corrects_invoice_id, new.id));
  return new;
end;
$function$;
revoke execute on function public.esblu_invoice_settlement_after_finalize() from public, anon, authenticated;
drop trigger if exists esblu_invoice_settlement_after_finalize on public.invoices;
create trigger esblu_invoice_settlement_after_finalize
  after update of document_status on public.invoices
  for each row
  when (old.document_status = 'draft' and new.document_status = 'finalized')
  execute function public.esblu_invoice_settlement_after_finalize();

-- 9) Zálohy: dostupné zálohy a zámok pri finalizácii ------------------------------------------------
create or replace function public.esblu_available_advances(p_invoice_id uuid)
returns table (advance_invoice_id uuid, invoice_number text, tax_point_date date, vat_category_code text, vat_rate numeric,
               taxable_total numeric, vat_total numeric, taxable_remaining numeric, vat_remaining numeric)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
begin
  if not public.esblu_my_finance_view() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_VIEW_REQUIRED';
  end if;
  select * into v_inv from public.invoices i where i.id = p_invoice_id;
  if v_inv.id is null or v_inv.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  return query
  select a.id, a.invoice_number, a.tax_point_date, b.vat_category_code, b.vat_rate::numeric,
         b.taxable_amount::numeric, b.vat_amount::numeric,
         b.taxable_amount - coalesce(u.taxable, 0), b.vat_amount - coalesce(u.vat, 0)
  from public.invoices a
  join public.invoice_tax_breakdowns b on b.invoice_id = a.id
  left join lateral (
    select sum(x.taxable_amount) taxable, sum(x.vat_amount) vat
    from public.invoice_advance_deductions x join public.invoices f on f.id = x.invoice_id
    where x.advance_invoice_id = a.id and x.vat_category_code = b.vat_category_code and x.vat_rate = b.vat_rate
      and f.document_status = 'finalized' and f.id <> v_inv.id
  ) u on true
  where a.company_id = v_inv.company_id and a.direction = 'issued' and a.kind = 'payment_received_invoice'
    and a.document_status = 'finalized' and a.currency = v_inv.currency
    and a.customer_business_partner_id is not distinct from v_inv.customer_business_partner_id
    and b.taxable_amount - coalesce(u.taxable, 0) > 0
  order by a.tax_point_date nulls last, a.invoice_number, b.vat_category_code, b.vat_rate;
end;
$function$;
revoke all on function public.esblu_available_advances(uuid) from public, anon;
grant execute on function public.esblu_available_advances(uuid) to authenticated;

-- Beží pred esblu_invoice_finalize_compliance (abecedne): zamkne zálohy → súbežný dvojitý odpočet nie je možný.
create or replace function public.esblu_lock_advance_deductions()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_total numeric(18, 2);
  v_bad record;
begin
  if not exists (select 1 from public.invoice_advance_deductions d where d.invoice_id = new.id) then
    return new;
  end if;
  perform 1 from public.invoices a
  where a.id in (select d.advance_invoice_id from public.invoice_advance_deductions d where d.invoice_id = new.id)
  order by a.id for update;
  select coalesce(sum(d.taxable_amount + d.vat_amount), 0) into v_total from public.invoice_advance_deductions d where d.invoice_id = new.id;
  if v_total > new.total_amount then
    raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_EXCEEDS_TOTAL',
      hint = 'Odpočítané zálohy nesmú prevýšiť sumu konečnej faktúry.';
  end if;
  for v_bad in
    select d.advance_invoice_id, d.vat_category_code, d.vat_rate, d.vat_amount from public.invoice_advance_deductions d where d.invoice_id = new.id
  loop
    if v_bad.vat_amount + coalesce((
         select sum(x.vat_amount) from public.invoice_advance_deductions x join public.invoices f on f.id = x.invoice_id
          where x.advance_invoice_id = v_bad.advance_invoice_id and x.vat_category_code = v_bad.vat_category_code
            and x.vat_rate = v_bad.vat_rate and f.document_status = 'finalized' and f.id <> new.id), 0)
       > coalesce((select b.vat_amount from public.invoice_tax_breakdowns b
          where b.invoice_id = v_bad.advance_invoice_id and b.vat_category_code = v_bad.vat_category_code and b.vat_rate = v_bad.vat_rate), 0) then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_EXCEEDS';
    end if;
  end loop;
  return new;
end;
$function$;
revoke execute on function public.esblu_lock_advance_deductions() from public, anon, authenticated;
drop trigger if exists esblu_a_lock_advance_deductions on public.invoices;
create trigger esblu_a_lock_advance_deductions
  before update of document_status on public.invoices
  for each row
  when (old.document_status = 'draft' and new.document_status = 'finalized' and new.direction = 'issued' and new.kind = 'regular_invoice')
  execute function public.esblu_lock_advance_deductions();
