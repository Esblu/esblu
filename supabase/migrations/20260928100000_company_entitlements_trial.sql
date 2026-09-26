-- =============================================================================
-- Company entitlements: 14-day company trial + modular paid entitlements +
-- AI-processing ledger + team-member limit + voice as a paid capability.
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. Aplikovať iba po výslovnom schválení cez
-- Supabase MCP apply_migration na fkpgvgvsmbpieduoatrt (supabase/MIGRATIONS.md).
-- NIKDY `supabase db push`. Nahrádza skorší (tiež neaplikovaný) Free/Pro návrh
-- s rovnakým názvom súboru.
--
-- PORADIE NASADENIA (povinné): najprv táto migrácia, AŽ POTOM kód, ktorý
-- volá esblu_get_my_company_entitlements / esblu_require_my_entitlement /
-- esblu_reserve_ai_processing. Kód bez migrácie je fail-closed (hlas a AI
-- spracovanie by prestali fungovať).
--
-- PRINCÍPY
--   1. Zmena nároku (trial, predplatné, ručný grant) mení IBA prístup —
--      nikdy nemaže, nepresúva ani neprepisuje business dáta ani storage.
--   2. Trial patrí FIRME: companies.trial_started_at / trial_ends_at sa
--      nastavia pri vzniku firmy (serverový čas) a sú NEMENNÉ. Pozvaný
--      používateľ ani zmena ownera trial neresetuje. Predĺženie = ručný
--      grant v company_entitlements, nie posun trialu. Firmy existujúce
--      pred touto migráciou trial NEMAJÚ (NULL) — ich dnešný prístup
--      zachovajú výslovné granty source='beta_compat' (bod 3b).
--   2b. Po strate nároku ostávajú existujúce dáta čitateľné podľa rolí a
--      upraviteľné tam, kde to dnes RLS dovoľuje; blokuje sa iba vznik
--      nových záznamov/akcií platených modulov, AI a hlas.
--   3. Platené moduly sú samostatné riadky company_entitlements (modulárne,
--      žiadny „pro odomkne všetko"). Nový modul = nový riadok v
--      entitlement_catalog, bez zmeny schémy.
--   4. Nárok NIKDY nerozširuje rolu/oprávnenie. RLS a finance/role RPC sa
--      touto migráciou nemenia; nároky sú ďalšia, samostatná brána.
--   5. Fail closed: neznámy kľúč, chýbajúca firma, poškodený stav = odmietnutie
--      zápisu/plateného úkonu. Čítanie existujúcich dát sa nemení.
--   6. Limity sa kontrolujú iba pri VZNIKU nového záznamu (BEFORE INSERT +
--      advisory lock na firmu+zdroj). Existujúce záznamy nad limitom ostávajú
--      čitateľné, upraviteľné a zmazateľné; nič sa automaticky nemaže.
--
-- ČO SA NEMENÍ: beta allowlist a Auth hook, RLS business tabuliek, storage,
-- role/permissions, OAuth/Push migrácie (ostávajú samostatne neaplikované).
--
-- ROLLBACK (bez straty dát): vrátiť esblu_enforce_plan_limit,
-- esblu_create_company_invite a esblu_accept_company_invite na definície z
-- produkcie pred touto migráciou (PRED aplikovaním ich uložiť cez
-- pg_get_functiondef — postup v docs/closed-beta-and-plans-2026-09-25.md →
-- „Rollback"), zhodiť nové triggery na invoices/companies. Nové tabuľky a
-- stĺpce môžu zostať (neškodné).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Katalóg nárokov (dáta, nie schéma — nový modul = nový riadok).
-- -----------------------------------------------------------------------------
create table if not exists public.entitlement_catalog (
  key text primary key,
  kind text not null,
  included_in_trial boolean not null default false,
  trial_limit integer null,
  limit_reason text null,
  sort_order integer not null default 100,
  constraint entitlement_catalog_key_format check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint entitlement_catalog_kind_check check (kind in ('module', 'capability', 'quota')),
  constraint entitlement_catalog_trial_limit_check check (trial_limit is null or trial_limit >= 0)
);

comment on table public.entitlement_catalog is
  'Zoznam komerčných nárokov (modulov/schopností). included_in_trial + trial_limit '
  'definujú 14-dňový trial firmy. NULL trial_limit = bez kvantitatívneho limitu.';

insert into public.entitlement_catalog (key, kind, included_in_trial, trial_limit, limit_reason, sort_order) values
  ('invoicing',    'module',     true,  null, null,                          10),
  ('ai_documents', 'quota',      true,  5,    'AI_PROCESSING_LIMIT_REACHED', 20),
  ('vehicles',     'module',     true,  2,    'VEHICLE_LIMIT_REACHED',       30),
  ('machines',     'module',     true,  2,    'MACHINE_LIMIT_REACHED',       40),
  ('inventory',    'module',     true,  5,    'INVENTORY_LIMIT_REACHED',     50),
  ('voice',        'capability', false, null, null,                          60),
  ('team_members', 'quota',      true,  1,    'USER_LIMIT_REACHED',          70)
on conflict (key) do update set
  kind = excluded.kind,
  included_in_trial = excluded.included_in_trial,
  trial_limit = excluded.trial_limit,
  limit_reason = excluded.limit_reason,
  sort_order = excluded.sort_order;

alter table public.entitlement_catalog enable row level security;
revoke all on table public.entitlement_catalog from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2) Trial na úrovni firmy (serverový čas, nemenný).
-- -----------------------------------------------------------------------------
alter table public.companies
  add column if not exists trial_started_at timestamptz null,
  add column if not exists trial_ends_at timestamptz null;

-- EXISTUJÚCE (pred-entitlement) beta firmy NEDOSTANÚ trial: trial_* ostáva
-- NULL = „firma vznikla pred zavedením trialu". Žiadny vymyslený dátum
-- registrácie, čas migrácie sa nestane ich „signup". Ich dnešný prístup sa
-- zachová VÝSLOVNE cez granty source='beta_compat' (bod 3b nižšie).
-- Nové firmy dostanú trial pri INSERT (trigger nižšie) — presne raz.

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.companies'::regclass
      and conname = 'companies_trial_window_check'
  ) then
    alter table public.companies
      add constraint companies_trial_window_check
      check (
        (trial_started_at is null and trial_ends_at is null)
        or trial_ends_at = trial_started_at + interval '14 days'
      );
  end if;
end
$migration$;

create or replace function public.esblu_companies_trial_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    -- Klient ani RPC nemôžu trial nastaviť — vždy serverový čas vzniku firmy.
    new.trial_started_at := now();
    new.trial_ends_at := now() + interval '14 days';
    return new;
  end if;

  -- Nemenné aj pre NULL: pred-entitlement firme sa trial nedá dodatočne
  -- „vyrobiť" (ani resetovať/posunúť už bežiaci).
  if new.trial_started_at is distinct from old.trial_started_at
    or new.trial_ends_at is distinct from old.trial_ends_at
  then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_TRIAL_IMMUTABLE',
      hint = 'Trial firmy sa nedá resetovať ani posunúť. Predĺženie = grant v company_entitlements.';
  end if;

  return new;
end
$function$;

revoke all on function public.esblu_companies_trial_guard() from public, anon, authenticated;

drop trigger if exists esblu_companies_trial_guard on public.companies;
create trigger esblu_companies_trial_guard
before insert or update of trial_started_at, trial_ends_at on public.companies
for each row execute function public.esblu_companies_trial_guard();

comment on column public.companies.trial_started_at is
  'Začiatok 14-dňového trialu FIRMY (serverový čas, nemenný). NULL = firma vznikla pred 20260928100000 '
  '(bez trialu; prístup cez granty beta_compat). Pozvaní používatelia nový trial nedostávajú.';
comment on column public.companies.plan is
  'DEPRECATED (20260928100000): už nie je autoritou pre limity ani moduly. '
  'Zdroj pravdy: company_entitlements + trial (esblu_resolve_entitlement). '
  'Ponechané iba pre spätnú kompatibilitu; nový kód ho nesmie čítať. '
  'Hodnota ''admin'' nikdy neznamenala a neznamená žiadne oprávnenie roly.';

-- -----------------------------------------------------------------------------
-- 3) Platené / ručné nároky firmy (modulárne).
-- -----------------------------------------------------------------------------
create table if not exists public.company_entitlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  entitlement_key text not null references public.entitlement_catalog (key),
  source text not null,
  status text not null default 'active',
  valid_from timestamptz not null default now(),
  valid_until timestamptz null,
  limit_value integer null,
  limit_period text null,
  external_ref text null,
  note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default session_user,
  constraint company_entitlements_source_check check (source in ('subscription', 'manual', 'beta_compat')),
  constraint company_entitlements_status_check check (status in ('active', 'suspended', 'revoked')),
  constraint company_entitlements_window_check check (valid_until is null or valid_until > valid_from),
  constraint company_entitlements_limit_check check (limit_value is null or limit_value >= 0),
  constraint company_entitlements_period_check check (limit_period is null or limit_period in ('month', 'total'))
);

comment on table public.company_entitlements is
  'Platené (subscription) a ručné (manual) nároky firmy. Trial NIE JE riadok — '
  'odvodzuje sa z companies.trial_* + entitlement_catalog, preto sa nedá znova vložiť. '
  'Zapisuje iba operátor (postgres/service_role) alebo budúci billing webhook. '
  'limit_value NULL = bez limitu; limit_period (month|total) pre kvóty (ai_documents).';

create index if not exists company_entitlements_lookup_idx
  on public.company_entitlements (company_id, entitlement_key, status);

alter table public.company_entitlements enable row level security;
-- Žiadna politika → default deny pre authenticated/anon. Firma svoje nároky
-- vidí iba cez esblu_get_my_company_entitlements() (bez external_ref/note).
revoke all on table public.company_entitlements from public, anon, authenticated;

create or replace function public.esblu_company_entitlements_touch()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  new.updated_at := now();
  return new;
end
$function$;

revoke all on function public.esblu_company_entitlements_touch() from public, anon, authenticated;

drop trigger if exists esblu_company_entitlements_touch on public.company_entitlements;
create trigger esblu_company_entitlements_touch
before update on public.company_entitlements
for each row execute function public.esblu_company_entitlements_touch();

-- 3b) BACKFILL pred-entitlement beta firiem — výslovné granty
--     source='beta_compat' (auditovateľné, odlíšiteľné od platených, bez
--     konca; operátor ich pred platenou prevádzkou revíduje a nahradí).
--     Zachováva DNEŠNÝ efektívny prístup, nič nové nepridáva:
--       plan pro/admin → všetky moduly bez limitu vrátane hlasu (dnes majú
--                        všetko; 'admin' je iba komerčný príznak, žiadna rola)
--       plan free      → dnešné Free limity z plan_limits (vozidlá 2,
--                        stroje 2, sklad 5), fakturácia a AI spracovanie bez
--                        kvóty (dnes obmedzené iba technickým abuse limitom),
--                        používatelia bez limitu (dnes bez limitu),
--                        HLAS NIE (hlas je iba platený — výslovná politika).
insert into public.company_entitlements (company_id, entitlement_key, source, limit_value, limit_period, note)
select c.id, m.key, 'beta_compat', m.limit_value, null,
       'beta_compat 20260928100000: pred-entitlement firma, companies.plan=' || c.plan
from public.companies c
cross join lateral (
  select k.key,
         case
           when c.plan in ('pro', 'admin') then null
           when k.key = 'vehicles' then (select pl.vehicles from public.plan_limits pl where pl.plan = 'free')
           when k.key = 'machines' then (select pl.machines from public.plan_limits pl where pl.plan = 'free')
           when k.key = 'inventory' then (select pl.inventory_items from public.plan_limits pl where pl.plan = 'free')
           else null
         end as limit_value
  from public.entitlement_catalog k
  where c.plan in ('pro', 'admin') or k.key <> 'voice'
) m
where c.trial_started_at is null
  and not exists (
    select 1 from public.company_entitlements e
    where e.company_id = c.id and e.entitlement_key = m.key
  );

-- -----------------------------------------------------------------------------
-- 4) Ledger AI spracovaní (nezávislý od uložených dokumentov).
-- -----------------------------------------------------------------------------
create table if not exists public.ai_processing_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null,
  endpoint text not null,
  idempotency_key text not null,
  content_sha256 text not null,
  entitlement_source text not null,
  entitlement_id uuid null references public.company_entitlements (id) on delete set null,
  status text not null default 'reserved',
  attempts integer not null default 1,
  reserved_at timestamptz not null default now(),
  finalized_at timestamptz null,
  constraint ai_processing_usage_endpoint_check
    check (endpoint in ('scan-document', 'scan-vehicle-registration', 'scan-vehicle-doc')),
  constraint ai_processing_usage_key_format check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  constraint ai_processing_usage_sha_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_processing_usage_source_check check (entitlement_source in ('trial', 'subscription', 'manual', 'beta_compat')),
  constraint ai_processing_usage_status_check check (status in ('reserved', 'succeeded', 'failed')),
  constraint ai_processing_usage_unique_key unique (company_id, idempotency_key)
);

comment on table public.ai_processing_usage is
  'Jeden riadok = jedno prijaté AI spracovanie dokumentu (1 dokument, 1+ volaní modelu). '
  'Zmazanie dokumentu kredit NEVRACIA (ledger nemá väzbu na documents). '
  'reserved + succeeded sa počítajú do kvóty; failed (chyba/nedostupnosť AI) nie.';

create index if not exists ai_processing_usage_company_idx
  on public.ai_processing_usage (company_id, entitlement_source, status, reserved_at);

alter table public.ai_processing_usage enable row level security;
revoke all on table public.ai_processing_usage from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5) Resolver — JEDINÁ autorita pre nárok (DB aj server ho volajú).
-- -----------------------------------------------------------------------------
create or replace function public.esblu_resolve_entitlement(p_company_id uuid, p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_catalog record;
  v_company record;
  v_grant record;
  v_trial_active boolean;
  v_denied_reason text;
begin
  select * into v_catalog from public.entitlement_catalog where key = p_key;
  if not found then
    return jsonb_build_object('key', p_key, 'active', false, 'reason', 'ENTITLEMENT_REQUIRED');
  end if;

  select c.id, c.trial_started_at, c.trial_ends_at into v_company
  from public.companies c where c.id = p_company_id;
  if not found then
    return jsonb_build_object('key', p_key, 'active', false, 'reason', 'ENTITLEMENT_REQUIRED');
  end if;

  -- NULL trial = pred-entitlement firma (nikdy nemala trial) → iba granty.
  v_trial_active := coalesce(now() >= v_company.trial_started_at and now() < v_company.trial_ends_at, false);

  -- Platený/ručný nárok má prednosť. Viac platných riadkov: bez limitu
  -- vyhráva, inak najvyšší limit (deterministicky podľa id).
  select e.id, e.source, e.limit_value, e.limit_period, e.valid_until into v_grant
  from public.company_entitlements e
  where e.company_id = p_company_id
    and e.entitlement_key = p_key
    and e.status = 'active'
    and e.valid_from <= now()
    and (e.valid_until is null or e.valid_until > now())
  order by (e.limit_value is null) desc, e.limit_value desc nulls first, e.id
  limit 1;

  if found then
    return jsonb_build_object(
      'key', p_key, 'active', true, 'source', v_grant.source,
      'entitlement_id', v_grant.id, 'limit', v_grant.limit_value,
      'limit_period', v_grant.limit_period, 'valid_until', v_grant.valid_until,
      'trial_active', v_trial_active, 'trial_ends_at', v_company.trial_ends_at
    );
  end if;

  if v_catalog.included_in_trial and v_trial_active then
    return jsonb_build_object(
      'key', p_key, 'active', true, 'source', 'trial', 'entitlement_id', null,
      'limit', v_catalog.trial_limit, 'limit_period', 'trial',
      'valid_until', v_company.trial_ends_at,
      'trial_active', true, 'trial_ends_at', v_company.trial_ends_at
    );
  end if;

  v_denied_reason := case
    when p_key = 'voice' then 'VOICE_ENTITLEMENT_REQUIRED'
    when v_catalog.included_in_trial and v_company.trial_ends_at is not null
         and now() >= v_company.trial_ends_at then 'TRIAL_EXPIRED'
    else 'ENTITLEMENT_REQUIRED'
  end;

  return jsonb_build_object(
    'key', p_key, 'active', false, 'reason', v_denied_reason,
    'trial_active', v_trial_active, 'trial_ends_at', v_company.trial_ends_at
  );
end
$function$;

revoke all on function public.esblu_resolve_entitlement(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_resolve_entitlement(uuid, text) to service_role;

-- Jednotná štruktúrovaná výnimka: message = ENTITLEMENT_DENIED:<REASON>:<key>,
-- detail = JSON {reason,key,limit,current}. Klient parsuje iba message prefix.
create or replace function public.esblu_raise_entitlement_denial(
  p_reason text, p_key text, p_limit integer default null, p_current bigint default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'P0001',
    message = 'ENTITLEMENT_DENIED:' || p_reason || ':' || p_key,
    detail = jsonb_build_object('reason', p_reason, 'key', p_key, 'limit', p_limit, 'current', p_current)::text;
end
$function$;

revoke all on function public.esblu_raise_entitlement_denial(text, text, integer, bigint) from public, anon, authenticated;

-- Brána pre vznik nového záznamu: aktívny nárok + (ak je limit) current < limit.
create or replace function public.esblu_require_entitlement_capacity(
  p_company_id uuid, p_key text, p_current bigint
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_ent jsonb;
  v_limit integer;
  v_reason text;
begin
  v_ent := public.esblu_resolve_entitlement(p_company_id, p_key);

  if coalesce((v_ent ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial(coalesce(v_ent ->> 'reason', 'ENTITLEMENT_REQUIRED'), p_key);
  end if;

  v_limit := (v_ent ->> 'limit')::integer;
  if v_limit is not null and coalesce(p_current, 0) >= v_limit then
    select coalesce(k.limit_reason, 'ENTITLEMENT_LIMIT_REACHED') into v_reason
    from public.entitlement_catalog k where k.key = p_key;
    perform public.esblu_raise_entitlement_denial(coalesce(v_reason, 'ENTITLEMENT_LIMIT_REACHED'), p_key, v_limit, p_current);
  end if;

  return v_ent;
end
$function$;

revoke all on function public.esblu_require_entitlement_capacity(uuid, text, bigint) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6) Limity vozidiel / strojov / skladu + modul AI evidencie (DB trigger).
--    Rovnaký trigger ako doteraz (rovnaké meno, rovnaké tabuľky), iba zdroj
--    pravdy je nárok, nie companies.plan. Platí pre UI, API, asistenta aj hlas.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_enforce_plan_limit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  authenticated_user_id uuid := auth.uid();
  request_role text := coalesce(auth.role(), '');
  is_privileged boolean := false;
  v_company_id uuid;
  v_key text;
  current_usage bigint;
begin
  if new.user_id is null then
    raise exception using errcode = '23502', message = 'PLAN_LIMIT_USER_MISSING';
  end if;

  is_privileged :=
    request_role = 'service_role'
    or session_user in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin');

  if not is_privileged
    and (authenticated_user_id is null or new.user_id is distinct from authenticated_user_id)
  then
    raise exception using errcode = '42501', message = 'PLAN_LIMIT_USER_MISMATCH';
  end if;

  v_key := case tg_table_name
    when 'vehicles' then 'vehicles'
    when 'machines' then 'machines'
    when 'inventory_items' then 'inventory'
    when 'ai_evidence' then 'ai_documents'
  end;

  if tg_table_schema <> 'public' or v_key is null then
    raise exception using
      errcode = 'P0001',
      message = 'PLAN_LIMIT_UNSUPPORTED_RESOURCE:' || tg_table_schema || '.' || tg_table_name;
  end if;

  if is_privileged and new.company_id is not null then
    v_company_id := new.company_id;
  else
    select cm.company_id into v_company_id
    from public.company_members cm
    where cm.user_id = authenticated_user_id and cm.status = 'active'
    limit 1;
  end if;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP:' || tg_table_schema || '.' || tg_table_name;
  end if;

  new.company_id := v_company_id;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':' || tg_table_name, 0));

  if v_key = 'ai_documents' then
    -- Záznamy AI evidencie nie sú kvóta (kvóta = AI spracovania v ledgri);
    -- vyžaduje sa iba aktívny modul. Počet uložených riadkov sa nepočíta.
    perform public.esblu_require_entitlement_capacity(v_company_id, v_key, null);
    return new;
  end if;

  execute format('select count(*) from public.%I where company_id = $1', tg_table_name)
    into current_usage using v_company_id;

  perform public.esblu_require_entitlement_capacity(v_company_id, v_key, current_usage);
  return new;
end
$function$;

revoke all on function public.esblu_enforce_plan_limit() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7) eFaktúra / fakturácia: vznik faktúry a finalizácia vyžadujú modul.
--    Úpravy existujúcich draftov a úhrady finalizovaných faktúr ostávajú.
-- -----------------------------------------------------------------------------
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
    perform public.esblu_require_entitlement_capacity(new.company_id, 'invoicing', null);
    return new;
  end if;

  if old.document_status = 'draft' and new.document_status = 'finalized' then
    perform public.esblu_require_entitlement_capacity(new.company_id, 'invoicing', null);
  end if;
  return new;
end
$function$;

revoke all on function public.esblu_enforce_invoicing_entitlement() from public, anon, authenticated;

drop trigger if exists esblu_invoicing_entitlement_guard on public.invoices;
create trigger esblu_invoicing_entitlement_guard
before insert or update of document_status on public.invoices
for each row execute function public.esblu_enforce_invoicing_entitlement();

-- -----------------------------------------------------------------------------
-- 8) Limit používateľov: pozvánka aj jej prijatie (jediné cesty do firmy —
--    company_members nemá INSERT grant pre authenticated; owner vzniká iba v
--    esblu_ensure_my_owner_company pri novej firme).
--    Pri vytvorení pozvánky: aktívni členovia + čakajúce neexpirované
--    pozvánky < limit. Pri prijatí: aktívni členovia < limit. Oboje pod
--    advisory lockom firmy → dve súbežné pozvánky nemôžu obe prejsť.
--    Existujúci členovia sa NIKDY neodoberajú.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_create_company_invite(p_email text, p_role text)
returns table(invite_id uuid, token text, expires_at timestamp with time zone, email text, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_caller_role text;
  v_email text;
  v_role text;
  v_raw_token text;
  v_token_hash text;
  v_invite_id uuid;
  v_expires_at timestamptz;
  v_existing_member_count integer;
  v_existing_pending_count integer;
  v_seats_used bigint;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  v_role := lower(btrim(coalesce(p_role, '')));

  if v_role not in ('admin', 'accountant', 'employee') then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_INVITE_ROLE:' || coalesce(p_role, '');
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));

  if v_email = '' or v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_INVITE_EMAIL';
  end if;

  select m.company_id, m.role into v_company_id, v_caller_role
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
  limit 1;

  -- Rola sa overuje PRED nárokom: nárok nikdy nerozširuje oprávnenie a
  -- neoprávnený volajúci sa nedozvie nič o nárokoch firmy.
  if v_company_id is null or v_caller_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;

  select count(*) into v_existing_member_count
  from public.company_members m
  join auth.users u on u.id = m.user_id
  where m.company_id = v_company_id and m.status = 'active' and lower(u.email) = v_email;

  if v_existing_member_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_MEMBER';
  end if;

  select count(*) into v_existing_pending_count
  from public.company_invites ci
  where ci.company_id = v_company_id and ci.email = v_email
    and ci.status = 'pending' and ci.expires_at > now();

  if v_existing_pending_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_PENDING';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':team_members', 0));

  select
    (select count(*) from public.company_members m
      where m.company_id = v_company_id and m.status = 'active')
    + (select count(*) from public.company_invites ci
      where ci.company_id = v_company_id and ci.status = 'pending' and ci.expires_at > now())
  into v_seats_used;

  perform public.esblu_require_entitlement_capacity(v_company_id, 'team_members', v_seats_used);

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_expires_at := now() + interval '7 days';

  insert into public.company_invites (company_id, email, role, invited_by, token_hash, status, expires_at)
  values (v_company_id, v_email, v_role, v_uid, v_token_hash, 'pending', v_expires_at)
  returning id into v_invite_id;

  return query select v_invite_id, v_raw_token, v_expires_at, v_email, v_role;
end;
$function$;

revoke all on function public.esblu_create_company_invite(text, text) from public, anon;
grant execute on function public.esblu_create_company_invite(text, text) to authenticated, service_role;

create or replace function public.esblu_accept_company_invite(p_token text)
returns table(company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_email text;
  v_token_hash text;
  v_invite record;
  v_existing_active_count integer;
  v_active_members bigint;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TOKEN';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  if v_email is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;

  v_email := lower(btrim(v_email));
  v_token_hash := encode(extensions.digest(btrim(p_token), 'sha256'), 'hex');

  select ci.* into v_invite
  from public.company_invites ci
  where ci.token_hash = v_token_hash
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TOKEN';
  end if;

  if v_invite.status = 'accepted' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_ACCEPTED';
  end if;

  if v_invite.status = 'revoked' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_REVOKED';
  end if;

  if v_invite.status = 'expired' or v_invite.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_EXPIRED';
  end if;

  if v_invite.email <> v_email then
    raise exception using errcode = '42501', message = 'ESBLU_INVITE_EMAIL_MISMATCH';
  end if;

  select count(*) into v_existing_active_count
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active';

  if v_existing_active_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP';
  end if;

  -- Limit používateľov znova pri prijatí (pozvánka mohla vzniknúť počas
  -- plateného obdobia, ktoré medzitým skončilo). Rovnaký lock ako pri
  -- vytváraní pozvánky → žiadne dve súbežné prijatia nad limit.
  perform pg_advisory_xact_lock(hashtextextended(v_invite.company_id::text || ':team_members', 0));

  select count(*) into v_active_members
  from public.company_members m
  where m.company_id = v_invite.company_id and m.status = 'active';

  perform public.esblu_require_entitlement_capacity(v_invite.company_id, 'team_members', v_active_members);

  begin
    insert into public.company_members (company_id, user_id, role, status)
    values (v_invite.company_id, v_uid, v_invite.role, 'active');
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP';
  end;

  update public.company_invites
  set status = 'accepted', accepted_at = now(), accepted_by = v_uid
  where id = v_invite.id;

  return query select v_invite.company_id, v_invite.role;
end;
$function$;

revoke all on function public.esblu_accept_company_invite(text) from public, anon;
grant execute on function public.esblu_accept_company_invite(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 9) AI spracovanie: rezervácia (pred volaním AI) a finalizácia (po ňom).
--
--   • Rezervuje sa AŽ po autentifikácii, overení firmy a validácii vstupu,
--     tesne pred prvým volaním modelu. Zamietnuté požiadavky nič nespotrebujú.
--   • Idempotencia: (company_id, idempotency_key) je unikátne. Opakovanie s
--     rovnakým kľúčom A rovnakým obsahom (sha256) do 24 h a najviac 3-krát
--     nespotrebuje nový kredit. Iný obsah pod rovnakým kľúčom = konflikt.
--   • Kvóta: reserved + succeeded. failed (chyba/timeout AI na strane
--     servera, ktorý stihol finalizovať) sa nepočíta. Pád servera pred
--     finalizáciou nechá riadok 'reserved' → počíta sa (fail closed); jeho
--     retry s rovnakým kľúčom ho použije bez ďalšieho kreditu.
--   • Súbežnosť: advisory lock firmy → #5 a #6 nemôžu obe prejsť.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_reserve_ai_processing(
  p_endpoint text, p_idempotency_key text, p_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_existing record;
  v_ent jsonb;
  v_limit integer;
  v_period text;
  v_source text;
  v_ent_id uuid;
  v_used bigint;
  v_usage_id uuid;
  v_found boolean := false;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_endpoint is null or p_endpoint not in ('scan-document', 'scan-vehicle-registration', 'scan-vehicle-doc') then
    raise exception using errcode = 'P0001', message = 'ESBLU_AI_ENDPOINT_UNKNOWN';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_AI_IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_AI_CONTENT_HASH_INVALID';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
  limit 1;

  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':ai_processing', 0));

  select u.* into v_existing
  from public.ai_processing_usage u
  where u.company_id = v_company_id and u.idempotency_key = p_idempotency_key
  for update;
  v_found := found;

  if v_found then
    if v_existing.content_sha256 <> p_content_sha256 or v_existing.user_id <> v_uid
      or v_existing.endpoint <> p_endpoint then
      raise exception using errcode = 'P0001', message = 'ESBLU_AI_IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.attempts >= 3 or v_existing.reserved_at < now() - interval '24 hours' then
      raise exception using errcode = 'P0001', message = 'ESBLU_AI_IDEMPOTENCY_EXPIRED';
    end if;
    if v_existing.status in ('reserved', 'succeeded') then
      update public.ai_processing_usage
      set attempts = attempts + 1, status = 'reserved', finalized_at = null
      where id = v_existing.id;
      return jsonb_build_object('usage_id', v_existing.id, 'reused', true, 'source', v_existing.entitlement_source);
    end if;
    -- 'failed' → nový pokus sa započíta, ak je kapacita (nižšie).
  end if;

  v_ent := public.esblu_resolve_entitlement(v_company_id, 'ai_documents');
  if coalesce((v_ent ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial(coalesce(v_ent ->> 'reason', 'ENTITLEMENT_REQUIRED'), 'ai_documents');
  end if;

  v_limit := (v_ent ->> 'limit')::integer;
  v_period := v_ent ->> 'limit_period';
  v_source := v_ent ->> 'source';
  v_ent_id := nullif(v_ent ->> 'entitlement_id', '')::uuid;

  if v_limit is not null then
    if v_source = 'trial' then
      select count(*) into v_used from public.ai_processing_usage u
      where u.company_id = v_company_id and u.entitlement_source = 'trial'
        and u.status in ('reserved', 'succeeded');
    elsif v_period = 'month' then
      select count(*) into v_used from public.ai_processing_usage u
      where u.company_id = v_company_id and u.entitlement_id = v_ent_id
        and u.status in ('reserved', 'succeeded')
        and u.reserved_at >= date_trunc('month', now());
    else
      select count(*) into v_used from public.ai_processing_usage u
      where u.company_id = v_company_id and u.entitlement_id = v_ent_id
        and u.status in ('reserved', 'succeeded');
    end if;

    if v_used >= v_limit then
      perform public.esblu_raise_entitlement_denial('AI_PROCESSING_LIMIT_REACHED', 'ai_documents', v_limit, v_used);
    end if;
  end if;

  if v_found then
    update public.ai_processing_usage
    set attempts = attempts + 1, status = 'reserved', finalized_at = null,
        entitlement_source = v_source, entitlement_id = v_ent_id, reserved_at = now()
    where id = v_existing.id
    returning id into v_usage_id;
  else
    insert into public.ai_processing_usage
      (company_id, user_id, endpoint, idempotency_key, content_sha256, entitlement_source, entitlement_id)
    values
      (v_company_id, v_uid, p_endpoint, p_idempotency_key, p_content_sha256, v_source, v_ent_id)
    returning id into v_usage_id;
  end if;

  return jsonb_build_object('usage_id', v_usage_id, 'reused', false, 'source', v_source,
    'limit', v_limit, 'used', coalesce(v_used, 0) + 1);
end
$function$;

revoke all on function public.esblu_reserve_ai_processing(text, text, text) from public, anon;
grant execute on function public.esblu_reserve_ai_processing(text, text, text) to authenticated, service_role;

create or replace function public.esblu_finalize_ai_processing(p_usage_id uuid, p_succeeded boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  -- Iba 'reserved' → výsledok, iba vlastník rezervácie. 'succeeded' sa už
  -- nedá zmeniť na 'failed' (žiadne dodatočné „vrátenie" kreditu).
  update public.ai_processing_usage
  set status = case when p_succeeded then 'succeeded' else 'failed' end,
      finalized_at = now()
  where id = p_usage_id and user_id = v_uid and status = 'reserved';
end
$function$;

revoke all on function public.esblu_finalize_ai_processing(uuid, boolean) from public, anon;
grant execute on function public.esblu_finalize_ai_processing(uuid, boolean) to authenticated, service_role;

-- Technický abuse limit (existujúci esblu_consume_ai_scan_quota) aj pre
-- ďalšie AI endpointy — doteraz ho mal iba scan-document; scan-vehicle-*
-- nemali žiadny strop ani kontrolu členstva. Rovnaké hodnoty ako scan-document.
insert into public.ai_scan_limits (endpoint, max_per_hour, max_per_day)
values ('scan-vehicle-registration', 60, 240), ('scan-vehicle-doc', 60, 240)
on conflict (endpoint) do nothing;

-- -----------------------------------------------------------------------------
-- 10) Serverová brána pre schopnosť (napr. hlas) — firma zo session.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_require_my_entitlement(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_ent jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
  limit 1;

  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  v_ent := public.esblu_resolve_entitlement(v_company_id, p_key);
  if coalesce((v_ent ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial(coalesce(v_ent ->> 'reason', 'ENTITLEMENT_REQUIRED'), p_key);
  end if;

  return jsonb_build_object('key', p_key, 'active', true, 'source', v_ent ->> 'source');
end
$function$;

revoke all on function public.esblu_require_my_entitlement(text) from public, anon;
grant execute on function public.esblu_require_my_entitlement(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 11) Prehľad pre UI/asistenta (iba vlastná firma; bez external_ref/note/cien).
-- -----------------------------------------------------------------------------
create or replace function public.esblu_get_my_company_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company record;
  v_items jsonb;
  v_ai_trial_used bigint;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select c.id, c.trial_started_at, c.trial_ends_at into v_company
  from public.company_members cm
  join public.companies c on c.id = cm.company_id
  where cm.user_id = v_uid and cm.status = 'active'
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  select jsonb_agg(
           (public.esblu_resolve_entitlement(v_company.id, k.key) - 'entitlement_id')
           order by k.sort_order)
  into v_items
  from public.entitlement_catalog k;

  select count(*) into v_ai_trial_used
  from public.ai_processing_usage u
  where u.company_id = v_company.id and u.entitlement_source = 'trial'
    and u.status in ('reserved', 'succeeded');

  return jsonb_build_object(
    'company_id', v_company.id,
    'server_time', now(),
    'trial', jsonb_build_object(
      'started_at', v_company.trial_started_at,
      'ends_at', v_company.trial_ends_at,
      'active', coalesce(now() < v_company.trial_ends_at, false),
      'ai_processing_used', v_ai_trial_used
    ),
    'entitlements', coalesce(v_items, '[]'::jsonb)
  );
end
$function$;

revoke all on function public.esblu_get_my_company_entitlements() from public, anon;
grant execute on function public.esblu_get_my_company_entitlements() to authenticated, service_role;

-- esblu_company_plan() zostáva (nič v DB ju už nevolá) — iba spätná
-- kompatibilita; EXECUTE ostáva obmedzené (bez zmeny ACL).
comment on function public.esblu_company_plan(uuid) is
  'DEPRECATED (20260928100000): nepoužíva sa na limity ani moduly. Pozri esblu_resolve_entitlement.';
