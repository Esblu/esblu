-- =============================================================================
-- J7 business rule corrections (20261026110000) — STAGING matica.
-- Jeden príkaz; fixtures aj dočasné prepínače (allow_mock_plans,
-- einvoice_sellable) sa zahodia výnimkou ESBLU_J7_CORRECTIONS_RESULT.
-- Očakávané: docs_only_ai 10, docs_plus_pack_ai 50, docs_only_voice false,
-- docs_only_users 25, docs_only_storage_mb 5120, expired_trial_storage
-- limit_mb 0 / exhausted true, expired_trial_upload_allowed ok:false,
-- invite_1 ok:1, invite_2_full USER_LIMIT_REACHED, einvoice used_half_units 40
-- = limit_half_units 40, einvoice_over EINVOICE_LIMIT_REACHED.
-- NIKDY nespúšťať proti produkcii.
-- =============================================================================
do $m$
declare
  oA uuid := 'b9000000-0000-4000-8000-0000000000a1'; oT uuid := 'b9000000-0000-4000-8000-0000000000e1';
  cA uuid := 'd9000000-0000-4000-8000-00000000000a'; cT uuid := 'd9000000-0000-4000-8000-00000000000e';
  sA uuid := 'e9000000-0000-4000-8000-0000000000a1'; sT uuid := 'e9000000-0000-4000-8000-0000000000e1';
  r jsonb := '{}'::jsonb; i int;
begin
  if current_database() <> 'postgres' or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'not a supabase db';
  end if;
  create function pg_temp.try_as(p_uid uuid, p_sess uuid, p_sql text) returns text language plpgsql as $f$
  declare v text; begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'session_id', p_sess)::text, true);
    execute 'set local role authenticated';
    execute format('select (%s)::text', p_sql) into v; reset role; return 'ok:' || coalesce(v, 'null');
  exception when others then reset role; return 'err:' || left(sqlerrm, 90); end $f$;
  insert into auth.users (id, email, aud, role) values (oA, 'j7-a@example.invalid', 'authenticated', 'authenticated'), (oT, 'j7-t@example.invalid', 'authenticated', 'authenticated');
  insert into auth.users (id, email, aud, role) select ('c9900000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'j7seat' || g || '@example.invalid', 'authenticated', 'authenticated' from generate_series(1, 23) g;
  insert into auth.sessions (id, user_id) values (sA, oA), (sT, oT);
  set local session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values (cA, oA, 'J7 A');
  insert into public.companies (id, owner_id, name, trial_started_at, trial_ends_at) values (cT, oT, 'J7 T', now() - interval '20 days', now() - interval '6 days');
  insert into public.company_members (company_id, user_id, role, status, permissions) values (cA, oA, 'owner', 'active', '{}'), (cT, oT, 'owner', 'active', '{}');
  insert into public.company_members (company_id, user_id, role, status, permissions)
    select cA, ('c9900000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'employee', 'active', '{}' from generate_series(1, 23) g;
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select v.co, d.version, v.own, 'company_dpa_gate' from (values (cA, oA), (cT, oT)) v(co, own), (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  set local session_replication_role = origin;
  update public.billing_runtime_config set allow_mock_plans = true, einvoice_sellable = true;

  perform public.esblu_staging_mock_set_plan(cA, 'modular', '{documents}', 0, 0, 0, 0, 0, true);
  r := r || jsonb_build_object('docs_only_ai', public.esblu_resolve_entitlement(cA, 'ai_documents') ->> 'limit',
    'docs_only_voice', public.esblu_resolve_entitlement(cA, 'voice_minutes') ->> 'active',
    'docs_only_users', public.esblu_resolve_entitlement(cA, 'team_members') ->> 'limit',
    'docs_only_storage_mb', public.esblu_company_storage_status(cA) ->> 'limit_mb');
  perform public.esblu_staging_mock_set_plan(cA, 'modular', '{documents}', 1, 0, 0, 0, 0, true);
  r := r || jsonb_build_object('docs_plus_pack_ai', public.esblu_resolve_entitlement(cA, 'ai_documents') ->> 'limit');
  r := r || jsonb_build_object('expired_trial_storage', public.esblu_company_storage_status(cT),
    'expired_trial_upload_allowed', pg_temp.try_as(oT, sT, $q$public.esblu_storage_upload_allowed('chat-attachments')$q$));
  r := r || jsonb_build_object('invite_1', pg_temp.try_as(oA, sA, $q$(select count(*) from public.esblu_create_company_invite('j7-inv1@example.invalid', 'employee'))$q$),
    'invite_2_full', pg_temp.try_as(oA, sA, $q$(select count(*) from public.esblu_create_company_invite('j7-inv2@example.invalid', 'employee'))$q$));
  perform public.esblu_staging_mock_set_plan(cA, 'complete', '{}', 0, 0, 0, 0, 0, true);
  for i in 1..10 loop perform public.esblu_record_einvoice_tx(cA, 1); end loop;
  for i in 1..20 loop perform public.esblu_record_einvoice_tx(cA, 0.5); end loop;
  r := r || jsonb_build_object('einvoice_status', public.esblu_einvoice_tx_status(cA));
  begin
    perform public.esblu_require_einvoice_tx_capacity(cA, 0.5);
    r := r || jsonb_build_object('einvoice_over', 'allowed');
  exception when others then r := r || jsonb_build_object('einvoice_over', left(sqlerrm, 80)); end;
  raise exception 'ESBLU_J7_CORRECTIONS_RESULT %', r::text;
end
$m$;
