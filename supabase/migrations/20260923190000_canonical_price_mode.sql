-- =============================================================================
-- KANONICKÝ PEŇAŽNÝ MODEL: `price_mode` na riadku faktúry
--
-- PREČO
-- -----
-- Z produkcie: používateľ nadiktoval tri položky so sumami S DAŇOU —
-- 750 + 250 + 800 = 1800,00 € pri 23 %. Esblu ukázalo:
--
--     základ 1463,42 + daň 336,59 = spolu 1800,01
--
-- O cent viac, než človek povedal. Príčina: cena s daňou sa prepočítala na
-- základ PO RIADKOCH a každý riadok sa zaokrúhlil zvlášť (609,76 + 203,25 +
-- 650,41 = 1463,42), no daň sa podľa EN16931 BR-CO-17 počíta zo ZOSČÍTANÉHO
-- základu — round(1463,42 × 23 %) = 336,59. Dve nezávislé zaokrúhlenia, obe
-- „správne", dokopy o cent vedľa. A vyslovená suma 1800,00 nebola v modeli
-- uložená nikde, takže sa to nemalo o čo oprieť.
--
-- ČO SA MENÍ
-- ----------
-- `unit_price` zostáva JEDINÉ cenové pole. Pribúda `price_mode`, ktorý
-- hovorí, ako sa má čítať. Dve cenové polia vedľa seba by boli dva zdroje
-- pravdy a tie sa raz rozídu.
--
--   price_mode = 'net'    → unit_price je cena BEZ dane (doterajší význam)
--                           autoritatívne: line_net_amount
--   price_mode = 'gross'  → unit_price je cena S DAŇOU, ako ju človek povedal
--                           autoritatívne: line_gross_amount
--
-- ADITÍVNE A SPÄTNE KOMPATIBILNÉ
-- ------------------------------
-- Predvolená hodnota je 'net'. Všetky existujúce riadky — vrátane
-- finalizovaných FA20260001 a prijatej faktúry — teda znamenajú presne to,
-- čo znamenali včera, a ich čísla sa nikde neprepočítavajú. Táto migrácia
-- NEPREPISUJE ani jeden existujúci peňažný údaj.
--
-- Privilégiá sa nerozširujú: nový stĺpec dedí granty tabuľky, ktoré boli
-- utiahnuté v 20260923170000. Žiadne PUBLIC/anon.
-- =============================================================================

alter table public.invoice_items
  add column if not exists price_mode text not null default 'net';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoice_items'::regclass
      and conname = 'invoice_items_price_mode_check'
  ) then
    alter table public.invoice_items
      add constraint invoice_items_price_mode_check
      check (price_mode in ('net', 'gross'));
  end if;
end $$;

comment on column public.invoice_items.price_mode is
  'Ako sa má čítať unit_price: net = cena bez dane (autoritatívny je line_net_amount), gross = cena s daňou tak, ako ju zadal používateľ (autoritatívny je line_gross_amount). Pozri lib/invoicing/vat-engine.ts — KANONICKÝ PEŇAŽNÝ MODEL.';

-- =============================================================================
-- esblu_finalize_invoice — peňažná časť prepísaná podľa kanonického modelu
--
-- Zvyšok funkcie (autorizácia, kontroly, číslovanie, snapshot strán,
-- udalosti) je NEZMENENÝ. Mení sa výhradne to, ako sa počítajú riadkové
-- sumy, rozpis dane a súčty.
--
-- ZAOKRÚHĽUJE SA PRESNE DVAKRÁT
--   1. raz na riadok:  round(quantity × unit_price, 2)  = autoritatívna suma
--   2. raz na skupinu (kategória + sadzba + režim):
--        net   → daň     = round(základ × sadzba / 100, 2)     [BR-CO-17]
--        gross → základ  = round(suma s daňou / (1 + sadzba/100), 2)
--                daň     = suma s daňou − základ
--
-- Dopočítaná riadková zložka sa NEZAOKRÚHĽUJE samostatne — rozdeľuje sa zo
-- skupinového čísla pravidlom najväčších zvyškov, pri zhode rozhoduje
-- `position`. To isté pravidlo v tom istom poradí má aj JS engine
-- (`allocateByLargestRemainder` v lib/invoicing/vat-engine.ts), takže koncept
-- a finalizácia sa nemôžu rozísť.
--
-- Pre doklad, kde sú všetky riadky 'net', vychádzajú VŠETKY súčty presne ako
-- v doterajšej verzii.
-- =============================================================================

create or replace function public.esblu_finalize_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid; v_role text; v_inv_company_id uuid; v_direction text; v_kind text;
  v_document_status text; v_issue_date date; v_customer_business_partner_id uuid;
  v_supplier_business_partner_id uuid; v_supplier_invoice_number text;
  v_corrects_invoice_id uuid; v_rounding_amount numeric(18,2);
  v_item_count integer; v_invalid_s_rate_count integer; v_counterparty_id uuid;
  v_series_key text; v_year integer; v_seq_id uuid; v_prefix text; v_suffix text;
  v_padding integer; v_allocated_number integer; v_invoice_number text;
  v_billing_company_id uuid; v_billing_legal_name text; v_bp_id uuid; v_bp_company_id uuid;
  v_corrected_company_id uuid; v_corrected_status text; v_corrected_direction text;
  v_subtotal numeric(18,2); v_vat_total numeric(18,2); v_total numeric(18,2);
  v_line_gross_sum numeric(18,2);
  v_finalized_at timestamptz; v_conflict_constraint text;
begin
  if p_invoice_id is null then
    raise exception using errcode='P0001', message='ESBLU_MISSING_ARGUMENT';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  v_role := public.esblu_my_active_role();
  if v_company_id is null or v_role is null then
    raise exception using errcode='P0001', message='ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if not public.esblu_my_finance_manage() then
    raise exception using errcode='P0001', message='ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED',
      hint='Finalizácia vyžaduje owner alebo permissions.finance.manage=true.';
  end if;

  select i.company_id, i.direction, i.kind, i.document_status, i.issue_date,
         i.customer_business_partner_id, i.supplier_business_partner_id,
         i.supplier_invoice_number, i.corrects_invoice_id, i.rounding_amount
    into v_inv_company_id, v_direction, v_kind, v_document_status, v_issue_date,
         v_customer_business_partner_id, v_supplier_business_partner_id,
         v_supplier_invoice_number, v_corrects_invoice_id, v_rounding_amount
  from public.invoices i where i.id = p_invoice_id for update;

  if v_inv_company_id is null then
    raise exception using errcode='P0001', message='ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv_company_id <> v_company_id then
    raise exception using errcode='P0001', message='ESBLU_INVOICE_NOT_FOUND',
      hint='Faktúra nepatrí do aktívnej firmy volajúceho.';
  end if;
  if v_document_status <> 'draft' then
    raise exception using errcode='P0001', message='ESBLU_INVOICE_NOT_DRAFT',
      hint='Iba draft faktúra sa dá finalizovať — jednosmerný prechod.';
  end if;
  if v_issue_date is null then
    raise exception using errcode='P0001', message='ESBLU_MISSING_ISSUE_DATE';
  end if;

  select count(*) into v_item_count from public.invoice_items where invoice_id = p_invoice_id;
  if v_item_count = 0 then
    raise exception using errcode='P0001', message='ESBLU_INVOICE_NO_ITEMS',
      hint='Faktúra musí mať aspoň jednu riadkovú položku.';
  end if;

  if v_direction = 'issued' then
    if v_customer_business_partner_id is null then
      raise exception using errcode='P0001', message='ESBLU_MISSING_BUSINESS_PARTNER';
    end if;
    v_counterparty_id := v_customer_business_partner_id;
  else
    if v_supplier_business_partner_id is null then
      raise exception using errcode='P0001', message='ESBLU_MISSING_SUPPLIER',
        hint='Prijatá faktúra musí mať priradeného dodávateľa (supplier_business_partner_id).';
    end if;
    if v_supplier_invoice_number is null or btrim(v_supplier_invoice_number) = '' then
      raise exception using errcode='P0001', message='ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER',
        hint='Prijatá faktúra musí mať číslo dokladu dodávateľa — Esblu jej nikdy neprideľuje vlastné číslo.';
    end if;
    v_counterparty_id := v_supplier_business_partner_id;
  end if;

  select bp.id, bp.company_id into v_bp_id, v_bp_company_id
  from public.business_partners bp where bp.id = v_counterparty_id;
  if v_bp_id is null or v_bp_company_id <> v_company_id then
    if v_direction = 'issued' then
      raise exception using errcode='P0001', message='ESBLU_BUSINESS_PARTNER_NOT_FOUND',
        hint='Obchodný partner neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
    else
      raise exception using errcode='P0001', message='ESBLU_SUPPLIER_NOT_FOUND',
        hint='Dodávateľ neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
    end if;
  end if;

  select cbp.company_id, cbp.legal_name into v_billing_company_id, v_billing_legal_name
  from public.company_billing_profile cbp where cbp.company_id = v_company_id;
  if v_billing_company_id is null or v_billing_legal_name is null or btrim(v_billing_legal_name) = '' then
    raise exception using errcode='P0001', message='ESBLU_MISSING_BILLING_PROFILE',
      hint='Firma nemá vyplnený company_billing_profile (vrátane obchodného mena) — doplňte v Nastaveniach pred finalizáciou.';
  end if;

  if v_kind in ('credit_note','debit_note') then
    select c.company_id, c.document_status, c.direction
      into v_corrected_company_id, v_corrected_status, v_corrected_direction
    from public.invoices c where c.id = v_corrects_invoice_id;
    if v_corrected_company_id is null then
      raise exception using errcode='P0001', message='ESBLU_CORRECTED_INVOICE_NOT_FOUND';
    end if;
    if v_corrected_company_id <> v_company_id then
      raise exception using errcode='P0001', message='ESBLU_CORRECTED_INVOICE_FOREIGN_COMPANY';
    end if;
    if v_corrected_status <> 'finalized' then
      raise exception using errcode='P0001', message='ESBLU_CORRECTED_INVOICE_NOT_FINALIZED',
        hint='Opravný doklad môže odkazovať iba na už finalizovanú faktúru.';
    end if;
    if v_corrected_direction is distinct from v_direction then
      raise exception using errcode='P0001', message='ESBLU_CORRECTED_INVOICE_DIRECTION_MISMATCH',
        hint='Opravný doklad musí mať rovnaký smer (issued/received) ako opravovaná faktúra.';
    end if;
  end if;

  select count(*) into v_invalid_s_rate_count from public.invoice_items
  where invoice_id = p_invoice_id and vat_category_code='S' and (vat_rate is null or vat_rate < 0);
  if v_invalid_s_rate_count > 0 then
    raise exception using errcode='P0001', message='ESBLU_INVALID_S_VAT_RATE',
      hint='Kategória S (taxable/standard-rated) vyžaduje platnú nezápornú sadzbu DPH na každej položke.';
  end if;

  -- ---------------------------------------------------------------------------
  -- Peňažný prepočet podľa kanonického modelu.
  -- ---------------------------------------------------------------------------
  with base as (
    select id, position, vat_category_code, price_mode,
           case when vat_category_code = 'S' then vat_rate else 0 end as eff_rate,
           -- Jediné riadkové zaokrúhlenie. V režime net je to základ, v režime
           -- gross suma s daňou — podľa toho, čo používateľ zadal.
           round(quantity * unit_price, 2) as auth_amount
    from public.invoice_items
    where invoice_id = p_invoice_id
  ),
  bucket as (
    select vat_category_code, price_mode, eff_rate,
           sum(auth_amount) as auth_sum,
           case when price_mode = 'gross'
                then round(sum(auth_amount) / (1 + eff_rate / 100), 2)
                else sum(auth_amount)
           end as taxable,
           case when price_mode = 'gross'
                then sum(auth_amount) - round(sum(auth_amount) / (1 + eff_rate / 100), 2)
                else round(sum(auth_amount) * eff_rate / 100, 2)
           end as vat
    from base
    group by vat_category_code, price_mode, eff_rate
  ),
  -- Podiel riadku na skupinovom čísle, v centoch, presne (numeric, nie float).
  share as (
    select b.id, b.position, b.price_mode, b.auth_amount,
           b.vat_category_code, b.eff_rate,
           case when round(k.auth_sum * 100) = 0 then 0
                else round(b.auth_amount * 100)
                     * (case when b.price_mode = 'gross' then round(k.taxable * 100)
                                                          else round(k.vat * 100) end)
                     / round(k.auth_sum * 100)
           end as raw_cents
    from base b
    join bucket k
      on k.vat_category_code = b.vat_category_code
     and k.price_mode        = b.price_mode
     and k.eff_rate          = b.eff_rate
  ),
  -- Pravidlo najväčších zvyškov. Pri zhode zvyškov rozhoduje position.
  ranked as (
    select s.*,
           floor(s.raw_cents) as floor_cents,
           row_number() over (
             partition by s.vat_category_code, s.price_mode, s.eff_rate
             order by (s.raw_cents - floor(s.raw_cents)) desc, s.position asc
           ) as rn,
           sum(floor(s.raw_cents)) over (
             partition by s.vat_category_code, s.price_mode, s.eff_rate
           ) as floor_sum
    from share s
  ),
  allocated as (
    select r.id, r.price_mode, r.auth_amount,
           (r.floor_cents
             + case when r.rn <= (
                 case when r.price_mode = 'gross' then round(k.taxable * 100)
                                                   else round(k.vat * 100) end
               ) - r.floor_sum then 1 else 0 end
           ) / 100 as allocated_amount
    from ranked r
    join bucket k
      on k.vat_category_code = r.vat_category_code
     and k.price_mode        = r.price_mode
     and k.eff_rate          = r.eff_rate
  )
  update public.invoice_items ii
  set line_net_amount = case when a.price_mode = 'gross'
                             then a.allocated_amount else a.auth_amount end,
      line_vat_amount = case when a.price_mode = 'gross'
                             then a.auth_amount - a.allocated_amount else a.allocated_amount end,
      line_gross_amount = case when a.price_mode = 'gross'
                               then a.auth_amount else a.auth_amount + a.allocated_amount end,
      updated_at = now()
  from allocated a
  where ii.id = a.id;

  delete from public.invoice_tax_breakdowns where invoice_id = p_invoice_id;

  -- Rozpis dane: režimy sa spájajú pod jednu kategóriu a sadzbu, ale skupinové
  -- čísla sa berú z riadkov, ktoré sa práve zapísali — nie z druhého výpočtu.
  insert into public.invoice_tax_breakdowns (invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount)
  select p_invoice_id, n.vat_category_code, n.eff_rate,
         sum(n.line_net_amount), sum(n.line_vat_amount)
  from (
    select vat_category_code,
           case when vat_category_code = 'S' then vat_rate else 0 end as eff_rate,
           line_net_amount, line_vat_amount
    from public.invoice_items where invoice_id = p_invoice_id
  ) n
  group by n.vat_category_code, n.eff_rate;

  select coalesce(sum(line_net_amount),0), coalesce(sum(line_vat_amount),0),
         coalesce(sum(line_gross_amount),0)
    into v_subtotal, v_vat_total, v_line_gross_sum
  from public.invoice_items where invoice_id = p_invoice_id;

  v_total := v_subtotal + v_vat_total + coalesce(v_rounding_amount,0);

  -- Fail-closed: ak sa základ + daň nerovná súčtu riadkových súm s daňou,
  -- doklad sa NEVYSTAVÍ. Radšej žiadna faktúra než faktúra, ktorá sa
  -- nerovná sama sebe. Za normálnych okolností sa to stať nemôže — práve
  -- preto to tu je.
  if v_subtotal + v_vat_total <> v_line_gross_sum then
    raise exception using errcode='P0001', message='ESBLU_TOTALS_DO_NOT_RECONCILE',
      hint='Základ + daň sa nerovná súčtu riadkových súm — doklad sa nevystavil.';
  end if;

  if v_direction = 'issued' then
    v_series_key := case v_kind when 'credit_note' then 'credit_note' when 'debit_note' then 'debit_note' else 'regular' end;
    v_year := extract(year from v_issue_date)::integer;
    perform pg_advisory_xact_lock(hashtextextended(v_company_id::text||':'||v_year::text||':'||v_series_key,0));
    insert into public.invoice_number_sequences (company_id, year, series_key, prefix)
    values (v_company_id, v_year, v_series_key,
      case v_series_key when 'credit_note' then 'DO' when 'debit_note' then 'ID' else 'FA' end)
    on conflict (company_id, year, series_key) do nothing;
    update public.invoice_number_sequences set next_number = next_number+1, updated_at = now()
    where company_id=v_company_id and year=v_year and series_key=v_series_key
    returning id, prefix, suffix, padding, next_number-1
      into v_seq_id, v_prefix, v_suffix, v_padding, v_allocated_number;
    v_invoice_number := coalesce(v_prefix,'')||v_year::text||lpad(v_allocated_number::text,v_padding,'0')||coalesce(v_suffix,'');
  end if;

  if v_direction = 'issued' then
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code,
      country_code, iban, bic, email, source_business_partner_id, electronic_address,
      electronic_address_scheme_id, legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id)
    select p_invoice_id,'seller',cbp.legal_name,cbp.ico,cbp.dic,cbp.ic_dph,cbp.address_line1,
      cbp.address_line2,cbp.city,cbp.postal_code,cbp.country_code,cbp.iban,cbp.bic,cbp.contact_email,null,
      cbp.electronic_address,cbp.electronic_address_scheme_id,cbp.legal_registration_id,
      cbp.legal_registration_scheme_id,cbp.vat_identifier,cbp.generic_identifier,cbp.generic_identifier_scheme_id
    from public.company_billing_profile cbp where cbp.company_id = v_company_id;

    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code,
      country_code, email, peppol_identifier, source_business_partner_id, electronic_address,
      electronic_address_scheme_id, legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id)
    select p_invoice_id,'buyer',bp.legal_name,bp.ico,bp.dic,bp.ic_dph,bp.address_line1,bp.address_line2,
      bp.city,bp.postal_code,bp.country_code,bp.email,bp.peppol_identifier,bp.id,
      bp.electronic_address,bp.electronic_address_scheme_id,bp.legal_registration_id,
      bp.legal_registration_scheme_id,bp.vat_identifier,bp.generic_identifier,bp.generic_identifier_scheme_id
    from public.business_partners bp where bp.id = v_counterparty_id;
  else
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code,
      country_code, iban, bic, email, peppol_identifier, source_business_partner_id, electronic_address,
      electronic_address_scheme_id, legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id)
    select p_invoice_id,'seller',bp.legal_name,bp.ico,bp.dic,bp.ic_dph,bp.address_line1,bp.address_line2,
      bp.city,bp.postal_code,bp.country_code,bp.iban,bp.bic,bp.email,bp.peppol_identifier,bp.id,
      bp.electronic_address,bp.electronic_address_scheme_id,bp.legal_registration_id,
      bp.legal_registration_scheme_id,bp.vat_identifier,bp.generic_identifier,bp.generic_identifier_scheme_id
    from public.business_partners bp where bp.id = v_counterparty_id;

    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code,
      country_code, iban, bic, email, source_business_partner_id, electronic_address,
      electronic_address_scheme_id, legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id)
    select p_invoice_id,'buyer',cbp.legal_name,cbp.ico,cbp.dic,cbp.ic_dph,cbp.address_line1,
      cbp.address_line2,cbp.city,cbp.postal_code,cbp.country_code,cbp.iban,cbp.bic,cbp.contact_email,null,
      cbp.electronic_address,cbp.electronic_address_scheme_id,cbp.legal_registration_id,
      cbp.legal_registration_scheme_id,cbp.vat_identifier,cbp.generic_identifier,cbp.generic_identifier_scheme_id
    from public.company_billing_profile cbp where cbp.company_id = v_company_id;
  end if;

  begin
    update public.invoices
    set invoice_number=v_invoice_number, invoice_number_sequence_id=v_seq_id,
        subtotal_amount=v_subtotal, vat_total_amount=v_vat_total, total_amount=v_total,
        document_status='finalized', finalized_at=now(), finalized_by=auth.uid(),
        updated_at=now(), updated_by=auth.uid()
    where id=p_invoice_id returning finalized_at into v_finalized_at;
  exception when unique_violation then
    get stacked diagnostics v_conflict_constraint = constraint_name;
    if v_conflict_constraint in ('invoices_received_supplier_number_uniq',
       'invoices_dedupe_fingerprint_uniq','invoices_transport_message_uniq') then
      raise exception using errcode='P0001', message='ESBLU_DUPLICATE_RECEIVED_INVOICE',
        hint='Doklad s rovnakou identitou (dodávateľ + číslo dokladu + typ) už je vo firme finalizovaný.';
    end if;
    raise;
  end;

  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id,'finalized',auth.uid(),'user',
    jsonb_build_object('direction',v_direction,'invoice_number',v_invoice_number,
      'supplier_invoice_number',v_supplier_invoice_number,'total_amount',v_total,'currency',null));

  return jsonb_build_object('invoice_id',p_invoice_id,'direction',v_direction,
    'invoice_number',v_invoice_number,'supplier_invoice_number',v_supplier_invoice_number,
    'subtotal_amount',v_subtotal,'vat_total_amount',v_vat_total,'total_amount',v_total,
    'finalized_at',v_finalized_at);
end;
$function$;
