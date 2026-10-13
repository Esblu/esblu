-- =============================================================================
-- E-Faktúra — (1) DIČ automaticky založeného dodávateľa, (2) kurzor partnerského feedu.
-- Aditívne a vratné. NEAPLIKOVAŤ do produkcie bez schválenia.
--
-- (1) esblu_einvoice_inbound_create_draft: nový voliteľný kľúč supplier.dic (server ho
--     odvodí z XML: IČ DPH „SK“ + 10 číslic, alebo Peppol endpoint 0245:DIČ; v sandboxe
--     aj testovacia schéma 9915). DB prijme iba ^[0-9]{10}$ pri krajine SK/NULL. Dodávateľ
--     sa hľadá aj podľa DIČ (v rámci firmy) PRED založením → žiadny duplicitný partner.
--     Existujúci partner sa NEMENÍ (dáta používateľa).
-- (2) einvoice_event_cursors: jeden kurzor GET /v1/agent/events na (provider, environment).
--     Feed je partnerský (všetky organizácie), preto kurzor nie je per-firma; tenant
--     izolácia ostáva v spracovaní (firma IBA z mapovania org). Kurzor sa posúva iba
--     dopredu (monotónne), iba po spracovaní stránky a s lease proti súbežnému behu.
--     Iba service_role (RLS bez politík).
-- Rollback: supabase/rollback/20261006100000_einvoice_supplier_dic_feed_cursor_rollback.sql
-- =============================================================================

-- (1) ---------------------------------------------------------------------------------
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
  -- 20261006100000: DIČ odvodené serverom z XML (IČ DPH SK+DIČ alebo Peppol 0245:DIČ), iba 10 číslic.
  v_dic text := nullif(btrim(coalesce(v_supplier ->> 'dic', '')), '');
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
  if v_dic is not null and (v_dic !~ '^[0-9]{10}$' or coalesce(v_country, 'SK') <> 'SK') then
    v_dic := null;
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
  if v_partner is null and v_dic is not null then
    select bp.id into v_partner from public.business_partners bp
    where bp.company_id = v_in.company_id and bp.dic = v_dic
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
      company_id, kind, legal_name, ico, dic, ic_dph, vat_identifier,
      address_line1, address_line2, city, postal_code, country_code,
      electronic_address, electronic_address_scheme_id
    ) values (
      v_in.company_id, 'supplier', left(v_name, 300), v_ico, v_dic,
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


-- (2) ---------------------------------------------------------------------------------
create table if not exists public.einvoice_event_cursors (
  provider text not null,
  environment text not null check (environment in ('sandbox', 'live')),
  last_event_id bigint not null default 0 check (last_event_id >= 0),
  locked_until timestamptz,
  lock_token uuid,
  last_run_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  updated_at timestamptz not null default now(),
  primary key (provider, environment)
);
alter table public.einvoice_event_cursors enable row level security;
revoke all on table public.einvoice_event_cursors from public, anon, authenticated;
grant select, insert, update on table public.einvoice_event_cursors to service_role;

-- Claim: lease (default 120 s) proti súbežnému behu; vráti aktuálny kurzor alebo nič (beží iný).
create or replace function public.esblu_einvoice_event_cursor_claim(p_provider text, p_environment text, p_lease_seconds integer default 120)
returns table (last_event_id bigint, lock_token uuid)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_token uuid := gen_random_uuid();
begin
  if p_provider is null or p_environment not in ('sandbox', 'live') or p_lease_seconds not between 10 and 600 then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  insert into public.einvoice_event_cursors as c (provider, environment) values (p_provider, p_environment)
  on conflict (provider, environment) do nothing;
  return query
  update public.einvoice_event_cursors c
     set locked_until = now() + make_interval(secs => p_lease_seconds), lock_token = v_token, last_run_at = now(), updated_at = now()
   where c.provider = p_provider and c.environment = p_environment
     and (c.locked_until is null or c.locked_until < now())
  returning c.last_event_id, c.lock_token;
end;
$function$;

-- Advance: iba s platným lease a iba dopredu (monotónne); p_release uvoľní lease.
create or replace function public.esblu_einvoice_event_cursor_advance(p_provider text, p_environment text, p_lock_token uuid, p_last_event_id bigint, p_release boolean, p_error_code text default null)
returns bigint
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_last bigint;
begin
  if p_lock_token is null or p_last_event_id is null or p_last_event_id < 0 then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  update public.einvoice_event_cursors c
     set last_event_id = greatest(c.last_event_id, p_last_event_id),
         locked_until = case when p_release then null else c.locked_until end,
         lock_token = case when p_release then null else c.lock_token end,
         last_error_code = p_error_code,
         updated_at = now()
   where c.provider = p_provider and c.environment = p_environment and c.lock_token = p_lock_token
     and c.locked_until > now()
  returning c.last_event_id into v_last;
  if v_last is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_CURSOR_LEASE_LOST';
  end if;
  return v_last;
end;
$function$;

revoke all on function public.esblu_einvoice_event_cursor_claim(text, text, integer) from public, anon, authenticated;
revoke all on function public.esblu_einvoice_event_cursor_advance(text, text, uuid, bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_event_cursor_claim(text, text, integer) to service_role;
grant execute on function public.esblu_einvoice_event_cursor_advance(text, text, uuid, bigint, boolean, text) to service_role;

-- (3) Opakovanie zlyhaného spracovania udalosti (webhook aj feed) ---------------------
--   Rovnaké doručenie (rovnaké ID aj telo) so stavom failed sa smie spracovať znova,
--   najviac p_max pokusov (default 5) → kurzor feedu sa na zlyhanej udalosti nezasekne
--   donekonečna a nič sa nepreskočí ticho (po limite ostáva failed pre operátora).
alter table public.einvoice_webhook_events
  add column if not exists attempts integer not null default 1;
alter table public.einvoice_webhook_events drop constraint if exists einvoice_webhook_events_attempts_check;
alter table public.einvoice_webhook_events add constraint einvoice_webhook_events_attempts_check check (attempts between 1 and 100);

create or replace function public.esblu_einvoice_webhook_retry(p_webhook_event_id uuid, p_max integer default 5)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_max is null or p_max not between 1 and 20 then
    raise exception using errcode = '22023', message = 'ESBLU_EINVOICE_INVALID_INPUT';
  end if;
  update public.einvoice_webhook_events w
     set processing_status = 'received', attempts = w.attempts + 1, error = null, processed_at = null
   where w.id = p_webhook_event_id and w.processing_status = 'failed' and w.attempts < p_max
  returning w.id into v_id;
  return v_id is not null;
end;
$function$;
revoke all on function public.esblu_einvoice_webhook_retry(uuid, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_webhook_retry(uuid, integer) to service_role;
