-- =============================================================================
-- E-Faktúra — Phase 2: serverový OUTBOUND flow (request → queue → send →
-- status/evidence). NEAPLIKOVANÉ. Do produkcie iba cez MCP apply_migration po
-- výslovnom schválení (supabase/MIGRATIONS.md §9). Nikdy `supabase db push`.
-- Závisí od 20261002100000_einvoice_foundation.
--
-- Tok:
--   1. Serverová route (POST /api/einvoice/outbound) overí JWT, readiness,
--      vygeneruje kanonické UBL z nemenného snapshotu, uloží PRESNÉ bajty do
--      privátneho storage (cesta adresovaná obsahom: …/<sha256>.xml), overí
--      príjemcu a preflight u poskytovateľa a AŽ POTOM zavolá
--      esblu_einvoice_request_outbound → riadok `queued` s nemennou UBL väzbou.
--      Route sama nič neodosiela.
--   2. Worker (iba server, service_role) si riadky berie cez
--      esblu_einvoice_claim_outbound (FOR UPDATE SKIP LOCKED + lease), načíta
--      uložené bajty, znovu overí SHA-256 a odošle ich s TÝM ISTÝM
--      Idempotency-Key. Výsledok zapíše cez esblu_einvoice_outbound_transition.
--   3. Reconciliation (iba server) sa pýta poskytovateľa na stav podaní a
--      dôkaz doručenia; po vyčerpaní pokusov s neistým výsledkom nič
--      neoznačí ako `failed` (žiadne dvojité odoslanie novým pokusom).
--
-- Udalosti: JEDINÝ model — trigger esblu_einvoice_log_state_change. Každá
-- zmena stavu (einvoice_events) aj súhrn na časovej osi faktúry
-- (invoice_events: einvoice_send_requested / _sent / _delivered / _failed)
-- vzniká v triggeri; RPC už invoice_events explicitne nezapisuje. Zdroj
-- (user / job / provider / reconcile …) a kód poskytovateľa odovzdávajú RPC
-- cez transakčné GUC esblu.einvoice_event_source / esblu.einvoice_provider_code.
--
-- ROLLBACK (bez straty business dát):
--   drop function esblu_einvoice_request_outbound(uuid, uuid, text, text, text, integer, text),
--     esblu_einvoice_claim_outbound(text, integer, integer, integer),
--     esblu_einvoice_outbound_transition(uuid, text, text, text, text, jsonb);
--   obnoviť esblu_einvoice_request_outbound(uuid, uuid, text),
--     esblu_einvoice_outbound_guard() a esblu_einvoice_log_state_change()
--     z 20261002100000; nové stĺpce môžu ostať (neškodné).
-- =============================================================================

begin;

-- 1) Nemenná UBL väzba + stav odosielania -------------------------------------------
alter table public.einvoice_outbound
  add column if not exists ubl_size_bytes integer
    check (ubl_size_bytes is null or ubl_size_bytes between 1 and 15728640),
  add column if not exists ubl_generated_at timestamptz,
  -- Kedy poskytovateľ potvrdil príjemcu (lookup) — príjemca sa ukladá IBA po overení.
  add column if not exists receiver_verified_at timestamptz,
  -- Prebieha volanie poskytovateľa (nastaví claim, zruší zápis výsledku).
  -- Ak lease vyprší s true, výsledok predchádzajúceho pokusu je NEZNÁMY.
  add column if not exists send_in_flight boolean not null default false,
  -- Aspoň jeden pokus mal neistý výsledok (timeout / sieť / 5xx / pád workera).
  -- Lepkavé: raz true, navždy true → riadok sa nikdy automaticky neoznačí failed.
  add column if not exists send_outcome_unknown boolean not null default false,
  -- Posledný normalizovaný stav od poskytovateľa (napr. SENT, DELIVERED) a čas kontroly.
  add column if not exists provider_status text
    check (provider_status is null or provider_status ~ '^[A-Za-z_]{1,40}$'),
  add column if not exists status_checked_at timestamptz;

-- 2) Guard: nemennosť + povolené prechody stavov --------------------------------------
create or replace function public.esblu_einvoice_outbound_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company uuid;
  v_direction text;
  v_status text;
begin
  if tg_op = 'INSERT' then
    select i.company_id, i.direction, i.document_status
      into v_company, v_direction, v_status
    from public.invoices i where i.id = new.invoice_id;
    if v_company is null or v_company <> new.company_id then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
    end if;
    if v_direction <> 'issued' or v_status <> 'finalized' then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVOICE_NOT_FINALIZED_ISSUED';
    end if;
    return new;
  end if;

  if new.company_id is distinct from old.company_id
     or new.invoice_id is distinct from old.invoice_id
     or new.attempt is distinct from old.attempt
     or new.idempotency_key is distinct from old.idempotency_key
     or new.provider is distinct from old.provider
     or new.environment is distinct from old.environment
     or (old.ubl_sha256 is not null and new.ubl_sha256 is distinct from old.ubl_sha256)
     or (old.ubl_storage_path is not null and new.ubl_storage_path is distinct from old.ubl_storage_path)
     or (old.ubl_size_bytes is not null and new.ubl_size_bytes is distinct from old.ubl_size_bytes)
     or (old.ubl_generated_at is not null and new.ubl_generated_at is distinct from old.ubl_generated_at)
     or (old.receiver_participant_id is not null and new.receiver_participant_id is distinct from old.receiver_participant_id)
     or (old.receiver_verified_at is not null and new.receiver_verified_at is distinct from old.receiver_verified_at)
     or (old.provider_submission_id is not null and new.provider_submission_id is distinct from old.provider_submission_id) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_OUTBOUND_IDENTITY_IMMUTABLE';
  end if;
  if new.retry_count < old.retry_count then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RETRY_COUNT_DECREASE';
  end if;
  if old.send_outcome_unknown and not new.send_outcome_unknown then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_OUTCOME_UNKNOWN_STICKY';
  end if;
  -- Terminálny stav sa už nemení (nový pokus = nový riadok).
  if old.state in ('delivered', 'failed', 'rejected') and new.state is distinct from old.state then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_OUTBOUND_TERMINAL';
  end if;
  if new.state is distinct from old.state and not (
       (old.state in ('pending', 'validated', 'staged') and new.state in ('queued', 'sending', 'sent', 'rejected', 'failed'))
    or (old.state = 'queued' and new.state in ('sending', 'rejected', 'failed'))
    or (old.state = 'sending' and new.state in ('sent', 'deferred', 'delivered', 'rejected', 'failed'))
    or (old.state = 'sent' and new.state in ('deferred', 'delivered', 'failed'))
    or (old.state = 'deferred' and new.state in ('sent', 'delivered', 'failed'))
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_TRANSITION:' || old.state || '->' || new.state;
  end if;
  -- Bez potvrdenia poskytovateľom (ID podania) nič nie je „odoslané".
  if new.state in ('sent', 'deferred', 'delivered') and new.provider_submission_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_PROVIDER_ID_REQUIRED';
  end if;
  if new.state = 'delivered' and new.delivered_at is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_DELIVERED_AT_REQUIRED';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_outbound_guard() from public, anon, authenticated;

-- 3) einvoice_events: zdroj 'provider' (aditívne) ---------------------------------------
alter table public.einvoice_events drop constraint if exists einvoice_events_source_check;
alter table public.einvoice_events add constraint einvoice_events_source_check
  check (source in ('user', 'job', 'provider', 'webhook', 'poll', 'reconcile', 'system'));

-- 4) JEDINÝ model udalostí: trigger -----------------------------------------------------
create or replace function public.esblu_einvoice_log_state_change()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_source text := coalesce(nullif(current_setting('esblu.einvoice_event_source', true), ''), 'system');
  v_provider_code text := nullif(current_setting('esblu.einvoice_provider_code', true), '');
  v_invoice_event text;
begin
  if v_source not in ('user', 'job', 'provider', 'webhook', 'poll', 'reconcile', 'system') then
    v_source := 'system';
  end if;
  if v_provider_code is not null and v_provider_code !~ '^[A-Za-z0-9_.:-]{1,80}$' then
    v_provider_code := null;
  end if;

  if tg_table_name = 'einvoice_outbound' then
    if tg_op = 'UPDATE' and new.state is not distinct from old.state then
      return null;
    end if;
    insert into public.einvoice_events (company_id, outbound_id, from_state, to_state, source, provider_code, metadata)
    values (
      new.company_id, new.id,
      case when tg_op = 'UPDATE' then old.state end,
      new.state, v_source,
      coalesce(v_provider_code, case when tg_op = 'UPDATE' then new.last_error_code end),
      jsonb_build_object('attempt', new.attempt, 'retry_count', new.retry_count,
                         'environment', new.environment, 'provider', new.provider)
    );

    -- Súhrn na časovej osi faktúry (bez PII, bez tajomstiev).
    v_invoice_event := case
      when tg_op = 'INSERT' then 'einvoice_send_requested'
      when new.state = 'sent' then 'einvoice_sent'
      when new.state = 'delivered' then 'einvoice_delivered'
      when new.state in ('failed', 'rejected') then 'einvoice_failed'
    end;
    if v_invoice_event is not null then
      insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
      values (
        new.invoice_id, v_invoice_event,
        case when tg_op = 'INSERT' then new.requested_by end,
        case when tg_op = 'INSERT' and new.requested_by is not null then 'user' else 'system' end,
        jsonb_build_object('attempt', new.attempt, 'state', new.state,
                           'environment', new.environment, 'provider', new.provider)
      );
    end if;
  else
    if tg_op = 'UPDATE' and new.processing_status is not distinct from old.processing_status then
      return null;
    end if;
    insert into public.einvoice_events (company_id, inbound_id, from_state, to_state, source, provider_code, metadata)
    values (
      new.company_id, new.id,
      case when tg_op = 'UPDATE' then old.processing_status end,
      new.processing_status, v_source, v_provider_code,
      jsonb_build_object('environment', new.environment, 'provider', new.provider)
    );
  end if;
  return null;
end;
$function$;
revoke all on function public.esblu_einvoice_log_state_change() from public, anon, authenticated;

-- 5) Požiadavka na odoslanie (iba server) -------------------------------------------------
-- Nahrádza verziu z 20261002100000: riadok vzniká až s nemennou UBL väzbou a
-- s príjemcom OVERENÝM u poskytovateľa (route volá lookup + preflight pred RPC).
drop function if exists public.esblu_einvoice_request_outbound(uuid, uuid, text);

create or replace function public.esblu_einvoice_request_outbound(
  p_actor_user_id uuid,
  p_invoice_id uuid,
  p_environment text,
  p_ubl_sha256 text,
  p_ubl_storage_path text,
  p_ubl_size_bytes integer,
  p_receiver_participant_id text
)
returns table (outbound_id uuid, created boolean, state text, ubl_sha256 text, idempotency_key text)
language plpgsql
volatile
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_ctx record;
  v_company uuid;
  v_inv record;
  v_org record;
  v_seller record;
  v_buyer record;
  v_receiver text;
  v_existing public.einvoice_outbound;
  v_attempt integer;
  v_row public.einvoice_outbound;
begin
  if p_actor_user_id is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select * into v_ctx from public.esblu_einvoice_actor_context(p_actor_user_id);
  v_company := v_ctx.company_id;
  if v_company is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if not v_ctx.finance_manage then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  perform public.esblu_require_entitlement_capacity(v_company, 'einvoice', null);

  if p_environment is null or p_environment not in ('sandbox', 'live') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_ENVIRONMENT';
  end if;

  select i.id, i.company_id, i.direction, i.document_status, i.kind
    into v_inv
  from public.invoices i where i.id = p_invoice_id;
  if v_inv.id is null or v_inv.company_id <> v_company then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_inv.direction <> 'issued' or v_inv.document_status <> 'finalized' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVOICE_NOT_FINALIZED_ISSUED';
  end if;
  if v_inv.kind not in ('regular_invoice', 'credit_note', 'debit_note') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_KIND_UNSUPPORTED';
  end if;

  select o.provider, o.environment, o.peppol_eligible, o.participant_id into v_org
  from public.einvoice_organizations o
  where o.company_id = v_company and o.environment = p_environment;
  if v_org.provider is null or not v_org.peppol_eligible or v_org.participant_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ORGANIZATION_NOT_READY';
  end if;

  -- Obranná vrstva nad nemenným snapshotom (úplnú kontrolu robí serverová readiness).
  select p.country_code, p.ico, p.electronic_address, p.electronic_address_scheme_id into v_seller
  from public.invoice_parties p where p.invoice_id = p_invoice_id and p.role = 'seller';
  select p.country_code, p.ico, p.electronic_address, p.electronic_address_scheme_id into v_buyer
  from public.invoice_parties p where p.invoice_id = p_invoice_id and p.role = 'buyer';
  if nullif(btrim(v_seller.electronic_address), '') is null or nullif(btrim(v_seller.electronic_address_scheme_id), '') is null
     or nullif(btrim(v_buyer.electronic_address), '') is null or nullif(btrim(v_buyer.electronic_address_scheme_id), '') is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_PARTY_ENDPOINT_MISSING';
  end if;
  if btrim(v_seller.electronic_address_scheme_id) || ':' || btrim(v_seller.electronic_address) <> v_org.participant_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_SELLER_ENDPOINT_MISMATCH';
  end if;
  if (upper(btrim(coalesce(v_seller.country_code, ''))) = 'SK' and coalesce(btrim(v_seller.ico), '') !~ '^[0-9]{8}$')
     or (upper(btrim(coalesce(v_buyer.country_code, ''))) = 'SK' and coalesce(btrim(v_buyer.ico), '') !~ '^[0-9]{8}$') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_SK_ICO_MISSING';
  end if;
  v_receiver := btrim(v_buyer.electronic_address_scheme_id) || ':' || btrim(v_buyer.electronic_address);
  if v_receiver !~ '^[0-9]{4}:[^\s:]{1,200}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RECEIVER_INVALID';
  end if;
  -- Server smie odovzdať IBA príjemcu odvodeného zo snapshotu a overeného u poskytovateľa.
  if p_receiver_participant_id is distinct from v_receiver then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RECEIVER_MISMATCH';
  end if;

  -- Nemenná UBL väzba: cesta adresovaná obsahom v rámci firmy a faktúry.
  if p_ubl_sha256 is null or p_ubl_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_UBL_HASH_INVALID';
  end if;
  if p_ubl_storage_path is distinct from (v_company::text || '/outbound/' || p_invoice_id::text || '/' || p_ubl_sha256 || '.xml') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_UBL_PATH_INVALID';
  end if;
  if p_ubl_size_bytes is null or p_ubl_size_bytes < 1 or p_ubl_size_bytes > 15728640 then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_UBL_SIZE_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('einvoice_outbound:' || p_invoice_id::text, 0));

  select * into v_existing from public.einvoice_outbound e
  where e.invoice_id = p_invoice_id and e.state not in ('failed', 'rejected');
  if v_existing.id is not null then
    -- Idempotentné: aktívny pokus už existuje → žiadny nový dokument ani riadok.
    return query select v_existing.id, false, v_existing.state, v_existing.ubl_sha256, v_existing.idempotency_key;
    return;
  end if;

  select coalesce(max(e.attempt), 0) + 1 into v_attempt
  from public.einvoice_outbound e where e.invoice_id = p_invoice_id;

  perform set_config('esblu.einvoice_event_source', 'user', true);
  insert into public.einvoice_outbound (
    company_id, invoice_id, provider, environment, attempt, idempotency_key, requested_by,
    state, next_retry_at, receiver_participant_id, receiver_verified_at,
    ubl_sha256, ubl_storage_path, ubl_size_bytes, ubl_generated_at
  ) values (
    v_company, p_invoice_id, v_org.provider, v_org.environment, v_attempt,
    -- Hranica idempotencie: faktúra + pokus + hash dokumentu (deterministické).
    'esblu-out-' || replace(p_invoice_id::text, '-', '') || '-' || v_attempt::text || '-' || left(p_ubl_sha256, 16),
    p_actor_user_id,
    'queued', now(), v_receiver, now(),
    p_ubl_sha256, p_ubl_storage_path, p_ubl_size_bytes, now()
  )
  returning * into v_row;
  perform set_config('esblu.einvoice_event_source', '', true);

  return query select v_row.id, true, v_row.state, v_row.ubl_sha256, v_row.idempotency_key;
end;
$function$;
revoke all on function public.esblu_einvoice_request_outbound(uuid, uuid, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_request_outbound(uuid, uuid, text, text, text, integer, text) to service_role;

-- 6) Claim pre worker / reconciliation (iba server) ---------------------------------------
--   p_mode = 'send'      : queued / sending BEZ ID poskytovateľa, retry-ready
--                          (next_retry_at <= now), lease voľný, retry_count < 8.
--                          Claim = nový pokus: retry_count + 1, send_in_flight,
--                          lepkavé send_outcome_unknown, ak predošlý pokus nedobehol.
--   p_mode = 'reconcile' : podania s ID poskytovateľa (sending/sent/deferred)
--                          staršie než p_reconcile_after_seconds, ALEBO sending bez
--                          ID po vyčerpaní pokusov (pád workera na poslednom pokuse).
-- FOR UPDATE SKIP LOCKED + lease (locked_until) → ten istý riadok nespracujú dvaja.
create or replace function public.esblu_einvoice_claim_outbound(
  p_mode text,
  p_limit integer,
  p_lease_seconds integer,
  p_reconcile_after_seconds integer default 300
)
returns setof public.einvoice_outbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 10);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
  v_after interval := make_interval(secs => greatest(coalesce(p_reconcile_after_seconds, 300), 0));
begin
  if p_mode = 'send' then
    perform set_config('esblu.einvoice_event_source', 'job', true);
    return query
    with c as (
      select e.id from public.einvoice_outbound e
      where e.state in ('queued', 'sending')
        and e.provider_submission_id is null
        and e.next_retry_at is not null and e.next_retry_at <= now()
        and (e.locked_until is null or e.locked_until < now())
        and e.retry_count < 8
        and e.ubl_sha256 is not null and e.ubl_storage_path is not null
      order by e.next_retry_at, e.created_at
      limit v_limit
      for update skip locked
    )
    update public.einvoice_outbound o
    set state = 'sending',
        retry_count = o.retry_count + 1,
        last_attempt_at = now(),
        locked_until = now() + v_lease,
        -- Pád workera počas pokusu → riadok sa po lease znovu zoberie.
        next_retry_at = now() + v_lease,
        send_outcome_unknown = o.send_outcome_unknown or o.send_in_flight,
        send_in_flight = true
    from c where o.id = c.id
    returning o.*;
    perform set_config('esblu.einvoice_event_source', '', true);
    return;
  end if;

  if p_mode = 'reconcile' then
    perform set_config('esblu.einvoice_event_source', 'reconcile', true);
    return query
    with c as (
      select e.id from public.einvoice_outbound e
      where (e.locked_until is null or e.locked_until < now())
        and (
          (e.provider_submission_id is not null and e.state in ('sending', 'sent', 'deferred')
            and e.updated_at <= now() - v_after)
          or (e.provider_submission_id is null and e.state = 'sending' and e.retry_count >= 8
            and e.next_retry_at is not null)
        )
      order by e.updated_at
      limit v_limit
      for update skip locked
    )
    update public.einvoice_outbound o
    set locked_until = now() + v_lease
    from c where o.id = c.id
    returning o.*;
    perform set_config('esblu.einvoice_event_source', '', true);
    return;
  end if;

  raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_CLAIM_MODE';
end;
$function$;
revoke all on function public.esblu_einvoice_claim_outbound(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_claim_outbound(text, integer, integer, integer) to service_role;

-- 7) Zápis výsledku (iba server) ----------------------------------------------------------
-- Optimistická kontrola stavu (p_expected_state), allowlist polí, zdroj a kód
-- poskytovateľa pre trigger udalostí. retry_count, identita a UBL väzba sa
-- touto cestou meniť nedajú.
create or replace function public.esblu_einvoice_outbound_transition(
  p_outbound_id uuid,
  p_expected_state text,
  p_to_state text,
  p_source text,
  p_provider_code text,
  p_fields jsonb
)
returns public.einvoice_outbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_row public.einvoice_outbound;
begin
  if jsonb_typeof(v_fields) <> 'object'
     or (v_fields - array['provider_submission_id', 'provider_staged_id', 'reject_reason', 'error_message',
                          'last_error_code', 'next_retry_at', 'receiver_identifier', 'document_id', 'evidence',
                          'sent_at', 'delivered_at', 'send_in_flight', 'send_outcome_unknown', 'locked_until',
                          'provider_status', 'status_checked_at']) <> '{}'::jsonb then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TRANSITION_FIELDS_INVALID';
  end if;
  if p_source is null or p_source not in ('job', 'provider', 'reconcile', 'webhook', 'poll', 'system') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TRANSITION_SOURCE_INVALID';
  end if;

  perform set_config('esblu.einvoice_event_source', p_source, true);
  perform set_config('esblu.einvoice_provider_code', coalesce(p_provider_code, ''), true);

  update public.einvoice_outbound o
  set state = coalesce(p_to_state, o.state),
      provider_submission_id = case when v_fields ? 'provider_submission_id' then v_fields ->> 'provider_submission_id' else o.provider_submission_id end,
      provider_staged_id = case when v_fields ? 'provider_staged_id' then v_fields ->> 'provider_staged_id' else o.provider_staged_id end,
      reject_reason = case when v_fields ? 'reject_reason' then v_fields ->> 'reject_reason' else o.reject_reason end,
      error_message = case when v_fields ? 'error_message' then v_fields ->> 'error_message' else o.error_message end,
      last_error_code = case when v_fields ? 'last_error_code' then v_fields ->> 'last_error_code' else o.last_error_code end,
      next_retry_at = case when v_fields ? 'next_retry_at' then (v_fields ->> 'next_retry_at')::timestamptz else o.next_retry_at end,
      receiver_identifier = case when v_fields ? 'receiver_identifier' then v_fields ->> 'receiver_identifier' else o.receiver_identifier end,
      document_id = case when v_fields ? 'document_id' then v_fields ->> 'document_id' else o.document_id end,
      evidence = case when v_fields ? 'evidence' then nullif(v_fields -> 'evidence', 'null'::jsonb) else o.evidence end,
      sent_at = case when v_fields ? 'sent_at' then (v_fields ->> 'sent_at')::timestamptz else o.sent_at end,
      delivered_at = case when v_fields ? 'delivered_at' then (v_fields ->> 'delivered_at')::timestamptz else o.delivered_at end,
      send_in_flight = case when v_fields ? 'send_in_flight' then (v_fields ->> 'send_in_flight')::boolean else o.send_in_flight end,
      send_outcome_unknown = case when v_fields ? 'send_outcome_unknown' then (v_fields ->> 'send_outcome_unknown')::boolean else o.send_outcome_unknown end,
      locked_until = case when v_fields ? 'locked_until' then (v_fields ->> 'locked_until')::timestamptz else o.locked_until end,
      provider_status = case when v_fields ? 'provider_status' then v_fields ->> 'provider_status' else o.provider_status end,
      status_checked_at = case when v_fields ? 'status_checked_at' then (v_fields ->> 'status_checked_at')::timestamptz else o.status_checked_at end
  where o.id = p_outbound_id and o.state = p_expected_state
  returning * into v_row;

  perform set_config('esblu.einvoice_event_source', '', true);
  perform set_config('esblu.einvoice_provider_code', '', true);

  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_OUTBOUND_STALE';
  end if;
  return v_row;
end;
$function$;
revoke all on function public.esblu_einvoice_outbound_transition(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_outbound_transition(uuid, text, text, text, text, jsonb) to service_role;

commit;
