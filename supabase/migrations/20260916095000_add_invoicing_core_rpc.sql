begin;

-- =============================================================================
-- Esblu — Fakturačné jadro (FÁZA 2), migrácia B: atomická finalizácia,
-- immutabilita, platby
-- =============================================================================
-- Nadväzuje na 20260916094000 (tabuľky/RLS). Tri skupiny objektov:
--   1. DB-level immutability triggery (invoices/invoice_items/invoice_
--      parties/invoice_tax_breakdowns) — RLS v migrácii A už odrezáva
--      priamy klientský zápis na finalizovanú faktúru, toto je NEZÁVISLÁ
--      druhá vrstva priamo na DB úrovni (platí aj keby RLS politika bola
--      niekedy v budúcnosti omylom oslabená).
--   2. esblu_finalize_invoice(uuid) — jediná atomická SECURITY DEFINER RPC,
--      presne 1:1 vzor ako esblu_finalize_vehicle_document(): SELECT ... FOR
--      UPDATE zámok, fail-closed autorizácia, validácia, concurrency-safe
--      číslovanie (pg_advisory_xact_lock, rovnaký vzor ako
--      esblu_enforce_plan_limit), atomický zápis, jsonb návrat.
--   3. esblu_add_invoice_payment()/esblu_remove_invoice_payment() — jediná
--      cesta k zápisu do invoice_payments, payment_status na invoices sa
--      prepočíta v TEJ ISTEJ transakcii, nikdy samostatným klientským
--      UPDATE (zadanie bod 19).
-- =============================================================================


-- =============================================================================
-- 1. Immutabilita — invoices
-- =============================================================================
-- Po document_status='finalized' smie zostať mutable IBA payment_status +
-- audit metadata (updated_at/updated_by) — a to výhradne cez esblu_add_
-- invoice_payment()/esblu_remove_invoice_payment() nižšie (klientský priamy
-- UPDATE je už odrezaný RLS v migrácii A, toto je druhá vrstva).
create or replace function public.esblu_block_finalized_invoice_mutation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if OLD.document_status = 'finalized' then
    if NEW.document_status is distinct from OLD.document_status
      or NEW.invoice_number is distinct from OLD.invoice_number
      or NEW.invoice_number_sequence_id is distinct from OLD.invoice_number_sequence_id
      or NEW.issue_date is distinct from OLD.issue_date
      or NEW.due_date is distinct from OLD.due_date
      or NEW.delivery_date is distinct from OLD.delivery_date
      or NEW.tax_point_date is distinct from OLD.tax_point_date
      or NEW.currency is distinct from OLD.currency
      or NEW.subtotal_amount is distinct from OLD.subtotal_amount
      or NEW.vat_total_amount is distinct from OLD.vat_total_amount
      or NEW.total_amount is distinct from OLD.total_amount
      or NEW.rounding_amount is distinct from OLD.rounding_amount
      or NEW.variable_symbol is distinct from OLD.variable_symbol
      or NEW.payment_terms_days is distinct from OLD.payment_terms_days
      or NEW.iban is distinct from OLD.iban
      or NEW.customer_business_partner_id is distinct from OLD.customer_business_partner_id
      or NEW.corrects_invoice_id is distinct from OLD.corrects_invoice_id
      or NEW.direction is distinct from OLD.direction
      or NEW.kind is distinct from OLD.kind
      or NEW.company_id is distinct from OLD.company_id
      or NEW.finalized_at is distinct from OLD.finalized_at
      or NEW.finalized_by is distinct from OLD.finalized_by
      or NEW.created_at is distinct from OLD.created_at
      or NEW.created_by is distinct from OLD.created_by
      or NEW.source is distinct from OLD.source
      or NEW.source_document_id is distinct from OLD.source_document_id
    then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE',
        hint = 'Finalizovaná faktúra je immutable okrem payment_status (cez esblu_add_invoice_payment/esblu_remove_invoice_payment) a audit metadát.';
    end if;
  end if;
  return NEW;
end;
$function$;

comment on function public.esblu_block_finalized_invoice_mutation() is
  'BEFORE UPDATE guard na invoices: po document_status=finalized blokuje zmenu čohokoľvek okrem payment_status/updated_at/updated_by. DB-level immutabilita nezávislá od RLS.';

create trigger esblu_invoices_immutability_guard
  before update on public.invoices
  for each row execute function public.esblu_block_finalized_invoice_mutation();

create or replace function public.esblu_block_finalized_invoice_delete()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if OLD.document_status = 'finalized' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_FINALIZED_NO_DELETE',
      hint = 'Finalizovaná faktúra sa nikdy nemaže — oprava ide výhradne cez credit_note/debit_note.';
  end if;
  return OLD;
end;
$function$;

create trigger esblu_invoices_immutability_delete_guard
  before delete on public.invoices
  for each row execute function public.esblu_block_finalized_invoice_delete();


-- =============================================================================
-- 2. Immutabilita — invoice_items
-- =============================================================================
-- invoice_items sú mutable kým je RODIČOVSKÁ faktúra draft (RLS to už rieši
-- v migrácii A), toto je nezávislá DB-level druhá vrstva, ktorá navyše chráni
-- aj pred prípadným budúcim service_role/administratívnym zápisom.
create or replace function public.esblu_block_finalized_invoice_items_mutation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_invoice_id uuid;
  v_status text;
begin
  v_invoice_id := coalesce(NEW.invoice_id, OLD.invoice_id);

  select i.document_status into v_status
  from public.invoices i
  where i.id = v_invoice_id;

  if v_status = 'finalized' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_ITEMS_FINALIZED_IMMUTABLE',
      hint = 'Riadky finalizovanej faktúry sa nedajú meniť — oprava ide cez samostatný credit_note/debit_note.';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$function$;

create trigger esblu_invoice_items_immutability_guard
  before insert or update or delete on public.invoice_items
  for each row execute function public.esblu_block_finalized_invoice_items_mutation();

comment on function public.esblu_block_finalized_invoice_items_mutation() is
  'BEFORE INSERT/UPDATE/DELETE guard na invoice_items: akákoľvek mutácia je zakázaná, ak rodičovská invoices.document_status=finalized. esblu_finalize_invoice() prepočítava riadky VŽDY PRED nastavením document_status=finalized (v tej istej transakcii), takže vlastný zápis RPC nie je týmto guardom nikdy blokovaný.';


-- =============================================================================
-- 3. Immutabilita — invoice_parties, invoice_tax_breakdowns
-- =============================================================================
-- Obe tabuľky majú v migrácii A iba SELECT RLS politiku (žiadny klientský
-- write vôbec) — INSERT vykonáva výhradne esblu_finalize_invoice() ako
-- SECURITY DEFINER (obchádza RLS aj tento trigger, keďže trigger iba
-- blokuje UPDATE/DELETE, nie INSERT). UNIQUE(invoice_id, role) /
-- UNIQUE(invoice_id, vat_category_code, vat_rate) + jednosmerný draft→
-- finalized prechod zaručujú, že INSERT sa reálne stane presne raz.
create or replace function public.esblu_block_invoice_snapshot_mutation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'P0001',
    message = 'ESBLU_INVOICE_SNAPSHOT_IMMUTABLE',
    hint = 'invoice_parties/invoice_tax_breakdowns sa po vzniku nikdy needitujú ani nemažú — vznikajú presne raz pri finalizácii.';
end;
$function$;

comment on function public.esblu_block_invoice_snapshot_mutation() is
  'BEFORE UPDATE/DELETE guard: invoice_parties a invoice_tax_breakdowns sú po vzniku úplne immutable (žiadna výnimka), rovnaký princíp ako invoices po finalizácii.';

create trigger esblu_invoice_parties_immutability_guard
  before update or delete on public.invoice_parties
  for each row execute function public.esblu_block_invoice_snapshot_mutation();

create trigger esblu_invoice_tax_breakdowns_immutability_guard
  before update or delete on public.invoice_tax_breakdowns
  for each row execute function public.esblu_block_invoice_snapshot_mutation();


-- =============================================================================
-- 4. esblu_finalize_invoice — atomická finalizácia
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
  -- Autoritatívny prepočet (nikdy sa nedôveruje klientom poslaným sumám).
  -- Rodičovská faktúra je tu ešte 'draft', takže immutability trigger na
  -- invoice_items tento UPDATE nijako neobmedzuje.
  -- ---------------------------------------------------------------------
  update public.invoice_items
  set
    line_net_amount = round(quantity * unit_price, 2),
    line_vat_amount = round(round(quantity * unit_price, 2) * vat_rate / 100, 2),
    line_gross_amount = round(quantity * unit_price, 2)
      + round(round(quantity * unit_price, 2) * vat_rate / 100, 2),
    updated_at = now()
  where invoice_id = p_invoice_id;

  -- Defenzívne vyčistenie (za normálnych okolností prázdne pred prvou
  -- finalizáciou — RLS/trigger nedovoľujú klientovi tieto tabuľky
  -- zapisovať vôbec).
  delete from public.invoice_tax_breakdowns where invoice_id = p_invoice_id;

  -- EN16931 BR-CO-17: vat_amount per (kategória × sadzba) = ROUND(SUM(line_
  -- net_amount) × rate / 100, 2) — agregácia PRED zaokrúhlením VAT sumy,
  -- nie súčet už zaokrúhlených per-line súm.
  insert into public.invoice_tax_breakdowns (
    invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount
  )
  select
    p_invoice_id,
    vat_category_code,
    vat_rate,
    sum(line_net_amount) as taxable_amount,
    round(sum(line_net_amount) * vat_rate / 100, 2) as vat_amount
  from public.invoice_items
  where invoice_id = p_invoice_id
  group by vat_category_code, vat_rate;

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
  'Atomická finalizácia draft faktúry: autorizácia (owner/finance.manage), SELECT...FOR UPDATE zámok, validácia povinných polí/partnera/billing profilu/opravovaného dokladu, autoritatívny prepočet VAT (EN16931 BR-CO-17/14/15), concurrency-safe pridelenie čísla (pg_advisory_xact_lock), immutable snapshot strán, jednosmerný prechod document_status draft→finalized, audit event. Nikdy čiastočne finalizovaná faktúra pri zlyhaní — jedna DB transakcia.';

revoke execute on function public.esblu_finalize_invoice(uuid) from public;
revoke execute on function public.esblu_finalize_invoice(uuid) from anon;
grant execute on function public.esblu_finalize_invoice(uuid) to authenticated;


-- =============================================================================
-- 5. esblu_add_invoice_payment / esblu_remove_invoice_payment
-- =============================================================================
create or replace function public.esblu_add_invoice_payment(
  p_invoice_id uuid,
  p_paid_amount numeric,
  p_paid_at date default current_date,
  p_payment_method text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_inv_company_id uuid;
  v_document_status text;
  v_total_amount numeric(18, 2);
  v_payment_id uuid;
  v_total_paid numeric(18, 2);
  v_new_status text;
begin
  if p_invoice_id is null or p_paid_amount is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_ARGUMENT';
  end if;

  if p_paid_amount <= 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_PAID_AMOUNT';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;

  select i.company_id, i.document_status, i.total_amount
    into v_inv_company_id, v_document_status, v_total_amount
  from public.invoices i
  where i.id = p_invoice_id
  for update;

  if v_inv_company_id is null or v_inv_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;

  if v_document_status <> 'finalized' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_FINALIZED',
      hint = 'Platby sa evidujú iba k finalizovanej faktúre.';
  end if;

  insert into public.invoice_payments (
    invoice_id, paid_amount, paid_at, payment_method, note, recorded_by
  )
  values (
    p_invoice_id, p_paid_amount, coalesce(p_paid_at, current_date),
    p_payment_method, p_note, auth.uid()
  )
  returning id into v_payment_id;

  select coalesce(sum(paid_amount), 0) into v_total_paid
  from public.invoice_payments
  where invoice_id = p_invoice_id;

  -- Overpayment: povolené a evidované (nie fail-closed odmietnutie, nie
  -- automatický refund — zadanie bod 18, "zvoľ bezpečný model, nevymýšľaj
  -- automatický refund"). Faktúra jednoducho zostáva 'paid', celková
  -- zaplatená suma (presahujúca total_amount) je viditeľná v súčte platieb.
  v_new_status := case
    when v_total_paid <= 0 then 'unpaid'
    when v_total_paid >= v_total_amount then 'paid'
    else 'partially_paid'
  end;

  update public.invoices
  set payment_status = v_new_status,
      updated_at = now(),
      updated_by = auth.uid()
  where id = p_invoice_id;

  insert into public.invoice_events (
    invoice_id, event_type, actor_user_id, actor_source, payload
  )
  values (
    p_invoice_id, 'payment_recorded', auth.uid(), 'user',
    jsonb_build_object(
      'payment_id', v_payment_id,
      'paid_amount', p_paid_amount,
      'new_payment_status', v_new_status
    )
  );

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'payment_status', v_new_status,
    'total_paid', v_total_paid
  );
end;
$function$;

comment on function public.esblu_add_invoice_payment(uuid, numeric, date, text, text) is
  'Jediná cesta k zápisu platby: vloží invoice_payments riadok a v tej istej transakcii atomicky prepočíta invoices.payment_status (unpaid/partially_paid/paid). Overpayment povolený a evidovaný, žiadny automatický refund. finance.manage required.';

revoke execute on function public.esblu_add_invoice_payment(uuid, numeric, date, text, text) from public;
revoke execute on function public.esblu_add_invoice_payment(uuid, numeric, date, text, text) from anon;
grant execute on function public.esblu_add_invoice_payment(uuid, numeric, date, text, text) to authenticated;


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
  v_document_status text;
  v_total_amount numeric(18, 2);
  v_total_paid numeric(18, 2);
  v_new_status text;
begin
  if p_payment_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_ARGUMENT';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;

  select p.invoice_id into v_invoice_id
  from public.invoice_payments p
  where p.id = p_payment_id;

  if v_invoice_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_PAYMENT_NOT_FOUND';
  end if;

  -- Zámok na faktúre (stabilné poradie zámkov: vždy invoices pred
  -- invoice_payments) — serializuje súbežné add/remove nad tou istou
  -- faktúrou.
  select i.company_id, i.document_status, i.total_amount
    into v_inv_company_id, v_document_status, v_total_amount
  from public.invoices i
  where i.id = v_invoice_id
  for update;

  if v_inv_company_id is null or v_inv_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;

  delete from public.invoice_payments
  where id = p_payment_id
    and invoice_id = v_invoice_id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_PAYMENT_NOT_FOUND';
  end if;

  select coalesce(sum(paid_amount), 0) into v_total_paid
  from public.invoice_payments
  where invoice_id = v_invoice_id;

  v_new_status := case
    when v_total_paid <= 0 then 'unpaid'
    when v_total_paid >= v_total_amount then 'paid'
    else 'partially_paid'
  end;

  update public.invoices
  set payment_status = v_new_status,
      updated_at = now(),
      updated_by = auth.uid()
  where id = v_invoice_id;

  insert into public.invoice_events (
    invoice_id, event_type, actor_user_id, actor_source, payload
  )
  values (
    v_invoice_id, 'payment_removed', auth.uid(), 'user',
    jsonb_build_object('payment_id', p_payment_id, 'new_payment_status', v_new_status)
  );

  return jsonb_build_object(
    'invoice_id', v_invoice_id,
    'payment_status', v_new_status,
    'total_paid', v_total_paid
  );
end;
$function$;

comment on function public.esblu_remove_invoice_payment(uuid) is
  'Jediná cesta k mazaniu platby: zmaže invoice_payments riadok a v tej istej transakcii atomicky prepočíta invoices.payment_status. finance.manage required, cross-company deny.';

revoke execute on function public.esblu_remove_invoice_payment(uuid) from public;
revoke execute on function public.esblu_remove_invoice_payment(uuid) from anon;
grant execute on function public.esblu_remove_invoice_payment(uuid) to authenticated;

commit;
