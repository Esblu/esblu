-- =============================================================================
-- UNIFIED SUBSCRIPTIONS / BILLING — kanonická serverová vrstva predplatného.
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. STAGING / LOKÁLNE (PGlite) ONLY.
--   - NIKDY neaplikovať na produkciu fkpgvgvsmbpieduoatrt bez výslovného
--     súhlasu majiteľa a bez CLIA posúdenia (docs/subscriptions-gdpr-provider-delta).
--   - Overené: scripts/subscriptions-pglite-tests.ts (baseline + 20260928100000
--     + 20260929100000 + táto migrácia, 2× pre idempotenciu).
--   - Rollback: supabase/rollback/20261008120000_subscriptions_platform_rollback.sql
--
-- PRINCÍP: "ONE ESBLU SUBSCRIPTION. BUY ANYWHERE. USE EVERYWHERE."
--   1. Zdroj pravdy o oprávneniach = company_entitlements (existujúci resolver
--      esblu_resolve_entitlement). Táto migrácia NEVYTVÁRA paralelný systém:
--      predplatné iba zapisuje/odvoláva riadky source='subscription'.
--   2. Stripe / Apple / Google NIE SÚ zdroj pravdy. Provider event sa
--      (1) overí (server), (2) deduplikuje, (3) uloží, (4) normalizuje (server),
--      (5) zmení subscription_accounts, (6) až potom prepočíta nároky.
--   3. Jedna firma = jeden subscription_accounts riadok (unique company_id).
--      Druhý aktívny provider pre tú istú firmu = 'conflict' (operátor), nie
--      prepis.
--   4. Firma sa NIKDY neberie z payloadu providera: iba z našej
--      billing_checkout_sessions (vytvorenej serverom) alebo
--      billing_provider_links. Plán sa NIKDY neberie z prehliadača ani z
--      providera: provider price → billing_provider_prices → plan_code.
--   5. Browser nikdy nerozhoduje o nárokoch. authenticated nemá zápis do
--      žiadnej billing tabuľky; čítanie iba cez RPC s rolovou bránou.
--   6. Zmena predplatného mení IBA prístup — nikdy nemaže business dáta.
--   7. Žiadne kartové / platobné údaje: billing_events drží iba sha256 tela
--      a minimalizovaný súhrn (identifikátory, stavy, obdobie).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Predpoklady (fail fast, ak chýba entitlement vrstva 20260928100000).
-- -----------------------------------------------------------------------------
do $pre$
begin
  if to_regclass('public.company_entitlements') is null
    or to_regclass('public.entitlement_catalog') is null
    or to_regprocedure('public.esblu_resolve_entitlement(uuid, text)') is null
  then
    raise exception 'subscriptions_platform vyžaduje 20260928100000_company_entitlements_trial';
  end if;
end
$pre$;

-- -----------------------------------------------------------------------------
-- 1) Katalóg plánov (dáta). Ceny tu NIE SÚ — cena žije u providera a v
--    lib/pricing.ts (provizórne). status='test_fixture' = iba staging/test.
-- -----------------------------------------------------------------------------
create table if not exists public.subscription_plans (
  plan_code text primary key,
  status text not null default 'draft',
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_plans_code_format check (plan_code ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint subscription_plans_status_check check (status in ('draft', 'test_fixture', 'approved', 'retired'))
);

comment on table public.subscription_plans is
  'Katalóg plánov predplatného (balík nárokov). approved = obchodne schválený; '
  'test_fixture = iba staging/test; retired = nedá sa kúpiť, existujúce predplatné dobehne.';

create table if not exists public.subscription_plan_entitlements (
  plan_code text not null references public.subscription_plans (plan_code) on delete cascade,
  entitlement_key text not null references public.entitlement_catalog (key),
  limit_value integer null,
  limit_period text null,
  primary key (plan_code, entitlement_key),
  constraint subscription_plan_entitlements_limit_check check (limit_value is null or limit_value >= 0),
  constraint subscription_plan_entitlements_period_check check (limit_period is null or limit_period in ('month', 'total'))
);

comment on table public.subscription_plan_entitlements is
  'Plán → nároky (entitlement_catalog). Jediný zdroj pre prepočet company_entitlements source=subscription.';

-- Server-side mapovanie plán + interval → provider price/product.
-- Prehliadač nikdy neposiela price ID; webhook price ID sa mapuje späť cez túto tabuľku.
create table if not exists public.billing_provider_prices (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  environment text not null,
  plan_code text not null references public.subscription_plans (plan_code),
  billing_interval text not null,
  provider_price_id text not null,
  provider_product_id text null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint billing_provider_prices_provider_check check (provider in ('stripe', 'apple', 'google', 'fake')),
  constraint billing_provider_prices_env_check check (environment in ('test', 'live')),
  constraint billing_provider_prices_interval_check check (billing_interval in ('month', 'year')),
  constraint billing_provider_prices_price_format check (provider_price_id ~ '^[A-Za-z0-9_.:-]{3,200}$'),
  constraint billing_provider_prices_unique_price unique (provider, environment, provider_price_id)
);

create unique index if not exists billing_provider_prices_one_active_idx
  on public.billing_provider_prices (provider, environment, plan_code, billing_interval)
  where active;


-- Runtime kill-switch + prostredie (jediný riadok). Klient NIKDY neurčuje
-- providera ani prostredie. Default 'none' = billing vypnutý.
-- LIVE je touto migráciou ZAKÁZANÝ (check) — live vyžaduje novú migráciu
-- a výslovný súhlas majiteľa.
create table if not exists public.billing_runtime_config (
  id boolean primary key default true,
  web_provider text not null default 'none',
  environment text not null default 'test',
  updated_at timestamptz not null default now(),
  constraint billing_runtime_config_singleton check (id),
  constraint billing_runtime_config_provider_check check (web_provider in ('none', 'fake', 'stripe')),
  constraint billing_runtime_config_env_check check (environment = 'test')
);

insert into public.billing_runtime_config (id) values (true) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 2) Kanonický stav predplatného — JEDEN riadok na firmu.
-- -----------------------------------------------------------------------------
create table if not exists public.subscription_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  plan_code text null references public.subscription_plans (plan_code),
  billing_interval text null,
  status text not null default 'none',
  billing_provider text null,
  provider_environment text null,
  provider_customer_id text null,
  provider_subscription_id text null,
  current_period_start timestamptz null,
  current_period_end timestamptz null,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz null,
  ended_at timestamptz null,
  provider_trial_start timestamptz null,
  provider_trial_end timestamptz null,
  grace_until timestamptz null,
  -- Kanál, ktorým predplatné vzniklo (iba informácia + povinnosť reportingu
  -- obchodu). NEMÁ vplyv na nároky — tie sú pre všetky kanály rovnaké.
  purchase_method text null,
  purchase_platform text null,
  store_reporting text not null default 'none',
  store_token text null,
  -- Ochrana poradia: čas providera (event.created / signedDate / eventTimeMillis)
  -- posledného APLIKOVANÉHO stavu. Starší event stav nikdy nevráti späť.
  provider_state_at timestamptz null,
  last_event_id uuid null,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_accounts_company_unique unique (company_id),
  constraint subscription_accounts_status_check check (status in (
    'none', 'incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'expired')),
  constraint subscription_accounts_interval_check check (billing_interval is null or billing_interval in ('month', 'year')),
  constraint subscription_accounts_provider_check check (billing_provider is null or billing_provider in ('stripe', 'apple', 'google', 'manual', 'fake')),
  constraint subscription_accounts_env_check check (provider_environment is null or provider_environment in ('test', 'live')),
  constraint subscription_accounts_period_check check (
    current_period_end is null or current_period_start is null or current_period_end > current_period_start),
  constraint subscription_accounts_reporting_check check (store_reporting in ('none', 'google_external_transaction', 'apple_external_purchase')),
  constraint subscription_accounts_paid_has_plan check (status in ('none', 'canceled', 'expired') or plan_code is not null)
);

comment on table public.subscription_accounts is
  'Kanonický (provider-neutrálny) stav predplatného firmy. Zapisuje IBA esblu_billing_apply_event '
  '(service_role). Nároky z neho odvodzuje esblu_billing_sync_entitlements do company_entitlements.';

create table if not exists public.billing_provider_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null,
  environment text not null,
  link_kind text not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  constraint billing_provider_links_provider_check check (provider in ('stripe', 'apple', 'google', 'fake')),
  constraint billing_provider_links_env_check check (environment in ('test', 'live')),
  -- customer = Stripe customer; subscription = Stripe sub / Apple originalTransactionId /
  -- Google purchaseToken (linkedPurchaseToken reťaz); account_token = Apple appAccountToken /
  -- Google obfuscatedExternalAccountId (nereverzibilný identifikátor firmy).
  constraint billing_provider_links_kind_check check (link_kind in ('customer', 'subscription', 'account_token')),
  constraint billing_provider_links_external_format check (external_id ~ '^[A-Za-z0-9_.:=+/-]+$' and char_length(external_id) between 3 and 2048),
  -- Jeden externý identifikátor patrí najviac jednej firme (Company A ≠ Company B).
  constraint billing_provider_links_unique_external unique (provider, environment, link_kind, external_id)
);

create index if not exists billing_provider_links_company_idx on public.billing_provider_links (company_id);

-- Checkout zámer vytvorený SERVEROM (po rolovej kontrole). Webhook nájde firmu
-- iba cez tento riadok (client_reference_id = id), nie cez metadata providera.
create table if not exists public.billing_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  created_by uuid not null,
  provider text not null,
  environment text not null,
  plan_code text not null references public.subscription_plans (plan_code),
  billing_interval text not null,
  provider_price_id text not null,
  provider_session_id text null,
  status text not null default 'created',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  completed_at timestamptz null,
  -- Mobilný nákup: odkiaľ a akým kanálom (sekcia 9). store_token = Apple
  -- ExternalPurchaseCustomLink token / Google externalTransactionToken.
  platform text not null default 'web',
  purchase_method text not null default 'stripe_web_checkout',
  storefront_country text null,
  store_token text null,
  store_reporting text not null default 'none',
  constraint billing_checkout_sessions_platform_check check (platform in ('web', 'android', 'ios')),
  constraint billing_checkout_sessions_storefront_check check (storefront_country is null or storefront_country ~ '^[A-Z]{2}$'),
  constraint billing_checkout_sessions_reporting_check check (store_reporting in ('none', 'google_external_transaction', 'apple_external_purchase')),
  constraint billing_checkout_sessions_provider_check check (provider in ('stripe', 'apple', 'google', 'fake')),
  constraint billing_checkout_sessions_env_check check (environment in ('test', 'live')),
  constraint billing_checkout_sessions_interval_check check (billing_interval in ('month', 'year')),
  constraint billing_checkout_sessions_status_check check (status in ('created', 'open', 'completed', 'expired', 'rejected')),
  constraint billing_checkout_sessions_provider_session_unique unique (provider, environment, provider_session_id)
);

create index if not exists billing_checkout_sessions_company_idx on public.billing_checkout_sessions (company_id, created_at desc);

-- Audit + idempotencia provider eventov. ŽIADNY raw payload / kartové údaje.
create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  environment text not null,
  provider_event_id text not null,
  event_type text not null,
  company_id uuid null references public.companies (id) on delete set null,
  provider_created_at timestamptz null,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  status text not null default 'received',
  attempts integer not null default 1,
  error_code text null,
  payload_sha256 text null,
  summary jsonb not null default '{}'::jsonb,
  constraint billing_events_provider_check check (provider in ('stripe', 'apple', 'google', 'fake')),
  constraint billing_events_env_check check (environment in ('test', 'live')),
  constraint billing_events_status_check check (status in ('received', 'processed', 'ignored', 'stale', 'conflict', 'failed')),
  constraint billing_events_event_id_format check (provider_event_id ~ '^[A-Za-z0-9_.:=+/-]+$' and char_length(provider_event_id) between 3 and 256),
  constraint billing_events_type_format check (event_type ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  constraint billing_events_sha_format check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint billing_events_error_format check (error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$'),
  constraint billing_events_summary_size check (pg_column_size(summary) <= 4096),
  constraint billing_events_unique_event unique (provider, environment, provider_event_id)
);

create index if not exists billing_events_company_idx on public.billing_events (company_id, received_at desc);

-- Prepočet nárokov z predplatného: najviac jeden riadok source='subscription'
-- na (firma, nárok). Čiastočný index — manual/beta_compat granty sa nemenia.
create unique index if not exists company_entitlements_subscription_unique_idx
  on public.company_entitlements (company_id, entitlement_key)
  where source = 'subscription';

-- -----------------------------------------------------------------------------
-- 3) RLS + granty: authenticated/anon NIČ priamo. service_role cez bypassrls.
-- -----------------------------------------------------------------------------
alter table public.billing_runtime_config enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.subscription_plan_entitlements enable row level security;
alter table public.billing_provider_prices enable row level security;
alter table public.subscription_accounts enable row level security;
alter table public.billing_provider_links enable row level security;
alter table public.billing_checkout_sessions enable row level security;
alter table public.billing_events enable row level security;

revoke all on table
  public.billing_runtime_config,
  public.subscription_plans,
  public.subscription_plan_entitlements,
  public.billing_provider_prices,
  public.subscription_accounts,
  public.billing_provider_links,
  public.billing_checkout_sessions,
  public.billing_events
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.billing_runtime_config,
  public.subscription_plans,
  public.subscription_plan_entitlements,
  public.billing_provider_prices,
  public.subscription_accounts,
  public.billing_provider_links,
  public.billing_checkout_sessions,
  public.billing_events
to service_role;

-- -----------------------------------------------------------------------------
-- 4) Rolová brána predplatného.
--    MANAGE (kúpa, zmena, zrušenie, portál): owner; alebo admin s výslovným
--      permissions.billing.manage = true. Accountant ani employee NIKDY
--      (accountant je externý — finance.manage pre faktúry ≠ platiť za Esblu).
--    VIEW detailov (obdobie, provider, stav platby): MANAGE alebo
--      esblu_my_finance_view() (owner/accountant/finance.view podľa prod).
--    Employee vidí iba nároky cez existujúce esblu_get_my_company_entitlements.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_billing_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_member record;
  v_manage boolean;
  v_view boolean;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select cm.company_id, cm.role, cm.permissions into v_member
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  v_manage := v_member.role = 'owner'
    or (v_member.role = 'admin'
        and coalesce((v_member.permissions -> 'billing' ->> 'manage')::boolean, false));
  v_view := v_manage or coalesce(public.esblu_my_finance_view(), false);

  return jsonb_build_object('company_id', v_member.company_id, 'role', v_member.role,
                            'can_manage', v_manage, 'can_view', v_view);
end
$function$;

revoke all on function public.esblu_billing_my_access() from public, anon;
grant execute on function public.esblu_billing_my_access() to authenticated, service_role;

-- Stav predplatného pre UI (web/Android/iOS — rovnaká odpoveď, bez platformy).
create or replace function public.esblu_get_my_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_company_id uuid := (v_access ->> 'company_id')::uuid;
  v_acc record;
  v_company record;
  v_plan_items jsonb;
  v_result jsonb;
begin
  select * into v_acc from public.subscription_accounts a where a.company_id = v_company_id;
  select c.trial_started_at, c.trial_ends_at into v_company from public.companies c where c.id = v_company_id;

  select coalesce(jsonb_agg(jsonb_build_object('key', pe.entitlement_key, 'limit', pe.limit_value,
                                               'limit_period', pe.limit_period)
                            order by k.sort_order), '[]'::jsonb)
  into v_plan_items
  from public.subscription_plan_entitlements pe
  join public.entitlement_catalog k on k.key = pe.entitlement_key
  where pe.plan_code = v_acc.plan_code;

  v_result := jsonb_build_object(
    'server_time', now(),
    'can_manage', (v_access ->> 'can_manage')::boolean,
    'can_view_details', (v_access ->> 'can_view')::boolean,
    'plan_code', v_acc.plan_code,
    'status', coalesce(v_acc.status, 'none'),
    'cancel_at_period_end', coalesce(v_acc.cancel_at_period_end, false),
    'plan_entitlements', coalesce(v_plan_items, '[]'::jsonb),
    'trial', jsonb_build_object(
      'ends_at', v_company.trial_ends_at,
      'active', coalesce(now() >= v_company.trial_started_at and now() < v_company.trial_ends_at, false))
  );

  if (v_access ->> 'can_view')::boolean then
    v_result := v_result || jsonb_build_object(
      'billing_interval', v_acc.billing_interval,
      'billing_provider', v_acc.billing_provider,
      'current_period_start', v_acc.current_period_start,
      'current_period_end', v_acc.current_period_end,
      'grace_until', v_acc.grace_until,
      'canceled_at', v_acc.canceled_at,
      'version', coalesce(v_acc.version, 0)
    );
  end if;

  return v_result;
end
$function$;

revoke all on function public.esblu_get_my_subscription() from public, anon;
grant execute on function public.esblu_get_my_subscription() to authenticated, service_role;

-- Stav konkrétneho checkout zámeru (návrat z checkoutu). Iba vlastná firma +
-- MANAGE/VIEW. Query parameter "success" nie je dôkaz — UI čaká na 'completed'.
create or replace function public.esblu_get_my_checkout_status(p_checkout_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_row record;
begin
  if not (v_access ->> 'can_view')::boolean then
    raise exception using errcode = '42501', message = 'ESBLU_BILLING_FORBIDDEN';
  end if;

  select s.id, s.status, s.plan_code, s.billing_interval, s.completed_at into v_row
  from public.billing_checkout_sessions s
  where s.id = p_checkout_id and s.company_id = (v_access ->> 'company_id')::uuid;

  if not found then
    -- Cudzí aj neexistujúci → rovnaká odpoveď (žiadny oracle).
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object('found', true, 'status', v_row.status, 'plan_code', v_row.plan_code,
                            'billing_interval', v_row.billing_interval, 'completed_at', v_row.completed_at);
end
$function$;

revoke all on function public.esblu_get_my_checkout_status(uuid) from public, anon;
grant execute on function public.esblu_get_my_checkout_status(uuid) to authenticated, service_role;

-- Verejne kúpiteľné plány pre dané prostredie (bez price ID — tie nikdy do prehliadača).
create or replace function public.esblu_billing_list_plans()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'web_provider', cfg.web_provider,
    'environment', cfg.environment,
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'plan_code', p.plan_code,
               'status', p.status,
               'intervals', (select coalesce(jsonb_agg(distinct bp.billing_interval), '[]'::jsonb)
                             from public.billing_provider_prices bp
                             where bp.plan_code = p.plan_code and bp.provider = cfg.web_provider
                               and bp.environment = cfg.environment and bp.active),
               'entitlements', (select coalesce(jsonb_agg(jsonb_build_object('key', pe.entitlement_key,
                                        'limit', pe.limit_value, 'limit_period', pe.limit_period)
                                        order by pe.entitlement_key), '[]'::jsonb)
                                from public.subscription_plan_entitlements pe where pe.plan_code = p.plan_code))
             order by p.sort_order)
      from public.subscription_plans p
      where p.status = 'approved' or (p.status = 'test_fixture' and cfg.environment = 'test')), '[]'::jsonb))
  from public.billing_runtime_config cfg
  where cfg.id
$function$;

revoke all on function public.esblu_billing_list_plans() from public, anon;
grant execute on function public.esblu_billing_list_plans() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5) Checkout zámer: volá PRIHLÁSENÝ používateľ (user-scoped JWT). Rola, firma,
--    plán aj price ID sa určujú TU — klient posiela iba plan_code + interval.
-- -----------------------------------------------------------------------------
-- Web checkout = jednotný nákupný zámer s platformou 'web' (sekcia 9).
create or replace function public.esblu_billing_create_checkout_intent(p_plan_code text, p_interval text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  return public.esblu_billing_create_purchase_intent(p_plan_code, p_interval, 'web', 'stripe_web_checkout', null, 'new', null);
end
$function$;

revoke all on function public.esblu_billing_create_checkout_intent(text, text) from public, anon;
grant execute on function public.esblu_billing_create_checkout_intent(text, text) to authenticated, service_role;

-- Server (service_role) priradí provider session ID k zámeru.
create or replace function public.esblu_billing_attach_checkout_session(
  p_checkout_id uuid, p_provider_session_id text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.billing_checkout_sessions
  set provider_session_id = p_provider_session_id, status = 'open'
  where id = p_checkout_id and status = 'created' and provider_session_id is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_CHECKOUT_STATE';
  end if;
end
$function$;

revoke all on function public.esblu_billing_attach_checkout_session(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_attach_checkout_session(uuid, text) to service_role;

-- Pre správu existujúceho predplatného (cancel/resume/portal/change):
-- rolová brána + provider identifikátory pre server. Volá prihlásený
-- používateľ; identifikátory sa vrátia iba MANAGE roli.
create or replace function public.esblu_billing_authorize_manage()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_acc record;
begin
  if not (v_access ->> 'can_manage')::boolean then
    raise exception using errcode = '42501', message = 'ESBLU_BILLING_FORBIDDEN';
  end if;
  select * into v_acc from public.subscription_accounts a where a.company_id = (v_access ->> 'company_id')::uuid;
  return jsonb_build_object(
    'company_id', v_access ->> 'company_id',
    'status', coalesce(v_acc.status, 'none'),
    'plan_code', v_acc.plan_code,
    'billing_interval', v_acc.billing_interval,
    'billing_provider', v_acc.billing_provider,
    'provider_environment', v_acc.provider_environment,
    'provider_customer_id', v_acc.provider_customer_id,
    'provider_subscription_id', v_acc.provider_subscription_id,
    'cancel_at_period_end', coalesce(v_acc.cancel_at_period_end, false));
end
$function$;

revoke all on function public.esblu_billing_authorize_manage() from public, anon;
grant execute on function public.esblu_billing_authorize_manage() to authenticated, service_role;

-- Server mapuje požadovaný plán na price ID pre zmenu plánu (upgrade/downgrade).
create or replace function public.esblu_billing_resolve_price(
  p_provider text, p_environment text, p_plan_code text, p_interval text
)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select bp.provider_price_id
  from public.billing_provider_prices bp
  join public.subscription_plans p on p.plan_code = bp.plan_code
  where bp.provider = p_provider and bp.environment = p_environment
    and bp.plan_code = p_plan_code and bp.billing_interval = p_interval and bp.active
    and (p.status = 'approved' or (p.status = 'test_fixture' and p_environment = 'test'))
$function$;

revoke all on function public.esblu_billing_resolve_price(text, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_resolve_price(text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 6) Prepočet nárokov z kanonického stavu (JEDINÁ cesta subscription → nárok).
--    Aktívny prístup: active / trialing / past_due (do grace_until).
--    valid_until = koniec obdobia (+grace) → bez webhooku nárok sám vyprší
--    (fail closed), nič sa nemaže.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_billing_sync_entitlements(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_acc record;
  v_until timestamptz;
  v_entitled boolean := false;
  v_ref text;
  v_count integer := 0;
  v_item record;
begin
  select * into v_acc from public.subscription_accounts a where a.company_id = p_company_id;

  if found and v_acc.plan_code is not null then
    v_ref := 'subscription_account:' || v_acc.id::text;
    if v_acc.status in ('active', 'trialing') and v_acc.current_period_end is not null then
      -- Krátky buffer na oneskorený renewal webhook (nie grace pri zlyhaní platby).
      v_until := v_acc.current_period_end + interval '2 days';
      v_entitled := v_until > now();
    elsif v_acc.status = 'past_due' and v_acc.grace_until is not null then
      v_until := v_acc.grace_until;
      v_entitled := v_until > now();
    end if;
  end if;

  if v_entitled then
    for v_item in
      select pe.entitlement_key, pe.limit_value, pe.limit_period
      from public.subscription_plan_entitlements pe where pe.plan_code = v_acc.plan_code
    loop
      insert into public.company_entitlements
        (company_id, entitlement_key, source, status, valid_from, valid_until, limit_value, limit_period, external_ref, note)
      values
        (p_company_id, v_item.entitlement_key, 'subscription', 'active',
         least(coalesce(v_acc.current_period_start, now()), now()), v_until,
         v_item.limit_value, v_item.limit_period, v_ref, 'plan=' || v_acc.plan_code)
      on conflict (company_id, entitlement_key) where source = 'subscription'
      do update set status = 'active',
                    valid_from = least(public.company_entitlements.valid_from, excluded.valid_from),
                    valid_until = excluded.valid_until,
                    limit_value = excluded.limit_value,
                    limit_period = excluded.limit_period,
                    external_ref = excluded.external_ref,
                    note = excluded.note;
      v_count := v_count + 1;
    end loop;

    -- Downgrade: nároky mimo plánu sa odvolajú (dáta ostávajú).
    update public.company_entitlements e
    set status = 'revoked'
    where e.company_id = p_company_id and e.source = 'subscription' and e.status <> 'revoked'
      and not exists (select 1 from public.subscription_plan_entitlements pe
                      where pe.plan_code = v_acc.plan_code and pe.entitlement_key = e.entitlement_key);
  else
    update public.company_entitlements e
    set status = 'revoked'
    where e.company_id = p_company_id and e.source = 'subscription' and e.status <> 'revoked';
  end if;

  return v_count;
end
$function$;

revoke all on function public.esblu_billing_sync_entitlements(uuid) from public, anon, authenticated;
grant execute on function public.esblu_billing_sync_entitlements(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 7) Provider event pipeline (service_role only).
--    record_event = kroky 2+3 (dedupe + uloženie). apply_event = kroky 5+6.
--    Kroky 1 (podpis) a 4 (normalizácia) robí server pred/po record_event.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_billing_record_event(
  p_provider text, p_environment text, p_provider_event_id text, p_event_type text,
  p_provider_created_at timestamptz, p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row record;
begin
  insert into public.billing_events
    (provider, environment, provider_event_id, event_type, provider_created_at, payload_sha256)
  values
    (p_provider, p_environment, p_provider_event_id, p_event_type, p_provider_created_at, p_payload_sha256)
  on conflict (provider, environment, provider_event_id) do nothing
  returning id, status into v_row;

  if found then
    return jsonb_build_object('event_id', v_row.id, 'duplicate', false);
  end if;

  select e.id, e.status, e.payload_sha256 into v_row
  from public.billing_events e
  where e.provider = p_provider and e.environment = p_environment and e.provider_event_id = p_provider_event_id
  for update;

  -- Rovnaké event ID s iným telom = podvrh / chyba → nikdy nespracovať.
  if v_row.payload_sha256 is not null and p_payload_sha256 is not null
     and v_row.payload_sha256 <> p_payload_sha256 then
    return jsonb_build_object('event_id', v_row.id, 'duplicate', true, 'status', 'payload_mismatch');
  end if;

  if v_row.status in ('received', 'failed') then
    -- Retry po technickej chybe → spracovať znova (bezpečné: apply je idempotentné).
    update public.billing_events set attempts = attempts + 1, status = 'received', error_code = null
    where id = v_row.id;
    return jsonb_build_object('event_id', v_row.id, 'duplicate', false, 'retry', true);
  end if;

  return jsonb_build_object('event_id', v_row.id, 'duplicate', true, 'status', v_row.status);
end
$function$;

revoke all on function public.esblu_billing_record_event(text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_record_event(text, text, text, text, timestamptz, text) to service_role;

-- Uzavretie eventu bez zmeny stavu (ignored/failed) — napr. nepodporovaný typ.
create or replace function public.esblu_billing_close_event(
  p_event_id uuid, p_status text, p_error_code text, p_summary jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_status not in ('ignored', 'failed') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_EVENT_STATUS';
  end if;
  update public.billing_events
  set status = p_status, error_code = p_error_code, summary = coalesce(p_summary, '{}'::jsonb),
      processed_at = now()
  where id = p_event_id and status = 'received';
end
$function$;

revoke all on function public.esblu_billing_close_event(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_billing_close_event(uuid, text, text, jsonb) to service_role;

-- Normalizovaný stav (p_state) — provider-neutrálny JSON zo servera:
--   provider_subscription_id, provider_customer_id, provider_price_id,
--   status, current_period_start, current_period_end, cancel_at_period_end,
--   canceled_at, ended_at, trial_start, trial_end, checkout_ref (uuid našej
--   billing_checkout_sessions), account_token (Apple/Google), state_at,
--   replaces_subscription_id (Google linkedPurchaseToken).
create or replace function public.esblu_billing_apply_event(p_event_id uuid, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_event record;
  v_company_id uuid;
  v_checkout_id uuid;
  v_checkout_price text;
  v_checkout_status text;
  v_checkout_method text;
  v_checkout_platform text;
  v_checkout_token text;
  v_checkout_reporting text;
  v_price record;
  v_acc record;
  v_state_at timestamptz;
  v_status text;
  v_sub_id text := nullif(p_state ->> 'provider_subscription_id', '');
  v_cust_id text := nullif(p_state ->> 'provider_customer_id', '');
  v_token text := nullif(p_state ->> 'account_token', '');
  v_checkout_ref uuid;
  v_grace_days integer := 7;
  v_result text;
  v_summary jsonb;
begin
  select * into v_event from public.billing_events e where e.id = p_event_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_EVENT_NOT_FOUND';
  end if;
  if v_event.status <> 'received' then
    -- Už spracované (duplicitné doručenie paralelne) → no-op.
    return jsonb_build_object('result', 'duplicate', 'status', v_event.status);
  end if;

  v_status := p_state ->> 'status';
  v_state_at := coalesce((p_state ->> 'state_at')::timestamptz, v_event.provider_created_at, now());
  v_summary := jsonb_strip_nulls(jsonb_build_object(
    'status', v_status, 'subscription', v_sub_id, 'price', p_state ->> 'provider_price_id',
    'period_end', p_state ->> 'current_period_end',
    'cancel_at_period_end', p_state -> 'cancel_at_period_end'));

  if v_status is null or v_status not in (
    'incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'expired') then
    update public.billing_events set status = 'failed', error_code = 'INVALID_STATE', summary = v_summary,
      processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'INVALID_STATE');
  end if;

  -- (a) Firma: iba z našich tabuliek.
  begin
    v_checkout_ref := nullif(p_state ->> 'checkout_ref', '')::uuid;
  exception when invalid_text_representation then
    v_checkout_ref := null;
  end;

  if v_checkout_ref is not null then
    select s.id, s.company_id, s.provider_price_id, s.status, s.purchase_method, s.platform, s.store_token, s.store_reporting
    into v_checkout_id, v_company_id, v_checkout_price, v_checkout_status, v_checkout_method, v_checkout_platform,
         v_checkout_token, v_checkout_reporting
    from public.billing_checkout_sessions s
    where s.id = v_checkout_ref and s.provider = v_event.provider and s.environment = v_event.environment;
  end if;

  if v_company_id is null and v_sub_id is not null then
    select l.company_id into v_company_id from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.link_kind = 'subscription' and l.external_id = v_sub_id;
  end if;
  if v_company_id is null and v_token is not null then
    select l.company_id into v_company_id from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.link_kind = 'account_token' and l.external_id = v_token;
  end if;
  if v_company_id is null and v_cust_id is not null then
    select l.company_id into v_company_id from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.link_kind = 'customer' and l.external_id = v_cust_id;
  end if;

  if v_company_id is null then
    update public.billing_events set status = 'failed', error_code = 'UNKNOWN_COMPANY', summary = v_summary,
      processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'UNKNOWN_COMPANY');
  end if;

  -- Identifikátor providera nesmie patriť inej firme (Company A event ≠ Company B).
  if exists (
    select 1 from public.billing_provider_links l
    where l.provider = v_event.provider and l.environment = v_event.environment
      and l.company_id <> v_company_id
      and ((l.link_kind = 'subscription' and l.external_id = v_sub_id)
        or (l.link_kind = 'customer' and l.external_id = v_cust_id)
        or (l.link_kind = 'account_token' and l.external_id = v_token))
  ) then
    update public.billing_events set status = 'failed', error_code = 'CROSS_TENANT_IDENTIFIER',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'CROSS_TENANT_IDENTIFIER');
  end if;

  -- (b) Plán: iba cez server-side mapovanie price → plán.
  select bp.* into v_price from public.billing_provider_prices bp
  where bp.provider = v_event.provider and bp.environment = v_event.environment
    and bp.provider_price_id = p_state ->> 'provider_price_id';
  if not found then
    update public.billing_events set status = 'failed', error_code = 'UNKNOWN_PRICE',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'UNKNOWN_PRICE');
  end if;

  -- Checkout zámer: provider musí predať presne to, čo server schválil.
  if v_checkout_id is not null and v_checkout_price <> v_price.provider_price_id then
    update public.billing_checkout_sessions set status = 'rejected' where id = v_checkout_id;
    update public.billing_events set status = 'failed', error_code = 'PRICE_MISMATCH',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'PRICE_MISMATCH');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':billing', 0));

  insert into public.subscription_accounts (company_id) values (v_company_id)
  on conflict (company_id) do nothing;
  select * into v_acc from public.subscription_accounts a where a.company_id = v_company_id for update;

  -- (c) Jedna firma = jedno predplatné. Iný provider / iné predplatné počas
  --     aktívneho stavu = konflikt pre operátora (žiadny prepis, žiadny zisk nárokov).
  if v_acc.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete')
     and v_acc.provider_subscription_id is not null
     and (v_acc.billing_provider is distinct from v_event.provider
          or v_acc.provider_subscription_id is distinct from v_sub_id)
     -- Výnimka: ten istý provider výslovne nahrádza predplatné (Google
     -- linkedPurchaseToken pri upgrade/downgrade = nový purchaseToken).
     and not (v_acc.billing_provider = v_event.provider
              and v_acc.provider_subscription_id = nullif(p_state ->> 'replaces_subscription_id', ''))
  then
    update public.billing_events set status = 'conflict', error_code = 'SECOND_ACTIVE_SUBSCRIPTION',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'conflict', 'error', 'SECOND_ACTIVE_SUBSCRIPTION');
  end if;

  -- (d) Poradie: starší stav toho istého predplatného nikdy neprepíše novší.
  if v_acc.provider_subscription_id is not distinct from v_sub_id
     and v_acc.provider_state_at is not null and v_state_at < v_acc.provider_state_at then
    update public.billing_events set status = 'stale', company_id = v_company_id, summary = v_summary,
      processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'stale');
  end if;

  -- (e) Ukončené predplatné toho istého ID sa nedá oživiť neskorším eventom.
  if v_acc.provider_subscription_id is not distinct from v_sub_id
     and v_acc.status in ('canceled', 'expired') and v_acc.ended_at is not null
     and v_status not in ('canceled', 'expired') then
    update public.billing_events set status = 'stale', error_code = 'TERMINAL_STATE',
      company_id = v_company_id, summary = v_summary, processed_at = now() where id = p_event_id;
    return jsonb_build_object('result', 'stale', 'error', 'TERMINAL_STATE');
  end if;

  update public.subscription_accounts a set
    plan_code = v_price.plan_code,
    billing_interval = v_price.billing_interval,
    status = v_status,
    billing_provider = v_event.provider,
    provider_environment = v_event.environment,
    provider_customer_id = coalesce(v_cust_id, a.provider_customer_id),
    provider_subscription_id = coalesce(v_sub_id, a.provider_subscription_id),
    current_period_start = nullif(p_state ->> 'current_period_start', '')::timestamptz,
    current_period_end = nullif(p_state ->> 'current_period_end', '')::timestamptz,
    cancel_at_period_end = coalesce((p_state ->> 'cancel_at_period_end')::boolean, false),
    canceled_at = nullif(p_state ->> 'canceled_at', '')::timestamptz,
    ended_at = case when v_status in ('canceled', 'expired')
                    then coalesce(nullif(p_state ->> 'ended_at', '')::timestamptz, v_state_at) end,
    provider_trial_start = nullif(p_state ->> 'trial_start', '')::timestamptz,
    provider_trial_end = nullif(p_state ->> 'trial_end', '')::timestamptz,
    grace_until = case
      when v_status = 'past_due' then coalesce(
        case when a.status = 'past_due' then a.grace_until end,
        v_state_at + make_interval(days => v_grace_days))
      else null end,
    -- Kanál vzniku: z nášho nákupného zámeru; nové predplatné bez zámeru
    -- (napr. nákup priamo v App Store / Play) = natívny kanál obchodu.
    purchase_method = case
      when v_checkout_id is not null then v_checkout_method
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then case v_event.provider when 'apple' then 'apple_iap' when 'google' then 'google_play' else null end
      else a.purchase_method end,
    purchase_platform = case
      when v_checkout_id is not null then v_checkout_platform
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then case v_event.provider when 'apple' then 'ios' when 'google' then 'android' else null end
      else a.purchase_platform end,
    store_reporting = case
      when v_checkout_id is not null then coalesce(v_checkout_reporting, 'none')
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then 'none'
      else a.store_reporting end,
    store_token = case
      when v_checkout_id is not null then v_checkout_token
      when a.provider_subscription_id is distinct from v_sub_id
           and nullif(p_state ->> 'replaces_subscription_id', '') is distinct from a.provider_subscription_id
        then null
      else a.store_token end,
    provider_state_at = v_state_at,
    last_event_id = p_event_id,
    version = a.version + 1,
    updated_at = now()
  where a.id = v_acc.id;

  -- Väzby (idempotentne; unique constraint chráni pred cudzou firmou).
  if v_sub_id is not null then
    insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
    values (v_company_id, v_event.provider, v_event.environment, 'subscription', v_sub_id)
    on conflict do nothing;
  end if;
  if v_cust_id is not null then
    insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
    values (v_company_id, v_event.provider, v_event.environment, 'customer', v_cust_id)
    on conflict do nothing;
  end if;
  if v_token is not null then
    insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
    values (v_company_id, v_event.provider, v_event.environment, 'account_token', v_token)
    on conflict do nothing;
  end if;

  if v_checkout_id is not null and v_checkout_status in ('created', 'open') then
    update public.billing_checkout_sessions set status = 'completed', completed_at = now()
    where id = v_checkout_id;
  end if;

  -- (f) Až teraz prepočet nárokov.
  perform public.esblu_billing_sync_entitlements(v_company_id);

  -- (g) Platba predplatného kúpeného kanálom s reportingom obchodu → outbox.
  if jsonb_typeof(p_state -> 'charge') = 'object' then
    perform public.esblu_billing_queue_store_report(v_acc.id, p_state -> 'charge');
  end if;

  update public.billing_events set status = 'processed', company_id = v_company_id, summary = v_summary,
    processed_at = now(), error_code = null where id = p_event_id;

  v_result := 'applied';
  return jsonb_build_object('result', v_result, 'company_id', v_company_id, 'plan_code', v_price.plan_code,
                            'status', v_status);
end
$function$;

revoke all on function public.esblu_billing_apply_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_billing_apply_event(uuid, jsonb) to service_role;

-- Mobilné účty (Apple appAccountToken / Google obfuscatedAccountId): server
-- vygeneruje nereverzibilný token pre firmu prihláseného MANAGE používateľa.
create or replace function public.esblu_billing_issue_account_token(p_provider text)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_company_id uuid := (v_access ->> 'company_id')::uuid;
  v_token text;
  p_environment text := (select c.environment from public.billing_runtime_config c where c.id);
begin
  if not (v_access ->> 'can_manage')::boolean then
    raise exception using errcode = '42501', message = 'ESBLU_BILLING_FORBIDDEN';
  end if;
  if p_provider is null or p_provider not in ('apple', 'google', 'fake') or p_environment is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PROVIDER_NOT_ALLOWED';
  end if;

  select l.external_id into v_token from public.billing_provider_links l
  where l.company_id = v_company_id and l.provider = p_provider and l.environment = p_environment
    and l.link_kind = 'account_token'
  limit 1;

  if v_token is null then
    -- Apple vyžaduje UUID; Google akceptuje ľubovoľný reťazec ≤ 64 znakov.
    v_token := gen_random_uuid()::text;
    insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
    values (v_company_id, p_provider, p_environment, 'account_token', v_token);
  end if;
  return v_token;
end
$function$;

revoke all on function public.esblu_billing_issue_account_token(text) from public, anon;
grant execute on function public.esblu_billing_issue_account_token(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 9) NÁKUP Z MOBILU — konfigurovateľné kanály podľa platformy a storefrontu.
--
--    Geografické pravidlá sú DÁTA (billing_region_groups + billing_channel_rules),
--    nie kód a nie súčasť entitlement engine. Entitlement engine nevie nič
--    o platforme ani krajine — všetky kanály končia v tom istom
--    subscription_accounts → esblu_billing_sync_entitlements.
--
--    Metódy (purchase_method):
--      stripe_web_checkout      web: Stripe-hosted Checkout
--      apple_iap                iOS: StoreKit 2 In-App Purchase
--      apple_eu_link_checkout   iOS EÚ: ExternalPurchaseCustomLink(.browser) → Stripe Checkout
--      apple_eu_in_app_checkout iOS EÚ: ExternalPurchaseCustomLink(.withinApp) → Stripe Checkout v appke
--      apple_us_link            iOS US: odkaz na Stripe Checkout (3.1.1(a)) — default vypnuté
--      google_play              Android: Google Play Billing
--      google_choice_developer  Android EEA: billing choice program → používateľ zvolil Esblu billing (Stripe)
--    Metóda je povolená iba ak: pravidlo pre (platforma, storefront) ju obsahuje
--    AND je v billing_runtime_config.enabled_methods (globálny kill-switch).
-- -----------------------------------------------------------------------------
create table if not exists public.billing_region_groups (
  group_code text not null,
  country_code text not null,
  primary key (group_code, country_code),
  constraint billing_region_groups_group_format check (group_code ~ '^[A-Z][A-Z0-9_]{1,15}$' and char_length(group_code) > 2),
  constraint billing_region_groups_country_format check (country_code ~ '^[A-Z]{2}$')
);

comment on table public.billing_region_groups is
  'Skupiny krajín pre billing pravidlá (EU27, EEA, …). Kód skupiny má ≥3 znaky, aby sa nezamenil s ISO krajinou.';

create table if not exists public.billing_channel_rules (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  region text not null,
  methods text[] not null,
  enabled boolean not null default true,
  note text null,
  updated_at timestamptz not null default now(),
  constraint billing_channel_rules_platform_check check (platform in ('web', 'android', 'ios')),
  -- '*' | ISO krajina (SK) | skupina (EU27, EEA)
  constraint billing_channel_rules_region_format check (region = '*' or region ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  constraint billing_channel_rules_methods_check check (
    cardinality(methods) between 1 and 8
    and methods <@ array['stripe_web_checkout', 'apple_iap', 'apple_eu_link_checkout', 'apple_eu_in_app_checkout',
                         'apple_us_link', 'google_play', 'google_choice_developer', 'view_only']::text[]),
  constraint billing_channel_rules_unique unique (platform, region)
);

comment on table public.billing_channel_rules is
  'Kde a ako sa smie kúpiť predplatné. Najšpecifickejšie pravidlo vyhráva: krajina > skupina > *. '
  'Zmena pravidla = UPDATE riadku (service_role), bez zmeny kódu ani entitlement engine.';

alter table public.billing_runtime_config
  add column if not exists enabled_methods text[] not null default array['stripe_web_checkout']::text[];

alter table public.billing_region_groups enable row level security;
alter table public.billing_channel_rules enable row level security;
revoke all on table public.billing_region_groups, public.billing_channel_rules from public, anon, authenticated;
grant select, insert, update, delete on table public.billing_region_groups, public.billing_channel_rules to service_role;

-- Metóda → rodina providera a povinnosť reportovania obchodu.
create or replace function public.esblu_billing_method_info(p_method text)
returns jsonb
language sql
immutable
set search_path to ''
as $function$
  select case p_method
    when 'stripe_web_checkout'      then '{"provider":"web","reporting":"none","needs_store_token":false}'
    when 'apple_iap'                then '{"provider":"apple","reporting":"none","needs_store_token":false}'
    when 'apple_eu_link_checkout'   then '{"provider":"web","reporting":"apple_external_purchase","needs_store_token":true}'
    when 'apple_eu_in_app_checkout' then '{"provider":"web","reporting":"apple_external_purchase","needs_store_token":true}'
    when 'apple_us_link'            then '{"provider":"web","reporting":"none","needs_store_token":false}'
    when 'google_play'              then '{"provider":"google","reporting":"none","needs_store_token":false}'
    when 'google_choice_developer'  then '{"provider":"web","reporting":"google_external_transaction","needs_store_token":true}'
    else null
  end::jsonb
$function$;

revoke all on function public.esblu_billing_method_info(text) from public, anon;
grant execute on function public.esblu_billing_method_info(text) to authenticated, service_role;

-- Povolené metódy pre platformu + storefront (bez rolovej brány — čistá konfigurácia).
create or replace function public.esblu_billing_resolve_methods(p_platform text, p_storefront text)
returns text[]
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_country text := upper(nullif(btrim(coalesce(p_storefront, '')), ''));
  v_rule record;
  v_enabled text[];
  v_result text[];
begin
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    v_country := null; -- neplatný storefront = neznámy → iba '*' pravidlo
  end if;

  select r.methods into v_rule
  from public.billing_channel_rules r
  where r.platform = p_platform and r.enabled
    and (r.region = '*'
         or (v_country is not null and r.region = v_country)
         or (v_country is not null and char_length(r.region) > 2 and exists (
               select 1 from public.billing_region_groups g
               where g.group_code = r.region and g.country_code = v_country)))
  order by case when r.region = '*' then 0 when char_length(r.region) = 2 then 2 else 1 end desc,
           r.region
  limit 1;

  select c.enabled_methods into v_enabled from public.billing_runtime_config c where c.id;

  select coalesce(array_agg(m order by ord), array[]::text[]) into v_result
  from unnest(coalesce(v_rule.methods, array[]::text[])) with ordinality as t(m, ord)
  where m = 'view_only' or m = any (coalesce(v_enabled, array[]::text[]));

  v_result := array_remove(v_result, 'view_only');
  if cardinality(v_result) = 0 then
    return array['view_only'];
  end if;
  return v_result;
end
$function$;

revoke all on function public.esblu_billing_resolve_methods(text, text) from public, anon;
grant execute on function public.esblu_billing_resolve_methods(text, text) to authenticated, service_role;

-- Ponuka pre obrazovku Predplatné (web/Android/iOS). Žiadne price ID pre
-- webové metódy; pre Apple/Google vracia product ID (verejné v obchode),
-- ktoré natívny StoreKit / Play Billing potrebuje.
create or replace function public.esblu_billing_purchase_options(p_platform text, p_storefront text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_cfg record;
  v_methods text[];
  v_items jsonb := '[]'::jsonb;
  v_method text;
  v_provider text;
begin
  if p_platform is null or p_platform not in ('web', 'android', 'ios') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PLATFORM_INVALID';
  end if;
  select * into v_cfg from public.billing_runtime_config c where c.id;
  v_methods := public.esblu_billing_resolve_methods(p_platform, p_storefront);

  foreach v_method in array v_methods loop
    v_provider := public.esblu_billing_method_info(v_method) ->> 'provider';
    if v_provider = 'web' then
      v_provider := nullif(v_cfg.web_provider, 'none');
    end if;
    if v_method = 'view_only' or v_provider is null then
      continue;
    end if;
    v_items := v_items || jsonb_build_object(
      'method', v_method,
      'provider', v_provider,
      'reporting', public.esblu_billing_method_info(v_method) ->> 'reporting',
      'plans', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'plan_code', p.plan_code,
                 'intervals', (
                   select coalesce(jsonb_agg(jsonb_build_object(
                            'interval', bp.billing_interval,
                            -- Store product ID je verejný (StoreKit/Play ho potrebujú); Stripe price nie.
                            'store_product_id', case when v_provider in ('apple', 'google') then bp.provider_price_id end)
                          order by bp.billing_interval), '[]'::jsonb)
                   from public.billing_provider_prices bp
                   where bp.plan_code = p.plan_code and bp.provider = v_provider
                     and bp.environment = v_cfg.environment and bp.active),
                 'entitlements', (
                   select coalesce(jsonb_agg(jsonb_build_object('key', pe.entitlement_key, 'limit', pe.limit_value,
                                                                'limit_period', pe.limit_period)
                                             order by pe.entitlement_key), '[]'::jsonb)
                   from public.subscription_plan_entitlements pe where pe.plan_code = p.plan_code))
               order by p.sort_order), '[]'::jsonb)
        from public.subscription_plans p
        where (p.status = 'approved' or (p.status = 'test_fixture' and v_cfg.environment = 'test'))
          and exists (select 1 from public.billing_provider_prices bp
                      where bp.plan_code = p.plan_code and bp.provider = v_provider
                        and bp.environment = v_cfg.environment and bp.active)));
  end loop;

  return jsonb_build_object(
    'platform', p_platform,
    'storefront', upper(nullif(btrim(coalesce(p_storefront, '')), '')),
    'environment', v_cfg.environment,
    'can_manage', (v_access ->> 'can_manage')::boolean,
    'methods', v_items,
    'view_only', jsonb_array_length(v_items) = 0);
end
$function$;

revoke all on function public.esblu_billing_purchase_options(text, text) from public, anon;
grant execute on function public.esblu_billing_purchase_options(text, text) to authenticated, service_role;

-- Jednotný nákupný zámer pre VŠETKY kanály (web, Android, iOS).
--   p_mode='new'    — nové predplatné (blokované, ak firma už má aktívne)
--   p_mode='change' — zmena plánu cez obchod, ktorý predplatné vlastní (Apple/Google);
--                     Stripe zmena ide cez /api/billing/manage.
--   p_store_token   — Apple ExternalPurchaseCustomLink token / Google externalTransactionToken
--                     (povinný pre metódy s reportingom; dôkaz, že obchod kanál povolil).
create or replace function public.esblu_billing_create_purchase_intent(
  p_plan_code text, p_interval text, p_platform text, p_method text,
  p_storefront text, p_mode text, p_store_token text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_access jsonb := public.esblu_billing_my_access();
  v_company_id uuid := (v_access ->> 'company_id')::uuid;
  v_cfg record;
  v_info jsonb;
  v_provider text;
  v_reporting text;
  v_plan record;
  v_price record;
  v_acc record;
  v_id uuid;
  v_recent integer;
  v_token text;
  v_storefront text := upper(nullif(btrim(coalesce(p_storefront, '')), ''));
begin
  if not (v_access ->> 'can_manage')::boolean then
    raise exception using errcode = '42501', message = 'ESBLU_BILLING_FORBIDDEN';
  end if;
  if p_platform is null or p_platform not in ('web', 'android', 'ios') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PLATFORM_INVALID';
  end if;
  if p_interval is null or p_interval not in ('month', 'year') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_INTERVAL_INVALID';
  end if;
  if coalesce(p_mode, 'new') not in ('new', 'change') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_MODE_INVALID';
  end if;
  if v_storefront is not null and v_storefront !~ '^[A-Z]{2}$' then
    v_storefront := null;
  end if;

  select * into v_cfg from public.billing_runtime_config c where c.id;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DISABLED';
  end if;

  -- Kanál musí povoliť KONFIGURÁCIA pre túto platformu a storefront.
  if p_method is null or not (p_method = any (public.esblu_billing_resolve_methods(p_platform, v_storefront)))
     or p_method = 'view_only' then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_METHOD_NOT_ALLOWED';
  end if;

  v_info := public.esblu_billing_method_info(p_method);
  v_provider := v_info ->> 'provider';
  v_reporting := v_info ->> 'reporting';
  if v_provider = 'web' then
    if v_cfg.web_provider = 'none' then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DISABLED';
    end if;
    v_provider := v_cfg.web_provider;
  end if;

  if (v_info ->> 'needs_store_token')::boolean
     and (p_store_token is null or char_length(p_store_token) not between 8 and 4096
          or p_store_token !~ '^[A-Za-z0-9_.:=+/-]+$') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_STORE_TOKEN_REQUIRED';
  end if;

  select * into v_plan from public.subscription_plans p where p.plan_code = p_plan_code;
  if not found
    or not (v_plan.status = 'approved' or (v_plan.status = 'test_fixture' and v_cfg.environment = 'test'))
  then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PLAN_NOT_PURCHASABLE';
  end if;

  select * into v_price from public.billing_provider_prices bp
  where bp.provider = v_provider and bp.environment = v_cfg.environment
    and bp.plan_code = p_plan_code and bp.billing_interval = p_interval and bp.active;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_PRICE_NOT_CONFIGURED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':billing', 0));
  select * into v_acc from public.subscription_accounts a where a.company_id = v_company_id;

  if coalesce(p_mode, 'new') = 'new' then
    if found and v_acc.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete') then
      raise exception using errcode = 'P0001',
        message = case when v_acc.billing_provider is distinct from v_provider
                       then 'ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER'
                       else 'ESBLU_BILLING_ALREADY_SUBSCRIBED' end;
    end if;
  else
    -- Zmena plánu v obchode, ktorý predplatné vlastní (StoreKit upgrade v skupine /
    -- Play SubscriptionUpdateParams). Iný provider = nepovolené (žiadne 2 predplatné).
    if not found or v_acc.status not in ('active', 'trialing', 'past_due')
       or v_acc.billing_provider is distinct from v_provider or v_provider not in ('apple', 'google') then
      raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_CHANGE_NOT_ALLOWED';
    end if;
  end if;

  select count(*) into v_recent from public.billing_checkout_sessions s
  where s.company_id = v_company_id and s.created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_RATE_LIMITED';
  end if;

  if v_provider in ('apple', 'google') then
    select l.external_id into v_token from public.billing_provider_links l
    where l.company_id = v_company_id and l.provider = v_provider and l.environment = v_cfg.environment
      and l.link_kind = 'account_token'
    limit 1;
    if v_token is null then
      v_token := gen_random_uuid()::text;
      insert into public.billing_provider_links (company_id, provider, environment, link_kind, external_id)
      values (v_company_id, v_provider, v_cfg.environment, 'account_token', v_token);
    end if;
  end if;

  insert into public.billing_checkout_sessions
    (company_id, created_by, provider, environment, plan_code, billing_interval, provider_price_id,
     platform, purchase_method, storefront_country, store_token, store_reporting)
  values
    (v_company_id, v_uid, v_provider, v_cfg.environment, p_plan_code, p_interval, v_price.provider_price_id,
     p_platform, p_method, v_storefront, p_store_token, v_reporting)
  returning id into v_id;

  return jsonb_build_object(
    'checkout_id', v_id,
    'company_id', v_company_id,
    'provider', v_provider,
    'environment', v_cfg.environment,
    'method', p_method,
    'reporting', v_reporting,
    'provider_price_id', v_price.provider_price_id,
    'provider_customer_id', case when v_acc.billing_provider = v_provider then v_acc.provider_customer_id end,
    'account_token', v_token,
    'replaces_subscription_id', case when coalesce(p_mode, 'new') = 'change' then v_acc.provider_subscription_id end);
end
$function$;

revoke all on function public.esblu_billing_create_purchase_intent(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.esblu_billing_create_purchase_intent(text, text, text, text, text, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 10) Reporting obchodom (Google External Transactions API do 24 h,
--     Apple External Purchase Server API mesačne do 15. dňa) — OUTBOX.
--     Vzniká automaticky z platby (charge) predplatného, ktoré bolo kúpené
--     kanálom s povinným reportingom. Odosiela ho server job (cron), nie DB.
-- -----------------------------------------------------------------------------
create table if not exists public.billing_store_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid null references public.companies (id) on delete set null,
  subscription_account_id uuid null references public.subscription_accounts (id) on delete set null,
  store text not null,
  report_kind text not null,
  environment text not null,
  provider_charge_id text not null,
  -- Google: externalTransactionId (≤63, bez osobných údajov); Apple: requestIdentifier (UUID).
  external_transaction_id text not null,
  initial_external_transaction_id text null,
  store_token text null,
  amount_pre_tax_minor bigint null,
  tax_minor bigint null,
  currency text null,
  tax_country text null,
  transaction_at timestamptz not null,
  period_start timestamptz null,
  period_end timestamptz null,
  product_id text null,
  status text not null default 'pending',
  attempts integer not null default 0,
  due_at timestamptz not null,
  sent_at timestamptz null,
  last_error text null,
  created_at timestamptz not null default now(),
  constraint billing_store_reports_store_check check (store in ('google', 'apple')),
  constraint billing_store_reports_kind_check check (report_kind in (
    'google_initial', 'google_renewal', 'google_refund',
    'apple_subscription_start', 'apple_renewal', 'apple_refund', 'apple_no_line_item')),
  constraint billing_store_reports_env_check check (environment in ('test', 'live')),
  constraint billing_store_reports_status_check check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  constraint billing_store_reports_currency_check check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint billing_store_reports_country_check check (tax_country is null or tax_country ~ '^[A-Z]{2}$'),
  constraint billing_store_reports_ext_id_format check (external_transaction_id ~ '^[A-Za-z0-9_-]+$' and char_length(external_transaction_id) <= 63),
  constraint billing_store_reports_unique_charge unique (report_kind, provider_charge_id)
);

create index if not exists billing_store_reports_due_idx on public.billing_store_reports (status, due_at);

alter table public.billing_store_reports enable row level security;
revoke all on table public.billing_store_reports from public, anon, authenticated;
grant select, insert, update, delete on table public.billing_store_reports to service_role;

-- charge: {id, kind: purchase|refund, amount_pre_tax_minor, tax_minor, currency, at, tax_country, refunded_charge_id}
create or replace function public.esblu_billing_queue_store_report(p_account_id uuid, p_charge jsonb)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_acc record;
  v_kind text;
  v_store text;
  v_initial text;
  v_at timestamptz := coalesce(nullif(p_charge ->> 'at', '')::timestamptz, now());
  v_id uuid := gen_random_uuid();
  v_ext text;
  v_due timestamptz;
  v_charge_id text := nullif(p_charge ->> 'id', '');
begin
  select * into v_acc from public.subscription_accounts a where a.id = p_account_id;
  if not found or coalesce(v_acc.store_reporting, 'none') = 'none' or v_charge_id is null then
    return null;
  end if;

  if v_acc.store_reporting = 'google_external_transaction' then
    v_store := 'google';
    select r.external_transaction_id into v_initial from public.billing_store_reports r
    where r.subscription_account_id = p_account_id and r.report_kind = 'google_initial'
      and r.store_token is not distinct from v_acc.store_token
    order by r.created_at limit 1;
    v_kind := case when p_charge ->> 'kind' = 'refund' then 'google_refund'
                   when v_initial is null then 'google_initial' else 'google_renewal' end;
    v_due := v_at + interval '24 hours';
    v_ext := 'esblu_' || replace(v_id::text, '-', '');
    if v_kind = 'google_refund' then
      -- Refund sa viaže na ID pôvodnej reportovanej transakcie.
      select r.external_transaction_id into v_initial from public.billing_store_reports r
      where r.provider_charge_id = nullif(p_charge ->> 'refunded_charge_id', '')
        and r.report_kind in ('google_initial', 'google_renewal');
      if v_initial is null then
        return null;
      end if;
    end if;
  else
    v_store := 'apple';
    v_kind := case when p_charge ->> 'kind' = 'refund' then 'apple_refund'
                   when exists (select 1 from public.billing_store_reports r
                                where r.subscription_account_id = p_account_id
                                  and r.report_kind = 'apple_subscription_start'
                                  and r.store_token is not distinct from v_acc.store_token)
                   then 'apple_renewal' else 'apple_subscription_start' end;
    -- Mesačne: do 15 dní po konci kalendárneho mesiaca transakcie.
    v_due := date_trunc('month', v_at) + interval '1 month' + interval '15 days';
    v_ext := replace(v_id::text, '-', '');
    select r.external_transaction_id into v_initial from public.billing_store_reports r
    where r.subscription_account_id = p_account_id and r.report_kind = 'apple_subscription_start'
      and r.store_token is not distinct from v_acc.store_token
    order by r.created_at limit 1;
  end if;

  insert into public.billing_store_reports
    (id, company_id, subscription_account_id, store, report_kind, environment, provider_charge_id,
     external_transaction_id, initial_external_transaction_id, store_token, amount_pre_tax_minor, tax_minor,
     currency, tax_country, transaction_at, period_start, period_end, product_id, due_at)
  values
    (v_id, v_acc.company_id, p_account_id, v_store, v_kind, coalesce(v_acc.provider_environment, 'test'), v_charge_id,
     v_ext, v_initial, v_acc.store_token,
     nullif(p_charge ->> 'amount_pre_tax_minor', '')::bigint, nullif(p_charge ->> 'tax_minor', '')::bigint,
     upper(nullif(p_charge ->> 'currency', '')), upper(nullif(p_charge ->> 'tax_country', '')),
     v_at, v_acc.current_period_start, v_acc.current_period_end, v_acc.plan_code, v_due)
  on conflict (report_kind, provider_charge_id) do nothing;

  return v_id;
end
$function$;

revoke all on function public.esblu_billing_queue_store_report(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_billing_queue_store_report(uuid, jsonb) to service_role;

-- Platba bez zmeny stavu (napr. refund) — iba reporting obchodu.
create or replace function public.esblu_billing_apply_charge(p_event_id uuid, p_provider_subscription_id text, p_charge jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_event record;
  v_acc record;
begin
  select * into v_event from public.billing_events e where e.id = p_event_id for update;
  if not found or v_event.status <> 'received' then
    return jsonb_build_object('result', 'duplicate');
  end if;
  select a.* into v_acc from public.subscription_accounts a
  where a.billing_provider = v_event.provider and a.provider_subscription_id = p_provider_subscription_id;
  if not found then
    update public.billing_events set status = 'failed', error_code = 'UNKNOWN_SUBSCRIPTION', processed_at = now()
    where id = p_event_id;
    return jsonb_build_object('result', 'failed', 'error', 'UNKNOWN_SUBSCRIPTION');
  end if;
  perform public.esblu_billing_queue_store_report(v_acc.id, p_charge);
  update public.billing_events set status = 'processed', company_id = v_acc.company_id, processed_at = now(),
    summary = jsonb_build_object('charge_kind', p_charge ->> 'kind') where id = p_event_id;
  return jsonb_build_object('result', 'applied', 'company_id', v_acc.company_id);
end
$function$;

revoke all on function public.esblu_billing_apply_charge(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_billing_apply_charge(uuid, text, jsonb) to service_role;

-- Job: vyzdvihne splatné/čakajúce reporty (SKIP LOCKED) a doplní Apple
-- NO_LINE_ITEM pre tokeny z uplynulých mesiacov, ktoré nevedú k nákupu.
create or replace function public.esblu_billing_claim_store_reports(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
begin
  insert into public.billing_store_reports
    (company_id, store, report_kind, environment, provider_charge_id, external_transaction_id, store_token,
     transaction_at, due_at)
  select s.company_id, 'apple', 'apple_no_line_item', s.environment, 'token:' || s.id::text,
         replace(gen_random_uuid()::text, '-', ''), s.store_token, s.created_at,
         date_trunc('month', s.created_at) + interval '1 month' + interval '15 days'
  from public.billing_checkout_sessions s
  where s.store_reporting = 'apple_external_purchase' and s.store_token is not null
    and s.status not in ('completed')
    and s.created_at < date_trunc('month', now())
    and not exists (select 1 from public.billing_store_reports r where r.store_token = s.store_token)
  on conflict (report_kind, provider_charge_id) do nothing;

  with claimed as (
  update public.billing_store_reports r
  set status = 'sending', attempts = r.attempts + 1
  where r.id in (
    select x.id from public.billing_store_reports x
    where x.status in ('pending', 'failed') and x.attempts < 10
    order by x.due_at, x.created_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update skip locked)
  returning r.*)
  select coalesce(jsonb_agg(to_jsonb(c) order by c.due_at, c.created_at), '[]'::jsonb) into v_result from claimed c;
  return v_result;
end
$function$;

revoke all on function public.esblu_billing_claim_store_reports(integer) from public, anon, authenticated;
grant execute on function public.esblu_billing_claim_store_reports(integer) to service_role;

create or replace function public.esblu_billing_complete_store_report(p_id uuid, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.billing_store_reports
  set status = case when p_ok then 'sent' else 'failed' end,
      sent_at = case when p_ok then now() end,
      last_error = case when p_ok then null else left(coalesce(p_error, 'ERROR'), 200) end
  where id = p_id and status = 'sending';
end
$function$;

revoke all on function public.esblu_billing_complete_store_report(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_complete_store_report(uuid, boolean, text) to service_role;

-- Overenie, že nákupný zámer patrí firme volajúceho (mobilné potvrdenie nákupu).
create or replace function public.esblu_billing_my_intent(p_checkout_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_access jsonb := public.esblu_billing_my_access();
  v_row record;
begin
  if not (v_access ->> 'can_manage')::boolean then
    raise exception using errcode = '42501', message = 'ESBLU_BILLING_FORBIDDEN';
  end if;
  select s.id, s.provider, s.environment, s.purchase_method, s.platform, s.provider_price_id, s.status
  into v_row
  from public.billing_checkout_sessions s
  where s.id = p_checkout_id and s.company_id = (v_access ->> 'company_id')::uuid;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object('found', true, 'provider', v_row.provider, 'environment', v_row.environment,
                            'method', v_row.purchase_method, 'platform', v_row.platform,
                            'provider_price_id', v_row.provider_price_id, 'status', v_row.status);
end
$function$;

revoke all on function public.esblu_billing_my_intent(uuid) from public, anon;
grant execute on function public.esblu_billing_my_intent(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8) TEST FIXTURES (iba status='test_fixture' + environment='test').
--    NIE SÚ obchodne schválené plány ani ceny. 'fake' price IDs patria fake
--    providerovi. Stripe test price IDs sa doplnia až po pripojení Stripe
--    sandboxu (operátor, service_role) — nič tu nie je vymyslené ako reálne ID.
-- -----------------------------------------------------------------------------
insert into public.subscription_plans (plan_code, status, sort_order) values
  ('test_starter', 'test_fixture', 10),
  ('test_pro', 'test_fixture', 20)
on conflict (plan_code) do nothing;

insert into public.subscription_plan_entitlements (plan_code, entitlement_key, limit_value, limit_period) values
  ('test_starter', 'invoicing',    null, null),
  ('test_starter', 'ai_documents', 50,   'month'),
  ('test_starter', 'vehicles',     5,    null),
  ('test_starter', 'machines',     5,    null),
  ('test_starter', 'inventory',    100,  null),
  ('test_starter', 'team_members', 3,    null),
  ('test_pro',     'invoicing',    null, null),
  ('test_pro',     'ai_documents', 200,  'month'),
  ('test_pro',     'vehicles',     null, null),
  ('test_pro',     'machines',     null, null),
  ('test_pro',     'inventory',    null, null),
  ('test_pro',     'voice',        null, null),
  ('test_pro',     'team_members', 10,   null)
on conflict (plan_code, entitlement_key) do nothing;

insert into public.billing_provider_prices (provider, environment, plan_code, billing_interval, provider_price_id) values
  ('fake', 'test', 'test_starter', 'month', 'fake_price_starter_month'),
  ('fake', 'test', 'test_starter', 'year',  'fake_price_starter_year'),
  ('fake', 'test', 'test_pro',     'month', 'fake_price_pro_month'),
  ('fake', 'test', 'test_pro',     'year',  'fake_price_pro_year'),
  ('apple', 'test', 'test_starter', 'month', 'com.esblu.test.starter.monthly'),
  ('apple', 'test', 'test_starter', 'year',  'com.esblu.test.starter.yearly'),
  ('google', 'test', 'test_starter', 'month', 'esblu_test_starter:monthly'),
  ('google', 'test', 'test_starter', 'year',  'esblu_test_starter:yearly'),
  ('apple', 'test', 'test_pro',    'month', 'com.esblu.test.pro.monthly'),
  ('apple', 'test', 'test_pro',    'year',  'com.esblu.test.pro.yearly'),
  ('google', 'test', 'test_pro',   'month', 'esblu_test_pro:monthly'),
  ('google', 'test', 'test_pro',   'year',  'esblu_test_pro:yearly')
on conflict (provider, environment, provider_price_id) do nothing;

-- Skupiny krajín (EU27 = EU-27; EEA = EU-27 + IS, LI, NO). Dáta — upraviteľné bez kódu.
insert into public.billing_region_groups (group_code, country_code)
select 'EU27', c from unnest(array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE']) c
on conflict do nothing;
insert into public.billing_region_groups (group_code, country_code)
select 'EEA', c from unnest(array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO']) c
on conflict do nothing;

-- Predvolené kanály (docs/subscriptions-store-compliance-2026-10-08.md, sekcia 5).
-- Neznámy storefront → '*' pravidlo (vždy natívny billing obchodu).
insert into public.billing_channel_rules (platform, region, methods, note) values
  ('web',     '*',   array['stripe_web_checkout'], 'Web: Stripe Checkout'),
  ('android', 'EEA', array['google_play', 'google_choice_developer'], 'EEA billing choice program: Play Billing alebo Esblu (Stripe) v appke; reporting 24 h'),
  ('android', 'US',  array['google_play'], 'US: Play Billing (US programy zatiaľ nie)'),
  ('android', '*',   array['google_play'], 'Mimo EEA: Play Billing'),
  ('ios',     'EU27', array['apple_iap', 'apple_eu_link_checkout'], 'EÚ Attachment 14: IAP + ExternalPurchaseCustomLink; reporting mesačne'),
  ('ios',     'US',  array['apple_iap', 'apple_us_link'], 'US: IAP + odkaz (3.1.1(a))'),
  ('ios',     '*',   array['apple_iap'], 'Mimo EÚ/US: iba IAP')
on conflict (platform, region) do nothing;
