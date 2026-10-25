-- =============================================================================
-- Cost control hardening (20261025100000 / 20261025110000) — STAGING matica.
-- Jeden príkaz; fixtures aj pokusy sa na konci zahodia vyhodením výnimky
-- ESBLU_COST_MATRIX_RESULT s JSON výsledkom → žiadny zápis nezostane.
-- Rovnaký mechanizmus ako PostgREST: SET LOCAL ROLE + request.jwt.claims.
-- Klasifikácia: ok:<n|value> | privilege | rls | err:<sqlstate>:<msg>
-- NIKDY nespúšťať proti produkcii.
-- =============================================================================
do $matrix$
declare
  oA uuid := 'b7000000-0000-4000-8000-0000000000a1'; eA uuid := 'b7000000-0000-4000-8000-0000000000a4';
  oB uuid := 'b7000000-0000-4000-8000-0000000000b1'; mu uuid := 'b7000000-0000-4000-8000-0000000000c1';
  xx uuid := 'b7000000-0000-4000-8000-0000000000d1';
  cA uuid := 'd7000000-0000-4000-8000-00000000000a'; cB uuid := 'd7000000-0000-4000-8000-00000000000b';
  sA uuid := 'e7000000-0000-4000-8000-0000000000a1'; sE uuid := 'e7000000-0000-4000-8000-0000000000a4';
  sB uuid := 'e7000000-0000-4000-8000-0000000000b1';
  resB uuid;
  r jsonb := '{}'::jsonb;
  who record;
  v text;
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
                else 'err:' || sqlstate || ':' || left(sqlerrm, 80) end;
  end $f$;

  insert into auth.users (id, email, aud, role) values
    (oA, 'cost-oa@example.invalid', 'authenticated', 'authenticated'), (eA, 'cost-ea@example.invalid', 'authenticated', 'authenticated'),
    (oB, 'cost-ob@example.invalid', 'authenticated', 'authenticated'), (mu, 'cost-m@example.invalid', 'authenticated', 'authenticated'),
    (xx, 'cost-x@example.invalid', 'authenticated', 'authenticated');
  insert into auth.sessions (id, user_id) values (sA, oA), (sE, eA), (sB, oB);
  set local session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values (cA, oA, 'Cost A'), (cB, oB, 'Cost B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (cA, oA, 'owner', 'active', '{}'), (cA, eA, 'employee', 'active', '{}'), (cA, mu, 'employee', 'active', '{}'),
    (cB, oB, 'owner', 'active', '{}'), (cB, mu, 'employee', 'active', '{}');
  insert into public.ai_processing_usage (company_id, user_id, endpoint, idempotency_key, content_sha256, entitlement_source)
    values (cB, mu, 'scan-document', 'cost_matrix_key_000001', repeat('b', 64), 'manual') returning id into resB;
  set local session_replication_role = origin;

  -- service zápis + company scoping
  r := r || jsonb_build_object(
    'svc_record_member_A', pg_temp.try_as('service_role', null, null, format(
      $q$public.esblu_record_ai_usage(%L, %L, 'voice_transcription', 'gpt-4o-transcribe', 'success', 300, 0, 18, 290, 0, 0, 0)$q$, cA, mu)),
    'svc_record_reservation_B', pg_temp.try_as('service_role', null, null, format(
      $q$public.esblu_record_ai_usage_for_reservation(%L, 'document_scan', 'gpt-5.6-terra', 'success', 9100, 0, 1400, 1, 0)$q$, resB)),
    'svc_record_non_member', pg_temp.try_as('service_role', null, null, format(
      $q$public.esblu_record_ai_usage(%L, %L, 'document_scan', 'gpt-5.6-terra', 'success', 1, 0, 1, 0, 0, 1, 0)$q$, cB, oA)),
    'svc_record_outsider', pg_temp.try_as('service_role', null, null, format(
      $q$public.esblu_record_ai_usage(%L, %L, 'document_scan', 'gpt-5.6-terra', 'success', 1, 0, 1, 0, 0, 1, 0)$q$, cA, xx)),
    'svc_record_unknown_flow', pg_temp.try_as('service_role', null, null, format(
      $q$public.esblu_record_ai_usage(%L, %L, 'ai_chatbot', 'gpt-5.6-terra', 'success', 1, 0, 1, 0, 0, 1, 0)$q$, cA, oA)),
    'svc_record_unknown_reservation', pg_temp.try_as('service_role', null, null,
      $q$public.esblu_record_ai_usage_for_reservation('c9000000-0000-4000-8000-000000000000', 'document_scan', 'gpt-5.6-terra', 'success', 1, 0, 1, 1, 0)$q$)
  );
  -- FORCE RLS bez politík: počty čítame ako service_role (BYPASSRLS), v novom príkaze (nový snapshot).
  r := r || jsonb_build_object(
    'svc_rows_A', pg_temp.try_as('service_role', null, null, format('select count(*) from public.ai_usage_monthly where company_id = %L', cA)),
    'svc_rows_B', pg_temp.try_as('service_role', null, null, format('select count(*) from public.ai_usage_monthly where company_id = %L', cB)),
    'svc_B_doc_input_tokens', pg_temp.try_as('service_role', null, null, format(
      $q$select input_tokens from public.ai_usage_monthly where company_id = %L and flow_type = 'document_scan'$q$, cB)),
    'svc_A_voice_audio_tokens', pg_temp.try_as('service_role', null, null, format(
      $q$select audio_input_tokens from public.ai_usage_monthly where company_id = %L and flow_type = 'voice_transcription'$q$, cA))
  );

  -- klienti: žiadny prístup
  for who in select * from (values ('owner_A', 'authenticated', oA, sA), ('employee_A', 'authenticated', eA, sE),
                                    ('owner_B', 'authenticated', oB, sB), ('anon', 'anon', null::uuid, null::uuid)) w(label, role, uid, sess) loop
    r := r || jsonb_build_object(
      who.label || '_select', pg_temp.try_as(who.role, who.uid, who.sess, 'select count(*) from public.ai_usage_monthly'),
      who.label || '_record', pg_temp.try_as(who.role, who.uid, who.sess, format(
        $q$public.esblu_record_ai_usage(%L, %L, 'document_scan', 'gpt-5.6-terra', 'success', 1, 0, 1, 0, 0, 1, 0)$q$, cA, oA)),
      who.label || '_record_res', pg_temp.try_as(who.role, who.uid, who.sess, format(
        $q$public.esblu_record_ai_usage_for_reservation(%L, 'document_scan', 'gpt-5.6-terra', 'success', 1, 0, 1, 1, 0)$q$, resB)),
      who.label || '_purge_usage', pg_temp.try_as(who.role, who.uid, who.sess, 'public.esblu_purge_ai_usage_monthly(13)'),
      who.label || '_purge_dedupe', pg_temp.try_as(who.role, who.uid, who.sess, 'public.esblu_purge_chat_notification_deliveries(7, 10)')
    );
  end loop;

  -- notification_deliveries retencia: iba staré 'chat', 'deadline' nikdy
  insert into public.notification_deliveries (user_id, company_id, kind, dedupe_key, sent_at) values
    (oA, cA, 'chat', 'chat:cost-old-1', now() - interval '10 days'), (oA, cA, 'chat', 'chat:cost-old-2', now() - interval '9 days'),
    (oA, cA, 'chat', 'chat:cost-fresh', now() - interval '1 hour'),
    (oA, cA, 'deadline', 'deadline:vehicle_stk:cost:2025-01-01:overdue', now() - interval '400 days');
  r := r || jsonb_build_object(
    'svc_purge_dedupe', pg_temp.try_as('service_role', null, null, 'public.esblu_purge_chat_notification_deliveries(7, 100000)')
  );
  r := r || jsonb_build_object(
    'fixture_left', (select jsonb_agg(dedupe_key order by dedupe_key) from public.notification_deliveries where company_id = cA)
  );

  -- objekty a ACL
  r := r || jsonb_build_object(
    'table_acl', (select coalesce(array_to_string(relacl, ','), '') from pg_class where oid = 'public.ai_usage_monthly'::regclass),
    'rls', (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.ai_usage_monthly'::regclass),
    'policies', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'ai_usage_monthly'),
    'fn_acl', (select jsonb_object_agg(proname, coalesce(array_to_string(proacl, ','), '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and proname in ('esblu_record_ai_usage', 'esblu_record_ai_usage_for_reservation',
                 'esblu_purge_ai_usage_monthly', 'esblu_purge_chat_notification_deliveries'))
  );

  raise exception 'ESBLU_COST_MATRIX_RESULT %', r::text;
end
$matrix$;
