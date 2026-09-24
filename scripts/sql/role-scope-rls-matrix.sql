-- =============================================================================
-- Regresný test: role scope (sklad iba na čítanie pre zamestnanca, dodacie
-- listy ako finančný podklad, príjem dokladov zamestnancom bez čítania).
--
-- Spúšťa sa ako `postgres` (Supabase SQL editor / MCP execute_sql). Všetko
-- je syntetické a na konci blok VŽDY vyhodí výnimku → rollback. `FAIL`
-- v texte výnimky = regresia. Pozri aj document-folders-rls-matrix.sql.
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
  v_item uuid;
  v_dn uuid;
  v_wt uuid;
  v_doc_dn uuid;
  v_n int;
  v_ok boolean;
  v_dpa text;
  a record;
begin
  select version into v_dpa from public.legal_documents
   where type = 'dpa' and effective_at <= now()
   order by effective_at desc, created_at desc, version desc limit 1;

  insert into auth.users (id, email, aud, role, instance_id)
  select u, 'role-scope-' || u || '@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
  from unnest(array[u_owner, u_admin_fin, u_admin, u_acc, u_emp, u_emp_forged, u_b]) u;
  insert into public.companies (id, name, owner_id) values (ca, 'Role scope A', u_owner), (cb, 'Role scope B', u_b);
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

  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  insert into public.inventory_items (company_id, user_id, name, quantity, unit) values (ca, u_owner, 'Cement 25 kg', 10, 'ks') returning id into v_item;

  -- Zamestnanec odošle dodací list (ai_evidence) a vážny lístok, a dodací list do documents.
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    -- Bez RETURNING: zamestnanec uložený dodací list už čítať nesmie.
    v_dn := gen_random_uuid();
    insert into public.ai_evidence (id, user_id, company_id, document_type, evidence_kind, supplier)
      values (v_dn, u_emp, ca, 'dodací list', 'delivery_note', 'Dodávateľ s.r.o.');
    v_ok := true;
  exception when others then v_ok := false; r := r || 'ERR ' || sqlerrm || E'\n'; end;
  r := r || format(E'%s employee submits delivery note (ai_evidence)\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    v_wt := gen_random_uuid();
    insert into public.ai_evidence (id, user_id, company_id, document_type, evidence_kind, supplier)
      values (v_wt, u_emp, ca, 'vážny lístok', 'weigh_ticket', 'Váha');
    v_ok := true;
  exception when others then v_ok := false; end;
  r := r || format(E'%s employee submits weigh ticket\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    insert into public.documents (id, user_id, company_id, storage_bucket, storage_path, document_type, status)
      values (gen_random_uuid(), u_emp, ca, 'ai-inbox-documents', 'x/dn.jpg', 'delivery_note', 'confirmed') returning id into v_doc_dn;
    v_ok := false; -- RETURNING musí zlyhať: zamestnanec riadok po uložení nevidí
  exception when others then v_ok := true; end;
  if v_doc_dn is null then
    insert into public.documents (user_id, company_id, storage_bucket, storage_path, document_type, status)
      values (u_emp, ca, 'ai-inbox-documents', 'x/dn.jpg', 'delivery_note', 'confirmed');
  end if;
  r := r || format(E'%s employee cannot read back the delivery note it submitted\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';
  select id into v_doc_dn from public.documents where company_id = ca and document_type = 'delivery_note' limit 1;

  for a in select * from (values
      ('owner', u_owner, true, true, true, true),
      ('admin+finance', u_admin_fin, true, true, true, true),
      ('admin-no-finance', u_admin, true, true, false, true),
      ('accountant', u_acc, false, false, true, false),
      ('employee', u_emp, true, false, false, true),
      ('employee-forged', u_emp_forged, true, false, false, true),
      ('other-tenant', u_b, false, false, false, false)
    ) as t(label, uid, inv_read, inv_write, dn_read, wt_read)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', a.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into v_n from public.inventory_items where id = v_item;
    v_ok := (v_n = 1) = a.inv_read;
    r := r || format(E'%s %-18s inventory read (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    begin
      insert into public.inventory_items (company_id, user_id, name, quantity) values (ca, a.uid, 'Test ' || a.label, 1);
      v_ok := a.inv_write;
    exception when others then v_ok := not a.inv_write; end;
    r := r || format(E'%s %-18s inventory create\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label);
    if not v_ok then fails := fails + 1; end if;

    update public.inventory_items set quantity = 999 where id = v_item;
    get diagnostics v_n = row_count;
    v_ok := (v_n = 1) = a.inv_write;
    r := r || format(E'%s %-18s inventory quantity change (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    select count(*) into v_n from public.ai_evidence where id = v_dn;
    v_ok := (v_n = 1) = a.dn_read;
    r := r || format(E'%s %-18s delivery note (ai_evidence) read (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    select count(*) into v_n from public.documents where id = v_doc_dn;
    v_ok := (v_n = 1) = a.dn_read;
    r := r || format(E'%s %-18s delivery note (documents) read (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    select count(*) into v_n from public.ai_evidence where id = v_wt;
    v_ok := (v_n = 1) = a.wt_read;
    r := r || format(E'%s %-18s weigh ticket read (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    delete from public.inventory_items where id = v_item and a.label = 'employee';
    get diagnostics v_n = row_count;
    if a.label = 'employee' then
      v_ok := v_n = 0;
      r := r || format(E'%s %-18s inventory delete denied (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, a.label, v_n);
      if not v_ok then fails := fails + 1; end if;
    end if;

    execute 'reset role';
  end loop;

  -- Legacy riadok bez evidence_kind, iba s popiskom → stále finančný.
  insert into public.ai_evidence (id, user_id, company_id, document_type) values (gen_random_uuid(), u_emp, ca, 'Lieferschein') returning id into v_dn;
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.ai_evidence where id = v_dn;
  execute 'reset role';
  v_ok := v_n = 0;
  r := r || format(E'%s legacy label-only delivery note hidden from employee (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;

  -- anon
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    select count(*) into v_n from public.inventory_items;
    v_ok := v_n = 0;
  exception when insufficient_privilege then v_ok := true; end;
  execute 'reset role';
  r := r || format(E'%s anon sees no inventory\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  raise exception E'ROLE SCOPE MATRIX (rolled back) — failures: %\n%', fails, r;
end $$;
