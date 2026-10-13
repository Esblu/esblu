-- =============================================================================
-- L3 krok 10 — E-Faktúra pre firmu A v SANDBOXE: organizácia u poskytovateľa
-- + rollout allowlist. Pred spustením nastav v_org na UUID
-- sandbox organizácie z L2 (nie je tajný). Live sa NEPOVOĽUJE.
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
do $rollout$
declare
  v_org text := '__SANDBOX_ORG_UUID__';
  c_a uuid := 'a1300000-0000-4000-8000-00000000000a';
begin
  if v_org !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'L3_ROLLOUT_STOP: v_org nie je UUID sandbox organizácie (zástupná hodnota nenahradená)';
  end if;
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, org_status, peppol_eligible)
    values (c_a, 'efaktura_sk', 'sandbox', v_org, '9915:2099999999', 'active', true)
    on conflict (company_id, environment) do nothing;
  insert into public.einvoice_rollout (company_id, environment, stage, note, changed_by)
    values (c_a, 'sandbox', 'internal', 'L3 staging', 'L3 setup')
    on conflict (company_id, environment) do update set stage = 'internal', changed_by = 'L3 setup', updated_at = now();
  if exists (select 1 from public.einvoice_rollout where environment = 'live') then
    raise exception 'L3_ROLLOUT_STOP: v stagingu nesmie existovať live rollout';
  end if;
end
$rollout$;
commit;
