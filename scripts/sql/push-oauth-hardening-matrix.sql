-- =============================================================================
-- Regresný test PO aplikovaní migrácií 20260927110000 (push) a 20260927120000
-- (OAuth pozvánková brána). Spúšťa sa ako `postgres` (MCP execute_sql).
-- Všetko je syntetické a blok na konci VŽDY vyhodí výnimku → rollback.
-- `FAIL` = regresia.
--
-- Overuje:
--   A) bežný prihlásený klient NEMÁ priamy prístup k push tabuľkám —
--      nezaregistruje ani neprepíše cudzí endpoint, nečíta ho, nezapíše
--      predvoľby, nečíta denník doručení,
--   B) prázdne okno dní je zakázané,
--   C) Auth hook: google/apple + platná pozvánka pre ten istý e-mail prejde;
--      iný poskytovateľ, vypršaná/cudzia pozvánka, e-mail bez tokenu a bez
--      allowlistu neprejde; owner allowlist funguje ako doteraz.
-- =============================================================================
do $$
declare
  r text := '';
  fails int := 0;
  ca uuid := gen_random_uuid();
  cb uuid := gen_random_uuid();
  u_a uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid();
  v_n int;
  v_ok boolean;
  v_res jsonb;
  v_dpa text;
  v_invited text := 'oauth-invited-' || gen_random_uuid() || '@example.invalid';
  v_expired text := 'oauth-expired-' || gen_random_uuid() || '@example.invalid';
  v_allowed text := 'oauth-allowed-' || gen_random_uuid() || '@example.invalid';
begin
  select version into v_dpa from public.legal_documents
   where type = 'dpa' and effective_at <= now()
   order by effective_at desc, created_at desc, version desc limit 1;

  insert into auth.users (id, email, aud, role, instance_id)
  select u, 'push-matrix-' || u || '@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
  from unnest(array[u_a, u_b]) u;
  insert into public.companies (id, name, owner_id) values (ca, 'Push A', u_a), (cb, 'Push B', u_b);
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (ca, u_a, 'owner', 'active', '{}'), (cb, u_b, 'owner', 'active', '{}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values
    (ca, v_dpa, u_a, 'company_dpa_gate'), (cb, v_dpa, u_b, 'company_dpa_gate');

  -- Zariadenie používateľa B (zapisuje server = postgres/service role).
  insert into public.push_subscriptions (user_id, company_id, endpoint, p256dh, auth_secret)
  values (u_b, cb, 'https://push.example.invalid/device-b', repeat('B', 87), repeat('b', 22));

  -- ---------------------------------------------------------------- A) klient
  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  begin
    insert into public.push_subscriptions (user_id, company_id, endpoint, p256dh, auth_secret)
    values (u_a, ca, 'https://push.example.invalid/device-a', repeat('A', 87), repeat('a', 22));
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; when others then v_ok := false; end;
  r := r || format(E'%s authenticated cannot insert push_subscriptions directly\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  begin
    update public.push_subscriptions set user_id = u_a, company_id = ca where endpoint = 'https://push.example.invalid/device-b';
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; when others then v_ok := false; end;
  r := r || format(E'%s authenticated cannot take over another endpoint\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  begin
    select count(*) into v_n from public.push_subscriptions;
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; when others then v_ok := false; end;
  r := r || format(E'%s authenticated cannot read push_subscriptions (no endpoint leak)\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  begin
    insert into public.notification_preferences (user_id, company_id, show_message_preview) values (u_a, ca, true);
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; when others then v_ok := false; end;
  r := r || format(E'%s authenticated cannot write notification_preferences directly\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  begin
    select count(*) into v_n from public.notification_deliveries;
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; when others then v_ok := false; end;
  r := r || format(E'%s authenticated cannot read notification_deliveries\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    select count(*) into v_n from public.push_subscriptions;
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; when others then v_ok := false; end;
  execute 'reset role';
  r := r || format(E'%s anon cannot read push_subscriptions\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- ---------------------------------------------------------------- B) okno dní
  begin
    insert into public.notification_preferences (user_id, company_id, deadline_days) values (u_a, ca, array[]::integer[]);
    v_ok := false;
  exception when check_violation then v_ok := true; when others then v_ok := false; end;
  r := r || format(E'%s empty deadline_days rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- ---------------------------------------------------------------- C) Auth hook
  insert into public.company_invites (company_id, email, role, token_hash, status, created_at, expires_at, invited_by)
  values
    (ca, v_invited, 'employee', encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), 'pending', now(), now() + interval '3 days', u_a),
    (ca, v_expired, 'employee', encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), 'pending', now() - interval '9 days', now() - interval '1 day', u_a);
  insert into public.beta_allowlist (email) values (v_allowed);

  for v_res, v_ok in
    select public.esblu_before_user_created_beta_gate(e.event), e.expect_allow
    from (values
      (jsonb_build_object('user', jsonb_build_object('email', v_invited, 'app_metadata', jsonb_build_object('provider', 'google'))), true),
      (jsonb_build_object('user', jsonb_build_object('email', v_invited, 'app_metadata', jsonb_build_object('provider', 'apple'))), true),
      (jsonb_build_object('user', jsonb_build_object('email', v_invited, 'app_metadata', jsonb_build_object('provider', 'github'))), false),
      (jsonb_build_object('user', jsonb_build_object('email', v_invited, 'app_metadata', jsonb_build_object('provider', 'email'))), false),
      (jsonb_build_object('user', jsonb_build_object('email', v_invited)), false),
      (jsonb_build_object('user', jsonb_build_object('email', v_invited, 'user_metadata', jsonb_build_object('provider', 'google'))), false),
      (jsonb_build_object('user', jsonb_build_object('email', v_expired, 'app_metadata', jsonb_build_object('provider', 'google'))), false),
      (jsonb_build_object('user', jsonb_build_object('email', 'random-' || gen_random_uuid() || '@example.invalid', 'app_metadata', jsonb_build_object('provider', 'google'))), false),
      (jsonb_build_object('user', jsonb_build_object('email', v_allowed, 'app_metadata', jsonb_build_object('provider', 'email'))), true),
      (jsonb_build_object('user', jsonb_build_object('email', v_allowed, 'app_metadata', jsonb_build_object('provider', 'google'))), true)
    ) as e(event, expect_allow)
  loop
    if (v_res = '{}'::jsonb) = v_ok then
      r := r || format(E'ok   hook %s\n', case when v_ok then 'allows' else 'blocks' end);
    else
      r := r || format(E'FAIL hook expected %s, got %s\n', case when v_ok then 'allow' else 'block' end, v_res::text);
      fails := fails + 1;
    end if;
  end loop;

  raise exception E'PUSH/OAUTH HARDENING MATRIX (rolled back) — failures: %\n%', fails, r;
end $$;
