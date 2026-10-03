-- =============================================================================
-- L3 krok 2 — reset public schémy STAGINGU (esblu-test). DEŠTRUKTÍVNE.
-- Audit 2026-10-03: 8 legacy tabuliek (documents, document_links,
-- document_review_log, inventory_items, machine_services, machines,
-- vehicle_services, vehicles), všetky s 0 riadkami; 10 politík; 0 funkcií;
-- auth.users = 0, storage.objects = 0, žiadne buckety, žiadna história migrácií.
-- Granty a predvolené privilégiá public NEnastavuje — obnoví ich presne
-- produkčný dump (10-prod-public-schema.sql: GRANT USAGE + ALTER DEFAULT
-- PRIVILEGES FOR ROLE postgres). Supabase predvolené `… to anon` by inak
-- dalo anon práva, ktoré produkcia nemá.
--
-- Oprava 2026-10-03: odstránené `delete from storage.buckets` — Supabase
-- priame mazanie zo storage tabuliek zakazuje (storage.protect_delete) a celá
-- transakcia sa zrolovala. Buckety sa tu nemenia; ak už existujú, iba sa
-- vypíše upozornenie (30-prod-storage-buckets.sql ich potom treba vložiť
-- s ON CONFLICT DO NOTHING alebo bucket odstrániť cez Storage API/Dashboard).
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
-- PG15+ predvolené USAGE pre PUBLIC (produkcia: =U/pg_database_owner); pg_dump
-- ho neexportuje (pg_init_privs), preto sa obnovuje tu. Ostatné granty dodá dump.
grant usage on schema public to public;
do $buckets$
declare n integer;
begin
  select count(*) into n from storage.buckets;
  if n > 0 then
    raise notice 'L3: storage.buckets už obsahuje % bucketov — nemažú sa (Supabase to priamo nedovolí); 30-prod-storage-buckets.sql vkladať s ON CONFLICT DO NOTHING', n;
  end if;
end
$buckets$;
commit;
