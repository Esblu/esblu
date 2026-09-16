-- =============================================================================
-- Fáza 2 pokračovanie — DB-level defense-in-depth pre VAT category semantics
-- v esblu_finalize_invoice().
--
-- PROBLÉM (audit): klientský VAT engine (lib/invoicing/vat-engine.ts) a UI
-- (app/faktury/InvoiceDetailView.tsx) už správne rozlišujú:
--   S  = taxable / standard-rated — vat_rate je skutočné percento
--   Z  = zero rate
--   E  = exempt
--   AE = reverse charge
-- a pre Z/E/AE klient VŽDY počíta vat_amount = 0, nezávisle od uloženej
-- vat_rate hodnoty.
--
-- Autoritatívna DB finalizácia (esblu_finalize_invoice, migrácia
-- 20260916095000) však doteraz počítala VAT univerzálne ako
-- `line_net_amount * vat_rate / 100` bez ohľadu na vat_category_code — pri
-- stray (nesprávne ponechanej) nenulovej vat_rate na Z/E/AE riadku by teda
-- DB finalizovala NESPRÁVNU nenulovú VAT sumu, hoci UI by ukazovalo 0.
-- Klient nie je authority — toto je preto skutočný security/financial
-- correctness gap, nie iba kozmetický UI problém.
--
-- OPRAVA (táto migrácia, CREATE OR REPLACE FUNCTION — expand-only, PÔVODNÁ
-- migrácia 20260916095000 sa nemení):
--   1. Explicitný fail-closed check pre S: vat_rate musí byť NOT NULL a >= 0
--      (v praxi už garantované stĺpcovým `invoice_items.vat_rate numeric(7,4)
--      not null default 0 check (vat_rate >= 0)` — tento check je preto
--      defense-in-depth s jasnou ESBLU_INVALID_S_VAT_RATE chybou, nie jediná
--      linka obrany).
--   2. line_vat_amount/line_gross_amount: pre kategórie iné než S je vat
--      časť VŽDY 0, nezávisle od uloženej vat_rate.
--   3. invoice_tax_breakdowns: zoskupovanie podľa NORMALIZOVANEJ (nie
--      surovej) sadzby — S zostáva zoskupené podľa skutočnej sadzby (BR-CO-17
--      nezmenené), Z/E/AE sa VŽDY zlúčia do jednej skupiny per kategória s
--      vat_rate=0/vat_amount=0, bez ohľadu na prípadné historické rozdielne
--      stray hodnoty v jednotlivých riadkoch. Kategórie Z/E/AE sa NIKDY
--      navzájom nemiešajú — každá zostáva samostatný riadok v breakdown.
--      Uložená vat_rate=0 pre Z/E/AE je iba technická hodnota v NOT NULL
--      stĺpci — právny význam určuje vat_category_code.
--   4. vat_total_amount/total_amount sú odvodené z týchto opravených súčtov
--      (rovnaký kód ako predtým, bez zmeny) — nemôže nastať stav, kde by
--      UI ukazovalo AE→0 VAT, ale DB finalizovala nenulovú VAT.
--
-- MIMO ROZSAHU (zámerne): neprepisuje sa uložená invoice_items.vat_rate
-- hodnota pre Z/E/AE riadky (iba line_vat_amount/line_gross_amount a
-- breakdown sú category-aware) — ide výhradne o autoritatívne SUMY, nie
-- o bulk-scrubbing historických dát. Žiadne historické drafty, produkčné
-- VAT defaults, client-side UX, numbering, RLS ani payment flow sa touto
-- migráciou nemenia.
--
-- Zachované beze zmeny: SECURITY DEFINER, SET search_path TO '', plne
-- kvalifikované názvy tabuliek, autorizácia cez esblu_my_finance_manage(),
-- SELECT...FOR UPDATE zámok, atomická transakcia, pg_advisory_xact_lock
-- číslovanie, immutable snapshot strán, jednosmerný draft→finalized prechod,
-- invoice_events audit log, explicit revoke/grant.
-- =============================================================================

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
  v_corrects_invoice_id uuid;
  v_rounding_amount numeric(18, 2);

  v_item_count integer;
  v_invalid_s_rate_count integer;

  v_series_key text;
  v_year integer;
  v_seq_id uuid;
  v_prefix text;
  v_suffix text;
  v_padding integer;
  v_allocated_number integer;
  v_invoice_number text;

  v_billing_company_id uuid;
  v_bp_id uuid;
  v_bp_company_id uuid;

  v_corrected_company_id uuid;
  v_corrected_status text;

  v_subtotal numeric(18, 2);
  v_vat_total numeric(18, 2);
  v_total numeric(18, 2);
  v_finalized_at timestamptz;
begin
  if p_invoice_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_ARGUMENT';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  v_role := public.esblu_my_active_role();

  if v_company_id is null or v_role is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED',
      hint = 'Finalizácia vyžaduje owner alebo permissions.finance.manage=true.';
  end if;

  -- SELECT ... FOR UPDATE — zamyká riadok faktúry na dĺžku transakcie.
  -- Presne ten istý dôvod ako v esblu_finalize_vehicle_document(): bez
  -- tohto zámku by dve súbežné finalize volania nad tou istou faktúrou
  -- mohli obe prejsť kontrolou document_status='draft' ešte pred commitom
  -- tej druhej.
  select i.company_id, i.direction, i.kind, i.document_status, i.issue_date,
         i.customer_business_partner_id, i.corrects_invoice_id, i.rounding_amount
    into v_inv_company_id, v_direction, v_kind, v_document_status, v_issue_date,
         v_customer_business_partner_id, v_corrects_invoice_id, v_rounding_amount
  from public.invoices i
  where i.id = p_invoice_id
  for update;

  if v_inv_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;

  if v_inv_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_FOUND',
      hint = 'Faktúra nepatrí do aktívnej firmy volajúceho.';
  end if;

  if v_document_status <> 'draft' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_DRAFT',
      hint = 'Iba draft faktúra sa dá finalizovať — jednosmerný prechod.';
  end if;

  -- Povinné polia.
  if v_issue_date is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_ISSUE_DATE';
  end if;

  select count(*) into v_item_count
  from public.invoice_items
  where invoice_id = p_invoice_id;

  if v_item_count = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NO_ITEMS',
      hint = 'Faktúra musí mať aspoň jednu riadkovú položku.';
  end if;

  -- Business partner (protistrana) — vyžadovaný bez ohľadu na direction.
  if v_customer_business_partner_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_BUSINESS_PARTNER';
  end if;

  select bp.id, bp.company_id into v_bp_id, v_bp_company_id
  from public.business_partners bp
  where bp.id = v_customer_business_partner_id;

  if v_bp_id is null or v_bp_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_BUSINESS_PARTNER_NOT_FOUND',
      hint = 'Obchodný partner neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
  end if;

  -- Company billing profile — vyžadovaný bez ohľadu na direction (je buď
  -- seller alebo buyer, vždy jedna zo strán).
  select cbp.company_id into v_billing_company_id
  from public.company_billing_profile cbp
  where cbp.company_id = v_company_id;

  if v_billing_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_BILLING_PROFILE',
      hint = 'Firma nemá vyplnený company_billing_profile — doplňte v Nastaveniach pred finalizáciou.';
  end if;

  -- Opravné doklady musia odkazovať na finalizovanú faktúru tej istej
  -- firmy (invoices CHECK constraint už vynucuje, že corrects_invoice_id
  -- je NOT NULL pre credit_note/debit_note — toto je finalize-time
  -- validácia SAMOTNÉHO odkazovaného dokladu).
  if v_kind in ('credit_note', 'debit_note') then
    select c.company_id, c.document_status into v_corrected_company_id, v_corrected_status
    from public.invoices c
    where c.id = v_corrects_invoice_id;

    if v_corrected_company_id is null then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_CORRECTED_INVOICE_NOT_FOUND';
    end if;

    if v_corrected_company_id <> v_company_id then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_CORRECTED_INVOICE_FOREIGN_COMPANY';
    end if;

    if v_corrected_status <> 'finalized' then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_CORRECTED_INVOICE_NOT_FINALIZED',
        hint = 'Opravný doklad môže odkazovať iba na už finalizovanú faktúru.';
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- VAT category semantics fail-closed check (audit dodatok): S je JEDINÁ
  -- kategória, kde má vat_rate skutočný percentuálny význam — musí byť
  -- NOT NULL a >= 0. V praxi to už garantuje stĺpcový CHECK na
  -- invoice_items.vat_rate (not null default 0 check (vat_rate >= 0)),
  -- takže táto vetva je defense-in-depth s jasnou ESBLU_* chybou, nikdy
  -- jediná linka obrany. Z/E/AE sem zámerne nepatria — pre ne je vat_rate
  -- iba technická hodnota (viď nižšie), nie business validácia.
  -- ---------------------------------------------------------------------
  select count(*) into v_invalid_s_rate_count
  from public.invoice_items
  where invoice_id = p_invoice_id
    and vat_category_code = 'S'
    and (vat_rate is null or vat_rate < 0);

  if v_invalid_s_rate_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_S_VAT_RATE',
      hint = 'Kategória S (taxable/standard-rated) vyžaduje platnú nezápornú sadzbu DPH na každej položke.';
  end if;

  -- ---------------------------------------------------------------------
  -- Autoritatívny prepočet (nikdy sa nedôveruje klientom poslaným sumám).
  -- Rodičovská faktúra je tu ešte 'draft', takže immutability trigger na
  -- invoice_items tento UPDATE nijako neobmedzuje.
  --
  -- VAT category semantics: iba S (taxable/standard-rated) interpretuje
  -- vat_rate ako percento. Z (zero rate), E (exempt) a AE (reverse charge)
  -- majú vat_amount VŽDY 0 — kategória samotná to určuje, nezávisle od
  -- akejkoľvek (aj stray/historickej) hodnoty vo vat_rate stĺpci danej
  -- položky. Toto je presne replikované z klientského VAT engine
  -- (effectiveVatRate() v lib/invoicing/vat-engine.ts).
  -- ---------------------------------------------------------------------
  update public.invoice_items
  set
    line_net_amount = round(quantity * unit_price, 2),
    line_vat_amount = case
      when vat_category_code = 'S'
        then round(round(quantity * unit_price, 2) * vat_rate / 100, 2)
      else 0
    end,
    line_gross_amount = round(quantity * unit_price, 2)
      + case
          when vat_category_code = 'S'
            then round(round(quantity * unit_price, 2) * vat_rate / 100, 2)
          else 0
        end,
    updated_at = now()
  where invoice_id = p_invoice_id;

  -- Defenzívne vyčistenie (za normálnych okolností prázdne pred prvou
  -- finalizáciou — RLS/trigger nedovoľujú klientovi tieto tabuľky
  -- zapisovať vôbec).
  delete from public.invoice_tax_breakdowns where invoice_id = p_invoice_id;

  -- EN16931 BR-CO-17: vat_amount per (kategória × sadzba) = ROUND(SUM(line_
  -- net_amount) × rate / 100, 2) — agregácia PRED zaokrúhlením VAT sumy,
  -- nie súčet už zaokrúhlených per-line súm. Nezmenené pre S.
  --
  -- Z/E/AE: zoskupovanie podľa NORMALIZOVANEJ sadzby (effective_rate = 0),
  -- nie podľa surovej invoice_items.vat_rate — inak by dve Z/E/AE položky
  -- s rôznou stray vat_rate hodnotou (napr. historické dáta) vytvorili DVE
  -- samostatné breakdown riadky pre tú istú kategóriu a pri INSERTe by obe
  -- dostali rovnakú normalizovanú vat_rate=0, čo by narazilo na
  -- invoice_tax_breakdowns UNIQUE (invoice_id, vat_category_code, vat_rate).
  -- Kategórie sa medzi sebou NIKDY nemiešajú — group by vat_category_code
  -- je vždy prvá úroveň zoskupenia, Z/E/AE zostávajú samostatné riadky.
  insert into public.invoice_tax_breakdowns (
    invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount
  )
  select
    p_invoice_id,
    normalized.vat_category_code,
    normalized.effective_rate,
    sum(normalized.line_net_amount) as taxable_amount,
    case
      when normalized.vat_category_code = 'S'
        then round(sum(normalized.line_net_amount) * normalized.effective_rate / 100, 2)
      else 0
    end as vat_amount
  from (
    select
      vat_category_code,
      case when vat_category_code = 'S' then vat_rate else 0 end as effective_rate,
      line_net_amount
    from public.invoice_items
    where invoice_id = p_invoice_id
  ) normalized
  group by normalized.vat_category_code, normalized.effective_rate;

  select coalesce(sum(line_net_amount), 0) into v_subtotal
  from public.invoice_items
  where invoice_id = p_invoice_id;

  select coalesce(sum(vat_amount), 0) into v_vat_total
  from public.invoice_tax_breakdowns
  where invoice_id = p_invoice_id;

  -- BR-CO-15: total = subtotal + vat_total (+ rounding_amount, v Fáze 2
  -- vždy hodnota, akú už draft mal — VAT engine ju nepoužíva na vynútenie
  -- rekonciliácie, pozri hlavičku migrácie A bod 7).
  v_total := v_subtotal + v_vat_total + coalesce(v_rounding_amount, 0);

  -- ---------------------------------------------------------------------
  -- Concurrency-safe číslovanie — pg_advisory_xact_lock na
  -- (company_id, year, series_key), rovnaký vzor ako
  -- esblu_enforce_plan_limit() (advisory lock nad hash kľúča namiesto
  -- SELECT→UPDATE bez zámku). Rok sa berie z issue_date faktúry (nie
  -- z now()) — bežná účtovná prax, číselný rad sa viaže na účtovný rok
  -- dokladu, nie na okamih finalizácie.
  -- ---------------------------------------------------------------------
  v_series_key := case v_kind
    when 'credit_note' then 'credit_note'
    when 'debit_note' then 'debit_note'
    else 'regular'
  end;
  v_year := extract(year from v_issue_date)::integer;

  perform pg_advisory_xact_lock(
    hashtextextended(v_company_id::text || ':' || v_year::text || ':' || v_series_key, 0)
  );

  -- Predvolený prefix per séria PRI PRVOM VZNIKU radu (iba na INSERT, ON
  -- CONFLICT DO NOTHING nikdy neprepíše už existujúci, prípadne ručne
  -- upravený, riadok). BEZ TOHTO by 'regular' aj 'credit_note'/'debit_note'
  -- rad pre tú istú company+rok pri prvom čísle oba vyprodukovali identický
  -- reťazec (rok + lpad(1,padding,'0'), keďže prefix/suffix sú inak NULL),
  -- čo by narazilo na invoices_company_invoice_number_key (company_id,
  -- invoice_number) UNIQUE constraint — dva rôzne doklady by sa nemohli
  -- vôbec obe finalizovať. 'FA'/'DO'/'ID' sú bežné slovenské skratky
  -- (faktúra/dobropis/ťarchopis), rovnaký typ predvoleného-ale-
  -- konfigurovateľného rozhodnutia ako bod 9 v hlavičke migrácie A —
  -- nie právne prehlásenie, iba technická disambiguácia formátu čísla.
  insert into public.invoice_number_sequences (company_id, year, series_key, prefix)
  values (
    v_company_id, v_year, v_series_key,
    case v_series_key
      when 'credit_note' then 'DO'
      when 'debit_note' then 'ID'
      else 'FA'
    end
  )
  on conflict (company_id, year, series_key) do nothing;

  update public.invoice_number_sequences
  set next_number = next_number + 1,
      updated_at = now()
  where company_id = v_company_id
    and year = v_year
    and series_key = v_series_key
  returning id, prefix, suffix, padding, next_number - 1
    into v_seq_id, v_prefix, v_suffix, v_padding, v_allocated_number;

  v_invoice_number := coalesce(v_prefix, '') || v_year::text
    || lpad(v_allocated_number::text, v_padding, '0') || coalesce(v_suffix, '');

  -- ---------------------------------------------------------------------
  -- Immutable snapshot strán — vzniká presne raz, tu.
  -- issued: seller = company_billing_profile, buyer = business_partners.
  -- received: seller = business_partners, buyer = company_billing_profile.
  -- ---------------------------------------------------------------------
  if v_direction = 'issued' then
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      iban, bic, email, source_business_partner_id
    )
    select
      p_invoice_id, 'seller', cbp.legal_name, cbp.ico, cbp.dic, cbp.ic_dph,
      cbp.address_line1, cbp.address_line2, cbp.city, cbp.postal_code, cbp.country_code,
      cbp.iban, cbp.bic, cbp.contact_email, null
    from public.company_billing_profile cbp
    where cbp.company_id = v_company_id;

    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      email, peppol_identifier, source_business_partner_id
    )
    select
      p_invoice_id, 'buyer', bp.legal_name, bp.ico, bp.dic, bp.ic_dph,
      bp.address_line1, bp.address_line2, bp.city, bp.postal_code, bp.country_code,
      bp.email, bp.peppol_identifier, bp.id
    from public.business_partners bp
    where bp.id = v_customer_business_partner_id;
  else
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      email, peppol_identifier, source_business_partner_id
    )
    select
      p_invoice_id, 'seller', bp.legal_name, bp.ico, bp.dic, bp.ic_dph,
      bp.address_line1, bp.address_line2, bp.city, bp.postal_code, bp.country_code,
      bp.email, bp.peppol_identifier, bp.id
    from public.business_partners bp
    where bp.id = v_customer_business_partner_id;

    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      iban, bic, email, source_business_partner_id
    )
    select
      p_invoice_id, 'buyer', cbp.legal_name, cbp.ico, cbp.dic, cbp.ic_dph,
      cbp.address_line1, cbp.address_line2, cbp.city, cbp.postal_code, cbp.country_code,
      cbp.iban, cbp.bic, cbp.contact_email, null
    from public.company_billing_profile cbp
    where cbp.company_id = v_company_id;
  end if;

  -- ---------------------------------------------------------------------
  -- Finálny zápis — posledný krok, KÝM sa document_status nezmení na
  -- 'finalized', všetky vyššie UPDATE/INSERT na invoice_items/invoice_
  -- parties/invoice_tax_breakdowns prebehli nad ešte 'draft' faktúrou, takže
  -- immutability triggery ich nijako neobmedzili. Od tohto UPDATE ďalej je
  -- faktúra navždy immutable (okrem payment_status).
  -- ---------------------------------------------------------------------
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

  insert into public.invoice_events (
    invoice_id, event_type, actor_user_id, actor_source, payload
  )
  values (
    p_invoice_id, 'finalized', auth.uid(), 'user',
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'total_amount', v_total,
      'currency', null
    )
  );

  return jsonb_build_object(
    'invoice_id', p_invoice_id,
    'invoice_number', v_invoice_number,
    'subtotal_amount', v_subtotal,
    'vat_total_amount', v_vat_total,
    'total_amount', v_total,
    'finalized_at', v_finalized_at
  );
end;
$function$;

comment on function public.esblu_finalize_invoice(uuid) is
  'Atomická finalizácia draft faktúry: autorizácia (owner/finance.manage), SELECT...FOR UPDATE zámok, validácia povinných polí/partnera/billing profilu/opravovaného dokladu/S-kategórie VAT sadzby, autoritatívny category-aware prepočet VAT (EN16931 BR-CO-17/14/15 pre S; Z/E/AE vždy vat_amount=0 nezávisle od stray vat_rate), concurrency-safe pridelenie čísla (pg_advisory_xact_lock), immutable snapshot strán, jednosmerný prechod document_status draft→finalized, audit event. Nikdy čiastočne finalizovaná faktúra pri zlyhaní — jedna DB transakcia.';

-- Explicit re-grant (CREATE OR REPLACE FUNCTION zachováva existujúce grants,
-- toto je iba explicitné potvrdenie/auditovateľnosť v tejto migrácii).
revoke execute on function public.esblu_finalize_invoice(uuid) from public;
revoke execute on function public.esblu_finalize_invoice(uuid) from anon;
grant execute on function public.esblu_finalize_invoice(uuid) to authenticated;
