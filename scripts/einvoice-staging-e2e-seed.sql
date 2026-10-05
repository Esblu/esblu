-- =============================================================================
-- E-Faktúra — STAGING E2E (API partner sandbox) — syntetický seed. IBA esblu-test.
--
-- Spúšťa sa v 2 krokoch (idempotentné):
--   1) pred `ensure-users` (driver): beta allowlist pre 2 syntetické e-maily,
--   2) po `ensure-users`: firmy A–D, členstvá, fakturačné profily, odberateľ B v A,
--      nárok einvoice a rollout `internal` (sandbox) pre A a B.
-- Všetky údaje sú syntetické: rezervované e-maily (example.com), IČO s platným
-- kontrolným súčtom a DIČ 20xxxxxxxx odvodené zo seedu „esblu-staging-e2e-2026-10-05",
-- vzorový IBAN z SWIFT IBAN Registry. Žiadne reálne osoby ani firmy.
-- Firmy C (neplatný FS kód) a D (send_only) nemajú členov — slúžia iba na onboarding.
-- Cleanup / rollback: scripts/einvoice-staging-e2e-cleanup.sql
-- =============================================================================
begin;
do $guard$
begin
  if to_regclass('esblu_l3.target') is null
     or not exists (select 1 from esblu_l3.target where ref = 'cjbdijbbcujvmrzezusd')
     or exists (select 1 from esblu_l3.target where ref = 'fkpgvgvsmbpieduoatrt') then
    raise exception 'E2E_GUARD_STOP: toto nie je staging esblu-test';
  end if;
end
$guard$;

insert into public.beta_allowlist (email, note)
select e, 'einvoice staging E2E (synthetic)'
from unnest(array['e2e-partner-a@example.com', 'e2e-partner-b@example.com']) e
where not exists (select 1 from public.beta_allowlist b where b.email = e);

do $seed$
declare
  u_a uuid := (select id from auth.users where email = 'e2e-partner-a@example.com');
  u_b uuid := (select id from auth.users where email = 'e2e-partner-b@example.com');
  c_a uuid := 'e2e5a000-0000-4000-8000-00000000000a';
  c_b uuid := 'e2e5a000-0000-4000-8000-00000000000b';
  c_c uuid := 'e2e5a000-0000-4000-8000-00000000000c';
  c_d uuid := 'e2e5a000-0000-4000-8000-00000000000d';
  v_iban text := 'SK3112000000198742637541';
begin
  if u_a is null or u_b is null then
    raise notice 'E2E seed: používatelia ešte neexistujú (driver ensure-users) — firmy sa nezakladajú';
    return;
  end if;
  insert into public.companies (id, owner_id, name) values
    (c_a, u_a, 'E2E Partner A s.r.o.'),
    (c_b, u_b, 'E2E Partner B s.r.o.'),
    (c_c, u_b, 'E2E Partner C s.r.o.'),
    (c_d, u_b, 'E2E Partner D s.r.o.')
  on conflict (id) do nothing;
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (c_a, u_a, 'owner', 'active', '{}'),
    (c_b, u_b, 'owner', 'active', '{}')
  on conflict do nothing;
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code,
      electronic_address, electronic_address_scheme_id, iban) values
    (c_a, 'E2E Partner A s.r.o.', '33002711', '2054825695', 'SK2054825695', 'Testovacia 1', 'Bratislava', '81101', 'SK', '2054825695', '9915', v_iban),
    (c_b, 'E2E Partner B s.r.o.', '37665880', '2020147507', 'SK2020147507', 'Testovacia 2', 'Košice', '04001', 'SK', '2020147507', '9915', null),
    (c_c, 'E2E Partner C s.r.o.', '34969861', '2023729343', 'SK2023729343', 'Testovacia 3', 'Žilina', '01001', 'SK', '2023729343', '9915', null),
    (c_d, 'E2E Partner D s.r.o.', '38940876', '2014993757', 'SK2014993757', 'Testovacia 4', 'Nitra', '94901', 'SK', '2014993757', '9915', null)
  on conflict (company_id) do nothing;
  insert into public.business_partners (company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code,
      electronic_address, electronic_address_scheme_id)
  select c_a, 'customer', 'E2E Partner B s.r.o.', '37665880', '2020147507', 'SK2020147507', 'Testovacia 2', 'Košice', '04001', 'SK', '2020147507', '9915'
  where not exists (select 1 from public.business_partners where company_id = c_a and ico = '37665880');
  insert into public.company_entitlements (company_id, entitlement_key, source, note)
  select c, 'einvoice', 'manual', 'einvoice staging E2E'
  from unnest(array[c_a, c_b]) c
  where not exists (select 1 from public.company_entitlements e where e.company_id = c and e.entitlement_key = 'einvoice' and e.status = 'active');
  insert into public.einvoice_rollout (company_id, environment, stage, note, changed_by) values
    (c_a, 'sandbox', 'internal', 'einvoice staging E2E', 'staging-e2e-seed'),
    (c_b, 'sandbox', 'internal', 'einvoice staging E2E', 'staging-e2e-seed')
  on conflict do nothing;
end
$seed$;
commit;
