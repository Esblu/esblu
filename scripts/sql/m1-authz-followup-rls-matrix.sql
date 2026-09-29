-- =============================================================================
-- Regresný test: M1 authz follow-up (2026-09-28)
--   20260930100000 review log (čítanie + integrita zápisu) + chat referencia
--   20260930110000 Inbox zložky — INSERT iba owner/admin/accountant
--   20260930120000 účtovník = iba finančné doklady (bez výnimky vlastných uploadov)
--   20260930125000 podpísané pripojenie vyťažených údajov k príjmu
--   20260930130000 documents INSERT podľa roly a tvaru
--   20260930135000 ai_evidence INSERT podľa roly a tvaru
--   20260930140000 Storage: originál nemenný (upload/upsert/move/delete/read)
--
-- SPÚŠŤA SA AŽ PO APLIKOVANÍ TÝCHTO MIGRÁCIÍ (alebo na Supabase branchi /
-- lokálnom stacku s nimi). Pred aplikovaním MUSIA niektoré riadky hlásiť FAIL
-- (to je dôkaz pôvodného problému, nie chyba testu).
--
-- Rovnaký vzor ako role-scope-rls-matrix.sql: beží ako `postgres`, všetko je
-- syntetické a blok na konci VŽDY vyhodí výnimku → úplný rollback.
-- `FAIL` v texte výnimky = regresia.
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
  u_admin_view uuid := gen_random_uuid();   -- admin s finance.view BEZ manage
  u_acc uuid := gen_random_uuid();
  u_emp uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid();
  d_inv uuid := gen_random_uuid();   -- finančný doklad (faktúra), nahral owner
  d_tp uuid := gen_random_uuid();    -- technický preukaz, nahral owner
  d_emp uuid := gen_random_uuid();   -- zamestnancov bloček v príjme
  d_old uuid := gen_random_uuid();   -- starý doklad zamestnanca (> 15 min)
  v_conv uuid := gen_random_uuid();
  v_msg uuid := gen_random_uuid();
  v_veh_b uuid := gen_random_uuid();
  v_n int;
  v_ok boolean;
  v_dpa text;
  a record;
begin
  select version into v_dpa from public.legal_documents
   where type = 'dpa' and effective_at <= now()
   order by effective_at desc, created_at desc, version desc limit 1;

  insert into auth.users (id, email, aud, role, instance_id)
  select u, 'm1-authz-' || u || '@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
  from unnest(array[u_owner, u_admin_fin, u_admin, u_admin_view, u_acc, u_emp, u_b]) u;
  insert into public.companies (id, name, owner_id) values (ca, 'M1 authz A', u_owner), (cb, 'M1 authz B', u_b);
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (ca, u_owner, 'owner', 'active', '{}'),
    (ca, u_admin_fin, 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    (ca, u_admin_view, 'admin', 'active', '{"finance":{"view":true}}'),
    (ca, u_admin, 'admin', 'active', '{}'),
    (ca, u_acc, 'accountant', 'active', '{}'),
    (ca, u_emp, 'employee', 'active', '{}'),
    (cb, u_b, 'owner', 'active', '{}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values
    (ca, v_dpa, u_owner, 'company_dpa_gate'), (cb, v_dpa, u_b, 'company_dpa_gate');

  -- Fixtúry ako postgres (trigger esblu_assign_company_id potrebuje JWT → nastaviť sub).
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  -- created_at v minulosti: potvrdené doklady nie sú „čerstvý vlastný upload"
  -- (inak by owner legitímne smel zapísať 'created' k vlastnému TP).
  insert into public.documents (id, user_id, company_id, storage_bucket, storage_path, document_type, status, created_at)
    values (d_inv, u_owner, ca, 'ai-inbox-documents', u_owner || '/inv.pdf', 'invoice', 'confirmed', now() - interval '2 hours'),
           (d_tp, u_owner, ca, 'ai-inbox-documents', u_owner || '/tp.jpg', 'vehicle_registration', 'confirmed', now() - interval '2 hours');
  insert into public.document_review_log (document_id, document_ref, user_id, action, document_snapshot)
    values (d_inv, d_inv, u_owner, 'confirmed', '{"supplier":"Tajný dodávateľ","total":1234.5}'),
           (d_tp, d_tp, u_owner, 'confirmed', '{"vin":"TESTVIN"}');
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
  insert into public.documents (id, user_id, company_id, storage_bucket, storage_path, document_type, status, created_at)
    values (d_emp, u_emp, ca, 'ai-inbox-documents', u_emp || '/rcpt.jpg', 'receipt', 'uploaded', now()),
           (d_old, u_emp, ca, 'ai-inbox-documents', u_emp || '/old.jpg', 'other', 'confirmed', now() - interval '2 hours');
  insert into public.chat_conversations (id, company_id, type) values (v_conv, ca, 'company');
  -- Vozidlo cudzej firmy (ako postgres) — pre test väzby ai_evidence.vehicle_id.
  insert into public.vehicles (id, company_id, user_id, spz) values (v_veh_b, cb, u_b, 'ZZ999ZZ');
  insert into public.chat_messages (id, conversation_id, company_id, author_id, body) values (v_msg, v_conv, ca, u_emp, 'test');

  -- --------------------------------------------------------------------------
  -- A. Čítanie review logu + rozsah účtovníka na documents
  -- --------------------------------------------------------------------------
  for a in select * from (values
      -- label, uid, inv_log, tp_log, inv_doc, tp_doc
      ('owner', u_owner, true, true, true, true),
      ('admin+finance', u_admin_fin, true, true, true, true),
      ('admin-no-finance', u_admin, false, true, false, true),
      ('admin-view-only', u_admin_view, true, true, true, true),
      ('accountant', u_acc, true, false, true, false),
      ('employee', u_emp, false, true, false, true),
      ('other-tenant', u_b, false, false, false, false)
    ) as t(label, uid, inv_log, tp_log, inv_doc, tp_doc)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', a.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into v_n from public.document_review_log where document_ref = d_inv;
    v_ok := (v_n > 0) = a.inv_log;
    r := r || format(E'%s %-17s review log of INVOICE (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    select count(*) into v_n from public.document_review_log where document_ref = d_tp;
    v_ok := (v_n > 0) = a.tp_log;
    r := r || format(E'%s %-17s review log of TP (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    select count(*) into v_n from public.documents where id = d_inv;
    v_ok := (v_n = 1) = a.inv_doc;
    r := r || format(E'%s %-17s documents INVOICE read (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    select count(*) into v_n from public.documents where id = d_tp;
    v_ok := (v_n = 1) = a.tp_doc;
    r := r || format(E'%s %-17s documents TP read (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    -- Podvrh histórie k faktúre: nikto cez klienta (ani owner — audit ide cez RPC).
    begin
      insert into public.document_review_log (document_id, document_ref, user_id, action, field_name, new_value)
        values (d_inv, d_inv, a.uid, 'field_edited', 'total', '"0"');
      v_ok := false;
    exception when others then v_ok := true; end;
    r := r || format(E'%s %-17s cannot forge field_edited on INVOICE\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label);
    if not v_ok then fails := fails + 1; end if;

    -- Podvrh „created" k cudziemu dokladu.
    begin
      insert into public.document_review_log (document_id, document_ref, user_id, action)
        values (d_tp, d_tp, a.uid, 'created');
      v_ok := false;
    exception when others then v_ok := true; end;
    r := r || format(E'%s %-17s cannot log created for someone else''s TP\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label);
    if not v_ok then fails := fails + 1; end if;

    -- UPDATE/DELETE auditu nikdy.
    begin
      update public.document_review_log set action = 'restored' where document_ref in (d_inv, d_tp);
      get diagnostics v_n = row_count;
      v_ok := v_n = 0;
    exception when others then v_ok := true; end;
    r := r || format(E'%s %-17s cannot update review log\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label);
    if not v_ok then fails := fails + 1; end if;
    begin
      delete from public.document_review_log where document_ref in (d_inv, d_tp);
      get diagnostics v_n = row_count;
      v_ok := v_n = 0;
    exception when others then v_ok := true; end;
    r := r || format(E'%s %-17s cannot delete review log\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label);
    if not v_ok then fails := fails + 1; end if;

    -- Inbox zložka: iba owner/admin/accountant.
    begin
      insert into public.custom_document_categories (company_id, name, canonical_slug, created_by)
        -- canonical_slug musí spĺňať prod CHECK '^[a-z0-9]+( [a-z0-9]+)*$'
        -- (inak by zamietnutie spôsobil CHECK, nie RLS).
        values (ca, 'M1 ' || a.label, 'm1 ' || replace(replace(a.label, '+', ' '), '-', ' '), a.uid);
      v_ok := a.label in ('owner', 'admin+finance', 'admin-no-finance', 'admin-view-only', 'accountant');
    exception when others then
      v_ok := a.label not in ('owner', 'admin+finance', 'admin-no-finance', 'admin-view-only', 'accountant');
      if sqlstate <> '42501' then r := r || '     (non-RLS error ' || sqlstate || ': ' || left(sqlerrm, 80) || E')\n'; end if;
    end;
    r := r || format(E'%s %-17s create Inbox category\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label);
    if not v_ok then fails := fails + 1; end if;

    -- Účtovník nesmie meniť nefinančný doklad.
    if a.label = 'accountant' then
      update public.documents set note = 'x' where id = d_tp;
      get diagnostics v_n = row_count;
      v_ok := v_n = 0;
      r := r || format(E'%s %-17s cannot update TP (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
      if not v_ok then fails := fails + 1; end if;
    end if;

    execute 'reset role';
  end loop;

  -- --------------------------------------------------------------------------
  -- B. Legitímny zápis zamestnanca: 'created' k vlastnému čerstvému dokladu
  -- --------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.document_review_log (document_id, document_ref, user_id, action) values (d_emp, d_emp, u_emp, 'created');
    v_ok := true;
  exception when others then v_ok := false; r := r || 'ERR ' || sqlerrm || E'\n'; end;
  r := r || format(E'%s employee logs created for own fresh intake doc\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    insert into public.document_review_log (document_id, document_ref, user_id, action) values (d_emp, d_emp, u_emp, 'created');
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s employee cannot log created twice\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    insert into public.document_review_log (document_id, document_ref, user_id, action) values (d_old, d_old, u_emp, 'created');
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s employee cannot log created for own OLD doc\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    insert into public.document_review_log (document_id, document_ref, user_id, action) values (d_emp, d_emp, u_owner, 'created');
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s employee cannot log under another user_id\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    insert into public.document_review_log (document_id, document_ref, user_id, action, created_at)
      values (d_old, d_old, u_emp, 'created', now() - interval '1 day');
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s employee cannot backdate a log\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- C. Chat: zamestnanec nepripne faktúru (ani nezistí jej existenciu), TP áno.
  begin
    perform public.esblu_attach_chat_message_reference(v_msg, 'document', d_inv);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%ENTITY_NOT_FOUND_OR_FORBIDDEN%'; end;
  r := r || format(E'%s employee cannot pin INVOICE into chat (same error as non-existent)\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    perform public.esblu_attach_chat_message_reference(v_msg, 'document', d_tp);
    v_ok := true;
  exception when others then v_ok := false; r := r || 'ERR ' || sqlerrm || E'\n'; end;
  r := r || format(E'%s employee can pin readable TP into chat\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- Human Chat ostáva: zamestnanec vidí správy firemného kanála.
  select count(*) into v_n from public.chat_messages where conversation_id = v_conv;
  v_ok := v_n = 1;
  r := r || format(E'%s employee reads company chat (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', u_acc, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.chat_messages where conversation_id = v_conv;
  v_ok := v_n = 1;
  r := r || format(E'%s accountant reads company chat (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- --------------------------------------------------------------------------
  -- D. documents INSERT podľa roly a tvaru (20260930130000) + podpísané RPC
  -- --------------------------------------------------------------------------
  for a in select * from (values
      -- label, uid, expect_ok, document_type, status, forged_fields, forged_user, foreign_path, archived
      ('employee intake receipt', u_emp, true, 'receipt', 'needs_review', false, false, false, false),
      ('employee intake invoice', u_emp, true, 'invoice', 'needs_review', false, false, false, false),
      ('employee type other', u_emp, false, 'other', 'confirmed', false, false, false, false),
      ('employee TP', u_emp, false, 'vehicle_registration', 'confirmed', false, false, false, false),
      ('employee invoice confirmed', u_emp, false, 'invoice', 'confirmed', false, false, false, false),
      ('employee intake + fields', u_emp, false, 'receipt', 'needs_review', true, false, false, false),
      ('employee as other user', u_emp, false, 'receipt', 'needs_review', false, true, false, false),
      ('employee foreign file', u_emp, false, 'receipt', 'needs_review', false, false, true, false),
      ('employee pre-archived', u_emp, false, 'receipt', 'needs_review', false, false, false, true),
      ('admin-no-fin intake', u_admin, true, 'invoice', 'needs_review', false, false, false, false),
      ('admin-no-fin invoice+fields', u_admin, false, 'invoice', 'confirmed', true, false, false, false),
      ('admin-no-fin TP', u_admin, true, 'vehicle_registration', 'confirmed', true, false, false, false),
      ('admin+fin invoice+fields', u_admin_fin, true, 'invoice', 'confirmed', true, false, false, false),
      ('admin-view intake', u_admin_view, true, 'receipt', 'needs_review', false, false, false, false),
      ('admin-view invoice+fields', u_admin_view, false, 'invoice', 'confirmed', true, false, false, false),
      ('owner TP', u_owner, true, 'vehicle_registration', 'confirmed', true, false, false, false),
      ('owner invoice+fields', u_owner, true, 'invoice', 'confirmed', true, false, false, false),
      ('accountant invoice+fields', u_acc, true, 'invoice', 'confirmed', true, false, false, false),
      ('accountant TP', u_acc, false, 'vehicle_registration', 'confirmed', false, false, false, false),
      ('accountant other', u_acc, false, 'other', 'confirmed', false, false, false, false)
    ) as t(label, uid, expect_ok, dtype, dstatus, forged_fields, forged_user, foreign_path, archived)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', a.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      insert into public.documents (user_id, storage_bucket, storage_path, document_type, status, extracted_fields, archived_from_inbox_at, content_sha256)
        values (
          case when a.forged_user then u_owner else a.uid end,
          'ai-inbox-documents',
          (case when a.foreign_path then u_owner else a.uid end)::text || '/' || gen_random_uuid() || '.webp',
          a.dtype, a.dstatus,
          case when a.forged_fields then '{"supplier":"X","total":1}'::jsonb else null end,
          case when a.archived then now() else null end,
          encode(extensions.digest(convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex')
        );
      v_ok := a.expect_ok;
    exception when others then
      v_ok := not a.expect_ok;
      -- zamietnutie musí prísť z RLS (42501), nie z CHECK/FK — inak test nič nedokazuje
      if sqlstate <> '42501' then r := r || '     (non-RLS error ' || sqlstate || ': ' || left(sqlerrm, 80) || E')\n'; end if;
    end;
    r := r || format(E'%s documents INSERT: %s (expect %s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, case when a.expect_ok then 'allow' else 'deny' end);
    if not v_ok then fails := fails + 1; end if;
    execute 'reset role';
  end loop;

  -- Podpísané RPC: bez platného podpisu nič nepripojí (a nič neprezradí).
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.documents (id, user_id, storage_bucket, storage_path, document_type, status, content_sha256)
    values (gen_random_uuid(), u_emp, 'ai-inbox-documents', u_emp || '/' || gen_random_uuid() || '.webp', 'receipt', 'needs_review',
            encode(extensions.digest(convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'));
  select public.esblu_attach_intake_extraction(d_emp, '{"extracted_fields":{"total":9999},"ai_raw_output":{}}',
           extract(epoch from now())::bigint + 60, repeat('0', 64)) into v_ok;
  v_ok := v_ok is not true;
  r := r || format(E'%s employee cannot attach fields without server signature\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';
  select count(*) into v_n from public.documents where id = d_emp and extracted_fields is not null;
  v_ok := v_n = 0;
  r := r || format(E'%s intake doc still without fields (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;

  -- --------------------------------------------------------------------------
  -- E. ai_evidence INSERT/UPDATE/DELETE podľa roly a tvaru (20260930135000)
  -- --------------------------------------------------------------------------
  for a in select * from (values
      -- label, uid, expect_ok, kind, review_status, with_data, forged_user, foreign_photo, foreign_vehicle
      ('employee intake DN', u_emp, true, 'delivery_note', 'needs_review', false, false, false, false),
      ('employee weigh ticket with data', u_emp, false, 'weigh_ticket', 'confirmed_candidate', true, false, false, false),
      ('employee intake weigh ticket', u_emp, true, 'weigh_ticket', 'needs_review', false, false, false, false),
      ('admin weigh ticket with data', u_admin, true, 'weigh_ticket', 'confirmed', true, false, false, false),
      ('employee DN with data', u_emp, false, 'delivery_note', 'needs_review', true, false, false, false),
      ('employee DN confirmed', u_emp, false, 'delivery_note', 'confirmed', false, false, false, false),
      ('employee weigh confirmed', u_emp, false, 'weigh_ticket', 'confirmed', true, false, false, false),
      ('employee as owner', u_emp, false, 'delivery_note', 'needs_review', false, true, false, false),
      ('employee foreign photo', u_emp, false, 'delivery_note', 'needs_review', false, false, true, false),
      ('admin foreign vehicle', u_admin, false, 'weigh_ticket', 'pending', true, false, false, true),
      ('admin-no-fin DN data', u_admin, false, 'delivery_note', 'needs_review', true, false, false, false),
      ('admin-no-fin intake DN', u_admin, true, 'delivery_note', 'needs_review', false, false, false, false),
      ('admin+fin DN data', u_admin_fin, true, 'delivery_note', 'needs_review', true, false, false, false),
      ('admin-view DN data', u_admin_view, false, 'delivery_note', 'needs_review', true, false, false, false),
      ('admin-view intake DN', u_admin_view, true, 'delivery_note', 'needs_review', false, false, false, false),
      ('owner DN data', u_owner, true, 'delivery_note', 'confirmed_candidate', true, false, false, false),
      ('accountant intake DN', u_acc, false, 'delivery_note', 'needs_review', false, false, false, false),
      -- prod: ai_evidence NEMÁ trigger esblu_assign_company_id → cudzí company_id
      -- zamietne RLS (company_id = aktívna firma). Prísnejšie než PGlite stub.
      ('other-tenant into A', u_b, false, 'weigh_ticket', 'pending', true, false, false, false)
    ) as t(label, uid, expect_ok, kind, rstatus, with_data, forged_user, foreign_photo, foreign_vehicle)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', a.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      insert into public.ai_evidence (user_id, company_id, evidence_kind, document_type, review_status, supplier, netto, photo_url, vehicle_id, content_sha256)
        values (
          case when a.forged_user then u_owner else a.uid end,
          ca,  -- aj cudzí tenant „zvolí" firmu A; RLS to zamietne
          a.kind,
          case when a.kind = 'delivery_note' then 'dodací list' else 'vážny lístok' end,
          a.rstatus,
          case when a.with_data then 'Dodávateľ' end,
          case when a.with_data then 12.5 end,
          (case when a.foreign_photo then u_owner else a.uid end)::text || '/' || gen_random_uuid() || '.webp',
          case when a.foreign_vehicle then v_veh_b end,
          encode(extensions.digest(convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex')
        );
      v_ok := a.expect_ok;
    exception when others then
      v_ok := not a.expect_ok;
      -- zamietnutie musí prísť z RLS (42501), nie z CHECK/FK — inak test nič nedokazuje
      if sqlstate <> '42501' then r := r || '     (non-RLS error ' || sqlstate || ': ' || left(sqlerrm, 80) || E')\n'; end if;
    end;
    r := r || format(E'%s ai_evidence INSERT: %s (expect %s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, case when a.expect_ok then 'allow' else 'deny' end);
    if not v_ok then fails := fails + 1; end if;
    execute 'reset role';
  end loop;
  select count(*) into v_n from public.ai_evidence where user_id = u_b and company_id = ca;
  v_ok := v_n = 0;
  r := r || format(E'%s other tenant cannot land a row in company A (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;

  -- Zamestnanec nemení ani nemaže (ani vlastný vážny lístok).
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update public.ai_evidence set review_status = 'confirmed', netto = 999 where user_id = u_emp;
  get diagnostics v_n = row_count;
  v_ok := v_n = 0;
  r := r || format(E'%s employee cannot update ai_evidence (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;
  delete from public.ai_evidence where user_id = u_emp;
  get diagnostics v_n = row_count;
  v_ok := v_n = 0;
  r := r || format(E'%s employee cannot delete ai_evidence (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- --------------------------------------------------------------------------
  -- F. Podpísané RPC — podpis sa tu počíta V SQL z Vault kľúča (rovnaký
  --    formát ako helper). Zhodu Node ↔ PostgreSQL overuje npm run test:m1-authz-db.
  --    Preskočí sa (s poznámkou), ak Vault kľúč ešte neexistuje.
  -- --------------------------------------------------------------------------
  declare
    v_key text;
    v_ev uuid := gen_random_uuid();
    v_ev2 uuid := gen_random_uuid();
    v_payload text := '{"supplier":"Kameňolom","quantity":12.5,"unit":"t"}';
    v_exp bigint := extract(epoch from now())::bigint + 120;
    v_sig text;
    v_bad text;
    v_hash text := encode(extensions.digest(convert_to('m1-original-' || gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex');
    function_msg text;
  begin
    select ds.decrypted_secret into v_key from vault.decrypted_secrets ds where ds.name = 'esblu_intake_attest_key';
    if v_key is null then
      r := r || E'SKIP HMAC section — Vault secret esblu_intake_attest_key neexistuje\n';
    else
      perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      insert into public.ai_evidence (id, user_id, evidence_kind, document_type, review_status, photo_url, content_sha256)
        values (v_ev, u_emp, 'delivery_note', 'dodací list', 'needs_review', u_emp || '/' || gen_random_uuid() || '.webp', v_hash),
               (v_ev2, u_emp, 'delivery_note', 'dodací list', 'needs_review', u_emp || '/' || gen_random_uuid() || '.webp', v_hash);
      execute 'reset role';
      function_msg := '15:esblu-intake-v3;' || '11:ai_evidence;' || '36:' || v_ev::text || ';' || '36:' || u_emp::text || ';'
        || '13:delivery_note;' || '64:' || v_hash || ';' || octet_length(v_exp::text) || ':' || v_exp::text || ';'
        || '64:' || encode(extensions.digest(convert_to(v_payload, 'UTF8'), 'sha256'), 'hex') || ';';
      v_sig := encode(extensions.hmac(convert_to(function_msg, 'UTF8'), convert_to(v_key, 'UTF8'), 'sha256'), 'hex');
      v_bad := encode(extensions.hmac(convert_to(replace(function_msg, v_ev::text, v_ev2::text), 'UTF8'), convert_to(v_key, 'UTF8'), 'sha256'), 'hex');

      perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      v_ok := public.esblu_attach_evidence_intake_extraction(v_ev, v_payload, v_exp, v_bad) is not true;
      r := r || format(E'%s RPC: signature for another row rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      v_ok := public.esblu_attach_evidence_intake_extraction(v_ev, v_payload || ' ', v_exp, v_sig) is not true;
      r := r || format(E'%s RPC: changed data rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      v_ok := public.esblu_attach_evidence_intake_extraction(v_ev, v_payload, v_exp, v_sig) is true;
      r := r || format(E'%s RPC: correct signature accepted\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      v_ok := public.esblu_attach_evidence_intake_extraction(v_ev, v_payload, v_exp, v_sig) is not true;
      r := r || format(E'%s RPC: second use rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      -- Review uploaderom: oprava + potvrdenie (extracted → confirmed), potom žiadny browse.
      v_ok := public.esblu_confirm_evidence_intake(v_ev, '{"review_status":"confirmed"}'::jsonb) is not true;
      r := r || format(E'%s REVIEW: forbidden key rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      v_ok := public.esblu_confirm_evidence_intake(v_ev, '{"supplier":"Kameňolom a.s.","netto":12.4}'::jsonb) is true;
      r := r || format(E'%s REVIEW: uploader confirms own delivery note\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      v_ok := public.esblu_confirm_evidence_intake(v_ev, '{"netto":1}'::jsonb) is not true;
      r := r || format(E'%s REVIEW: second confirmation rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      select count(*) into v_n from public.ai_evidence where id = v_ev;
      v_ok := v_n = 0;
      r := r || format(E'%s REVIEW: employee cannot browse confirmed delivery note (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
      if not v_ok then fails := fails + 1; end if;
      execute 'reset role';
      select count(*) into v_n from public.ai_evidence_review_log where evidence_ref = v_ev and user_id = u_emp;
      v_ok := v_n >= 3;
      r := r || format(E'%s REVIEW: field edits + confirmation audited with actor (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
      if not v_ok then fails := fails + 1; end if;
      perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      v_ok := public.esblu_attach_evidence_intake_extraction(v_ev2, v_payload, v_exp, v_bad) is not true;
      r := r || format(E'%s RPC: someone else''s row rejected even with its valid signature\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      begin
        perform decrypted_secret from vault.decrypted_secrets limit 1;
        v_ok := false;
      exception when insufficient_privilege then v_ok := true; end;
      r := r || format(E'%s authenticated cannot read Vault\n', case when v_ok then 'ok  ' else 'FAIL' end);
      if not v_ok then fails := fails + 1; end if;
      execute 'reset role';
    end if;
  end;

  -- --------------------------------------------------------------------------
  -- G. Storage runtime (20260930140000) — príkazy, ktoré vykonáva Storage API
  --    (INSERT = upload, INSERT … ON CONFLICT DO UPDATE = upsert, UPDATE name =
  --    move, DELETE s storage.allow_delete_query = remove), pod rolou z JWT.
  --    Originál naviazaný na záznam sa nedá prepísať, presunúť ani zmazať —
  --    ani potvrdený, ani rozpracovaný, ani legacy (bez hashu), ani príloha.
  -- --------------------------------------------------------------------------
  declare
    d_rev uuid := gen_random_uuid();       -- zamestnancov bloček v review (≤ 24 h)
    d_rev_old uuid := gen_random_uuid();   -- zamestnancov bloček v review, starší než 24 h
    d_emp_conf uuid := gen_random_uuid();  -- zamestnancov potvrdený bloček
    d_ghost uuid := gen_random_uuid();     -- záznam bez objektu (objekt „zmizol")
    e_dn_conf uuid := gen_random_uuid();   -- potvrdený dodací list zamestnanca
    e_wt_rev uuid := gen_random_uuid();    -- vážny lístok zamestnanca v review
    p_inv text := u_owner || '/inv.pdf';
    p_tp text := u_owner || '/tp.jpg';
    p_old text := u_emp || '/old.jpg';
    p_rev text := u_emp || '/g-rev-' || gen_random_uuid() || '.webp';
    p_rev_old text := u_emp || '/g-rev-old-' || gen_random_uuid() || '.webp';
    p_emp_conf text := u_emp || '/g-conf-' || gen_random_uuid() || '.webp';
    p_ghost text := u_emp || '/g-ghost-' || gen_random_uuid() || '.webp';
    p_att text := u_owner || '/g-att-' || gen_random_uuid() || '.jpg';
    p_orphan_emp text := u_emp || '/g-orphan-' || gen_random_uuid() || '.webp';
    p_orphan_own text := u_owner || '/g-orphan-' || gen_random_uuid() || '.webp';
    p_new_emp text := u_emp || '/g-new-' || gen_random_uuid() || '.webp';
    p_ev_dn text := u_emp || '/g-dn-' || gen_random_uuid() || '.webp';
    p_ev_wt text := u_emp || '/g-wt-' || gen_random_uuid() || '.webp';
    p_ev_ghost text := u_emp || '/g-ev-ghost-' || gen_random_uuid() || '.webp';
    e_ghost uuid := gen_random_uuid();     -- záznam evidencie bez objektu
    v_h text := encode(extensions.digest(convert_to('m1-storage-' || gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex');
    s record;
  begin
    execute 'reset role';
    -- Fixtúry ako postgres.
    perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
    insert into public.documents (id, user_id, company_id, storage_bucket, storage_path, document_type, status, content_sha256, created_at) values
      (d_rev, u_emp, ca, 'ai-inbox-documents', p_rev, 'receipt', 'needs_review', v_h, now()),
      (d_rev_old, u_emp, ca, 'ai-inbox-documents', p_rev_old, 'receipt', 'needs_review', v_h, now() - interval '25 hours'),
      (d_emp_conf, u_emp, ca, 'ai-inbox-documents', p_emp_conf, 'receipt', 'confirmed', v_h, now()),
      (d_ghost, u_emp, ca, 'ai-inbox-documents', p_ghost, 'receipt', 'needs_review', v_h, now());
    insert into public.ai_evidence (id, user_id, company_id, evidence_kind, document_type, review_status, photo_url, content_sha256) values
      (e_dn_conf, u_emp, ca, 'delivery_note', 'dodací list', 'confirmed', p_ev_dn, v_h),
      (e_wt_rev, u_emp, ca, 'weigh_ticket', 'vážny lístok', 'needs_review', p_ev_wt, v_h),
      (e_ghost, u_emp, ca, 'weigh_ticket', 'vážny lístok', 'needs_review', p_ev_ghost, v_h);
    perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
    insert into public.document_attachments (document_id, company_id, user_id, storage_bucket, storage_path, attachment_type)
      values (d_tp, ca, u_owner, 'ai-inbox-documents', p_att, 'other');
    insert into storage.objects (bucket_id, name, owner_id) values
      ('ai-inbox-documents', p_inv, u_owner::text), ('ai-inbox-documents', p_tp, u_owner::text),
      ('ai-inbox-documents', p_old, u_emp::text), ('ai-inbox-documents', p_rev, u_emp::text),
      ('ai-inbox-documents', p_rev_old, u_emp::text), ('ai-inbox-documents', p_emp_conf, u_emp::text),
      ('ai-inbox-documents', p_att, u_owner::text), ('ai-inbox-documents', p_orphan_emp, u_emp::text),
      ('ai-inbox-documents', p_orphan_own, u_owner::text),
      ('ai-evidence-documents', p_ev_dn, u_emp::text), ('ai-evidence-documents', p_ev_wt, u_emp::text);

    -- G1 Upload (INSERT) ------------------------------------------------------
    for s in select * from (values
        ('employee upload new own path', u_emp, 'ai-inbox-documents', p_new_emp, true),
        ('employee upload onto path of existing record (object gone)', u_emp, 'ai-inbox-documents', p_ghost, false),
        ('employee upload into owner folder', u_emp, 'ai-inbox-documents', u_owner || '/g-x-' || gen_random_uuid() || '.webp', false),
        ('employee evidence upload new own path', u_emp, 'ai-evidence-documents', u_emp || '/g-ev-new-' || gen_random_uuid() || '.webp', true),
        ('employee evidence upload onto path of existing row (object gone)', u_emp, 'ai-evidence-documents', p_ev_ghost, false),
        ('other tenant upload into employee folder', u_b, 'ai-inbox-documents', u_emp || '/g-y-' || gen_random_uuid() || '.webp', false)
      ) as t(label, uid, bucket, path, expect_ok)
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', s.uid, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin
        insert into storage.objects (bucket_id, name, owner_id) values (s.bucket, s.path, s.uid::text);
        v_ok := s.expect_ok;
      exception when others then v_ok := not s.expect_ok; end;
      execute 'reset role';
      r := r || format(E'%s STORAGE upload: %s (expect %s)\n', case when v_ok then 'ok  ' else 'FAIL' end, s.label, case when s.expect_ok then 'allow' else 'deny' end);
      if not v_ok then fails := fails + 1; end if;
    end loop;

    -- G2 Upsert (INSERT … ON CONFLICT DO UPDATE) = prepis originálu -----------
    for s in select * from (values
        ('employee upsert own REVIEW original', u_emp, 'ai-inbox-documents', p_rev),
        ('employee upsert own CONFIRMED original', u_emp, 'ai-inbox-documents', p_emp_conf),
        ('employee upsert own LEGACY original', u_emp, 'ai-inbox-documents', p_old),
        ('owner upsert confirmed INVOICE original', u_owner, 'ai-inbox-documents', p_inv),
        ('owner upsert attachment', u_owner, 'ai-inbox-documents', p_att),
        ('employee upsert own orphan', u_emp, 'ai-inbox-documents', p_orphan_emp),
        ('employee upsert evidence REVIEW photo', u_emp, 'ai-evidence-documents', p_ev_wt)
      ) as t(label, uid, bucket, path)
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', s.uid, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin
        insert into storage.objects (bucket_id, name, owner_id, metadata) values (s.bucket, s.path, s.uid::text, '{"m1":"overwrite"}')
          on conflict (bucket_id, name) do update set metadata = excluded.metadata;
        get diagnostics v_n = row_count;
        v_ok := v_n = 0;
      exception when others then v_ok := true; end;
      execute 'reset role';
      r := r || format(E'%s STORAGE upsert denied: %s\n', case when v_ok then 'ok  ' else 'FAIL' end, s.label);
      if not v_ok then fails := fails + 1; end if;
    end loop;

    -- G3 Update / Move (UPDATE name, metadata) -------------------------------
    for s in select * from (values
        ('employee move own REVIEW original', u_emp, 'ai-inbox-documents', p_rev),
        ('employee move own orphan', u_emp, 'ai-inbox-documents', p_orphan_emp),
        ('owner move confirmed INVOICE', u_owner, 'ai-inbox-documents', p_inv),
        ('owner move legacy TP', u_owner, 'ai-inbox-documents', p_tp),
        ('owner move attachment', u_owner, 'ai-inbox-documents', p_att),
        ('owner move evidence DN photo', u_owner, 'ai-evidence-documents', p_ev_dn),
        ('employee move evidence REVIEW photo', u_emp, 'ai-evidence-documents', p_ev_wt)
      ) as t(label, uid, bucket, path)
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', s.uid, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin
        update storage.objects set name = s.path || '.moved', metadata = '{"m1":"moved"}'
          where bucket_id = s.bucket and name = s.path;
        get diagnostics v_n = row_count;
        v_ok := v_n = 0;
      exception when others then v_ok := true; end;
      execute 'reset role';
      r := r || format(E'%s STORAGE update/move denied: %s\n', case when v_ok then 'ok  ' else 'FAIL' end, s.label);
      if not v_ok then fails := fails + 1; end if;
    end loop;

    -- G4 Delete (Storage API remove) -----------------------------------------
    for s in select * from (values
        ('owner delete confirmed INVOICE original', u_owner, 'ai-inbox-documents', p_inv, false),
        ('admin+fin delete confirmed INVOICE original', u_admin_fin, 'ai-inbox-documents', p_inv, false),
        ('owner delete legacy TP original', u_owner, 'ai-inbox-documents', p_tp, false),
        ('owner delete employee LEGACY original', u_owner, 'ai-inbox-documents', p_old, false),
        ('owner delete attachment', u_owner, 'ai-inbox-documents', p_att, false),
        ('employee delete own REVIEW original', u_emp, 'ai-inbox-documents', p_rev, false),
        ('employee delete own CONFIRMED original', u_emp, 'ai-inbox-documents', p_emp_conf, false),
        ('owner delete confirmed DN photo', u_owner, 'ai-evidence-documents', p_ev_dn, false),
        ('owner delete REVIEW weigh-ticket photo', u_owner, 'ai-evidence-documents', p_ev_wt, false),
        ('employee delete own orphan (failed upload cleanup)', u_emp, 'ai-inbox-documents', p_orphan_emp, true),
        ('employee delete owner orphan', u_emp, 'ai-inbox-documents', p_orphan_own, false),
        ('owner delete own orphan', u_owner, 'ai-inbox-documents', p_orphan_own, true)
      ) as t(label, uid, bucket, path, expect_deleted)
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', s.uid, 'role', 'authenticated')::text, true);
      perform set_config('storage.allow_delete_query', 'true', true);
      execute 'set local role authenticated';
      begin
        delete from storage.objects where bucket_id = s.bucket and name = s.path;
        get diagnostics v_n = row_count;
        v_ok := (v_n = 1) = s.expect_deleted;
      exception when others then v_ok := not s.expect_deleted; r := r || 'ERR ' || sqlerrm || E'\n'; end;
      execute 'reset role';
      perform set_config('storage.allow_delete_query', 'false', true);
      r := r || format(E'%s STORAGE delete: %s (expect %s)\n', case when v_ok then 'ok  ' else 'FAIL' end, s.label, case when s.expect_deleted then 'deleted' else 'kept' end);
      if not v_ok then fails := fails + 1; end if;
    end loop;
    select count(*) into v_n from storage.objects
      where (bucket_id, name) in (('ai-inbox-documents', p_inv), ('ai-inbox-documents', p_tp), ('ai-inbox-documents', p_old),
                                  ('ai-inbox-documents', p_att), ('ai-inbox-documents', p_rev), ('ai-inbox-documents', p_emp_conf),
                                  ('ai-evidence-documents', p_ev_dn), ('ai-evidence-documents', p_ev_wt))
        and coalesce(metadata ->> 'm1', '') = '';
    v_ok := v_n = 8;
    r := r || format(E'%s STORAGE all 8 referenced originals intact and unmodified (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
    if not v_ok then fails := fails + 1; end if;

    -- G5 Read (SELECT = download / signed URL) --------------------------------
    for s in select * from (values
        ('employee reads own REVIEW original (resume)', u_emp, 'ai-inbox-documents', p_rev, true),
        ('employee reads own REVIEW original older than 24 h', u_emp, 'ai-inbox-documents', p_rev_old, false),
        ('employee reads own CONFIRMED receipt', u_emp, 'ai-inbox-documents', p_emp_conf, false),
        ('employee reads INVOICE', u_emp, 'ai-inbox-documents', p_inv, false),
        ('employee reads TP', u_emp, 'ai-inbox-documents', p_tp, true),
        ('owner reads employee REVIEW receipt', u_owner, 'ai-inbox-documents', p_rev, true),
        ('accountant reads INVOICE', u_acc, 'ai-inbox-documents', p_inv, true),
        ('accountant reads TP', u_acc, 'ai-inbox-documents', p_tp, false),
        ('admin-view reads INVOICE', u_admin_view, 'ai-inbox-documents', p_inv, true),
        ('admin-no-fin reads INVOICE', u_admin, 'ai-inbox-documents', p_inv, false),
        ('admin-no-fin reads employee REVIEW receipt', u_admin, 'ai-inbox-documents', p_rev, false),
        ('other tenant reads INVOICE', u_b, 'ai-inbox-documents', p_inv, false),
        ('other tenant reads employee REVIEW receipt', u_b, 'ai-inbox-documents', p_rev, false),
        ('employee reads own REVIEW weigh-ticket photo', u_emp, 'ai-evidence-documents', p_ev_wt, true),
        ('employee reads own CONFIRMED DN photo', u_emp, 'ai-evidence-documents', p_ev_dn, false),
        ('admin-view reads confirmed DN photo', u_admin_view, 'ai-evidence-documents', p_ev_dn, true),
        ('admin-no-fin reads confirmed DN photo', u_admin, 'ai-evidence-documents', p_ev_dn, false),
        ('other tenant reads REVIEW weigh-ticket photo', u_b, 'ai-evidence-documents', p_ev_wt, false)
      ) as t(label, uid, bucket, path, expect_read)
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', s.uid, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select count(*) into v_n from storage.objects where bucket_id = s.bucket and name = s.path;
      execute 'reset role';
      v_ok := (v_n = 1) = s.expect_read;
      r := r || format(E'%s STORAGE read: %s (expect %s)\n', case when v_ok then 'ok  ' else 'FAIL' end, s.label, case when s.expect_read then 'allow' else 'deny' end);
      if not v_ok then fails := fails + 1; end if;
    end loop;

    -- G6 anon: nič
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
    select count(*) into v_n from storage.objects where bucket_id in ('ai-inbox-documents', 'ai-evidence-documents');
    execute 'reset role';
    v_ok := v_n = 0;
    r := r || format(E'%s STORAGE anon sees no originals (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
    if not v_ok then fails := fails + 1; end if;
  end;

  -- anon
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    select count(*) into v_n from public.document_review_log;
    v_ok := v_n = 0;
  exception when insufficient_privilege then v_ok := true; end;
  execute 'reset role';
  r := r || format(E'%s anon sees no review log\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  raise exception E'M1 AUTHZ FOLLOW-UP MATRIX (rolled back) — failures: %\n%', fails, r;
end $$;
