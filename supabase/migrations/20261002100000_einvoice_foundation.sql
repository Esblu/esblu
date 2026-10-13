-- =============================================================================
-- E-Faktúra — provider-independent dátový základ.
-- NEAPLIKOVANÉ. Do produkcie iba cez MCP apply_migration po výslovnom
-- schválení (supabase/MIGRATIONS.md §9). Nikdy `supabase db push`.
--
-- Pôvodne 20261001100000 (vetva einvoice-foundation, 89f074f). Prečíslované
-- za 20261001130000_push_devices_session_binding a upravené podľa auditu
-- 2026-10-01 (serverová orchestrácia, nárok einvoice, retry stĺpce,
-- append-only einvoice_events, aditívny invoice_events CHECK, allowlist
-- dôkazu doručenia).
--
-- Architektúra:
--   - Esblu je source of truth faktúry, číslovania, finalizácie aj PDF.
--     Poskytovateľ (eFaktura.sk, Connector cesta — vlastný UBL) je iba
--     transportná / Peppol vrstva, nie archív ani databáza pre UI.
--   - Transportný stav sa NIKDY nezapisuje do `invoices` (finalizovaná
--     faktúra je deny-by-default immutable, 20260920150000). Patrí sem.
--   - Esblu neposkytuje zákonnú dlhodobú archiváciu. Uložené XML sú
--     prevádzkové kópie pre doručenie, kontrolu a export zákazníkom.
--
-- Prístup:
--   - Čítanie: finance.view v aktívnej firme (owner, accountant, admin iba s
--     explicitným permissions.finance.*). Employee nikdy. Čítanie NEZÁVISÍ od
--     nároku — po strate nároku ostáva história čitateľná, nič sa nemaže.
--   - Klient NEMÁ INSERT/UPDATE/DELETE na žiadnu z tabuliek ani EXECUTE na
--     žiadnu einvoice funkciu. Požiadavka „odoslať" ide VÝHRADNE cez serverovú
--     route → esblu_einvoice_request_outbound (iba service_role), ktorá
--     autorizuje overeného používateľa (finance.manage + nárok einvoice) cez
--     kanonické helpery esblu_my_*. Firma sa odvodí z členstva, prostredie
--     určuje serverová konfigurácia — nič z klientského payloadu.
--   - Žiadne tajomstvo poskytovateľa (API kľúč, webhook secret) sa do DB
--     neukladá. Iba identifikátory.
--
-- Nárok (entitlement_catalog, 20260928100000):
--   - nový samostatný platený modul `einvoice` (included_in_trial = false),
--   - firma môže mať IBA einvoice: vznik/finalizácia faktúry (trigger
--     esblu_invoicing_entitlement_guard) prejde pri aktívnom `invoicing`
--     ALEBO `einvoice` — bez toho by e-faktúru nebolo z čoho odoslať,
--   - nová požiadavka na odoslanie vyžaduje aktívny `einvoice`.
--
-- ROLLBACK (bez straty business dát):
--   drop function esblu_einvoice_request_outbound(uuid, uuid, text),
--     esblu_einvoice_actor_context(uuid);
--   drop table einvoice_events, einvoice_webhook_events, einvoice_inbound,
--     einvoice_outbound, einvoice_organizations;
--   drop function esblu_einvoice_*_guard(), esblu_einvoice_log_state_change(),
--     esblu_einvoice_events_guard(), esblu_einvoice_touch_updated_at();
--   esblu_enforce_invoicing_entitlement vrátiť na definíciu z 20260928100000
--     a drop function esblu_require_invoice_creation_entitlement(uuid);
--   delete from entitlement_catalog where key = 'einvoice' (iba ak nemá granty);
--   invoice_events CHECK zúžiť iba ak neexistujú riadky einvoice_*;
--   delete from storage.buckets where id = 'einvoice-documents' (iba ak je prázdny).
-- =============================================================================

begin;

-- Pozostatok zo skoršieho návrhu (klientsky volateľné RPC s p_environment).
-- V produkcii nikdy neexistovalo; v lokálnych/sandbox DB sa odstráni.
drop function if exists public.esblu_einvoice_request_outbound(uuid, text);

-- 0) Spoločné -----------------------------------------------------------------
create or replace function public.esblu_einvoice_touch_updated_at()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_touch_updated_at() from public, anon, authenticated;

-- 1) Nárok einvoice -----------------------------------------------------------
-- Samostatný platený modul, mimo trialu. Nový modul = nový riadok katalógu
-- (princíp 3 z 20260928100000), resolver ani tabuľky nárokov sa nemenia.
insert into public.entitlement_catalog (key, kind, included_in_trial, trial_limit, limit_reason, sort_order)
values ('einvoice', 'module', false, null, null, 15)
on conflict (key) do update set
  kind = excluded.kind,
  included_in_trial = excluded.included_in_trial,
  trial_limit = excluded.trial_limit,
  limit_reason = excluded.limit_reason,
  sort_order = excluded.sort_order;

-- Vznik / finalizácia faktúry: `invoicing` ALEBO `einvoice`. Jediné miesto
-- tejto politiky; resolver (esblu_resolve_entitlement) ostáva jedinou
-- autoritou stavu nároku. Pri odmietnutí sa vyhodí PRESNE tá istá
-- štruktúrovaná chyba ako doteraz (ENTITLEMENT_DENIED:<reason>:invoicing).
create or replace function public.esblu_require_invoice_creation_entitlement(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce((public.esblu_resolve_entitlement(p_company_id, 'invoicing') ->> 'active')::boolean, false) then
    return;
  end if;
  if coalesce((public.esblu_resolve_entitlement(p_company_id, 'einvoice') ->> 'active')::boolean, false) then
    return;
  end if;
  perform public.esblu_require_entitlement_capacity(p_company_id, 'invoicing', null);
end
$function$;
revoke all on function public.esblu_require_invoice_creation_entitlement(uuid) from public, anon, authenticated;

-- Rovnaká trigger funkcia (rovnaké meno, rovnaký trigger) ako 20260928100000,
-- iba brána nároku ide cez helper vyššie.
create or replace function public.esblu_enforce_invoicing_entitlement()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.company_id is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
    end if;
    perform public.esblu_require_invoice_creation_entitlement(new.company_id);
    return new;
  end if;

  if old.document_status = 'draft' and new.document_status = 'finalized' then
    perform public.esblu_require_invoice_creation_entitlement(new.company_id);
  end if;
  return new;
end
$function$;
revoke all on function public.esblu_enforce_invoicing_entitlement() from public, anon, authenticated;

-- 2) einvoice_organizations — väzba firma ↔ organizácia u poskytovateľa -------
create table if not exists public.einvoice_organizations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  provider_org_id text check (provider_org_id is null or char_length(provider_org_id) between 1 and 200),
  -- Peppol participant ID v tvare <schéma>:<hodnota>, napr. 9915:… (sandbox) / 0245:… (live).
  participant_id text check (participant_id is null or participant_id ~ '^[0-9]{4}:[^\s:]{1,200}$'),
  -- Stavové polia poskytovateľa sa ukladajú tak, ako prídu (neutrálny text) —
  -- enumy poskytovateľa nie sú zmluvne stabilné (docs: „ignore unknown enum values").
  org_status text check (org_status is null or char_length(org_status) <= 80),
  peppol_status text check (peppol_status is null or char_length(peppol_status) <= 80),
  claim_status text check (claim_status is null or char_length(claim_status) <= 80),
  peppol_eligible boolean not null default false,
  -- Presne tie firemné údaje, ktoré server poslal pri založení (audit). Nikdy tajomstvá.
  onboarding_snapshot jsonb check (onboarding_snapshot is null or jsonb_typeof(onboarding_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint einvoice_organizations_company_env_key unique (company_id, environment),
  constraint einvoice_organizations_provider_org_key unique (provider, environment, provider_org_id)
);

-- 3) einvoice_outbound — pokusy o doručenie finalizovanej vydanej faktúry -------
create table if not exists public.einvoice_outbound (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  attempt integer not null check (attempt >= 1),
  -- Posiela sa poskytovateľovi ako Idempotency-Key; nemenné. Každý retry
  -- TOHO ISTÉHO pokusu ho musí použiť znova (žiadne dvojité odoslanie).
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  ubl_sha256 text check (ubl_sha256 is null or ubl_sha256 ~ '^[0-9a-f]{64}$'),
  ubl_storage_path text check (ubl_storage_path is null or char_length(ubl_storage_path) <= 500),
  -- Neutrálne pomenovanie: ID podania / odloženého (staged) dokumentu u poskytovateľa.
  provider_submission_id text check (provider_submission_id is null or char_length(provider_submission_id) <= 200),
  provider_staged_id text check (provider_staged_id is null or char_length(provider_staged_id) <= 200),
  state text not null default 'pending' check (state in (
    'pending',      -- vytvorené v Esblu, ešte neodoslané poskytovateľovi
    'validated',    -- iba validácia (validateOnly / preflight)
    'staged',       -- prijaté na neskoršie odoslanie
    'queued', 'sending', 'sent', 'deferred',
    'delivered',    -- potvrdené doručenie (terminálny úspech)
    'rejected',     -- odmietnuté pred odoslaním (validácia, kredit…) — terminálne
    'failed'        -- poskytovateľom POTVRDENÉ zlyhanie — terminálne (timeout nie je failed)
  )),
  reject_reason text check (reject_reason is null or char_length(reject_reason) <= 200),
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  receiver_identifier text check (receiver_identifier is null or char_length(receiver_identifier) <= 250),
  document_id text check (document_id is null or char_length(document_id) <= 250),
  -- Dôkaz doručenia: IBA allowlistované polia (lib/einvoice/evidence.ts).
  -- Nikdy surová odpoveď, hlavičky, tokeny ani request/response blob.
  evidence jsonb check (
    evidence is null or (
      jsonb_typeof(evidence) = 'object'
      and (evidence - array['schema', 'provider_invoice_id', 'document_id', 'ubl_sha256',
                            'delivery_state', 'delivered_at', 'transactions']) = '{}'::jsonb
      and octet_length(evidence::text) <= 16384
    )
  ),
  requested_by uuid,
  -- Retry / spracovanie serverovým jobom.
  retry_count integer not null default 0 check (retry_count between 0 and 1000),
  next_retry_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  last_attempt_at timestamptz,
  locked_until timestamptz,
  -- Príjemca (Peppol participant) odvodený zo snapshotu kupujúceho pri požiadavke.
  receiver_participant_id text check (receiver_participant_id is null or receiver_participant_id ~ '^[0-9]{4}:[^\s:]{1,200}$'),
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint einvoice_outbound_invoice_attempt_key unique (invoice_id, attempt),
  constraint einvoice_outbound_idempotency_key unique (idempotency_key)
);
create index if not exists einvoice_outbound_company_idx on public.einvoice_outbound (company_id, created_at desc);
-- Najviac jeden aktívny (neterminálne zlyhaný) pokus na faktúru — žiadne dvojité odoslanie.
create unique index if not exists einvoice_outbound_one_active_per_invoice
  on public.einvoice_outbound (invoice_id) where state not in ('failed', 'rejected');
-- Výber práce pre job (retry / reconciliation).
create index if not exists einvoice_outbound_work_idx
  on public.einvoice_outbound (next_retry_at)
  where state in ('pending', 'staged', 'queued', 'sending', 'sent', 'deferred');

-- 4) einvoice_inbound — doklady prijaté cez poskytovateľa ------------------------
create table if not exists public.einvoice_inbound (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  provider_received_id text not null check (char_length(provider_received_id) between 1 and 200),
  sender_participant_id text check (sender_participant_id is null or char_length(sender_participant_id) <= 250),
  sender_ico text check (sender_ico is null or char_length(sender_ico) <= 20),
  document_number text check (document_number is null or char_length(document_number) <= 200),
  document_type text check (document_type is null or char_length(document_type) <= 80),
  xml_storage_path text check (xml_storage_path is null or char_length(xml_storage_path) <= 500),
  xml_sha256 text check (xml_sha256 is null or xml_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_storage_path text check (pdf_storage_path is null or char_length(pdf_storage_path) <= 500),
  acknowledged_at timestamptz,
  is_test boolean not null default false,
  -- Koncept prijatej faktúry vytvorený z dokladu (vždy draft na review človekom).
  invoice_id uuid references public.invoices(id) on delete set null,
  processing_status text not null default 'received' check (processing_status in (
    'received', 'stored', 'acknowledged', 'parsed', 'needs_review',
    'draft_created', 'duplicate', 'failed'
  )),
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint einvoice_inbound_provider_doc_key unique (provider, environment, provider_received_id)
);
create index if not exists einvoice_inbound_company_idx on public.einvoice_inbound (company_id, received_at desc);

-- 5) einvoice_webhook_events — prijaté doručenia webhookov (dedupe + audit) -----
create table if not exists public.einvoice_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  -- ID doručenia od poskytovateľa (napr. X-Webhook-Id) — kľúč idempotencie.
  delivery_id text not null check (char_length(delivery_id) between 1 and 200),
  provider_org_id text check (provider_org_id is null or char_length(provider_org_id) <= 200),
  -- Firma vyriešená IBA cez einvoice_organizations.provider_org_id; NULL = neznáma organizácia.
  company_id uuid references public.companies(id) on delete cascade,
  event text not null check (char_length(event) between 1 and 120),
  -- Hash surového tela — telo samotné sa neukladá (minimalizácia osobných údajov).
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in (
    'received', 'processed', 'ignored', 'failed', 'rejected'
  )),
  error text check (error is null or char_length(error) <= 2000),
  constraint einvoice_webhook_events_delivery_key unique (provider, environment, delivery_id)
);
create index if not exists einvoice_webhook_events_company_idx on public.einvoice_webhook_events (company_id, received_at desc);

-- 6) einvoice_events — append-only história stavov (outbound / inbound) --------
-- Zapisuje ju VÝHRADNE trigger pri zmene stavu (bod 8) — úplnosť auditu
-- nezávisí od toho, či serverový kód „nezabudne" zapísať udalosť.
create table if not exists public.einvoice_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- NO ACTION (kontrola na konci príkazu): priame zmazanie pokusu/dokladu s
  -- históriou zlyhá; kaskáda zo zmazania firmy prejde.
  outbound_id uuid references public.einvoice_outbound(id),
  inbound_id uuid references public.einvoice_inbound(id),
  from_state text check (from_state is null or from_state ~ '^[a-z_]{1,40}$'),
  to_state text not null check (to_state ~ '^[a-z_]{1,40}$'),
  source text not null check (source in ('user', 'job', 'webhook', 'poll', 'reconcile', 'system')),
  provider_code text check (provider_code is null or provider_code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  -- Iba malé allowlistované metadáta — žiadne osobné údaje, telá ani tajomstvá.
  metadata jsonb check (
    metadata is null or (
      jsonb_typeof(metadata) = 'object'
      and (metadata - array['attempt', 'retry_count', 'http_status', 'retryable', 'environment', 'provider']) = '{}'::jsonb
      and octet_length(metadata::text) <= 1024
    )
  ),
  created_at timestamptz not null default now(),
  constraint einvoice_events_one_subject check (num_nonnulls(outbound_id, inbound_id) = 1)
);
create index if not exists einvoice_events_company_idx on public.einvoice_events (company_id, created_at desc);
create index if not exists einvoice_events_outbound_idx on public.einvoice_events (outbound_id, created_at) where outbound_id is not null;
create index if not exists einvoice_events_inbound_idx on public.einvoice_events (inbound_id, created_at) where inbound_id is not null;

-- 7) Integrita (triggre) ----------------------------------------------------------
-- company_id sa po vložení nikdy nemení; identita pokusu/dokladu je nemenná.
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
     or (old.receiver_participant_id is not null and new.receiver_participant_id is distinct from old.receiver_participant_id) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_OUTBOUND_IDENTITY_IMMUTABLE';
  end if;
  if new.retry_count < old.retry_count then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_RETRY_COUNT_DECREASE';
  end if;
  -- Terminálny stav sa už nemení (nový pokus = nový riadok).
  if old.state in ('delivered', 'failed', 'rejected') and new.state is distinct from old.state then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_OUTBOUND_TERMINAL';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_outbound_guard() from public, anon, authenticated;

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
       or (old.pdf_storage_path is not null and new.pdf_storage_path is distinct from old.pdf_storage_path) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE';
    end if;
  end if;
  -- Priradený koncept musí patriť tej istej firme.
  if new.invoice_id is not null and not exists (
    select 1 from public.invoices i where i.id = new.invoice_id and i.company_id = new.company_id
  ) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_guard() from public, anon, authenticated;

create or replace function public.esblu_einvoice_organization_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.company_id is distinct from old.company_id
     or new.provider is distinct from old.provider
     or new.environment is distinct from old.environment
     or (old.provider_org_id is not null and new.provider_org_id is distinct from old.provider_org_id) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_ORGANIZATION_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_organization_guard() from public, anon, authenticated;

-- einvoice_events: iba INSERT; firma udalosti = firma pokusu/dokladu.
-- UPDATE nikdy; DELETE iba ako kaskáda zo zmazania firmy (pg_trigger_depth > 1),
-- nikdy priamy príkaz (ani service_role); TRUNCATE nikdy.
create or replace function public.esblu_einvoice_events_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.outbound_id is not null and not exists (
      select 1 from public.einvoice_outbound o where o.id = new.outbound_id and o.company_id = new.company_id
    ) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
    end if;
    if new.inbound_id is not null and not exists (
      select 1 from public.einvoice_inbound i where i.id = new.inbound_id and i.company_id = new.company_id
    ) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_EVENTS_APPEND_ONLY';
end;
$function$;
revoke all on function public.esblu_einvoice_events_guard() from public, anon, authenticated;

drop trigger if exists esblu_einvoice_outbound_guard on public.einvoice_outbound;
create trigger esblu_einvoice_outbound_guard before insert or update on public.einvoice_outbound
  for each row execute function public.esblu_einvoice_outbound_guard();
drop trigger if exists esblu_einvoice_inbound_guard on public.einvoice_inbound;
create trigger esblu_einvoice_inbound_guard before insert or update on public.einvoice_inbound
  for each row execute function public.esblu_einvoice_inbound_guard();
drop trigger if exists esblu_einvoice_organization_guard on public.einvoice_organizations;
create trigger esblu_einvoice_organization_guard before update on public.einvoice_organizations
  for each row execute function public.esblu_einvoice_organization_guard();
drop trigger if exists esblu_einvoice_events_guard on public.einvoice_events;
create trigger esblu_einvoice_events_guard before insert or update or delete on public.einvoice_events
  for each row execute function public.esblu_einvoice_events_guard();
drop trigger if exists esblu_einvoice_events_no_truncate on public.einvoice_events;
create trigger esblu_einvoice_events_no_truncate before truncate on public.einvoice_events
  for each statement execute function public.esblu_einvoice_events_guard();

drop trigger if exists esblu_einvoice_organizations_touch on public.einvoice_organizations;
create trigger esblu_einvoice_organizations_touch before update on public.einvoice_organizations
  for each row execute function public.esblu_einvoice_touch_updated_at();
drop trigger if exists esblu_einvoice_outbound_touch on public.einvoice_outbound;
create trigger esblu_einvoice_outbound_touch before update on public.einvoice_outbound
  for each row execute function public.esblu_einvoice_touch_updated_at();
drop trigger if exists esblu_einvoice_inbound_touch on public.einvoice_inbound;
create trigger esblu_einvoice_inbound_touch before update on public.einvoice_inbound
  for each row execute function public.esblu_einvoice_touch_updated_at();

-- 8) Automatický audit zmien stavu → einvoice_events -------------------------------
-- Zdroj udalosti nastavuje serverový kód lokálne v transakcii:
--   select set_config('esblu.einvoice_event_source', 'job', true);
-- Neznáma/chýbajúca hodnota = 'system'. Do metadát ide iba allowlist.
create or replace function public.esblu_einvoice_log_state_change()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_source text := coalesce(nullif(current_setting('esblu.einvoice_event_source', true), ''), 'system');
begin
  if v_source not in ('user', 'job', 'webhook', 'poll', 'reconcile', 'system') then
    v_source := 'system';
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
      case when tg_op = 'UPDATE' then new.last_error_code end,
      jsonb_build_object('attempt', new.attempt, 'retry_count', new.retry_count,
                         'environment', new.environment, 'provider', new.provider)
    );
  else
    if tg_op = 'UPDATE' and new.processing_status is not distinct from old.processing_status then
      return null;
    end if;
    insert into public.einvoice_events (company_id, inbound_id, from_state, to_state, source, metadata)
    values (
      new.company_id, new.id,
      case when tg_op = 'UPDATE' then old.processing_status end,
      new.processing_status, v_source,
      jsonb_build_object('environment', new.environment, 'provider', new.provider)
    );
  end if;
  return null;
end;
$function$;
revoke all on function public.esblu_einvoice_log_state_change() from public, anon, authenticated;

drop trigger if exists esblu_einvoice_outbound_log_state on public.einvoice_outbound;
create trigger esblu_einvoice_outbound_log_state after insert or update of state on public.einvoice_outbound
  for each row execute function public.esblu_einvoice_log_state_change();
drop trigger if exists esblu_einvoice_inbound_log_state on public.einvoice_inbound;
create trigger esblu_einvoice_inbound_log_state after insert or update of processing_status on public.einvoice_inbound
  for each row execute function public.esblu_einvoice_log_state_change();

-- 9) RLS a oprávnenia ---------------------------------------------------------------
alter table public.einvoice_organizations enable row level security;
alter table public.einvoice_outbound enable row level security;
alter table public.einvoice_inbound enable row level security;
alter table public.einvoice_webhook_events enable row level security;
alter table public.einvoice_events enable row level security;

revoke all on table public.einvoice_organizations, public.einvoice_outbound,
  public.einvoice_inbound, public.einvoice_webhook_events, public.einvoice_events
  from public, anon, authenticated;
grant select on table public.einvoice_organizations, public.einvoice_outbound,
  public.einvoice_inbound, public.einvoice_webhook_events, public.einvoice_events to authenticated;
grant all on table public.einvoice_organizations, public.einvoice_outbound,
  public.einvoice_inbound, public.einvoice_webhook_events to service_role;
-- Append-only aj pre server: iba SELECT + INSERT.
revoke all on table public.einvoice_events from service_role;
grant select, insert on table public.einvoice_events to service_role;

-- Čítanie: aktívna firma + finance.view. ZÁMERNE bez nároku — história
-- ostáva čitateľná aj po strate nároku einvoice.
drop policy if exists einvoice_organizations_select_finance on public.einvoice_organizations;
create policy einvoice_organizations_select_finance on public.einvoice_organizations
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists einvoice_outbound_select_finance on public.einvoice_outbound;
create policy einvoice_outbound_select_finance on public.einvoice_outbound
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists einvoice_inbound_select_finance on public.einvoice_inbound;
create policy einvoice_inbound_select_finance on public.einvoice_inbound
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists einvoice_webhook_events_select_finance on public.einvoice_webhook_events;
create policy einvoice_webhook_events_select_finance on public.einvoice_webhook_events
  for select to authenticated
  using (company_id is not null
         and company_id = public.esblu_my_active_company_id()
         and public.esblu_my_finance_view());

drop policy if exists einvoice_events_select_finance on public.einvoice_events;
create policy einvoice_events_select_finance on public.einvoice_events
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

-- 10) invoice_events — einvoice_* typy ADITÍVNE ---------------------------------------
-- Zoznam povolených typov sa NEPREPISUJE naslepo: prečíta sa aktuálny CHECK
-- (čokoľvek doň medzičasom pribudlo, ostáva), pridajú sa iba chýbajúce
-- einvoice_* typy a na konci sa overí, že žiadny pôvodný typ nezmizol.
do $migration$
declare
  v_con record;
  v_found integer := 0;
  v_conname text;
  v_existing text[] := array[]::text[];
  v_all text[];
  v_type text;
  v_after text;
begin
  for v_con in
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.conrelid = 'public.invoice_events'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%event_type%'
  loop
    v_found := v_found + 1;
    v_conname := v_con.conname;
    select coalesce(array_agg(x.m[1] order by x.ord), array[]::text[]) into v_existing
    from regexp_matches(v_con.def, '''([^'']+)''', 'g') with ordinality as x(m, ord);
  end loop;

  if v_found <> 1 or cardinality(v_existing) = 0 then
    raise exception using errcode = 'P0001',
      message = 'ESBLU_MIGRATION_INVOICE_EVENTS_CHECK_UNEXPECTED:' || v_found::text;
  end if;

  v_all := v_existing;
  foreach v_type in array array['einvoice_send_requested', 'einvoice_sent', 'einvoice_delivered',
                                'einvoice_failed', 'einvoice_received']
  loop
    if not (v_type = any (v_all)) then
      v_all := v_all || v_type;
    end if;
  end loop;

  execute format('alter table public.invoice_events drop constraint %I', v_conname);
  -- Tvar `event_type in ('a', 'b', …)` — Postgres ho uloží ako
  -- ANY (ARRAY['a'::text, …]), rovnako ako pôvodný CHECK (opakovateľné čítanie).
  execute format(
    'alter table public.invoice_events add constraint invoice_events_event_type_check check (event_type in (%s))',
    (select string_agg(quote_literal(t.v), ', ' order by t.ord) from unnest(v_all) with ordinality as t(v, ord))
  );

  select pg_get_constraintdef(c.oid) into v_after
  from pg_constraint c
  where c.conrelid = 'public.invoice_events'::regclass and c.conname = 'invoice_events_event_type_check';
  foreach v_type in array v_existing
  loop
    if position('''' || v_type || '''' in v_after) = 0 then
      raise exception using errcode = 'P0001', message = 'ESBLU_MIGRATION_INVOICE_EVENTS_TYPE_LOST:' || v_type;
    end if;
  end loop;
end
$migration$;

-- 11) Požiadavka na odoslanie — IBA serverová orchestrácia ----------------------------
-- Kontext overeného používateľa vyhodnotený KANONICKÝMI helpermi
-- (esblu_my_active_company_id / esblu_my_finance_manage) — žiadna
-- duplicitná logika rolí. Identita sa na čas vyhodnotenia nastaví lokálne
-- v transakcii a hneď sa obnoví. Bez grantov — volá ju iba RPC nižšie.
create or replace function public.esblu_einvoice_actor_context(
  p_actor_user_id uuid,
  out company_id uuid,
  out finance_manage boolean
)
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_old_claims text := current_setting('request.jwt.claims', true);
  v_old_sub text := current_setting('request.jwt.claim.sub', true);
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_actor_user_id::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);

  company_id := public.esblu_my_active_company_id();
  finance_manage := coalesce(public.esblu_my_finance_manage(), false);

  perform set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);
end;
$function$;
revoke all on function public.esblu_einvoice_actor_context(uuid) from public, anon, authenticated, service_role;

-- Vytvorí (alebo vráti existujúci aktívny) pokus o doručenie. Nič neposiela —
-- odoslanie robí serverový job s kľúčom poskytovateľa.
--   p_actor_user_id  overený používateľ (JWT overený serverovou route)
--   p_invoice_id     faktúra (musí patriť firme používateľa)
--   p_environment    serverová konfigurácia (ESBLU_EINVOICE_ENVIRONMENT),
--                    nikdy klientský vstup — funkcia nie je klientom volateľná
create or replace function public.esblu_einvoice_request_outbound(
  p_actor_user_id uuid,
  p_invoice_id uuid,
  p_environment text
)
returns public.einvoice_outbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
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
  -- Rola PRED nárokom: nárok nikdy nerozširuje oprávnenie.
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

  -- Obranná vrstva nad nemenným snapshotom (úplnú kontrolu robí serverová
  -- readiness + UBL generátor). Nič sa nedopĺňa ani nehádá.
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

  perform pg_advisory_xact_lock(hashtextextended('einvoice_outbound:' || p_invoice_id::text, 0));

  select * into v_existing from public.einvoice_outbound e
  where e.invoice_id = p_invoice_id and e.state not in ('failed', 'rejected');
  if v_existing.id is not null then
    return v_existing;  -- idempotentné: aktívny pokus už existuje
  end if;

  select coalesce(max(e.attempt), 0) + 1 into v_attempt
  from public.einvoice_outbound e where e.invoice_id = p_invoice_id;

  perform set_config('esblu.einvoice_event_source', 'user', true);
  insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt,
                                        idempotency_key, requested_by, receiver_participant_id)
  values (v_company, p_invoice_id, v_org.provider, v_org.environment, v_attempt,
          'esblu-out-' || replace(p_invoice_id::text, '-', '') || '-' || v_attempt::text,
          p_actor_user_id, v_receiver)
  returning * into v_row;
  perform set_config('esblu.einvoice_event_source', '', true);

  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'einvoice_send_requested', p_actor_user_id, 'user',
          jsonb_build_object('attempt', v_attempt, 'environment', v_org.environment, 'provider', v_org.provider));

  return v_row;
end;
$function$;
revoke all on function public.esblu_einvoice_request_outbound(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_request_outbound(uuid, uuid, text) to service_role;

-- 12) Storage — privátny bucket, bez klientskych politík (iba server) ---------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('einvoice-documents', 'einvoice-documents', false, 15728640,
        array['application/xml', 'text/xml', 'application/pdf'])
on conflict (id) do nothing;

commit;
