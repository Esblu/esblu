-- =============================================================================
-- Pricing + entitlements architektúra (Esblu Komplet / moduly / add-ony) — 2026-10-26
-- REPO + STAGING ONLY. Nič neaktivuje live billing ani live eFaktúru.
--
-- Kanonické ceny žijú v lib/pricing.ts (TS engine). DB drží IBA to, čo firma
-- smie (nároky + limity) — billing provider (Stripe / Google Play / Apple,
-- zatiaľ nič live) je zdroj platobného STAVU (subscription_accounts), výber
-- plánu (company_plan_selection) je zdroj KOMPOZÍCIE a
-- esblu_plan_entitlement_targets() je JEDINÉ pravidlo plán → nároky
-- (SQL zrkadlo entitlementTargets() z lib/pricing.ts, paritný test).
--
-- Zásady:
--   - subscription patrí FIRME; billing authority = owner aktívnej firmy,
--   - limity sú per firma (nikdy zdieľané), čítajú sa vždy pre AKTÍVNU firmu,
--   - trial 14 dní z overeného právneho subjektu (bez zmeny, trial_claims),
--   - nič sa nemaže: downgrade / koniec trialu / koniec predplatného iba
--     odvolá nároky na NOVÉ zápisy, dáta ostávajú,
--   - klient nikdy nezapisuje plán, add-ony ani usage (iba service_role;
--     staging mock iba s explicitným billing_runtime_config.allow_mock_plans).
-- =============================================================================

-- ----------------------------------------------------------------------------- 1) runtime prepínače
alter table public.billing_runtime_config add column if not exists allow_mock_plans boolean not null default false;
alter table public.billing_runtime_config add column if not exists einvoice_sellable boolean not null default false;
comment on column public.billing_runtime_config.allow_mock_plans is
  'STAGING ONLY: povolí esblu_staging_mock_set_plan. V produkcii musí ostať false.';
comment on column public.billing_runtime_config.einvoice_sellable is
  'eFaktúra predajná (modul + tx kvóta). false, kým eFaktúra nie je live (provider, API, CLIA, účtovníctvo, súhlas).';

-- ----------------------------------------------------------------------------- 2) katalóg nárokov
-- Trial (14 dní): všetky hlavné moduly bez kusových limitov, 25 používateľov,
-- 10 AI spracovaní, 15 min hlasu, 1 GB. eFaktúra mimo trialu (nie je live).
insert into public.entitlement_catalog (key, kind, included_in_trial, trial_limit, limit_reason, sort_order) values
  ('invoicing',             'module',     true,  null, null,                          10),
  ('einvoice',              'module',     false, null, null,                          15),
  ('einvoice_transactions', 'quota',      false, null, 'EINVOICE_LIMIT_REACHED',      16),
  ('ai_documents',          'quota',      true,  10,   'AI_PROCESSING_LIMIT_REACHED', 20),
  ('vehicles',              'module',     true,  null, 'VEHICLE_LIMIT_REACHED',       30),
  ('machines',              'module',     true,  null, 'MACHINE_LIMIT_REACHED',       40),
  ('inventory',             'module',     true,  null, 'INVENTORY_LIMIT_REACHED',     50),
  ('voice',                 'capability', true,  null, null,                          60),
  ('voice_minutes',         'quota',      true,  15,   'VOICE_LIMIT_REACHED',         65),
  ('team_members',          'quota',      true,  25,   'USER_LIMIT_REACHED',          70),
  ('storage_mb',            'quota',      true,  1024, 'STORAGE_LIMIT_REACHED',       80)
on conflict (key) do update set
  kind = excluded.kind,
  included_in_trial = excluded.included_in_trial,
  trial_limit = excluded.trial_limit,
  limit_reason = excluded.limit_reason,
  sort_order = excluded.sort_order;

-- Legacy firmy s ručnými / beta nárokmi (dnešná produkcia: pro/admin/free z
-- 20260928100000) si zachovajú dnešné správanie aj pre nové kvóty: kto má
-- aktívny ručný/beta nárok, dostane ručné nároky nových kvót bez limitu
-- (voice_minutes iba ak má `voice`). Idempotentné. Rozhodnutie o ich
-- migrácii na Komplet = OWNER DECISION pri spustení.
insert into public.company_entitlements (company_id, entitlement_key, source, status, valid_from, limit_value, limit_period, note)
select distinct e.company_id, k.key, 'manual', 'active', now(), null::integer, null::text, 'backfill 20261026100000: legacy grant'
from public.company_entitlements e
cross join (values ('storage_mb'), ('voice_minutes')) k(key)
where e.status = 'active' and e.source in ('manual', 'beta_compat')
  and (e.valid_until is null or e.valid_until > now())
  and (k.key <> 'voice_minutes' or exists (
    select 1 from public.company_entitlements v
    where v.company_id = e.company_id and v.entitlement_key = 'voice' and v.status = 'active'
      and v.source in ('manual', 'beta_compat')))
  and not exists (
    select 1 from public.company_entitlements x
    where x.company_id = e.company_id and x.entitlement_key = k.key and x.source = 'manual');

-- ----------------------------------------------------------------------------- 3) kanonické plány
insert into public.subscription_plans (plan_code, status, sort_order) values
  ('esblu_complete',           'approved', 100),
  ('esblu_complete_secondary', 'approved', 110),
  ('esblu_modular',            'approved', 120)
on conflict (plan_code) do nothing;

-- ----------------------------------------------------------------------------- 4) výber plánu (kompozícia)
create table if not exists public.company_plan_selection (
  company_id uuid primary key references public.companies(id) on delete cascade,
  plan_kind text not null,
  price_tier text not null,
  modules text[] not null default '{}',
  ai_packs integer not null default 0,
  voice_packs integer not null default 0,
  user_packs integer not null default 0,
  einvoice_40_packs integer not null default 0,
  einvoice_100_packs integer not null default 0,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  constraint company_plan_selection_kind_check check (plan_kind in ('complete', 'modular')),
  constraint company_plan_selection_tier_check check (price_tier in ('primary', 'secondary')),
  constraint company_plan_selection_modules_check check (
    modules <@ array['vehicles', 'machines', 'inventory', 'invoicing', 'documents', 'einvoice']::text[]),
  constraint company_plan_selection_packs_check check (
    ai_packs between 0 and 50 and voice_packs between 0 and 50 and user_packs between 0 and 50
    and einvoice_40_packs between 0 and 50 and einvoice_100_packs between 0 and 50),
  constraint company_plan_selection_source_check check (source in ('provider', 'staging_mock'))
);
alter table public.company_plan_selection enable row level security;
alter table public.company_plan_selection force row level security;
revoke all on table public.company_plan_selection from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.company_plan_selection to service_role;

-- ----------------------------------------------------------------------------- 5) usage počítadlá (hlas, eFaktúra)
-- AI spracovania majú vlastný ledger (ai_processing_usage); používatelia =
-- aktívne členstvá; úložisko = súčet objektov firmy. Tu iba metriky bez ledgra.
create table if not exists public.company_usage_counters (
  company_id uuid not null references public.companies(id) on delete cascade,
  metric text not null,
  period_start timestamptz not null,
  used numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now(),
  constraint company_usage_counters_pk primary key (company_id, metric, period_start),
  constraint company_usage_counters_metric_check check (metric in ('voice_seconds', 'einvoice_tx')),
  constraint company_usage_counters_used_check check (used >= 0)
);
alter table public.company_usage_counters enable row level security;
alter table public.company_usage_counters force row level security;
revoke all on table public.company_usage_counters from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.company_usage_counters to service_role;

-- ----------------------------------------------------------------------------- 6) pravidlo plán → nároky
-- SQL zrkadlo entitlementTargets() z lib/pricing.ts. Jediné miesto pravidla.
create or replace function public.esblu_plan_entitlement_targets(
  p_plan_kind text,
  p_modules text[],
  p_ai_packs integer,
  p_voice_packs integer,
  p_user_packs integer,
  p_einvoice_40_packs integer,
  p_einvoice_100_packs integer,
  p_einvoice_available boolean
)
returns table (entitlement_key text, limit_value integer, limit_period text)
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_base text[] := array['vehicles', 'machines', 'inventory', 'invoicing', 'documents', 'einvoice'];
  v_sellable text[];
  v_modules text[];
  v_voice integer;
  m text;
begin
  if p_plan_kind not in ('complete', 'modular') then
    return;
  end if;
  v_sellable := case when coalesce(p_einvoice_available, false) then v_base else array_remove(v_base, 'einvoice') end;
  if p_plan_kind = 'complete' then
    v_modules := v_sellable;
  else
    select coalesce(array_agg(b order by array_position(v_base, b)), '{}') into v_modules
    from unnest(v_sellable) b where b = any (coalesce(p_modules, '{}'));
  end if;

  foreach m in array v_modules loop
    if m = 'documents' then
      entitlement_key := 'ai_documents';
      limit_value := 40 + 40 * least(greatest(coalesce(p_ai_packs, 0), 0), 50);
      limit_period := 'month';
    else
      entitlement_key := m; limit_value := null; limit_period := null;
    end if;
    return next;
  end loop;

  v_voice := case when p_plan_kind = 'complete' then 60 else 0 end
             + 60 * least(greatest(coalesce(p_voice_packs, 0), 0), 50);
  if v_voice > 0 then
    entitlement_key := 'voice'; limit_value := null; limit_period := null; return next;
    entitlement_key := 'voice_minutes'; limit_value := v_voice; limit_period := 'month'; return next;
  end if;

  entitlement_key := 'team_members';
  limit_value := 25 + 25 * least(greatest(coalesce(p_user_packs, 0), 0), 50);
  limit_period := null;
  return next;

  entitlement_key := 'storage_mb'; limit_value := 5120; limit_period := null; return next;

  if 'einvoice' = any (v_modules) then
    entitlement_key := 'einvoice_transactions';
    limit_value := 20 + 40 * least(greatest(coalesce(p_einvoice_40_packs, 0), 0), 50)
                      + 100 * least(greatest(coalesce(p_einvoice_100_packs, 0), 0), 50);
    limit_period := 'month';
    return next;
  end if;
end
$function$;
revoke all on function public.esblu_plan_entitlement_targets(text, text[], integer, integer, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.esblu_plan_entitlement_targets(text, text[], integer, integer, integer, integer, integer, boolean) to service_role;

-- Ciele nárokov pre firmu: kanonický plán → z výberu; iné (test fixtures) → plan_entitlements.
create or replace function public.esblu_billing_plan_targets(p_company_id uuid, p_plan_code text)
returns table (entitlement_key text, limit_value integer, limit_period text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_sel record;
  v_einvoice boolean;
begin
  if p_plan_code in ('esblu_complete', 'esblu_complete_secondary', 'esblu_modular') then
    select * into v_sel from public.company_plan_selection s where s.company_id = p_company_id;
    if not found then
      return; -- bez kompozície žiadne nároky (fail closed)
    end if;
    select coalesce(bool_or(c.einvoice_sellable), false) into v_einvoice from public.billing_runtime_config c;
    return query
      select t.entitlement_key, t.limit_value, t.limit_period
      from public.esblu_plan_entitlement_targets(v_sel.plan_kind, v_sel.modules, v_sel.ai_packs, v_sel.voice_packs,
             v_sel.user_packs, v_sel.einvoice_40_packs, v_sel.einvoice_100_packs, v_einvoice) t;
    return;
  end if;
  return query
    select pe.entitlement_key, pe.limit_value, pe.limit_period
    from public.subscription_plan_entitlements pe where pe.plan_code = p_plan_code;
end
$function$;
revoke all on function public.esblu_billing_plan_targets(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_billing_plan_targets(uuid, text) to service_role;

-- ----------------------------------------------------------------------------- 7) subscription → nároky (provider-agnostické)
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
    elsif v_acc.status = 'grace_period' and coalesce(v_acc.grace_until, v_acc.current_period_end) is not null then
      v_until := coalesce(v_acc.grace_until, v_acc.current_period_end);
      v_entitled := v_until > now();
    end if;
    -- Všetky ostatné stavy → nároky odvolané (dáta ostávajú).
  end if;

  if v_entitled then
    for v_item in
      select t.entitlement_key, t.limit_value, t.limit_period
      from public.esblu_billing_plan_targets(p_company_id, v_acc.plan_code) t
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

    -- Downgrade: nároky mimo plánu sa odvolajú (dáta ostávajú, nič sa nemaže).
    update public.company_entitlements e
    set status = 'revoked'
    where e.company_id = p_company_id and e.source = 'subscription' and e.status <> 'revoked'
      and not exists (select 1 from public.esblu_billing_plan_targets(p_company_id, v_acc.plan_code) t
                      where t.entitlement_key = e.entitlement_key);
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

-- ----------------------------------------------------------------------------- 8) kanonické obdobie čerpania
-- trial → začiatok trialu; month → aktuálne obdobie predplatného (provider
-- anchor), inak kalendárny mesiac (manual / bez providera); total → epoch.
create or replace function public.esblu_usage_period_start(p_company_id uuid, p_limit_period text)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_acc record;
  v_trial timestamptz;
begin
  if p_limit_period = 'trial' then
    select c.trial_started_at into v_trial from public.companies c where c.id = p_company_id;
    return coalesce(v_trial, date_trunc('month', now()));
  end if;
  if p_limit_period = 'month' then
    select a.current_period_start, a.current_period_end into v_acc
    from public.subscription_accounts a
    where a.company_id = p_company_id and a.current_period_start is not null
      and a.current_period_start <= now() and a.current_period_end > now();
    if found then
      return v_acc.current_period_start;
    end if;
    return date_trunc('month', now());
  end if;
  return 'epoch'::timestamptz;
end
$function$;
revoke all on function public.esblu_usage_period_start(uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_usage_period_start(uuid, text) to service_role;

-- ----------------------------------------------------------------------------- 9) AI kvóta — obdobie podľa predplatného
-- Jediná zmena oproti 20261012140000: mesačný limit sa počíta od začiatku
-- aktuálneho obdobia predplatného (provider anchor), nie od kalendárneho mesiaca.
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
      and cm.company_id = public.esblu_my_active_company_id()
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
        and u.reserved_at >= public.esblu_usage_period_start(v_company_id, 'month');
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

-- ----------------------------------------------------------------------------- 10) hlas — minúty
-- Stav kvóty hlasu pre firmu (bez výnimky): aktívny nárok voice + voice_minutes.
create or replace function public.esblu_voice_usage_status(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_voice jsonb := public.esblu_resolve_entitlement(p_company_id, 'voice');
  v_min jsonb := public.esblu_resolve_entitlement(p_company_id, 'voice_minutes');
  v_period timestamptz;
  v_used numeric := 0;
  v_limit integer;
begin
  if coalesce((v_voice ->> 'active')::boolean, false) is not true or coalesce((v_min ->> 'active')::boolean, false) is not true then
    return jsonb_build_object('active', false, 'reason', coalesce(v_voice ->> 'reason', v_min ->> 'reason', 'VOICE_ENTITLEMENT_REQUIRED'));
  end if;
  v_limit := (v_min ->> 'limit')::integer;
  v_period := public.esblu_usage_period_start(p_company_id, coalesce(v_min ->> 'limit_period', 'month'));
  select coalesce(sum(c.used), 0) into v_used from public.company_usage_counters c
  where c.company_id = p_company_id and c.metric = 'voice_seconds' and c.period_start = v_period;
  return jsonb_build_object('active', true, 'limit_minutes', v_limit, 'used_seconds', v_used,
    'period_start', v_period, 'exhausted', v_limit is not null and v_used >= v_limit * 60);
end
$function$;
revoke all on function public.esblu_voice_usage_status(uuid) from public, anon, authenticated;
grant execute on function public.esblu_voice_usage_status(uuid) to service_role;

-- Brána pred prepisom (user-scoped, aktívna firma). Vyčerpané → štruktúrovaná
-- chyba ENTITLEMENT_DENIED:VOICE_LIMIT_REACHED:voice_minutes (limit, current v min).
create or replace function public.esblu_require_my_voice_capacity()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_status jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  select cm.company_id into v_company_id from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active' and cm.company_id = public.esblu_my_active_company_id()
  limit 1;
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  v_status := public.esblu_voice_usage_status(v_company_id);
  if coalesce((v_status ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial('VOICE_ENTITLEMENT_REQUIRED', 'voice');
  end if;
  if coalesce((v_status ->> 'exhausted')::boolean, false) then
    perform public.esblu_raise_entitlement_denial('VOICE_LIMIT_REACHED', 'voice_minutes',
      (v_status ->> 'limit_minutes')::integer, ceil((v_status ->> 'used_seconds')::numeric / 60)::bigint);
  end if;
  return v_status || jsonb_build_object('company_id', v_company_id);
end
$function$;
revoke all on function public.esblu_require_my_voice_capacity() from public, anon;
grant execute on function public.esblu_require_my_voice_capacity() to authenticated, service_role;

-- Započítanie sekúnd po úspešnom prepise (server only). Firma musí byť
-- aktívna firma volajúceho podľa servera a používateľ jej aktívny člen.
create or replace function public.esblu_record_voice_usage(p_company_id uuid, p_user_id uuid, p_seconds numeric)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_min jsonb;
  v_period timestamptz;
begin
  if p_company_id is null or p_user_id is null or p_seconds is null or p_seconds <= 0 or p_seconds > 600 then
    return false;
  end if;
  if not exists (select 1 from public.company_members cm
                 where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.status = 'active') then
    return false;
  end if;
  v_min := public.esblu_resolve_entitlement(p_company_id, 'voice_minutes');
  v_period := public.esblu_usage_period_start(p_company_id, coalesce(v_min ->> 'limit_period', 'month'));
  insert into public.company_usage_counters as c (company_id, metric, period_start, used)
  values (p_company_id, 'voice_seconds', v_period, round(p_seconds, 3))
  on conflict on constraint company_usage_counters_pk
  do update set used = c.used + excluded.used, updated_at = now();
  return true;
end
$function$;
revoke all on function public.esblu_record_voice_usage(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.esblu_record_voice_usage(uuid, uuid, numeric) to service_role;

-- ----------------------------------------------------------------------------- 11) eFaktúra tx — READINESS (nie je zapojené do live toku)
create or replace function public.esblu_einvoice_tx_status(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_ent jsonb := public.esblu_resolve_entitlement(p_company_id, 'einvoice_transactions');
  v_period timestamptz;
  v_used numeric := 0;
begin
  if coalesce((v_ent ->> 'active')::boolean, false) is not true then
    return jsonb_build_object('active', false, 'reason', coalesce(v_ent ->> 'reason', 'ENTITLEMENT_REQUIRED'));
  end if;
  v_period := public.esblu_usage_period_start(p_company_id, coalesce(v_ent ->> 'limit_period', 'month'));
  select coalesce(sum(c.used), 0) into v_used from public.company_usage_counters c
  where c.company_id = p_company_id and c.metric = 'einvoice_tx' and c.period_start = v_period;
  return jsonb_build_object('active', true, 'limit', (v_ent ->> 'limit')::integer, 'used', v_used, 'period_start', v_period);
end
$function$;
revoke all on function public.esblu_einvoice_tx_status(uuid) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_tx_status(uuid) to service_role;

-- Odoslaný doklad = 1 tx, prijatý = 0,5 tx (cenník providera). Hádže
-- ENTITLEMENT_DENIED:EINVOICE_LIMIT_REACHED:einvoice_transactions.
create or replace function public.esblu_require_einvoice_tx_capacity(p_company_id uuid, p_units numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_status jsonb := public.esblu_einvoice_tx_status(p_company_id);
  v_limit integer;
begin
  if coalesce((v_status ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial(coalesce(v_status ->> 'reason', 'ENTITLEMENT_REQUIRED'), 'einvoice_transactions');
  end if;
  v_limit := (v_status ->> 'limit')::integer;
  if v_limit is not null and (v_status ->> 'used')::numeric + coalesce(p_units, 1) > v_limit then
    perform public.esblu_raise_entitlement_denial('EINVOICE_LIMIT_REACHED', 'einvoice_transactions', v_limit,
      ceil((v_status ->> 'used')::numeric)::bigint);
  end if;
  return v_status;
end
$function$;
revoke all on function public.esblu_require_einvoice_tx_capacity(uuid, numeric) from public, anon, authenticated;
grant execute on function public.esblu_require_einvoice_tx_capacity(uuid, numeric) to service_role;

create or replace function public.esblu_record_einvoice_tx(p_company_id uuid, p_units numeric)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_ent jsonb;
  v_period timestamptz;
begin
  if p_company_id is null or p_units is null or p_units not in (0.5, 1) then
    return false;
  end if;
  v_ent := public.esblu_resolve_entitlement(p_company_id, 'einvoice_transactions');
  v_period := public.esblu_usage_period_start(p_company_id, coalesce(v_ent ->> 'limit_period', 'month'));
  insert into public.company_usage_counters as c (company_id, metric, period_start, used)
  values (p_company_id, 'einvoice_tx', v_period, p_units)
  on conflict on constraint company_usage_counters_pk
  do update set used = c.used + excluded.used, updated_at = now();
  return true;
end
$function$;
revoke all on function public.esblu_record_einvoice_tx(uuid, numeric) from public, anon, authenticated;
grant execute on function public.esblu_record_einvoice_tx(uuid, numeric) to service_role;

-- ----------------------------------------------------------------------------- 12) úložisko — firemné účtovanie
-- Súčet veľkostí objektov, ktoré referencujú metadátové riadky FIRMY (každý
-- objekt raz). Cesta objektu začína uid nahrávajúceho, preto sa firma určuje
-- cez referenčné riadky, nie cez cestu. eFaktúra XML z veľkostných stĺpcov.
create or replace function public.esblu_company_storage_bytes(p_company_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $function$
  with refs(bucket_id, name) as (
    select vp.storage_bucket, vp.storage_path from public.vehicle_photos vp where vp.company_id = p_company_id
    union select 'machine-photos', mp.file_path from public.machine_photos mp where mp.company_id = p_company_id
    union select 'inventory-photos', ip.file_path from public.inventory_photos ip where ip.company_id = p_company_id
    union select 'company-logos', b.logo_path from public.company_billing_profile b where b.company_id = p_company_id and b.logo_path is not null
    union select da.storage_bucket, da.storage_path from public.document_attachments da
            join public.documents d on d.id = da.document_id where d.company_id = p_company_id
    union select ca.storage_bucket, ca.storage_path from public.chat_attachments ca where ca.company_id = p_company_id
  )
  select coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0)::bigint
       + coalesce((select sum(coalesce(eo.ubl_size_bytes, 0)) from public.einvoice_outbound eo where eo.company_id = p_company_id), 0)::bigint
       + coalesce((select sum(coalesce(ei.xml_size_bytes, 0)) from public.einvoice_inbound ei where ei.company_id = p_company_id), 0)::bigint
  from refs r
  join storage.objects o on o.bucket_id = r.bucket_id and o.name = r.name
$function$;
revoke all on function public.esblu_company_storage_bytes(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_storage_bytes(uuid) to service_role;

-- Limit úložiska firmy v bajtoch (null = bez limitu). Bez aktívneho nároku
-- (napr. po skončení trialu bez predplatného) platí podlaha 1 GB — core
-- funkcie (chat, logo) fungujú v malom rozsahu, nič sa nemaže (OWNER CONFIRM).
create or replace function public.esblu_company_storage_status(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_ent jsonb := public.esblu_resolve_entitlement(p_company_id, 'storage_mb');
  v_limit_mb integer;
  v_used bigint := public.esblu_company_storage_bytes(p_company_id);
begin
  if coalesce((v_ent ->> 'active')::boolean, false) then
    v_limit_mb := (v_ent ->> 'limit')::integer;
  else
    v_limit_mb := 1024;
  end if;
  return jsonb_build_object(
    'used_bytes', v_used,
    'limit_mb', v_limit_mb,
    'limit_bytes', case when v_limit_mb is null then null else v_limit_mb::bigint * 1048576 end,
    'exhausted', v_limit_mb is not null and v_used >= v_limit_mb::bigint * 1048576,
    'source', coalesce(v_ent ->> 'source', 'floor'));
end
$function$;
revoke all on function public.esblu_company_storage_status(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_storage_status(uuid) to service_role;

-- Predkontrola pre UI (štruktúrovaná chyba namiesto tichého RLS zlyhania).
create or replace function public.esblu_require_my_storage_capacity()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_status jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  select cm.company_id into v_company_id from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active' and cm.company_id = public.esblu_my_active_company_id()
  limit 1;
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  v_status := public.esblu_company_storage_status(v_company_id);
  if coalesce((v_status ->> 'exhausted')::boolean, false) then
    perform public.esblu_raise_entitlement_denial('STORAGE_LIMIT_REACHED', 'storage_mb',
      (v_status ->> 'limit_mb')::integer, ((v_status ->> 'used_bytes')::bigint / 1048576));
  end if;
  return v_status;
end
$function$;
revoke all on function public.esblu_require_my_storage_capacity() from public, anon;
grant execute on function public.esblu_require_my_storage_capacity() to authenticated, service_role;

-- Tvrdá serverová brána (RESTRICTIVE politika — AND so všetkými existujúcimi
-- insert politikami storage). Existujúce súbory sa nikdy nemažú; iba nové
-- uploady nad limit aktívnej firmy zlyhajú.
create or replace function public.esblu_storage_upload_allowed(p_bucket text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  if p_bucket is null or p_bucket not in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos',
      'ai-inbox-documents', 'ai-evidence-documents', 'chat-attachments') then
    return true; -- iné buckety rieši ich vlastná politika (napr. eFaktúra = iba server)
  end if;
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    return false;
  end if;
  return coalesce((public.esblu_company_storage_status(v_company_id) ->> 'exhausted')::boolean, true) is not true;
end
$function$;
revoke all on function public.esblu_storage_upload_allowed(text) from public, anon;
grant execute on function public.esblu_storage_upload_allowed(text) to authenticated, service_role;

drop policy if exists esblu_storage_company_capacity on storage.objects;
create policy esblu_storage_company_capacity on storage.objects
  as restrictive
  for insert to authenticated
  with check (public.esblu_storage_upload_allowed(bucket_id));

-- ----------------------------------------------------------------------------- 13) cenová úroveň firmy
-- secondary = owner tejto firmy už má INÚ firmu s kanonickým predplatným,
-- ktoré vzniklo skôr. Každá firma má vlastné limity (nič sa nezdieľa).
create or replace function public.esblu_company_price_tier(p_company_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case when exists (
    select 1
    from public.companies me
    join public.companies other on other.owner_id = me.owner_id and other.id <> me.id
    join public.company_plan_selection s on s.company_id = other.id
    left join public.company_plan_selection mine on mine.company_id = me.id
    where me.id = p_company_id
      and (mine.company_id is null or s.created_at < mine.created_at or (s.created_at = mine.created_at and other.id < me.id))
  ) then 'secondary' else 'primary' end
$function$;
revoke all on function public.esblu_company_price_tier(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_price_tier(uuid) to service_role;

-- ----------------------------------------------------------------------------- 14) prehľad plánu a čerpania (aktívna firma)
-- Každý aktívny člen vidí limity a čerpanie svojej aktívnej firmy (UX pri
-- LIMIT_REACHED); kompozíciu plánu, cenovú úroveň a add-ony iba owner.
create or replace function public.esblu_my_plan_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_member record;
  v_company record;
  v_ai jsonb;
  v_ai_used bigint := 0;
  v_ai_period timestamptz;
  v_users jsonb;
  v_users_used bigint;
  v_sel record;
  v_acc record;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  select cm.company_id, cm.role into v_member from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active' and cm.company_id = public.esblu_my_active_company_id()
  limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  select c.id, c.trial_started_at, c.trial_ends_at into v_company from public.companies c where c.id = v_member.company_id;

  v_ai := public.esblu_resolve_entitlement(v_company.id, 'ai_documents');
  if coalesce((v_ai ->> 'active')::boolean, false) then
    if v_ai ->> 'source' = 'trial' then
      select count(*) into v_ai_used from public.ai_processing_usage u
      where u.company_id = v_company.id and u.entitlement_source = 'trial' and u.status in ('reserved', 'succeeded');
    elsif v_ai ->> 'limit_period' = 'month' then
      v_ai_period := public.esblu_usage_period_start(v_company.id, 'month');
      select count(*) into v_ai_used from public.ai_processing_usage u
      where u.company_id = v_company.id and u.entitlement_id = nullif(v_ai ->> 'entitlement_id', '')::uuid
        and u.status in ('reserved', 'succeeded') and u.reserved_at >= v_ai_period;
    end if;
  end if;

  v_users := public.esblu_resolve_entitlement(v_company.id, 'team_members');
  select count(*) into v_users_used from public.company_members cm where cm.company_id = v_company.id and cm.status = 'active';

  v_result := jsonb_build_object(
    'company_id', v_company.id,
    'role', v_member.role,
    'trial', jsonb_build_object('started_at', v_company.trial_started_at, 'ends_at', v_company.trial_ends_at,
                                'active', coalesce(now() >= v_company.trial_started_at and now() < v_company.trial_ends_at, false)),
    'usage', jsonb_build_object(
      'ai_processings', jsonb_build_object('active', coalesce((v_ai ->> 'active')::boolean, false),
                                           'used', v_ai_used, 'limit', (v_ai ->> 'limit')::integer, 'source', v_ai ->> 'source'),
      'voice', public.esblu_voice_usage_status(v_company.id),
      'users', jsonb_build_object('active', coalesce((v_users ->> 'active')::boolean, false),
                                  'used', v_users_used, 'limit', (v_users ->> 'limit')::integer, 'source', v_users ->> 'source'),
      'storage', public.esblu_company_storage_status(v_company.id),
      'einvoice_transactions', public.esblu_einvoice_tx_status(v_company.id)
    ),
    'modules', (select jsonb_object_agg(k.key, coalesce((public.esblu_resolve_entitlement(v_company.id, k.key) ->> 'active')::boolean, false))
                from public.entitlement_catalog k where k.kind = 'module'),
    'einvoice_sellable', coalesce((select bool_or(c.einvoice_sellable) from public.billing_runtime_config c), false)
  );

  if v_member.role = 'owner' then
    select * into v_sel from public.company_plan_selection s where s.company_id = v_company.id;
    select a.status, a.plan_code, a.billing_provider, a.current_period_start, a.current_period_end
      into v_acc from public.subscription_accounts a where a.company_id = v_company.id;
    v_result := v_result || jsonb_build_object(
      'price_tier', public.esblu_company_price_tier(v_company.id),
      'plan', case when v_sel.company_id is null then null else jsonb_build_object(
        'kind', v_sel.plan_kind, 'tier', v_sel.price_tier, 'modules', to_jsonb(v_sel.modules),
        'addons', jsonb_build_object('ai_40', v_sel.ai_packs, 'voice_60', v_sel.voice_packs, 'users_25', v_sel.user_packs,
                                     'einvoice_40', v_sel.einvoice_40_packs, 'einvoice_100', v_sel.einvoice_100_packs),
        'source', v_sel.source) end,
      'subscription', case when v_acc.status is null then null else jsonb_build_object(
        'status', v_acc.status, 'plan_code', v_acc.plan_code, 'provider', v_acc.billing_provider,
        'period_start', v_acc.current_period_start, 'period_end', v_acc.current_period_end) end
    );
  end if;
  return v_result;
end
$function$;
revoke all on function public.esblu_my_plan_overview() from public, anon;
grant execute on function public.esblu_my_plan_overview() to authenticated, service_role;

-- ----------------------------------------------------------------------------- 15) STAGING ONLY — mock aktivácia plánu
-- Jediná ne-providerová cesta k plateným nárokom. Iba service_role a iba ak
-- billing_runtime_config.allow_mock_plans = true (default false; produkcia
-- ho nikdy nezapína). Klient ju nevie zavolať. Žiadny reálny billing.
create or replace function public.esblu_staging_mock_set_plan(
  p_company_id uuid,
  p_plan_kind text,
  p_modules text[],
  p_ai_packs integer,
  p_voice_packs integer,
  p_user_packs integer,
  p_einvoice_40_packs integer,
  p_einvoice_100_packs integer,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_allowed boolean;
  v_tier text;
  v_plan_code text;
begin
  select coalesce(bool_or(c.allow_mock_plans), false) into v_allowed from public.billing_runtime_config c;
  if not v_allowed then
    raise exception using errcode = 'P0001', message = 'ESBLU_MOCK_PLANS_DISABLED';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_NOT_FOUND';
  end if;
  if p_plan_kind not in ('complete', 'modular') then
    raise exception using errcode = 'P0001', message = 'ESBLU_PLAN_KIND_INVALID';
  end if;

  v_tier := public.esblu_company_price_tier(p_company_id);
  insert into public.company_plan_selection as s
    (company_id, plan_kind, price_tier, modules, ai_packs, voice_packs, user_packs, einvoice_40_packs, einvoice_100_packs, source)
  values (p_company_id, p_plan_kind, v_tier, coalesce(p_modules, '{}'), coalesce(p_ai_packs, 0), coalesce(p_voice_packs, 0),
          coalesce(p_user_packs, 0), coalesce(p_einvoice_40_packs, 0), coalesce(p_einvoice_100_packs, 0), 'staging_mock')
  on conflict (company_id) do update set
    plan_kind = excluded.plan_kind, price_tier = s.price_tier, modules = excluded.modules,
    ai_packs = excluded.ai_packs, voice_packs = excluded.voice_packs, user_packs = excluded.user_packs,
    einvoice_40_packs = excluded.einvoice_40_packs, einvoice_100_packs = excluded.einvoice_100_packs,
    source = 'staging_mock', updated_at = now(), version = s.version + 1;

  select case when s.plan_kind = 'modular' then 'esblu_modular'
              when s.price_tier = 'secondary' then 'esblu_complete_secondary' else 'esblu_complete' end
    into v_plan_code from public.company_plan_selection s where s.company_id = p_company_id;

  insert into public.subscription_accounts as a
    (company_id, plan_code, billing_interval, status, billing_provider, provider_environment,
     current_period_start, current_period_end)
  values (p_company_id, v_plan_code, 'month', case when p_active then 'active' else 'canceled' end, 'fake', 'test',
          now(), now() + interval '1 month')
  on conflict on constraint subscription_accounts_company_unique do update set
    plan_code = excluded.plan_code, billing_interval = 'month',
    status = excluded.status, billing_provider = 'fake', provider_environment = 'test',
    current_period_start = case when a.status = excluded.status and a.plan_code = excluded.plan_code
                                then a.current_period_start else excluded.current_period_start end,
    current_period_end = case when a.status = excluded.status and a.plan_code = excluded.plan_code
                              then a.current_period_end else excluded.current_period_end end,
    updated_at = now(), version = a.version + 1;

  perform public.esblu_billing_sync_entitlements(p_company_id);
  return jsonb_build_object('company_id', p_company_id, 'plan_code', v_plan_code,
                            'tier', (select s.price_tier from public.company_plan_selection s where s.company_id = p_company_id));
end
$function$;
revoke all on function public.esblu_staging_mock_set_plan(uuid, text, text[], integer, integer, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.esblu_staging_mock_set_plan(uuid, text, text[], integer, integer, integer, integer, integer, boolean) to service_role;
