-- =============================================================================
-- Fakturácia — súlad so slovenskými predpismi (audit 2026-10, docs/einvoice-sk-accounting-legal-audit-2026-10.md).
-- Aditívne. NEAPLIKOVAŤ do produkcie bez schválenia. Rollback: supabase/rollback/20261008100000_invoicing_sk_compliance_rollback.sql
--
-- Zdroje (Slov-Lex, znenie účinné od 1. 1. 2027): zákon č. 222/2004 Z. z. o DPH § 19 ods. 4, § 25, § 26 ods. 1,
-- § 27, § 69 ods. 12, § 71 ods. 2–3, § 72, § 73, § 74, § 76, § 85o (zákon č. 385/2025 Z. z.); zákon č. 431/2002 Z. z.
-- o účtovníctve § 8, § 10, § 31–35.
--
--  1) kind 'proforma' (výzva na úhradu) — nie je daňový doklad, vlastná séria PF, nikdy e-faktúra.
--  2) Draft-only polia: correction_reason, kurz cudzej meny (fx_rate = jednotky meny za 1 EUR, ECB konvencia),
--     fx_rate_date, fx_rate_source; tax_point_date pre vydané doklady (dátum prijatia platby / DUZP).
--     Po finalizácii sú nemenné (deny-by-default trigger esblu_block_finalized_invoice_mutation).
--  3) Pri finalizácii (draft → finalized, vydané doklady) sa overí: dátum dodania / prijatia platby, povolené
--     SK sadzby pre kategóriu S, neplatiteľ DPH bez DPH, IČ DPH odberateľa pri prenesení daňovej povinnosti a
--     dodaní do EÚ, kurz pri cudzej mene (+ EUR základ a daň podľa § 26), dôvod opravy, kumulatívny strop
--     dobropisov, väzba opravy (nie na proformu), odpočet záloh. Esblu NErozhoduje, aká sadzba patrí tovaru —
--     iba odmietne sadzbu, ktorú zákon nepozná.
--  4) Rozpis DPH: bez explicitného dôvodu sa doplní zákonom dovolený text oslobodenia / „prenesenie daňovej
--     povinnosti“ (§ 74 ods. 1 písm. h), k)).
--  5) Odpočet záloh (invoice_advance_deductions) — väzba konečnej faktúry na faktúry k prijatej platbe.
--  6) Audit: invoice_events append-only; correction_created sa zapisuje; snapshoty finalizovaného dokladu
--     nemožno doplniť (INSERT guard); úhrada dobropisu je zakázaná.
-- =============================================================================

-- 1) kind proforma -------------------------------------------------------------------------
alter table public.invoices drop constraint if exists invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check
  check (kind in ('regular_invoice', 'payment_received_invoice', 'credit_note', 'debit_note', 'proforma'));
alter table public.invoices drop constraint if exists invoices_proforma_issued_only;
alter table public.invoices add constraint invoices_proforma_issued_only
  check (kind <> 'proforma' or direction = 'issued');

-- 2) Draft-only polia ----------------------------------------------------------------------
alter table public.invoices
  add column if not exists correction_reason text,
  add column if not exists fx_rate numeric(18,6),
  add column if not exists fx_rate_date date,
  add column if not exists fx_rate_source text,
  add column if not exists tax_base_eur numeric(18,2),
  add column if not exists vat_total_eur numeric(18,2);
alter table public.invoices drop constraint if exists invoices_correction_reason_check;
alter table public.invoices add constraint invoices_correction_reason_check
  check (correction_reason is null or (correction_reason = btrim(correction_reason) and char_length(correction_reason) between 3 and 500));
alter table public.invoices drop constraint if exists invoices_fx_rate_check;
alter table public.invoices add constraint invoices_fx_rate_check check (fx_rate is null or fx_rate > 0);
alter table public.invoices drop constraint if exists invoices_fx_rate_source_check;
alter table public.invoices add constraint invoices_fx_rate_source_check check (fx_rate_source is null or fx_rate_source in ('ECB', 'NBS', 'CUSTOMS'));
alter table public.invoices drop constraint if exists invoices_currency_format;
alter table public.invoices add constraint invoices_currency_format check (currency ~ '^[A-Z]{3}$') not valid;
comment on column public.invoices.fx_rate is 'Jednotky cudzej meny za 1 EUR (konvencia ECB/NBS). EUR suma = suma / fx_rate. § 26 ods. 1 zákona o DPH.';

-- Povolené SK sadzby pre kategóriu S podľa rozhodného dňa (§ 27; od 1. 1. 2025: 23 / 19 / 5 %).
create or replace function public.esblu_sk_vat_rates(p_date date)
returns numeric[]
language sql
immutable
set search_path to ''
as $function$
  select case when p_date >= date '2025-01-01' then array[23, 19, 5]::numeric[] else array[20, 10, 5]::numeric[] end;
$function$;

-- Úprava draft-only polí (finance.manage, aktívna firma, iba draft). Iba whitelist kľúčov.
create or replace function public.esblu_set_invoice_compliance_fields(p_invoice_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
  v_keys text[];
begin
  if p_invoice_id is null or p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ARGUMENT';
  end if;
  select array_agg(k) into v_keys from jsonb_object_keys(p_fields) k;
  if exists (select 1 from unnest(v_keys) k where k not in ('correction_reason', 'fx_rate', 'fx_rate_date', 'fx_rate_source', 'tax_point_date')) then
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
  update public.invoices i set
    correction_reason = case when p_fields ? 'correction_reason' then nullif(btrim(p_fields ->> 'correction_reason'), '') else i.correction_reason end,
    fx_rate = case when p_fields ? 'fx_rate' then nullif(p_fields ->> 'fx_rate', '')::numeric else i.fx_rate end,
    fx_rate_date = case when p_fields ? 'fx_rate_date' then nullif(p_fields ->> 'fx_rate_date', '')::date else i.fx_rate_date end,
    fx_rate_source = case when p_fields ? 'fx_rate_source' then nullif(upper(btrim(p_fields ->> 'fx_rate_source')), '') else i.fx_rate_source end,
    tax_point_date = case when p_fields ? 'tax_point_date' then nullif(p_fields ->> 'tax_point_date', '')::date else i.tax_point_date end,
    updated_at = now(), updated_by = auth.uid()
  where i.id = p_invoice_id;
end;
$function$;
revoke all on function public.esblu_set_invoice_compliance_fields(uuid, jsonb) from public, anon;
grant execute on function public.esblu_set_invoice_compliance_fields(uuid, jsonb) to authenticated;

-- 5) Odpočet záloh -------------------------------------------------------------------------
create table if not exists public.invoice_advance_deductions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  advance_invoice_id uuid not null references public.invoices(id),
  vat_category_code text not null,
  vat_rate numeric(7,4) not null check (vat_rate >= 0),
  taxable_amount numeric(18,2) not null check (taxable_amount > 0),
  vat_amount numeric(18,2) not null check (vat_amount >= 0),
  created_at timestamptz not null default now(),
  unique (invoice_id, advance_invoice_id, vat_category_code, vat_rate),
  check (invoice_id <> advance_invoice_id)
);
create index if not exists invoice_advance_deductions_advance_idx on public.invoice_advance_deductions (advance_invoice_id);
alter table public.invoice_advance_deductions enable row level security;
revoke all on table public.invoice_advance_deductions from public, anon, authenticated;
grant select on table public.invoice_advance_deductions to authenticated;
grant select, insert, update, delete on table public.invoice_advance_deductions to service_role;
drop policy if exists invoice_advance_deductions_select_finance on public.invoice_advance_deductions;
create policy invoice_advance_deductions_select_finance on public.invoice_advance_deductions
  for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id
                 and i.company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view()));

-- Nastavenie odpočtov na draft konečnej faktúry (nahradí všetky riadky). p_rows: [{advance_invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount}]
create or replace function public.esblu_set_invoice_advance_deductions(p_invoice_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
  v_n integer;
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

-- Odpočty sú nemenné, keď je konečná faktúra finalizovaná.
create or replace function public.esblu_block_finalized_advance_deductions()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_status text;
begin
  select i.document_status into v_status from public.invoices i where i.id = coalesce(new.invoice_id, old.invoice_id);
  if v_status = 'finalized' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE';
  end if;
  return coalesce(new, old);
end;
$function$;
drop trigger if exists esblu_advance_deductions_immutability on public.invoice_advance_deductions;
create trigger esblu_advance_deductions_immutability before insert or update or delete on public.invoice_advance_deductions
  for each row execute function public.esblu_block_finalized_advance_deductions();

-- 4) Rozpis DPH: zákonný text oslobodenia / prenesenia ---------------------------------------
create or replace function public.esblu_default_breakdown_exemption()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.vat_category_code = 'S' or new.vat_category_code = 'Z' then
    return new;
  end if;
  if new.vat_exemption_reason_code is null then
    new.vat_exemption_reason_code := case new.vat_category_code
      when 'AE' then 'VATEX-EU-AE' when 'K' then 'VATEX-EU-IC' when 'G' then 'VATEX-EU-G' when 'O' then 'VATEX-EU-O' else null end;
  end if;
  if new.vat_exemption_reason_text is null then
    new.vat_exemption_reason_text := case new.vat_category_code
      when 'AE' then 'Prenesenie daňovej povinnosti'
      when 'E' then 'Dodanie je oslobodené od dane'
      when 'K' then 'Dodanie je oslobodené od dane (§ 43 zákona č. 222/2004 Z. z.)'
      when 'G' then 'Dodanie je oslobodené od dane (vývoz tovaru, § 47 zákona č. 222/2004 Z. z.)'
      when 'O' then 'Plnenie nie je predmetom DPH v tuzemsku'
      else null end;
  end if;
  return new;
end;
$function$;
drop trigger if exists esblu_breakdown_exemption_default on public.invoice_tax_breakdowns;
create trigger esblu_breakdown_exemption_default before insert on public.invoice_tax_breakdowns
  for each row execute function public.esblu_default_breakdown_exemption();

-- 6) INSERT guard snapshotov finalizovaného dokladu ---------------------------------------
create or replace function public.esblu_block_snapshot_insert_when_finalized()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if exists (select 1 from public.invoices i where i.id = new.invoice_id and i.document_status = 'finalized') then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE';
  end if;
  return new;
end;
$function$;
drop trigger if exists esblu_parties_insert_guard on public.invoice_parties;
create trigger esblu_parties_insert_guard before insert on public.invoice_parties
  for each row execute function public.esblu_block_snapshot_insert_when_finalized();
drop trigger if exists esblu_breakdowns_insert_guard on public.invoice_tax_breakdowns;
create trigger esblu_breakdowns_insert_guard before insert on public.invoice_tax_breakdowns
  for each row execute function public.esblu_block_snapshot_insert_when_finalized();

-- invoice_events: append-only
create or replace function public.esblu_invoice_events_append_only()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_EVENTS_APPEND_ONLY';
end;
$function$;
drop trigger if exists esblu_invoice_events_append_only on public.invoice_events;
create trigger esblu_invoice_events_append_only before update or delete on public.invoice_events
  for each row execute function public.esblu_invoice_events_append_only();

-- Úhrada sa nezapisuje k dobropisu (dobropis znižuje pohľadávku, nie je to pohľadávka na úhradu).
create or replace function public.esblu_block_payment_on_credit_note()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if exists (select 1 from public.invoices i where i.id = new.invoice_id and i.kind = 'credit_note') then
    raise exception using errcode = 'P0001', message = 'ESBLU_PAYMENT_ON_CREDIT_NOTE';
  end if;
  return new;
end;
$function$;
drop trigger if exists esblu_payment_credit_note_guard on public.invoice_payments;
create trigger esblu_payment_credit_note_guard before insert on public.invoice_payments
  for each row execute function public.esblu_block_payment_on_credit_note();

-- 3) Kontroly pri finalizácii (draft → finalized) ------------------------------------------
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
begin
  if not (old.document_status = 'draft' and new.document_status = 'finalized') then
    return new;
  end if;

  -- Cudzia mena: kurz povinný pre VŠETKY smery (EUR základ a daň, § 26 ods. 1).
  if new.currency <> 'EUR' then
    if new.fx_rate is null or new.fx_rate_date is null or new.fx_rate_source is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_REQUIRED',
        hint = 'Pri cudzej mene uveďte kurz (jednotky meny za 1 EUR), jeho dátum a zdroj (ECB / NBS / colný kurz).';
    end if;
    v_eff := coalesce(new.tax_point_date, new.delivery_date, new.issue_date);
    if new.fx_rate_source in ('ECB', 'NBS') and (new.fx_rate_date >= v_eff or new.fx_rate_date < v_eff - 10) then
      raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_DATE_INVALID',
        hint = 'Referenčný kurz ECB/NBS sa berie v deň predchádzajúci vzniku daňovej povinnosti (§ 26 ods. 1).';
    end if;
    if new.fx_rate_source = 'CUSTOMS' and new.fx_rate_date <> v_eff then
      raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_DATE_INVALID',
        hint = 'Colný kurz sa berie v deň vzniku daňovej povinnosti (§ 26 ods. 1).';
    end if;
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
     where it.invoice_id = new.id and it.vat_category_code = 'S' and not (it.vat_rate = any (v_rates)) limit 1;
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
    if new.currency <> 'EUR' and v_orig.fx_rate is distinct from new.fx_rate then
      raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_FX_RATE_MISMATCH',
        hint = 'Pri oprave základu dane sa použije kurz pôvodnej faktúry (§ 26 ods. 1).';
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
drop trigger if exists esblu_invoice_finalize_compliance on public.invoices;
create trigger esblu_invoice_finalize_compliance before update of document_status on public.invoices
  for each row execute function public.esblu_invoice_finalize_compliance();

-- correction_created (audit) po finalizácii opravného dokladu
create or replace function public.esblu_invoice_correction_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.document_status = 'draft' and new.document_status = 'finalized' and new.kind in ('credit_note', 'debit_note') then
    insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
    values (new.corrects_invoice_id, 'correction_created', auth.uid(), 'user',
            jsonb_build_object('kind', new.kind, 'invoice_number', new.invoice_number, 'total_amount', new.total_amount, 'currency', new.currency));
  end if;
  return new;
end;
$function$;
drop trigger if exists esblu_invoice_correction_event on public.invoices;
create trigger esblu_invoice_correction_event after update of document_status on public.invoices
  for each row execute function public.esblu_invoice_correction_event();

-- Finalizácia: séria PF pre proformu (zvyšok funkcie nezmenený oproti 20260923190000).
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
revoke execute on function public.esblu_finalize_invoice(uuid) from public;
revoke execute on function public.esblu_finalize_invoice(uuid) from anon;
grant execute on function public.esblu_finalize_invoice(uuid) to authenticated;
