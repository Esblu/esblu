-- =============================================================================
-- P4 (2026-11-23): účtovná kópia Stripe dokladov + podklady pre mesačný export účtovníčke.
-- Iba aditívne. Rollback: supabase/rollback/20261123110000_billing_invoice_documents_rollback.sql
-- (účtovné dáta sa pri rollbacku NEMAŽÚ — presunú sa do esblu_audit_archive).
-- Architektúra a otvorené daňové otázky: docs/billing-invoicing-architecture-2026-11-19.md,
-- docs/accountant-questions-billing-2026-11-19.md. Táto migrácia NEROZHODUJE, kto je vystaviteľ
-- daňového dokladu (stĺpec legal_issuer; default 'stripe' = variant A, kým účtovníčka nerozhodne).
--
--   billing_invoice_documents   — 1 riadok na Stripe faktúru / dobropis (unikát provider+prostredie+ID),
--                                 sumy a daňové polia tak, ako ich poslal Stripe, väzba na firmu,
--                                 predplatné, PaymentIntent, pôvodnú faktúru (dobropis), archív PDF
--                                 (SHA-256 + cesta v Storage). Plní ho pipeline z udalostí
--                                 invoice.finalized / paid / voided / marked_uncollectible a
--                                 credit_note.created / updated / voided (webhook, doťahovanie, retry)
--                                 idempotentne; stav sa posúva iba dopredu, archivované PDF je nemenné.
--   billing_refund_observations — refundácie (charge.refunded) podľa PaymentIntent → kontrola, že ku
--                                 každej refundácii vznikol dobropis (ops alert REFUND_WITHOUT_CREDIT_NOTE).
--   billing_balance_transactions — import Stripe balance transactions (hrubá suma, poplatok, čistá suma,
--                                 výplata) pre mesačný export; read-only reportingový kľúč.
--   billing_ops_admins          — prevádzkovatelia s prístupom k admin exportu (zápis iba SQL / postgres).
--   billing_accounting_export_log — kto a kedy exportoval (audit).
--   Storage bucket billing-documents (privátny, iba PDF, iba server).
-- Žiadna tabuľka nemá prístup cez Data API pre anon / authenticated; service_role nemá DELETE.
-- Z dát Stripe sa neukladá meno, e-mail ani adresa odberateľa (iba krajina a daňové identifikátory z dokladu).
--
-- Identifikačný snapshot odberateľa (esblu8, 2026-11-19): company_id je FK s ON DELETE SET NULL — po
-- ukončení firmy by doklad stratil väzbu na zákazníka. Preto sa pri prvom zápise (a pri prvom priradení
-- firmy) zachytí NEMENNÝ snapshot: customer_company_id (obyčajné uuid bez FK), obchodné meno, IČO, DIČ,
-- IČ DPH, registrácia (krajina + číslo), fakturačná adresa a krajina z company_billing_profile /
-- company_legal_identities / companies (identita právnickej osoby / SZČO, ktorej Esblu fakturuje — obsah
-- účtovného dokladu Esblu, nie kontaktné údaje osoby: bez e-mailu, IBAN, owner_id). Snapshot sa neskôr
-- iba DOPĹŇA (null → hodnota), nikdy neprepíše (trigger). provider_customer_id / provider_subscription_id
-- sú po nastavení tiež nemenné.
-- Účtovné záznamy Esblu (billing_invoice_documents, billing_refund_observations,
-- billing_balance_transactions, billing_accounting_export_log) sa NEDAJÚ zmazať ani TRUNCATE (trigger,
-- aj pre postgres): ukončenie firmy, zrušenie účtu, cleanup joby ani retenčná purge zákazníckych dát
-- (esblu_retention.purge_expired) sa ich nedotknú. Vlastná retencia Esblu pre tieto záznamy a PDF v
-- bucket billing-documents = samostatná lehota, PROPOSED 10 rokov od konca kalendárneho roka dokladu
-- (potvrdí účtovníčka); automatické mazanie NEEXISTUJE, kým lehota a postup nie sú schválené.
-- =============================================================================

-- ----------------------------------------------------------------------------- 1) doklady
create table if not exists public.billing_invoice_documents (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe',
  environment text not null,
  kind text not null,
  provider_document_id text not null,
  related_invoice_id text null,
  company_id uuid null references public.companies (id) on delete set null,
  provider_customer_id text null,
  provider_subscription_id text null,
  payment_intent_id text null,
  document_number text null,
  status text null,
  currency text null,
  subtotal_minor bigint null,
  subtotal_excl_tax_minor bigint null,
  total_minor bigint null,
  total_excl_tax_minor bigint null,
  tax_minor bigint null,
  amount_paid_minor bigint null,
  customer_country text null,
  customer_tax_exempt text null,
  customer_tax_ids jsonb not null default '[]'::jsonb,
  tax_details jsonb not null default '[]'::jsonb,
  service_period_start timestamptz null,
  service_period_end timestamptz null,
  issued_at timestamptz null,
  paid_at timestamptz null,
  voided_at timestamptz null,
  hosted_url text null,
  pdf_url text null,
  credit_reason text null,
  credit_type text null,
  -- Nemenný identifikačný snapshot odberateľa (prežije ukončenie firmy; nie je FK).
  customer_company_id uuid null,
  customer_legal_name text null,
  customer_ico text null,
  customer_dic text null,
  customer_ic_dph text null,
  customer_registration_country text null,
  customer_registration_id text null,
  customer_address jsonb null,
  customer_billing_country text null,
  customer_snapshot_at timestamptz null,
  customer_snapshot_source text null,
  -- Kto je zákonným vystaviteľom daňového dokladu (variant A = 'stripe', variant B = 'esblu').
  legal_issuer text not null default 'stripe',
  -- Budúca väzba na štruktúrovanú e-faktúru (eFaktura.sk / Peppol) — najviac jedna na doklad.
  einvoice_outbound_id uuid null,
  pdf_sha256 text null,
  pdf_storage_path text null,
  pdf_archived_at timestamptz null,
  pdf_archive_attempts integer not null default 0,
  pdf_archive_error text null,
  pdf_next_attempt_at timestamptz null,
  first_event_id text null,
  last_event_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_invoice_documents_provider_check check (provider in ('stripe')),
  constraint billing_invoice_documents_env_check check (environment in ('test', 'live')),
  constraint billing_invoice_documents_kind_check check (kind in ('invoice', 'credit_note')),
  constraint billing_invoice_documents_id_format check (
    (kind = 'invoice' and provider_document_id ~ '^in_[A-Za-z0-9_]{1,250}$')
    or (kind = 'credit_note' and provider_document_id ~ '^cn_[A-Za-z0-9_]{1,250}$')),
  constraint billing_invoice_documents_related_check check (
    related_invoice_id is null or (kind = 'credit_note' and related_invoice_id ~ '^in_[A-Za-z0-9_]{1,250}$')),
  constraint billing_invoice_documents_status_check check (
    status is null or status in ('draft', 'open', 'paid', 'uncollectible', 'void', 'issued')),
  constraint billing_invoice_documents_currency_check check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint billing_invoice_documents_country_check check (customer_country is null or customer_country ~ '^[A-Z]{2}$'),
  constraint billing_invoice_documents_issuer_check check (legal_issuer in ('stripe', 'esblu')),
  constraint billing_invoice_documents_sha_check check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),
  constraint billing_invoice_documents_archive_check check (
    (pdf_archived_at is null and pdf_sha256 is null and pdf_storage_path is null)
    or (pdf_archived_at is not null and pdf_sha256 is not null and pdf_storage_path is not null)),
  constraint billing_invoice_documents_error_check check (pdf_archive_error is null or pdf_archive_error ~ '^[A-Z0-9_]{1,80}$'),
  constraint billing_invoice_documents_url_check check (
    (hosted_url is null or hosted_url ~ '^https://[a-z0-9.-]*stripe\.com/') and (pdf_url is null or pdf_url ~ '^https://[a-z0-9.-]*stripe\.com/')),
  constraint billing_invoice_documents_json_size check (
    pg_column_size(customer_tax_ids) <= 2048 and pg_column_size(tax_details) <= 8192),
  -- Živá väzba (FK) a snapshot ukazujú na tú istú firmu; po ukončení firmy ostane iba snapshot.
  constraint billing_invoice_documents_customer_company_check check (
    company_id is null or company_id = customer_company_id),
  constraint billing_invoice_documents_snapshot_check check (
    (customer_snapshot_source is null or customer_snapshot_source in ('company', 'related_document', 'customer_document'))
    and (customer_snapshot_at is null) = (customer_snapshot_source is null)
    and (customer_address is null or (jsonb_typeof(customer_address) = 'object' and pg_column_size(customer_address) <= 2048))
    and (customer_billing_country is null or customer_billing_country ~ '^[A-Z]{2}$')
    and (customer_registration_country is null or customer_registration_country ~ '^[A-Z]{2}$')
    and coalesce(char_length(customer_legal_name), 0) <= 300 and coalesce(char_length(customer_ico), 0) <= 32
    and coalesce(char_length(customer_dic), 0) <= 32 and coalesce(char_length(customer_ic_dph), 0) <= 32
    and coalesce(char_length(customer_registration_id), 0) <= 32),
  constraint billing_invoice_documents_unique unique (provider, environment, provider_document_id)
);

-- Najviac jedna e-faktúra na doklad (ochrana pred duplicitným daňovým dokladom, variant A aj B).
create unique index if not exists billing_invoice_documents_einvoice_unique
  on public.billing_invoice_documents (einvoice_outbound_id) where einvoice_outbound_id is not null;
create index if not exists billing_invoice_documents_issued_idx on public.billing_invoice_documents (environment, issued_at);
create index if not exists billing_invoice_documents_pi_idx on public.billing_invoice_documents (environment, payment_intent_id) where payment_intent_id is not null;
create index if not exists billing_invoice_documents_related_idx on public.billing_invoice_documents (environment, related_invoice_id) where related_invoice_id is not null;
create index if not exists billing_invoice_documents_company_idx on public.billing_invoice_documents (company_id);
create index if not exists billing_invoice_documents_customer_company_idx on public.billing_invoice_documents (customer_company_id);
create index if not exists billing_invoice_documents_customer_idx
  on public.billing_invoice_documents (environment, provider_customer_id) where provider_customer_id is not null;
create index if not exists billing_invoice_documents_archive_due_idx
  on public.billing_invoice_documents (environment, pdf_next_attempt_at) where pdf_archived_at is null and pdf_url is not null;

comment on table public.billing_invoice_documents is
  'P4: účtovná kópia Stripe faktúr a dobropisov (sumy a daňové polia tak, ako ich poslal Stripe) + archív PDF. '
  'Service-only, DELETE/TRUNCATE zakázané triggerom (aj pre postgres). Po ukončení firmy company_id = null, '
  'identifikácia odberateľa ostáva v nemennom snapshote customer_* (customer_company_id bez FK). '
  'Retencia Esblu: PROPOSED 10 r. od konca roka dokladu (potvrdí účtovníčka); automatické mazanie neexistuje.';

-- Identita firmy pre snapshot (bez e-mailu, IBAN, owner_id). Tabuľky profilu môžu v minimálnych
-- testovacích baseline chýbať → to_regclass (statický SQL v nevykonanej vetve sa neplánuje).
create or replace function public.esblu_billing_customer_identity(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_out jsonb;
  v_profile jsonb := '{}'::jsonb;
  v_legal jsonb := '{}'::jsonb;
begin
  if p_company_id is null then
    return null;
  end if;
  select jsonb_build_object('company_name', c.name) into v_out from public.companies c where c.id = p_company_id;
  if v_out is null then
    return null;
  end if;
  if to_regclass('public.company_billing_profile') is not null then
    select coalesce(jsonb_strip_nulls(jsonb_build_object(
             'legal_name', nullif(btrim(b.legal_name), ''), 'ico', nullif(btrim(b.ico), ''), 'dic', nullif(btrim(b.dic), ''),
             'ic_dph', nullif(btrim(b.ic_dph), ''), 'country_code', b.country_code,
             'address', nullif(jsonb_strip_nulls(jsonb_build_object(
               'line1', nullif(btrim(b.address_line1), ''), 'line2', nullif(btrim(b.address_line2), ''),
               'city', nullif(btrim(b.city), ''), 'postal_code', nullif(btrim(b.postal_code), ''),
               'country_code', b.country_code)), '{}'::jsonb))), '{}'::jsonb)
      into v_profile
    from public.company_billing_profile b where b.company_id = p_company_id;
  end if;
  if to_regclass('public.company_legal_identities') is not null then
    select coalesce(jsonb_build_object('registration_country', l.country_code, 'registration_id', l.registration_id), '{}'::jsonb)
      into v_legal
    from public.company_legal_identities l where l.company_id = p_company_id;
  end if;
  return v_out || coalesce(v_profile, '{}'::jsonb) || coalesce(v_legal, '{}'::jsonb);
end
$function$;

-- Guard (INSERT aj UPDATE): archivované PDF je nemenné (SHA-256 aj cesta), identita dokladu nemenná,
-- e-faktúra po nastavení nemenná, snapshot odberateľa sa iba dopĺňa (null → hodnota), firma sa nedá
-- prehodiť na inú (iba X → null cez ON DELETE SET NULL, alebo null → customer_company_id).
create or replace function public.esblu_billing_documents_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id jsonb;
begin
  if tg_op = 'UPDATE' then
    if old.pdf_sha256 is not null and (new.pdf_sha256 is distinct from old.pdf_sha256
        or new.pdf_storage_path is distinct from old.pdf_storage_path
        or new.pdf_archived_at is distinct from old.pdf_archived_at) then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_ARCHIVE_IMMUTABLE';
    end if;
    if new.provider_document_id is distinct from old.provider_document_id or new.kind is distinct from old.kind
       or new.environment is distinct from old.environment then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_IDENTITY_IMMUTABLE';
    end if;
    if old.einvoice_outbound_id is not null and new.einvoice_outbound_id is distinct from old.einvoice_outbound_id then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_EINVOICE_IMMUTABLE';
    end if;
    if (old.customer_company_id is not null and new.customer_company_id is distinct from old.customer_company_id)
       or (old.customer_legal_name is not null and new.customer_legal_name is distinct from old.customer_legal_name)
       or (old.customer_ico is not null and new.customer_ico is distinct from old.customer_ico)
       or (old.customer_dic is not null and new.customer_dic is distinct from old.customer_dic)
       or (old.customer_ic_dph is not null and new.customer_ic_dph is distinct from old.customer_ic_dph)
       or (old.customer_registration_country is not null and new.customer_registration_country is distinct from old.customer_registration_country)
       or (old.customer_registration_id is not null and new.customer_registration_id is distinct from old.customer_registration_id)
       or (old.customer_address is not null and new.customer_address is distinct from old.customer_address)
       or (old.customer_billing_country is not null and new.customer_billing_country is distinct from old.customer_billing_country)
       or (old.customer_snapshot_at is not null and new.customer_snapshot_at is distinct from old.customer_snapshot_at)
       or (old.customer_snapshot_source is not null and new.customer_snapshot_source is distinct from old.customer_snapshot_source)
       or (old.provider_customer_id is not null and new.provider_customer_id is distinct from old.provider_customer_id)
       or (old.provider_subscription_id is not null and new.provider_subscription_id is distinct from old.provider_subscription_id) then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_SNAPSHOT_IMMUTABLE';
    end if;
    if old.company_id is not null and new.company_id is not null and new.company_id <> old.company_id then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_COMPANY_IMMUTABLE';
    end if;
  end if;

  -- Živá firma → snapshot (customer_company_id + doplnenie chýbajúcich identifikátorov).
  if new.company_id is not null then
    if new.customer_company_id is not null and new.customer_company_id <> new.company_id then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_COMPANY_IMMUTABLE';
    end if;
    new.customer_company_id := new.company_id;
    if new.customer_snapshot_at is null or new.customer_legal_name is null or new.customer_ico is null
       or new.customer_dic is null or new.customer_ic_dph is null or new.customer_address is null
       or new.customer_billing_country is null or new.customer_registration_id is null then
      v_id := public.esblu_billing_customer_identity(new.company_id);
      if v_id is not null then
        new.customer_legal_name := coalesce(new.customer_legal_name, v_id ->> 'legal_name', v_id ->> 'company_name');
        new.customer_ico := coalesce(new.customer_ico, v_id ->> 'ico');
        new.customer_dic := coalesce(new.customer_dic, v_id ->> 'dic');
        new.customer_ic_dph := coalesce(new.customer_ic_dph, v_id ->> 'ic_dph');
        new.customer_registration_country := coalesce(new.customer_registration_country, v_id ->> 'registration_country');
        new.customer_registration_id := coalesce(new.customer_registration_id, v_id ->> 'registration_id');
        new.customer_address := coalesce(new.customer_address, v_id -> 'address');
        new.customer_billing_country := coalesce(new.customer_billing_country, v_id ->> 'country_code', v_id ->> 'registration_country');
        new.customer_snapshot_at := coalesce(new.customer_snapshot_at, now());
        new.customer_snapshot_source := coalesce(new.customer_snapshot_source, 'company');
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end
$function$;

drop trigger if exists esblu_billing_documents_guard on public.billing_invoice_documents;
create trigger esblu_billing_documents_guard
  before insert or update on public.billing_invoice_documents
  for each row execute function public.esblu_billing_documents_guard();

-- Pred výmazom firmy (akákoľvek cesta: ukončenie s archívom, výnimka syntetických dát, owner delete,
-- priamy DELETE) sa doplní snapshot dokladov, kým sú údaje firmy ešte čitateľné. Nič nemaže ani neblokuje.
create or replace function public.esblu_billing_documents_company_freeze()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if to_regclass('public.billing_invoice_documents') is not null then
    update public.billing_invoice_documents d
       set company_id = d.company_id
     where d.company_id = old.id
       and (d.customer_snapshot_at is null or d.customer_legal_name is null or d.customer_ico is null
            or d.customer_dic is null or d.customer_ic_dph is null or d.customer_address is null);
  end if;
  return old;
end
$function$;

drop trigger if exists esblu_billing_documents_company_freeze on public.companies;
create trigger esblu_billing_documents_company_freeze
  before delete on public.companies
  for each row execute function public.esblu_billing_documents_company_freeze();

-- Účtovné záznamy Esblu sa nemažú (ani postgres, ani security definer funkcie ukončenia / zrušenia
-- účtu / purge). Vlastná retencia Esblu je samostatné, explicitne schválené rozhodnutie (PROPOSED 10 r.);
-- výmaz by vyžadoval novú migráciu so schválením — automatická cesta neexistuje.
create or replace function public.esblu_billing_accounting_record_retained()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_ACCOUNTING_RECORD_RETAINED',
    hint = 'Účtovná kópia Esblu (vlastná retencia Esblu, PROPOSED 10 r. — potvrdí účtovníčka); nemaže sa pri ukončení firmy, zrušení účtu ani retenčnej purge.';
end
$function$;

drop trigger if exists esblu_billing_documents_retained on public.billing_invoice_documents;
create trigger esblu_billing_documents_retained before delete on public.billing_invoice_documents
  for each row execute function public.esblu_billing_accounting_record_retained();
drop trigger if exists esblu_billing_documents_no_truncate on public.billing_invoice_documents;
create trigger esblu_billing_documents_no_truncate before truncate on public.billing_invoice_documents
  for each statement execute function public.esblu_billing_accounting_record_retained();

-- ----------------------------------------------------------------------------- 2) refundácie
create table if not exists public.billing_refund_observations (
  environment text not null,
  payment_intent_id text not null,
  amount_refunded_minor bigint not null,
  currency text null,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  constraint billing_refund_observations_pkey primary key (environment, payment_intent_id),
  constraint billing_refund_observations_env_check check (environment in ('test', 'live')),
  constraint billing_refund_observations_pi_check check (payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,250}$'),
  constraint billing_refund_observations_amount_check check (amount_refunded_minor > 0),
  constraint billing_refund_observations_currency_check check (currency is null or currency ~ '^[A-Z]{3}$')
);

-- ----------------------------------------------------------------------------- 3) balance transactions
create table if not exists public.billing_balance_transactions (
  environment text not null,
  bt_id text not null,
  type text not null,
  reporting_category text null,
  source_id text null,
  payment_intent_id text null,
  charge_id text null,
  amount_minor bigint not null,
  fee_minor bigint not null default 0,
  net_minor bigint not null,
  currency text not null,
  status text null,
  created_at timestamptz not null,
  available_on timestamptz null,
  payout_id text null,
  payout_arrival_date timestamptz null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_balance_transactions_pkey primary key (environment, bt_id),
  constraint billing_balance_transactions_env_check check (environment in ('test', 'live')),
  constraint billing_balance_transactions_id_check check (bt_id ~ '^txn_[A-Za-z0-9_]{1,250}$'),
  constraint billing_balance_transactions_type_check check (type ~ '^[a-z_]{1,60}$'
    and (reporting_category is null or reporting_category ~ '^[a-z_]{1,60}$')),
  constraint billing_balance_transactions_refs_check check (
    (source_id is null or source_id ~ '^[A-Za-z0-9_]{3,255}$')
    and (payment_intent_id is null or payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,250}$')
    and (charge_id is null or charge_id ~ '^(ch|py)_[A-Za-z0-9_]{1,250}$')
    and (payout_id is null or payout_id ~ '^po_[A-Za-z0-9_]{1,250}$')),
  constraint billing_balance_transactions_currency_check check (currency ~ '^[A-Z]{3}$')
);
create index if not exists billing_balance_transactions_created_idx on public.billing_balance_transactions (environment, created_at);
create index if not exists billing_balance_transactions_pi_idx on public.billing_balance_transactions (environment, payment_intent_id) where payment_intent_id is not null;

-- ----------------------------------------------------------------------------- 4) admini a audit exportu
create table if not exists public.billing_ops_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text null check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  created_by text not null default session_user
);
comment on table public.billing_ops_admins is
  'P4: prevádzkovatelia Esblu s prístupom k účtovnému exportu billing dokladov. Zápis IBA SQL (rola postgres), '
  'nie cez Data API. Overenie: esblu_billing_is_ops_admin() z JWT volajúceho.';

create table if not exists public.billing_accounting_export_log (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('test', 'live')),
  period_from timestamptz not null,
  period_to timestamptz not null,
  actor_user_id uuid null,
  row_count integer not null,
  created_at timestamptz not null default now()
);

-- Ochrana pred výmazom aj pre refundácie, ledger a audit exportu.
drop trigger if exists esblu_billing_refunds_retained on public.billing_refund_observations;
create trigger esblu_billing_refunds_retained before delete on public.billing_refund_observations
  for each row execute function public.esblu_billing_accounting_record_retained();
drop trigger if exists esblu_billing_refunds_no_truncate on public.billing_refund_observations;
create trigger esblu_billing_refunds_no_truncate before truncate on public.billing_refund_observations
  for each statement execute function public.esblu_billing_accounting_record_retained();
drop trigger if exists esblu_billing_ledger_retained on public.billing_balance_transactions;
create trigger esblu_billing_ledger_retained before delete on public.billing_balance_transactions
  for each row execute function public.esblu_billing_accounting_record_retained();
drop trigger if exists esblu_billing_ledger_no_truncate on public.billing_balance_transactions;
create trigger esblu_billing_ledger_no_truncate before truncate on public.billing_balance_transactions
  for each statement execute function public.esblu_billing_accounting_record_retained();
drop trigger if exists esblu_billing_export_log_retained on public.billing_accounting_export_log;
create trigger esblu_billing_export_log_retained before delete on public.billing_accounting_export_log
  for each row execute function public.esblu_billing_accounting_record_retained();
drop trigger if exists esblu_billing_export_log_no_truncate on public.billing_accounting_export_log;
create trigger esblu_billing_export_log_no_truncate before truncate on public.billing_accounting_export_log
  for each statement execute function public.esblu_billing_accounting_record_retained();

-- ----------------------------------------------------------------------------- 5) RLS + granty
alter table public.billing_invoice_documents enable row level security;
alter table public.billing_refund_observations enable row level security;
alter table public.billing_balance_transactions enable row level security;
alter table public.billing_ops_admins enable row level security;
alter table public.billing_accounting_export_log enable row level security;
revoke all on table public.billing_invoice_documents, public.billing_refund_observations, public.billing_balance_transactions,
  public.billing_ops_admins, public.billing_accounting_export_log from public, anon, authenticated, service_role;
grant select, insert, update on table public.billing_invoice_documents, public.billing_refund_observations,
  public.billing_balance_transactions to service_role;
grant select on table public.billing_ops_admins to service_role;
grant select, insert on table public.billing_accounting_export_log to service_role;

-- ----------------------------------------------------------------------------- 6) Storage (privátny)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('billing-documents', 'billing-documents', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------- 7) RPC
create or replace function public.esblu_billing_document_status_rank(p_kind text, p_status text)
returns integer
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_status is null then -1
    when p_kind = 'credit_note' then case p_status when 'issued' then 1 when 'void' then 2 else 0 end
    else case p_status when 'draft' then 0 when 'open' then 1 when 'paid' then 2 when 'uncollectible' then 2 when 'void' then 3 else 0 end
  end
$function$;

create or replace function public.esblu_billing_upsert_document(p_environment text, p_event_id text, p_doc jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_env text;
  v_kind text := p_doc ->> 'kind';
  v_id text := p_doc ->> 'provider_document_id';
  v_old public.billing_invoice_documents;
  v_company uuid;
  v_src public.billing_invoice_documents;
  v_src_kind text;
  v_forward boolean;
  v_row_id uuid;
begin
  select c.environment into v_env from public.billing_runtime_config c where c.id;
  if v_env is null or p_environment is distinct from v_env then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_ENVIRONMENT_MISMATCH';
  end if;
  if p_event_id is not null and (p_event_id !~ '^[A-Za-z0-9_.:=+/-]+$' or char_length(p_event_id) not between 3 and 256) then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_INVALID';
  end if;

  -- Firma: väzba predplatného, inak zákazníka (iba v rámci prostredia).
  select l.company_id into v_company from public.billing_provider_links l
  where l.provider = 'stripe' and l.environment = p_environment
    and ((l.link_kind = 'subscription' and l.external_id = p_doc ->> 'provider_subscription_id')
      or (l.link_kind = 'customer' and l.external_id = p_doc ->> 'provider_customer_id'))
  order by (l.link_kind = 'subscription') desc
  limit 1;
  if v_company is null and v_kind = 'credit_note' then
    select d.company_id into v_company from public.billing_invoice_documents d
    where d.provider = 'stripe' and d.environment = p_environment and d.provider_document_id = p_doc ->> 'related_invoice_id';
  end if;
  -- Firma už neexistuje (ukončená → väzby billing_provider_links zanikli): identifikačný snapshot sa
  -- prevezme z pôvodnej faktúry (dobropis) alebo z posledného dokladu toho istého Stripe zákazníka.
  -- Nikdy sa nespolieha na riadok s company_id = null.
  if v_company is null then
    select d.* into v_src from public.billing_invoice_documents d
    where d.provider = 'stripe' and d.environment = p_environment and d.customer_company_id is not null
      and ((v_kind = 'credit_note' and d.provider_document_id = p_doc ->> 'related_invoice_id')
        or (p_doc ->> 'provider_customer_id' is not null and d.provider_customer_id = p_doc ->> 'provider_customer_id'))
    order by (d.provider_document_id = coalesce(p_doc ->> 'related_invoice_id', '')) desc, d.created_at desc
    limit 1;
    if v_src.id is not null then
      v_src_kind := case when v_src.provider_document_id = p_doc ->> 'related_invoice_id' then 'related_document' else 'customer_document' end;
    end if;
  end if;

  select * into v_old from public.billing_invoice_documents d
  where d.provider = 'stripe' and d.environment = p_environment and d.provider_document_id = v_id
  for update;

  if not found then
    insert into public.billing_invoice_documents (
      environment, kind, provider_document_id, related_invoice_id, company_id, provider_customer_id,
      provider_subscription_id, payment_intent_id, document_number, status, currency, subtotal_minor,
      subtotal_excl_tax_minor, total_minor, total_excl_tax_minor, tax_minor, amount_paid_minor, customer_country,
      customer_tax_exempt, customer_tax_ids, tax_details, service_period_start, service_period_end, issued_at,
      paid_at, voided_at, hosted_url, pdf_url, credit_reason, credit_type, pdf_next_attempt_at, first_event_id, last_event_id,
      customer_company_id, customer_legal_name, customer_ico, customer_dic, customer_ic_dph, customer_registration_country,
      customer_registration_id, customer_address, customer_billing_country, customer_snapshot_at, customer_snapshot_source)
    values (
      p_environment, v_kind, v_id, p_doc ->> 'related_invoice_id', v_company, p_doc ->> 'provider_customer_id',
      p_doc ->> 'provider_subscription_id', p_doc ->> 'payment_intent_id', p_doc ->> 'document_number', p_doc ->> 'status',
      p_doc ->> 'currency', (p_doc ->> 'subtotal_minor')::bigint, (p_doc ->> 'subtotal_excl_tax_minor')::bigint,
      (p_doc ->> 'total_minor')::bigint, (p_doc ->> 'total_excl_tax_minor')::bigint, (p_doc ->> 'tax_minor')::bigint,
      (p_doc ->> 'amount_paid_minor')::bigint, p_doc ->> 'customer_country', p_doc ->> 'customer_tax_exempt',
      coalesce(p_doc -> 'customer_tax_ids', '[]'::jsonb), coalesce(p_doc -> 'tax_details', '[]'::jsonb),
      (p_doc ->> 'service_period_start')::timestamptz, (p_doc ->> 'service_period_end')::timestamptz,
      (p_doc ->> 'issued_at')::timestamptz, (p_doc ->> 'paid_at')::timestamptz, (p_doc ->> 'voided_at')::timestamptz,
      p_doc ->> 'hosted_url', p_doc ->> 'pdf_url', p_doc ->> 'credit_reason', p_doc ->> 'credit_type',
      case when p_doc ->> 'pdf_url' is not null then now() end, p_event_id, p_event_id,
      v_src.customer_company_id, v_src.customer_legal_name, v_src.customer_ico, v_src.customer_dic, v_src.customer_ic_dph,
      v_src.customer_registration_country, v_src.customer_registration_id, v_src.customer_address, v_src.customer_billing_country,
      case when v_src.id is not null then now() end, v_src_kind)
    on conflict (provider, environment, provider_document_id) do nothing
    returning id into v_row_id;
    if v_row_id is not null then
      return jsonb_build_object('result', 'inserted', 'id', v_row_id);
    end if;
    -- súbeh: riadok práve vznikol → pokračovať ako update
    select * into v_old from public.billing_invoice_documents d
    where d.provider = 'stripe' and d.environment = p_environment and d.provider_document_id = v_id
    for update;
  end if;

  if v_old.kind is distinct from v_kind then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_INVALID';
  end if;

  -- Stav iba dopredu; pri staršej udalosti sa iba doplnia chýbajúce hodnoty.
  v_forward := public.esblu_billing_document_status_rank(v_kind, p_doc ->> 'status')
               >= public.esblu_billing_document_status_rank(v_kind, v_old.status);

  update public.billing_invoice_documents d set
    status = case when v_forward then coalesce(p_doc ->> 'status', d.status) else d.status end,
    company_id = coalesce(d.company_id, v_company),
    related_invoice_id = coalesce(d.related_invoice_id, p_doc ->> 'related_invoice_id'),
    provider_customer_id = coalesce(d.provider_customer_id, p_doc ->> 'provider_customer_id'),
    provider_subscription_id = coalesce(d.provider_subscription_id, p_doc ->> 'provider_subscription_id'),
    payment_intent_id = coalesce(d.payment_intent_id, p_doc ->> 'payment_intent_id'),
    document_number = coalesce(d.document_number, p_doc ->> 'document_number'),
    currency = coalesce(d.currency, p_doc ->> 'currency'),
    subtotal_minor = case when v_forward then coalesce((p_doc ->> 'subtotal_minor')::bigint, d.subtotal_minor) else coalesce(d.subtotal_minor, (p_doc ->> 'subtotal_minor')::bigint) end,
    subtotal_excl_tax_minor = case when v_forward then coalesce((p_doc ->> 'subtotal_excl_tax_minor')::bigint, d.subtotal_excl_tax_minor) else coalesce(d.subtotal_excl_tax_minor, (p_doc ->> 'subtotal_excl_tax_minor')::bigint) end,
    total_minor = case when v_forward then coalesce((p_doc ->> 'total_minor')::bigint, d.total_minor) else coalesce(d.total_minor, (p_doc ->> 'total_minor')::bigint) end,
    total_excl_tax_minor = case when v_forward then coalesce((p_doc ->> 'total_excl_tax_minor')::bigint, d.total_excl_tax_minor) else coalesce(d.total_excl_tax_minor, (p_doc ->> 'total_excl_tax_minor')::bigint) end,
    tax_minor = case when v_forward then coalesce((p_doc ->> 'tax_minor')::bigint, d.tax_minor) else coalesce(d.tax_minor, (p_doc ->> 'tax_minor')::bigint) end,
    amount_paid_minor = case when v_forward then coalesce((p_doc ->> 'amount_paid_minor')::bigint, d.amount_paid_minor) else coalesce(d.amount_paid_minor, (p_doc ->> 'amount_paid_minor')::bigint) end,
    customer_country = coalesce(d.customer_country, p_doc ->> 'customer_country'),
    customer_tax_exempt = coalesce(d.customer_tax_exempt, p_doc ->> 'customer_tax_exempt'),
    customer_tax_ids = case when d.customer_tax_ids = '[]'::jsonb then coalesce(p_doc -> 'customer_tax_ids', '[]'::jsonb) else d.customer_tax_ids end,
    tax_details = case when v_forward and coalesce(p_doc -> 'tax_details', '[]'::jsonb) <> '[]'::jsonb then p_doc -> 'tax_details' else d.tax_details end,
    service_period_start = coalesce(d.service_period_start, (p_doc ->> 'service_period_start')::timestamptz),
    service_period_end = coalesce(d.service_period_end, (p_doc ->> 'service_period_end')::timestamptz),
    issued_at = coalesce(d.issued_at, (p_doc ->> 'issued_at')::timestamptz),
    paid_at = coalesce(d.paid_at, (p_doc ->> 'paid_at')::timestamptz),
    voided_at = coalesce(d.voided_at, (p_doc ->> 'voided_at')::timestamptz),
    hosted_url = coalesce(p_doc ->> 'hosted_url', d.hosted_url),
    pdf_url = coalesce(p_doc ->> 'pdf_url', d.pdf_url),
    pdf_next_attempt_at = case when d.pdf_archived_at is null and coalesce(p_doc ->> 'pdf_url', d.pdf_url) is not null
                               then coalesce(d.pdf_next_attempt_at, now()) else d.pdf_next_attempt_at end,
    credit_reason = coalesce(d.credit_reason, p_doc ->> 'credit_reason'),
    credit_type = coalesce(d.credit_type, p_doc ->> 'credit_type'),
    -- snapshot z iného dokladu iba ak riadok ešte nemá žiadnu identifikáciu (inak by sa miešali firmy)
    customer_company_id = case when d.customer_company_id is null then v_src.customer_company_id else d.customer_company_id end,
    customer_legal_name = case when d.customer_company_id is null then v_src.customer_legal_name else d.customer_legal_name end,
    customer_ico = case when d.customer_company_id is null then v_src.customer_ico else d.customer_ico end,
    customer_dic = case when d.customer_company_id is null then v_src.customer_dic else d.customer_dic end,
    customer_ic_dph = case when d.customer_company_id is null then v_src.customer_ic_dph else d.customer_ic_dph end,
    customer_registration_country = case when d.customer_company_id is null then v_src.customer_registration_country else d.customer_registration_country end,
    customer_registration_id = case when d.customer_company_id is null then v_src.customer_registration_id else d.customer_registration_id end,
    customer_address = case when d.customer_company_id is null then v_src.customer_address else d.customer_address end,
    customer_billing_country = case when d.customer_company_id is null then v_src.customer_billing_country else d.customer_billing_country end,
    customer_snapshot_at = case when d.customer_company_id is null and v_src.id is not null then now() else d.customer_snapshot_at end,
    customer_snapshot_source = case when d.customer_company_id is null and v_src.id is not null then v_src_kind else d.customer_snapshot_source end,
    first_event_id = coalesce(d.first_event_id, p_event_id),
    last_event_id = coalesce(p_event_id, d.last_event_id)
  where d.id = v_old.id;
  return jsonb_build_object('result', 'updated', 'id', v_old.id, 'forward', v_forward);
end
$function$;

create or replace function public.esblu_billing_record_refund_observation(
  p_environment text, p_payment_intent_id text, p_amount_refunded_minor bigint, p_currency text, p_observed_at timestamptz)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_env text;
begin
  select c.environment into v_env from public.billing_runtime_config c where c.id;
  if v_env is null or p_environment is distinct from v_env then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_ENVIRONMENT_MISMATCH';
  end if;
  insert into public.billing_refund_observations (environment, payment_intent_id, amount_refunded_minor, currency, first_observed_at, last_observed_at)
  values (p_environment, p_payment_intent_id, p_amount_refunded_minor, p_currency, coalesce(p_observed_at, now()), coalesce(p_observed_at, now()))
  on conflict (environment, payment_intent_id) do update set
    amount_refunded_minor = greatest(public.billing_refund_observations.amount_refunded_minor, excluded.amount_refunded_minor),
    currency = coalesce(public.billing_refund_observations.currency, excluded.currency),
    last_observed_at = greatest(public.billing_refund_observations.last_observed_at, excluded.last_observed_at);
end
$function$;

-- Refundácie bez (dostatočného) dobropisu: suma refundácie > súčet nevoidovaných dobropisov k faktúre.
create or replace function public.esblu_billing_refunds_without_credit_note(p_environment text, p_older_than interval)
returns table (payment_intent_id text, invoice_id text, refunded_minor bigint, credited_minor bigint, first_observed_at timestamptz)
language sql
stable
security definer
set search_path to ''
as $function$
  select q.payment_intent_id, q.invoice_id, q.refunded_minor, q.credited_minor, q.first_observed_at
  from (
    select r.payment_intent_id, i.provider_document_id as invoice_id, r.amount_refunded_minor as refunded_minor,
           coalesce((select sum(cn.total_minor) from public.billing_invoice_documents cn
                     where cn.environment = r.environment and cn.kind = 'credit_note'
                       and cn.related_invoice_id = i.provider_document_id and cn.status is distinct from 'void'), 0)::bigint as credited_minor,
           r.first_observed_at
    from public.billing_refund_observations r
    left join public.billing_invoice_documents i
      on i.environment = r.environment and i.kind = 'invoice' and i.payment_intent_id = r.payment_intent_id
    where r.environment = p_environment and r.first_observed_at < now() - p_older_than
  ) q
  where q.refunded_minor > q.credited_minor
$function$;

-- PDF archív: kandidáti s lease (súbežný beh ich nevezme dvakrát), backoff po chybe, max 10 pokusov.
create or replace function public.esblu_billing_document_archive_claim(p_environment text, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_out jsonb;
begin
  with due as (
    select d.id from public.billing_invoice_documents d
    where d.environment = p_environment and d.pdf_archived_at is null and d.pdf_url is not null
      and d.pdf_next_attempt_at <= now() and d.pdf_archive_attempts < 10
      and d.status in ('open', 'paid', 'uncollectible', 'void', 'issued')
    order by d.pdf_next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 20), 50))
    for update skip locked
  ), claimed as (
    update public.billing_invoice_documents d
    set pdf_next_attempt_at = now() + interval '15 minutes', pdf_archive_attempts = d.pdf_archive_attempts + 1
    from due where d.id = due.id
    returning d.id, d.environment, d.kind, d.provider_document_id, d.pdf_url, coalesce(d.issued_at, d.created_at) as issued_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'environment', c.environment, 'kind', c.kind,
    'provider_document_id', c.provider_document_id, 'pdf_url', c.pdf_url, 'issued_at', c.issued_at)), '[]'::jsonb)
  into v_out from claimed c;
  return v_out;
end
$function$;

create or replace function public.esblu_billing_document_archive_result(
  p_id uuid, p_ok boolean, p_sha256 text, p_storage_path text, p_error_code text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_ok then
    if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_storage_path is null
       or p_storage_path !~ '^(test|live)/[0-9]{4}/[0-9]{2}/(invoice|credit_note)/(in|cn)_[A-Za-z0-9_]+\.pdf$' then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_INVALID';
    end if;
    update public.billing_invoice_documents d
    set pdf_sha256 = p_sha256, pdf_storage_path = p_storage_path, pdf_archived_at = now(),
        pdf_archive_error = null, pdf_next_attempt_at = null
    where d.id = p_id and d.pdf_archived_at is null;
  else
    update public.billing_invoice_documents d
    set pdf_archive_error = case when p_error_code ~ '^[A-Z0-9_]{1,80}$' then p_error_code else 'ARCHIVE_FAILED' end,
        pdf_next_attempt_at = now() + least(interval '24 hours', interval '30 minutes' * power(2, least(d.pdf_archive_attempts, 8)))
    where d.id = p_id and d.pdf_archived_at is null;
  end if;
end
$function$;

create or replace function public.esblu_billing_upsert_balance_transactions(p_environment text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer;
begin
  if p_environment is null or p_environment not in ('test', 'live') or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) > 500 then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_LEDGER_INVALID';
  end if;
  insert into public.billing_balance_transactions as b (
    environment, bt_id, type, reporting_category, source_id, payment_intent_id, charge_id, amount_minor, fee_minor,
    net_minor, currency, status, created_at, available_on, payout_id, payout_arrival_date)
  select p_environment, r ->> 'bt_id', r ->> 'type', r ->> 'reporting_category', r ->> 'source_id', r ->> 'payment_intent_id',
         r ->> 'charge_id', (r ->> 'amount_minor')::bigint, coalesce((r ->> 'fee_minor')::bigint, 0), (r ->> 'net_minor')::bigint,
         r ->> 'currency', r ->> 'status', (r ->> 'created_at')::timestamptz, (r ->> 'available_on')::timestamptz,
         r ->> 'payout_id', (r ->> 'payout_arrival_date')::timestamptz
  from jsonb_array_elements(p_rows) r
  on conflict (environment, bt_id) do update set
    type = excluded.type,
    reporting_category = coalesce(excluded.reporting_category, b.reporting_category),
    source_id = coalesce(excluded.source_id, b.source_id),
    payment_intent_id = coalesce(excluded.payment_intent_id, b.payment_intent_id),
    charge_id = coalesce(excluded.charge_id, b.charge_id),
    amount_minor = excluded.amount_minor, fee_minor = excluded.fee_minor, net_minor = excluded.net_minor,
    currency = excluded.currency, status = coalesce(excluded.status, b.status),
    available_on = coalesce(excluded.available_on, b.available_on),
    payout_id = coalesce(excluded.payout_id, b.payout_id),
    payout_arrival_date = coalesce(excluded.payout_arrival_date, b.payout_arrival_date),
    updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

-- Mesačný export: (1) doklady vystavené v období s väzbou na platbu (hrubá suma / poplatok / čistá suma /
-- výplata podľa PaymentIntent), (2) VŠETKY balance transactions obdobia (poplatky, refundácie, spory,
-- výplaty, úpravy) s väzbou na číslo dokladu, ak existuje. Čísla, ID Stripe, daňové polia dokladu a
-- identifikácia odberateľa (firmy) zo snapshotu dokladu.
create or replace function public.esblu_billing_accounting_export(p_environment text, p_from timestamptz, p_to timestamptz, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_rows jsonb;
begin
  if p_environment is null or p_environment not in ('test', 'live') or p_from is null or p_to is null
     or p_to <= p_from or p_to - p_from > interval '93 days' then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_EXPORT_INVALID';
  end if;
  select coalesce(jsonb_agg(x.row order by x.sort_at, x.sort_kind, x.sort_id), '[]'::jsonb) into v_rows from (
    select d.issued_at as sort_at, 0 as sort_kind, d.provider_document_id as sort_id,
      jsonb_build_object(
        'record_type', d.kind, 'document_date', d.issued_at, 'document_number', d.document_number,
        'stripe_document_id', d.provider_document_id, 'related_invoice_id', d.related_invoice_id,
        'related_invoice_number', ri2.document_number,
        'status', d.status, 'legal_issuer', d.legal_issuer, 'currency', d.currency,
        'total_excl_tax_minor', d.total_excl_tax_minor, 'tax_minor', d.tax_minor, 'total_minor', d.total_minor,
        'customer_country', d.customer_country, 'customer_tax_ids', d.customer_tax_ids, 'customer_tax_exempt', d.customer_tax_exempt,
        'tax_details', d.tax_details, 'service_period_start', d.service_period_start, 'service_period_end', d.service_period_end,
        'paid_at', d.paid_at, 'payment_intent_id', coalesce(d.payment_intent_id, ri2.payment_intent_id),
        'gross_minor', bt.gross, 'fee_minor', bt.fee, 'net_minor', bt.net, 'bt_ids', bt.ids, 'payout_ids', bt.payouts,
        'pdf_archived', d.pdf_archived_at is not null, 'pdf_sha256', d.pdf_sha256, 'pdf_storage_path', d.pdf_storage_path,
        -- identifikácia odberateľa zo snapshotu (platí aj po ukončení firmy, keď company_id = null)
        'customer_company_id', d.customer_company_id, 'customer_legal_name', d.customer_legal_name,
        'customer_ico', d.customer_ico, 'customer_dic', d.customer_dic, 'customer_ic_dph', d.customer_ic_dph,
        'customer_registration_id', d.customer_registration_id, 'customer_address', d.customer_address,
        'customer_billing_country', d.customer_billing_country, 'company_linked', d.company_id is not null,
        'provider_customer_id', d.provider_customer_id, 'provider_subscription_id', d.provider_subscription_id) as row
    from public.billing_invoice_documents d
    left join public.billing_invoice_documents ri2
      on d.kind = 'credit_note' and ri2.environment = d.environment and ri2.provider_document_id = d.related_invoice_id
    left join lateral (
      select sum(b.amount_minor) as gross, sum(b.fee_minor) as fee, sum(b.net_minor) as net,
             string_agg(b.bt_id, ' ' order by b.created_at) as ids,
             string_agg(distinct b.payout_id, ' ') as payouts
      from public.billing_balance_transactions b
      where b.environment = d.environment and b.payment_intent_id = coalesce(d.payment_intent_id, ri2.payment_intent_id)
        and ((d.kind = 'invoice' and b.type in ('charge', 'payment'))
          or (d.kind = 'credit_note' and b.type in ('refund', 'payment_refund')))
    ) bt on true
    where d.environment = p_environment and d.issued_at >= p_from and d.issued_at < p_to
      and d.status is distinct from 'draft'
    union all
    select b.created_at, 1, b.bt_id,
      jsonb_build_object(
        'record_type', 'balance_transaction', 'document_date', b.created_at, 'bt_ids', b.bt_id, 'bt_type', b.type,
        'reporting_category', b.reporting_category, 'currency', b.currency, 'gross_minor', b.amount_minor,
        'fee_minor', b.fee_minor, 'net_minor', b.net_minor, 'payment_intent_id', b.payment_intent_id,
        'source_id', b.source_id, 'payout_ids', b.payout_id, 'payout_arrival_date', b.payout_arrival_date,
        'available_on', b.available_on,
        'document_number', (select string_agg(dd.document_number, ' ' order by dd.issued_at) from public.billing_invoice_documents dd
                            where dd.environment = b.environment and dd.kind = 'invoice' and dd.payment_intent_id = b.payment_intent_id))
    from public.billing_balance_transactions b
    where b.environment = p_environment and b.created_at >= p_from and b.created_at < p_to
  ) x;
  insert into public.billing_accounting_export_log (environment, period_from, period_to, actor_user_id, row_count)
  values (p_environment, p_from, p_to, p_actor, jsonb_array_length(v_rows));
  return v_rows;
end
$function$;

-- Admin overenie z JWT volajúceho (route ho volá user-scoped klientom; tabuľku klient nevidí).
create or replace function public.esblu_billing_is_ops_admin()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select auth.uid() is not null and exists (select 1 from public.billing_ops_admins a where a.user_id = auth.uid())
$function$;

revoke all on function public.esblu_billing_documents_guard() from public, anon, authenticated, service_role;
revoke all on function public.esblu_billing_customer_identity(uuid) from public, anon, authenticated, service_role;
revoke all on function public.esblu_billing_documents_company_freeze() from public, anon, authenticated, service_role;
revoke all on function public.esblu_billing_accounting_record_retained() from public, anon, authenticated, service_role;
revoke all on function public.esblu_billing_document_status_rank(text, text) from public, anon, authenticated;
revoke all on function public.esblu_billing_upsert_document(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.esblu_billing_record_refund_observation(text, text, bigint, text, timestamptz) from public, anon, authenticated;
revoke all on function public.esblu_billing_refunds_without_credit_note(text, interval) from public, anon, authenticated;
revoke all on function public.esblu_billing_document_archive_claim(text, integer) from public, anon, authenticated;
revoke all on function public.esblu_billing_document_archive_result(uuid, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.esblu_billing_upsert_balance_transactions(text, jsonb) from public, anon, authenticated;
revoke all on function public.esblu_billing_accounting_export(text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.esblu_billing_is_ops_admin() from public, anon;
grant execute on function public.esblu_billing_upsert_document(text, text, jsonb) to service_role;
grant execute on function public.esblu_billing_record_refund_observation(text, text, bigint, text, timestamptz) to service_role;
grant execute on function public.esblu_billing_refunds_without_credit_note(text, interval) to service_role;
grant execute on function public.esblu_billing_document_archive_claim(text, integer) to service_role;
grant execute on function public.esblu_billing_document_archive_result(uuid, boolean, text, text, text) to service_role;
grant execute on function public.esblu_billing_upsert_balance_transactions(text, jsonb) to service_role;
grant execute on function public.esblu_billing_accounting_export(text, timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.esblu_billing_is_ops_admin() to authenticated, service_role;
