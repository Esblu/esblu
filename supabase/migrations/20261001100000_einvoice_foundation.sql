-- =============================================================================
-- E-Faktúra — provider-independent dátový základ (Phase A).
-- NEAPLIKOVANÉ. Iba lokálne / testovací branch. Do produkcie iba cez MCP
-- apply_migration po výslovnom schválení. Nikdy `supabase db push`.
--
-- Architektúra (rozhodnutie 2026-09-30):
--   - Esblu je source of truth faktúry, číslovania, finalizácie aj PDF.
--   - Poskytovateľ (prvý kandidát eFaktura.sk, Connector cesta — vlastný UBL)
--     je iba transportná / Peppol vrstva.
--   - Transportný stav sa NIKDY nezapisuje do `invoices` (finalizovaná
--     faktúra je deny-by-default immutable, 20260920150000). Patrí sem.
--   - Esblu neposkytuje zákonnú dlhodobú archiváciu. Uložené XML/PDF sú
--     prevádzkové kópie pre doručenie, kontrolu a export zákazníkom.
--
-- Prístup:
--   - Čítanie: finance.view v aktívnej firme (owner, accountant, admin iba s
--     explicitným permissions.finance.*). Employee nikdy — výnimka príjmu
--     dokladov (M1 intake) sa E-Faktúry netýka.
--   - Klient NEMÁ INSERT/UPDATE/DELETE na žiadnu z tabuliek. Používateľská
--     akcia „odoslať" ide cez esblu_einvoice_request_outbound (SECURITY
--     DEFINER, finance.manage). Stavy od poskytovateľa a webhooky zapisuje
--     iba server (service_role) — žiadna klientska cesta.
--   - Žiadne tajomstvo poskytovateľa (API kľúč, webhook secret) sa do DB
--     neukladá. Iba identifikátory.
--
-- ROLLBACK: drop function esblu_einvoice_request_outbound(uuid, text);
--   drop table einvoice_webhook_events, einvoice_inbound, einvoice_outbound,
--   einvoice_organizations; drop function esblu_einvoice_*_guard();
--   vrátiť invoice_events_event_type_check na pôvodný zoznam;
--   delete from storage.buckets where id = 'einvoice-documents' (iba ak je prázdny).
-- =============================================================================

begin;

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

-- 1) einvoice_organizations — väzba firma ↔ organizácia u poskytovateľa -------
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

-- 2) einvoice_outbound — pokusy o doručenie finalizovanej vydanej faktúry -------
create table if not exists public.einvoice_outbound (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null check (environment in ('sandbox', 'live')),
  attempt integer not null check (attempt >= 1),
  -- Posiela sa poskytovateľovi ako Idempotency-Key; nemenné.
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
    'failed'        -- zlyhalo po odoslaní — terminálne
  )),
  reject_reason text check (reject_reason is null or char_length(reject_reason) <= 200),
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  receiver_identifier text check (receiver_identifier is null or char_length(receiver_identifier) <= 250),
  document_id text check (document_id is null or char_length(document_id) <= 250),
  evidence jsonb check (evidence is null or jsonb_typeof(evidence) = 'object'),
  requested_by uuid,
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

-- 3) einvoice_inbound — doklady prijaté cez poskytovateľa ------------------------
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

-- 4) einvoice_webhook_events — prijaté doručenia webhookov (dedupe + audit) -----
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

-- 5) Integrita (triggre) ----------------------------------------------------------
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
     or (old.ubl_storage_path is not null and new.ubl_storage_path is distinct from old.ubl_storage_path) then
    raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_OUTBOUND_IDENTITY_IMMUTABLE';
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

drop trigger if exists esblu_einvoice_outbound_guard on public.einvoice_outbound;
create trigger esblu_einvoice_outbound_guard before insert or update on public.einvoice_outbound
  for each row execute function public.esblu_einvoice_outbound_guard();
drop trigger if exists esblu_einvoice_inbound_guard on public.einvoice_inbound;
create trigger esblu_einvoice_inbound_guard before insert or update on public.einvoice_inbound
  for each row execute function public.esblu_einvoice_inbound_guard();
drop trigger if exists esblu_einvoice_organization_guard on public.einvoice_organizations;
create trigger esblu_einvoice_organization_guard before update on public.einvoice_organizations
  for each row execute function public.esblu_einvoice_organization_guard();

drop trigger if exists esblu_einvoice_organizations_touch on public.einvoice_organizations;
create trigger esblu_einvoice_organizations_touch before update on public.einvoice_organizations
  for each row execute function public.esblu_einvoice_touch_updated_at();
drop trigger if exists esblu_einvoice_outbound_touch on public.einvoice_outbound;
create trigger esblu_einvoice_outbound_touch before update on public.einvoice_outbound
  for each row execute function public.esblu_einvoice_touch_updated_at();
drop trigger if exists esblu_einvoice_inbound_touch on public.einvoice_inbound;
create trigger esblu_einvoice_inbound_touch before update on public.einvoice_inbound
  for each row execute function public.esblu_einvoice_touch_updated_at();

-- 6) RLS a oprávnenia ---------------------------------------------------------------
alter table public.einvoice_organizations enable row level security;
alter table public.einvoice_outbound enable row level security;
alter table public.einvoice_inbound enable row level security;
alter table public.einvoice_webhook_events enable row level security;

revoke all on table public.einvoice_organizations, public.einvoice_outbound,
  public.einvoice_inbound, public.einvoice_webhook_events from public, anon, authenticated;
grant select on table public.einvoice_organizations, public.einvoice_outbound,
  public.einvoice_inbound, public.einvoice_webhook_events to authenticated;
grant all on table public.einvoice_organizations, public.einvoice_outbound,
  public.einvoice_inbound, public.einvoice_webhook_events to service_role;

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

-- 7) invoice_events — typy udalostí E-Faktúry ------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.invoice_events'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%event_type%'
  loop
    execute format('alter table public.invoice_events drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.invoice_events add constraint invoice_events_event_type_check check (event_type in (
  'created', 'draft_updated', 'finalized',
  'payment_recorded', 'payment_removed', 'correction_created',
  'einvoice_send_requested', 'einvoice_sent', 'einvoice_delivered',
  'einvoice_failed', 'einvoice_received'
));

-- 8) Používateľská akcia: požiadavka na odoslanie --------------------------------------
-- Vytvorí (alebo vráti existujúci aktívny) pokus o doručenie. Nič neposiela —
-- odoslanie robí server s kľúčom poskytovateľa. Prostredie a poskytovateľ sa
-- berú z einvoice_organizations (zakladá ich iba server), nie z klienta.
create or replace function public.esblu_einvoice_request_outbound(p_invoice_id uuid, p_environment text)
returns public.einvoice_outbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.esblu_my_active_company_id();
  v_inv record;
  v_org record;
  v_existing public.einvoice_outbound;
  v_attempt integer;
  v_row public.einvoice_outbound;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  if v_company is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
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

  select o.provider, o.environment, o.peppol_eligible into v_org
  from public.einvoice_organizations o
  where o.company_id = v_company and o.environment = p_environment;
  if v_org.provider is null or not v_org.peppol_eligible then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_ORGANIZATION_NOT_READY';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('einvoice_outbound:' || p_invoice_id::text, 0));

  select * into v_existing from public.einvoice_outbound e
  where e.invoice_id = p_invoice_id and e.state not in ('failed', 'rejected');
  if v_existing.id is not null then
    return v_existing;  -- idempotentné: aktívny pokus už existuje
  end if;

  select coalesce(max(e.attempt), 0) + 1 into v_attempt
  from public.einvoice_outbound e where e.invoice_id = p_invoice_id;

  insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key, requested_by)
  values (v_company, p_invoice_id, v_org.provider, v_org.environment, v_attempt,
          'esblu-out-' || replace(p_invoice_id::text, '-', '') || '-' || v_attempt::text, v_uid)
  returning * into v_row;

  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'einvoice_send_requested', v_uid, 'user',
          jsonb_build_object('attempt', v_attempt, 'environment', v_org.environment, 'provider', v_org.provider));

  return v_row;
end;
$function$;
revoke all on function public.esblu_einvoice_request_outbound(uuid, text) from public, anon;
grant execute on function public.esblu_einvoice_request_outbound(uuid, text) to authenticated;

-- 9) Storage — privátny bucket, bez klientskych politík (iba server) ---------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('einvoice-documents', 'einvoice-documents', false, 15728640,
        array['application/xml', 'text/xml', 'application/pdf'])
on conflict (id) do nothing;

commit;
