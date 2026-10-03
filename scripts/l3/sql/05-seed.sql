-- =============================================================================
-- L3 krok 9 — syntetické firmy, roly a nároky. Predpoklad: 6 používateľov
-- (krok 8) existuje v staging Auth. Všetko syntetické (IČO/DIČ sandbox
-- organizácie z L2, rezervované e-maily). Firma A = sandbox organizácia
-- (self-send), firma B = cudzí tenant bez nároku einvoice.
-- =============================================================================
begin;
do $guard$
declare v_prod boolean;
begin
  if to_regclass('esblu_l3.target') is null then
    raise exception 'L3_GUARD_STOP: chýba staging marker esblu_l3.target — toto nie je pripravený staging';
  end if;
  if not exists (select 1 from esblu_l3.target where ref = 'cjbdijbbcujvmrzezusd') then
    raise exception 'L3_GUARD_STOP: marker neukazuje na staging cjbdijbbcujvmrzezusd';
  end if;
  if exists (select 1 from esblu_l3.target where ref = 'fkpgvgvsmbpieduoatrt') then
    raise exception 'L3_GUARD_STOP: produkčný ref v markeri';
  end if;
  -- Produkčná stopa: história migrácií produkcie (apply timestampy MCP, napr. push_notifications).
  -- Dynamicky: tabuľka histórie v čerstvom stagingu nemusí existovať (statický odkaz by zlyhal pri kompilácii).
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select exists (select 1 from supabase_migrations.schema_migrations where version = any($1))'
      into v_prod using array['20260930213531', '20260930213818', '20260929201345'];
    if v_prod then
      raise exception 'L3_GUARD_STOP: databáza má produkčnú históriu migrácií';
    end if;
  end if;
end
$guard$;
do $seed$
declare
  u_owner uuid := (select id from auth.users where email = 'l3-owner@example.com');
  u_acc uuid := (select id from auth.users where email = 'l3-accountant@example.com');
  u_admin_fin uuid := (select id from auth.users where email = 'l3-admin-fin@example.com');
  u_admin uuid := (select id from auth.users where email = 'l3-admin@example.com');
  u_emp uuid := (select id from auth.users where email = 'l3-employee@example.com');
  u_other uuid := (select id from auth.users where email = 'l3-other-owner@example.com');
  c_a uuid := 'a1300000-0000-4000-8000-00000000000a';
  c_b uuid := 'b1300000-0000-4000-8000-00000000000b';
  -- Syntetický IBAN: vzorový slovenský IBAN z SWIFT IBAN Registry (príklad
  -- formátu, nie účet Esblu ani zákazníka), platný kontrolný súčet ISO 13616.
  v_test_iban text := 'SK3112000000198742637541';
begin
  if u_owner is null or u_acc is null or u_admin_fin is null or u_admin is null or u_emp is null or u_other is null then
    raise exception 'L3_SEED_STOP: chýba niektorý L3 používateľ v auth.users (krok 8)';
  end if;
  insert into public.companies (id, owner_id, name) values (c_a, u_owner, 'L3 Tatra Servis s.r.o.'), (c_b, u_other, 'L3 Iná firma s.r.o.')
    on conflict (id) do nothing;
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    (c_a, u_owner, 'owner', 'active', '{}'),
    (c_a, u_acc, 'accountant', 'active', '{}'),
    (c_a, u_admin_fin, 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    (c_a, u_admin, 'admin', 'active', '{}'),
    (c_a, u_emp, 'employee', 'active', '{"finance":{"view":true,"manage":true}}'),
    (c_b, u_other, 'owner', 'active', '{}')
  on conflict do nothing;
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code,
      electronic_address, electronic_address_scheme_id, iban)
    values (c_a, 'Tatra Servis s.r.o.', '87654326', '2099999999', 'SK2099999999', 'Hlavná 1', 'Bratislava', '81101', 'SK', '2099999999', '9915', v_test_iban),
           (c_b, 'L3 Iná firma s.r.o.', '22222222', '2030000000', 'SK2030000000', 'Skúšobná 2', 'Košice', '04001', 'SK', '2030000000', '9915', null)
    on conflict (company_id) do nothing;
  -- BR-61 (L3 nález): bankový prevod (kód úhrady 30/58) vyžaduje IBAN dodávateľa.
  -- Už existujúci profil firmy A (staging seedovaný pred touto zmenou) sa iba
  -- DOPLNÍ, ak IBAN chýba — ručne zmenený IBAN sa neprepíše (idempotentné).
  -- Finalizované faktúry majú nemenný snapshot strán; táto zmena sa ich netýka.
  update public.company_billing_profile set iban = v_test_iban
    where company_id = c_a and (iban is null or btrim(iban) = '');
  -- Odberateľ = tá istá sandbox organizácia (self-send → vznikne aj prijatý doklad).
  insert into public.business_partners (company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code,
      electronic_address, electronic_address_scheme_id)
    select c_a, 'customer', 'Tatra Servis s.r.o.', '87654326', '2099999999', 'SK2099999999', 'Hlavná 1', 'Bratislava', '81101', 'SK', '2099999999', '9915'
    where not exists (select 1 from public.business_partners where company_id = c_a and ico = '87654326');
  -- Nárok einvoice iba pre firmu A (B = "bez nároku" v authz matici).
  insert into public.company_entitlements (company_id, entitlement_key, source, note)
    select c_a, 'einvoice', 'manual', 'L3 staging'
    where not exists (select 1 from public.company_entitlements where company_id = c_a and entitlement_key = 'einvoice' and status = 'active');
end
$seed$;
commit;
