-- =============================================================================
-- E-Faktúra — Phase 3: serverový INBOUND flow (webhook / poll → fetch XML →
-- nemenné uloženie + hash → parse → dedupe → koncept prijatej faktúry → ACK).
-- NEAPLIKOVANÉ. Do produkcie iba cez MCP apply_migration po výslovnom
-- schválení (supabase/MIGRATIONS.md §9). Nikdy `supabase db push`.
-- Závisí od 20261002100000 / 20261002110000 / 20261002120000.
--
-- Zásady:
--   - Firma sa určí VÝHRADNE mapovaním provider_org_id → einvoice_organizations,
--     nikdy z obsahu webhooku. Webhook nie je zdroj pravdy: po overení podpisu
--     sa použije iba ID doručenia + provider_org_id a dokument/stav sa znova
--     načíta od poskytovateľa.
--   - Koncept prijatej faktúry vzniká EXISTUJÚCOU logikou
--     esblu_create_received_invoice_draft — jej telo sa presúva do internej
--     esblu_received_invoice_draft_core (bez zmeny správania pre AI Inbox) a
--     server ju volá s firmou z mapovania organizácie a bez používateľa
--     (actor_source = system, source = efaktura_peppol). Žiadna druhá tabuľka
--     faktúr; nič sa nefinalizuje — inbound ide vždy na kontrolu človekom.
--   - ACK poskytovateľovi je dovolený (a v DB vynútený) až keď existuje
--     uložené XML, hash, riadok einvoice_inbound A koncept faktúry.
--   - Udalosti: ten istý jediný model ako outbound — trigger
--     esblu_einvoice_log_state_change (zdroj cez GUC esblu.einvoice_event_source).
--
-- ROLLBACK (bez straty business dát):
--   esblu_create_received_invoice_draft vrátiť na definíciu z 20260921100000
--     a drop function esblu_received_invoice_draft_core(...);
--   drop function esblu_einvoice_webhook_record, esblu_einvoice_webhook_complete,
--     esblu_einvoice_inbound_register, esblu_einvoice_claim_inbound,
--     esblu_einvoice_inbound_transition, esblu_einvoice_inbound_create_draft,
--     esblu_einvoice_claim_outbound_by_submission, esblu_einvoice_org_company;
--   esblu_einvoice_inbound_guard() vrátiť z 20261002100000; nové stĺpce môžu ostať.
-- =============================================================================

begin;

-- 1) einvoice_inbound — stav spracovania, nemenné XML, retry ---------------------------
alter table public.einvoice_inbound
  add column if not exists xml_size_bytes integer
    check (xml_size_bytes is null or xml_size_bytes between 1 and 5242880),
  add column if not exists issue_date date,
  add column if not exists review_reasons text[]
    check (review_reasons is null or (
      cardinality(review_reasons) <= 30
      and (cardinality(review_reasons) = 0
           or array_to_string(review_reasons, ',') ~ '^[A-Z0-9_]{1,60}(,[A-Z0-9_]{1,60})*$')
    )),
  add column if not exists dedupe_matched_on text
    check (dedupe_matched_on is null or dedupe_matched_on ~ '^[a-z0-9_]{1,40}$'),
  add column if not exists retry_count integer not null default 0 check (retry_count between 0 and 1000),
  add column if not exists next_retry_at timestamptz,
  add column if not exists locked_until timestamptz,
  add column if not exists last_error_code text
    check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  add column if not exists draft_created_at timestamptz;

-- Stavy (aditívne: + ack_pending). needs_review ostáva povolené (legacy, nepoužíva sa).
alter table public.einvoice_inbound drop constraint if exists einvoice_inbound_processing_status_check;
alter table public.einvoice_inbound add constraint einvoice_inbound_processing_status_check
  check (processing_status in (
    'received',      -- poskytovateľ hlási doklad, XML ešte nie je uložené
    'stored',        -- presné XML uložené + SHA-256
    'parsed',        -- XML prešlo parserom a kontrolou profilu
    'draft_created', -- vznikol koncept prijatej faktúry (čaká na ACK)
    'duplicate',     -- ten istý doklad už vo firme je (prepojený existujúci koncept; čaká na ACK)
    'ack_pending',   -- ACK zlyhal, opakuje sa
    'acknowledged',  -- poskytovateľ potvrdil prevzatie (terminálny úspech)
    'failed',        -- trvalá chyba (neplatné XML, nepodporovaný profil…) — bez ACK, kontrola človekom
    'needs_review'   -- legacy (20261002100000)
  ));

create index if not exists einvoice_inbound_work_idx
  on public.einvoice_inbound (next_retry_at)
  where processing_status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending');
create index if not exists einvoice_inbound_hash_idx
  on public.einvoice_inbound (company_id, xml_sha256) where xml_sha256 is not null;

create or replace function public.esblu_einvoice_inbound_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id
       or new.provider is distinct from old.provider
       or new.environment is distinct from old.environment
       or new.provider_received_id is distinct from old.provider_received_id
       or (old.xml_sha256 is not null and new.xml_sha256 is distinct from old.xml_sha256)
       or (old.xml_storage_path is not null and new.xml_storage_path is distinct from old.xml_storage_path)
       or (old.xml_size_bytes is not null and new.xml_size_bytes is distinct from old.xml_size_bytes)
       or (old.pdf_storage_path is not null and new.pdf_storage_path is distinct from old.pdf_storage_path)
       or (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id)
       or (old.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE';
    end if;
    if new.retry_count < old.retry_count then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RETRY_COUNT_DECREASE';
    end if;
    if old.processing_status in ('acknowledged', 'failed') and new.processing_status is distinct from old.processing_status then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_TERMINAL';
    end if;
    if new.processing_status is distinct from old.processing_status and not (
         (old.processing_status = 'received' and new.processing_status in ('stored', 'failed'))
      or (old.processing_status = 'stored' and new.processing_status in ('parsed', 'failed'))
      or (old.processing_status = 'parsed' and new.processing_status in ('draft_created', 'duplicate', 'failed'))
      or (old.processing_status in ('draft_created', 'duplicate') and new.processing_status in ('acknowledged', 'ack_pending'))
      or (old.processing_status = 'ack_pending' and new.processing_status = 'acknowledged')
      or (old.processing_status = 'needs_review' and new.processing_status in ('stored', 'parsed', 'failed'))
    ) then
      raise exception using errcode = 'P0001',
        message = 'ESBLU_EINVOICE_INVALID_TRANSITION:' || old.processing_status || '->' || new.processing_status;
    end if;
  end if;

  -- Stavové invarianty (aj pre INSERT).
  if new.processing_status in ('stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending', 'acknowledged')
     and (new.xml_sha256 is null or new.xml_storage_path is null or new.xml_size_bytes is null) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_XML_REQUIRED';
  end if;
  -- ACK (a stavy čakajúce na ACK) iba s existujúcim konceptom faktúry.
  if new.processing_status in ('draft_created', 'duplicate', 'ack_pending', 'acknowledged') and new.invoice_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_DRAFT_REQUIRED';
  end if;
  if new.processing_status = 'acknowledged' and new.acknowledged_at is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACKNOWLEDGED_AT_REQUIRED';
  end if;

  -- Priradený koncept musí patriť tej istej firme a byť prijatou faktúrou.
  if new.invoice_id is not null and not exists (
    select 1 from public.invoices i
    where i.id = new.invoice_id and i.company_id = new.company_id and i.direction = 'received'
  ) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_guard() from public, anon, authenticated;

-- 2) Koncept prijatej faktúry: jadro (bez zmeny správania pre AI Inbox) --------------------
-- Telo je doslovne logika esblu_create_received_invoice_draft (20260921100000)
-- s parametrami firmy/aktéra/zdroja namiesto auth.uid(). Rozdiely iba pre
-- p_source = 'efaktura_peppol': kategórie DPH K/G/O a dedupe vrstva C
-- (transport_provider + transport_message_id). Bez grantov — volajú ju iba
-- verejná RPC (autorizovaný používateľ) a serverové inbound RPC.
create or replace function public.esblu_received_invoice_draft_core(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_source text,
  p_transport_provider text,
  p_transport_message_id text,
  p_supplier_business_partner_id uuid,
  p_supplier_invoice_number text,
  p_issue_date date,
  p_items jsonb,
  p_due_date date,
  p_delivery_date date,
  p_tax_point_date date,
  p_currency text,
  p_iban text,
  p_bic text,
  p_payment_reference text,
  p_variable_symbol text,
  p_buyer_reference text,
  p_purchase_order_reference text,
  p_received_at date,
  p_source_document_id uuid,
  p_dedupe_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid := p_company_id;
  v_user_id uuid := p_actor_user_id;
  v_bp_company_id uuid;
  v_doc_company_id uuid;
  v_doc_deleted timestamptz;
  v_number text;
  v_normalized_number text;
  v_existing_id uuid;
  v_item jsonb;
  v_position integer := 0;
  v_item_count integer;
  v_description text;
  v_quantity numeric(18, 6);
  v_unit_price numeric(18, 6);
  v_vat_category text;
  v_allowed_categories text[];
  v_vat_rate numeric(7, 4);
  v_unit text;
  v_unit_code text;
  v_line_net numeric(18, 2);
  v_line_vat numeric(18, 2);
  v_invoice_id uuid;
begin
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if p_source not in ('ai_inbox', 'efaktura_peppol') then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_SOURCE';
  end if;
  if (p_transport_provider is null) <> (p_transport_message_id is null)
     or (p_transport_provider is not null and p_source <> 'efaktura_peppol') then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TRANSPORT_REFERENCE';
  end if;
  v_allowed_categories := case when p_source = 'efaktura_peppol'
    then array['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] else array['S', 'Z', 'E', 'AE'] end;

  if p_supplier_business_partner_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_SUPPLIER';
  end if;

  select bp.company_id into v_bp_company_id
  from public.business_partners bp
  where bp.id = p_supplier_business_partner_id;

  if v_bp_company_id is null or v_bp_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_SUPPLIER_NOT_FOUND',
      hint = 'Dodávateľ neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
  end if;

  v_number := btrim(coalesce(p_supplier_invoice_number, ''));
  if v_number = '' then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER';
  end if;

  if p_issue_date is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ISSUE_DATE';
  end if;

  if p_source_document_id is not null then
    select d.company_id, d.deleted_at into v_doc_company_id, v_doc_deleted
    from public.documents d
    where d.id = p_source_document_id;

    if v_doc_company_id is null or v_doc_company_id <> v_company_id or v_doc_deleted is not null then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_SOURCE_DOCUMENT_NOT_FOUND',
        hint = 'Zdrojový dokument neexistuje, je zmazaný alebo nepatrí do aktívnej firmy volajúceho.';
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NO_ITEMS';
  end if;

  v_item_count := jsonb_array_length(p_items);
  if v_item_count = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NO_ITEMS';
  end if;

  -- DEDUPE (vnútri transakcie, pred akýmkoľvek zápisom) — vždy iba v rámci firmy.
  v_normalized_number := upper(regexp_replace(v_number, '[\s\-/]', '', 'g'));

  select i.id into v_existing_id
  from public.invoices i
  where i.company_id = v_company_id
    and i.direction = 'received'
    and i.kind = 'regular_invoice'
    and i.supplier_business_partner_id = p_supplier_business_partner_id
    and i.supplier_invoice_number is not null
    and upper(regexp_replace(i.supplier_invoice_number, '[\s\-/]', '', 'g')) = v_normalized_number
  order by i.created_at
  limit 1;

  if v_existing_id is not null then
    return jsonb_build_object('status', 'duplicate', 'existing_invoice_id', v_existing_id, 'matched_on', 'supplier_invoice_number');
  end if;

  if p_dedupe_fingerprint is not null then
    select i.id into v_existing_id
    from public.invoices i
    where i.company_id = v_company_id
      and i.direction = 'received'
      and i.dedupe_fingerprint = p_dedupe_fingerprint
    order by i.created_at
    limit 1;

    if v_existing_id is not null then
      return jsonb_build_object('status', 'duplicate', 'existing_invoice_id', v_existing_id, 'matched_on', 'dedupe_fingerprint');
    end if;
  end if;

  -- Vrstva C — transport ID poskytovateľa (iba e-faktúra).
  if p_transport_message_id is not null then
    select i.id into v_existing_id
    from public.invoices i
    where i.company_id = v_company_id
      and i.transport_provider = p_transport_provider
      and i.transport_message_id = p_transport_message_id
    order by i.created_at
    limit 1;

    if v_existing_id is not null then
      return jsonb_build_object('status', 'duplicate', 'existing_invoice_id', v_existing_id, 'matched_on', 'transport_message_id');
    end if;
  end if;

  if p_source_document_id is not null then
    select i.id into v_existing_id
    from public.invoices i
    where i.company_id = v_company_id
      and i.source_document_id = p_source_document_id
    order by i.created_at
    limit 1;

    if v_existing_id is not null then
      return jsonb_build_object('status', 'duplicate', 'existing_invoice_id', v_existing_id, 'matched_on', 'source_document');
    end if;
  end if;

  insert into public.invoices (
    company_id, direction, kind, document_status,
    issue_date, due_date, delivery_date, tax_point_date,
    currency, iban, payment_reference, variable_symbol,
    buyer_reference, purchase_order_reference,
    supplier_business_partner_id, supplier_invoice_number, received_at,
    source, source_document_id, dedupe_fingerprint,
    transport_provider, transport_message_id,
    created_by, updated_by
  )
  values (
    v_company_id, 'received', 'regular_invoice', 'draft',
    p_issue_date, p_due_date, p_delivery_date, p_tax_point_date,
    coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'EUR'),
    nullif(btrim(coalesce(p_iban, '')), ''),
    nullif(btrim(coalesce(p_payment_reference, '')), ''),
    nullif(btrim(coalesce(p_variable_symbol, '')), ''),
    nullif(btrim(coalesce(p_buyer_reference, '')), ''),
    nullif(btrim(coalesce(p_purchase_order_reference, '')), ''),
    p_supplier_business_partner_id, v_number, p_received_at,
    p_source, p_source_document_id, p_dedupe_fingerprint,
    p_transport_provider, p_transport_message_id,
    v_user_id, v_user_id
  )
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;
    v_description := btrim(coalesce(v_item ->> 'description', ''));
    if v_description = '' then
      raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' nemá popis.';
    end if;

    begin
      v_quantity := (v_item ->> 'quantity')::numeric;
      v_unit_price := (v_item ->> 'unit_price')::numeric;
    exception when others then
      raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' má nečíselné množstvo alebo cenu.';
    end;

    if v_quantity is null or v_quantity <= 0 then
      raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' musí mať kladné množstvo.';
    end if;

    if v_unit_price is null or v_unit_price < 0 then
      raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' musí mať nezápornú jednotkovú cenu.';
    end if;

    v_vat_category := coalesce(v_item ->> 'vat_category_code', '');
    if not (v_vat_category = any (v_allowed_categories)) then
      raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' nemá platnú kategóriu DPH.';
    end if;

    if v_vat_category = 'S' then
      begin
        v_vat_rate := (v_item ->> 'vat_rate')::numeric;
      exception when others then
        v_vat_rate := null;
      end;

      if v_vat_rate is null or v_vat_rate < 0 then
        raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_S_VAT_RATE',
          hint = 'Položka č. ' || v_position || ' má kategóriu S bez platnej sadzby DPH.';
      end if;
    else
      v_vat_rate := 0;
    end if;

    v_unit := nullif(btrim(coalesce(v_item ->> 'unit', '')), '');
    v_unit_code := nullif(btrim(coalesce(v_item ->> 'unit_code', '')), '');

    v_line_net := round(v_quantity * v_unit_price, 2);
    v_line_vat := case when v_vat_category = 'S' then round(v_line_net * v_vat_rate / 100, 2) else 0 end;

    insert into public.invoice_items (
      invoice_id, position, description, quantity, unit, unit_code, unit_price,
      vat_category_code, vat_rate, line_net_amount, line_vat_amount, line_gross_amount
    )
    values (
      v_invoice_id, v_position, v_description, v_quantity,
      coalesce(v_unit, 'ks'), v_unit_code, v_unit_price,
      v_vat_category, v_vat_rate, v_line_net, v_line_vat, v_line_net + v_line_vat
    );
  end loop;

  if p_source_document_id is not null then
    insert into public.document_links (
      company_id, user_id, document_id, invoice_id, link_type, confirmed_by_user
    )
    values (
      v_company_id, v_user_id, p_source_document_id, v_invoice_id, 'primary', true
    )
    on conflict do nothing;
  end if;

  insert into public.invoice_events (
    invoice_id, event_type, actor_user_id, actor_source, payload
  )
  values (
    v_invoice_id, 'created', v_user_id, case when v_user_id is null then 'system' else 'user' end,
    jsonb_build_object('direction', 'received', 'source', p_source,
      'supplier_invoice_number', v_number, 'item_count', v_item_count)
  );

  return jsonb_build_object('status', 'created', 'invoice_id', v_invoice_id,
    'supplier_invoice_number', v_number, 'item_count', v_item_count);
end;
$function$;
revoke all on function public.esblu_received_invoice_draft_core(uuid, uuid, text, text, text, uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text)
  from public, anon, authenticated, service_role;

-- Verejná RPC (AI Inbox) — rovnaký podpis, rovnaké granty, rovnaké správanie:
-- autorizácia volajúceho, potom jadro so zdrojom 'ai_inbox'.
create or replace function public.esblu_create_received_invoice_draft(
  p_supplier_business_partner_id uuid,
  p_supplier_invoice_number text,
  p_issue_date date,
  p_items jsonb,
  p_due_date date default null,
  p_delivery_date date default null,
  p_tax_point_date date default null,
  p_currency text default 'EUR',
  p_iban text default null,
  p_bic text default null,
  p_payment_reference text default null,
  p_variable_symbol text default null,
  p_buyer_reference text default null,
  p_purchase_order_reference text default null,
  p_received_at date default null,
  p_source_document_id uuid default null,
  p_dedupe_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_user_id uuid;
begin
  v_user_id := auth.uid();
  v_company_id := public.esblu_my_active_company_id();

  if v_user_id is null or v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED',
      hint = 'Vytvorenie prijatej faktúry vyžaduje owner alebo permissions.finance.manage=true.';
  end if;

  return public.esblu_received_invoice_draft_core(
    v_company_id, v_user_id, 'ai_inbox', null, null,
    p_supplier_business_partner_id, p_supplier_invoice_number, p_issue_date, p_items,
    p_due_date, p_delivery_date, p_tax_point_date, p_currency, p_iban, p_bic,
    p_payment_reference, p_variable_symbol, p_buyer_reference, p_purchase_order_reference,
    p_received_at, p_source_document_id, p_dedupe_fingerprint
  );
end;
$function$;
revoke execute on function public.esblu_create_received_invoice_draft(uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) from public;
revoke execute on function public.esblu_create_received_invoice_draft(uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) from anon;
grant execute on function public.esblu_create_received_invoice_draft(uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) to authenticated;

-- 3) Mapovanie organizácie → firma (jediný zdroj firmy pre webhook / poll) ---------------
create or replace function public.esblu_einvoice_org_company(p_provider text, p_environment text, p_provider_org_id text)
returns uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select o.company_id from public.einvoice_organizations o
  where o.provider = p_provider and o.environment = p_environment
    and o.provider_org_id = p_provider_org_id and p_provider_org_id is not null
  limit 1;
$function$;
revoke all on function public.esblu_einvoice_org_company(text, text, text) from public, anon, authenticated, service_role;

-- 4) Webhook: záznam doručenia (dedupe) a uzavretie ---------------------------------------
create or replace function public.esblu_einvoice_webhook_record(
  p_provider text,
  p_environment text,
  p_delivery_id text,
  p_provider_org_id text,
  p_event text,
  p_body_sha256 text
)
returns table (webhook_event_id uuid, inserted boolean, body_matches boolean, company_id uuid, processing_status text)
language plpgsql
volatile
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_company uuid := public.esblu_einvoice_org_company(p_provider, p_environment, p_provider_org_id);
  v_id uuid;
  v_existing public.einvoice_webhook_events;
begin
  insert into public.einvoice_webhook_events (
    provider, environment, delivery_id, provider_org_id, company_id, event, body_sha256,
    processing_status, error, processed_at
  ) values (
    p_provider, p_environment, p_delivery_id, p_provider_org_id, v_company, p_event, p_body_sha256,
    case when v_company is null then 'rejected' else 'received' end,
    case when v_company is null then 'UNKNOWN_ORG' end,
    case when v_company is null then now() end
  )
  on conflict (provider, environment, delivery_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true, true, v_company, case when v_company is null then 'rejected' else 'received' end;
    return;
  end if;

  select * into v_existing from public.einvoice_webhook_events w
  where w.provider = p_provider and w.environment = p_environment and w.delivery_id = p_delivery_id;
  return query select v_existing.id, false, v_existing.body_sha256 = p_body_sha256, v_existing.company_id, v_existing.processing_status;
end;
$function$;
revoke all on function public.esblu_einvoice_webhook_record(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_webhook_record(text, text, text, text, text, text) to service_role;

create or replace function public.esblu_einvoice_webhook_complete(p_webhook_event_id uuid, p_status text, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path to ''
as $function$
begin
  if p_status not in ('processed', 'ignored', 'failed', 'rejected') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_WEBHOOK_STATUS_INVALID';
  end if;
  if p_code is not null and p_code !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_WEBHOOK_CODE_INVALID';
  end if;
  update public.einvoice_webhook_events w
  set processing_status = p_status, error = p_code, processed_at = now()
  where w.id = p_webhook_event_id and w.processing_status = 'received';
end;
$function$;
revoke all on function public.esblu_einvoice_webhook_complete(uuid, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_webhook_complete(uuid, text, text) to service_role;

-- 5) Registrácia prijatého dokladu (idempotentné podľa ID poskytovateľa) -------------------
create or replace function public.esblu_einvoice_inbound_register(
  p_provider text,
  p_environment text,
  p_provider_org_id text,
  p_provider_received_id text,
  p_source text,
  p_meta jsonb
)
returns table (inbound_id uuid, created boolean, processing_status text, company_id uuid)
language plpgsql
volatile
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_company uuid := public.esblu_einvoice_org_company(p_provider, p_environment, p_provider_org_id);
  v_meta jsonb := coalesce(p_meta, '{}'::jsonb);
  v_id uuid;
  v_row public.einvoice_inbound;
begin
  if v_company is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_UNKNOWN_ORG';
  end if;
  if p_source not in ('webhook', 'poll') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_SOURCE_INVALID';
  end if;
  if jsonb_typeof(v_meta) <> 'object'
     or (v_meta - array['sender_participant_id', 'sender_ico', 'document_number', 'document_type', 'is_test']) <> '{}'::jsonb then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_META_INVALID';
  end if;

  perform set_config('esblu.einvoice_event_source', p_source, true);
  insert into public.einvoice_inbound (
    company_id, provider, environment, provider_received_id,
    sender_participant_id, sender_ico, document_number, document_type, is_test,
    processing_status, next_retry_at
  ) values (
    v_company, p_provider, p_environment, p_provider_received_id,
    left(v_meta ->> 'sender_participant_id', 250), left(v_meta ->> 'sender_ico', 20),
    left(v_meta ->> 'document_number', 200), left(v_meta ->> 'document_type', 80),
    coalesce((v_meta ->> 'is_test')::boolean, false),
    'received', now()
  )
  on conflict (provider, environment, provider_received_id) do nothing
  returning id into v_id;
  perform set_config('esblu.einvoice_event_source', '', true);

  if v_id is not null then
    return query select v_id, true, 'received'::text, v_company;
    return;
  end if;

  select * into v_row from public.einvoice_inbound i
  where i.provider = p_provider and i.environment = p_environment and i.provider_received_id = p_provider_received_id;
  -- Iný tenant s rovnakým ID poskytovateľa? (nemožné pri správnom mapovaní) → neprezradiť nič.
  if v_row.company_id is distinct from v_company then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_UNKNOWN_ORG';
  end if;
  return query select v_row.id, false, v_row.processing_status, v_row.company_id;
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_register(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_register(text, text, text, text, text, jsonb) to service_role;

-- 6) Claim pre inbound worker (FOR UPDATE SKIP LOCKED + lease) -----------------------------
create or replace function public.esblu_einvoice_claim_inbound(p_limit integer, p_lease_seconds integer)
returns setof public.einvoice_inbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 10);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
begin
  return query
  with c as (
    select i.id from public.einvoice_inbound i
    where i.processing_status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending')
      and i.next_retry_at is not null and i.next_retry_at <= now()
      and (i.locked_until is null or i.locked_until < now())
      and i.retry_count < 12
    order by i.next_retry_at, i.received_at
    limit v_limit
    for update skip locked
  )
  update public.einvoice_inbound i
  set locked_until = now() + v_lease,
      retry_count = i.retry_count + 1,
      -- pád workera → po lease sa riadok znovu zoberie
      next_retry_at = now() + v_lease
  from c where i.id = c.id
  returning i.*;
end;
$function$;
revoke all on function public.esblu_einvoice_claim_inbound(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_claim_inbound(integer, integer) to service_role;

-- 7) Zápis výsledku kroku (allowlist polí, optimistický stav) -------------------------------
create or replace function public.esblu_einvoice_inbound_transition(
  p_inbound_id uuid,
  p_expected_state text,
  p_to_state text,
  p_source text,
  p_provider_code text,
  p_fields jsonb
)
returns public.einvoice_inbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_row public.einvoice_inbound;
begin
  if jsonb_typeof(v_fields) <> 'object'
     or (v_fields - array['xml_storage_path', 'xml_sha256', 'xml_size_bytes', 'document_number', 'document_type',
                          'sender_participant_id', 'sender_ico', 'issue_date', 'review_reasons', 'error_message',
                          'last_error_code', 'next_retry_at', 'locked_until', 'acknowledged_at']) <> '{}'::jsonb then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TRANSITION_FIELDS_INVALID';
  end if;
  if p_source is null or p_source not in ('job', 'provider', 'webhook', 'poll', 'system') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TRANSITION_SOURCE_INVALID';
  end if;

  perform set_config('esblu.einvoice_event_source', p_source, true);
  perform set_config('esblu.einvoice_provider_code', coalesce(p_provider_code, ''), true);

  update public.einvoice_inbound i
  set processing_status = coalesce(p_to_state, i.processing_status),
      xml_storage_path = case when v_fields ? 'xml_storage_path' then v_fields ->> 'xml_storage_path' else i.xml_storage_path end,
      xml_sha256 = case when v_fields ? 'xml_sha256' then v_fields ->> 'xml_sha256' else i.xml_sha256 end,
      xml_size_bytes = case when v_fields ? 'xml_size_bytes' then (v_fields ->> 'xml_size_bytes')::integer else i.xml_size_bytes end,
      document_number = case when v_fields ? 'document_number' then left(v_fields ->> 'document_number', 200) else i.document_number end,
      document_type = case when v_fields ? 'document_type' then left(v_fields ->> 'document_type', 80) else i.document_type end,
      sender_participant_id = case when v_fields ? 'sender_participant_id' then left(v_fields ->> 'sender_participant_id', 250) else i.sender_participant_id end,
      sender_ico = case when v_fields ? 'sender_ico' then left(v_fields ->> 'sender_ico', 20) else i.sender_ico end,
      issue_date = case when v_fields ? 'issue_date' then (v_fields ->> 'issue_date')::date else i.issue_date end,
      review_reasons = case when v_fields ? 'review_reasons'
        then array(select jsonb_array_elements_text(v_fields -> 'review_reasons')) else i.review_reasons end,
      error_message = case when v_fields ? 'error_message' then left(v_fields ->> 'error_message', 2000) else i.error_message end,
      last_error_code = case when v_fields ? 'last_error_code' then v_fields ->> 'last_error_code' else i.last_error_code end,
      next_retry_at = case when v_fields ? 'next_retry_at' then (v_fields ->> 'next_retry_at')::timestamptz else i.next_retry_at end,
      locked_until = case when v_fields ? 'locked_until' then (v_fields ->> 'locked_until')::timestamptz else i.locked_until end,
      acknowledged_at = case when v_fields ? 'acknowledged_at' then (v_fields ->> 'acknowledged_at')::timestamptz else i.acknowledged_at end
  where i.id = p_inbound_id and i.processing_status = p_expected_state
  returning * into v_row;

  perform set_config('esblu.einvoice_event_source', '', true);
  perform set_config('esblu.einvoice_provider_code', '', true);

  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_STALE';
  end if;
  return v_row;
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_transition(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_transition(uuid, text, text, text, text, jsonb) to service_role;

-- 8) Koncept prijatej faktúry z rozparsovaného XML (atomicky s prechodom stavu) ------------
-- p_draft: { supplier: {legal_name, ico, vat_id, country_code, address_line1,
--   address_line2, city, postal_code, endpoint_id, endpoint_scheme},
--   invoice_number, issue_date, due_date, delivery_date, currency, iban, bic,
--   payment_reference, buyer_reference, purchase_order_reference, items: [...] }
-- Dodávateľ: nájdený podľa identity (IČO → IČ DPH / VAT → Peppol endpoint),
-- inak založený ako nový obchodný partner tej istej firmy. Podľa mena sa
-- NIKDY nepáruje. Bez identity → ESBLU_EINVOICE_SUPPLIER_UNIDENTIFIED.
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
  v_supplier jsonb := coalesce(p_draft -> 'supplier', '{}'::jsonb);
  v_ico text := nullif(btrim(coalesce(v_supplier ->> 'ico', '')), '');
  v_vat text := nullif(upper(regexp_replace(coalesce(v_supplier ->> 'vat_id', ''), '[\s.\-/]', '', 'g')), '');
  v_endpoint text := nullif(btrim(coalesce(v_supplier ->> 'endpoint_id', '')), '');
  v_endpoint_scheme text := nullif(btrim(coalesce(v_supplier ->> 'endpoint_scheme', '')), '');
  v_name text := nullif(btrim(coalesce(v_supplier ->> 'legal_name', '')), '');
  v_country text := nullif(upper(btrim(coalesce(v_supplier ->> 'country_code', ''))), '');
  v_partner uuid;
  v_result jsonb;
  v_status text;
begin
  select * into v_in from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if v_in.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_NOT_FOUND';
  end if;
  if v_in.processing_status <> 'parsed' or v_in.xml_sha256 is null or v_in.xml_storage_path is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_STATE';
  end if;

  perform set_config('esblu.einvoice_event_source', 'job', true);

  -- Dedupe 1: rovnaké XML (SHA-256) už vo FIRME spracované → prepojiť existujúci koncept.
  select i.id, i.invoice_id into v_dup
  from public.einvoice_inbound i
  where i.company_id = v_in.company_id and i.xml_sha256 = v_in.xml_sha256
    and i.id <> v_in.id and i.invoice_id is not null
  order by i.received_at
  limit 1;
  if v_dup.id is not null then
    update public.einvoice_inbound i
    set processing_status = 'duplicate', invoice_id = v_dup.invoice_id, dedupe_matched_on = 'xml_sha256',
        -- ACK nasleduje hneď v tom istom behu; pri páde workera sa zopakuje po 2 min.
        last_error_code = null, next_retry_at = now() + interval '2 minutes'
    where i.id = v_in.id;
    perform set_config('esblu.einvoice_event_source', '', true);
    return jsonb_build_object('status', 'duplicate', 'invoice_id', v_dup.invoice_id, 'matched_on', 'xml_sha256');
  end if;

  -- Dodávateľ v RÁMCI FIRMY podľa identity (nikdy podľa mena).
  if v_ico is not null and v_ico !~ '^[0-9]{8}$' then
    v_ico := null;
  end if;
  if v_endpoint is not null and (v_endpoint_scheme is null or v_endpoint_scheme !~ '^[0-9]{4}$') then
    v_endpoint := null;
  end if;
  if v_ico is null and v_vat is null and v_endpoint is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_SUPPLIER_UNIDENTIFIED';
  end if;
  if v_name is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_SUPPLIER_UNIDENTIFIED';
  end if;

  if v_ico is not null then
    select bp.id into v_partner from public.business_partners bp
    where bp.company_id = v_in.company_id and bp.ico = v_ico limit 1;
  end if;
  if v_partner is null and v_vat is not null then
    select bp.id into v_partner from public.business_partners bp
    where bp.company_id = v_in.company_id
      and (upper(regexp_replace(coalesce(bp.ic_dph, ''), '[\s.\-/]', '', 'g')) = v_vat
           or upper(regexp_replace(coalesce(bp.vat_identifier, ''), '[\s.\-/]', '', 'g')) = v_vat)
    order by bp.created_at limit 1;
  end if;
  if v_partner is null and v_endpoint is not null then
    select bp.id into v_partner from public.business_partners bp
    where bp.company_id = v_in.company_id
      and bp.electronic_address = v_endpoint and bp.electronic_address_scheme_id = v_endpoint_scheme
    order by bp.created_at limit 1;
  end if;
  if v_partner is null then
    insert into public.business_partners (
      company_id, kind, legal_name, ico, ic_dph, vat_identifier,
      address_line1, address_line2, city, postal_code, country_code,
      electronic_address, electronic_address_scheme_id
    ) values (
      v_in.company_id, 'supplier', left(v_name, 300), v_ico,
      case when v_vat ~ '^SK[0-9]{10}$' then v_vat end,
      case when v_vat is not null and v_vat !~ '^SK[0-9]{10}$' then v_vat end,
      nullif(btrim(coalesce(v_supplier ->> 'address_line1', '')), ''),
      nullif(btrim(coalesce(v_supplier ->> 'address_line2', '')), ''),
      nullif(btrim(coalesce(v_supplier ->> 'city', '')), ''),
      nullif(btrim(coalesce(v_supplier ->> 'postal_code', '')), ''),
      case when v_country ~ '^[A-Z]{2}$' then v_country end,
      case when v_endpoint_scheme is not null then v_endpoint end,
      case when v_endpoint is not null then v_endpoint_scheme end
    )
    on conflict do nothing
    returning id into v_partner;
    if v_partner is null then
      -- súbežne založený s rovnakým IČO
      select bp.id into v_partner from public.business_partners bp
      where bp.company_id = v_in.company_id and bp.ico = v_ico limit 1;
    end if;
  end if;

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
  update public.einvoice_inbound i
  set processing_status = v_status,
      invoice_id = coalesce((v_result ->> 'invoice_id')::uuid, (v_result ->> 'existing_invoice_id')::uuid),
      dedupe_matched_on = case when v_status = 'duplicate' then v_result ->> 'matched_on' end,
      draft_created_at = case when v_status = 'draft_created' then now() else i.draft_created_at end,
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

-- 9) Outbound webhook → reconciliation jedného podania (stav sa overí u poskytovateľa) ------
create or replace function public.esblu_einvoice_claim_outbound_by_submission(
  p_company_id uuid,
  p_provider_submission_id text,
  p_lease_seconds integer
)
returns setof public.einvoice_outbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
begin
  return query
  with c as (
    select e.id from public.einvoice_outbound e
    where e.company_id = p_company_id
      and e.provider_submission_id = p_provider_submission_id
      and e.state in ('sending', 'sent', 'deferred')
      and (e.locked_until is null or e.locked_until < now())
    limit 1
    for update skip locked
  )
  update public.einvoice_outbound o
  set locked_until = now() + v_lease
  from c where o.id = c.id
  returning o.*;
end;
$function$;
revoke all on function public.esblu_einvoice_claim_outbound_by_submission(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_claim_outbound_by_submission(uuid, text, integer) to service_role;

commit;
