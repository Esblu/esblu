-- =============================================================================
-- 20261008100009 — ZDANENÁ záloha v konečnej faktúre ako MÍNUSOVÝ RIADOK (FS SR, FAQ k eFaktúre,
-- verzia 15. 9. 2026, technická séria, príklad 38).
--
-- Model:
--   A) ZDANENÁ záloha (existuje faktúra k prijatej platbe / UBL 386):
--      - v konečnej faktúre samostatný riadok: množstvo -1 (v DB 1 × záporná cena), základ zálohy,
--        tá istá kategória a sadzba DPH ako zálohová faktúra, DPH riadka = DPH zálohy;
--      - znižuje základ aj DPH rekapitulácie (invoice_tax_breakdowns, hlavička);
--      - väzba BillingReference (BT-25/26) na zálohovú faktúru;
--      - PrepaidAmount (BT-113) sa pre ňu NEPOUŽÍVA.
--   B) NEZDANENÁ záloha (bez faktúry k prijatej platbe):
--      - vydaná: invoices.untaxed_prepaid_amount (+ voliteľná referencia) → PrepaidAmount, znižuje iba sumu
--        na úhradu, rozpis DPH nemení;
--      - prijatá: invoices.prepaid_amount (BT-113 z XML), nič sa nepáruje.
--
-- Vydaná: odpočty sa naďalej zadávajú do invoice_advance_deductions (koncept); pri finalizácii sa z nich
-- vytvoria mínusové riadky invoice_items (is_advance_deduction, advance_invoice_id, advance_vat_amount).
-- Prijatá: mínusové riadky z XML sa uložia ako riadky so zápornou cenou (is_advance_deduction); párovanie na
-- prijaté 386 po riadkoch (firma + dodávateľ + BT-25 + sadzba + zostatok základu), inak review.
-- Saldo: zdanené zálohy sú už v total_amount (nič sa neodpočíta druhýkrát); odpočítava sa iba nezdanená.
-- Staršie finalizované konečné faktúry (pred touto migráciou, bez mínusových riadkov) ostávajú v pôvodnom
-- výpočte salda (odpočet mimo súčtu).
-- Prijaté XML: tolerancia DPH skupiny 0,01 voči základ × sadzba (Peppol BR-CO-17 pripúšťa ±1).
--
-- ROLLBACK: supabase/rollback/20261008100009_taxed_advance_deduction_lines_rollback.sql
-- =============================================================================

-- 1) Riadky odpočtu zálohy --------------------------------------------------------------------------
alter table public.invoice_items
  add column if not exists is_advance_deduction boolean not null default false,
  add column if not exists advance_invoice_id uuid references public.invoices(id) on delete restrict,
  add column if not exists advance_vat_amount numeric(18, 2);
do $ck$
declare r record;
begin
  -- pôvodné check (unit_price >= 0) z 20260916094000 (názov generovaný Postgresom)
  for r in select c.conname from pg_constraint c
           where c.conrelid = 'public.invoice_items'::regclass and c.contype = 'c'
             and pg_get_constraintdef(c.oid) ~ '^CHECK \(\(unit_price >= ' loop
    execute format('alter table public.invoice_items drop constraint %I', r.conname);
  end loop;
end
$ck$;
alter table public.invoice_items drop constraint if exists invoice_items_unit_price_sign_check;
alter table public.invoice_items add constraint invoice_items_unit_price_sign_check
  check ((not is_advance_deduction and unit_price >= 0) or (is_advance_deduction and unit_price < 0 and quantity = 1));
alter table public.invoice_items drop constraint if exists invoice_items_advance_fields_check;
alter table public.invoice_items add constraint invoice_items_advance_fields_check
  check ((advance_invoice_id is null and advance_vat_amount is null) or is_advance_deduction);
alter table public.invoice_items drop constraint if exists invoice_items_advance_vat_check;
alter table public.invoice_items add constraint invoice_items_advance_vat_check
  check (advance_vat_amount is null or advance_vat_amount >= 0);
create index if not exists invoice_items_advance_invoice_idx on public.invoice_items (advance_invoice_id) where advance_invoice_id is not null;

-- Riadky odpočtu vytvára iba DB (finalizácia / príjem XML), nikdy klient.
create or replace function public.esblu_block_client_advance_item_change()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.is_advance_deduction or new.advance_invoice_id is not null or new.advance_vat_amount is not null then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_LINE_PROTECTED';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.is_advance_deduction or new.is_advance_deduction
       or new.advance_invoice_id is distinct from old.advance_invoice_id
       or new.advance_vat_amount is distinct from old.advance_vat_amount then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_LINE_PROTECTED';
    end if;
    return new;
  end if;
  return old;
end;
$function$;
revoke execute on function public.esblu_block_client_advance_item_change() from public, anon, authenticated;
drop trigger if exists esblu_block_client_advance_item_change on public.invoice_items;
create trigger esblu_block_client_advance_item_change before insert or update on public.invoice_items
  for each row execute function public.esblu_block_client_advance_item_change();

-- 2) Nezdanená záloha (vydaná) a review len pre mínusové riadky (prijatá) -----------------------------
alter table public.invoices
  add column if not exists untaxed_prepaid_amount numeric(18, 2),
  add column if not exists untaxed_prepaid_reference text;
alter table public.invoices drop constraint if exists invoices_untaxed_prepaid_check;
alter table public.invoices add constraint invoices_untaxed_prepaid_check
  check (untaxed_prepaid_amount is null or (untaxed_prepaid_amount > 0 and direction = 'issued' and kind = 'regular_invoice'));
alter table public.invoices drop constraint if exists invoices_untaxed_prepaid_reference_check;
alter table public.invoices add constraint invoices_untaxed_prepaid_reference_check
  check (untaxed_prepaid_reference is null or char_length(untaxed_prepaid_reference) between 1 and 200);
alter table public.invoices drop constraint if exists invoices_advance_review_status_check;
alter table public.invoices add constraint invoices_advance_review_status_check
  check (advance_review_status is null
         or (advance_review_status in ('review', 'proposed', 'linked') and direction = 'received' and kind = 'regular_invoice'));

create or replace function public.esblu_block_client_advance_review_change()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.prepaid_amount is not null or new.advance_references is not null or new.advance_review_status is not null
       or new.advance_review_reasons is not null or new.advance_review_note is not null
       or new.advance_reviewed_at is not null or new.advance_reviewed_by is not null
       or new.untaxed_prepaid_amount is not null or new.untaxed_prepaid_reference is not null then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_REVIEW_FIELDS_PROTECTED';
    end if;
  elsif new.prepaid_amount is distinct from old.prepaid_amount
     or new.advance_references is distinct from old.advance_references
     or new.advance_review_status is distinct from old.advance_review_status
     or new.advance_review_reasons is distinct from old.advance_review_reasons
     or new.advance_review_note is distinct from old.advance_review_note
     or new.advance_reviewed_at is distinct from old.advance_reviewed_at
     or new.advance_reviewed_by is distinct from old.advance_reviewed_by
     or new.untaxed_prepaid_amount is distinct from old.untaxed_prepaid_amount
     or new.untaxed_prepaid_reference is distinct from old.untaxed_prepaid_reference
     -- Druh prijatej zálohy (386) a konečnej faktúry so zálohami sa nemení z klienta.
     or (old.direction = 'received' and old.source = 'efaktura_peppol' and new.kind is distinct from old.kind) then
    raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_REVIEW_FIELDS_PROTECTED';
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_block_client_advance_review_change() from public, anon, authenticated;

-- 3) Vydaná konečná faktúra: odpočty zdanených záloh (koncept) — validácia pri zadaní -----------------
create or replace function public.esblu_set_invoice_advance_deductions(p_invoice_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
  v_n integer;
  v_r jsonb;
  v_a public.invoices%rowtype;
  v_b record;
  v_cat text; v_rate numeric; v_taxable numeric; v_vat numeric;
  v_used_t numeric; v_used_v numeric;
begin
  if p_invoice_id is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ARGUMENT';
  end if;
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if v_inv.id is null or v_inv.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_DRAFT';
  end if;
  if v_inv.direction <> 'issued' or v_inv.kind <> 'regular_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_KIND',
      hint = 'Odpočet záloh je iba na vydanej konečnej (riadnej) faktúre.';
  end if;
  -- 20261008100009: každý riadok = existujúca finalizovaná faktúra k prijatej platbe tej istej firmy
  -- a odberateľa, v tej istej mene, s rovnakou kategóriou a sadzbou DPH; najviac do zostatku.
  for v_r in select r from jsonb_array_elements(p_rows) r
  loop
    begin
      v_cat := upper(btrim(v_r ->> 'vat_category_code'));
      v_rate := (v_r ->> 'vat_rate')::numeric;
      v_taxable := (v_r ->> 'taxable_amount')::numeric;
      v_vat := (v_r ->> 'vat_amount')::numeric;
      select * into v_a from public.invoices a where a.id = (v_r ->> 'advance_invoice_id')::uuid;
    exception when others then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_INVALID';
    end;
    if v_a.id is null or v_a.company_id <> v_inv.company_id or v_a.direction <> 'issued'
       or v_a.kind <> 'payment_received_invoice' or v_a.document_status <> 'finalized'
       or v_a.customer_business_partner_id is distinct from v_inv.customer_business_partner_id
       or v_a.currency <> v_inv.currency then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_INVALID';
    end if;
    if v_taxable is null or v_taxable <= 0 or v_vat is null or v_vat < 0
       or v_taxable <> round(v_taxable, 2) or v_vat <> round(v_vat, 2) then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_INVALID';
    end if;
    select b.taxable_amount, b.vat_amount into v_b from public.invoice_tax_breakdowns b
    where b.invoice_id = v_a.id and b.vat_category_code = v_cat and b.vat_rate = v_rate;
    if not found then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_RATE_MISMATCH',
        hint = 'Odpočet zálohy musí mať rovnakú kategóriu a sadzbu DPH ako faktúra k prijatej platbe.';
    end if;
    select coalesce(sum(x.taxable_amount), 0), coalesce(sum(x.vat_amount), 0) into v_used_t, v_used_v
    from public.invoice_advance_deductions x join public.invoices f on f.id = x.invoice_id
    where x.advance_invoice_id = v_a.id and x.vat_category_code = v_cat and x.vat_rate = v_rate
      and f.document_status = 'finalized' and f.id <> v_inv.id;
    if v_used_t + v_taxable > v_b.taxable_amount or v_used_v + v_vat > v_b.vat_amount then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_EXCEEDS';
    end if;
  end loop;
  delete from public.invoice_advance_deductions d where d.invoice_id = p_invoice_id;
  insert into public.invoice_advance_deductions (invoice_id, advance_invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount)
  select p_invoice_id, (r ->> 'advance_invoice_id')::uuid, upper(btrim(r ->> 'vat_category_code')),
         (r ->> 'vat_rate')::numeric, (r ->> 'taxable_amount')::numeric, (r ->> 'vat_amount')::numeric
  from jsonb_array_elements(p_rows) r;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.esblu_set_invoice_advance_deductions(uuid, jsonb) from public, anon;
grant execute on function public.esblu_set_invoice_advance_deductions(uuid, jsonb) to authenticated;

-- 4) Compliance polia + nezdanená záloha (vydaná konečná faktúra) -------------------------------------
create or replace function public.esblu_set_invoice_compliance_fields(p_invoice_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
  v_keys text[];
  v_untaxed numeric;
begin
  if p_invoice_id is null or p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ARGUMENT';
  end if;
  select array_agg(k) into v_keys from jsonb_object_keys(p_fields) k;
  if exists (select 1 from unnest(v_keys) k where k not in ('correction_reason', 'fx_rate', 'fx_rate_date', 'fx_rate_source', 'tax_point_date',
                                                           'untaxed_prepaid_amount', 'untaxed_prepaid_reference')) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_FIELD';
  end if;
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if v_inv.id is null or v_inv.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_DRAFT';
  end if;
  if p_fields ? 'untaxed_prepaid_amount' or p_fields ? 'untaxed_prepaid_reference' then
    if v_inv.direction <> 'issued' or v_inv.kind <> 'regular_invoice' then
      raise exception using errcode = 'P0001', message = 'ESBLU_UNTAXED_PREPAID_KIND';
    end if;
    begin
      v_untaxed := nullif(p_fields ->> 'untaxed_prepaid_amount', '')::numeric;
    exception when others then
      raise exception using errcode = 'P0001', message = 'ESBLU_UNTAXED_PREPAID_INVALID';
    end;
    if v_untaxed is not null and (v_untaxed <= 0 or v_untaxed <> round(v_untaxed, 2)) then
      raise exception using errcode = 'P0001', message = 'ESBLU_UNTAXED_PREPAID_INVALID';
    end if;
  end if;
  update public.invoices i set
    correction_reason = case when p_fields ? 'correction_reason' then nullif(btrim(p_fields ->> 'correction_reason'), '') else i.correction_reason end,
    fx_rate = case when p_fields ? 'fx_rate' then nullif(p_fields ->> 'fx_rate', '')::numeric else i.fx_rate end,
    fx_rate_date = case when p_fields ? 'fx_rate_date' then nullif(p_fields ->> 'fx_rate_date', '')::date else i.fx_rate_date end,
    fx_rate_source = case when p_fields ? 'fx_rate_source' then nullif(upper(btrim(p_fields ->> 'fx_rate_source')), '') else i.fx_rate_source end,
    tax_point_date = case when p_fields ? 'tax_point_date' then nullif(p_fields ->> 'tax_point_date', '')::date else i.tax_point_date end,
    untaxed_prepaid_amount = case when p_fields ? 'untaxed_prepaid_amount' then v_untaxed else i.untaxed_prepaid_amount end,
    untaxed_prepaid_reference = case when p_fields ? 'untaxed_prepaid_reference'
                                     then left(nullif(btrim(p_fields ->> 'untaxed_prepaid_reference'), ''), 200)
                                     else i.untaxed_prepaid_reference end,
    updated_at = now(), updated_by = auth.uid()
  where i.id = p_invoice_id;
end;
$function$;
revoke all on function public.esblu_set_invoice_compliance_fields(uuid, jsonb) from public, anon;
grant execute on function public.esblu_set_invoice_compliance_fields(uuid, jsonb) to authenticated;

-- 5) Finalizácia: mínusové riadky zdanených záloh (vydaná), DPH skupín podľa XML (prijatá) ------------
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
  v_xml jsonb;
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

  -- 20261008100009: ZDANENÉ zálohy (faktúra k prijatej platbe) sa v konečnej faktúre odpočítajú
  -- MÍNUSOVÝM RIADKOM (základ + DPH zálohy, rovnaká sadzba) — FS FAQ k eFaktúre, príklad 38.
  -- Riadky sa vytvoria pri finalizácii z invoice_advance_deductions (jediný zdroj pravdy počas konceptu).
  if v_direction = 'issued' then
    delete from public.invoice_items it where it.invoice_id = p_invoice_id and it.is_advance_deduction;
    if v_kind = 'regular_invoice' then
      insert into public.invoice_items (invoice_id, position, description, quantity, unit, unit_code, unit_price, price_mode,
                                        vat_category_code, vat_rate, is_advance_deduction, advance_invoice_id, advance_vat_amount)
      select p_invoice_id,
             (select coalesce(max(x.position), 0) from public.invoice_items x where x.invoice_id = p_invoice_id)
               + row_number() over (order by a.invoice_number, d.vat_category_code, d.vat_rate),
             'Odpočet zálohy – faktúra k prijatej platbe č. ' || coalesce(a.invoice_number, '?'),
             1, 'ks', 'C62', -d.taxable_amount, 'net', d.vat_category_code, d.vat_rate, true, d.advance_invoice_id, d.vat_amount
      from public.invoice_advance_deductions d join public.invoices a on a.id = d.advance_invoice_id
      where d.invoice_id = p_invoice_id;
    end if;
  else
    -- Prijatá e-faktúra: skupinová DPH podľa doručeného XML (riadky vrátane mínusových riadkov záloh sa
    -- rozpočítajú rovnako ako pri vzniku konceptu; zmena položky sa prejaví v základe a zachytí ju guard).
    select i.xml_totals into v_xml from public.einvoice_inbound i
    where i.invoice_id = p_invoice_id and i.company_id = v_inv_company_id and i.xml_totals is not null
    order by i.received_at limit 1;
  end if;

  select count(*) into v_item_count from public.invoice_items where invoice_id = p_invoice_id and not is_advance_deduction;
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
      -- mínusový riadok vydanej zdanenej zálohy má DPH pevne = DPH zálohy (nižšie)
      and not (is_advance_deduction and advance_vat_amount is not null)
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
                else coalesce(
                  (select (xb ->> 'vat')::numeric from jsonb_array_elements(coalesce(v_xml -> 'breakdown', '[]'::jsonb)) xb
                   where xb ->> 'category' = vat_category_code and (xb ->> 'rate')::numeric = eff_rate limit 1),
                  round(sum(auth_amount) * eff_rate / 100, 2))
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

  -- 20261008100009: mínusový riadok zdanenej zálohy = presne základ a DPH zálohy (FS príklad 38).
  update public.invoice_items ii
  set line_net_amount = round(ii.quantity * ii.unit_price, 2),
      line_vat_amount = -ii.advance_vat_amount,
      line_gross_amount = round(ii.quantity * ii.unit_price, 2) - ii.advance_vat_amount,
      updated_at = now()
  where ii.invoice_id = p_invoice_id and ii.is_advance_deduction and ii.advance_vat_amount is not null;

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
    -- 20261008100000: proforma (výzva na úhradu) NIE JE daňový doklad → vlastná séria PF,
    -- nikdy nespotrebuje číslo daňovej série FA (§ 74 ods. 1 písm. c) zákona o DPH).
    v_series_key := case v_kind when 'credit_note' then 'credit_note' when 'debit_note' then 'debit_note' when 'proforma' then 'proforma' else 'regular' end;
    v_year := extract(year from v_issue_date)::integer;
    perform pg_advisory_xact_lock(hashtextextended(v_company_id::text||':'||v_year::text||':'||v_series_key,0));
    insert into public.invoice_number_sequences (company_id, year, series_key, prefix)
    values (v_company_id, v_year, v_series_key,
      case v_series_key when 'credit_note' then 'DO' when 'debit_note' then 'ID' when 'proforma' then 'PF' else 'FA' end)
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
      'supplier_invoice_number',v_supplier_invoice_number,'total_amount',v_total,'currency',(select i2.currency from public.invoices i2 where i2.id = p_invoice_id)));

  return jsonb_build_object('invoice_id',p_invoice_id,'direction',v_direction,
    'invoice_number',v_invoice_number,'supplier_invoice_number',v_supplier_invoice_number,
    'subtotal_amount',v_subtotal,'vat_total_amount',v_vat_total,'total_amount',v_total,
    'finalized_at',v_finalized_at);
end;
$function$;
revoke all on function public.esblu_finalize_invoice(uuid) from public, anon;
grant execute on function public.esblu_finalize_invoice(uuid) to authenticated;

-- Compliance pri finalizácii: sadzba mínusového riadku zálohy = sadzba zálohovej faktúry (nekontroluje sa voči dňu konečnej faktúry).
create or replace function public.esblu_invoice_finalize_compliance()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_eff date;
  v_rates numeric[];
  v_seller_country text;
  v_vat_payer text;
  v_buyer_icdph text;
  v_orig public.invoices%rowtype;
  v_credited numeric(18,2);
  v_debited numeric(18,2);
  v_base_eur numeric(18,2);
  v_vat_eur numeric(18,2);
  v_bad record;
  v_official record;
begin
  if not (old.document_status = 'draft' and new.document_status = 'finalized') then
    return new;
  end if;

  -- Cudzia mena (§ 26 ods. 1 zákona o DPH) — overenie voči oficiálnym dátam ECB (20261008100004).
  new.fx_reference_rate_id := null;
  new.fx_tax_point_date := null;
  if new.currency <> 'EUR' then
    if new.fx_rate is null or new.fx_rate_date is null or new.fx_rate_source is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_REQUIRED',
        hint = 'Pri cudzej mene uveďte kurz (jednotky meny za 1 EUR), jeho dátum a zdroj (ECB / NBS / colný kurz).';
    end if;
    if new.kind in ('credit_note', 'debit_note') and new.corrects_invoice_id is not null then
      -- Oprava základu dane podľa § 25: „použije sa kurz, ktorý sa použil pri vzniku daňovej povinnosti“.
      select * into v_orig from public.invoices o where o.id = new.corrects_invoice_id;
      if v_orig.fx_rate is distinct from new.fx_rate or v_orig.fx_rate_date is distinct from new.fx_rate_date
         or v_orig.fx_rate_source is distinct from new.fx_rate_source then
        raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_FX_RATE_MISMATCH',
          hint = 'Pri oprave základu dane sa použije kurz pôvodnej faktúry (§ 26 ods. 1): rovnaký kurz, dátum aj zdroj.';
      end if;
      new.fx_reference_rate_id := v_orig.fx_reference_rate_id;
      new.fx_tax_point_date := v_orig.fx_tax_point_date;
    elsif new.direction = 'issued' then
      v_eff := coalesce(new.tax_point_date, new.delivery_date, new.issue_date);
      new.fx_tax_point_date := v_eff;
      if new.fx_rate_source in ('ECB', 'NBS') then
        select o.status, o.rate_date, o.rate, o.reference_id into v_official
          from public.esblu_fx_official_rate(new.currency, v_eff) o;
        if v_official.status = 'data_missing' then
          raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_DATA_MISSING',
            hint = 'Oficiálne kurzy ECB pre tento deň ešte nie sú importované — finalizáciu zopakujte po importe.';
        elsif v_official.status = 'not_published' then
          raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_NOT_PUBLISHED',
            hint = 'ECB pre túto menu v rozhodný deň referenčný kurz nevyhlásila.';
        elsif v_official.status <> 'ok' then
          raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_DATA_MISSING';
        end if;
        if new.fx_rate_date <> v_official.rate_date then
          raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_DATE_INVALID',
            detail = 'expected_fx_rate_date=' || v_official.rate_date::text,
            hint = 'Referenčný kurz vyhlásený v deň predchádzajúci dňu vzniku daňovej povinnosti (§ 26 ods. 1): ' || v_official.rate_date::text || '.';
        end if;
        if new.fx_rate <> v_official.rate then
          raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_MISMATCH',
            detail = 'expected_fx_rate=' || v_official.rate::text,
            hint = 'Kurz sa nezhoduje s oficiálnym referenčným kurzom ECB: ' || v_official.rate::text || '.';
        end if;
        new.fx_reference_rate_id := v_official.reference_id;
      elsif new.fx_rate_date <> v_eff then
        raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_DATE_INVALID',
          detail = 'expected_fx_rate_date=' || v_eff::text,
          hint = 'Kurz podľa colných predpisov platný v deň vzniku daňovej povinnosti (§ 26 ods. 1).';
      end if;
      -- Colný kurz je po oznámení daňovému úradu záväzný celý kalendárny rok (§ 26 ods. 1) — nemiešať.
      if exists (
        select 1 from public.invoices x
        where x.company_id = new.company_id and x.direction = 'issued' and x.document_status = 'finalized'
          and x.currency <> 'EUR' and x.id <> new.id and x.fx_rate_source is not null
          and x.kind not in ('credit_note', 'debit_note', 'proforma')
          and extract(year from coalesce(x.tax_point_date, x.delivery_date, x.issue_date)) = extract(year from v_eff)
          and (x.fx_rate_source = 'CUSTOMS') <> (new.fx_rate_source = 'CUSTOMS')) then
        raise exception using errcode = 'P0001', message = 'ESBLU_FX_SOURCE_YEAR_MISMATCH',
          hint = 'Rozhodnutie používať colný kurz je záväzné počas celého kalendárneho roka (§ 26 ods. 1).';
      end if;
    end if;
    -- Prijaté doklady: kurz a dátum sa preberajú z dokladu dodávateľa; pravidlo dňa sa nevynucuje (LEGAL REVIEW).
    select coalesce(sum(round(b.taxable_amount / new.fx_rate, 2)), 0),
           coalesce(sum(round(round(b.taxable_amount / new.fx_rate, 2) * b.vat_rate / 100, 2)), 0)
      into v_base_eur, v_vat_eur
    from public.invoice_tax_breakdowns b where b.invoice_id = new.id;
    new.tax_base_eur := v_base_eur;
    new.vat_total_eur := v_vat_eur;
  else
    if new.fx_rate is not null or new.fx_rate_date is not null or new.fx_rate_source is not null then
      raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_NOT_ALLOWED_FOR_EUR';
    end if;
    new.tax_base_eur := new.subtotal_amount;
    new.vat_total_eur := new.vat_total_amount;
  end if;

  if new.direction <> 'issued' then
    return new;
  end if;

  -- Dátumy (§ 74 ods. 1 písm. d), § 19 ods. 4).
  if new.kind = 'payment_received_invoice' and new.tax_point_date is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_PAYMENT_RECEIVED_DATE_REQUIRED',
      hint = 'Faktúra k prijatej platbe musí obsahovať dátum prijatia platby (§ 19 ods. 4, § 74 ods. 1 písm. d)).';
  end if;
  if new.kind in ('regular_invoice', 'debit_note') and new.delivery_date is null and new.tax_point_date is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_DELIVERY_DATE_REQUIRED',
      hint = 'Uveďte dátum dodania tovaru alebo služby (§ 74 ods. 1 písm. d)).';
  end if;

  select upper(coalesce(nullif(btrim(c.country_code), ''), 'SK')), c.vat_payer_status
    into v_seller_country, v_vat_payer
  from public.company_billing_profile c where c.company_id = new.company_id;

  -- Neplatiteľ DPH neúčtuje DPH (kategória O).
  if v_vat_payer = 'non_vat_payer' and exists (
    select 1 from public.invoice_items it where it.invoice_id = new.id and it.vat_category_code <> 'O') then
    raise exception using errcode = 'P0001', message = 'ESBLU_NON_VAT_PAYER_CATEGORY',
      hint = 'Neplatiteľ DPH vystavuje doklad bez DPH (kategória O — nepodlieha DPH).';
  end if;

  -- Povolené SK sadzby pre kategóriu S (Esblu nerozhoduje, ktorá sadzba patrí tovaru — iba neprijme neexistujúcu).
  if v_seller_country = 'SK' and new.kind <> 'proforma' then
    v_eff := coalesce(new.tax_point_date, new.delivery_date, new.issue_date);
    v_rates := public.esblu_sk_vat_rates(v_eff);
    select it.vat_rate into v_bad from public.invoice_items it
     where it.invoice_id = new.id and it.vat_category_code = 'S' and not (it.vat_rate = any (v_rates))
       and not it.is_advance_deduction  -- 20261008100009: mínusový riadok zálohy má sadzbu zálohovej faktúry (FS príklad 38)
     limit 1;
    if found then
      raise exception using errcode = 'P0001', message = 'ESBLU_VAT_RATE_NOT_ALLOWED',
        hint = 'Sadzba DPH nie je platná slovenská sadzba pre rozhodný deň (§ 27).';
    end if;
  end if;

  -- Prenesenie daňovej povinnosti / dodanie do EÚ: IČ DPH odberateľa (§ 74 ods. 1 písm. b), k)).
  if exists (select 1 from public.invoice_items it where it.invoice_id = new.id and it.vat_category_code in ('AE', 'K')) then
    select bp.ic_dph into v_buyer_icdph from public.business_partners bp where bp.id = new.customer_business_partner_id;
    if v_buyer_icdph is null or btrim(v_buyer_icdph) = '' then
      raise exception using errcode = 'P0001', message = 'ESBLU_BUYER_VAT_ID_REQUIRED',
        hint = 'Pri prenesení daňovej povinnosti a dodaní do iného členského štátu je povinné IČ DPH odberateľa.';
    end if;
  end if;

  -- Opravné doklady (§ 71 ods. 2, § 74 ods. 3 písm. c), § 25, § 85o ods. 5).
  if new.kind in ('credit_note', 'debit_note') then
    if new.correction_reason is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_REASON_REQUIRED',
        hint = 'Opravný doklad musí uvádzať dôvod opravy a menené údaje.';
    end if;
    select * into v_orig from public.invoices o where o.id = new.corrects_invoice_id;
    if v_orig.kind = 'proforma' then
      raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_OF_PROFORMA',
        hint = 'Proforma nie je daňový doklad — neopravuje sa dobropisom ani ťarchopisom.';
    end if;
    if v_orig.currency <> new.currency then
      raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_CURRENCY_MISMATCH';
    end if;
    if new.kind = 'credit_note' then
      select coalesce(sum(c.total_amount), 0) into v_credited from public.invoices c
       where c.corrects_invoice_id = v_orig.id and c.kind = 'credit_note' and c.document_status = 'finalized';
      select coalesce(sum(d.total_amount), 0) into v_debited from public.invoices d
       where d.corrects_invoice_id = v_orig.id and d.kind = 'debit_note' and d.document_status = 'finalized';
      if v_credited + new.total_amount > v_orig.total_amount + v_debited then
        raise exception using errcode = 'P0001', message = 'ESBLU_CREDIT_EXCEEDS_ORIGINAL',
          hint = 'Súčet dobropisov nesmie prekročiť sumu pôvodnej faktúry vrátane ťarchopisov.';
      end if;
    end if;
  end if;

  -- Odpočet záloh (§ 19 ods. 4, § 72 ods. 1 písm. f)): iba z vlastných finalizovaných faktúr k prijatej platbe
  -- toho istého odberateľa, najviac do výšky zálohy v danej kategórii a sadzbe.
  for v_bad in
    select d.*, a.company_id a_company, a.kind a_kind, a.direction a_direction, a.document_status a_status,
           a.customer_business_partner_id a_customer, a.currency a_currency
    from public.invoice_advance_deductions d join public.invoices a on a.id = d.advance_invoice_id
    where d.invoice_id = new.id
  loop
    if new.kind <> 'regular_invoice' or v_bad.a_company <> new.company_id or v_bad.a_kind <> 'payment_received_invoice'
       or v_bad.a_direction <> 'issued' or v_bad.a_status <> 'finalized'
       or v_bad.a_customer is distinct from new.customer_business_partner_id or v_bad.a_currency <> new.currency then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_INVALID';
    end if;
    if v_bad.taxable_amount + coalesce((
         select sum(x.taxable_amount) from public.invoice_advance_deductions x join public.invoices f on f.id = x.invoice_id
          where x.advance_invoice_id = v_bad.advance_invoice_id and x.vat_category_code = v_bad.vat_category_code
            and x.vat_rate = v_bad.vat_rate and f.document_status = 'finalized' and f.id <> new.id), 0)
       > coalesce((select b.taxable_amount from public.invoice_tax_breakdowns b
          where b.invoice_id = v_bad.advance_invoice_id and b.vat_category_code = v_bad.vat_category_code and b.vat_rate = v_bad.vat_rate), 0) then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_DEDUCTION_EXCEEDS';
    end if;
  end loop;

  return new;
end;
$function$;
revoke execute on function public.esblu_invoice_finalize_compliance() from public, anon, authenticated;

-- Zámok záloh pri finalizácii: total_amount je už po odpočte.
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
  -- 20261008100009: zálohy sú mínusovými riadkami → total_amount je už po odpočte; nesmie byť záporný.
  if new.total_amount < 0 then
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

-- Nezdanená záloha nesmie prevýšiť sumu faktúry.
create or replace function public.esblu_check_untaxed_prepaid()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.untaxed_prepaid_amount > new.total_amount then
    raise exception using errcode = 'P0001', message = 'ESBLU_UNTAXED_PREPAID_EXCEEDS_TOTAL';
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_check_untaxed_prepaid() from public, anon, authenticated;
drop trigger if exists esblu_check_untaxed_prepaid on public.invoices;
create trigger esblu_check_untaxed_prepaid
  before update of document_status on public.invoices
  for each row
  when (old.document_status = 'draft' and new.document_status = 'finalized' and new.untaxed_prepaid_amount is not null)
  execute function public.esblu_check_untaxed_prepaid();

-- 6) Saldo: zdanené zálohy už v súčte; odpočíta sa iba nezdanená (a staršie konečné faktúry) ----------
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
  v_taxed numeric(18, 2) := 0;
  v_untaxed numeric(18, 2) := 0;
  v_linked numeric(18, 2) := 0;
  v_consumed numeric(18, 2) := null;
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
  -- 20261008100009: zdanené zálohy sú mínusovými riadkami → UŽ sú v total_amount (nič sa neodpočítava znova).
  select coalesce(-sum(it.line_gross_amount), 0) into v_taxed
  from public.invoice_items it where it.invoice_id = v_root.id and it.is_advance_deduction;
  -- Staršie (pred 20261008100009) finalizované konečné faktúry bez mínusových riadkov: odpočet mimo súčtu.
  if v_taxed = 0 then
    select coalesce(sum(d.taxable_amount + d.vat_amount), 0) into v_prepaid from public.invoice_advance_deductions d where d.invoice_id = v_root.id;
  else
    v_prepaid := 0;
  end if;
  -- Nezdanená záloha (PrepaidAmount, BT-113): vydaná = untaxed_prepaid_amount, prijatá = prepaid_amount z XML.
  v_untaxed := coalesce(case when v_root.direction = 'issued' then v_root.untaxed_prepaid_amount else v_root.prepaid_amount end, 0);
  v_prepaid := v_prepaid + v_untaxed;
  if v_root.direction = 'received' then
    select coalesce(sum(l.amount), 0) into v_linked from public.received_advance_links l where l.invoice_id = v_root.id;
  end if;
  if v_root.kind = 'payment_received_invoice' then
    if v_root.direction = 'received' then
      select coalesce(sum(l.amount), 0) into v_consumed from public.received_advance_links l
      join public.invoices f on f.id = l.invoice_id where l.advance_invoice_id = v_root.id and f.document_status = 'finalized';
    else
      select coalesce(sum(d.taxable_amount + d.vat_amount), 0) into v_consumed from public.invoice_advance_deductions d
      join public.invoices f on f.id = d.invoice_id where d.advance_invoice_id = v_root.id and f.document_status = 'finalized';
    end if;
  end if;
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
    'items_total', v_root.total_amount + v_taxed, 'advances_taxed', v_taxed, 'prepaid_untaxed', v_untaxed,
    'advances_linked', v_linked,
    'advance_consumed', v_consumed,
    'advance_remaining', case when v_consumed is null then null else v_root.total_amount - v_consumed end,
    'credit_notes_total', v_credits, 'debit_notes_total', v_debits,
    'amount_due', v_due, 'paid', v_paid, 'refunded', v_refunded,
    'balance', v_balance, 'payment_status', v_status);
end;
$function$;
revoke all on function public.esblu_invoice_settlement_core(uuid) from public, anon, authenticated;

-- 7) Prijatá konečná faktúra: väzby po sadzbe na mínusové riadky -------------------------------------
alter table public.received_advance_links
  add column if not exists vat_category_code text,
  add column if not exists vat_rate numeric(7, 4);
alter table public.received_advance_links alter column vat_amount drop not null;
alter table public.received_advance_links drop constraint if exists received_advance_links_invoice_id_advance_invoice_id_key;
create unique index if not exists received_advance_links_rate_uniq
  on public.received_advance_links (invoice_id, advance_invoice_id, coalesce(vat_category_code, ''), coalesce(vat_rate, -1));

-- Zdanený odpočet prijatej konečnej faktúry po (kategória, sadzba) = -Σ základ mínusových riadkov.
create or replace function public.esblu_received_deduction_groups(p_invoice_id uuid)
returns table (vat_category_code text, vat_rate numeric, taxable numeric, vat numeric)
language sql
stable
security definer
set search_path to ''
as $function$
  select it.vat_category_code, (case when it.vat_category_code = 'S' then it.vat_rate else 0 end)::numeric,
         -sum(it.line_net_amount), -sum(it.line_vat_amount)
  from public.invoice_items it
  where it.invoice_id = p_invoice_id and it.is_advance_deduction
  group by 1, 2;
$function$;
revoke all on function public.esblu_received_deduction_groups(uuid) from public, anon, authenticated;

create or replace function public.esblu_received_advance_link_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
  v_a public.invoices%rowtype;
  v_b record;
  v_ded numeric;
  v_used_t numeric;
  v_used_v numeric;
  v_final_t numeric;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.invoices f where f.id = old.invoice_id and f.document_status = 'finalized') then
      raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED',
      hint = 'Väzba sa nemení — odoberie sa a priradí znova.';
  end if;

  select * into v_f from public.invoices f where f.id = new.invoice_id for update;
  if v_f.id is null or v_f.company_id <> new.company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' or v_f.advance_review_status is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_TARGET_INVALID';
  end if;
  if v_f.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED';
  end if;
  -- Zámok zálohy: súbežné priradenie tej istej zálohy dvom faktúram sa serializuje.
  select * into v_a from public.invoices a where a.id = new.advance_invoice_id for update;
  -- Iná firma = „neexistuje“ (žiadny únik existencie cudzieho dokladu).
  if v_a.id is null or v_a.company_id <> v_f.company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_FOUND';
  end if;
  if v_a.direction <> 'received' or v_a.kind <> 'payment_received_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_KIND_INVALID';
  end if;
  if v_a.supplier_business_partner_id is distinct from v_f.supplier_business_partner_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_SUPPLIER_MISMATCH';
  end if;
  if v_a.currency <> v_f.currency then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_CURRENCY_MISMATCH';
  end if;
  if new.vat_category_code is null or new.vat_rate is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH';
  end if;
  -- Sadzba musí byť na zálohe aj na mínusovom riadku konečnej faktúry.
  select b.taxable_amount, b.vat_amount into v_b from public.invoice_tax_breakdowns b
  where b.invoice_id = v_a.id and b.vat_category_code = new.vat_category_code and b.vat_rate = new.vat_rate;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH';
  end if;
  select g.taxable into v_ded from public.esblu_received_deduction_groups(v_f.id) g
  where g.vat_category_code = new.vat_category_code and g.vat_rate = new.vat_rate;
  if v_ded is null or v_ded <= 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH';
  end if;
  if new.taxable_amount is null or new.taxable_amount <= 0 or new.taxable_amount <> round(new.taxable_amount, 2) then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_AMOUNT_INVALID';
  end if;
  if new.vat_amount is null then
    new.vat_amount := case when new.taxable_amount = v_b.taxable_amount then v_b.vat_amount
                           else round(v_b.vat_amount * new.taxable_amount / v_b.taxable_amount, 2) end;
  end if;
  -- Dvojitý odpočet: súčet na zálohe (po sadzbe) nesmie prekročiť základ ani DPH zálohy.
  select coalesce(sum(l.taxable_amount), 0), coalesce(sum(l.vat_amount), 0) into v_used_t, v_used_v
  from public.received_advance_links l
  where l.advance_invoice_id = v_a.id and l.id is distinct from new.id
    and (l.vat_category_code is null or (l.vat_category_code = new.vat_category_code and l.vat_rate = new.vat_rate));
  if v_used_t + new.taxable_amount > v_b.taxable_amount or v_used_v + new.vat_amount > v_b.vat_amount then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_EXCEEDS',
      hint = 'Záloha je už odpočítaná (celá alebo čiastočne) na inej faktúre.';
  end if;
  select coalesce(sum(l.taxable_amount), 0) into v_final_t from public.received_advance_links l
  where l.invoice_id = v_f.id and l.vat_category_code = new.vat_category_code and l.vat_rate = new.vat_rate
    and l.advance_invoice_id <> v_a.id;
  if v_final_t + new.taxable_amount > v_ded then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_EXCEEDS_PREPAID',
      hint = 'Súčet priradených záloh nesmie prekročiť odpočet v mínusových riadkoch faktúry.';
  end if;
  new.amount := new.taxable_amount + new.vat_amount;
  return new;
end;
$function$;
revoke execute on function public.esblu_received_advance_link_guard() from public, anon, authenticated;

-- Párovanie mínusových riadkov na prijaté 386 (iba koncept v review bez väzieb).
create or replace function public.esblu_received_advance_match(p_invoice_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
  v_ref jsonb;
  v_num text;
  v_date date;
  v_cands uuid[];
  v_found uuid[] := array[]::uuid[];
  v_reasons text[] := array[]::text[];
  v_line record;
  v_pick uuid;
  v_n integer;
  v_exact integer;
  v_has_rate boolean;
  v_vat numeric;
  v_status text;
  v_a public.invoices%rowtype;
begin
  select * into v_f from public.invoices f where f.id = p_invoice_id for update;
  if v_f.id is null or v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' or v_f.document_status <> 'draft'
     or v_f.advance_review_status is distinct from 'review'
     or exists (select 1 from public.received_advance_links l where l.invoice_id = v_f.id)
     or not exists (select 1 from public.invoice_items it where it.invoice_id = v_f.id and it.is_advance_deduction) then
    return v_f.advance_review_status;
  end if;

  if v_f.advance_references is null or jsonb_array_length(v_f.advance_references) = 0 then
    v_reasons := array_append(v_reasons, 'ADVANCE_REFERENCE_MISSING');
  else
    for v_ref in select r from jsonb_array_elements(v_f.advance_references) r
    loop
      v_num := upper(regexp_replace(coalesce(v_ref ->> 'number', ''), '[\s\-/]', '', 'g'));
      v_date := case when coalesce(v_ref ->> 'issue_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_ref ->> 'issue_date')::date end;
      if v_num = '' then
        continue;
      end if;
      select coalesce(array_agg(a.id order by a.created_at), array[]::uuid[]) into v_cands
      from public.invoices a
      where a.company_id = v_f.company_id and a.direction = 'received' and a.kind = 'payment_received_invoice'
        and a.supplier_business_partner_id = v_f.supplier_business_partner_id
        and upper(regexp_replace(coalesce(a.supplier_invoice_number, ''), '[\s\-/]', '', 'g')) = v_num
        and (v_date is null or a.issue_date = v_date);
      if cardinality(v_cands) = 0 then
        if exists (select 1 from public.invoices a
                   where a.company_id = v_f.company_id and a.direction = 'received' and a.kind = 'payment_received_invoice'
                     and a.supplier_business_partner_id is distinct from v_f.supplier_business_partner_id
                     and upper(regexp_replace(coalesce(a.supplier_invoice_number, ''), '[\s\-/]', '', 'g')) = v_num) then
          v_reasons := array_append(v_reasons, 'ADVANCE_SUPPLIER_MISMATCH');
        else
          v_reasons := array_append(v_reasons, 'ADVANCE_NOT_FOUND');
        end if;
      elsif cardinality(v_cands) > 1 then
        v_reasons := array_append(v_reasons, 'ADVANCE_AMBIGUOUS');
      elsif not (v_cands[1] = any (v_found)) then
        select * into v_a from public.invoices a where a.id = v_cands[1];
        if v_a.currency <> v_f.currency then
          v_reasons := array_append(v_reasons, 'ADVANCE_CURRENCY_MISMATCH');
        else
          v_found := array_append(v_found, v_a.id);
        end if;
      end if;
    end loop;
    if cardinality(v_found) = 0 and cardinality(v_reasons) = 0 then
      v_reasons := array_append(v_reasons, 'ADVANCE_REFERENCE_MISSING');
    end if;
  end if;

  if cardinality(v_reasons) = 0 then
    -- Zostatok základu každej nájdenej zálohy po (kategória, sadzba); väzby iných faktúr sa odpočítajú.
    create temporary table if not exists esblu_adv_rem (
      advance_id uuid, cat text, rate numeric, taxable numeric, vat numeric, remaining numeric
    ) on commit drop;
    delete from pg_temp.esblu_adv_rem;
    create temporary table if not exists esblu_adv_pick (
      advance_id uuid, cat text, rate numeric, taxable numeric, vat numeric
    ) on commit drop;
    delete from pg_temp.esblu_adv_pick;
    insert into pg_temp.esblu_adv_rem
    select b.invoice_id, b.vat_category_code, b.vat_rate, b.taxable_amount, b.vat_amount,
           b.taxable_amount - coalesce((select sum(l.taxable_amount) from public.received_advance_links l
                                        where l.advance_invoice_id = b.invoice_id and l.invoice_id <> v_f.id
                                          and (l.vat_category_code is null
                                               or (l.vat_category_code = b.vat_category_code and l.vat_rate = b.vat_rate))), 0)
    from public.invoice_tax_breakdowns b where b.invoice_id = any (v_found);

    for v_line in
      select it.position, it.vat_category_code as cat,
             (case when it.vat_category_code = 'S' then it.vat_rate else 0 end)::numeric as rate,
             -it.line_net_amount as base, -it.line_vat_amount as line_vat
      from public.invoice_items it
      where it.invoice_id = v_f.id and it.is_advance_deduction
      order by it.position
    loop
      select count(*), count(*) filter (where r.remaining = v_line.base) into v_n, v_exact
      from pg_temp.esblu_adv_rem r where r.cat = v_line.cat and r.rate = v_line.rate and r.remaining >= v_line.base;
      if v_exact = 1 then
        select r.advance_id into v_pick from pg_temp.esblu_adv_rem r
        where r.cat = v_line.cat and r.rate = v_line.rate and r.remaining = v_line.base;
      elsif v_n = 1 then
        select r.advance_id into v_pick from pg_temp.esblu_adv_rem r
        where r.cat = v_line.cat and r.rate = v_line.rate and r.remaining >= v_line.base;
      elsif v_n = 0 then
        select exists (select 1 from pg_temp.esblu_adv_rem r where r.cat = v_line.cat and r.rate = v_line.rate) into v_has_rate;
        v_reasons := array_append(v_reasons, case when v_has_rate then 'ADVANCE_ALREADY_DEDUCTED' else 'ADVANCE_RATE_MISMATCH' end);
        continue;
      else
        v_reasons := array_append(v_reasons, 'ADVANCE_AMBIGUOUS');
        continue;
      end if;
      -- DPH odpočtu: celá záloha v tejto sadzbe → DPH zálohy; inak pomerne. Musí sedieť s DPH riadka (± 0,01).
      select case when r.remaining = r.taxable and v_line.base = r.taxable then r.vat
                  else round(r.vat * v_line.base / r.taxable, 2) end
        into v_vat
      from pg_temp.esblu_adv_rem r where r.advance_id = v_pick and r.cat = v_line.cat and r.rate = v_line.rate;
      if abs(v_vat - v_line.line_vat) > 0.01 then
        v_reasons := array_append(v_reasons, 'ADVANCE_VAT_MISMATCH');
      end if;
      update pg_temp.esblu_adv_rem r set remaining = r.remaining - v_line.base
      where r.advance_id = v_pick and r.cat = v_line.cat and r.rate = v_line.rate;
      insert into pg_temp.esblu_adv_pick values (v_pick, v_line.cat, v_line.rate, v_line.base, v_vat);
    end loop;
  end if;

  v_reasons := array(select r from unnest(v_reasons) with ordinality u(r, o) group by r order by min(o));

  if cardinality(v_reasons) = 0 then
    insert into public.received_advance_links (company_id, invoice_id, advance_invoice_id, vat_category_code, vat_rate,
                                               amount, taxable_amount, vat_amount, source, created_by)
    select v_f.company_id, v_f.id, p.advance_id, p.cat, p.rate, 0, sum(p.taxable), sum(p.vat), 'auto', null
    from pg_temp.esblu_adv_pick p group by p.advance_id, p.cat, p.rate;
    v_status := 'proposed';
  else
    v_status := 'review';
  end if;
  update public.invoices i
  set advance_review_status = v_status, advance_review_reasons = v_reasons, updated_at = now()
  where i.id = v_f.id;
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (v_f.id, 'advance_reviewed', null, 'system',
          jsonb_build_object('action', case when v_status = 'proposed' then 'auto_proposed' else 'needs_review' end,
                             'reasons', to_jsonb(v_reasons), 'advance_invoice_ids', to_jsonb(v_found)));
  return v_status;
end;
$function$;
revoke all on function public.esblu_received_advance_match(uuid) from public, anon, authenticated;

-- Finalizácia prijatej konečnej faktúry s mínusovými riadkami: väzby po sadzbe presne = odpočet.
create or replace function public.esblu_a_received_advance_finalize()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.advance_review_status not in ('proposed', 'linked') then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_REVIEW_REQUIRED',
      hint = 'Najprv priraďte prijaté zálohy (faktúry k prijatej platbe), ktoré dodávateľ odpočítal.';
  end if;
  perform 1 from public.invoices a
  where a.id in (select l.advance_invoice_id from public.received_advance_links l where l.invoice_id = new.id)
  order by a.id for update;
  if exists (
    select 1 from public.esblu_received_deduction_groups(new.id) g
    where g.taxable <> coalesce((select sum(l.taxable_amount) from public.received_advance_links l
                                 where l.invoice_id = new.id and l.vat_category_code = g.vat_category_code and l.vat_rate = g.vat_rate), 0)
  ) or exists (
    select 1 from public.received_advance_links l where l.invoice_id = new.id
      and not exists (select 1 from public.esblu_received_deduction_groups(new.id) g
                      where g.vat_category_code = l.vat_category_code and g.vat_rate = l.vat_rate)
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_AMOUNT_MISMATCH';
  end if;
  if exists (select 1 from public.received_advance_links l join public.invoices a on a.id = l.advance_invoice_id
             where l.invoice_id = new.id and a.document_status <> 'finalized') then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_FINALIZED',
      hint = 'Najprv finalizujte prijatú faktúru k prijatej platbe.';
  end if;
  if new.advance_review_status = 'proposed' then
    new.advance_review_status := 'linked';
    new.advance_reviewed_at := now();
    new.advance_reviewed_by := auth.uid();
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_a_received_advance_finalize() from public, anon, authenticated;
drop trigger if exists esblu_a_received_advance_finalize on public.invoices;
create trigger esblu_a_received_advance_finalize
  before update of document_status on public.invoices
  for each row
  when (old.document_status = 'draft' and new.document_status = 'finalized' and new.direction = 'received'
        and new.kind = 'regular_invoice' and new.advance_review_status is not null)
  execute function public.esblu_a_received_advance_finalize();

create or replace function public.esblu_received_advance_target(p_invoice_id uuid)
returns public.invoices
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
begin
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_f from public.invoices i where i.id = p_invoice_id for update;
  if v_f.id is null or v_f.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_f.advance_review_status is null or v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_TARGET_INVALID';
  end if;
  if v_f.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED';
  end if;
  return v_f;
end;
$function$;
revoke all on function public.esblu_received_advance_target(uuid) from public, anon, authenticated;

create or replace function public.esblu_received_advance_refresh_status(p_invoice_id uuid, p_action text, p_extra jsonb)
returns text
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_n integer;
  v_status text;
  v_reasons text[];
begin
  select count(*) into v_n from public.received_advance_links l where l.invoice_id = p_invoice_id;
  if not exists (
       select 1 from public.esblu_received_deduction_groups(p_invoice_id) g
       where g.taxable <> coalesce((select sum(l.taxable_amount) from public.received_advance_links l
                                    where l.invoice_id = p_invoice_id and l.vat_category_code = g.vat_category_code
                                      and l.vat_rate = g.vat_rate), 0)) then
    v_status := 'linked'; v_reasons := array[]::text[];
  else
    v_status := 'review';
    v_reasons := case when v_n = 0 then array['ADVANCE_NOT_ASSIGNED'] else array['ADVANCE_PARTIALLY_ASSIGNED'] end;
  end if;
  update public.invoices i
  set advance_review_status = v_status, advance_review_reasons = v_reasons,
      advance_reviewed_at = case when v_status = 'linked' then now() else null end,
      advance_reviewed_by = case when v_status = 'linked' then auth.uid() else null end,
      updated_at = now(), updated_by = auth.uid()
  where i.id = p_invoice_id;
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'advance_reviewed', auth.uid(), 'user', jsonb_build_object('action', p_action, 'status', v_status) || coalesce(p_extra, '{}'::jsonb));
  return v_status;
end;
$function$;
revoke all on function public.esblu_received_advance_refresh_status(uuid, text, jsonb) from public, anon, authenticated;

-- Ručné priradenie: p_amount = ZÁKLAD odpočtu (null = zvyšok). Sadzba = jediná spoločná nepriradená sadzba
-- mínusových riadkov a zálohy; inak ESBLU_RECEIVED_ADVANCE_RATE_AMBIGUOUS / _RATE_MISMATCH.
create or replace function public.esblu_received_advance_link(p_invoice_id uuid, p_advance_invoice_id uuid, p_amount numeric default null)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype := public.esblu_received_advance_target(p_invoice_id);
  v_a record;
  v_cat text;
  v_rate numeric;
  v_n integer;
  v_open numeric;
  v_rem numeric;
  v_amount numeric(18, 2);
begin
  select a.id, a.company_id into v_a from public.invoices a where a.id = p_advance_invoice_id;
  if v_a.id is null or v_a.company_id <> v_f.company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_FOUND';
  end if;
  select count(*), min(g.vat_category_code), min(g.vat_rate) into v_n, v_cat, v_rate
  from public.esblu_received_deduction_groups(v_f.id) g
  join public.invoice_tax_breakdowns b on b.invoice_id = p_advance_invoice_id
                                      and b.vat_category_code = g.vat_category_code and b.vat_rate = g.vat_rate
  where g.taxable > coalesce((select sum(l.taxable_amount) from public.received_advance_links l
                              where l.invoice_id = v_f.id and l.vat_category_code = g.vat_category_code and l.vat_rate = g.vat_rate), 0);
  if v_n = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH';
  elsif v_n > 1 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_AMBIGUOUS';
  end if;
  if exists (select 1 from public.received_advance_links l where l.invoice_id = v_f.id and l.advance_invoice_id = p_advance_invoice_id
             and l.vat_category_code = v_cat and l.vat_rate = v_rate) then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_ALREADY_LINKED';
  end if;
  if p_amount is null then
    select g.taxable - coalesce((select sum(l.taxable_amount) from public.received_advance_links l
                                 where l.invoice_id = v_f.id and l.vat_category_code = v_cat and l.vat_rate = v_rate), 0)
      into v_open from public.esblu_received_deduction_groups(v_f.id) g where g.vat_category_code = v_cat and g.vat_rate = v_rate;
    select b.taxable_amount - coalesce((select sum(l.taxable_amount) from public.received_advance_links l
                                        where l.advance_invoice_id = p_advance_invoice_id
                                          and (l.vat_category_code is null or (l.vat_category_code = v_cat and l.vat_rate = v_rate))), 0)
      into v_rem from public.invoice_tax_breakdowns b
    where b.invoice_id = p_advance_invoice_id and b.vat_category_code = v_cat and b.vat_rate = v_rate;
    v_amount := least(v_open, v_rem);
  else
    v_amount := p_amount;
  end if;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_AMOUNT_INVALID';
  end if;
  -- Guard vynúti firmu, smer, druh, dodávateľa, menu, sadzbu a limity (záloha aj odpočet faktúry).
  insert into public.received_advance_links (company_id, invoice_id, advance_invoice_id, vat_category_code, vat_rate,
                                             amount, taxable_amount, vat_amount, source, created_by)
  values (v_f.company_id, v_f.id, p_advance_invoice_id, v_cat, v_rate, 0, v_amount, null, 'manual', auth.uid());
  return public.esblu_received_advance_refresh_status(p_invoice_id, 'manual_linked',
    jsonb_build_object('advance_invoice_id', p_advance_invoice_id, 'taxable_amount', v_amount, 'vat_rate', v_rate));
end;
$function$;
revoke all on function public.esblu_received_advance_link(uuid, uuid, numeric) from public, anon;
grant execute on function public.esblu_received_advance_link(uuid, uuid, numeric) to authenticated;

-- 8) Súčty z XML: tolerancia DPH skupiny 0,01 (Peppol BR-CO-17 pripúšťa ±1) — mínusové riadky záloh
--    menia rekapituláciu o DPH zálohy, ktorá sa od základ × sadzba môže líšiť o zaokrúhlenie.
do $patch$
declare
  r record;
  d text;
  v_new text;
  v_seen integer := 0;
  v_found integer := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'esblu_einvoice_apply_xml_totals'
  loop
    v_found := v_found + 1;
    d := pg_get_functiondef(r.oid);
    v_new := replace(d, 'if v_rate <= 0 or v_bvat <> round(v_taxable * v_rate / 100, 2) then',
                        'if v_rate <= 0 or abs(v_bvat - round(v_taxable * v_rate / 100, 2)) > 0.01 then');
    if v_new <> d then
      execute v_new;
      v_seen := v_seen + 1;
    elsif position('abs(v_bvat - round(v_taxable * v_rate / 100, 2)) > 0.01' in d) > 0 then
      v_seen := v_seen + 1;
    end if;
  end loop;
  if v_found > 0 and v_seen <> v_found then
    raise exception 'APPLY_XML_TOTALS_VAT_ANCHOR_MISSING';
  end if;
end
$patch$;

-- 9) create_draft: mínusové riadky zálohy → riadky odpočtu + párovanie; BT-113 = nezdanená záloha -----
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
  v_kind text := coalesce(p_draft ->> 'document_kind', 'regular_invoice');
  v_prepaid numeric;
  v_invoice_id uuid;
  v_existing uuid;
  v_final record;
  v_items jsonb;
  v_ded_items jsonb;
  v_has_deductions boolean;
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
  if v_kind not in ('regular_invoice', 'payment_received_invoice', 'credit_note', 'debit_note') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_KIND_UNSUPPORTED';
  end if;
  begin
    v_prepaid := coalesce(nullif(p_draft -> 'totals' ->> 'prepaid', ''), '0')::numeric;
  exception when others then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_INCONSISTENT', hint = 'NUMBER';
  end;
  -- 20261008100009: mínusové riadky zdanených záloh (FS FAQ eFaktúra, príklad 38) — iba konečná (bežná) faktúra.
  v_items := coalesce(p_draft -> 'items', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NO_ITEMS';
  end if;
  select coalesce(jsonb_agg(x) filter (where coalesce((x ->> 'advance_deduction')::boolean, false)), '[]'::jsonb),
         coalesce(jsonb_agg(x) filter (where not coalesce((x ->> 'advance_deduction')::boolean, false)), '[]'::jsonb)
    into v_ded_items, v_items
  from jsonb_array_elements(v_items) x;
  v_has_deductions := jsonb_array_length(v_ded_items) > 0;
  if v_has_deductions and v_kind <> 'regular_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_INCONSISTENT', hint = 'ADVANCE_LINES_KIND';
  end if;
  -- BT-113 (nezdanená záloha) iba na konečnej (bežnej) faktúre.
  if v_prepaid <> 0 and v_kind <> 'regular_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_INCONSISTENT', hint = 'UNSUPPORTED_AMOUNTS';
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

  if v_kind in ('credit_note', 'debit_note') then
    perform set_config('esblu.einvoice_event_source', '', true);
    return public.esblu_einvoice_inbound_create_correction(p_inbound_id, p_draft);
  end if;

  v_partner := public.esblu_einvoice_resolve_supplier(v_in.company_id, coalesce(p_draft -> 'supplier', '{}'::jsonb));

  -- 20261008100008: faktúra k prijatej platbe — duplicita podľa (dodávateľ, druh, číslo) PRED vznikom konceptu
  -- (jadro konceptu porovnáva iba bežné faktúry; transport ID a odtlačok kontroluje jadro).
  if v_kind = 'payment_received_invoice' then
    select i.id into v_existing
    from public.invoices i
    where i.company_id = v_in.company_id and i.direction = 'received' and i.kind = 'payment_received_invoice'
      and i.supplier_business_partner_id = v_partner
      and upper(regexp_replace(coalesce(i.supplier_invoice_number, ''), '[\s\-/]', '', 'g'))
          = upper(regexp_replace(btrim(coalesce(p_draft ->> 'invoice_number', '')), '[\s\-/]', '', 'g'))
    order by i.created_at
    limit 1;
  end if;

  if v_existing is not null then
    v_result := jsonb_build_object('status', 'duplicate', 'existing_invoice_id', v_existing, 'matched_on', 'supplier_invoice_number');
  else
    v_result := public.esblu_received_invoice_draft_core(
      v_in.company_id, null, 'efaktura_peppol', v_in.provider, v_in.provider_received_id,
      v_partner,
      p_draft ->> 'invoice_number',
      nullif(p_draft ->> 'issue_date', '')::date,
      v_items,
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
  end if;

  v_status := case when v_result ->> 'status' = 'created' then 'draft_created' else 'duplicate' end;
  if v_status = 'draft_created' then
    v_invoice_id := (v_result ->> 'invoice_id')::uuid;
    if v_kind = 'payment_received_invoice' then
      -- Samostatný druh (UBL 386), BT-7 = dátum prijatia platby. O odpočte DPH sa nerozhoduje.
      update public.invoices i
      set kind = 'payment_received_invoice',
          tax_point_date = case when coalesce(p_draft ->> 'tax_point_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
                                then (p_draft ->> 'tax_point_date')::date end,
          updated_at = now()
      where i.id = v_invoice_id;
    end if;
    if v_has_deductions then
      -- Mínusové riadky: množstvo 1, záporná cena = suma riadka z XML (BT-131); sadzba a kategória z XML.
      insert into public.invoice_items (invoice_id, position, description, quantity, unit, unit_code, unit_price, price_mode,
                                        vat_category_code, vat_rate, is_advance_deduction, line_net_amount, line_vat_amount, line_gross_amount)
      select v_invoice_id,
             (select coalesce(max(x.position), 0) from public.invoice_items x where x.invoice_id = v_invoice_id) + d.ord,
             left(btrim(coalesce(d.item ->> 'description', 'Odpočet zálohy')), 500),
             1, 'ks', nullif(d.item ->> 'unit_code', ''), (d.item ->> 'unit_price')::numeric, 'net',
             d.item ->> 'vat_category_code',
             case when d.item ->> 'vat_category_code' = 'S' then (d.item ->> 'vat_rate')::numeric else 0 end,
             true, round((d.item ->> 'unit_price')::numeric, 2), 0, round((d.item ->> 'unit_price')::numeric, 2)
      from jsonb_array_elements(v_ded_items) with ordinality as d(item, ord);
    end if;

    v_totals := public.esblu_einvoice_apply_xml_totals(v_invoice_id, p_draft -> 'totals', p_draft ->> 'payment_means_code');

    -- BT-113 = NEZDANENÁ záloha (FS príklad 38): iba znižuje sumu na úhradu, nič sa nepáruje.
    if v_kind = 'regular_invoice' and v_prepaid > 0 then
      update public.invoices i set prepaid_amount = v_prepaid, updated_at = now() where i.id = v_invoice_id;
    end if;

    if v_has_deductions then
      update public.invoices i
      set advance_references = coalesce(
            (select jsonb_agg(jsonb_build_object('number', left(btrim(r ->> 'number'), 200),
                                                 'issue_date', case when coalesce(r ->> 'issue_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then r ->> 'issue_date' end))
               from (select r from jsonb_array_elements(case when jsonb_typeof(p_draft -> 'advance' -> 'references') = 'array'
                                                             then p_draft -> 'advance' -> 'references' else '[]'::jsonb end) r
                     where jsonb_typeof(r) = 'object' and btrim(coalesce(r ->> 'number', '')) <> '' limit 20) x),
            '[]'::jsonb),
          advance_review_status = 'review',
          advance_review_reasons = array[]::text[],
          updated_at = now()
      where i.id = v_invoice_id;
      perform public.esblu_received_advance_match(v_invoice_id);
    end if;

    if v_kind = 'payment_received_invoice' then
      -- Záloha prišla PO konečnej faktúre → dodatočné párovanie konceptov v review toho istého dodávateľa.
      for v_final in
        select f.id from public.invoices f
        where f.company_id = v_in.company_id and f.direction = 'received' and f.kind = 'regular_invoice'
          and f.document_status = 'draft' and f.advance_review_status = 'review'
          and f.supplier_business_partner_id = v_partner
          and not exists (select 1 from public.received_advance_links l where l.invoice_id = f.id)
          and exists (select 1 from jsonb_array_elements(coalesce(f.advance_references, '[]'::jsonb)) r
                      where upper(regexp_replace(coalesce(r ->> 'number', ''), '[\s\-/]', '', 'g'))
                            = upper(regexp_replace(btrim(coalesce(p_draft ->> 'invoice_number', '')), '[\s\-/]', '', 'g')))
        order by f.created_at
      loop
        perform public.esblu_received_advance_match(v_final.id);
      end loop;
    end if;

    if v_kind = 'regular_invoice' then
      -- 20261008100007: oprava mohla prísť (alebo sa spracovať) SKÔR než originál → dodatočné prepojenie
      -- čakajúcich opráv v review: tá istá firma, ten istý dodávateľ, BT-25 = číslo tejto faktúry (a BT-26, ak je).
      with linked as (
        update public.invoices c
        set corrects_invoice_id = v_invoice_id,
            correction_review_reasons = array_append(
              array(select r from unnest(coalesce(c.correction_review_reasons, array[]::text[])) r
                    where r not in ('ORIGINAL_REFERENCE_MISSING', 'ORIGINAL_NOT_FOUND', 'ORIGINAL_AMBIGUOUS', 'ORIGINAL_NOT_FINALIZED')),
              'ORIGINAL_NOT_FINALIZED'),
            updated_at = now()
        where c.company_id = v_in.company_id and c.direction = 'received' and c.kind in ('credit_note', 'debit_note')
          and c.document_status = 'draft' and c.correction_review_status = 'review' and c.corrects_invoice_id is null
          and c.supplier_business_partner_id = v_partner
          and upper(regexp_replace(coalesce(c.corrected_document_reference, ''), '[\s\-/]', '', 'g'))
              = upper(regexp_replace(coalesce(p_draft ->> 'invoice_number', ''), '[\s\-/]', '', 'g'))
          and (c.corrected_document_issue_date is null or c.corrected_document_issue_date = nullif(p_draft ->> 'issue_date', '')::date)
        returning c.id
      )
      insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
      select l.id, 'correction_reviewed', null, 'system',
             jsonb_build_object('action', 'auto_linked', 'original_invoice_id', v_invoice_id)
      from linked l;
    end if;
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
    'matched_on', v_result ->> 'matched_on',
    'document_kind', v_kind
  );
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) to service_role;
