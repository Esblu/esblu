-- =============================================================================
-- Regresný test: hlasové hromadné zmazanie nepriradených dokladov z Inboxu
-- (migrácia 20260926130000_inbox_bulk_delete_confirmation).
--
-- Overuje, že rozšírenie allowlistu potvrdení NIČ neoslabilo:
--   - INBOX_DELETE_UNASSIGNED sa dá potvrdiť (authenticated, vlastná firma),
--   - neznámy intent je stále odmietnutý, anon funkciu nespustí,
--   - bloček (finančný doklad) číta a maže iba owner / admin s financiami /
--     účtovník; zamestnanec (aj s podvrhnutým permissions.finance), admin
--     bez financií ani iná firma ho nevidia a nezmažú.
--
-- Spúšťa sa ako `postgres` (MCP execute_sql). Všetko je syntetické a blok
-- na konci VŽDY vyhodí výnimku → rollback. `FAIL` = regresia.
-- =============================================================================
do $$
declare
  r text := '';
  fails int := 0;
  ca uuid := gen_random_uuid();
  cb uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  u_admin_fin uuid := gen_random_uuid();
  u_admin uuid := gen_random_uuid();
  u_acc uuid := gen_random_uuid();
  u_emp uuid := gen_random_uuid();
  u_emp_forged uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid();
  v_doc uuid;
  v_conf uuid;
  v_n int;
  v_ok boolean;
  v_dpa text;
  a record;
begin
  select version into v_dpa from public.legal_documents
   where type = 'dpa' and effective_at <= now()
   order by effective_at desc, created_at desc, version desc limit 1;

  insert into auth.users (id, email, aud, role, instance_id)
  select u, 'inbox-bulk-' || u || '@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
  from unnest(array[u_owner, u_admin_fin, u_admin, u_acc, u_emp, u_emp_forged, u_b]) u;
  insert into public.companies (id, name, owner_id) values (ca, 'Inbox bulk A', u_owner), (cb, 'Inbox bulk B', u_b);
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (ca, u_owner, 'owner', 'active', '{}'),
    (ca, u_admin_fin, 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    (ca, u_admin, 'admin', 'active', '{}'),
    (ca, u_acc, 'accountant', 'active', '{}'),
    (ca, u_emp, 'employee', 'active', '{}'),
    (ca, u_emp_forged, 'employee', 'active', '{"finance":{"view":true,"manage":true}}'),
    (cb, u_b, 'owner', 'active', '{}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values
    (ca, v_dpa, u_owner, 'company_dpa_gate'), (cb, v_dpa, u_b, 'company_dpa_gate');

  -- 1) Potvrdenie INBOX_DELETE_UNASSIGNED (owner) — povolené.
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    v_conf := public.esblu_create_action_confirmation(
      'INBOX_DELETE_UNASSIGNED', '{"documentIds":[]}'::jsonb, 0,
      md5(random()::text) || md5(random()::text), md5(random()::text) || md5(random()::text),
      extract(epoch from now() + interval '4 minutes')::bigint);
    v_ok := v_conf is not null;
  exception when others then v_ok := false; r := r || 'ERR ' || sqlerrm || E'\n'; end;
  r := r || format(E'%s owner can create INBOX_DELETE_UNASSIGNED confirmation\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- 2) Neznámy intent — stále odmietnutý.
  begin
    perform public.esblu_create_action_confirmation(
      'INBOX_DELETE_EVERYTHING', '{}'::jsonb, 0,
      md5(random()::text) || md5(random()::text), md5(random()::text) || md5(random()::text),
      extract(epoch from now() + interval '4 minutes')::bigint);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%ESBLU_INVALID_ACTION_INTENT%'; end;
  r := r || format(E'%s unknown intent still rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- 3) Klient nečíta tabuľku potvrdení priamo.
  begin
    select count(*) into v_n from public.assistant_action_confirmations;
    v_ok := v_n = 0;
  exception when insufficient_privilege then v_ok := true; end;
  r := r || format(E'%s authenticated cannot read confirmations table directly\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- 4) Priamy INSERT do tabuľky potvrdení (obchádzka funkcie) — zakázaný.
  begin
    insert into public.assistant_action_confirmations (user_id, company_id, intent, canonical_args, nonce, server_proof, expires_at)
      values (u_owner, ca, 'INBOX_DELETE_UNASSIGNED', '{}'::jsonb, md5('x') || md5('y'), md5('a') || md5('b'), now() + interval '1 minute');
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s authenticated cannot insert confirmations directly\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- 5) anon funkciu nespustí.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    perform public.esblu_create_action_confirmation('INBOX_DELETE_UNASSIGNED', '{}'::jsonb, 0,
      md5('1') || md5('2'), md5('3') || md5('4'), extract(epoch from now() + interval '4 minutes')::bigint);
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; when others then v_ok := false; end;
  execute 'reset role';
  r := r || format(E'%s anon cannot execute esblu_create_action_confirmation\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- 6) Nepriradený bloček: čítanie a mazanie podľa roly (nový riadok pre každú rolu).
  for a in select * from (values
      ('owner', u_owner, true),
      ('admin+finance', u_admin_fin, true),
      ('accountant', u_acc, true),
      ('admin-no-finance', u_admin, false),
      ('employee', u_emp, false),
      ('employee-forged', u_emp_forged, false),
      ('other-tenant', u_b, false)
    ) as t(label, uid, allowed)
  loop
    v_doc := gen_random_uuid();
    -- Fixture pod identitou ownera firmy A (trigger priraďuje firmu z JWT).
    perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
    insert into public.documents (id, user_id, company_id, storage_bucket, storage_path, document_type, status)
      values (v_doc, u_owner, ca, 'ai-inbox-documents', 'x/' || v_doc || '.webp', 'receipt', 'confirmed');

    perform set_config('request.jwt.claims', json_build_object('sub', a.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into v_n from public.documents where id = v_doc;
    v_ok := (v_n = 1) = a.allowed;
    r := r || format(E'%s %-17s unassigned receipt read (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    delete from public.documents where id = v_doc;
    get diagnostics v_n = row_count;
    v_ok := (v_n = 1) = a.allowed;
    r := r || format(E'%s %-17s unassigned receipt delete (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    execute 'reset role';
  end loop;

  raise exception E'INBOX BULK DELETE MATRIX (rolled back) — failures: %\n%', fails, r;
end $$;
