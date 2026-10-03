-- =============================================================================
-- L3 krok 2 — reset public schémy STAGINGU (esblu-test). DEŠTRUKTÍVNE.
-- Audit 2026-10-03: 8 legacy tabuliek (documents, document_links,
-- document_review_log, inventory_items, machine_services, machines,
-- vehicle_services, vehicles), všetky s 0 riadkami; 10 politík; 0 funkcií;
-- auth.users = 0, storage.objects = 0, žiadne buckety, žiadna história migrácií.
-- Obnoví predvolené Supabase granty pre public.
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
do $empty$
begin
  if exists (select 1 from auth.users) or exists (select 1 from storage.objects) then
    raise exception 'L3_GUARD_STOP: staging už obsahuje používateľov alebo súbory — reset zastavený';
  end if;
end
$empty$;
drop schema public cascade;
create schema public authorization pg_database_owner;
comment on schema public is 'standard public schema';
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
alter default privileges for role postgres in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to postgres, anon, authenticated, service_role;
delete from storage.buckets;  -- staging nemá žiadne objekty (overené vyššie)
commit;
