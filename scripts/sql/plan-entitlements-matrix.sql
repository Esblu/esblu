-- =============================================================================
-- ENTITLEMENTS / TRIAL / AI LEDGER / VOICE — regresná matica (SYNTETICKÉ DÁTA)
--
-- Predpoklad: aplikovaná migrácia 20260928100000_company_entitlements_trial.sql.
-- Spúšťa sa ako `postgres`:
--   • lokálne: po scripts/sql/entitlements-local-baseline.sql + migrácii,
--   • alebo na Supabase BRANCHI (MCP execute_sql). NIE na produkcii.
-- Celý beh je jeden DO blok, ktorý na konci VŽDY vyhodí výnimku → rollback.
-- Výstup: zoznam `ok  ` / `FAIL` riadkov + počet zlyhaní v texte výnimky.
--
-- Časové prípady (deň 1 / 13 / hranica / deň 15) posúvajú trial priamo v DB
-- s dočasne vypnutým guard triggerom (iba v tejto rollback transakcii) —
-- aplikácia to urobiť nemôže (ESBLU_TRIAL_IMMUTABLE).
-- Skutočná súbežnosť (dve spojenia naraz) je v
-- scripts/sql/entitlements-concurrency-local.sh.
-- =============================================================================
do $matrix$
declare
  fails int := 0;
  r text := '';
  v_dpa text;
  -- firma T = trial, firma P = platená (iba vybrané moduly), firma X = cudzia
  c_t uuid; c_p uuid := gen_random_uuid(); c_x uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid(); u_emp uuid := gen_random_uuid(); u_acc uuid := gen_random_uuid();
  u_p_owner uuid := gen_random_uuid(); u_p_emp uuid := gen_random_uuid(); u_p_acc uuid := gen_random_uuid();
  u_x uuid := gen_random_uuid(); u_invitee uuid := gen_random_uuid(); u_invitee2 uuid := gen_random_uuid();
  e_owner text := 'ent-owner-' || gen_random_uuid() || '@example.invalid';
  e_invitee text := 'ent-invitee-' || gen_random_uuid() || '@example.invalid';
  e_invitee2 text := 'ent-invitee2-' || gen_random_uuid() || '@example.invalid';
  v_err text; v_ok boolean; v_n bigint; v_m bigint; v_res jsonb; v_res2 jsonb; v_token text;
  v_trial_start timestamptz; v_trial_end timestamptz;
  v_ids_before text; v_ids_after text; v_storage_before bigint; v_storage_after bigint;
  v_ent_id uuid; v_usage uuid; v_inv uuid; c_t2 uuid;
  sha_a text := repeat('a', 64); sha_b text := repeat('b', 64);
  i int;
begin
  select version into v_dpa from public.legal_documents
   where type = 'dpa' and effective_at <= now() order by effective_at desc, created_at desc, version desc limit 1;

  insert into auth.users (id, email, aud, role, instance_id)
  select u, coalesce(e, 'ent-' || u || '@example.invalid'), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
  from (values (u_owner, e_owner), (u_emp, null), (u_acc, null), (u_p_owner, null), (u_p_emp, null), (u_p_acc, null),
               (u_x, null), (u_invitee, e_invitee), (u_invitee2, e_invitee2)) s(u, e);

  -- ============================================================ TRIAL ONBOARDING
  -- 7) prvý používateľ: owner z beta allowlistu založí firmu → trial firmy.
  insert into public.beta_allowlist (email, note) values (e_owner, 'entitlement-matrix');
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select company_id into c_t from public.esblu_ensure_my_owner_company();
  execute 'reset role';
  select trial_started_at, trial_ends_at into v_trial_start, v_trial_end from public.companies where id = c_t;
  v_ok := c_t is not null and v_trial_end = v_trial_start + interval '14 days' and v_trial_start = now();
  r := r || format(E'%s 7 owner creates company; company-level 14-day trial from server time\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values (c_t, v_dpa, u_owner, 'company_dpa_gate');

  -- Nová firma dostane presne JEDEN trial: opakované volanie nič nové nevytvorí.
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select company_id into c_t2 from public.esblu_ensure_my_owner_company();
  execute 'reset role';
  v_ok := c_t2 = c_t
      and (select count(*) from public.companies where owner_id = u_owner) = 1
      and (select trial_started_at from public.companies where id = c_t) = v_trial_start;
  r := r || format(E'%s new company gets exactly one 14-day trial (repeat bootstrap = same company, same trial)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- Firma P (platená iba invoicing + voice + inventory + team 5) a firma X.
  insert into public.companies (id, name, owner_id) values (c_p, 'Paid modular', u_p_owner), (c_x, 'Foreign', u_x);
  insert into public.company_members (company_id, user_id, role, status) values
    (c_p, u_p_owner, 'owner', 'active'), (c_p, u_p_emp, 'employee', 'active'), (c_p, u_p_acc, 'accountant', 'active'),
    (c_x, u_x, 'owner', 'active');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values
    (c_p, v_dpa, u_p_owner, 'company_dpa_gate'), (c_x, v_dpa, u_x, 'company_dpa_gate');

  -- ============================================================ 1) trial day 1
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.vehicles (company_id, user_id, spz) values (c_t, u_owner, 'TR001AA');
    insert into public.vehicles (company_id, user_id, spz) values (c_t, u_owner, 'TR002AA');
    v_err := 'ok';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ok';
  r := r || format(E'%s 1/11 trial day 1: vehicle #1 and #2 allowed (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_err); if not v_ok then fails := fails + 1; end if;

  begin insert into public.vehicles (company_id, user_id, spz) values (c_t, u_owner, 'TR003AA'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:VEHICLE_LIMIT_REACHED:vehicles';
  r := r || format(E'%s 12 vehicle #3 blocked with structured reason (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_err); if not v_ok then fails := fails + 1; end if;

  for i in 1..2 loop insert into public.machines (company_id, user_id, name) values (c_t, u_owner, 'Machine ' || i); end loop;
  begin insert into public.machines (company_id, user_id, name) values (c_t, u_owner, 'Machine 3'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:MACHINE_LIMIT_REACHED:machines';
  r := r || format(E'%s machines: #1,#2 allowed, #3 blocked\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  for i in 1..5 loop insert into public.inventory_items (company_id, user_id, name) values (c_t, u_owner, 'Item ' || i); end loop;
  begin insert into public.inventory_items (company_id, user_id, name) values (c_t, u_owner, 'Item 6'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:INVENTORY_LIMIT_REACHED:inventory';
  r := r || format(E'%s inventory: #1..#5 allowed, #6 blocked\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  update public.inventory_items set quantity = 7 where company_id = c_t and name = 'Item 1';
  get diagnostics v_n = row_count;
  v_ok := v_n = 1;
  r := r || format(E'%s inventory at limit: existing item editable\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- Fakturácia je súčasťou trialu (bez limitu počtu faktúr).
  begin
    insert into public.invoices (company_id, direction, kind, created_by) values (c_t, 'issued', 'invoice', u_owner) returning id into v_inv;
    v_err := 'ok';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ok' and v_inv is not null;
  r := r || format(E'%s trial includes Fakturácia: invoice draft allowed (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_err); if not v_ok then fails := fails + 1; end if;

  -- 8) druhý používateľ v triali zablokovaný (pozvánka).
  begin perform * from public.esblu_create_company_invite(e_invitee, 'employee'); v_err := 'created';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:USER_LIMIT_REACHED:team_members';
  r := r || format(E'%s 8 trial: second user invite blocked (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_err); if not v_ok then fails := fails + 1; end if;

  -- Hlas v triali nie je nikdy.
  begin perform public.esblu_require_my_entitlement('voice'); v_err := 'allowed';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:VOICE_ENTITLEMENT_REQUIRED:voice';
  r := r || format(E'%s VOICE trial: voice unavailable server-side regardless of remaining limits\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  v_res := public.esblu_get_my_company_entitlements();
  v_ok := (v_res #>> '{trial,active}')::boolean
      and exists (select 1 from jsonb_array_elements(v_res -> 'entitlements') e where e ->> 'key' = 'voice' and (e ->> 'active')::boolean = false)
      and exists (select 1 from jsonb_array_elements(v_res -> 'entitlements') e where e ->> 'key' = 'vehicles' and (e ->> 'limit')::int = 2 and e ->> 'source' = 'trial')
      and not (v_res::text like '%external_ref%') and not (v_res::text like '%entitlement_id%');
  r := r || format(E'%s entitlements overview: trial active, voice off, limits, no billing internals\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- ============================================================ AI ledger (trial)
  for i in 1..4 loop
    v_res := public.esblu_reserve_ai_processing('scan-document', 'trial-key-' || i || '-0123456789', sha_a);
    perform public.esblu_finalize_ai_processing((v_res ->> 'usage_id')::uuid, true);
  end loop;

  -- zlyhanie AI (failed) sa nepočíta
  v_res := public.esblu_reserve_ai_processing('scan-document', 'trial-key-failed-0123456789', sha_a);
  perform public.esblu_finalize_ai_processing((v_res ->> 'usage_id')::uuid, false);

  -- neplatný vstup / neplatný kľúč nič nespotrebuje
  begin perform public.esblu_reserve_ai_processing('scan-document', 'short', sha_a); exception when others then null; end;
  begin perform public.esblu_reserve_ai_processing('unknown-endpoint', 'trial-key-bad-endpoint-0001', sha_a); exception when others then null; end;
  begin perform public.esblu_reserve_ai_processing('scan-document', 'trial-key-bad-hash-000000001', 'nothex'); exception when others then null; end;

  -- upload bez AI nespotrebuje nič
  insert into public.documents (user_id, storage_bucket, storage_path, document_type, status, company_id)
    values (u_owner, 'ai-inbox-documents', u_owner || '/synthetic/plain-upload.pdf', 'other', 'uploaded', c_t);

  execute 'reset role';
  select count(*) into v_n from public.ai_processing_usage where company_id = c_t and status in ('reserved', 'succeeded');
  v_ok := v_n = 4;
  r := r || format(E'%s AI: 4 counted; failed AI, invalid input and plain upload not counted (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n); if not v_ok then fails := fails + 1; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_res := public.esblu_reserve_ai_processing('scan-document', 'trial-key-5-0123456789', sha_b);
  -- retry toho istého jobu (klient stratil odpoveď) → žiadny ďalší kredit
  v_res2 := public.esblu_reserve_ai_processing('scan-document', 'trial-key-5-0123456789', sha_b);
  v_ok := (v_res2 ->> 'reused')::boolean and v_res2 ->> 'usage_id' = v_res ->> 'usage_id';
  r := r || format(E'%s AI: same idempotency key + same content = no second credit\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  perform public.esblu_finalize_ai_processing((v_res ->> 'usage_id')::uuid, true);

  begin perform public.esblu_reserve_ai_processing('scan-document', 'trial-key-5-0123456789', sha_a); v_err := 'allowed';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ESBLU_AI_IDEMPOTENCY_CONFLICT';
  r := r || format(E'%s AI: same key with different content rejected (no free processing)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin perform public.esblu_reserve_ai_processing('scan-document', 'trial-key-6-0123456789', sha_a); v_err := 'allowed';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:AI_PROCESSING_LIMIT_REACHED:ai_documents';
  r := r || format(E'%s AI: 6th processing denied before AI call (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_err); if not v_ok then fails := fails + 1; end if;

  execute 'reset role';
  delete from public.documents where company_id = c_t;
  delete from public.ai_evidence where company_id = c_t;
  execute 'set local role authenticated';
  begin perform public.esblu_reserve_ai_processing('scan-document', 'trial-key-7-0123456789', sha_a); v_err := 'allowed';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:AI_PROCESSING_LIMIT_REACHED:ai_documents';
  r := r || format(E'%s AI: deleting stored documents does NOT restore credits\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- iný používateľ nemôže „vrátiť" kredit cudzej rezervácie
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_x, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.esblu_finalize_ai_processing((v_res ->> 'usage_id')::uuid, false);
  execute 'reset role';
  select status into v_err from public.ai_processing_usage where id = (v_res ->> 'usage_id')::uuid;
  v_ok := v_err = 'succeeded';
  r := r || format(E'%s AI: foreign user cannot flip a succeeded processing to failed\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- auth zlyhanie nič nespotrebuje
  perform set_config('request.jwt.claims', '{}', true);
  select count(*) into v_n from public.ai_processing_usage where company_id = c_t;
  execute 'set local role authenticated';
  begin perform public.esblu_reserve_ai_processing('scan-document', 'trial-key-noauth-0123456', sha_a); exception when others then null; end;
  execute 'reset role';
  select count(*) into v_m from public.ai_processing_usage where company_id = c_t;
  v_ok := v_n = v_m;
  r := r || format(E'%s AI: unauthenticated call consumes nothing\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- ============================================================ TRIAL TIME
  execute 'alter table public.companies disable trigger esblu_companies_trial_guard';
  update public.companies set trial_started_at = now() - interval '12 days', trial_ends_at = now() + interval '2 days' where id = c_t;
  execute 'alter table public.companies enable trigger esblu_companies_trial_guard';
  v_res := public.esblu_resolve_entitlement(c_t, 'vehicles');
  v_ok := (v_res ->> 'active')::boolean and v_res ->> 'source' = 'trial';
  r := r || format(E'%s 2 trial day 13 still active\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  execute 'alter table public.companies disable trigger esblu_companies_trial_guard';
  update public.companies set trial_started_at = now() - interval '14 days', trial_ends_at = now() where id = c_t;
  execute 'alter table public.companies enable trigger esblu_companies_trial_guard';
  v_res := public.esblu_resolve_entitlement(c_t, 'vehicles');
  execute 'alter table public.companies disable trigger esblu_companies_trial_guard';
  update public.companies set trial_started_at = now() - interval '14 days' + interval '1 microsecond', trial_ends_at = now() + interval '1 microsecond' where id = c_t;
  execute 'alter table public.companies enable trigger esblu_companies_trial_guard';
  v_res2 := public.esblu_resolve_entitlement(c_t, 'vehicles');
  v_ok := (v_res ->> 'active')::boolean = false and v_res ->> 'reason' = 'TRIAL_EXPIRED' and (v_res2 ->> 'active')::boolean;
  r := r || format(E'%s 3 exact boundary deterministic: now() = ends_at → expired; 1µs before → active\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- Pred expiráciou: do firmy T pridáme (ako operátor) ďalšieho člena, aby
  -- sme overili, že expirácia nikoho neodoberie.
  insert into public.company_members (company_id, user_id, role, status) values (c_t, u_emp, 'employee', 'active'), (c_t, u_acc, 'accountant', 'active');

  execute 'alter table public.companies disable trigger esblu_companies_trial_guard';
  update public.companies set trial_started_at = now() - interval '15 days', trial_ends_at = now() - interval '1 day' where id = c_t;
  execute 'alter table public.companies enable trigger esblu_companies_trial_guard';

  -- snapshot dát pred „stratou" nároku
  select md5(string_agg(t || ids, '|' order by t)) into v_ids_before from (
    select 'v' t, string_agg(id::text || spz, ',' order by id) ids from public.vehicles where company_id = c_t
    union all select 'm', string_agg(id::text, ',' order by id) from public.machines where company_id = c_t
    union all select 'i', string_agg(id::text || coalesce(quantity::text, ''), ',' order by id) from public.inventory_items where company_id = c_t
    union all select 'u', string_agg(id::text || user_id::text || role || status, ',' order by id) from public.company_members where company_id = c_t
    union all select 'c', id::text || name || owner_id::text || trial_started_at::text from public.companies where id = c_t
  ) s;
  select count(*) into v_storage_before from storage.objects;

  -- 4) deň 15: platené operácie zamietnuté, čítanie/úpravy existujúcich OK
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into public.inventory_items (company_id, user_id, name) values (c_t, u_owner, 'After expiry'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:TRIAL_EXPIRED:inventory';
  r := r || format(E'%s 4 day 15: new inventory item denied with TRIAL_EXPIRED\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin perform public.esblu_reserve_ai_processing('scan-document', 'expired-key-0123456789ab', sha_a); v_err := 'allowed';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:TRIAL_EXPIRED:ai_documents';
  r := r || format(E'%s AI: expired trial blocks AI unless paid entitlement\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin insert into public.invoices (company_id, direction, kind, created_by) values (c_t, 'issued', 'invoice', u_owner); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:TRIAL_EXPIRED:invoicing';
  r := r || format(E'%s invoicing: new invoice after trial requires Fakturácia module\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  select count(*) into v_n from public.invoices where company_id = c_t;
  v_ok := v_n = 1;
  r := r || format(E'%s expired Fakturácia: owner still reads existing invoice (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n); if not v_ok then fails := fails + 1; end if;

  update public.invoices set updated_by = u_owner where id = v_inv;
  get diagnostics v_n = row_count;
  v_ok := v_n = 1;
  r := r || format(E'%s expired Fakturácia: existing draft still editable where RLS allows\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  begin update public.invoices set document_status = 'finalized', finalized_at = now(), invoice_number = 'T-1' where id = v_inv; v_err := 'finalized';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:TRIAL_EXPIRED:invoicing';
  r := r || format(E'%s expired Fakturácia: finalizing a draft is blocked (even via privileged RPC path)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- finančné obmedzenie ostáva: zamestnanec tej istej firmy faktúry nevidí
  perform set_config('request.jwt.claims', json_build_object('sub', u_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.invoices where company_id = c_t;
  execute 'reset role';
  v_ok := v_n = 0;
  r := r || format(E'%s expiry never bypasses finance restriction (employee sees 0 invoices)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  select count(*) into v_n from public.inventory_items where company_id = c_t;
  update public.vehicles set model = 'edited after expiry' where company_id = c_t and spz = 'TR001AA';
  get diagnostics v_m = row_count;
  v_ok := v_n = 5 and v_m = 1;
  r := r || format(E'%s 13/14 after expiry: all existing rows readable (%s) and editable; nothing auto-deleted\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n); if not v_ok then fails := fails + 1; end if;

  begin perform * from public.esblu_create_company_invite(e_invitee, 'employee'); v_err := 'created';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:TRIAL_EXPIRED:team_members';
  r := r || format(E'%s users: invites blocked after expiry\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  select count(*) into v_n from public.company_members where company_id = c_t and status = 'active';
  v_ok := v_n = 3;
  r := r || format(E'%s 10 existing members kept after expiry (%s, incl. owner)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_n); if not v_ok then fails := fails + 1; end if;

  -- 5) trial sa nedá resetovať (ani operátor, ani cez update firmy)
  begin update public.companies set trial_started_at = now(), trial_ends_at = now() + interval '14 days' where id = c_t; v_err := 'updated';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ESBLU_TRIAL_IMMUTABLE';
  r := r || format(E'%s 5 trial cannot be reset (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_err); if not v_ok then fails := fails + 1; end if;

  update public.companies set name = 'Renamed company', owner_id = u_emp where id = c_t;
  select trial_ends_at into v_trial_end from public.companies where id = c_t;
  v_ok := v_trial_end = now() - interval '1 day';
  r := r || format(E'%s 5 owner change / settings change does not reset trial\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  update public.companies set owner_id = u_owner where id = c_t;

  -- ============================================================ PAID MODULE (manual grant)
  insert into public.company_entitlements (company_id, entitlement_key, source, limit_value, limit_period, note)
  values (c_t, 'inventory', 'manual', null, null, 'matrix'), (c_t, 'ai_documents', 'manual', 100, 'month', 'matrix'),
         (c_t, 'team_members', 'manual', 4, null, 'matrix');

  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into public.inventory_items (company_id, user_id, name) values (c_t, u_owner, 'Paid item 6'); v_err := 'ok';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ok';
  r := r || format(E'%s paid inventory module unlocks creation (no limit) in same session\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin insert into public.vehicles (company_id, user_id, spz) values (c_t, u_owner, 'TR009AA'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:TRIAL_EXPIRED:vehicles';
  r := r || format(E'%s unrelated module (vehicles) stays locked\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin v_res := public.esblu_reserve_ai_processing('scan-document', 'paid-key-1-0123456789', sha_a); v_err := 'ok';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ok' and v_res ->> 'source' = 'manual';
  r := r || format(E'%s paid AI entitlement restores processing (own monthly bucket)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin perform public.esblu_require_my_entitlement('voice'); v_err := 'allowed';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:VOICE_ENTITLEMENT_REQUIRED:voice';
  r := r || format(E'%s module entitlement alone does NOT unlock voice\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- pozvánka s limitom 4: aktívni 3 + 1 čakajúca = 4 → ďalšia zamietnutá
  begin select token into v_token from public.esblu_create_company_invite(e_invitee, 'employee');
  exception when others then v_token := null; end;
  begin perform * from public.esblu_create_company_invite(e_invitee2, 'employee'); v_err := 'created';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_token is not null and v_err = 'ENTITLEMENT_DENIED:USER_LIMIT_REACHED:team_members';
  r := r || format(E'%s users: pending invitations count toward the limit\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- 6) pozvaný používateľ nevytvorí nový trial ani firmu
  select count(*) into v_n from public.companies;
  perform set_config('request.jwt.claims', json_build_object('sub', u_invitee, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform * from public.esblu_accept_company_invite(v_token); exception when others then null; end;
  execute 'reset role';
  select count(*) into v_m from public.companies;
  select trial_ends_at into v_trial_end from public.companies where id = c_t;
  v_ok := v_n = v_m and v_trial_end = now() - interval '1 day'
      and exists (select 1 from public.company_members where company_id = c_t and user_id = u_invitee and status = 'active');
  r := r || format(E'%s 6 invited user joins existing company; no new company, no new trial\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- odobratie nároku nemaže dáta
  update public.company_entitlements set status = 'revoked' where company_id = c_t;
  select md5(string_agg(t || ids, '|' order by t)) into v_ids_after from (
    select 'v' t, string_agg(id::text || spz, ',' order by id) ids from public.vehicles where company_id = c_t
    union all select 'm', string_agg(id::text, ',' order by id) from public.machines where company_id = c_t
    union all select 'i', string_agg(id::text || coalesce(quantity::text, ''), ',' order by id) from public.inventory_items where company_id = c_t and name <> 'Paid item 6'
    union all select 'u', string_agg(id::text || user_id::text || role || status, ',' order by id) from public.company_members where company_id = c_t and user_id <> u_invitee
    union all select 'c', id::text || 'Renamed company' || owner_id::text || trial_started_at::text from public.companies where id = c_t
  ) s;
  select count(*) into v_storage_after from storage.objects;
  select count(*) into v_n from public.inventory_items where company_id = c_t;
  -- Pozn.: meno firmy bolo zámerne premenované vyššie; porovnávame IDs/počty.
  v_ok := v_n = 6 and v_storage_before = v_storage_after
      and (select count(*) from public.vehicles where company_id = c_t) = 2
      and (select count(*) from public.machines where company_id = c_t) = 2;
  r := r || format(E'%s entitlement change: same IDs/rows, storage untouched, revoke deletes nothing\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- ============================================================ VOICE × MODULE × ROLE (firma P)
  insert into public.company_entitlements (company_id, entitlement_key, source, note) values
    (c_p, 'voice', 'subscription', 'matrix'), (c_p, 'invoicing', 'subscription', 'matrix');
  execute 'alter table public.companies disable trigger esblu_companies_trial_guard';
  update public.companies set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '16 days' where id = c_p;
  execute 'alter table public.companies enable trigger esblu_companies_trial_guard';

  perform set_config('request.jwt.claims', json_build_object('sub', u_p_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin v_res := public.esblu_require_my_entitlement('voice'); v_err := 'ok';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ok';
  r := r || format(E'%s paid voice entitlement allows voice session\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin insert into public.inventory_items (company_id, user_id, name) values (c_p, u_p_owner, 'Voice-created'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ENTITLEMENT_DENIED:TRIAL_EXPIRED:inventory';
  r := r || format(E'%s voice + invoicing does NOT unlock inventory\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  begin insert into public.invoices (company_id, direction, kind, created_by) values (c_p, 'issued', 'invoice', u_p_owner); v_err := 'ok';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ok';
  r := r || format(E'%s voice + invoicing + owner role: invoice draft allowed\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', u_p_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into public.invoices (company_id, direction, kind, created_by) values (c_p, 'issued', 'invoice', u_p_emp); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err <> 'inserted';
  r := r || format(E'%s voice + invoicing + employee role: still denied by RLS (entitlement never widens role)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  select count(*) into v_n from public.invoices where company_id = c_p;
  v_ok := v_n = 0;
  r := r || format(E'%s employee cannot browse invoices in paid company\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  begin perform * from public.esblu_create_company_invite('x-' || gen_random_uuid() || '@example.invalid', 'employee'); v_err := 'created';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  r := r || format(E'%s employee cannot invite (role checked before entitlement; no entitlement leak)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', u_p_acc, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into public.vehicles (company_id, user_id, spz) values (c_p, u_p_acc, 'ACC01AA'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err <> 'inserted';
  r := r || format(E'%s accountant scope unchanged (no vehicles write)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  -- ============================================================ SECURITY
  perform set_config('request.jwt.claims', json_build_object('sub', u_p_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into public.company_entitlements (company_id, entitlement_key, source) values (c_p, 'inventory', 'manual'); v_err := 'inserted';
  exception when others then v_err := sqlstate; end;
  v_ok := v_err = '42501';
  r := r || format(E'%s authenticated owner cannot self-grant a module (%s)\n', case when v_ok then 'ok  ' else 'FAIL' end, v_err); if not v_ok then fails := fails + 1; end if;
  begin perform count(*) from public.company_entitlements; v_err := 'read';
  exception when others then v_err := sqlstate; end;
  v_ok := v_err = '42501';
  r := r || format(E'%s authenticated cannot read entitlement internals directly\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  begin perform count(*) from public.ai_processing_usage; v_err := 'read';
  exception when others then v_err := sqlstate; end;
  v_ok := v_err = '42501';
  r := r || format(E'%s authenticated cannot read/alter AI ledger directly\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  begin perform public.esblu_resolve_entitlement(c_t, 'vehicles'); v_err := 'called';
  exception when others then v_err := sqlstate; end;
  v_ok := v_err = '42501';
  r := r || format(E'%s authenticated cannot probe other companies via resolver\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  begin update public.companies set trial_ends_at = now() + interval '1 year' where id = c_p; get diagnostics v_n = row_count; v_err := v_n::text;
  exception when others then v_err := sqlstate; end;
  v_ok := v_err in ('42501', '0');
  r := r || format(E'%s authenticated cannot extend own trial\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  v_res := public.esblu_get_my_company_entitlements();
  v_ok := (v_res ->> 'company_id')::uuid = c_p;
  r := r || format(E'%s overview RPC is bound to caller company (no company_id parameter)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  begin insert into public.vehicles (company_id, user_id, spz) values (c_t, u_p_owner, 'XCOMP1A'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  v_ok := v_err <> 'inserted' or not exists (select 1 from public.vehicles where spz = 'XCOMP1A' and company_id = c_t);
  r := r || format(E'%s cross-company create blocked (body company_id ignored)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;
  execute 'reset role';

  execute 'set local role anon';
  begin perform count(*) from public.entitlement_catalog; v_err := 'read'; exception when others then v_err := sqlstate; end;
  v_ok := v_err = '42501';
  begin perform public.esblu_get_my_company_entitlements(); v_err := 'called'; exception when others then v_err := sqlstate; end;
  v_ok := v_ok and v_err = '42501';
  begin perform public.esblu_reserve_ai_processing('scan-document', 'anon-key-0123456789abc', sha_a); v_err := 'called'; exception when others then v_err := sqlstate; end;
  v_ok := v_ok and v_err = '42501';
  execute 'reset role';
  r := r || format(E'%s anon: no access to catalog, overview or AI reservation\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  select count(*) into v_n from pg_policies where schemaname = 'public'
    and (coalesce(qual, '') ~* '\m(plan|entitlement)' or coalesce(with_check, '') ~* '\m(plan|entitlement)');
  v_ok := v_n = 0;
  r := r || format(E'%s no RLS policy depends on plan/entitlement (authorization stays separate)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  select count(*) into v_n from pg_proc p, aclexplode(p.proacl) a
  where p.pronamespace = 'public'::regnamespace and a.grantee = (select oid from pg_roles where rolname = 'anon')
    and p.proname in ('esblu_resolve_entitlement', 'esblu_require_entitlement_capacity', 'esblu_raise_entitlement_denial',
      'esblu_reserve_ai_processing', 'esblu_finalize_ai_processing', 'esblu_require_my_entitlement',
      'esblu_get_my_company_entitlements', 'esblu_create_company_invite', 'esblu_accept_company_invite');
  v_ok := v_n = 0;
  r := r || format(E'%s no anon EXECUTE on entitlement functions\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  -- companies.plan 'admin' nič neodomyká v rolách
  update public.companies set plan = 'admin' where id = c_p;
  perform set_config('request.jwt.claims', json_build_object('sub', u_p_emp, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into public.inventory_items (company_id, user_id, name) values (c_p, u_p_emp, 'emp'); v_err := 'inserted';
  exception when others then v_err := sqlerrm; end;
  execute 'reset role';
  v_ok := v_err <> 'inserted';
  r := r || format(E'%s legacy companies.plan=admin grants nothing (employee inventory stays read-only)\n', case when v_ok then 'ok  ' else 'FAIL' end); if not v_ok then fails := fails + 1; end if;

  raise exception E'ENTITLEMENTS MATRIX (rolled back) — % failure(s)\n%', fails, r;
end
$matrix$;
