-- Rollback 20261023100000_team_granular_permissions.sql
-- Vráti role-based politiky (owner/admin) presne podľa stavu pred migráciou,
-- pôvodnú esblu_media_role_allows a odstráni tabuľky/funkcie oprávnení.
-- Udelené oprávnenia (company_member_permissions) a audit sa tým ZMAŽÚ.

drop policy if exists vehicles_insert_permitted on public.vehicles;
create policy vehicles_insert_owner_admin on public.vehicles for insert to authenticated
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));
drop policy if exists vehicles_update_permitted on public.vehicles;
create policy vehicles_update_owner_admin on public.vehicles for update to authenticated
  using ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])))
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));

drop policy if exists vehicle_vignettes_insert_permitted on public.vehicle_vignettes;
create policy vehicle_vignettes_insert_owner_admin on public.vehicle_vignettes for insert to authenticated
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text]))
    and (exists (select 1 from public.vehicles v where ((v.id = vehicle_vignettes.vehicle_id) and (v.company_id = public.esblu_my_active_company_id())))));
drop policy if exists vehicle_vignettes_update_permitted on public.vehicle_vignettes;
create policy vehicle_vignettes_update_owner_admin on public.vehicle_vignettes for update to authenticated
  using ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text]))
    and (exists (select 1 from public.vehicles v where ((v.id = vehicle_vignettes.vehicle_id) and (v.company_id = public.esblu_my_active_company_id())))))
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text]))
    and (exists (select 1 from public.vehicles v where ((v.id = vehicle_vignettes.vehicle_id) and (v.company_id = public.esblu_my_active_company_id())))));

drop policy if exists machines_insert_permitted on public.machines;
create policy machines_insert_manager on public.machines for insert to authenticated
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));
drop policy if exists machines_update_permitted on public.machines;
create policy machines_update_manager on public.machines for update to authenticated
  using ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])))
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));

drop policy if exists machine_photos_insert_permitted on public.machine_photos;
create policy machine_photos_insert_manager on public.machine_photos for insert to authenticated
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));
drop policy if exists machine_photos_update_permitted on public.machine_photos;
create policy machine_photos_update_manager on public.machine_photos for update to authenticated
  using ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])))
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));

drop policy if exists machine_services_insert_permitted on public.machine_services;
create policy machine_services_insert_manager on public.machine_services for insert to authenticated
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));
drop policy if exists machine_services_update_permitted on public.machine_services;
create policy machine_services_update_manager on public.machine_services for update to authenticated
  using ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])))
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));

drop policy if exists inventory_items_insert_permitted on public.inventory_items;
create policy inventory_items_insert_manager on public.inventory_items for insert to authenticated
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));
drop policy if exists inventory_items_update_permitted on public.inventory_items;
create policy inventory_items_update_manager on public.inventory_items for update to authenticated
  using ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])))
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));

drop policy if exists inventory_photos_insert_permitted on public.inventory_photos;
create policy inventory_photos_insert_manager on public.inventory_photos for insert to authenticated
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));
drop policy if exists inventory_photos_update_permitted on public.inventory_photos;
create policy inventory_photos_update_manager on public.inventory_photos for update to authenticated
  using ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])))
  with check ((company_id = public.esblu_my_active_company_id()) and (public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])));

drop trigger if exists esblu_inventory_update_permission_guard on public.inventory_items;
drop function if exists public.esblu_inventory_update_permission_guard();

create or replace function public.esblu_media_role_allows(p_bucket text, p_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public.esblu_my_active_role();
begin
  if v_role is null then
    return false;
  end if;

  if p_bucket = 'company-logos' then
    if p_action = 'read' then return true; end if;
    if p_action in ('upload', 'delete') then return public.esblu_my_finance_manage(); end if;
    return false;
  end if;

  if p_bucket not in ('vehicle-photos', 'machine-photos', 'inventory-photos') then
    return false;
  end if;

  if p_action = 'read' then
    return v_role in ('owner', 'admin', 'employee');
  end if;

  if p_action = 'upload' then
    if p_bucket = 'vehicle-photos' then
      return v_role in ('owner', 'admin', 'employee');
    end if;
    return v_role in ('owner', 'admin');
  end if;

  if p_action = 'delete' then
    return v_role in ('owner', 'admin');
  end if;

  return false;
end;
$function$;
revoke all on function public.esblu_media_role_allows(text, text) from public, anon;
grant execute on function public.esblu_media_role_allows(text, text) to authenticated, service_role;

drop trigger if exists esblu_member_permissions_reset on public.company_members;
drop function if exists public.esblu_member_permissions_reset();
drop function if exists public.esblu_set_member_permissions(uuid, text[]);
drop function if exists public.esblu_list_company_member_permissions();
drop function if exists public.esblu_my_permissions();
drop function if exists public.esblu_my_has_permission(text);
drop table if exists public.company_member_permission_events;
drop table if exists public.company_member_permissions;
drop function if exists public.esblu_permission_is_delegable(text);
drop function if exists public.esblu_permission_registry();
