-- =============================================================================
-- 20260921160000_partner_payment_identifiers.sql
--
-- eFaktúra readiness, fáza 1 — platobné identifikátory obchodného partnera.
--
-- NÁLEZ (reportovaný dvakrát ako blocker pred XML/UBL mapperom)
-- ------------------------------------------------------------
-- business_partners nemá iban ani bic. Pri PRIJATEJ faktúre je predávajúcim
-- dodávateľ, takže seller snapshot v invoice_parties nemal z čoho vziať
-- platobné údaje a ostával s IBAN = NULL. Pri vydanej faktúre to nevadilo —
-- tam je predávajúcim naša firma a company_billing_profile.iban existuje.
--
-- Dôsledok: EN16931 BT-84 (Payment account identifier) sa pre prijatú faktúru
-- nemal odkiaľ naplniť. invoice_parties.iban/bic stĺpce pritom existujú od
-- 20260916094000 — chýbal iba zdroj.
--
-- ČO SA MENÍ
-- ----------
--   1. business_partners.iban / .bic — nullable, expand-only, bez backfillu.
--   2. esblu_finalize_invoice() snapshotuje tieto hodnoty do seller party pri
--      direction='received'.
--
-- MASTER DATA vs SNAPSHOT (§11 zadania)
-- -------------------------------------
-- business_partners je MUTABLE kmeňové dáta. invoice_parties je IMMUTABLE
-- snapshot vytvorený presne raz pri finalizácii. Zmena IBAN-u dodávateľa v
-- kmeňových dátach preto NIKDY nezmení už finalizovanú faktúru — tá si nesie
-- hodnotu platnú v čase finalizácie. Renderer sa na live master data nepozerá
-- (docs/received-invoice-dedupe-en16931-design.md, zásada 3).
--
-- COUNTRY-NEUTRAL (§14)
-- ---------------------
-- Žiadna SK-špecifická validácia. IBAN/BIC sa ukladajú presne tak, ako ich
-- používateľ zadal — len bez medzier a veľkými písmenami, čo je kanonický
-- tvar podľa ISO 13616 / ISO 9362. Kontrolné číslice sa NEOVERUJÚ a banková
-- existencia sa neoveruje; to je vec platobnej vrstvy, nie evidencie.
-- =============================================================================

begin;

alter table public.business_partners
  add column if not exists iban text,
  add column if not exists bic text;

comment on column public.business_partners.iban is
  'EN16931 BT-84 zdroj pre seller snapshot pri direction=''received''. Kmeňové (mutable) dáta — finalizovaná faktúra si nesie vlastný immutable snapshot v invoice_parties.iban a zmena tu ju nikdy neovplyvní. Bez validácie kontrolných číslic a bez overovania existencie účtu.';

comment on column public.business_partners.bic is
  'EN16931 BT-86 zdroj pre seller snapshot pri direction=''received''. Rovnaká master/snapshot sémantika ako iban.';

-- Formát je zámerne VOĽNÝ (iba horná hranica dĺžky a povolená abeceda).
-- IBAN má podľa ISO 13616 max 34 znakov, BIC podľa ISO 9362 8 alebo 11.
-- Prísnejšia country-špecifická kontrola do evidencie nepatrí — zablokovala by
-- legitímne zahraničné účty, ktoré Esblu nemá ako poznať.
alter table public.business_partners
  drop constraint if exists business_partners_iban_format;
alter table public.business_partners
  add constraint business_partners_iban_format
  check (iban is null or iban ~ '^[A-Z0-9]{5,34}$');

alter table public.business_partners
  drop constraint if exists business_partners_bic_format;
alter table public.business_partners
  add constraint business_partners_bic_format
  check (bic is null or bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$');


-- ---------------------------------------------------------------------------
-- Snapshot pri finalizácii
-- ---------------------------------------------------------------------------
-- Zmena oproti 20260920140000 je JEDINÁ: received seller snapshot po novom
-- kopíruje bp.iban a bp.bic. Všetko ostatné (autorizácia, SELECT ... FOR
-- UPDATE, direction-aware validácia, číslovanie výhradne pre issued,
-- category-aware VAT, dedupe preklad unique violation, audit event) je
-- prevzaté bez zmeny.
create or replace function public.esblu_finalize_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_role text;
  v_inv_company_id uuid;
  v_direction text;
  v_kind text;
  v_document_status text;
  v_issue_date date;
  v_customer_business_partner_id uuid;
  v_supplier_business_partner_id uuid;
  v_supplier_invoice_number text;
  v_corrects_invoice_id uuid;
  v_rounding_amount numeric(18, 2);
  v_item_count integer;
  v_invalid_s_rate_count integer;
  v_counterparty_id uuid;
  v_series_key text;
  v_year integer;
  v_seq_id uuid;
  v_prefix text;
  v_suffix text;
  v_padding integer;
  v_allocated_number integer;
  v_invoice_number text;
  v_billing_company_id uuid;
  v_billing_legal_name text;
  v_bp_id uuid;
  v_bp_company_id uuid;
  v_corrected_company_id uuid;
  v_corrected_status text;
  v_corrected_direction text;
  v_subtotal numeric(18, 2);
  v_vat_total numeric(18, 2);
  v_total numeric(18, 2);
  v_finalized_at timestamptz;
  v_conflict_constraint text;
begin
  if p_invoice_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ARGUMENT';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  v_role := public.esblu_my_active_role();

  if v_company_id is null or v_role is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED',
      hint = 'Finalizácia vyžaduje owner alebo permissions.finance.manage=true.';
  end if;

  select i.company_id, i.direction, i.kind, i.document_status, i.issue_date,
         i.customer_business_partner_id, i.supplier_business_partner_id,
         i.supplier_invoice_number, i.corrects_invoice_id, i.rounding_amount
    into v_inv_company_id, v_direction, v_kind, v_document_status, v_issue_date,
         v_customer_business_partner_id, v_supplier_business_partner_id,
         v_supplier_invoice_number, v_corrects_invoice_id, v_rounding_amount
  from public.invoices i
  where i.id = p_invoice_id
  for update;

  if v_inv_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;

  if v_inv_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND',
      hint = 'Faktúra nepatrí do aktívnej firmy volajúceho.';
  end if;

  if v_document_status <> 'draft' then
    raise exception using
      errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_DRAFT',
      hint = 'Iba draft faktúra sa dá finalizovať — jednosmerný prechod.';
  end if;

  if v_issue_date is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ISSUE_DATE';
  end if;

  select count(*) into v_item_count
  from public.invoice_items where invoice_id = p_invoice_id;

  if v_item_count = 0 then
    raise exception using
      errcode = 'P0001', message = 'ESBLU_INVOICE_NO_ITEMS',
      hint = 'Faktúra musí mať aspoň jednu riadkovú položku.';
  end if;

  if v_direction = 'issued' then
    if v_customer_business_partner_id is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_BUSINESS_PARTNER';
    end if;
    v_counterparty_id := v_customer_business_partner_id;
  else
    if v_supplier_business_partner_id is null then
      raise exception using
        errcode = 'P0001', message = 'ESBLU_MISSING_SUPPLIER',
        hint = 'Prijatá faktúra musí mať priradeného dodávateľa (supplier_business_partner_id).';
    end if;

    if v_supplier_invoice_number is null or btrim(v_supplier_invoice_number) = '' then
      raise exception using
        errcode = 'P0001', message = 'ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER',
        hint = 'Prijatá faktúra musí mať číslo dokladu dodávateľa — Esblu jej nikdy neprideľuje vlastné číslo.';
    end if;

    v_counterparty_id := v_supplier_business_partner_id;
  end if;

  select bp.id, bp.company_id into v_bp_id, v_bp_company_id
  from public.business_partners bp where bp.id = v_counterparty_id;

  if v_bp_id is null or v_bp_company_id <> v_company_id then
    if v_direction = 'issued' then
      raise exception using
        errcode = 'P0001', message = 'ESBLU_BUSINESS_PARTNER_NOT_FOUND',
        hint = 'Obchodný partner neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
    else
      raise exception using
        errcode = 'P0001', message = 'ESBLU_SUPPLIER_NOT_FOUND',
        hint = 'Dodávateľ neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
    end if;
  end if;

  select cbp.company_id, cbp.legal_name
    into v_billing_company_id, v_billing_legal_name
  from public.company_billing_profile cbp where cbp.company_id = v_company_id;

  if v_billing_company_id is null or v_billing_legal_name is null
     or btrim(v_billing_legal_name) = '' then
    raise exception using
      errcode = 'P0001', message = 'ESBLU_MISSING_BILLING_PROFILE',
      hint = 'Firma nemá vyplnený company_billing_profile (vrátane obchodného mena) — doplňte v Nastaveniach pred finalizáciou.';
  end if;

  if v_kind in ('credit_note', 'debit_note') then
    select c.company_id, c.document_status, c.direction
      into v_corrected_company_id, v_corrected_status, v_corrected_direction
    from public.invoices c where c.id = v_corrects_invoice_id;

    if v_corrected_company_id is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTED_INVOICE_NOT_FOUND';
    end if;
    if v_corrected_company_id <> v_company_id then
      raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTED_INVOICE_FOREIGN_COMPANY';
    end if;
    if v_corrected_status <> 'finalized' then
      raise exception using
        errcode = 'P0001', message = 'ESBLU_CORRECTED_INVOICE_NOT_FINALIZED',
        hint = 'Opravný doklad môže odkazovať iba na už finalizovanú faktúru.';
    end if;
    if v_corrected_direction is distinct from v_direction then
      raise exception using
        errcode = 'P0001', message = 'ESBLU_CORRECTED_INVOICE_DIRECTION_MISMATCH',
        hint = 'Opravný doklad musí mať rovnaký smer (issued/received) ako opravovaná faktúra.';
    end if;
  end if;

  select count(*) into v_invalid_s_rate_count
  from public.invoice_items
  where invoice_id = p_invoice_id
    and vat_category_code = 'S'
    and (vat_rate is null or vat_rate < 0);

  if v_invalid_s_rate_count > 0 then
    raise exception using
      errcode = 'P0001', message = 'ESBLU_INVALID_S_VAT_RATE',
      hint = 'Kategória S (taxable/standard-rated) vyžaduje platnú nezápornú sadzbu DPH na každej položke.';
  end if;

  update public.invoice_items
  set
    line_net_amount = round(quantity * unit_price, 2),
    line_vat_amount = case
      when vat_category_code = 'S'
        then round(round(quantity * unit_price, 2) * vat_rate / 100, 2)
      else 0 end,
    line_gross_amount = round(quantity * unit_price, 2)
      + case when vat_category_code = 'S'
          then round(round(quantity * unit_price, 2) * vat_rate / 100, 2)
          else 0 end,
    updated_at = now()
  where invoice_id = p_invoice_id;

  delete from public.invoice_tax_breakdowns where invoice_id = p_invoice_id;

  insert into public.invoice_tax_breakdowns (
    invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount
  )
  select
    p_invoice_id, normalized.vat_category_code, normalized.effective_rate,
    sum(normalized.line_net_amount),
    case when normalized.vat_category_code = 'S'
      then round(sum(normalized.line_net_amount) * normalized.effective_rate / 100, 2)
      else 0 end
  from (
    select vat_category_code,
      case when vat_category_code = 'S' then vat_rate else 0 end as effective_rate,
      line_net_amount
    from public.invoice_items where invoice_id = p_invoice_id
  ) normalized
  group by normalized.vat_category_code, normalized.effective_rate;

  select coalesce(sum(line_net_amount), 0) into v_subtotal
  from public.invoice_items where invoice_id = p_invoice_id;

  select coalesce(sum(vat_amount), 0) into v_vat_total
  from public.invoice_tax_breakdowns where invoice_id = p_invoice_id;

  v_total := v_subtotal + v_vat_total + coalesce(v_rounding_amount, 0);

  if v_direction = 'issued' then
    v_series_key := case v_kind
      when 'credit_note' then 'credit_note'
      when 'debit_note' then 'debit_note'
      else 'regular' end;
    v_year := extract(year from v_issue_date)::integer;

    perform pg_advisory_xact_lock(
      hashtextextended(v_company_id::text || ':' || v_year::text || ':' || v_series_key, 0));

    insert into public.invoice_number_sequences (company_id, year, series_key, prefix)
    values (v_company_id, v_year, v_series_key,
      case v_series_key when 'credit_note' then 'DO' when 'debit_note' then 'ID' else 'FA' end)
    on conflict (company_id, year, series_key) do nothing;

    update public.invoice_number_sequences
    set next_number = next_number + 1, updated_at = now()
    where company_id = v_company_id and year = v_year and series_key = v_series_key
    returning id, prefix, suffix, padding, next_number - 1
      into v_seq_id, v_prefix, v_suffix, v_padding, v_allocated_number;

    v_invoice_number := coalesce(v_prefix, '') || v_year::text
      || lpad(v_allocated_number::text, v_padding, '0') || coalesce(v_suffix, '');
  end if;

  if v_direction = 'issued' then
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      iban, bic, email, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'seller', cbp.legal_name, cbp.ico, cbp.dic, cbp.ic_dph,
      cbp.address_line1, cbp.address_line2, cbp.city, cbp.postal_code, cbp.country_code,
      cbp.iban, cbp.bic, cbp.contact_email, null,
      cbp.electronic_address, cbp.electronic_address_scheme_id,
      cbp.legal_registration_id, cbp.legal_registration_scheme_id,
      cbp.vat_identifier, cbp.generic_identifier, cbp.generic_identifier_scheme_id
    from public.company_billing_profile cbp where cbp.company_id = v_company_id;

    -- Buyer pri VYDANEJ faktúre je odberateľ. Jeho iban/bic sa zámerne
    -- NESNAPSHOTUJE — pri vydanej faktúre platí odberateľ nám, takže jeho
    -- účet nie je platobný údaj dokladu. Ponechané byte-identicky s
    -- 20260920140000, aby sa správanie vydaných faktúr touto migráciou
    -- vôbec nezmenilo.
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      email, peppol_identifier, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'buyer', bp.legal_name, bp.ico, bp.dic, bp.ic_dph,
      bp.address_line1, bp.address_line2, bp.city, bp.postal_code, bp.country_code,
      bp.email, bp.peppol_identifier, bp.id,
      bp.electronic_address, bp.electronic_address_scheme_id,
      bp.legal_registration_id, bp.legal_registration_scheme_id,
      bp.vat_identifier, bp.generic_identifier, bp.generic_identifier_scheme_id
    from public.business_partners bp where bp.id = v_counterparty_id;
  else
    -- ZMENA TEJTO MIGRÁCIE: seller (dodávateľ) po novom nesie aj iban/bic.
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      iban, bic, email, peppol_identifier, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'seller', bp.legal_name, bp.ico, bp.dic, bp.ic_dph,
      bp.address_line1, bp.address_line2, bp.city, bp.postal_code, bp.country_code,
      bp.iban, bp.bic, bp.email, bp.peppol_identifier, bp.id,
      bp.electronic_address, bp.electronic_address_scheme_id,
      bp.legal_registration_id, bp.legal_registration_scheme_id,
      bp.vat_identifier, bp.generic_identifier, bp.generic_identifier_scheme_id
    from public.business_partners bp where bp.id = v_counterparty_id;

    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      iban, bic, email, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'buyer', cbp.legal_name, cbp.ico, cbp.dic, cbp.ic_dph,
      cbp.address_line1, cbp.address_line2, cbp.city, cbp.postal_code, cbp.country_code,
      cbp.iban, cbp.bic, cbp.contact_email, null,
      cbp.electronic_address, cbp.electronic_address_scheme_id,
      cbp.legal_registration_id, cbp.legal_registration_scheme_id,
      cbp.vat_identifier, cbp.generic_identifier, cbp.generic_identifier_scheme_id
    from public.company_billing_profile cbp where cbp.company_id = v_company_id;
  end if;

  begin
    update public.invoices
    set
      invoice_number = v_invoice_number,
      invoice_number_sequence_id = v_seq_id,
      subtotal_amount = v_subtotal,
      vat_total_amount = v_vat_total,
      total_amount = v_total,
      document_status = 'finalized',
      finalized_at = now(),
      finalized_by = auth.uid(),
      updated_at = now(),
      updated_by = auth.uid()
    where id = p_invoice_id
    returning finalized_at into v_finalized_at;
  exception
    when unique_violation then
      get stacked diagnostics v_conflict_constraint = constraint_name;
      if v_conflict_constraint in (
        'invoices_received_supplier_number_uniq',
        'invoices_dedupe_fingerprint_uniq',
        'invoices_transport_message_uniq'
      ) then
        raise exception using
          errcode = 'P0001', message = 'ESBLU_DUPLICATE_RECEIVED_INVOICE',
          hint = 'Doklad s rovnakou identitou (dodávateľ + číslo dokladu + typ) už je vo firme finalizovaný.';
      end if;
      raise;
  end;

  insert into public.invoice_events (
    invoice_id, event_type, actor_user_id, actor_source, payload
  )
  values (
    p_invoice_id, 'finalized', auth.uid(), 'user',
    jsonb_build_object(
      'direction', v_direction,
      'invoice_number', v_invoice_number,
      'supplier_invoice_number', v_supplier_invoice_number,
      'total_amount', v_total,
      'currency', null)
  );

  return jsonb_build_object(
    'invoice_id', p_invoice_id,
    'direction', v_direction,
    'invoice_number', v_invoice_number,
    'supplier_invoice_number', v_supplier_invoice_number,
    'subtotal_amount', v_subtotal,
    'vat_total_amount', v_vat_total,
    'total_amount', v_total,
    'finalized_at', v_finalized_at);
end;
$function$;

comment on function public.esblu_finalize_invoice(uuid) is
  'Atomická, DIRECTION-AWARE finalizácia draft faktúry. issued: číslo z interného radu Esblu, seller = company_billing_profile, buyer = odberateľ. received: ŽIADNA alokácia radu, identitu tvorí supplier_invoice_number, seller = dodávateľ (vrátane iban/bic od 20260921160000), buyer = naša firma. Snapshot strán je immutable a nikdy sa nečíta z live master data.';

revoke execute on function public.esblu_finalize_invoice(uuid) from public;
revoke execute on function public.esblu_finalize_invoice(uuid) from anon;
grant execute on function public.esblu_finalize_invoice(uuid) to authenticated;

commit;
