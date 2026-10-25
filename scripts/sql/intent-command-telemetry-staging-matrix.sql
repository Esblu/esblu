-- =============================================================================
-- J8 intent command telemetry (20261027100000) — STAGING matica.
-- Jeden príkaz; fixtures aj zápisy sa zahodia výnimkou ESBLU_J8_MATRIX.
-- NIKDY nespúšťať proti produkcii.
-- Očakávané (2026-10-25 staging): det/det2/ai = true, foreign_company /
-- bad_class / bad_outcome / old_rpc_rejects_flow = false, rows: ai-fallback
-- failure 1 + deterministic success 2 (input_tokens 0), rows_b = 0,
-- client = authenticated:42501 anon:42501, acl = postgres + service_role,
-- secdef = true, cfg = search_path="", md5(prosrc) = 54fb3ab44ed31fcf3a45481751d295a1.
-- =============================================================================
do $m$
declare
  o uuid := 'b9000000-0000-4000-8000-0000000000a1'; x uuid := 'b9000000-0000-4000-8000-0000000000b1';
  c uuid := 'd9000000-0000-4000-8000-00000000000a'; c2 uuid := 'd9000000-0000-4000-8000-00000000000b';
  r jsonb := '{}';
  v text;
begin
  insert into auth.users (id, email, aud, role) values (o, 'j8-o@example.invalid','authenticated','authenticated'), (x, 'j8-x@example.invalid','authenticated','authenticated');
  set local session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values (c, o, 'J8 A'), (c2, x, 'J8 B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values (c, o, 'owner','active','{}'), (c2, x, 'owner','active','{}');
  set local session_replication_role = origin;
  set local role service_role;
  r := r || jsonb_build_object(
    'det', public.esblu_record_intent_command(c, o, 'deterministic', 'success'),
    'det2', public.esblu_record_intent_command(c, o, 'deterministic', 'success'),
    'ai', public.esblu_record_intent_command(c, o, 'ai-fallback', 'failure'),
    'foreign_company', public.esblu_record_intent_command(c2, o, 'deterministic', 'success'),
    'bad_class', public.esblu_record_intent_command(c, o, 'chat', 'success'),
    'bad_outcome', public.esblu_record_intent_command(c, o, 'ambiguous', 'maybe'),
    'old_rpc_rejects_flow', public.esblu_record_ai_usage(c, o, 'intent_command', 'deterministic', 'success', 0,0,0,0,0,0,0));
  reset role;
  r := r || jsonb_build_object('rows', (select jsonb_agg(jsonb_build_object('m', model, 'o', outcome, 'n', requests, 'in', input_tokens) order by model) from public.ai_usage_monthly where company_id = c),
    'rows_b', (select count(*) from public.ai_usage_monthly where company_id = c2));
  begin
    set local role authenticated;
    perform public.esblu_record_intent_command(c, o, 'deterministic', 'success');
    v := 'authenticated:EXECUTED';
  exception when others then v := 'authenticated:' || sqlstate; end;
  reset role;
  begin
    set local role anon;
    perform public.esblu_record_intent_command(c, o, 'deterministic', 'success');
    v := v || ' anon:EXECUTED';
  exception when others then v := v || ' anon:' || sqlstate; end;
  reset role;
  r := r || jsonb_build_object('client', v,
    'md5', (select md5(prosrc) from pg_proc where proname = 'esblu_record_intent_command'),
    'acl', (select array_to_string(proacl, ',') from pg_proc where proname = 'esblu_record_intent_command'),
    'secdef', (select prosecdef from pg_proc where proname = 'esblu_record_intent_command'),
    'cfg', (select array_to_string(proconfig, ',') from pg_proc where proname = 'esblu_record_intent_command'));
  raise exception 'ESBLU_J8_MATRIX %', r::text;
end $m$;
