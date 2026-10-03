-- =============================================================================
-- L3 staging — SQL HARD GUARD. Vkladá sa ako PRVÝ blok každého L3 SQL súboru.
-- Prejde IBA v databáze, ktorá nesie staging marker (esblu_l3.target =
-- cjbdijbbcujvmrzezusd) a NEMÁ produkčnú migračnú stopu. Na produkcii marker
-- neexistuje → okamžitá výnimka, nič sa nevykoná (súbory bežia v transakcii).
-- =============================================================================
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
