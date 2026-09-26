-- =============================================================================
-- LOKÁLNA kontrola backfillu migrácie 20260928100000 (iba lokálny PostgreSQL).
--   1) psql -f scripts/sql/entitlements-local-baseline.sql
--   2) psql -v phase=seed  -f scripts/sql/entitlements-backfill-check-local.sql
--   3) psql -f supabase/migrations/20260928100000_company_entitlements_trial.sql
--   4) psql -v phase=check -f scripts/sql/entitlements-backfill-check-local.sql
-- Simuluje dnešné produkčné firmy (plan free/pro/admin, 43/43/28 dní staré,
-- beta firma s 2 členmi) a overí, že migrácia nezmení žiadne dáta.
-- =============================================================================
\if :{?phase}
\else
  \set phase check
\endif

select :'phase' = 'seed' as is_seed \gset
\if :is_seed
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a001', 'bf-admin@example.invalid'),
  ('00000000-0000-0000-0000-00000000a002', 'bf-pro@example.invalid'),
  ('00000000-0000-0000-0000-00000000a003', 'bf-free@example.invalid'),
  ('00000000-0000-0000-0000-00000000a004', 'bf-free-emp@example.invalid');
insert into public.companies (id, owner_id, name, plan, created_at) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000a001', 'BF admin', 'admin', now() - interval '43 days'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000a002', 'BF pro', 'pro', now() - interval '43 days'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a003', 'BF free', 'free', now() - interval '28 days');
insert into public.company_members (company_id, user_id, role, status) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000a001', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000a002', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a003', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a004', 'employee', 'active');
-- Pred migráciou: pro firma má 3 vozidlá (nad budúcim trial limitom).
alter table public.vehicles disable trigger user;
insert into public.vehicles (company_id, user_id, spz)
select '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000a002', 'BF' || g || 'AA' from generate_series(1, 3) g;
insert into public.vehicles (company_id, user_id, spz)
select '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a003', 'FR' || g || 'AA' from generate_series(1, 2) g;
alter table public.vehicles enable trigger user;
create table public.__bf_snapshot as
  select (select md5(string_agg(id::text || company_id::text || spz, ',' order by id)) from public.vehicles) v,
         (select md5(string_agg(id::text || user_id::text || role || status, ',' order by id)) from public.company_members) m,
         (select md5(string_agg(id::text || name || owner_id::text || plan, ',' order by id)) from public.companies) c;
select 'seeded' as phase;
\else
select
  (select v from public.__bf_snapshot) = (select md5(string_agg(id::text || company_id::text || spz, ',' order by id)) from public.vehicles) as vehicles_unchanged,
  (select m from public.__bf_snapshot) = (select md5(string_agg(id::text || user_id::text || role || status, ',' order by id)) from public.company_members) as members_unchanged,
  (select c from public.__bf_snapshot) = (select md5(string_agg(id::text || name || owner_id::text || plan, ',' order by id)) from public.companies) as companies_unchanged,
  -- žiadny vymyslený trial: pred-entitlement firmy majú trial NULL
  (select bool_and(trial_started_at is null and trial_ends_at is null) from public.companies) as no_fabricated_trial,
  -- výslovné granty beta_compat
  (select count(*) from public.company_entitlements where company_id = '00000000-0000-0000-0000-0000000000c1' and source = 'beta_compat' and limit_value is null) = (select count(*) from public.entitlement_catalog) as admin_all_modules_incl_voice,
  (select count(*) from public.company_entitlements where company_id = '00000000-0000-0000-0000-0000000000c2' and source = 'beta_compat' and limit_value is null) = (select count(*) from public.entitlement_catalog) as pro_all_modules_incl_voice,
  (select count(*) from public.company_entitlements where company_id = '00000000-0000-0000-0000-0000000000c3' and source = 'beta_compat') = (select count(*) from public.entitlement_catalog) - 1 as free_all_but_voice,
  (select limit_value from public.company_entitlements where company_id = '00000000-0000-0000-0000-0000000000c3' and entitlement_key = 'vehicles') = 2 as free_keeps_old_vehicle_limit,
  (select limit_value from public.company_entitlements where company_id = '00000000-0000-0000-0000-0000000000c3' and entitlement_key = 'inventory') = 5 as free_keeps_old_inventory_limit,
  (public.esblu_resolve_entitlement('00000000-0000-0000-0000-0000000000c3', 'invoicing') ->> 'source') = 'beta_compat' as free_invoicing_not_locked_out,
  (public.esblu_resolve_entitlement('00000000-0000-0000-0000-0000000000c3', 'team_members') ->> 'active')::boolean
    and (public.esblu_resolve_entitlement('00000000-0000-0000-0000-0000000000c3', 'team_members') ->> 'limit') is null as free_team_not_locked_out,
  (public.esblu_resolve_entitlement('00000000-0000-0000-0000-0000000000c3', 'voice') ->> 'reason') = 'VOICE_ENTITLEMENT_REQUIRED' as free_voice_stays_paid_only,
  (public.esblu_resolve_entitlement('00000000-0000-0000-0000-0000000000c2', 'voice') ->> 'active')::boolean as pro_keeps_voice_explicitly;
-- (roly: members_unchanged vyššie = backfill nezmenil žiadne členstvo ani rolu)
-- Nová firma po migrácii dostane trial a pred-entitlement firma si trial nevie „vyrobiť".
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000a009', 'bf-new@example.invalid');
insert into public.companies (id, owner_id, name) values ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-00000000a009', 'BF new');
select (select trial_ends_at = trial_started_at + interval '14 days' from public.companies where id = '00000000-0000-0000-0000-0000000000c9') as new_company_gets_one_trial,
       (select count(*) from public.company_entitlements where company_id = '00000000-0000-0000-0000-0000000000c9') = 0 as new_company_no_compat_grants;
do $$ begin
  update public.companies set trial_started_at = now(), trial_ends_at = now() + interval '14 days' where id = '00000000-0000-0000-0000-0000000000c3';
  raise exception 'FAIL: trial fabricated';
exception when others then
  if sqlerrm <> 'ESBLU_TRIAL_IMMUTABLE' then raise; end if;
  raise notice 'ok: pre-entitlement company cannot get a fabricated trial (%)', sqlerrm;
end $$;
\endif
