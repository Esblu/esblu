-- =============================================================================
-- Esblu - rola iba na čítanie pre zálohu databázy (pg_dump), 2026-11-20.
-- NIE JE migrácia a NEAPLIKUJE sa automaticky. Spúšťa sa iba po schválení prevádzkovateľa
-- (Supabase SQL Editor, rola postgres). Heslo sa nastaví ZVLÁŠŤ (ALTER ROLE ... PASSWORD),
-- nikdy nie v tomto súbore ani v Gite.
--
-- Prečo: Supabase secret / service_role kľúč nemá režim „iba čítanie“ (obchádza RLS a smie
-- zapisovať aj mazať). Táto rola smie iba SELECT; zápis odmietne vrstva oprávnení (42501)
-- aj keď si klient vypne default_transaction_read_only. Overené v PGlite na celej schéme Esblu
-- (scripts/ops/esblu-backup-pglite-tests.ts) a pred použitím v produkcii overovacím dotazom nižšie.
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'esblu_backup') then
    create role esblu_backup login noinherit nocreatedb nocreaterole noreplication bypassrls connection limit 2;
  end if;
end $$;

alter role esblu_backup set default_transaction_read_only = on;   -- druhá vrstva (prvá = oprávnenia)
alter role esblu_backup set statement_timeout = '15min';
alter role esblu_backup set idle_in_transaction_session_timeout = '5min';

grant usage on schema public, storage, auth to esblu_backup;
grant select on all tables in schema public to esblu_backup;
grant select on all sequences in schema public to esblu_backup;
grant select on storage.buckets, storage.objects to esblu_backup;
grant select on auth.users, auth.identities to esblu_backup;
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'supabase_migrations') then
    execute 'grant usage on schema supabase_migrations to esblu_backup';
    execute 'grant select on supabase_migrations.schema_migrations to esblu_backup';
  end if;
end $$;
-- Nové tabuľky (budúce migrácie vytvára rola postgres) sú čitateľné automaticky.
alter default privileges for role postgres in schema public grant select on tables to esblu_backup;
alter default privileges for role postgres in schema public grant select on sequences to esblu_backup;

-- -----------------------------------------------------------------------------
-- OVEROVACÍ DOTAZ (po vytvorení, iba čítanie): každý riadok musí mať ok = true.
-- -----------------------------------------------------------------------------
-- select 'no write on any table' chk, not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
--          where n.nspname in ('public','storage','auth','supabase_migrations','vault','realtime') and c.relkind in ('r','p')
--          and (has_table_privilege('esblu_backup', c.oid, 'INSERT') or has_table_privilege('esblu_backup', c.oid, 'UPDATE')
--            or has_table_privilege('esblu_backup', c.oid, 'DELETE') or has_table_privilege('esblu_backup', c.oid, 'TRUNCATE'))) ok
-- union all select 'no security definer function', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--          where p.prosecdef and n.nspname not in ('pg_catalog','information_schema') and has_function_privilege('esblu_backup', p.oid, 'EXECUTE'))
-- union all select 'no CREATE in schemas', not exists (select 1 from pg_namespace n where has_schema_privilege('esblu_backup', n.oid, 'CREATE'))
-- union all select 'no role membership', not exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'esblu_backup')
-- union all select 'not superuser/createrole', (select not rolsuper and not rolcreaterole and not rolcreatedb from pg_roles where rolname = 'esblu_backup');
