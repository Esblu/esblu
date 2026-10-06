-- 20261008100002 — finance oprávnenie vždy viazané na konkrétnu firmu (defense in depth).
--
-- Audit (október 2026): esblu_my_finance_manage() / esblu_my_finance_view() čítali „prvé aktívne
-- členstvo“ (limit 1 bez väzby na firmu). Dnes to NIE JE zneužiteľné, lebo unikátny index
-- company_members_one_active_per_user_idx (20260814…) dovoľuje používateľovi iba jedno aktívne
-- členstvo, takže prvé aktívne členstvo = aktívna firma. Väzba však bola iba implicitná: ak by sa
-- index niekedy odstránil (multi-company), oprávnenie z firmy A by mohlo platiť pri zdroji firmy B.
--
-- Oprava: helpery explicitne vyhodnotia oprávnenie pre esblu_my_active_company_id() — teda pre tú
-- istú firmu, ktorú RLS a RPC porovnávajú so stĺpcom company_id zdroja. Sémantika rolí je
-- nezmenená (owner/accountant áno, employee nie, admin iba s permissions.finance.*).
-- Signatúry, SECURITY DEFINER, search_path aj granty ostávajú (create or replace).

create or replace function public.esblu_my_finance_manage()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce((
    select case
      when cm.role = 'employee' then false
      when cm.role in ('owner', 'accountant') then true
      else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
    end
    from public.company_members cm
    where cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  ), false);
$function$;

create or replace function public.esblu_my_finance_view()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce((
    select case
      when cm.role = 'employee' then false
      when cm.role in ('owner', 'accountant') then true
      else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false)
        or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
    end
    from public.company_members cm
    where cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
  ), false);
$function$;
