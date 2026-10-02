-- =============================================================================
-- E-Faktúra — Phase 4: recovery, operátorské akcie, retencia, health/alerty.
-- NEAPLIKOVANÉ. Do produkcie iba cez MCP apply_migration po výslovnom
-- schválení (supabase/MIGRATIONS.md §9). Nikdy `supabase db push`.
-- Závisí od 20261002100000 … 20261002130000.
--
-- Primárne transportné stavy sa NEMENIA. Operátorské kategórie sa odvodzujú
-- zo state + provider_submission_id + next_retry_at + last_error_code
-- (esblu_einvoice_outbound_category / esblu_einvoice_inbound_category,
-- zrkadlo v lib/einvoice/ops/categories.ts).
--
-- Bezpečnosť opakovania:
--   - nový pokus (nový Idempotency-Key) iba po rejected / potvrdenom failed a
--     NIKDY pri neistom výsledku, kým reconciliation autoritatívne nepotvrdí,
--     že pôvodné podanie u poskytovateľa neexistuje (reconciled_absent_at).
--     Vynucuje to esblu_einvoice_request_outbound (DB), nie iba UI,
--   - operátorské akcie idú cez esblu_einvoice_operator_begin: autorizácia
--     aktéra (finance.manage, aktívna firma, izolácia), pravidlo stavu, nárok
--     pre NOVÉ operácie, lease na konkrétny riadok a DB cooldown (rate limit),
--     audit udalosť (source=user, metadata iba action/actor/reason_code).
--   - dokončenie rozbehnutého transportu (reconciliation, ACK) nárok nevyžaduje.
--
-- Retencia: iba technické metadáta webhookov (einvoice_webhook_events,
-- einvoice_webhook_rejections) — nikdy faktúry, XML/UBL, dôkazy ani
-- einvoice_events.
--
-- ROLLBACK (bez straty business dát):
--   drop function esblu_einvoice_operator_begin, esblu_einvoice_health,
--     esblu_einvoice_webhook_retention, esblu_einvoice_storage_consistency,
--     esblu_einvoice_webhook_rejection_record, esblu_einvoice_outbound_category,
--     esblu_einvoice_inbound_category; drop table einvoice_webhook_rejections;
--   esblu_einvoice_outbound_guard / _outbound_transition / _request_outbound
--     vrátiť z 20261002120000 a esblu_einvoice_inbound_guard z 20261002130000;
--   metadata CHECK einvoice_events vrátiť (iba ak neexistujú action udalosti);
--   nové stĺpce môžu ostať.
-- =============================================================================

begin;

-- 1) Stĺpce ------------------------------------------------------------------------------
alter table public.einvoice_outbound
  -- Reconciliation autoritatívne potvrdila, že podanie s týmto Idempotency-Key
  -- u poskytovateľa NEEXISTUJE (iba pre pokus bez ID poskytovateľa).
  add column if not exists reconciled_absent_at timestamptz,
  -- Posledná operátorská akcia (DB rate limit / cooldown).
  add column if not exists operator_action_at timestamptz;
alter table public.einvoice_inbound
  add column if not exists operator_action_at timestamptz;

-- Technické počítadlo odmietnutých webhookov (zlý podpis / replay) — bez tela,
-- bez hlavičiek, bez IP. Jeden riadok na minútu a dôvod (ohraničená veľkosť).
create table if not exists public.einvoice_webhook_rejections (
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  reason text not null check (reason in ('INVALID_SIGNATURE', 'REPLAYED_WEBHOOK', 'PAYLOAD_TOO_LARGE', 'INVALID_PAYLOAD')),
  bucket_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (provider, environment, reason, bucket_start)
);
alter table public.einvoice_webhook_rejections enable row level security;
revoke all on table public.einvoice_webhook_rejections from public, anon, authenticated;
grant select, insert, update, delete on table public.einvoice_webhook_rejections to service_role;

-- 2) Audit operátorských akcií: metadáta allowlist + action/actor/reason ---------------------
alter table public.einvoice_events drop constraint if exists einvoice_events_metadata_check;
alter table public.einvoice_events add constraint einvoice_events_metadata_check check (
  metadata is null or (
    jsonb_typeof(metadata) = 'object'
    and (metadata - array['attempt', 'retry_count', 'http_status', 'retryable', 'environment', 'provider',
                          'action', 'actor_user_id', 'reason_code']) = '{}'::jsonb
    and octet_length(metadata::text) <= 1024
  )
);

-- 3) Guardy a serverové RPC rozšírené o Phase 4 pravidlá (telo inak zhodné s 20261002120000/130000)
-- 3a) outbound guard: reconciled_absent_at nemenné; iba pre pokus bez ID poskytovateľa
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
     or (old.provider_submission_id is not null and new.provider_submission_id is distinct from old.provider_submission_id)
     or (old.reconciled_absent_at is not null and new.reconciled_absent_at is distinct from old.reconciled_absent_at) then
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
  -- „Podanie u poskytovateľa neexistuje" sa dá potvrdiť iba pre pokus bez ID poskytovateľa.
  if new.reconciled_absent_at is not null and new.provider_submission_id is not null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ABSENT_WITH_PROVIDER_ID';
  end if;
  if new.state = 'delivered' and new.delivered_at is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_DELIVERED_AT_REQUIRED';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_outbound_guard() from public, anon, authenticated;

-- 3b) zápis výsledku: + reconciled_absent_at (allowlist)
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
                          'provider_status', 'status_checked_at', 'reconciled_absent_at']) <> '{}'::jsonb then
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
      status_checked_at = case when v_fields ? 'status_checked_at' then (v_fields ->> 'status_checked_at')::timestamptz else o.status_checked_at end,
      reconciled_absent_at = case when v_fields ? 'reconciled_absent_at' then (v_fields ->> 'reconciled_absent_at')::timestamptz else o.reconciled_absent_at end
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

-- 3c) požiadavka na odoslanie: blok nového pokusu po neistom výsledku (DB, nie iba UI)
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
  v_last public.einvoice_outbound;
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

  -- Phase 4: nový pokus (nový Idempotency-Key) NIKDY, ak výsledok predošlého
  -- pokusu je neistý a reconciliation nepotvrdila, že u poskytovateľa neexistuje.
  select * into v_last from public.einvoice_outbound e
  where e.invoice_id = p_invoice_id order by e.attempt desc limit 1;
  if v_last.id is not null and v_last.send_outcome_unknown
     and v_last.provider_submission_id is null and v_last.reconciled_absent_at is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_PREVIOUS_OUTCOME_UNKNOWN';
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

-- 3d) inbound guard: operátorské failed → stored iba s uloženým XML a bez konceptu
create or replace function public.esblu_einvoice_inbound_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id
       or new.provider is distinct from old.provider
       or new.environment is distinct from old.environment
       or new.provider_received_id is distinct from old.provider_received_id
       or (old.xml_sha256 is not null and new.xml_sha256 is distinct from old.xml_sha256)
       or (old.xml_storage_path is not null and new.xml_storage_path is distinct from old.xml_storage_path)
       or (old.xml_size_bytes is not null and new.xml_size_bytes is distinct from old.xml_size_bytes)
       or (old.pdf_storage_path is not null and new.pdf_storage_path is distinct from old.pdf_storage_path)
       or (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id)
       or (old.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE';
    end if;
    if new.retry_count < old.retry_count then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RETRY_COUNT_DECREASE';
    end if;
    -- Phase 4: jediná výnimka z terminálneho stavu — operátorské opätovné
    -- spracovanie failed → stored, iba ak XML (hash, cesta, veľkosť) už existuje,
    -- koncept ešte nevznikol a prechod robí operátorské RPC (transakčné GUC).
    if old.processing_status = 'failed' and new.processing_status = 'stored'
       and coalesce(current_setting('esblu.einvoice_operator_reprocess', true), '') = 'on'
       and old.xml_sha256 is not null and old.xml_storage_path is not null
       and old.xml_size_bytes is not null and old.invoice_id is null then
      return new;
    end if;
    if old.processing_status in ('acknowledged', 'failed') and new.processing_status is distinct from old.processing_status then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_TERMINAL';
    end if;
    if new.processing_status is distinct from old.processing_status and not (
         (old.processing_status = 'received' and new.processing_status in ('stored', 'failed'))
      or (old.processing_status = 'stored' and new.processing_status in ('parsed', 'failed'))
      or (old.processing_status = 'parsed' and new.processing_status in ('draft_created', 'duplicate', 'failed'))
      or (old.processing_status in ('draft_created', 'duplicate') and new.processing_status in ('acknowledged', 'ack_pending'))
      or (old.processing_status = 'ack_pending' and new.processing_status = 'acknowledged')
      or (old.processing_status = 'needs_review' and new.processing_status in ('stored', 'parsed', 'failed'))
    ) then
      raise exception using errcode = 'P0001',
        message = 'ESBLU_EINVOICE_INVALID_TRANSITION:' || old.processing_status || '->' || new.processing_status;
    end if;
  end if;

  -- Stavové invarianty (aj pre INSERT).
  if new.processing_status in ('stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending', 'acknowledged')
     and (new.xml_sha256 is null or new.xml_storage_path is null or new.xml_size_bytes is null) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_XML_REQUIRED';
  end if;
  -- ACK (a stavy čakajúce na ACK) iba s existujúcim konceptom faktúry.
  if new.processing_status in ('draft_created', 'duplicate', 'ack_pending', 'acknowledged') and new.invoice_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_DRAFT_REQUIRED';
  end if;
  if new.processing_status = 'acknowledged' and new.acknowledged_at is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACKNOWLEDGED_AT_REQUIRED';
  end if;

  -- Priradený koncept musí patriť tej istej firme a byť prijatou faktúrou.
  if new.invoice_id is not null and not exists (
    select 1 from public.invoices i
    where i.id = new.invoice_id and i.company_id = new.company_id and i.direction = 'received'
  ) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_guard() from public, anon, authenticated;

-- 4) Operátorské kategórie (odvodené, bez nových stavov) ------------------------------------
create or replace function public.esblu_einvoice_outbound_category(
  p_state text, p_provider_submission_id text, p_next_retry_at timestamptz, p_last_error_code text
)
returns text
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_state = 'delivered' then 'delivered'
    when p_state = 'rejected' then 'rejected'
    when p_state = 'failed' then 'permanent_failure'
    when p_state = 'sending' and p_provider_submission_id is null
         and p_last_error_code = 'EINVOICE_RETRY_EXHAUSTED_UNKNOWN' then 'retry_exhausted_unknown'
    when p_provider_submission_id is not null
         or (p_state = 'sending' and p_next_retry_at is null) then 'reconciliation_required'
    else 'retryable'
  end;
$function$;
revoke all on function public.esblu_einvoice_outbound_category(text, text, timestamptz, text) from public, anon, authenticated;

create or replace function public.esblu_einvoice_inbound_category(p_status text, p_dedupe_matched_on text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_status = 'duplicate' or (p_status = 'acknowledged' and p_dedupe_matched_on is not null) then 'duplicate'
    when p_status = 'acknowledged' then 'acknowledged'
    when p_status in ('ack_pending', 'draft_created') then 'ack_pending'
    when p_status = 'failed' then 'failed'
    else 'retryable'
  end;
$function$;
revoke all on function public.esblu_einvoice_inbound_category(text, text) from public, anon, authenticated;

-- 5) Začiatok operátorskej akcie (iba server; aktér z overeného JWT) -------------------------
--   outbound_reconcile : sending / sent / deferred — lease; bez nároku (dokončenie transportu)
--   outbound_retry     : rejected / failed, NIE neistý výsledok bez potvrdenej absencie,
--                        posledný pokus faktúry, žiadny aktívny pokus — vyžaduje nárok
--   inbound_reprocess  : received / stored / parsed, alebo failed s uloženým XML bez
--                        konceptu (failed → stored) — lease; vyžaduje nárok
--   inbound_ack_retry  : ack_pending / draft_created / duplicate s konceptom a XML — lease;
--                        bez nároku (dokončenie transportu)
-- Rate limit: cooldown na riadok (operator_action_at) + aktívny lease = odmietnuté.
create or replace function public.esblu_einvoice_operator_begin(
  p_actor_user_id uuid,
  p_kind text,
  p_id uuid,
  p_action text,
  p_reason_code text,
  p_lease_seconds integer,
  p_cooldown_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_ctx record;
  v_company uuid;
  v_out public.einvoice_outbound;
  v_in public.einvoice_inbound;
  v_latest integer;
  v_active integer;
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
  v_cooldown interval := make_interval(secs => least(greatest(coalesce(p_cooldown_seconds, 60), 0), 3600));
  v_meta jsonb;
begin
  if p_actor_user_id is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  if not ((p_kind = 'outbound' and p_action in ('outbound_reconcile', 'outbound_retry'))
          or (p_kind = 'inbound' and p_action in ('inbound_reprocess', 'inbound_ack_retry'))) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_INVALID';
  end if;
  if p_reason_code is not null and p_reason_code !~ '^[A-Z_]{1,40}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_REASON_INVALID';
  end if;

  select * into v_ctx from public.esblu_einvoice_actor_context(p_actor_user_id);
  v_company := v_ctx.company_id;
  if v_company is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if not v_ctx.finance_manage then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;

  v_meta := jsonb_build_object('action', p_action, 'actor_user_id', p_actor_user_id::text)
    || case when p_reason_code is not null then jsonb_build_object('reason_code', p_reason_code) else '{}'::jsonb end;

  if p_kind = 'outbound' then
    select * into v_out from public.einvoice_outbound o where o.id = p_id for update;
    -- Iná firma = „neexistuje" (žiadny únik existencie).
    if v_out.id is null or v_out.company_id <> v_company then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_NOT_FOUND';
    end if;
    if p_action = 'outbound_retry' then
      perform public.esblu_require_entitlement_capacity(v_company, 'einvoice', null);
    end if;
    if v_out.operator_action_at is not null and v_out.operator_action_at > now() - v_cooldown then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_RATE_LIMITED';
    end if;
    if v_out.locked_until is not null and v_out.locked_until > now() then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_IN_PROGRESS';
    end if;

    if p_action = 'outbound_reconcile' then
      if v_out.state not in ('sending', 'sent', 'deferred') then
        raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_NOT_ALLOWED';
      end if;
    else
      if v_out.state = 'sending' and v_out.provider_submission_id is null and v_out.send_outcome_unknown then
        -- Neistý výsledok: najprv povinná reconciliation, nikdy priamo nový pokus.
        raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RECONCILE_REQUIRED';
      end if;
      if v_out.state not in ('failed', 'rejected') then
        raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_NOT_ALLOWED';
      end if;
      if v_out.send_outcome_unknown and v_out.provider_submission_id is null and v_out.reconciled_absent_at is null then
        raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RECONCILE_REQUIRED';
      end if;
      select max(e.attempt) into v_latest from public.einvoice_outbound e where e.invoice_id = v_out.invoice_id;
      select count(*) into v_active from public.einvoice_outbound e
      where e.invoice_id = v_out.invoice_id and e.state not in ('failed', 'rejected');
      if v_latest <> v_out.attempt or v_active > 0 then
        raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_NOT_LATEST_ATTEMPT';
      end if;
    end if;

    update public.einvoice_outbound o
    set operator_action_at = now(),
        locked_until = case when p_action = 'outbound_reconcile' then now() + v_lease else o.locked_until end
    where o.id = v_out.id
    returning * into v_out;

    insert into public.einvoice_events (company_id, outbound_id, from_state, to_state, source, provider_code, metadata)
    values (v_company, v_out.id, v_out.state, v_out.state, 'user', 'OPERATOR_' || upper(p_action), v_meta);

    return jsonb_build_object('kind', 'outbound', 'row', to_jsonb(v_out));
  end if;

  select * into v_in from public.einvoice_inbound i where i.id = p_id for update;
  if v_in.id is null or v_in.company_id <> v_company then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_NOT_FOUND';
  end if;
  if p_action = 'inbound_reprocess' then
    perform public.esblu_require_entitlement_capacity(v_company, 'einvoice', null);
  end if;
  if v_in.operator_action_at is not null and v_in.operator_action_at > now() - v_cooldown then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_RATE_LIMITED';
  end if;
  if v_in.locked_until is not null and v_in.locked_until > now() then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_IN_PROGRESS';
  end if;

  if p_action = 'inbound_reprocess' then
    if not (v_in.processing_status in ('received', 'stored', 'parsed')
            or (v_in.processing_status = 'failed' and v_in.invoice_id is null and v_in.xml_sha256 is not null
                and v_in.xml_storage_path is not null and v_in.xml_size_bytes is not null)) then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACTION_NOT_ALLOWED';
    end if;
  else
    if v_in.processing_status not in ('ack_pending', 'draft_created', 'duplicate')
       or v_in.invoice_id is null or v_in.xml_sha256 is null or v_in.xml_storage_path is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ACK_REQUIRES_DRAFT';
    end if;
  end if;

  insert into public.einvoice_events (company_id, inbound_id, from_state, to_state, source, provider_code, metadata)
  values (v_company, v_in.id, v_in.processing_status, v_in.processing_status, 'user', 'OPERATOR_' || upper(p_action), v_meta);

  perform set_config('esblu.einvoice_event_source', 'user', true);
  if v_in.processing_status = 'failed' then
    perform set_config('esblu.einvoice_operator_reprocess', 'on', true);
  end if;
  update public.einvoice_inbound i
  set processing_status = case when i.processing_status = 'failed' then 'stored' else i.processing_status end,
      last_error_code = case when i.processing_status = 'failed' then null else i.last_error_code end,
      operator_action_at = now(),
      next_retry_at = now() + v_lease,
      locked_until = now() + v_lease
  where i.id = v_in.id
  returning * into v_in;
  perform set_config('esblu.einvoice_operator_reprocess', '', true);
  perform set_config('esblu.einvoice_event_source', '', true);

  return jsonb_build_object('kind', 'inbound', 'row', to_jsonb(v_in));
end;
$function$;
revoke all on function public.esblu_einvoice_operator_begin(uuid, text, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_operator_begin(uuid, text, uuid, text, text, integer, integer) to service_role;

-- 6) Odmietnuté webhooky — ohraničené počítadlo (bez tela, hlavičiek, IP) --------------------
create or replace function public.esblu_einvoice_webhook_rejection_record(p_provider text, p_environment text, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path to ''
as $function$
begin
  insert into public.einvoice_webhook_rejections (provider, environment, reason, bucket_start, count)
  values (p_provider, p_environment, p_reason, date_trunc('minute', now()), 1)
  on conflict (provider, environment, reason, bucket_start)
  do update set count = least(public.einvoice_webhook_rejections.count + 1, 1000000);
end;
$function$;
revoke all on function public.esblu_einvoice_webhook_rejection_record(text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_webhook_rejection_record(text, text, text) to service_role;

-- 7) Retencia technických webhook dát (dávkovo, bez kaskády do faktúr) ------------------------
-- Maže IBA uzavreté doručenia (processed / ignored / failed / rejected) staršie
-- než p_older_than_days (min. 30, odporúčané 90) a počítadlá odmietnutí. Nikdy
-- faktúry, XML/UBL, dôkazy, einvoice_events ani einvoice_inbound/outbound.
create or replace function public.esblu_einvoice_webhook_retention(p_older_than_days integer, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_days integer := greatest(coalesce(p_older_than_days, 90), 30);
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_events integer;
  v_rejections integer;
begin
  with d as (
    select w.id from public.einvoice_webhook_events w
    where w.received_at < now() - make_interval(days => v_days)
      and w.processing_status in ('processed', 'ignored', 'failed', 'rejected')
    order by w.received_at
    limit v_limit
  )
  delete from public.einvoice_webhook_events w using d where w.id = d.id;
  get diagnostics v_events = row_count;

  with d as (
    select r.provider, r.environment, r.reason, r.bucket_start from public.einvoice_webhook_rejections r
    where r.bucket_start < now() - make_interval(days => v_days)
    order by r.bucket_start
    limit v_limit
  )
  delete from public.einvoice_webhook_rejections r using d
  where r.provider = d.provider and r.environment = d.environment and r.reason = d.reason and r.bucket_start = d.bucket_start;
  get diagnostics v_rejections = row_count;

  return jsonb_build_object('older_than_days', v_days, 'webhook_events_deleted', v_events, 'rejection_buckets_deleted', v_rejections);
end;
$function$;
revoke all on function public.esblu_einvoice_webhook_retention(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_webhook_retention(integer, integer) to service_role;

-- 8) Konzistencia storage (iba čítanie, iba počty) ------------------------------------------
create or replace function public.esblu_einvoice_storage_consistency()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with refs as (
    select o.ubl_storage_path as path, 'outbound' as kind from public.einvoice_outbound o where o.ubl_storage_path is not null
    union
    select i.xml_storage_path, 'inbound' from public.einvoice_inbound i where i.xml_storage_path is not null
  ),
  objs as (
    select s.name from storage.objects s where s.bucket_id = 'einvoice-documents'
  )
  select jsonb_build_object(
    'outbound_rows_missing_object', (select count(*) from public.einvoice_outbound o
       where o.ubl_storage_path is not null and not exists (select 1 from objs where objs.name = o.ubl_storage_path)),
    'inbound_rows_missing_object', (select count(*) from public.einvoice_inbound i
       where i.xml_storage_path is not null and not exists (select 1 from objs where objs.name = i.xml_storage_path)),
    'objects_without_reference', (select count(*) from objs where not exists (select 1 from refs where refs.path = objs.name)),
    'objects_total', (select count(*) from objs),
    'references_total', (select count(*) from refs)
  );
$function$;
revoke all on function public.esblu_einvoice_storage_consistency() from public, anon, authenticated;
grant execute on function public.esblu_einvoice_storage_consistency() to service_role;

-- 9) Health — iba agregované počty (žiadne firmy, IČO, čísla dokladov, XML ani ID) -----------
create or replace function public.esblu_einvoice_health(p_stuck_minutes integer, p_ack_pending_minutes integer)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with o as (
    select e.state, e.updated_at, e.send_outcome_unknown, e.provider_submission_id,
           public.esblu_einvoice_outbound_category(e.state, e.provider_submission_id, e.next_retry_at, e.last_error_code) as category
    from public.einvoice_outbound e
  ),
  i as (
    select n.processing_status as status, n.updated_at,
           public.esblu_einvoice_inbound_category(n.processing_status, n.dedupe_matched_on) as category
    from public.einvoice_inbound n
  ),
  stuck_minutes as (select greatest(coalesce(p_stuck_minutes, 60), 1) as m, greatest(coalesce(p_ack_pending_minutes, 60), 1) as a)
  select jsonb_build_object(
    'generated_at', now(),
    'outbound', jsonb_build_object(
      'queued', (select count(*) from o where state = 'queued'),
      'sending', (select count(*) from o where state = 'sending'),
      'sent', (select count(*) from o where state = 'sent'),
      'deferred', (select count(*) from o where state = 'deferred'),
      'delivered', (select count(*) from o where state = 'delivered'),
      'rejected', (select count(*) from o where state = 'rejected'),
      'failed', (select count(*) from o where state = 'failed'),
      'retryable', (select count(*) from o where category = 'retryable'),
      'reconciliation_required', (select count(*) from o where category = 'reconciliation_required'),
      'retry_exhausted_unknown', (select count(*) from o where category = 'retry_exhausted_unknown'),
      'unknown_send_outcome', (select count(*) from o where send_outcome_unknown and provider_submission_id is null and state not in ('failed', 'rejected', 'delivered')),
      'stuck', (select count(*) from o, stuck_minutes s where state in ('queued', 'sending', 'sent', 'deferred') and updated_at < now() - make_interval(mins => s.m)),
      'oldest_stuck_age_seconds', (select coalesce(floor(extract(epoch from now() - min(updated_at))), 0)::bigint from o where state in ('queued', 'sending', 'sent', 'deferred'))
    ),
    'inbound', jsonb_build_object(
      'received', (select count(*) from i where status = 'received'),
      'stored', (select count(*) from i where status = 'stored'),
      'parsed', (select count(*) from i where status = 'parsed'),
      'draft_created', (select count(*) from i where status = 'draft_created'),
      'duplicate', (select count(*) from i where category = 'duplicate'),
      'ack_pending', (select count(*) from i where category = 'ack_pending'),
      'acknowledged', (select count(*) from i where category = 'acknowledged'),
      'failed', (select count(*) from i where status = 'failed'),
      'ack_pending_too_long', (select count(*) from i, stuck_minutes s where status in ('ack_pending', 'draft_created', 'duplicate') and updated_at < now() - make_interval(mins => s.a)),
      'stuck', (select count(*) from i, stuck_minutes s where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending') and updated_at < now() - make_interval(mins => s.m)),
      'oldest_stuck_age_seconds', (select coalesce(floor(extract(epoch from now() - min(updated_at))), 0)::bigint from i where status in ('received', 'stored', 'parsed', 'draft_created', 'duplicate', 'ack_pending'))
    ),
    'webhook', jsonb_build_object(
      'failures_24h', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'failed' and w.received_at > now() - interval '24 hours'),
      'rejected_24h', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'rejected' and w.received_at > now() - interval '24 hours'),
      'unprocessed_older_15m', (select count(*) from public.einvoice_webhook_events w where w.processing_status = 'received' and w.received_at < now() - interval '15 minutes'),
      'signature_failures_1h', (select coalesce(sum(r.count), 0) from public.einvoice_webhook_rejections r where r.reason = 'INVALID_SIGNATURE' and r.bucket_start > now() - interval '1 hour'),
      'replays_1h', (select coalesce(sum(r.count), 0) from public.einvoice_webhook_rejections r where r.reason = 'REPLAYED_WEBHOOK' and r.bucket_start > now() - interval '1 hour')
    )
  );
$function$;
revoke all on function public.esblu_einvoice_health(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_health(integer, integer) to service_role;

commit;
