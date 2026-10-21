-- =============================================================================
-- Data API rolová matica pre explicitné granty (20261021100000) — STAGING.
-- Spúšťa sa ako jeden príkaz; VŠETKO (fixtures aj pokusy) sa na konci zahodí
-- vyhodením výnimky ESBLU_MATRIX_RESULT s JSON výsledkom → žiadny zápis
-- nezostane. Rovnaký mechanizmus ako PostgREST: SET LOCAL ROLE + request.jwt.claims.
-- Pozor: funkciu volaj vo WHERE (nie iba v projekcii) — count(*) nad
-- subselectom by STABLE funkciu z projekcie vynechal a nevyhodnotil.
-- Klasifikácia: ok:<n> | privilege (42501 permission denied — chýba GRANT)
--              | rls (42501 row-level security) | err:<sqlstate>:<msg>
-- NIKDY nespúšťať proti produkcii.
-- =============================================================================
do $matrix$
declare
  oA uuid := 'b0000000-0000-4000-8000-0000000000a1'; adA uuid := 'b0000000-0000-4000-8000-0000000000a2';
  acA uuid := 'b0000000-0000-4000-8000-0000000000a3'; eA uuid := 'b0000000-0000-4000-8000-0000000000a4';
  oB uuid := 'b0000000-0000-4000-8000-0000000000b1'; mu uuid := 'b0000000-0000-4000-8000-0000000000c1';
  cA uuid := 'd0000000-0000-4000-8000-00000000000a'; cB uuid := 'd0000000-0000-4000-8000-00000000000b';
  sA uuid := 'e0000000-0000-4000-8000-0000000000a1'; sAd uuid := 'e0000000-0000-4000-8000-0000000000a2';
  sAc uuid := 'e0000000-0000-4000-8000-0000000000a3'; sE uuid := 'e0000000-0000-4000-8000-0000000000a4';
  sB uuid := 'e0000000-0000-4000-8000-0000000000b1'; sM1 uuid := 'e0000000-0000-4000-8000-0000000000c1';
  sM2 uuid := 'e0000000-0000-4000-8000-0000000000c2';
  vA uuid := 'f0000000-0000-4000-8000-0000000000a1'; vB uuid := 'f0000000-0000-4000-8000-0000000000b1';
  r jsonb := '{}'::jsonb;
  t text;
begin
  if current_database() <> 'postgres' or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'not a supabase db';
  end if;

  create function pg_temp.try_as(p_role text, p_uid uuid, p_sess uuid, p_sql text, p_dml boolean default false)
  returns text language plpgsql as $f$
  declare n bigint; begin
    perform set_config('request.jwt.claims', case when p_role = 'authenticated'
      then json_build_object('sub', p_uid, 'role', 'authenticated', 'session_id', p_sess)::text
      else json_build_object('role', p_role)::text end, true);
    execute format('set local role %I', p_role);
    if p_dml then execute p_sql; get diagnostics n = row_count;
    else execute format('select count(*) from (%s) x', p_sql) into n; end if;
    reset role;
    return 'ok:' || n;
  exception when others then
    reset role;
    return case when sqlstate = '42501' and sqlerrm like 'permission denied%' then 'privilege'
                when sqlstate = '42501' and sqlerrm like '%row-level security%' then 'rls'
                else 'err:' || sqlstate || ':' || left(sqlerrm, 80) end;
  end $f$;

  -- fixtures (zahodia sa)
  insert into auth.users (id, email, aud, role) values
    (oA, 'grants-oa@example.invalid', 'authenticated', 'authenticated'), (adA, 'grants-ada@example.invalid', 'authenticated', 'authenticated'),
    (acA, 'grants-aca@example.invalid', 'authenticated', 'authenticated'), (eA, 'grants-ea@example.invalid', 'authenticated', 'authenticated'),
    (oB, 'grants-ob@example.invalid', 'authenticated', 'authenticated'), (mu, 'grants-m@example.invalid', 'authenticated', 'authenticated');
  insert into auth.sessions (id, user_id) values (sA, oA), (sAd, adA), (sAc, acA), (sE, eA), (sB, oB), (sM1, mu), (sM2, mu);
  set local session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values (cA, oA, 'Grants A'), (cB, oB, 'Grants B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (cA, oA, 'owner', 'active', '{}'), (cA, adA, 'admin', 'active', '{"billing":{"manage":true},"finance":{"view":true,"manage":true}}'),
    (cA, acA, 'accountant', 'active', '{}'), (cA, eA, 'employee', 'active', '{"finance":{"view":true,"manage":true}}'),
    (cA, mu, 'employee', 'active', '{}'), (cB, oB, 'owner', 'active', '{}'), (cB, mu, 'employee', 'active', '{}');
  insert into public.session_active_company (session_id, user_id, company_id) values (sM1, mu, cA), (sM2, mu, cB);
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select co, d.version, own, 'company_dpa_gate'
    from (values (cA, oA), (cB, oB)) v(co, own),
         (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values
    (cA, 'vehicles', 'manual', 'active', 100, 'total'), (cB, 'vehicles', 'manual', 'active', 100, 'total');
  insert into public.vehicles (id, spz, user_id, company_id) values (vA, 'GA-1', oA, cA), (vB, 'GB-1', oB, cB);
  insert into public.invoices (company_id, direction, kind) values (cA, 'issued', 'regular_invoice'), (cB, 'issued', 'regular_invoice');
  insert into public.einvoice_organizations (company_id, provider, environment) values (cA, 'efaktura', 'sandbox'), (cB, 'efaktura', 'sandbox');
  insert into public.company_legal_identities (company_id, country_code, registration_id, legal_entity_key)
    values (cA, 'SK', '99999901', 'SK:99999901'), (cB, 'SK', '99999902', 'SK:99999902');
  set local session_replication_role = origin;

  -- anon
  foreach t in array array['invoices','documents','vehicles','companies','company_members','billing_events','trial_claims',
    'account_deletion_cleanup_jobs','media_deletion_queue','push_devices','einvoice_outbound','subscription_accounts'] loop
    r := r || jsonb_build_object('anon.select.' || t, pg_temp.try_as('anon', null, null, format('select 1 from public.%I', t)));
  end loop;
  r := r || jsonb_build_object('anon.select.legal_documents', pg_temp.try_as('anon', null, null, 'select 1 from public.legal_documents'));
  r := r || jsonb_build_object('anon.insert.vehicles', pg_temp.try_as('anon', null, null, format('insert into public.vehicles (spz, company_id) values (%L, %L)', 'X', cA), true));

  -- authenticated owner na service/RPC-only tabuľkách
  foreach t in array array['billing_events','billing_provider_links','billing_checkout_sessions','subscription_accounts','trial_claims',
    'account_deletion_cleanup_jobs','media_deletion_queue','einvoice_rollout','einvoice_event_cursors','einvoice_webhook_rejections',
    'einvoice_ops_audit','push_devices','push_subscriptions','notification_preferences','company_entitlements','company_invites',
    'ai_scan_usage','ai_scan_limits','assistant_action_confirmations','beta_allowlist'] loop
    r := r || jsonb_build_object('ownerA.select.' || t, pg_temp.try_as('authenticated', oA, sA, format('select 1 from public.%I', t)));
  end loop;

  -- zápis do SELECT-only tabuliek
  r := r || jsonb_build_object(
    'ownerA.update.invoice_payments', pg_temp.try_as('authenticated', oA, sA, 'update public.invoice_payments set paid_amount = 0', true),
    'ownerA.delete.invoice_events', pg_temp.try_as('authenticated', oA, sA, 'delete from public.invoice_events', true),
    'ownerA.delete.company_billing_profile', pg_temp.try_as('authenticated', oA, sA, 'delete from public.company_billing_profile', true),
    'ownerA.delete.settings', pg_temp.try_as('authenticated', oA, sA, 'delete from public.settings', true),
    'ownerA.update.settings.plan', pg_temp.try_as('authenticated', oA, sA, $q$update public.settings set plan = 'admin'$q$, true),
    'ownerA.update.companies', pg_temp.try_as('authenticated', oA, sA, $q$update public.companies set name = 'x'$q$, true),
    'ownerA.truncate.vehicles', pg_temp.try_as('authenticated', oA, sA, 'truncate public.vehicles', true));

  -- tenant izolácia
  r := r || jsonb_build_object(
    'ownerA.select.vehicles(own=1)', pg_temp.try_as('authenticated', oA, sA, format('select 1 from public.vehicles where company_id in (%L,%L)', cA, cB)),
    'ownerB.select.vehicles(own=1)', pg_temp.try_as('authenticated', oB, sB, format('select 1 from public.vehicles where company_id in (%L,%L)', cA, cB)),
    'ownerA.select.invoices(own=1)', pg_temp.try_as('authenticated', oA, sA, format('select 1 from public.invoices where company_id in (%L,%L)', cA, cB)),
    'ownerA.insert.vehicles.own', pg_temp.try_as('authenticated', oA, sA, format('insert into public.vehicles (spz, user_id, company_id) values (%L, %L, %L)', 'GA-2', oA, cA), true),
    'ownerA.insert.vehicles.foreign', pg_temp.try_as('authenticated', oA, sA, format('insert into public.vehicles (spz, user_id, company_id) values (%L, %L, %L)', 'GX-9', oA, cB), true),
    'ownerA.update.vehicles.foreign(0)', pg_temp.try_as('authenticated', oA, sA, format('update public.vehicles set model = %L where id = %L', 'x', vB), true),
    'ownerA.delete.vehicles.foreign(0)', pg_temp.try_as('authenticated', oA, sA, format('delete from public.vehicles where id = %L', vB), true),
    'ownerA.update.vehicles.own(1)', pg_temp.try_as('authenticated', oA, sA, format('update public.vehicles set model = %L where id = %L', 'x', vA), true),
    'multi.sessionA.vehicles', pg_temp.try_as('authenticated', mu, sM1, format('select 1 from public.vehicles where company_id = %L', cA)),
    'multi.sessionA.vehicles.B(0)', pg_temp.try_as('authenticated', mu, sM1, format('select 1 from public.vehicles where company_id = %L', cB)),
    'multi.sessionB.vehicles.B', pg_temp.try_as('authenticated', mu, sM2, format('select 1 from public.vehicles where company_id = %L', cB)),
    'multi.sessionB.vehicles.A(0)', pg_temp.try_as('authenticated', mu, sM2, format('select 1 from public.vehicles where company_id = %L', cA)));

  -- billing owner-only
  r := r || jsonb_build_object(
    'billing.owner', pg_temp.try_as('authenticated', oA, sA, 'select 1 where public.esblu_billing_authorize_manage() is not null'),
    'billing.admin', pg_temp.try_as('authenticated', adA, sAd, 'select 1 where public.esblu_billing_authorize_manage() is not null'),
    'billing.accountant', pg_temp.try_as('authenticated', acA, sAc, 'select 1 where public.esblu_billing_authorize_manage() is not null'),
    'billing.employee', pg_temp.try_as('authenticated', eA, sE, 'select 1 where public.esblu_billing_authorize_manage() is not null'));

  -- eInvoice
  r := r || jsonb_build_object(
    'einv.owner.orgA(1)', pg_temp.try_as('authenticated', oA, sA, format('select 1 from public.einvoice_organizations where company_id in (%L,%L)', cA, cB)),
    'einv.accountant.orgA(1)', pg_temp.try_as('authenticated', acA, sAc, format('select 1 from public.einvoice_organizations where company_id in (%L,%L)', cA, cB)),
    'einv.employee.orgA(0)', pg_temp.try_as('authenticated', eA, sE, format('select 1 from public.einvoice_organizations where company_id in (%L,%L)', cA, cB)),
    'einv.ownerB.orgA(0)', pg_temp.try_as('authenticated', oB, sB, format('select 1 from public.einvoice_organizations where company_id = %L', cA)),
    'einv.owner.update.org', pg_temp.try_as('authenticated', oA, sA, $q$update public.einvoice_organizations set provider = 'x'$q$, true),
    'einv.service.select.outbound', pg_temp.try_as('service_role', null, null, 'select 1 from public.einvoice_outbound'),
    'einv.service.delete.events', pg_temp.try_as('service_role', null, null, 'delete from public.einvoice_events where false', true));

  -- trial / legal identity
  r := r || jsonb_build_object(
    'trial.owner.claims', pg_temp.try_as('authenticated', oA, sA, 'select 1 from public.trial_claims'),
    'trial.service.claims', pg_temp.try_as('service_role', null, null, 'select 1 from public.trial_claims limit 1'),
    'trial.service.delete.claims', pg_temp.try_as('service_role', null, null, 'delete from public.trial_claims where false', true),
    'legal.owner(1)', pg_temp.try_as('authenticated', oA, sA, format('select 1 from public.company_legal_identities where company_id in (%L,%L)', cA, cB)),
    'legal.admin(0)', pg_temp.try_as('authenticated', adA, sAd, format('select 1 from public.company_legal_identities where company_id in (%L,%L)', cA, cB)),
    'legal.employee(0)', pg_temp.try_as('authenticated', eA, sE, format('select 1 from public.company_legal_identities where company_id in (%L,%L)', cA, cB)),
    'legal.ownerB.A(0)', pg_temp.try_as('authenticated', oB, sB, format('select 1 from public.company_legal_identities where company_id = %L', cA)));

  -- deletion / media / push / service
  r := r || jsonb_build_object(
    'del.owner.cleanup_jobs', pg_temp.try_as('authenticated', oA, sA, 'select 1 from public.account_deletion_cleanup_jobs'),
    'del.owner.media_queue', pg_temp.try_as('authenticated', oA, sA, 'select 1 from public.media_deletion_queue'),
    'del.service.cleanup_jobs', pg_temp.try_as('service_role', null, null, 'select 1 from public.account_deletion_cleanup_jobs limit 1'),
    'del.service.delete.cleanup_jobs', pg_temp.try_as('service_role', null, null, 'delete from public.account_deletion_cleanup_jobs where false', true),
    'media.owner.insert.own', pg_temp.try_as('authenticated', oA, sA, format('insert into public.vehicle_photos (vehicle_id, user_id, storage_bucket, storage_path, company_id) values (%L, %L, %L, %L, %L)', vA, oA, 'vehicle-photos', cA || '/' || vA || '/g.jpg', cA), true),
    'media.owner.insert.foreign', pg_temp.try_as('authenticated', oA, sA, format('insert into public.vehicle_photos (vehicle_id, user_id, storage_bucket, storage_path, company_id) values (%L, %L, %L, %L, %L)', vB, oA, 'vehicle-photos', cB || '/' || vB || '/g.jpg', cB), true),
    'media.storage.objects.policies', (select count(*)::text from pg_policies where schemaname = 'storage' and tablename = 'objects'),
    'push.owner.devices', pg_temp.try_as('authenticated', oA, sA, 'select 1 from public.push_devices'),
    'push.owner.rpc.my_devices', pg_temp.try_as('authenticated', oA, sA, 'select * from public.esblu_push_my_devices()'),
    'svc.vehicles', pg_temp.try_as('service_role', null, null, 'select 1 from public.vehicles limit 1'),
    'svc.truncate.billing_events', pg_temp.try_as('service_role', null, null, 'truncate public.billing_events', true),
    'svc.rpc.active_membership', pg_temp.try_as('service_role', null, null, format('select * from public.esblu_active_membership_for_user(%L, %L)', oA, sA)),
    'svc.rpc.einvoice_health', pg_temp.try_as('service_role', null, null, 'select 1 where public.esblu_einvoice_health(60, 24) is not null'),
    'svc.rpc.internal_helper(denied)', pg_temp.try_as('service_role', null, null, 'select 1 where public.esblu_my_active_company_id() is null'));

  -- settings.locale (20261022100000) — per-user preferencia; zápis + čítanie späť v tej istej (zahodenej) transakcii
  insert into public.settings (user_id) values (oA), (oB), (eA), (adA) on conflict (user_id) do nothing;
  r := r || jsonb_build_object(
    'locale.owner.update.own(1)', pg_temp.try_as('authenticated', oA, sA, format('update public.settings set locale = %L where user_id = %L', 'de', oA), true),
    'locale.owner.readback(de=1)', pg_temp.try_as('authenticated', oA, sA, format('select 1 from public.settings where user_id = %L and locale = %L', oA, 'de')),
    'locale.ownerB.update.foreign(0)', pg_temp.try_as('authenticated', oB, sB, format('update public.settings set locale = %L where user_id = %L', 'sk', oA), true),
    'locale.employee.update.own(1)', pg_temp.try_as('authenticated', eA, sE, format('update public.settings set locale = %L where user_id = %L', 'en', eA), true),
    'locale.admin.update.employee(0)', pg_temp.try_as('authenticated', adA, sAd, format('update public.settings set locale = %L where user_id = %L', 'sk', eA), true),
    'locale.owner.update.plan(deny)', pg_temp.try_as('authenticated', oA, sA, format('update public.settings set plan = %L where user_id = %L', 'admin', oA), true),
    'locale.owner.update.locale+plan(deny)', pg_temp.try_as('authenticated', oA, sA, format('update public.settings set locale = %L, plan = %L where user_id = %L', 'sk', 'pro', oA), true),
    'locale.owner.invalid(23514)', pg_temp.try_as('authenticated', oA, sA, format('update public.settings set locale = %L where user_id = %L', 'xx', oA), true),
    'locale.anon.update(deny)', pg_temp.try_as('anon', null, null, format('update public.settings set locale = %L', 'de'), true),
    'locale.final.owner', (select locale from public.settings where user_id = oA),
    'locale.final.employee', (select locale from public.settings where user_id = eA));
  -- policy hygiene: anon dostane čistý table-privilege deny; finance flows nezmenené
  r := r || jsonb_build_object(
    'hygiene.public_role_policies', (select count(*)::text from pg_policies where schemaname = 'public' and 'public' = any (roles)),
    'hygiene.legal_documents_roles', (select string_agg(roles::text, ';') from pg_policies where schemaname = 'public' and tablename = 'legal_documents'),
    'hygiene.owner.insert.partner.own', pg_temp.try_as('authenticated', oA, sA, format('insert into public.business_partners (company_id, legal_name, kind) values (%L, %L, %L)', cA, 'Grants Partner', 'customer'), true),
    'hygiene.owner.insert.partner.foreign', pg_temp.try_as('authenticated', oA, sA, format('insert into public.business_partners (company_id, legal_name, kind) values (%L, %L, %L)', cB, 'Grants Partner X', 'customer'), true),
    'hygiene.accountant.invoices(1)', pg_temp.try_as('authenticated', acA, sAc, format('select 1 from public.invoices where company_id in (%L,%L)', cA, cB)),
    'hygiene.employee.invoices(0)', pg_temp.try_as('authenticated', eA, sE, format('select 1 from public.invoices where company_id in (%L,%L)', cA, cB)));
  declare m text; begin
    foreach t in array array['invoices','invoice_items','documents','business_partners','company_billing_profile','settings'] loop
      begin
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        set local role anon;
        execute format('select count(*) from public.%I', t);
        reset role; m := 'ok';
      exception when others then reset role; m := sqlstate || ' ' || sqlerrm; end;
      r := r || jsonb_build_object('hygiene.anon.msg.' || t, m);
    end loop;
  end;

  raise exception using errcode = 'P0001', message = 'ESBLU_MATRIX_RESULT', detail = r::text;
end
$matrix$;
