-- =============================================================================
-- L3 krok 1 — staging marker. Spúšťa sa IBA cez Supabase MCP / SQL editor
-- projektu cjbdijbbcujvmrzezusd (esblu-test), po výslovnom schválení.
-- Bezpečnostná poistka: ak v DB existuje produkčná história migrácií alebo
-- akékoľvek dáta v auth.users / storage.objects, marker sa NEVYTVORÍ.
-- =============================================================================
begin;
do $pre$
declare v_prod boolean;
begin
  -- Dynamicky: tabuľka histórie v čerstvom stagingu nemusí existovať (statický odkaz by zlyhal pri kompilácii).
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select exists (select 1 from supabase_migrations.schema_migrations where version = any($1))'
      into v_prod using array['20260930213531', '20260930213818', '20260929201345'];
    if v_prod then
      raise exception 'L3_GUARD_STOP: produkčná história migrácií — marker sa nevytvorí';
    end if;
  end if;
  if exists (select 1 from auth.users) or exists (select 1 from storage.objects) then
    raise exception 'L3_GUARD_STOP: databáza nie je prázdna (auth.users / storage.objects)';
  end if;
end
$pre$;
create schema if not exists esblu_l3;
revoke all on schema esblu_l3 from public, anon, authenticated;
create table if not exists esblu_l3.target (ref text primary key, created_at timestamptz not null default now(), note text);
revoke all on esblu_l3.target from public, anon, authenticated;
insert into esblu_l3.target (ref, note) values ('cjbdijbbcujvmrzezusd', 'esblu-test = L3 staging pre E-Faktúru') on conflict do nothing;
commit;
