-- =============================================================================
-- Regresný test: priečinky dokladov, balíky a udalosti stiahnutia — RLS matica.
--
-- Spúšťa sa proti databáze ako `postgres` (Supabase SQL editor / MCP
-- execute_sql). Celý blok vytvorí syntetické firmy, používateľov a doklady,
-- prepína sa medzi rolami cez `set local role` + request.jwt.claims a na
-- konci VŽDY vyhodí výnimku — tým sa všetko vráti späť (rollback). Výsledok
-- je text výnimky: riadok na kontrolu, `FAIL` znamená regresiu.
--
-- Žiadne reálne zákaznícke dáta sa nečítajú ani nemenia.
-- =============================================================================
do $$
declare
  r text := '';
  fails int := 0;
  v_company_a uuid := gen_random_uuid();
  v_company_b uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  u_acc uuid := gen_random_uuid();
  u_admin_fin uuid := gen_random_uuid();
  u_admin_nofin uuid := gen_random_uuid();
  u_emp uuid := gen_random_uuid();
  u_emp_forged uuid := gen_random_uuid();
  u_owner_b uuid := gen_random_uuid();
  v_folder_a uuid;
  v_folder_b uuid;
  v_invoice_a uuid;
  v_invoice_b uuid;
  v_receipt_a uuid;
  v_insurance_a uuid;
  v_pkg uuid;
  v_pkg2 uuid;
  v_n int;
  v_ok boolean;
  v_sha text := repeat('a', 64);
  v_dpa text;
  actor record;
begin
  select version into v_dpa from public.legal_documents
   where type = 'dpa' and effective_at <= now()
   order by effective_at desc, created_at desc, version desc limit 1;

  -- ---------------------------------------------------------------- fixtures
  insert into auth.users (id, email, aud, role, instance_id)
  select u, 'rls-matrix-' || u || '@example.invalid', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000'
  from unnest(array[u_owner, u_acc, u_admin_fin, u_admin_nofin, u_emp, u_emp_forged, u_owner_b]) u;

  insert into public.companies (id, name, owner_id) values
    (v_company_a, 'RLS matrix A', u_owner),
    (v_company_b, 'RLS matrix B', u_owner_b);

  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (v_company_a, u_owner, 'owner', 'active', '{}'),
    (v_company_a, u_acc, 'accountant', 'active', '{}'),
    (v_company_a, u_admin_fin, 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    (v_company_a, u_admin_nofin, 'admin', 'active', '{}'),
    (v_company_a, u_emp, 'employee', 'active', '{}'),
    (v_company_a, u_emp_forged, 'employee', 'active', '{"finance":{"view":true,"manage":true}}'),
    (v_company_b, u_owner_b, 'owner', 'active', '{}');

  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values
    (v_company_a, v_dpa, u_owner, 'company_dpa_gate'),
    (v_company_b, v_dpa, u_owner_b, 'company_dpa_gate');

  insert into public.invoices (id, company_id, direction, kind) values
    (gen_random_uuid(), v_company_a, 'issued', 'regular_invoice') returning id into v_invoice_a;
  insert into public.invoices (id, company_id, direction, kind) values
    (gen_random_uuid(), v_company_b, 'issued', 'regular_invoice') returning id into v_invoice_b;

  -- Dokumenty vkladá vlastník (trigger priradí firmu podľa auth.uid()).
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  insert into public.documents (storage_bucket, storage_path, company_id, document_type, status, user_id)
    values ('ai-inbox-documents', 'rls/receipt.jpg', v_company_a, 'receipt', 'confirmed', u_owner)
    returning id into v_receipt_a;
  insert into public.documents (storage_bucket, storage_path, company_id, document_type, status, user_id)
    values ('ai-inbox-documents', 'rls/pzp.jpg', v_company_a, 'insurance', 'confirmed', u_owner)
    returning id into v_insurance_a;

  insert into public.document_folders (company_id, name, created_by)
    values (v_company_a, 'August 2026', u_owner) returning id into v_folder_a;
  insert into public.document_folders (company_id, name, created_by)
    values (v_company_b, 'Cudzí', u_owner_b) returning id into v_folder_b;

  -- ------------------------------------------------------- role matrix, A
  for actor in
    select * from (values
      ('owner', u_owner, true),
      ('accountant', u_acc, true),
      ('admin+finance', u_admin_fin, true),
      ('admin-no-finance', u_admin_nofin, false),
      ('employee', u_emp, false),
      ('employee-forged-finance', u_emp_forged, false),
      ('owner-other-tenant', u_owner_b, false)
    ) as t(label, uid, allowed)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', actor.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    -- vidí priečinok A?
    select count(*) into v_n from public.document_folders where id = v_folder_a;
    v_ok := (v_n = 1) = actor.allowed;
    r := r || format(E'%s %-24s see folder A: %s\n', case when v_ok then 'ok  ' else 'FAIL' end, actor.label, v_n);
    if not v_ok then fails := fails + 1; end if;

    -- pridá faktúru A do priečinka A?
    begin
      insert into public.document_folder_items (folder_id, company_id, entity_type, invoice_id)
        values (v_folder_a, v_company_a, 'invoice', v_invoice_a);
      v_ok := actor.allowed;
      delete from public.document_folder_items where folder_id = v_folder_a and invoice_id = v_invoice_a;
    exception when others then
      v_ok := not actor.allowed;
    end;
    r := r || format(E'%s %-24s add invoice A to folder A\n', case when v_ok then 'ok  ' else 'FAIL' end, actor.label);
    if not v_ok then fails := fails + 1; end if;

    -- založí priečinok vo firme A?
    begin
      insert into public.document_folders (company_id, name, created_by)
        values (v_company_a, 'Test ' || actor.label, actor.uid);
      v_ok := actor.allowed;
    exception when others then
      v_ok := not actor.allowed;
    end;
    r := r || format(E'%s %-24s create folder in A\n', case when v_ok then 'ok  ' else 'FAIL' end, actor.label);
    if not v_ok then fails := fails + 1; end if;

    -- udalosti stiahnutia sa priamo zapísať nedajú nikomu
    begin
      insert into public.document_download_events (company_id, package_id, entity_type, entity_ref, download_kind)
        values (v_company_a, gen_random_uuid(), 'invoice', v_invoice_a, 'folder');
      v_ok := false;
    exception when others then
      v_ok := true;
    end;
    r := r || format(E'%s %-24s direct event insert denied\n', case when v_ok then 'ok  ' else 'FAIL' end, actor.label);
    if not v_ok then fails := fails + 1; end if;

    execute 'reset role';
  end loop;

  -- ------------------------------------------------ strict type whitelist
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.document_folder_items (folder_id, company_id, entity_type, document_id)
      values (v_folder_a, v_company_a, 'document', v_insurance_a);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s owner cannot add PZP (non-accounting type)\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  begin
    insert into public.document_folder_items (folder_id, company_id, entity_type, document_id)
      values (v_folder_a, v_company_a, 'document', v_receipt_a);
    v_ok := true;
  exception when others then v_ok := false; end;
  r := r || format(E'%s owner adds receipt to folder A\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  begin
    insert into public.document_folder_items (folder_id, company_id, entity_type, invoice_id, document_id)
      values (v_folder_a, v_company_a, 'invoice', v_invoice_a, v_receipt_a);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s mixed reference rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- ----------------------------------------------------- cross tenant
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner_b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.document_folder_items (folder_id, company_id, entity_type, invoice_id)
      values (v_folder_b, v_company_b, 'invoice', v_invoice_a);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s tenant B cannot add invoice A to own folder\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  begin
    insert into public.document_folder_items (folder_id, company_id, entity_type, invoice_id)
      values (v_folder_a, v_company_b, 'invoice', v_invoice_b);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s tenant B cannot add into folder A\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  select count(*) into v_n from public.document_folder_items where folder_id = v_folder_a;
  r := r || format(E'%s tenant B sees 0 items of folder A (%s)\n', case when v_n = 0 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 0 then fails := fails + 1; end if;

  update public.document_folders set name = 'hijack' where id = v_folder_a;
  get diagnostics v_n = row_count;
  r := r || format(E'%s tenant B cannot rename folder A (%s rows)\n', case when v_n = 0 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 0 then fails := fails + 1; end if;

  delete from public.document_folders where id = v_folder_a;
  get diagnostics v_n = row_count;
  r := r || format(E'%s tenant B cannot delete folder A (%s rows)\n', case when v_n = 0 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 0 then fails := fails + 1; end if;
  execute 'reset role';

  -- --------------------------------------------- download confirmation
  perform set_config('request.jwt.claims', json_build_object('sub', u_acc, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  insert into public.document_export_packages (company_id, created_by, export_kind, folder_id, item_count,
      file_count, package_bytes, package_sha256, manifest_sha256, package_filename, manifest_schema_version)
    values (v_company_a, u_acc, 'folder', v_folder_a, 2, 4, 100, v_sha, v_sha, 't.zip', '2.0')
    returning id into v_pkg;
  insert into public.document_export_package_items (package_id, company_id, entity_type, entity_ref, invoice_id)
    values (v_pkg, v_company_a, 'invoice', v_invoice_a, v_invoice_a);
  insert into public.document_export_package_items (package_id, company_id, entity_type, entity_ref, document_id)
    values (v_pkg, v_company_a, 'document', v_receipt_a, v_receipt_a);

  -- cudzia faktúra sa do položiek balíka nedostane
  begin
    insert into public.document_export_package_items (package_id, company_id, entity_type, entity_ref, invoice_id)
      values (v_pkg, v_company_a, 'invoice', v_invoice_b, v_invoice_b);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s package item for foreign invoice rejected\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;

  -- zlý odtlačok = nič sa nezapíše (balík neprišiel celý)
  begin
    perform public.esblu_confirm_package_download(v_pkg, repeat('b', 64));
    v_ok := false;
  exception when others then v_ok := true; end;
  select count(*) into v_n from public.document_download_events where package_id = v_pkg;
  v_ok := v_ok and v_n = 0;
  r := r || format(E'%s hash mismatch -> no events (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;

  -- správny odtlačok = presne 2 udalosti
  v_n := public.esblu_confirm_package_download(v_pkg, v_sha);
  r := r || format(E'%s first confirm -> %s events\n', case when v_n = 2 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 2 then fails := fails + 1; end if;

  -- opakované potvrdenie toho istého balíka nič nepripočíta
  v_n := public.esblu_confirm_package_download(v_pkg, v_sha);
  r := r || format(E'%s repeat confirm same package -> %s events\n', case when v_n = 0 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 0 then fails := fails + 1; end if;

  -- druhé stiahnutie = nový balík = počet 2
  insert into public.document_export_packages (company_id, created_by, export_kind, folder_id, item_count,
      file_count, package_bytes, package_sha256, manifest_sha256, package_filename, manifest_schema_version)
    values (v_company_a, u_acc, 'folder', v_folder_a, 1, 2, 50, v_sha, v_sha, 't2.zip', '2.0')
    returning id into v_pkg2;
  insert into public.document_export_package_items (package_id, company_id, entity_type, entity_ref, invoice_id)
    values (v_pkg2, v_company_a, 'invoice', v_invoice_a, v_invoice_a);
  perform public.esblu_confirm_package_download(v_pkg2, v_sha);

  select download_count into v_n from public.esblu_document_download_summary()
   where entity_type = 'invoice' and entity_ref = v_invoice_a;
  r := r || format(E'%s re-download -> invoice count %s\n', case when v_n = 2 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 2 then fails := fails + 1; end if;

  select accountant_download_count into v_n from public.esblu_document_download_summary()
   where entity_type = 'document' and entity_ref = v_receipt_a;
  r := r || format(E'%s receipt accountant count %s\n', case when v_n = 1 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 1 then fails := fails + 1; end if;

  -- udalosti sa nedajú zmeniť ani zmazať
  begin
    update public.document_download_events set downloaded_at = now() - interval '1 year' where package_id = v_pkg;
    get diagnostics v_n = row_count;
    v_ok := v_n = 0;
  exception when insufficient_privilege then v_ok := true; v_n := 0; end;
  r := r || format(E'%s events immutable (update %s rows)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- iný používateľ nemôže potvrdiť cudzí balík
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.esblu_confirm_package_download(v_pkg, v_sha);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s owner cannot confirm accountant package\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- zamestnanec nevidí udalosti ani súhrn
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp_forged, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.esblu_document_download_summary();
  r := r || format(E'%s forged employee summary rows %s\n', case when v_n = 0 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 0 then fails := fails + 1; end if;
  begin
    perform public.esblu_confirm_package_download(v_pkg, v_sha);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s forged employee confirm denied\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- tenant B nevidí udalosti A
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner_b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.document_download_events;
  r := r || format(E'%s tenant B sees %s events\n', case when v_n = 0 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 0 then fails := fails + 1; end if;
  execute 'reset role';

  -- anon nemá žiadny prístup
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    select count(*) into v_n from public.document_folders;
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; end;
  r := r || format(E'%s anon denied on document_folders\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  begin
    perform public.esblu_confirm_package_download(v_pkg, v_sha);
    v_ok := false;
  exception when others then v_ok := true; end;
  r := r || format(E'%s anon cannot confirm\n', case when v_ok then 'ok  ' else 'FAIL' end);
  if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- priečinok nevlastní doklad: zmazanie priečinka nechá faktúru aj dokument
  delete from public.document_folders where id = v_folder_a;
  select count(*) into v_n from public.invoices where id = v_invoice_a;
  select v_n + count(*) into v_n from public.documents where id = v_receipt_a;
  r := r || format(E'%s folder delete keeps canonical records (%s/2)\n', case when v_n = 2 then 'ok  ' else 'FAIL' end, v_n);
  if v_n <> 2 then fails := fails + 1; end if;

  raise exception E'RLS MATRIX RESULT (rolled back) — failures: %\n%', fails, r;
end $$;
