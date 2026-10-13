-- 20261008100004 — § 26 ods. 1 zákona o DPH: dátum aj hodnota kurzu z OFICIÁLNYCH dát ECB,
-- nie z ručne udržiavaného kalendára.
--
-- Audit (október 2026): 20261008100003 určoval „deň vyhlásenia“ ručne zakódovaným kalendárom TARGET
-- (víkendy, 1. 1., Veľký piatok, Veľkonočný pondelok, 1. 5., 25. 12., 26. 12.) + tabuľkou výnimiek.
-- Kalendár nebol slovenský (slovenské sviatky správne neovplyvňoval), ale bol to stále predpoklad,
-- nie oficiálny údaj: nevedel, či ECB v daný deň skutočne vyhlásila kurz konkrétnej meny
-- (pozastavené meny, mimoriadne dni), a hodnotu kurzu vôbec neoveroval.
--
-- Nový model:
--   * fx_rate_import_batches — každý import oficiálneho súboru ECB (URL, SHA-256 dokumentu, meny,
--     interval ÚPLNÉHO pokrytia coverage_from..coverage_to). Append-only.
--   * fx_reference_rates — oficiálne referenčné kurzy (provider ECB, mena, dátum, kurz). Append-only;
--     rovnaký (mena, dátum) s iným kurzom = ESBLU_FX_RATE_CONFLICT; nový kurz do už pokrytého
--     intervalu = ESBLU_FX_COVERAGE_CONFLICT (nikdy sa ticho nemení minulosť).
--   * esblu_fx_official_rate(mena, deň vzniku) — posledný kurz meny s dátumom ≤ deň vzniku − 1,
--     iba ak je celý interval ⟨ten dátum; deň vzniku − 1⟩ pokrytý importom. Inak 'data_missing'.
--     Ak v intervale ECB vyhlásila iné meny, ale túto nie → 'not_published' (pozastavená mena).
--   * Finalizácia vydanej faktúry v cudzej mene so zdrojom ECB/NBS vyžaduje 'ok', presný dátum
--     aj presnú hodnotu kurzu; uloží fx_reference_rate_id a fx_tax_point_date (nemenné).
--     NBS na svojom webe zverejňuje referenčné kurzy ECB; vlastné kurzy NBS pre iné meny sú
--     mesačné a „len informatívne“ → pre NBS sa overuje voči tým istým dátam ECB.
--   * Oprava (§ 25) preberá kurz, dátum, zdroj, rozhodný deň aj referenciu z pôvodnej faktúry.
--   * Žiadne sieťové volanie pri zobrazení faktúry — dáta sú v DB; import robí server (cron/skript).
-- Odstraňuje sa kalendár z 20261008100003 (esblu_fx_is_publication_day, esblu_easter_sunday,
-- fx_rate_publication_exceptions).

-- 1) Tabuľky -----------------------------------------------------------------------------------
create table if not exists public.fx_rate_import_batches (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'ECB'),
  source_url text not null check (source_url ~ '^https://www\.ecb\.europa\.eu/'),
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  currencies text[] not null check (cardinality(currencies) > 0),
  coverage_from date not null,
  coverage_to date not null,
  published_days integer not null check (published_days > 0),
  imported_at timestamptz not null default now(),
  check (coverage_from <= coverage_to),
  unique (provider, document_sha256)
);
create table if not exists public.fx_reference_rates (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'ECB'),
  currency text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'EUR'),
  rate_date date not null,
  rate numeric(18,6) not null check (rate > 0),
  batch_id uuid not null references public.fx_rate_import_batches(id),
  created_at timestamptz not null default now(),
  unique (provider, currency, rate_date)
);
create index if not exists fx_reference_rates_lookup_idx on public.fx_reference_rates (provider, currency, rate_date desc);
create index if not exists fx_reference_rates_date_idx on public.fx_reference_rates (provider, rate_date);

alter table public.fx_rate_import_batches enable row level security;
alter table public.fx_reference_rates enable row level security;
revoke all on table public.fx_rate_import_batches from public, anon, authenticated;
revoke all on table public.fx_reference_rates from public, anon, authenticated;
grant select on table public.fx_rate_import_batches to authenticated;
grant select on table public.fx_reference_rates to authenticated;
grant select, insert on table public.fx_rate_import_batches to service_role;
grant select, insert on table public.fx_reference_rates to service_role;
drop policy if exists fx_rate_import_batches_read on public.fx_rate_import_batches;
create policy fx_rate_import_batches_read on public.fx_rate_import_batches for select to authenticated using (true);
drop policy if exists fx_reference_rates_read on public.fx_reference_rates;
create policy fx_reference_rates_read on public.fx_reference_rates for select to authenticated using (true);
comment on table public.fx_reference_rates is 'Oficiálne referenčné kurzy ECB (jednotky meny za 1 EUR). Append-only. Zdroj: fx_rate_import_batches.';

create or replace function public.esblu_fx_append_only()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  raise exception using errcode = 'P0001', message = 'ESBLU_FX_DATA_APPEND_ONLY';
end;
$function$;
revoke execute on function public.esblu_fx_append_only() from public, anon, authenticated;
drop trigger if exists esblu_fx_reference_rates_append_only on public.fx_reference_rates;
create trigger esblu_fx_reference_rates_append_only before update or delete on public.fx_reference_rates
  for each row execute function public.esblu_fx_append_only();
drop trigger if exists esblu_fx_import_batches_append_only on public.fx_rate_import_batches;
create trigger esblu_fx_import_batches_append_only before update or delete on public.fx_rate_import_batches
  for each row execute function public.esblu_fx_append_only();

-- 2) Import (iba service_role) ------------------------------------------------------------------
create or replace function public.esblu_fx_import_ecb_batch(
  p_source_url text, p_document_sha256 text, p_coverage_from date, p_coverage_to date, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_batch uuid;
  v_min date;
  v_max date;
  v_days integer;
  v_currencies text[];
  v_inserted integer;
  v_conflict record;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_FX_IMPORT_EMPTY';
  end if;
  select b.id into v_batch from public.fx_rate_import_batches b where b.provider = 'ECB' and b.document_sha256 = p_document_sha256;
  if v_batch is not null then
    return jsonb_build_object('batch_id', v_batch, 'duplicate', true, 'inserted', 0);
  end if;

  create temporary table if not exists esblu_fx_import_tmp (currency text, rate_date date, rate numeric(18,6)) on commit drop;
  truncate pg_temp.esblu_fx_import_tmp;
  insert into pg_temp.esblu_fx_import_tmp
  select upper(r ->> 'currency'), (r ->> 'rate_date')::date, (r ->> 'rate')::numeric
  from jsonb_array_elements(p_rows) r;

  if exists (select 1 from pg_temp.esblu_fx_import_tmp t where t.currency !~ '^[A-Z]{3}$' or t.currency = 'EUR' or t.rate is null or t.rate <= 0 or t.rate_date is null) then
    raise exception using errcode = 'P0001', message = 'ESBLU_FX_IMPORT_INVALID_ROW';
  end if;
  if exists (select 1 from pg_temp.esblu_fx_import_tmp t group by t.currency, t.rate_date having count(*) > 1) then
    raise exception using errcode = 'P0001', message = 'ESBLU_FX_IMPORT_DUPLICATE_ROW';
  end if;
  select min(t.rate_date), max(t.rate_date), count(distinct t.rate_date), array_agg(distinct t.currency order by t.currency)
    into v_min, v_max, v_days, v_currencies from pg_temp.esblu_fx_import_tmp t;
  -- Pokrytie musí začínať prvým vyhláseným dňom v súbore a končiť najskôr posledným.
  -- Rezerva max. 6 dní za posledným dňom (najdlhšie bežné obdobie bez kurzu) — technická poistka, nie právne pravidlo.
  if p_coverage_from is distinct from v_min or p_coverage_to < v_max or p_coverage_to > v_max + 6 then
    raise exception using errcode = 'P0001', message = 'ESBLU_FX_IMPORT_COVERAGE_INVALID';
  end if;

  -- Rozpor s už uloženým kurzom → nikdy neprepísať.
  select t.currency, t.rate_date into v_conflict
  from pg_temp.esblu_fx_import_tmp t join public.fx_reference_rates r
    on r.provider = 'ECB' and r.currency = t.currency and r.rate_date = t.rate_date and r.rate <> t.rate
  limit 1;
  if found then
    raise exception using errcode = 'P0001', message = 'ESBLU_FX_RATE_CONFLICT',
      detail = v_conflict.currency || ' ' || v_conflict.rate_date::text;
  end if;
  -- Nový kurz v intervale, ktorý už predchádzajúci import vyhlásil za úplný → rozpor v zdrojových dátach.
  select t.currency, t.rate_date into v_conflict
  from pg_temp.esblu_fx_import_tmp t
  where not exists (select 1 from public.fx_reference_rates r where r.provider = 'ECB' and r.currency = t.currency and r.rate_date = t.rate_date)
    and exists (select 1 from public.fx_rate_import_batches b
                where b.provider = 'ECB' and t.currency = any (b.currencies) and t.rate_date between b.coverage_from and b.coverage_to)
  limit 1;
  if found then
    raise exception using errcode = 'P0001', message = 'ESBLU_FX_COVERAGE_CONFLICT',
      detail = v_conflict.currency || ' ' || v_conflict.rate_date::text;
  end if;

  insert into public.fx_rate_import_batches (provider, source_url, document_sha256, currencies, coverage_from, coverage_to, published_days)
  values ('ECB', p_source_url, p_document_sha256, v_currencies, p_coverage_from, p_coverage_to, v_days)
  returning id into v_batch;
  insert into public.fx_reference_rates (provider, currency, rate_date, rate, batch_id)
  select 'ECB', t.currency, t.rate_date, t.rate, v_batch from pg_temp.esblu_fx_import_tmp t
  on conflict (provider, currency, rate_date) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('batch_id', v_batch, 'duplicate', false, 'inserted', v_inserted, 'currencies', cardinality(v_currencies),
                            'coverage_from', p_coverage_from, 'coverage_to', p_coverage_to);
end;
$function$;
revoke execute on function public.esblu_fx_import_ecb_batch(text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_fx_import_ecb_batch(text, text, date, date, jsonb) to service_role;

-- 3) Vyhľadanie oficiálneho kurzu ---------------------------------------------------------------
create or replace function public.esblu_fx_official_rate(p_currency text, p_tax_point date)
returns table (status text, rate_date date, rate numeric, reference_id uuid)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_d0 date := p_tax_point - 1;
  v_cur text := upper(btrim(p_currency));
  v_row public.fx_reference_rates%rowtype;
begin
  if p_tax_point is null or v_cur is null or v_cur !~ '^[A-Z]{3}$' or v_cur = 'EUR' then
    return query select 'invalid'::text, null::date, null::numeric, null::uuid; return;
  end if;
  select * into v_row from public.fx_reference_rates r
   where r.provider = 'ECB' and r.currency = v_cur and r.rate_date <= v_d0
   order by r.rate_date desc limit 1;
  -- Každý deň ⟨posledný kurz meny; deň vzniku − 1⟩ musí byť v intervale úplného pokrytia importom tejto meny.
  if v_row.id is null or exists (
       select 1 from generate_series(v_row.rate_date, v_d0, interval '1 day') g(d)
       where not exists (select 1 from public.fx_rate_import_batches b
                         where b.provider = 'ECB' and v_cur = any (b.currencies)
                           and g.d::date between b.coverage_from and b.coverage_to)) then
    return query select 'data_missing'::text, null::date, null::numeric, null::uuid; return;
  end if;
  -- ECB v intervale vyhlásila iné meny, ale túto nie → mena nebola vyhlásená (napr. pozastavená).
  if exists (select 1 from public.fx_reference_rates r
             where r.provider = 'ECB' and r.rate_date > v_row.rate_date and r.rate_date <= v_d0) then
    return query select 'not_published'::text, null::date, null::numeric, null::uuid; return;
  end if;
  return query select 'ok'::text, v_row.rate_date, v_row.rate, v_row.id;
end;
$function$;
revoke execute on function public.esblu_fx_official_rate(text, date) from public, anon;
grant execute on function public.esblu_fx_official_rate(text, date) to authenticated, service_role;

-- 4) Nemenné väzby na faktúre ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists fx_tax_point_date date,
  add column if not exists fx_reference_rate_id uuid references public.fx_reference_rates(id);
comment on column public.invoices.fx_tax_point_date is 'Rozhodný deň vzniku daňovej povinnosti pre kurz (§ 26 ods. 1); nastaví finalizácia, potom nemenný.';
comment on column public.invoices.fx_reference_rate_id is 'Oficiálny kurz ECB použitý pri finalizácii (ECB/NBS); pri oprave kurz pôvodnej faktúry.';

-- 5) Odstránenie ručného kalendára z 20261008100003 --------------------------------------------------
drop function if exists public.esblu_fx_reference_rate_date(date, text);
drop function if exists public.esblu_fx_is_publication_day(date, text);
drop function if exists public.esblu_easter_sunday(integer);
drop table if exists public.fx_rate_publication_exceptions;

-- 6) Finalizácia: overenie voči oficiálnym dátam ------------------------------------------------
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
