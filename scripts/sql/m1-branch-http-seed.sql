-- =============================================================================
-- BRANCH-ONLY seed pre scripts/m1-branch-http-smoke.ts (m1-authz-runtime-test).
-- NIKDY nespúšťať na produkcii (fkpgvgvsmbpieduoatrt).
-- Predpoklad: 4 syntetické Auth účty vytvorené na BRANCHI (dashboard branchu
-- → Authentication → Add user). Nahraď iba syntetické e-maily nižšie.
-- Vytvorí firmu A (owner, employee, accountant) a B (owner), DPA súhlas.
-- Idempotentné (on conflict do nothing / exists).
-- =============================================================================
do $$
declare
  e_owner text := 'm1-owner@example.invalid';
  e_emp   text := 'm1-employee@example.invalid';
  e_acc   text := 'm1-accountant@example.invalid';
  e_other text := 'm1-other@example.invalid';
  u_owner uuid; u_emp uuid; u_acc uuid; u_other uuid;
  ca uuid; cb uuid; v_dpa text;
begin
  select id into u_owner from auth.users where email = e_owner;
  select id into u_emp from auth.users where email = e_emp;
  select id into u_acc from auth.users where email = e_acc;
  select id into u_other from auth.users where email = e_other;
  if u_owner is null or u_emp is null or u_acc is null or u_other is null then
    raise exception 'create the 4 synthetic branch users first';
  end if;
  select version into v_dpa from public.legal_documents where type = 'dpa' order by effective_at desc limit 1;

  select id into ca from public.companies where owner_id = u_owner limit 1;
  if ca is null then
    insert into public.companies (name, owner_id, plan) values ('M1 HTTP A (synthetic)', u_owner, 'pro') returning id into ca;
  end if;
  select id into cb from public.companies where owner_id = u_other limit 1;
  if cb is null then
    insert into public.companies (name, owner_id, plan) values ('M1 HTTP B (synthetic)', u_other, 'pro') returning id into cb;
  end if;
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (ca, u_owner, 'owner', 'active', '{}'), (ca, u_emp, 'employee', 'active', '{}'),
    (ca, u_acc, 'accountant', 'active', '{}'), (cb, u_other, 'owner', 'active', '{}')
  on conflict (company_id, user_id) do nothing;
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method) values
    (ca, v_dpa, u_owner, 'company_dpa_gate'), (cb, v_dpa, u_other, 'company_dpa_gate')
  on conflict (company_id, document_type, version) do nothing;
end $$;
