-- =============================================================================
-- 20260921100000_add_received_invoice_intake.sql
--
-- AI Inbox → canonical received invoice. Serverová časť.
--
-- DVA POTVRDENÉ BLOCKERY
-- ----------------------
-- Migrácia 20260920121000 pridala document_links.invoice_id, ale stĺpec je
-- dnes ŠTRUKTÚRNE NEPOUŽITEĽNÝ — nič ho nevie zapísať:
--
--   1. CHECK document_links_exactly_one_entity_check znie
--        num_nonnulls(vehicle_id, machine_id, inventory_item_id,
--                     vehicle_service_id, machine_service_id) = 1
--      Riadok, ktorý má vyplnený IBA invoice_id, má num_nonnulls = 0 a
--      constraint ho odmietne.
--
--   2. RLS document_links_insert_company vyžaduje, aby bola vyplnená a
--      company-matchnutá jedna z tých istých piatich entít. Vetva pre
--      invoice_id neexistuje, takže insert je fail-closed.
--
-- Bod 1 je chyba, ktorú treba opraviť (constraint musí o stĺpci vedieť).
-- Bod 2 NEOTVÁRAME. Zadanie hovorí "nevytváraj broad insert policy" a
-- prelinkovanie dokumentu na faktúru má prísnejšie požiadavky než
-- prelinkovanie na vozidlo: je to finance operácia. Klientská RLS cesta
-- preto pre invoice_id zostáva zatvorená a jediným zápisovým kanálom je
-- SECURITY DEFINER RPC nižšie, ktoré overí všetko naraz.
--
-- ČO TÁTO MIGRÁCIA ROBÍ
-- ---------------------
--   1. Nahrádza exactly-one-entity CHECK verziou, ktorá pozná invoice_id.
--   2. Pridáva esblu_create_received_invoice_draft() — atomické vytvorenie
--      canonical received draftu + položiek + prelinkovania zdrojového
--      dokumentu, s dedupe kontrolou vnútri tej istej transakcie.
--
-- ČO NEROBÍ (zámerne)
-- -------------------
--   • Nemení esblu_finalize_invoice(). Draft z Inboxu je obyčajný draft a
--     finalizuje sa tou istou direction-aware RPC ako každý iný.
--   • Nemení immutability, payment model, issued numbering ani RLS na
--     invoices/invoice_items.
--   • Žiadny XML/UBL, žiadny provider, žiadny auto-finalize.
--   • Nedotýka sa ostatných štyroch entity vetiev document_links.
--
-- HLAVNÉ PRAVIDLO: AI Inbox nevytvára právnu pravdu. Táto RPC je volaná AŽ
-- PO tom, ako používateľ v review obrazovke potvrdil dodávateľa, číslo
-- dokladu, dátumy a položky. Server nič nedopĺňa a nič nehádá — validuje
-- a zapisuje to, čo dostal, alebo fail-closed odmietne.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. document_links — CHECK musí poznať invoice_id
-- ---------------------------------------------------------------------------
-- Stále presne JEDNA entita na riadok; pribúda len šiesta možnosť. Existujúce
-- riadky (vozidlá, stroje, sklad, servisy) vyhovujú novej podmienke rovnako
-- ako starej, takže ADD CONSTRAINT prejde validáciou celej tabuľky bez zmeny
-- dát. Ak by nevyhovel čo i len jeden riadok, celá migrácia sa rollbackne.

alter table public.document_links
  drop constraint if exists document_links_exactly_one_entity_check;

alter table public.document_links
  add constraint document_links_exactly_one_entity_check
  check (
    num_nonnulls(
      vehicle_id, machine_id, inventory_item_id,
      vehicle_service_id, machine_service_id, invoice_id
    ) = 1
  );

comment on constraint document_links_exactly_one_entity_check on public.document_links is
  'Jeden link = presne jedna cieľová entita. invoice_id doplnené 20260921100000 — bez neho bol stĺpec z 20260920121000 nezapisovateľný (num_nonnulls = 0).';


-- ---------------------------------------------------------------------------
-- 2. esblu_create_received_invoice_draft()
-- ---------------------------------------------------------------------------
-- Vstup je už POTVRDENÝ používateľom v review obrazovke. Server preto:
--   • neodhaduje dodávateľa,
--   • nedopĺňa VAT kategóriu ani sadzbu,
--   • nepreberá sumy z dokumentu (tie sú iba comparison signal v UI),
--   • neprideľuje žiadne interné číslo (received nikdy nedostane invoice_number).
--
-- Dedupe beží TU, vnútri transakcie, nie v aplikačnej vrstve — aplikačný
-- pre-check je race condition, dvaja používatelia môžu potvrdiť ten istý
-- doklad súčasne.
--
-- Deduplikačný kľúč je zhodný s partial unique indexom
-- invoices_received_supplier_number_uniq (20260920140000):
--   company + dodávateľ + normalizované číslo dokladu + kind
-- s jedným rozdielom — index platí len pre finalized, táto kontrola pokrýva
-- aj DRAFT. Dôvod: dva rozpracované drafty tej istej faktúry sú presne to,
-- čomu má Inbox dedupe zabrániť, a index by ich pustil.
--
-- Návratová hodnota namiesto výnimky pri duplikáte: UI musí vedieť ukázať
-- existujúcu faktúru ("túto už máte"), nie len zlyhať. Druhá canonical
-- faktúra ani tak nevznikne — to je fail-closed správanie, aké zadanie žiada.

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
  v_vat_rate numeric(7, 4);
  v_unit text;
  v_unit_code text;
  v_line_net numeric(18, 2);
  v_line_vat numeric(18, 2);

  v_invoice_id uuid;
begin
  v_user_id := auth.uid();
  v_company_id := public.esblu_my_active_company_id();

  if v_user_id is null or v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED',
      hint = 'Vytvorenie prijatej faktúry vyžaduje owner alebo permissions.finance.manage=true.';
  end if;

  -- ---- dodávateľ -------------------------------------------------------
  if p_supplier_business_partner_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_SUPPLIER';
  end if;

  select bp.company_id into v_bp_company_id
  from public.business_partners bp
  where bp.id = p_supplier_business_partner_id;

  -- company_id volajúceho sa NIKDY nepreberá z argumentu — porovnáva sa voči
  -- aktívnej firme odvodenej z auth.uid().
  if v_bp_company_id is null or v_bp_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_SUPPLIER_NOT_FOUND',
      hint = 'Dodávateľ neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
  end if;

  -- ---- číslo dokladu dodávateľa ---------------------------------------
  v_number := btrim(coalesce(p_supplier_invoice_number, ''));
  if v_number = '' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER';
  end if;

  if p_issue_date is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_ISSUE_DATE';
  end if;

  -- ---- zdrojový dokument ----------------------------------------------
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

  -- ---- položky ---------------------------------------------------------
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NO_ITEMS';
  end if;

  v_item_count := jsonb_array_length(p_items);
  if v_item_count = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NO_ITEMS';
  end if;

  -- ---- DEDUPE (vnútri transakcie, pred akýmkoľvek zápisom) -------------
  -- Normalizácia je zhodná s indexom invoices_received_supplier_number_uniq:
  -- medzery, pomlčky a lomky preč, veľké písmená, vedúce nuly ZACHOVANÉ
  -- (FA-0001 a FA-1 sú rôzne doklady).
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
    return jsonb_build_object(
      'status', 'duplicate',
      'existing_invoice_id', v_existing_id,
      'matched_on', 'supplier_invoice_number'
    );
  end if;

  -- Vrstva B — structured fingerprint. Beží len ak ho volajúci vypočítal
  -- (dodávateľ bez spoľahlivého identifikátora ho mať nebude, a vtedy sa
  -- dedupe zámerne nespúšťa, namiesto hádania podľa mena firmy).
  if p_dedupe_fingerprint is not null then
    select i.id into v_existing_id
    from public.invoices i
    where i.company_id = v_company_id
      and i.direction = 'received'
      and i.dedupe_fingerprint = p_dedupe_fingerprint
    order by i.created_at
    limit 1;

    if v_existing_id is not null then
      return jsonb_build_object(
        'status', 'duplicate',
        'existing_invoice_id', v_existing_id,
        'matched_on', 'dedupe_fingerprint'
      );
    end if;
  end if;

  -- Vrstva D — z toho istého zdrojového dokumentu už faktúra vznikla.
  if p_source_document_id is not null then
    select i.id into v_existing_id
    from public.invoices i
    where i.company_id = v_company_id
      and i.source_document_id = p_source_document_id
    order by i.created_at
    limit 1;

    if v_existing_id is not null then
      return jsonb_build_object(
        'status', 'duplicate',
        'existing_invoice_id', v_existing_id,
        'matched_on', 'source_document'
      );
    end if;
  end if;

  -- ---- canonical received draft ---------------------------------------
  -- invoice_number a invoice_number_sequence_id zostávajú NULL — prijatej
  -- faktúre Esblu nikdy neprideľuje interné vydané číslo (CHECK
  -- invoices_received_never_gets_internal_number).
  -- customer_business_partner_id zostáva NULL (CHECK invoices_customer_only_when_issued).
  insert into public.invoices (
    company_id, direction, kind, document_status,
    issue_date, due_date, delivery_date, tax_point_date,
    currency, iban, payment_reference, variable_symbol,
    buyer_reference, purchase_order_reference,
    supplier_business_partner_id, supplier_invoice_number, received_at,
    source, source_document_id, dedupe_fingerprint,
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
    'ai_inbox', p_source_document_id, p_dedupe_fingerprint,
    v_user_id, v_user_id
  )
  returning id into v_invoice_id;

  -- ---- položky ---------------------------------------------------------
  -- VAT sémantika je zhodná s canonical engine: sadzba má percentuálny
  -- význam VÝHRADNE pre kategóriu S; pre Z/E/AE je uložená 0 a vat časť je 0.
  -- Sumy tu sú iba draft/preview hodnoty — autoritatívne ich prepočíta
  -- esblu_finalize_invoice() pri finalizácii.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;

    v_description := btrim(coalesce(v_item ->> 'description', ''));
    if v_description = '' then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' nemá popis.';
    end if;

    begin
      v_quantity := (v_item ->> 'quantity')::numeric;
      v_unit_price := (v_item ->> 'unit_price')::numeric;
    exception when others then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' má nečíselné množstvo alebo cenu.';
    end;

    if v_quantity is null or v_quantity <= 0 then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' musí mať kladné množstvo.';
    end if;

    if v_unit_price is null or v_unit_price < 0 then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' musí mať nezápornú jednotkovú cenu.';
    end if;

    v_vat_category := coalesce(v_item ->> 'vat_category_code', '');
    if v_vat_category not in ('S', 'Z', 'E', 'AE') then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_INVALID_ITEM',
        hint = 'Položka č. ' || v_position || ' nemá platnú kategóriu DPH.';
    end if;

    if v_vat_category = 'S' then
      begin
        v_vat_rate := (v_item ->> 'vat_rate')::numeric;
      exception when others then
        v_vat_rate := null;
      end;

      -- Kategória S je jediná, kde má sadzba percentuálny význam. AI ju
      -- smie navrhnúť, ale potvrdiť ju musí používateľ — server ju nikdy
      -- nedopĺňa defaultom.
      if v_vat_rate is null or v_vat_rate < 0 then
        raise exception using
          errcode = 'P0001',
          message = 'ESBLU_INVALID_S_VAT_RATE',
          hint = 'Položka č. ' || v_position || ' má kategóriu S bez platnej sadzby DPH.';
      end if;
    else
      v_vat_rate := 0;
    end if;

    v_unit := nullif(btrim(coalesce(v_item ->> 'unit', '')), '');
    -- unit_code sa NIKDY neodvodzuje z voľného textu unit — iba ak ho
    -- používateľ explicitne potvrdil a klient ho poslal.
    v_unit_code := nullif(btrim(coalesce(v_item ->> 'unit_code', '')), '');

    v_line_net := round(v_quantity * v_unit_price, 2);
    v_line_vat := case when v_vat_category = 'S'
      then round(v_line_net * v_vat_rate / 100, 2) else 0 end;

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

  -- ---- prelinkovanie zdrojového dokumentu ------------------------------
  -- Jediná cesta, ktorou v systéme vzniká document_links riadok s invoice_id.
  -- ON CONFLICT DO NOTHING kvôli idempotencii voči partial unique indexu
  -- document_links_invoice_document_uniq.
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
    v_invoice_id, 'created', v_user_id, 'user',
    jsonb_build_object(
      'direction', 'received',
      'source', 'ai_inbox',
      'supplier_invoice_number', v_number,
      'item_count', v_item_count
    )
  );

  return jsonb_build_object(
    'status', 'created',
    'invoice_id', v_invoice_id,
    'supplier_invoice_number', v_number,
    'item_count', v_item_count
  );
end;
$function$;

comment on function public.esblu_create_received_invoice_draft(uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) is
  'Atomické vytvorenie canonical received invoice DRAFTU z potvrdeného Inbox review: autorizácia (owner/finance.manage), tenant kontrola dodávateľa aj zdrojového dokumentu, dedupe vnútri transakcie (supplier+normalizované číslo+kind, dedupe_fingerprint, source_document), vloženie položiek s category-aware VAT, prelinkovanie document_links.invoice_id a audit event. Nikdy neprideľuje interné číslo, nikdy nefinalizuje, nikdy nedopĺňa VAT kategóriu/sadzbu ani dodávateľa. Pri zhode vracia {status:duplicate, existing_invoice_id} a druhá faktúra nevznikne.';

revoke execute on function public.esblu_create_received_invoice_draft(uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) from public;
revoke execute on function public.esblu_create_received_invoice_draft(uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) from anon;
grant execute on function public.esblu_create_received_invoice_draft(uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) to authenticated;

commit;
