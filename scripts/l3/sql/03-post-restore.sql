-- =============================================================================
-- L3 krok 4 — po obnove produkčnej štruktúry (10/20/21/30/31 z .l3-local/):
-- Realtime publikácia pre chat (rovnako ako 20260827100000_add_chat_core) a
-- kontrolný výpis. Bez dát, bez tajomstiev.
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
do $rt$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['chat_messages', 'chat_attachments', 'chat_message_references'] loop
      if to_regclass('public.' || t) is not null and not exists (
        select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  else
    raise notice 'supabase_realtime neexistuje — zapnúť v Dashboard → Database → Publications';
  end if;
end
$rt$;
commit;

-- Kontrola (iba čítanie)
select 'public_tables' k, count(*)::text v from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
union all select 'public_functions', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
union all select 'public_policies', count(*)::text from pg_policies where schemaname = 'public'
union all select 'storage_policies', count(*)::text from pg_policies where schemaname = 'storage'
union all select 'buckets', coalesce(string_agg(id || ':' || public::text, ',' order by id), '') from storage.buckets
union all select 'einvoice_tables', count(*)::text from information_schema.tables where table_schema = 'public' and table_name like 'einvoice%'
union all select 'realtime', coalesce(string_agg(tablename, ',' order by tablename), '') from pg_publication_tables where pubname = 'supabase_realtime';
