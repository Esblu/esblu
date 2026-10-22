-- =============================================================================
-- Granulárne oprávnenia členov tímu (V1 — prevádzkové moduly) — 2026-10-23
--
-- Roly ostávajú: owner / admin / accountant / employee. Zamestnancovi môže
-- owner alebo admin VO SVOJEJ FIRME zapnúť konkrétne prevádzkové zápisy.
-- Oprávnenie je naviazané na členstvo (company_members.id) — ten istý
-- používateľ má v inej firme vlastné (alebo žiadne) oprávnenia.
--
-- Vynútenie: RLS politiky prevádzkových tabuliek + storage upload fotiek
-- volajú public.esblu_my_has_permission(); úprava množstva vs. úprava
-- položky skladu sa rozlišuje triggerom. Tabuľky oprávnení sú RPC-only
-- (klient do nich nepíše ani z nich priamo nečíta).
--
-- Spätná kompatibilita:
--   owner/admin  = implicitne všetky prevádzkové oprávnenia (ako doteraz)
--   accountant   = žiadne prevádzkové (ako doteraz)
--   employee     = dnešný základ (čítanie vozidiel/strojov/skladu, servis a
--                  fotky vozidiel) + IBA explicitne udelené zápisy.
--   Migrácia nikomu nič neudelí.
-- Mimo V1 (vedome): doklady, partneri, faktúry (finance model ostáva
-- permissions.finance + účtovník), mazanie, billing, vlastníctvo, roly.
-- =============================================================================

-- ----------------------------------------------------------------------------- registry
-- Jediný zdroj pravdy v DB. TS zrkadlo: lib/team-permissions.ts (test parity).
create or replace function public.esblu_permission_registry()
returns table (permission text, area text, delegable boolean, admin_may_grant boolean, employee_baseline boolean)
language sql
immutable
set search_path = ''
as $function$
  values
    ('vehicles.view',           'vehicles',  false, false, true),
    ('vehicles.create',         'vehicles',  true,  true,  false),
    ('vehicles.edit',           'vehicles',  true,  true,  false),
    ('vehicles.manage_service', 'vehicles',  false, false, true),
    ('machines.view',           'machines',  false, false, true),
    ('machines.create',         'machines',  true,  true,  false),
    ('machines.edit',           'machines',  true,  true,  false),
    ('machines.manage_service', 'machines',  true,  true,  false),
    ('inventory.view',          'inventory', false, false, true),
    ('inventory.create',        'inventory', true,  true,  false),
    ('inventory.edit',          'inventory', true,  true,  false),
    ('inventory.adjust_stock',  'inventory', true,  true,  false)
$function$;
revoke all on function public.esblu_permission_registry() from public, anon;
grant execute on function public.esblu_permission_registry() to authenticated;

create or replace function public.esblu_permission_is_delegable(p_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce((select r.delegable from public.esblu_permission_registry() r where r.permission = p_permission), false)
$function$;
revoke all on function public.esblu_permission_is_delegable(text) from public, anon;
grant execute on function public.esblu_permission_is_delegable(text) to authenticated;

-- ----------------------------------------------------------------------------- tabuľky (RPC-only)
create table if not exists public.company_member_permissions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.company_members(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  permission text not null,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  constraint company_member_permissions_unique unique (member_id, permission),
  constraint company_member_permissions_delegable check (public.esblu_permission_is_delegable(permission))
);
create index if not exists company_member_permissions_company_idx on public.company_member_permissions (company_id);
alter table public.company_member_permissions enable row level security;
alter table public.company_member_permissions force row level security;
revoke all on table public.company_member_permissions from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.company_member_permissions to service_role;

-- Audit: kto komu v ktorej firme čo zmenil (bez iných údajov). Append-only.
create table if not exists public.company_member_permission_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  member_id uuid,
  target_user_id uuid,
  actor_user_id uuid,
  permission text not null,
  granted boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists company_member_permission_events_company_idx on public.company_member_permission_events (company_id, created_at desc);
alter table public.company_member_permission_events enable row level security;
alter table public.company_member_permission_events force row level security;
revoke all on table public.company_member_permission_events from public, anon, authenticated, service_role;
grant select, insert on table public.company_member_permission_events to service_role;

-- ----------------------------------------------------------------------------- vyhodnotenie
-- Má volajúci v AKTÍVNEJ firme dané oprávnenie? Neznáme oprávnenie = false.
create or replace function public.esblu_my_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select case
      when cm.role in ('owner', 'admin') then true
      when cm.role = 'employee' then r.employee_baseline or exists (
        select 1 from public.company_member_permissions p
        where p.member_id = cm.id and p.company_id = cm.company_id and p.permission = r.permission)
      else false
    end
    from public.company_members cm
    join public.esblu_permission_registry() r on r.permission = p_permission
    where cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
    limit 1
  ), false)
$function$;
revoke all on function public.esblu_my_has_permission(text) from public, anon;
grant execute on function public.esblu_my_has_permission(text) to authenticated;

-- Efektívne oprávnenia volajúceho v aktívnej firme (pre UI — nie autorita).
create or replace function public.esblu_my_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(array_agg(r.permission order by r.permission), '{}'::text[])
  from public.esblu_permission_registry() r
  where public.esblu_my_has_permission(r.permission)
$function$;
revoke all on function public.esblu_my_permissions() from public, anon;
grant execute on function public.esblu_my_permissions() to authenticated;

-- Udelené oprávnenia členov aktívnej firmy — iba owner/admin.
create or replace function public.esblu_list_company_member_permissions()
returns table (member_id uuid, permission text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.esblu_my_active_company_id();
  v_role text;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  select m.role into v_role from public.company_members m
   where m.user_id = v_uid and m.company_id = v_company and m.status = 'active';
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;
  return query
    select p.member_id, p.permission
      from public.company_member_permissions p
     where p.company_id = v_company
     order by p.member_id, p.permission;
end;
$function$;
revoke all on function public.esblu_list_company_member_permissions() from public, anon;
grant execute on function public.esblu_list_company_member_permissions() to authenticated;

-- Nastaví PRESNÚ množinu delegovaných oprávnení zamestnanca v aktívnej firme.
-- Cudzia firma sa nelíši od neexistujúceho člena (žiadny únik existencie).
-- Admin smie meniť iba oprávnenia, ktoré registry dovolí adminovi (pridať aj odobrať).
create or replace function public.esblu_set_member_permissions(p_member_id uuid, p_permissions text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.esblu_my_active_company_id();
  v_caller_role text;
  v_target record;
  v_wanted text[];
  v_bad text;
  v_current text[];
  v_perm text;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  if p_member_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_ARGUMENT';
  end if;

  select m.role into v_caller_role from public.company_members m
   where m.user_id = v_uid and m.company_id = v_company and m.status = 'active';
  if v_caller_role is null or v_caller_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text || ':member_permissions', 0));

  select m.id, m.user_id, m.role, m.status, m.company_id into v_target
    from public.company_members m where m.id = p_member_id for update;
  if v_target.id is null or v_target.company_id is distinct from v_company then
    raise exception using errcode = 'P0001', message = 'ESBLU_MEMBER_NOT_FOUND';
  end if;
  if v_target.user_id = v_uid then
    raise exception using errcode = '42501', message = 'ESBLU_CANNOT_EDIT_OWN_PERMISSIONS';
  end if;
  if v_target.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'ESBLU_MEMBER_NOT_ACTIVE';
  end if;
  if v_target.role <> 'employee' then
    raise exception using errcode = '42501', message = 'ESBLU_PERMISSIONS_EMPLOYEE_ONLY';
  end if;

  select coalesce(array_agg(distinct btrim(x) order by btrim(x)), '{}'::text[]) into v_wanted
    from unnest(coalesce(p_permissions, '{}'::text[])) x;

  select string_agg(w, ', ') into v_bad from unnest(v_wanted) w
   where not exists (select 1 from public.esblu_permission_registry() r where r.permission = w);
  if v_bad is not null then
    raise exception using errcode = 'P0001', message = 'ESBLU_UNKNOWN_PERMISSION:' || v_bad;
  end if;
  select string_agg(w, ', ') into v_bad from unnest(v_wanted) w
    join public.esblu_permission_registry() r on r.permission = w where not r.delegable;
  if v_bad is not null then
    raise exception using errcode = '42501', message = 'ESBLU_PERMISSION_NOT_DELEGABLE:' || v_bad;
  end if;

  select coalesce(array_agg(p.permission order by p.permission), '{}'::text[]) into v_current
    from public.company_member_permissions p where p.member_id = v_target.id;

  if v_caller_role = 'admin' then
    select string_agg(x, ', ') into v_bad
      from ((select unnest(v_wanted) except select unnest(v_current))
            union
            (select unnest(v_current) except select unnest(v_wanted))) d(x)
      join public.esblu_permission_registry() r on r.permission = d.x
     where not r.admin_may_grant;
    if v_bad is not null then
      raise exception using errcode = '42501', message = 'ESBLU_PERMISSION_OWNER_ONLY:' || v_bad;
    end if;
  end if;

  for v_perm in select unnest(v_current) except select unnest(v_wanted) loop
    delete from public.company_member_permissions where member_id = v_target.id and permission = v_perm;
    insert into public.company_member_permission_events (company_id, member_id, target_user_id, actor_user_id, permission, granted)
    values (v_company, v_target.id, v_target.user_id, v_uid, v_perm, false);
  end loop;

  for v_perm in select unnest(v_wanted) except select unnest(v_current) loop
    insert into public.company_member_permissions (member_id, company_id, permission, granted_by)
    values (v_target.id, v_company, v_perm, v_uid);
    insert into public.company_member_permission_events (company_id, member_id, target_user_id, actor_user_id, permission, granted)
    values (v_company, v_target.id, v_target.user_id, v_uid, v_perm, true);
  end loop;

  return v_wanted;
end;
$function$;
revoke all on function public.esblu_set_member_permissions(uuid, text[]) from public, anon;
grant execute on function public.esblu_set_member_permissions(uuid, text[]) to authenticated;

-- Zmena roly / odchod z firmy = delegované oprávnenia zaniknú (žiadne „spiace“
-- práva, ktoré by sa vrátili pri spätnej zmene na zamestnanca).
create or replace function public.esblu_member_permissions_reset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.role is distinct from old.role or (old.status = 'active' and new.status <> 'active') then
    delete from public.company_member_permissions where member_id = new.id;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_member_permissions_reset() from public, anon, authenticated, service_role;
drop trigger if exists esblu_member_permissions_reset on public.company_members;
create trigger esblu_member_permissions_reset
  after update of role, status on public.company_members
  for each row execute function public.esblu_member_permissions_reset();

-- ----------------------------------------------------------------------------- RLS: prevádzkové zápisy
-- Vozidlá
drop policy if exists vehicles_insert_owner_admin on public.vehicles;
drop policy if exists vehicles_insert_permitted on public.vehicles;
create policy vehicles_insert_permitted on public.vehicles for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('vehicles.create'));
drop policy if exists vehicles_update_owner_admin on public.vehicles;
drop policy if exists vehicles_update_permitted on public.vehicles;
create policy vehicles_update_permitted on public.vehicles for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('vehicles.edit'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('vehicles.edit'));

drop policy if exists vehicle_vignettes_insert_owner_admin on public.vehicle_vignettes;
drop policy if exists vehicle_vignettes_insert_permitted on public.vehicle_vignettes;
create policy vehicle_vignettes_insert_permitted on public.vehicle_vignettes for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('vehicles.edit')
    and exists (select 1 from public.vehicles v where v.id = vehicle_vignettes.vehicle_id and v.company_id = public.esblu_my_active_company_id()));
drop policy if exists vehicle_vignettes_update_owner_admin on public.vehicle_vignettes;
drop policy if exists vehicle_vignettes_update_permitted on public.vehicle_vignettes;
create policy vehicle_vignettes_update_permitted on public.vehicle_vignettes for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('vehicles.edit')
    and exists (select 1 from public.vehicles v where v.id = vehicle_vignettes.vehicle_id and v.company_id = public.esblu_my_active_company_id()))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('vehicles.edit')
    and exists (select 1 from public.vehicles v where v.id = vehicle_vignettes.vehicle_id and v.company_id = public.esblu_my_active_company_id()));

-- Stroje
drop policy if exists machines_insert_manager on public.machines;
drop policy if exists machines_insert_permitted on public.machines;
create policy machines_insert_permitted on public.machines for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.create'));
drop policy if exists machines_update_manager on public.machines;
drop policy if exists machines_update_permitted on public.machines;
create policy machines_update_permitted on public.machines for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.edit'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.edit'));

drop policy if exists machine_photos_insert_manager on public.machine_photos;
drop policy if exists machine_photos_insert_permitted on public.machine_photos;
create policy machine_photos_insert_permitted on public.machine_photos for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.edit'));
drop policy if exists machine_photos_update_manager on public.machine_photos;
drop policy if exists machine_photos_update_permitted on public.machine_photos;
create policy machine_photos_update_permitted on public.machine_photos for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.edit'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.edit'));

drop policy if exists machine_services_insert_manager on public.machine_services;
drop policy if exists machine_services_insert_permitted on public.machine_services;
create policy machine_services_insert_permitted on public.machine_services for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.manage_service'));
drop policy if exists machine_services_update_manager on public.machine_services;
drop policy if exists machine_services_update_permitted on public.machine_services;
create policy machine_services_update_permitted on public.machine_services for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.manage_service'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('machines.manage_service'));

-- Sklad
drop policy if exists inventory_items_insert_manager on public.inventory_items;
drop policy if exists inventory_items_insert_permitted on public.inventory_items;
create policy inventory_items_insert_permitted on public.inventory_items for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('inventory.create'));
drop policy if exists inventory_items_update_manager on public.inventory_items;
drop policy if exists inventory_items_update_permitted on public.inventory_items;
create policy inventory_items_update_permitted on public.inventory_items for update to authenticated
  using (company_id = public.esblu_my_active_company_id()
    and (public.esblu_my_has_permission('inventory.edit') or public.esblu_my_has_permission('inventory.adjust_stock')))
  with check (company_id = public.esblu_my_active_company_id()
    and (public.esblu_my_has_permission('inventory.edit') or public.esblu_my_has_permission('inventory.adjust_stock')));

drop policy if exists inventory_photos_insert_manager on public.inventory_photos;
drop policy if exists inventory_photos_insert_permitted on public.inventory_photos;
create policy inventory_photos_insert_permitted on public.inventory_photos for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('inventory.edit'));
drop policy if exists inventory_photos_update_manager on public.inventory_photos;
drop policy if exists inventory_photos_update_permitted on public.inventory_photos;
create policy inventory_photos_update_permitted on public.inventory_photos for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('inventory.edit'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_has_permission('inventory.edit'));

-- „Iba úprava množstva“ ≠ „úprava položky“: bez inventory.edit smie zmeniť iba quantity.
-- Server (service_role) a migrácie nemajú používateľa — rozhoduje ich vlastná autorizácia.
create or replace function public.esblu_inventory_update_permission_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or public.esblu_my_has_permission('inventory.edit') then
    return new;
  end if;
  if (to_jsonb(new) - 'quantity') is distinct from (to_jsonb(old) - 'quantity') then
    raise exception using errcode = '42501', message = 'ESBLU_PERMISSION_DENIED:inventory.edit';
  end if;
  if new.quantity is distinct from old.quantity and not public.esblu_my_has_permission('inventory.adjust_stock') then
    raise exception using errcode = '42501', message = 'ESBLU_PERMISSION_DENIED:inventory.adjust_stock';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_inventory_update_permission_guard() from public, anon, authenticated, service_role;
drop trigger if exists esblu_inventory_update_permission_guard on public.inventory_items;
create trigger esblu_inventory_update_permission_guard
  before update on public.inventory_items
  for each row execute function public.esblu_inventory_update_permission_guard();

-- ----------------------------------------------------------------------------- storage: upload fotiek
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
    -- 20261023100000: stroje/sklad podľa delegovaného oprávnenia (owner/admin implicitne).
    if p_bucket = 'machine-photos' then
      return public.esblu_my_has_permission('machines.edit');
    end if;
    return public.esblu_my_has_permission('inventory.edit');
  end if;

  if p_action = 'delete' then
    return v_role in ('owner', 'admin');
  end if;

  return false;
end;
$function$;
revoke all on function public.esblu_media_role_allows(text, text) from public, anon;
grant execute on function public.esblu_media_role_allows(text, text) to authenticated, service_role;
