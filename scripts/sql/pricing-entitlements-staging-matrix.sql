-- =============================================================================
-- Pricing + entitlements (20261026100000) — STAGING matica.
-- Jeden príkaz; fixtures, dočasné zapnutie allow_mock_plans aj všetky pokusy
-- sa na konci zahodia vyhodením výnimky ESBLU_PRICING_MATRIX_RESULT.
-- Klasifikácia: ok:<value> | privilege | rls | err:<sqlstate>:<msg>
-- NIKDY nespúšťať proti produkcii.
-- =============================================================================
do $matrix$
declare
  oA uuid := 'b8000000-0000-4000-8000-0000000000a1'; adA uuid := 'b8000000-0000-4000-8000-0000000000a2';
  acA uuid := 'b8000000-0000-4000-8000-0000000000a3'; eA uuid := 'b8000000-0000-4000-8000-0000000000a4';
  oB uuid := 'b8000000-0000-4000-8000-0000000000b1';
  cA uuid := 'd8000000-0000-4000-8000-00000000000a'; cA2 uuid := 'd8000000-0000-4000-8000-0000000000a2';
  cB uuid := 'd8000000-0000-4000-8000-00000000000b';
  sA uuid := 'e8000000-0000-4000-8000-0000000000a1'; sA2 uuid := 'e8000000-0000-4000-8000-0000000000a9';
  sAd uuid := 'e8000000-0000-4000-8000-0000000000a2'; sAc uuid := 'e8000000-0000-4000-8000-0000000000a3';
  sE uuid := 'e8000000-0000-4000-8000-0000000000a4'; sB uuid := 'e8000000-0000-4000-8000-0000000000b1';
  r jsonb := '{}'::jsonb;
  who record;
begin
  if current_database() <> 'postgres' or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'not a supabase db';
  end if;

  create function pg_temp.try_as(p_role text, p_uid uuid, p_sess uuid, p_sql text)
  returns text language plpgsql as $f$
  declare v text; begin
    perform set_config('request.jwt.claims', case when p_role = 'authenticated'
      then json_build_object('sub', p_uid, 'role', 'authenticated', 'session_id', p_sess)::text
      else json_build_object('role', p_role)::text end, true);
    execute format('set local role %I', p_role);
    execute format('select (%s)::text', p_sql) into v;
    reset role;
    return 'ok:' || coalesce(v, 'null');
  exception when others then
    reset role;
    return case when sqlstate = '42501' and sqlerrm like 'permission denied%' then 'privilege'
                when sqlstate = '42501' and sqlerrm like '%row-level security%' then 'rls'
                else 'err:' || sqlstate || ':' || left(sqlerrm, 90) end;
  end $f$;

  create function pg_temp.try_exec(p_uid uuid, p_sess uuid, p_sql text)
  returns text language plpgsql as $f$
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'session_id', p_sess)::text, true);
    execute 'set local role authenticated';
    execute p_sql;
    reset role;
    return 'ok';
  exception when others then
    reset role;
    return 'err:' || sqlstate || ':' || left(sqlerrm, 90);
  end $f$;

  create function pg_temp.ent(p_company uuid, p_key text) returns text language sql as $f$
    select case when coalesce((public.esblu_resolve_entitlement(p_company, p_key) ->> 'active')::boolean, false)
                then coalesce(public.esblu_resolve_entitlement(p_company, p_key) ->> 'limit', 'unlimited') else 'off' end
  $f$;

  insert into auth.users (id, email, aud, role) values
    (oA, 'price-oa@example.invalid', 'authenticated', 'authenticated'), (adA, 'price-ada@example.invalid', 'authenticated', 'authenticated'),
    (acA, 'price-aca@example.invalid', 'authenticated', 'authenticated'), (eA, 'price-ea@example.invalid', 'authenticated', 'authenticated'),
    (oB, 'price-ob@example.invalid', 'authenticated', 'authenticated');
  insert into auth.sessions (id, user_id) values (sA, oA), (sA2, oA), (sAd, adA), (sAc, acA), (sE, eA), (sB, oB);
  set local session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values (cA, oA, 'Price A'), (cA2, oA, 'Price A2'), (cB, oB, 'Price B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (cA, oA, 'owner', 'active', '{}'), (cA, adA, 'admin', 'active', '{"billing":{"manage":true}}'),
    (cA, acA, 'accountant', 'active', '{}'), (cA, eA, 'employee', 'active', '{}'),
    (cA2, oA, 'owner', 'active', '{}'), (cB, oB, 'owner', 'active', '{}');
  insert into public.session_active_company (session_id, user_id, company_id) values (sA, oA, cA), (sA2, oA, cA2);
  set local session_replication_role = origin;

  -- mock je predvolene vypnutý
  r := r || jsonb_build_object('mock_disabled_by_default', pg_temp.try_as('service_role', null, null, format(
    $q$public.esblu_staging_mock_set_plan(%L, 'complete', '{}', 0, 0, 0, 0, 0, true)$q$, cA)));
  update public.billing_runtime_config set allow_mock_plans = true;  -- iba v tejto transakcii

  r := r || jsonb_build_object(
    'mock_complete_A', pg_temp.try_as('service_role', null, null, format($q$public.esblu_staging_mock_set_plan(%L, 'complete', '{}', 1, 0, 0, 0, 0, true)$q$, cA)),
    'mock_complete_A2', pg_temp.try_as('service_role', null, null, format($q$public.esblu_staging_mock_set_plan(%L, 'complete', '{}', 0, 0, 0, 0, 0, true)$q$, cA2)),
    'mock_modular_B', pg_temp.try_as('service_role', null, null, format($q$public.esblu_staging_mock_set_plan(%L, 'modular', '{vehicles,invoicing}', 0, 0, 0, 0, 0, true)$q$, cB))
  );
  r := r || jsonb_build_object(
    'A', jsonb_build_object('vehicles', pg_temp.ent(cA, 'vehicles'), 'ai', pg_temp.ent(cA, 'ai_documents'), 'voice_min', pg_temp.ent(cA, 'voice_minutes'),
                            'users', pg_temp.ent(cA, 'team_members'), 'storage_mb', pg_temp.ent(cA, 'storage_mb'), 'einvoice', pg_temp.ent(cA, 'einvoice')),
    'A2', jsonb_build_object('ai', pg_temp.ent(cA2, 'ai_documents'), 'users', pg_temp.ent(cA2, 'team_members'),
                             'tier', (select price_tier from public.company_plan_selection where company_id = cA2)),
    'B', jsonb_build_object('vehicles', pg_temp.ent(cB, 'vehicles'), 'machines', pg_temp.ent(cB, 'machines'), 'ai', pg_temp.ent(cB, 'ai_documents'),
                            'voice', pg_temp.ent(cB, 'voice'), 'users', pg_temp.ent(cB, 'team_members'))
  );

  -- hlas: vyčerpanie A, A2 nezasiahnutá
  r := r || jsonb_build_object('voice_cap_A_before', pg_temp.try_as('authenticated', oA, sA, $q$(public.esblu_require_my_voice_capacity() ->> 'limit_minutes')$q$));
  perform public.esblu_record_voice_usage(cA, oA, 600) from generate_series(1, 6);
  r := r || jsonb_build_object(
    'voice_cap_A_after', pg_temp.try_as('authenticated', oA, sA, 'public.esblu_require_my_voice_capacity()'),
    'voice_cap_A2', pg_temp.try_as('authenticated', oA, sA2, $q$(public.esblu_require_my_voice_capacity() ->> 'limit_minutes')$q$));

  -- downgrade B: vozidlá → odvolané, dáta ostávajú
  set local session_replication_role = replica;
  insert into public.vehicles (spz, user_id, company_id) values ('PB-1', oB, cB);
  set local session_replication_role = origin;
  perform public.esblu_staging_mock_set_plan(cB, 'modular', '{invoicing}', 0, 0, 0, 0, 0, true);
  r := r || jsonb_build_object(
    'B_after_downgrade_vehicles', pg_temp.ent(cB, 'vehicles'),
    'B_vehicle_rows_kept', (select count(*) from public.vehicles where company_id = cB),
    'B_insert_vehicle', pg_temp.try_exec(oB, sB,
      format($q$insert into public.vehicles (spz, user_id, company_id) values ('PB-2', %L, %L)$q$, oB, cB)));

  -- roly a klientsky prístup
  for who in select * from (values ('owner_A', 'authenticated', oA, sA), ('admin_A', 'authenticated', adA, sAd),
                                    ('accountant_A', 'authenticated', acA, sAc), ('employee_A', 'authenticated', eA, sE),
                                    ('anon', 'anon', null::uuid, null::uuid)) w(label, role, uid, sess) loop
    r := r || jsonb_build_object(
      who.label || '_overview_plan', pg_temp.try_as(who.role, who.uid, who.sess, $q$coalesce(public.esblu_my_plan_overview() -> 'plan' ->> 'kind', 'hidden')$q$),
      who.label || '_billing_manage', pg_temp.try_as(who.role, who.uid, who.sess, $q$(public.esblu_billing_my_access() ->> 'can_manage')$q$),
      who.label || '_mock', pg_temp.try_as(who.role, who.uid, who.sess, format($q$public.esblu_staging_mock_set_plan(%L, 'complete', '{}', 50, 50, 50, 0, 0, true)$q$, cA)),
      who.label || '_select_selection', pg_temp.try_as(who.role, who.uid, who.sess, '(select count(*) from public.company_plan_selection)'),
      who.label || '_select_counters', pg_temp.try_as(who.role, who.uid, who.sess, '(select count(*) from public.company_usage_counters)'),
      who.label || '_record_voice', pg_temp.try_as(who.role, who.uid, who.sess, format($q$public.esblu_record_voice_usage(%L, %L, 1)$q$, cA, oA))
    );
  end loop;

  r := r || jsonb_build_object(
    'acl_selection', (select coalesce(array_to_string(relacl, ','), '') from pg_class where oid = 'public.company_plan_selection'::regclass),
    'acl_counters', (select coalesce(array_to_string(relacl, ','), '') from pg_class where oid = 'public.company_usage_counters'::regclass),
    'storage_policy', (select permissive from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'esblu_storage_company_capacity'));

  raise exception 'ESBLU_PRICING_MATRIX_RESULT %', r::text;
end
$matrix$;
