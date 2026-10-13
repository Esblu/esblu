-- =============================================================================
-- E-Faktúra — koncept PRIJATEJ e-faktúry je pri vzniku finančne zhodný s
-- nemenným XML (L3 nález 2026-10-03, staging: koncept FA20260004 mal hlavičku
-- 0 / 0 / 0, bez spôsobu úhrady a bez rozpisu DPH, hoci XML ich nesie).
-- NEAPLIKOVANÉ. Do produkcie iba cez MCP apply_migration po výslovnom
-- schválení (supabase/MIGRATIONS.md §9). Nikdy `supabase db push`.
-- Závisí od 20261002130000_einvoice_inbound_flow (a 20260916095000).
--
-- Príčina: esblu_received_invoice_draft_core (spoločné jadro s AI Inboxom)
-- zakladá koncept iba s položkami — hlavičkové súčty a rozpis DPH vznikali
-- výhradne pri finalizácii, BT-81 (spôsob úhrady) sa nezapisoval vôbec, a
-- mapovanie XML (lib/einvoice/inbound/mapping.ts) súčty ani BT-81 neposielalo.
--
-- Čo sa mení (AI Inbox a vydané faktúry BEZ zmeny):
--   1) einvoice_inbound.xml_totals — nemenný záznam súčtov z XML (BG-22, BT-81,
--      BG-23), zapísaný raz pri vzniku konceptu.
--   2) esblu_einvoice_apply_xml_totals — interná funkcia: overí aritmetiku XML
--      a zhodu s položkami konceptu (fail-closed), zapíše hlavičku
--      (subtotal/vat/rounding/total), payment_means_code, rozpis DPH presne
--      podľa XML a rozdelí DPH skupiny na riadky (najväčšie zvyšky — rovnako
--      ako finalizácia). Nič neprepočítava „inak" než XML.
--   3) esblu_einvoice_inbound_create_draft — po vzniku konceptu volá (2).
--      Bez `totals` v payloade (starý serverový kód) → ESBLU_EINVOICE_TOTALS_REQUIRED
--      (prechodná chyba, worker to zopakuje — žiadny koncept s nulovými súčtami).
--   4) esblu_block_invoice_snapshot_mutation — invoice_tax_breakdowns /
--      invoice_parties sú nemenné od FINALIZÁCIE (predtým od vzniku, lebo
--      vznikali iba pri nej). Koncept s rozpisom z XML musí ísť finalizovať
--      (finalizácia rozpis zmaže a znovu vypočíta) aj zmazať. Klient na tieto
--      tabuľky nemá žiadne DML (zapisujú iba SECURITY DEFINER funkcie).
--   5) Trigger na finalizáciu prijatej e-faktúry: prepočet finalizácie sa MUSÍ
--      zhodovať s XML (hlavička aj rozpis DPH), inak ESBLU_EINVOICE_FINALIZE_TOTALS_MISMATCH
--      — ručná zmena položiek konceptu nesmie potichu zmeniť význam doručeného dokladu.
--      Staršie koncepty bez xml_totals (pred touto migráciou) sa neblokujú.
--
-- ROLLBACK: drop trigger esblu_einvoice_received_finalize_guard on public.invoices;
--   drop trigger esblu_einvoice_inbound_xml_totals_guard on public.einvoice_inbound;
--   drop function esblu_einvoice_received_finalize_guard(), esblu_einvoice_inbound_xml_totals_guard(),
--     esblu_einvoice_apply_xml_totals(uuid, jsonb, text);
--   esblu_einvoice_inbound_create_draft a esblu_block_invoice_snapshot_mutation
--   vrátiť z 20261002130000 / 20260916095000. Stĺpec xml_totals môže ostať.
-- =============================================================================

begin;

-- 1) Nemenný záznam súčtov z XML ---------------------------------------------------------
alter table public.einvoice_inbound
  add column if not exists xml_totals jsonb
    check (xml_totals is null or jsonb_typeof(xml_totals) = 'object');

comment on column public.einvoice_inbound.xml_totals is
  'Súčty z doručeného XML (BT-106/109/110/112/114/113/115, BT-81, BG-23) zapísané raz pri vzniku konceptu. Referencia pre kontrolu finalizácie; nemenné.';

create or replace function public.esblu_einvoice_inbound_xml_totals_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.xml_totals is not null and new.xml_totals is distinct from old.xml_totals then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_xml_totals_guard() from public, anon, authenticated;

drop trigger if exists esblu_einvoice_inbound_xml_totals_guard on public.einvoice_inbound;
create trigger esblu_einvoice_inbound_xml_totals_guard
  before update of xml_totals on public.einvoice_inbound
  for each row execute function public.esblu_einvoice_inbound_xml_totals_guard();

-- 2) Snapshot tabuľky: nemenné od finalizácie -------------------------------------------
create or replace function public.esblu_block_invoice_snapshot_mutation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- Nemenné, keď patria FINALIZOVANEJ faktúre. Koncept (napr. prijatá e-faktúra
  -- s rozpisom DPH z XML) ich smie mať a finalizácia ich prepíše; pri kaskádovom
  -- zmazaní konceptu už rodič neexistuje. Klient nemá na tieto tabuľky DML.
  if exists (
    select 1 from public.invoices i
    where i.id = old.invoice_id and i.document_status = 'finalized'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_SNAPSHOT_IMMUTABLE',
      hint = 'invoice_parties/invoice_tax_breakdowns finalizovanej faktúry sa nikdy needitujú ani nemažú.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
revoke all on function public.esblu_block_invoice_snapshot_mutation() from public, anon, authenticated;

-- 3) Súčty z XML na koncept --------------------------------------------------------------
create or replace function public.esblu_einvoice_apply_xml_totals(p_invoice_id uuid, p_totals jsonb, p_payment_means_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_inv record;
  v_line_ext numeric; v_tax_excl numeric; v_vat numeric; v_tax_incl numeric;
  v_rounding numeric; v_prepaid numeric; v_payable numeric;
  v_b jsonb;
  v_cat text; v_rate numeric; v_taxable numeric; v_bvat numeric; v_code text;
  v_group_net numeric;
  v_sum_taxable numeric := 0; v_sum_vat numeric := 0;
  v_breakdown jsonb := '[]'::jsonb;
  v_keys text[] := array[]::text[];
  v_key text;
  v_line_groups integer;
  v_pm text := nullif(btrim(coalesce(p_payment_means_code, '')), '');
  v_bad constant text := 'ESBLU_EINVOICE_TOTALS_INCONSISTENT';
begin
  select i.id, i.direction, i.document_status, i.source into v_inv
  from public.invoices i where i.id = p_invoice_id for update;
  if v_inv.id is null or v_inv.direction <> 'received' or v_inv.document_status <> 'draft' or v_inv.source <> 'efaktura_peppol' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_TARGET_INVALID';
  end if;
  if p_totals is null or jsonb_typeof(p_totals) <> 'object' or jsonb_typeof(p_totals -> 'breakdown') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_REQUIRED';
  end if;

  begin
    v_line_ext := (p_totals ->> 'line_extension')::numeric;
    v_tax_excl := (p_totals ->> 'tax_exclusive')::numeric;
    v_vat := (p_totals ->> 'vat_total')::numeric;
    v_tax_incl := (p_totals ->> 'tax_inclusive')::numeric;
    v_rounding := (p_totals ->> 'rounding')::numeric;
    v_prepaid := (p_totals ->> 'prepaid')::numeric;
    v_payable := (p_totals ->> 'payable')::numeric;
  exception when others then
    raise exception using errcode = 'P0001', message = v_bad, hint = 'NUMBER';
  end;
  if v_line_ext is null or v_tax_excl is null or v_vat is null or v_tax_incl is null
     or v_rounding is null or v_prepaid is null or v_payable is null
     or v_line_ext <> round(v_line_ext, 2) or v_tax_excl <> round(v_tax_excl, 2) or v_vat <> round(v_vat, 2)
     or v_tax_incl <> round(v_tax_incl, 2) or v_rounding <> round(v_rounding, 2) or v_payable <> round(v_payable, 2) then
    raise exception using errcode = 'P0001', message = v_bad, hint = 'AMOUNTS';
  end if;
  -- Dátový model Esblu nemá zálohy ani zľavy/prirážky dokladu.
  if v_prepaid <> 0 or v_tax_excl <> v_line_ext then
    raise exception using errcode = 'P0001', message = v_bad, hint = 'UNSUPPORTED_AMOUNTS';
  end if;
  if v_tax_excl + v_vat <> v_tax_incl or v_tax_incl - v_prepaid + v_rounding <> v_payable then
    raise exception using errcode = 'P0001', message = v_bad, hint = 'ARITHMETIC';
  end if;
  if (select coalesce(sum(it.line_net_amount), 0) from public.invoice_items it where it.invoice_id = p_invoice_id) <> v_line_ext then
    raise exception using errcode = 'P0001', message = v_bad, hint = 'LINE_SUM';
  end if;
  if jsonb_array_length(p_totals -> 'breakdown') = 0 then
    raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_MISSING';
  end if;

  for v_b in select * from jsonb_array_elements(p_totals -> 'breakdown')
  loop
    v_cat := v_b ->> 'category';
    begin
      v_rate := (v_b ->> 'rate')::numeric;
      v_taxable := (v_b ->> 'taxable')::numeric;
      v_bvat := (v_b ->> 'vat')::numeric;
    exception when others then
      raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_NUMBER';
    end;
    if v_cat is null or not (v_cat = any (array['S', 'Z', 'E', 'AE', 'K', 'G', 'O']))
       or v_rate is null or v_taxable is null or v_bvat is null
       or v_taxable <> round(v_taxable, 2) or v_bvat <> round(v_bvat, 2) then
      raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_FIELDS';
    end if;
    if v_cat = 'S' then
      if v_rate <= 0 or v_bvat <> round(v_taxable * v_rate / 100, 2) then
        raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_VAT';
      end if;
    elsif v_rate <> 0 or v_bvat <> 0 then
      raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_VAT';
    end if;
    v_key := v_cat || '|' || v_rate::numeric(7, 4)::text;
    if v_key = any (v_keys) then
      raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_DUPLICATE';
    end if;
    v_keys := v_keys || v_key;
    select coalesce(sum(it.line_net_amount), 0) into v_group_net
    from public.invoice_items it
    where it.invoice_id = p_invoice_id and it.vat_category_code = v_cat
      and (case when it.vat_category_code = 'S' then it.vat_rate else 0 end) = v_rate;
    if v_group_net <> v_taxable then
      raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_LINES';
    end if;
    v_code := nullif(upper(btrim(coalesce(v_b ->> 'exemption_reason_code', ''))), '');
    if v_code is not null and v_code !~ '^[A-Z0-9-]{1,30}$' then
      v_code := null;
    end if;
    v_sum_taxable := v_sum_taxable + v_taxable;
    v_sum_vat := v_sum_vat + v_bvat;
    v_breakdown := v_breakdown || jsonb_build_object('category', v_cat, 'rate', v_rate, 'taxable', v_taxable, 'vat', v_bvat, 'exemption_reason_code', v_code);
  end loop;

  select count(*) into v_line_groups from (
    select distinct it.vat_category_code, case when it.vat_category_code = 'S' then it.vat_rate else 0 end
    from public.invoice_items it where it.invoice_id = p_invoice_id
  ) g;
  if v_line_groups <> cardinality(v_keys) or v_sum_taxable <> v_tax_excl or v_sum_vat <> v_vat then
    raise exception using errcode = 'P0001', message = v_bad, hint = 'BREAKDOWN_TOTALS';
  end if;
  if v_pm is not null and v_pm !~ '^[0-9]{1,3}$' then
    v_pm := null;
  end if;

  -- DPH skupiny (z XML) na riadky — najväčšie zvyšky, pri zhode rozhoduje position
  -- (rovnaké pravidlo ako esblu_finalize_invoice). Súčet riadkov = rozpis = hlavička.
  with grp as (
    select b ->> 'category' as cat, (b ->> 'rate')::numeric as rate,
           round(((b ->> 'taxable')::numeric) * 100) as taxable_cents,
           round(((b ->> 'vat')::numeric) * 100) as vat_cents
    from jsonb_array_elements(v_breakdown) b
  ),
  share as (
    select it.id, it.position, g.cat, g.rate, g.vat_cents,
           case when g.taxable_cents = 0 then 0
                else round(it.line_net_amount * 100) * g.vat_cents / g.taxable_cents end as raw_cents
    from public.invoice_items it
    join grp g on g.cat = it.vat_category_code
              and g.rate = (case when it.vat_category_code = 'S' then it.vat_rate else 0 end)
    where it.invoice_id = p_invoice_id
  ),
  ranked as (
    select s.*, floor(s.raw_cents) as floor_cents,
           row_number() over (partition by s.cat, s.rate order by (s.raw_cents - floor(s.raw_cents)) desc, s.position asc) as rn,
           sum(floor(s.raw_cents)) over (partition by s.cat, s.rate) as floor_sum
    from share s
  ),
  allocated as (
    select r.id, (r.floor_cents + case when r.rn <= r.vat_cents - r.floor_sum then 1 else 0 end) / 100 as vat_amount
    from ranked r
  )
  update public.invoice_items it
  set line_vat_amount = a.vat_amount,
      line_gross_amount = it.line_net_amount + a.vat_amount,
      updated_at = now()
  from allocated a
  where it.id = a.id;

  insert into public.invoice_tax_breakdowns (invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount, vat_exemption_reason_code)
  select p_invoice_id, b ->> 'category', (b ->> 'rate')::numeric, (b ->> 'taxable')::numeric, (b ->> 'vat')::numeric, b ->> 'exemption_reason_code'
  from jsonb_array_elements(v_breakdown) b;

  update public.invoices i
  set subtotal_amount = v_tax_excl,
      vat_total_amount = v_vat,
      rounding_amount = v_rounding,
      total_amount = v_tax_incl + v_rounding,
      payment_means_code = v_pm,
      updated_at = now()
  where i.id = p_invoice_id;

  return jsonb_build_object(
    'line_extension', v_line_ext, 'tax_exclusive', v_tax_excl, 'vat_total', v_vat,
    'tax_inclusive', v_tax_incl, 'rounding', v_rounding, 'prepaid', v_prepaid, 'payable', v_payable,
    'payment_means_code', v_pm, 'breakdown', v_breakdown
  );
end;
$function$;
revoke all on function public.esblu_einvoice_apply_xml_totals(uuid, jsonb, text) from public, anon, authenticated;

-- 4) Koncept z inbound: po vzniku zapísať súčty z XML ------------------------------------
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
  v_totals jsonb;
begin
  select * into v_in from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if v_in.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_NOT_FOUND';
  end if;
  if v_in.processing_status <> 'parsed' or v_in.xml_sha256 is null or v_in.xml_storage_path is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_STATE';
  end if;
  -- Bez súčtov z XML (starý serverový kód) žiadny koncept — prechodná chyba, worker zopakuje.
  if p_draft is null or jsonb_typeof(p_draft -> 'totals') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_REQUIRED';
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
  -- Nový koncept: hlavička, BT-81 a rozpis DPH presne podľa XML (fail-closed v tej istej transakcii).
  if v_status = 'draft_created' then
    v_totals := public.esblu_einvoice_apply_xml_totals((v_result ->> 'invoice_id')::uuid, p_draft -> 'totals', p_draft ->> 'payment_means_code');
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
    'matched_on', v_result ->> 'matched_on'
  );
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) to service_role;

-- 5) Finalizácia prijatej e-faktúry sa musí zhodovať s XML ---------------------------------
create or replace function public.esblu_einvoice_received_finalize_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_x jsonb;
begin
  select i.xml_totals into v_x
  from public.einvoice_inbound i
  where i.invoice_id = new.id and i.company_id = new.company_id and i.xml_totals is not null
  order by i.received_at
  limit 1;
  if v_x is null then
    return new; -- koncept bez záznamu súčtov z XML (vznikol pred 20261003100000)
  end if;

  if new.subtotal_amount <> (v_x ->> 'tax_exclusive')::numeric
     or new.vat_total_amount <> (v_x ->> 'vat_total')::numeric
     or new.rounding_amount <> (v_x ->> 'rounding')::numeric
     or new.total_amount <> (v_x ->> 'payable')::numeric
     or exists (
       (select b ->> 'category', (b ->> 'rate')::numeric, (b ->> 'taxable')::numeric, (b ->> 'vat')::numeric
          from jsonb_array_elements(v_x -> 'breakdown') b)
       except
       (select t.vat_category_code, t.vat_rate::numeric, t.taxable_amount::numeric, t.vat_amount::numeric
          from public.invoice_tax_breakdowns t where t.invoice_id = new.id)
     )
     or exists (
       (select t.vat_category_code, t.vat_rate::numeric, t.taxable_amount::numeric, t.vat_amount::numeric
          from public.invoice_tax_breakdowns t where t.invoice_id = new.id)
       except
       (select b ->> 'category', (b ->> 'rate')::numeric, (b ->> 'taxable')::numeric, (b ->> 'vat')::numeric
          from jsonb_array_elements(v_x -> 'breakdown') b)
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_EINVOICE_FINALIZE_TOTALS_MISMATCH',
      hint = 'Súčty prijatej e-faktúry sa musia zhodovať s doručeným XML — položky konceptu boli zmenené.';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_received_finalize_guard() from public, anon, authenticated;

drop trigger if exists esblu_einvoice_received_finalize_guard on public.invoices;
create trigger esblu_einvoice_received_finalize_guard
  before update of document_status on public.invoices
  for each row
  when (old.document_status = 'draft' and new.document_status = 'finalized'
        and new.direction = 'received' and new.source = 'efaktura_peppol')
  execute function public.esblu_einvoice_received_finalize_guard();

commit;
