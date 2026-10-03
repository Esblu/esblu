-- =============================================================================
-- L3 krok 7 — closed beta allowlist pre syntetických L3 používateľov (PRED ich
-- vytvorením, ak je v stagingu zapnutý Before User Created hook). Iba
-- rezervovaná doména example.com — žiadne reálne e-maily.
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
insert into public.beta_allowlist (email, note) values
  ('l3-owner@example.com', 'L3 staging'),
  ('l3-accountant@example.com', 'L3 staging'),
  ('l3-admin-fin@example.com', 'L3 staging'),
  ('l3-admin@example.com', 'L3 staging'),
  ('l3-employee@example.com', 'L3 staging'),
  ('l3-other-owner@example.com', 'L3 staging')
on conflict (email) do nothing;
commit;
