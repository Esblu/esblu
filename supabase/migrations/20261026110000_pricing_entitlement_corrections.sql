-- =============================================================================
-- J7 business rule corrections (OWNER DECISION 2026-10-26) — STAGING ONLY.
--
--   1. modulárny plán: hlas iba cez add-on (bez zmeny — overené testami),
--   2. samostatný modul Dokumenty = 10 AI / obdobie (Komplet 40, +40 / balík),
--   3. každá platená firma = 25 používateľov + 5 GB (bez zmeny — overené),
--   4. po skončení trialu bez plateného plánu = 0 nových uploadov (predtým
--      podlaha 1 GB); existujúce súbory ostávajú, nič sa nemaže; RESTRICTIVE
--      brána teraz kryje aj UPDATE (prepis objektu / upsert),
--   5. čakajúce pozvánky rezervujú miesto (esblu_create_company_invite to už
--      robí — prehľad teraz ukazuje aj rezervované miesta),
--   6. eFaktúra: odoslaná 1,0 tx, prijatá 0,5 tx — integer half-units
--      (2 / 1), žiadna float aritmetika. Stále iba readiness, nič live.
-- =============================================================================

-- ----------------------------------------------------------------------------- 2) Dokumenty = 10 AI
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
      -- OWNER DECISION 2026-10-26: Komplet 40, samostatný modul Dokumenty 10 (+40 / AI balík).
      entitlement_key := 'ai_documents';
      limit_value := (case when p_plan_kind = 'complete' then 40 else 10 end)
                     + 40 * least(greatest(coalesce(p_ai_packs, 0), 0), 50);
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

-- ----------------------------------------------------------------------------- 4) bez nároku = 0 nových uploadov
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
  -- OWNER DECISION 2026-10-26: bez aktívneho nároku (trial skončil, žiadny
  -- platený plán) = 0 nových uploadov. Existujúce súbory ostávajú (nič sa nemaže).
  if coalesce((v_ent ->> 'active')::boolean, false) then
    v_limit_mb := (v_ent ->> 'limit')::integer;
  else
    v_limit_mb := 0;
  end if;
  return jsonb_build_object(
    'used_bytes', v_used,
    'limit_mb', v_limit_mb,
    'limit_bytes', case when v_limit_mb is null then null else v_limit_mb::bigint * 1048576 end,
    'exhausted', v_limit_mb is not null and (v_limit_mb = 0 or v_used >= v_limit_mb::bigint * 1048576),
    'source', coalesce(v_ent ->> 'source', 'none'));
end
$function$;
revoke all on function public.esblu_company_storage_status(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_storage_status(uuid) to service_role;

-- Prepis objektu (UPDATE / upsert) podlieha tej istej bráne ako nový upload.
create or replace function public.esblu_storage_overwrite_allowed(p_bucket text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return public.esblu_storage_upload_allowed(p_bucket);
end
$function$;
revoke all on function public.esblu_storage_overwrite_allowed(text) from public, anon;
grant execute on function public.esblu_storage_overwrite_allowed(text) to authenticated, service_role;

drop policy if exists esblu_storage_company_capacity_update on storage.objects;
create policy esblu_storage_company_capacity_update on storage.objects
  as restrictive
  for update to authenticated
  using (true)
  with check (public.esblu_storage_overwrite_allowed(bucket_id));

-- ----------------------------------------------------------------------------- 5) prehľad: rezervované miesta
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
  v_users_pending bigint;
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
  -- Platné čakajúce pozvánky rezervujú miesto (rovnako ako esblu_create_company_invite).
  select count(*) into v_users_pending from public.company_invites ci
  where ci.company_id = v_company.id and ci.status = 'pending' and ci.expires_at > now();

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
                                  'used', v_users_used, 'pending', v_users_pending, 'reserved', v_users_used + v_users_pending,
                                  'limit', (v_users ->> 'limit')::integer, 'source', v_users ->> 'source'),
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

-- ----------------------------------------------------------------------------- 6) eFaktúra half-units
update public.company_usage_counters set metric = 'einvoice_half_units', used = used * 2 where metric = 'einvoice_tx';
alter table public.company_usage_counters drop constraint if exists company_usage_counters_metric_check;
alter table public.company_usage_counters add constraint company_usage_counters_metric_check
  check (metric in ('voice_seconds', 'einvoice_half_units'));
alter table public.company_usage_counters drop constraint if exists company_usage_counters_half_units_integer;
alter table public.company_usage_counters add constraint company_usage_counters_half_units_integer
  check (metric <> 'einvoice_half_units' or used = trunc(used));

-- eFaktúra účtovanie (READINESS, nie je zapojené do live toku): integer
-- half-units — odoslaná = 2 (1,0 tx), prijatá = 1 (0,5 tx); limit tx × 2.
-- Vstup p_units je PRESNÝ numeric 1 (odoslaná) alebo 0.5 (prijatá) — iné
-- hodnoty sa odmietnu; prepočet na half-units je exaktný (numeric × 2 → int).
-- Signatúry ostávajú (uuid, numeric) — re-run 20261026100000 je idempotentný.
create or replace function public.esblu_einvoice_half_units(p_direction text)
returns integer
language sql
immutable
set search_path = ''
as $function$
  select case p_direction when 'sent' then 2 when 'received' then 1 else null end
$function$;
revoke all on function public.esblu_einvoice_half_units(text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_half_units(text) to service_role;

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
  v_used_half bigint := 0;
  v_limit integer;
begin
  if coalesce((v_ent ->> 'active')::boolean, false) is not true then
    return jsonb_build_object('active', false, 'reason', coalesce(v_ent ->> 'reason', 'ENTITLEMENT_REQUIRED'));
  end if;
  v_limit := (v_ent ->> 'limit')::integer;
  v_period := public.esblu_usage_period_start(p_company_id, coalesce(v_ent ->> 'limit_period', 'month'));
  select coalesce(sum(c.used), 0)::bigint into v_used_half from public.company_usage_counters c
  where c.company_id = p_company_id and c.metric = 'einvoice_half_units' and c.period_start = v_period;
  return jsonb_build_object('active', true, 'limit', v_limit,
    'limit_half_units', case when v_limit is null then null else v_limit::bigint * 2 end,
    'used_half_units', v_used_half, 'period_start', v_period);
end
$function$;
revoke all on function public.esblu_einvoice_tx_status(uuid) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_tx_status(uuid) to service_role;

-- ENTITLEMENT_DENIED:EINVOICE_LIMIT_REACHED:einvoice_transactions. Porovnanie
-- v half-units; detail chyby v celých tx (current zaokrúhlené nahor).
create or replace function public.esblu_require_einvoice_tx_capacity(p_company_id uuid, p_units numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_units integer := case when p_units = 1 then 2 when p_units = 0.5 then 1 else null end;
  v_status jsonb := public.esblu_einvoice_tx_status(p_company_id);
  v_limit_half bigint;
  v_used_half bigint;
begin
  if v_units is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_UNITS_INVALID';
  end if;
  if coalesce((v_status ->> 'active')::boolean, false) is not true then
    perform public.esblu_raise_entitlement_denial(coalesce(v_status ->> 'reason', 'ENTITLEMENT_REQUIRED'), 'einvoice_transactions');
  end if;
  v_limit_half := (v_status ->> 'limit_half_units')::bigint;
  v_used_half := (v_status ->> 'used_half_units')::bigint;
  if v_limit_half is not null and v_used_half + v_units > v_limit_half then
    perform public.esblu_raise_entitlement_denial('EINVOICE_LIMIT_REACHED', 'einvoice_transactions',
      (v_limit_half / 2)::integer, ((v_used_half + 1) / 2));
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
  v_units integer := case when p_units = 1 then 2 when p_units = 0.5 then 1 else null end;
  v_ent jsonb;
  v_period timestamptz;
begin
  if p_company_id is null or v_units is null then
    return false;
  end if;
  v_ent := public.esblu_resolve_entitlement(p_company_id, 'einvoice_transactions');
  v_period := public.esblu_usage_period_start(p_company_id, coalesce(v_ent ->> 'limit_period', 'month'));
  insert into public.company_usage_counters as c (company_id, metric, period_start, used)
  values (p_company_id, 'einvoice_half_units', v_period, v_units)
  on conflict on constraint company_usage_counters_pk
  do update set used = c.used + excluded.used, updated_at = now();
  return true;
end
$function$;
revoke all on function public.esblu_record_einvoice_tx(uuid, numeric) from public, anon, authenticated;
grant execute on function public.esblu_record_einvoice_tx(uuid, numeric) to service_role;
