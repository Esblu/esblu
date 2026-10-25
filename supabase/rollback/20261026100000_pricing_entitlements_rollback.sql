-- Rollback 20261026100000_pricing_entitlements.sql
-- Vráti katalóg, sync a AI rezerváciu do stavu pred migráciou a odstráni
-- tabuľky výberu plánu / usage počítadiel (STAGING: kompozícia plánov a
-- počítadlá hlasu sa tým ZMAŽÚ; obchodné dáta firiem ostávajú).
-- Kanonické plány sa odstránia iba ak ich nepoužíva žiadny subscription účet.

drop policy if exists esblu_storage_company_capacity on storage.objects;

drop function if exists public.esblu_staging_mock_set_plan(uuid, text, text[], integer, integer, integer, integer, integer, boolean);
drop function if exists public.esblu_my_plan_overview();
drop function if exists public.esblu_company_price_tier(uuid);
drop function if exists public.esblu_storage_upload_allowed(text);
drop function if exists public.esblu_require_my_storage_capacity();
drop function if exists public.esblu_company_storage_status(uuid);
drop function if exists public.esblu_company_storage_bytes(uuid);
drop function if exists public.esblu_record_einvoice_tx(uuid, numeric);
drop function if exists public.esblu_require_einvoice_tx_capacity(uuid, numeric);
drop function if exists public.esblu_einvoice_tx_status(uuid);
drop function if exists public.esblu_record_voice_usage(uuid, uuid, numeric);
drop function if exists public.esblu_require_my_voice_capacity();
drop function if exists public.esblu_voice_usage_status(uuid);

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
      -- Store grace period (Google IN_GRACE_PERIOD / Apple billing retry s grace):
      -- prístup trvá do konca grace podľa providera.
      v_until := coalesce(v_acc.grace_until, v_acc.current_period_end);
      v_entitled := v_until > now();
    end if;
    -- Všetky ostatné stavy (pending, account_hold, unpaid, paused, canceled,
    -- expired, refunded, revoked) → nároky odvolané (dáta ostávajú).
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

drop function if exists public.esblu_usage_period_start(uuid, text);
drop function if exists public.esblu_billing_plan_targets(uuid, text);
drop function if exists public.esblu_plan_entitlement_targets(text, text[], integer, integer, integer, integer, integer, boolean);

drop table if exists public.company_usage_counters;
drop table if exists public.company_plan_selection;

delete from public.subscription_plans p
where p.plan_code in ('esblu_complete', 'esblu_complete_secondary', 'esblu_modular')
  and not exists (select 1 from public.subscription_accounts a where a.plan_code = p.plan_code)
  and not exists (select 1 from public.billing_provider_prices b where b.plan_code = p.plan_code)
  and not exists (select 1 from public.billing_checkout_sessions s where s.plan_code = p.plan_code);

delete from public.company_entitlements where note = 'backfill 20261026100000: legacy grant';
delete from public.company_entitlements where entitlement_key in ('voice_minutes', 'storage_mb', 'einvoice_transactions');
delete from public.entitlement_catalog where key in ('voice_minutes', 'storage_mb', 'einvoice_transactions');

insert into public.entitlement_catalog (key, kind, included_in_trial, trial_limit, limit_reason, sort_order) values
  ('invoicing',    'module',     true,  null, null,                          10),
  ('einvoice',     'module',     false, null, null,                          15),
  ('ai_documents', 'quota',      true,  5,    'AI_PROCESSING_LIMIT_REACHED', 20),
  ('vehicles',     'module',     true,  2,    'VEHICLE_LIMIT_REACHED',       30),
  ('machines',     'module',     true,  2,    'MACHINE_LIMIT_REACHED',       40),
  ('inventory',    'module',     true,  5,    'INVENTORY_LIMIT_REACHED',     50),
  ('voice',        'capability', false, null, null,                          60),
  ('team_members', 'quota',      true,  1,    'USER_LIMIT_REACHED',          70)
on conflict (key) do update set
  kind = excluded.kind, included_in_trial = excluded.included_in_trial, trial_limit = excluded.trial_limit,
  limit_reason = excluded.limit_reason, sort_order = excluded.sort_order;

alter table public.billing_runtime_config drop column if exists einvoice_sellable;
alter table public.billing_runtime_config drop column if exists allow_mock_plans;
