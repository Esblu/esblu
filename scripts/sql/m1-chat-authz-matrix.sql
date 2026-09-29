-- =============================================================================
-- Regresný test: Human Chat membership (20260930150000)
-- Beží ako `postgres` (MCP execute_sql na BRANCHI), všetko je syntetické a
-- blok na konci VŽDY vyhodí výnimku → úplný rollback. `FAIL` = regresia.
-- Pred migráciou MUSIA riadky exploitu hlásiť FAIL (dôkaz pôvodnej chyby).
-- Zamietnutie sa počíta iba ak príde z RLS / authz (42501, alebo
-- ESBLU_* authz výnimka) — CHECK/FK chyba sa hlási ako „non-authz".
-- =============================================================================
do $$
declare
  r text := ''; fails int := 0; ok boolean; n int; st text; msg text;
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  u_o uuid := gen_random_uuid(); u_ad uuid := gen_random_uuid(); u_ac uuid := gen_random_uuid();
  u_e1 uuid := gen_random_uuid(); u_e2 uuid := gen_random_uuid(); u_dis uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid(); u_b2 uuid := gen_random_uuid();
  c_a uuid; c_b uuid; d1 uuid; d2 uuid; db uuid;
  m_d2 uuid := gen_random_uuid(); m_d1_e1 uuid := gen_random_uuid(); m_ca_o uuid := gen_random_uuid(); m_db uuid := gen_random_uuid();
  v_dpa text;
  t record;
begin
  select version into v_dpa from public.legal_documents where type = 'dpa' and effective_at <= now()
   order by effective_at desc, created_at desc, version desc limit 1;
  insert into auth.users (id, email, aud, role, instance_id)
  select u, 'm1-chat-' || u || '@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
  from unnest(array[u_o, u_ad, u_ac, u_e1, u_e2, u_dis, u_b, u_b2]) u;
  insert into public.companies (id, name, owner_id) values (ca, 'M1 chat A', u_o), (cb, 'M1 chat B', u_b);
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (ca, u_o, 'owner', 'active', '{}'), (ca, u_ad, 'admin', 'active', '{}'),
    (ca, u_ac, 'accountant', 'active', '{}'), (ca, u_e1, 'employee', 'active', '{}'),
    (ca, u_e2, 'employee', 'active', '{}'), (ca, u_dis, 'employee', 'disabled', '{}'),
    (cb, u_b, 'owner', 'active', '{}'), (cb, u_b2, 'employee', 'active', '{}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values
    (ca, v_dpa, u_o, 'company_dpa_gate'), (cb, v_dpa, u_b, 'company_dpa_gate');

  -- Fixtúry cez skutočné RPC pod identitou používateľov.
  perform set_config('request.jwt.claims', json_build_object('sub', u_e1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  c_a := public.esblu_ensure_company_chat_channel();
  d1 := public.esblu_get_or_create_direct_conversation(u_ac);        -- e1 ↔ accountant
  perform public.esblu_mark_conversation_read(c_a);                  -- read pointer = riadok členstva
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  d2 := public.esblu_get_or_create_direct_conversation(u_e2);        -- owner ↔ e2
  insert into public.chat_messages (id, conversation_id, author_id, body) values (m_d2, d2, u_o, 'owner→e2 private');
  insert into public.chat_messages (id, conversation_id, author_id, body) values (m_ca_o, c_a, u_o, 'owner in channel');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  c_b := public.esblu_ensure_company_chat_channel();
  db := public.esblu_get_or_create_direct_conversation(u_b2);
  insert into public.chat_messages (id, conversation_id, author_id, body) values (m_db, db, u_b, 'B private');
  execute 'reset role';

  -- A. INSERT -------------------------------------------------------------------
  for t in select * from (values
      ('employee member of A-channel -> A-channel', u_e1, c_a, u_e1, true),
      ('employee member of D1 -> D1', u_e1, d1, u_e1, true),
      ('EXPLOIT employee member of D1/channel -> foreign direct D2', u_e1, d2, u_e1, false),
      ('accountant member of D1 -> D1', u_ac, d1, u_ac, true),
      ('accountant -> A-channel', u_ac, c_a, u_ac, true),
      ('EXPLOIT accountant not member -> D2', u_ac, d2, u_ac, false),
      ('owner participant -> D2', u_o, d2, u_o, true),
      ('owner NOT participant -> D1', u_o, d1, u_o, false),
      ('admin -> A-channel', u_ad, c_a, u_ad, true),
      ('admin NOT participant -> D1', u_ad, d1, u_ad, false),
      ('employee2 participant -> D2', u_e2, d2, u_e2, true),
      ('EXPLOIT employee A -> B-channel (cross-company)', u_e1, c_b, u_e1, false),
      ('EXPLOIT employee A -> B direct (cross-company)', u_e1, db, u_e1, false),
      ('other tenant -> A-channel', u_b, c_a, u_b, false),
      ('other tenant -> D1', u_b, d1, u_b, false),
      ('spoof author: employee as owner -> A-channel', u_e1, c_a, u_o, false),
      ('spoof author: employee as accountant -> D1', u_e1, d1, u_ac, false),
      ('disabled employee -> A-channel', u_dis, c_a, u_dis, false),
      ('non-existent conversation', u_e1, gen_random_uuid(), u_e1, false)
    ) as x(label, uid, conv, author, expect_ok)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', t.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      insert into public.chat_messages (conversation_id, author_id, body) values (t.conv, t.author, 'm1 ' || t.label);
      ok := t.expect_ok;
      st := null;
    exception when others then
      ok := not t.expect_ok; st := sqlstate; msg := sqlerrm;
      if st not in ('42501') and msg not like 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP%' then
        r := r || format(E'     (non-authz error %s: %s)\n', st, left(msg, 90));
        if not t.expect_ok then ok := false; end if;
      end if;
    end;
    execute 'reset role';
    r := r || format(E'%s INSERT %s (expect %s)%s\n', case when ok then 'ok  ' else 'FAIL' end, t.label,
                     case when t.expect_ok then 'allow' else 'deny' end, case when st is not null then ' [' || st || ']' else '' end);
    if not ok then fails := fails + 1; end if;
  end loop;

  -- B. SELECT (správy / konverzácie) ------------------------------------------------
  for t in select * from (values
      ('employee e1 reads D2 messages', u_e1, d2, 0),
      ('employee e1 reads D1 messages', u_e1, d1, -1),
      ('accountant reads D2 messages', u_ac, d2, 0),
      ('admin reads D2 messages', u_ad, d2, 0),
      ('owner reads D2 messages', u_o, d2, -1),
      ('owner reads D1 messages (not participant)', u_o, d1, 0),
      ('employee e1 reads A-channel', u_e1, c_a, -1),
      ('accountant reads A-channel', u_ac, c_a, -1),
      ('other tenant reads A-channel', u_b, c_a, 0),
      ('employee A reads B direct', u_e1, db, 0),
      ('disabled employee reads A-channel', u_dis, c_a, 0)
    ) as x(label, uid, conv, expect_n)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', t.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into n from public.chat_messages where conversation_id = t.conv;
    ok := case when t.expect_n = -1 then n > 0 else n = t.expect_n end;
    select count(*) into n from public.chat_conversations where id = t.conv;
    ok := ok and case when t.expect_n = -1 then n = 1 else n = 0 end;
    execute 'reset role';
    r := r || format(E'%s SELECT %s (messages+conversation, expect %s)\n', case when ok then 'ok  ' else 'FAIL' end, t.label,
                     case when t.expect_n = -1 then 'visible' else 'hidden' end);
    if not ok then fails := fails + 1; end if;
  end loop;

  -- C. UPDATE / DELETE ----------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', u_e1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.chat_messages (id, conversation_id, author_id, body) values (m_d1_e1, d1, u_e1, 'e1 own');
  update public.chat_messages set body = 'edited', edited_at = now() where id = m_d1_e1; get diagnostics n = row_count;
  ok := n = 1; r := r || format(E'%s UPDATE employee edits own message in D1\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  update public.chat_messages set body = 'hijack' where id in (m_d2, m_ca_o); get diagnostics n = row_count;
  ok := n = 0; r := r || format(E'%s UPDATE employee cannot edit others'' messages (%s)\n', case when ok then 'ok  ' else 'FAIL' end, n); if not ok then fails := fails + 1; end if;
  begin
    update public.chat_messages set conversation_id = d2 where id = m_d1_e1; ok := false;
  exception when others then ok := true; end;
  r := r || format(E'%s UPDATE employee cannot move own message into D2\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  begin
    update public.chat_messages set author_id = u_o where id = m_d1_e1; get diagnostics n = row_count; ok := n = 0;
  exception when others then ok := true; end;
  r := r || format(E'%s UPDATE employee cannot re-attribute own message to owner\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  begin
    delete from public.chat_messages where id = m_d1_e1; get diagnostics n = row_count; ok := n = 0;
  exception when insufficient_privilege then ok := true; end;
  r := r || format(E'%s DELETE hard delete not possible for client\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  begin
    insert into public.chat_conversation_members (conversation_id, company_id, user_id) values (d2, ca, u_e1); ok := false;
  exception when insufficient_privilege then ok := true; end;
  r := r || format(E'%s MEMBERSHIP employee cannot add self to D2\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  begin
    perform public.esblu_mark_conversation_read(d2); ok := false;
  exception when others then ok := sqlstate = '42501'; end;
  r := r || format(E'%s MEMBERSHIP mark-read of D2 rejected (no self-join)\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  begin
    perform public.esblu_mark_conversation_read(db); ok := false;
  exception when others then ok := sqlstate = '42501'; end;
  r := r || format(E'%s MEMBERSHIP mark-read of B direct rejected\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  select count(*) into n from public.esblu_get_my_unread_counts() u where u.conversation_id in (d2, db, c_b);
  ok := n = 0; r := r || format(E'%s UNREAD counts never list foreign conversations (%s)\n', case when ok then 'ok  ' else 'FAIL' end, n); if not ok then fails := fails + 1; end if;
  execute 'reset role';

  -- D. Prílohy -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', u_e1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  for t in select * from (values
      ('own message, correct path', m_d1_e1, 'chat-attachments', ca::text || '/' || d1 || '/' || m_d1_e1 || '/a.webp', true),
      ('own message, path of D2', m_d1_e1, 'chat-attachments', ca::text || '/' || d2 || '/' || m_d2 || '/a.webp', false),
      ('own message, foreign bucket', m_d1_e1, 'ai-inbox-documents', ca::text || '/' || d1 || '/' || m_d1_e1 || '/b.webp', false),
      ('owner''s D2 message', m_d2, 'chat-attachments', ca::text || '/' || d2 || '/' || m_d2 || '/c.webp', false),
      ('B direct message', m_db, 'chat-attachments', cb::text || '/' || db || '/' || m_db || '/d.webp', false)
    ) as x(label, mid, bucket, path, expect_ok)
  loop
    begin
      insert into public.chat_attachments (message_id, storage_bucket, storage_path, original_filename, mime_type, file_size)
        values (t.mid, t.bucket, t.path, 'x.webp', 'image/webp', 10);
      ok := t.expect_ok; st := null;
    exception when others then
      ok := not t.expect_ok; st := sqlstate;
      if st <> '42501' then r := r || format(E'     (non-authz error %s: %s)\n', st, left(sqlerrm, 90)); if not t.expect_ok then ok := false; end if; end if;
    end;
    r := r || format(E'%s ATTACHMENT row: %s (expect %s)\n', case when ok then 'ok  ' else 'FAIL' end, t.label, case when t.expect_ok then 'allow' else 'deny' end);
    if not ok then fails := fails + 1; end if;
  end loop;
  for t in select * from (values
      ('upload own message path', ca::text || '/' || d1 || '/' || m_d1_e1 || '/u1.webp', true),
      ('upload with D2 folder + own message id', ca::text || '/' || d2 || '/' || m_d1_e1 || '/u2.webp', false),
      ('upload under owner''s D2 message', ca::text || '/' || d2 || '/' || m_d2 || '/u3.webp', false),
      ('upload under B message', cb::text || '/' || db || '/' || m_db || '/u4.webp', false)
    ) as x(label, path, expect_ok)
  loop
    begin
      insert into storage.objects (bucket_id, name, owner_id) values ('chat-attachments', t.path, u_e1::text);
      ok := t.expect_ok;
    exception when others then ok := not t.expect_ok; end;
    r := r || format(E'%s STORAGE chat %s (expect %s)\n', case when ok then 'ok  ' else 'FAIL' end, t.label, case when t.expect_ok then 'allow' else 'deny' end);
    if not ok then fails := fails + 1; end if;
  end loop;
  execute 'reset role';
  -- objekty/prílohy ako postgres, potom čítanie
  insert into storage.objects (bucket_id, name, owner_id) values ('chat-attachments', ca::text || '/' || d2 || '/' || m_d2 || '/priv.webp', u_o::text);
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  insert into public.chat_attachments (message_id, storage_bucket, storage_path, original_filename, mime_type, file_size)
    values (m_d2, 'chat-attachments', ca::text || '/' || d2 || '/' || m_d2 || '/priv.webp', 'p.webp', 'image/webp', 10);
  insert into public.chat_message_references (message_id, company_id, entity_type, entity_id) values (m_d2, ca, 'vehicle', gen_random_uuid());
  for t in select * from (values
      ('employee e1', u_e1, 0), ('accountant', u_ac, 0), ('admin', u_ad, 0), ('other tenant', u_b, 0), ('owner participant', u_o, 1), ('employee2 participant', u_e2, 1)
    ) as x(label, uid, expect_n)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', t.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into n from public.chat_attachments where message_id = m_d2; ok := n = t.expect_n;
    select count(*) into n from public.chat_message_references where message_id = m_d2; ok := ok and n = t.expect_n;
    select count(*) into n from storage.objects where bucket_id = 'chat-attachments' and name like ca::text || '/' || d2 || '/%'; ok := ok and n = t.expect_n;
    execute 'reset role';
    r := r || format(E'%s READ D2 attachment+reference+object: %s (expect %s)\n', case when ok then 'ok  ' else 'FAIL' end, t.label, case when t.expect_n = 1 then 'visible' else 'hidden' end);
    if not ok then fails := fails + 1; end if;
  end loop;

  -- E. Referencie cez RPC nerozšíria členstvo ---------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', u_e1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.esblu_attach_chat_message_reference(m_d2, 'vehicle', gen_random_uuid()); ok := false;
  exception when others then ok := sqlstate = '42501'; end;
  r := r || format(E'%s REFERENCE employee cannot pin onto owner''s D2 message\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  begin
    perform public.esblu_attach_chat_message_reference(m_d1_e1, 'document', gen_random_uuid()); ok := false;
  exception when others then ok := sqlerrm like '%ENTITY_NOT_FOUND_OR_FORBIDDEN%'; end;
  r := r || format(E'%s REFERENCE own D1 message reaches entity check (membership ok)\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;
  execute 'reset role';

  -- anon
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin select count(*) into n from public.chat_messages; ok := n = 0; exception when insufficient_privilege then ok := true; end;
  execute 'reset role';
  r := r || format(E'%s anon sees no chat\n', case when ok then 'ok  ' else 'FAIL' end); if not ok then fails := fails + 1; end if;

  raise exception E'M1 CHAT AUTHZ MATRIX (rolled back) — failures: %\n%', fails, r;
end $$;
