-- 20261008100003 — § 26 ods. 1 zákona o DPH: presný dátum kurzu namiesto 10-dňového okna.
--
-- Audit (október 2026): 20261008100000 prijímal pre ECB/NBS ĽUBOVOĽNÝ dátum kurzu v okne
-- <deň vzniku − 10; deň vzniku). Tým akceptoval aj svojvoľne zvolený starší kurz (napr. kurz spred
-- týždňa v bežný pracovný deň) a aj dátum, ku ktorému sa kurz vôbec nevyhlasuje (nedeľa).
-- Zákon: „referenčným výmenným kurzom určeným a vyhláseným ECB alebo NBS v deň predchádzajúci dňu
-- vzniku daňovej povinnosti“. Oprava: prípustný je PRÁVE JEDEN dátum —
--   esblu_fx_reference_rate_date(deň vzniku, zdroj) = posledný deň vyhlásenia kurzu ≤ (deň vzniku − 1).
-- Deň vyhlásenia = pracovný deň TARGET (ECB nevyhlasuje referenčné kurzy cez víkend a v dni
-- zatvorenia TARGET: 1. 1., Veľký piatok, Veľkonočný pondelok, 1. 5., 25. 12., 26. 12.), mínus
-- mimoriadne výnimky v tabuľke fx_rate_publication_exceptions (spravuje iba service_role).
-- Posun na posledný vyhlásený kurz, keď sa v predchádzajúci deň kurz nevyhlásil, je technický
-- výklad (LEGAL REVIEW) — zákon tento prípad výslovne nerieši.
-- Ďalej: oprava (§ 25) musí mať kurz, dátum aj zdroj zhodné s pôvodnou faktúrou; colný kurz sa
-- v rámci kalendárneho roka nemieša s ECB/NBS; prijaté doklady pravidlo dňa nevynucujú.

create or replace function public.esblu_easter_sunday(p_year integer)
returns date
language plpgsql
immutable
set search_path to ''
as $function$
declare
  a int := p_year % 19; b int := p_year / 100; c int := p_year % 100;
  d int; e int; f int; g int; h int; i int; k int; l int; m int; mo int; dy int;
begin
  d := b / 4; e := b % 4; f := (b + 8) / 25; g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30; i := c / 4; k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7; m := (a + 11 * h + 22 * l) / 451;
  mo := (h + l - 7 * m + 114) / 31; dy := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(p_year, mo, dy);
end;
$function$;

create table if not exists public.fx_rate_publication_exceptions (
  rate_source text not null check (rate_source in ('ECB', 'NBS')),
  day date not null,
  note text not null check (char_length(note) between 3 and 300),
  created_at timestamptz not null default now(),
  primary key (rate_source, day)
);
alter table public.fx_rate_publication_exceptions enable row level security;
revoke all on table public.fx_rate_publication_exceptions from public, anon, authenticated;
grant select, insert, update, delete on table public.fx_rate_publication_exceptions to service_role;
comment on table public.fx_rate_publication_exceptions is
  'Mimoriadne dni, keď ECB/NBS kurz nevyhlásila mimo kalendára TARGET. Iba service_role.';

create or replace function public.esblu_fx_is_publication_day(p_day date, p_source text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select extract(isodow from p_day) < 6
     and not (extract(month from p_day) = 1 and extract(day from p_day) = 1)
     and not (extract(month from p_day) = 5 and extract(day from p_day) = 1)
     and not (extract(month from p_day) = 12 and extract(day from p_day) in (25, 26))
     and p_day <> public.esblu_easter_sunday(extract(year from p_day)::int) - 2
     and p_day <> public.esblu_easter_sunday(extract(year from p_day)::int) + 1
     and not exists (select 1 from public.fx_rate_publication_exceptions x where x.rate_source = p_source and x.day = p_day);
$function$;

create or replace function public.esblu_fx_reference_rate_date(p_tax_point date, p_source text)
returns date
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  d date := p_tax_point - 1;
begin
  if p_tax_point is null or p_source not in ('ECB', 'NBS') then
    return null;
  end if;
  for n in 1..30 loop
    exit when public.esblu_fx_is_publication_day(d, p_source);
    d := d - 1;
  end loop;
  return d;
end;
$function$;

revoke execute on function public.esblu_easter_sunday(integer) from public, anon;
revoke execute on function public.esblu_fx_is_publication_day(date, text) from public, anon;
revoke execute on function public.esblu_fx_reference_rate_date(date, text) from public, anon;
grant execute on function public.esblu_easter_sunday(integer) to authenticated, service_role;
grant execute on function public.esblu_fx_is_publication_day(date, text) to authenticated, service_role;
grant execute on function public.esblu_fx_reference_rate_date(date, text) to authenticated, service_role;

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
  v_expected date;
begin
  if not (old.document_status = 'draft' and new.document_status = 'finalized') then
    return new;
  end if;

  -- Cudzia mena (§ 26 ods. 1 zákona o DPH).
  if new.currency <> 'EUR' then
    if new.fx_rate is null or new.fx_rate_date is null or new.fx_rate_source is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_REQUIRED',
        hint = 'Pri cudzej mene uveďte kurz (jednotky meny za 1 EUR), jeho dátum a zdroj (ECB / NBS / colný kurz).';
    end if;
    if new.kind in ('credit_note', 'debit_note') and new.corrects_invoice_id is not null then
      -- Oprava základu dane podľa § 25: „použije sa kurz, ktorý sa použil pri vzniku daňovej povinnosti“.
      -- Kurz, jeho dátum aj zdroj musia byť zhodné s pôvodnou faktúrou; pravidlo dňa sa znovu nepočíta.
      select * into v_orig from public.invoices o where o.id = new.corrects_invoice_id;
      if v_orig.fx_rate is distinct from new.fx_rate or v_orig.fx_rate_date is distinct from new.fx_rate_date
         or v_orig.fx_rate_source is distinct from new.fx_rate_source then
        raise exception using errcode = 'P0001', message = 'ESBLU_CORRECTION_FX_RATE_MISMATCH',
          hint = 'Pri oprave základu dane sa použije kurz pôvodnej faktúry (§ 26 ods. 1): rovnaký kurz, dátum aj zdroj.';
      end if;
    elsif new.direction = 'issued' then
      v_eff := coalesce(new.tax_point_date, new.delivery_date, new.issue_date);
      if new.fx_rate_source in ('ECB', 'NBS') then
        -- Presne jeden prípustný dátum: posledný deň vyhlásenia kurzu pred dňom vzniku daňovej povinnosti.
        v_expected := public.esblu_fx_reference_rate_date(v_eff, new.fx_rate_source);
        if new.fx_rate_date <> v_expected then
          raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_DATE_INVALID',
            detail = 'expected_fx_rate_date=' || v_expected::text,
            hint = 'Referenčný kurz ECB/NBS vyhlásený v deň predchádzajúci dňu vzniku daňovej povinnosti (§ 26 ods. 1); '
                   || 'ak sa v ten deň kurz nevyhlasoval, posledný vyhlásený kurz: ' || v_expected::text || '.';
        end if;
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
