// =============================================================================
// Granulárne oprávnenia členov tímu — kanonický register (V1, 2026-10-23).
//
// Zrkadlo DB funkcie public.esblu_permission_registry() z migrácie
// 20261023100000_team_granular_permissions.sql. Zhodu stráži test
// (scripts/team-permissions-pglite-tests.ts). Autoritou je VŽDY databáza
// (RLS + RPC); tento modul iba hovorí UI, čo ukázať.
//
//   owner / admin  — implicitne všetky prevádzkové oprávnenia
//   accountant     — žiadne prevádzkové (financie riešia finance oprávnenia)
//   employee       — základ (baseline) + iba explicitne udelené zápisy
//
// Neznáme oprávnenie = false (fail closed).
// =============================================================================

export const TEAM_PERMISSION_AREAS = ["vehicles", "machines", "inventory"] as const;
export type TeamPermissionArea = (typeof TEAM_PERMISSION_AREAS)[number];

export type TeamPermissionDef = {
  key: TeamPermission;
  area: TeamPermissionArea;
  /** Smie owner/admin zamestnancovi zapnúť/vypnúť. */
  delegable: boolean;
  /** Smie ho meniť aj admin (inak iba owner). */
  adminMayGrant: boolean;
  /** Zamestnanec ho má vždy (dnešný základ, nedá sa vypnúť). */
  employeeBaseline: boolean;
};

export const TEAM_PERMISSIONS = [
  "vehicles.view",
  "vehicles.create",
  "vehicles.edit",
  "vehicles.manage_service",
  "machines.view",
  "machines.create",
  "machines.edit",
  "machines.manage_service",
  "inventory.view",
  "inventory.create",
  "inventory.edit",
  "inventory.adjust_stock",
] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

const def = (
  key: TeamPermission,
  area: TeamPermissionArea,
  delegable: boolean,
  adminMayGrant: boolean,
  employeeBaseline: boolean
): TeamPermissionDef => ({ key, area, delegable, adminMayGrant, employeeBaseline });

export const TEAM_PERMISSION_REGISTRY: readonly TeamPermissionDef[] = [
  def("vehicles.view", "vehicles", false, false, true),
  def("vehicles.create", "vehicles", true, true, false),
  def("vehicles.edit", "vehicles", true, true, false),
  def("vehicles.manage_service", "vehicles", false, false, true),
  def("machines.view", "machines", false, false, true),
  def("machines.create", "machines", true, true, false),
  def("machines.edit", "machines", true, true, false),
  def("machines.manage_service", "machines", true, true, false),
  def("inventory.view", "inventory", false, false, true),
  def("inventory.create", "inventory", true, true, false),
  def("inventory.edit", "inventory", true, true, false),
  def("inventory.adjust_stock", "inventory", true, true, false),
];

export function isTeamPermission(value: unknown): value is TeamPermission {
  return typeof value === "string" && (TEAM_PERMISSIONS as readonly string[]).includes(value);
}

export function permissionDef(key: string): TeamPermissionDef | null {
  return TEAM_PERMISSION_REGISTRY.find((d) => d.key === key) ?? null;
}

/** Oprávnenia, ktoré smie daný správca zamestnancovi zapnúť/vypnúť. */
export function delegablePermissionsFor(managerRole: string | null | undefined): TeamPermissionDef[] {
  if (managerRole === "owner") return TEAM_PERMISSION_REGISTRY.filter((d) => d.delegable);
  if (managerRole === "admin") return TEAM_PERMISSION_REGISTRY.filter((d) => d.delegable && d.adminMayGrant);
  return [];
}

/**
 * Efektívne oprávnenie pre UI. `granted` = množina z esblu_my_permissions()
 * (server už zarátal rolu aj základ); bez nej sa použije iba rola.
 */
export function can(
  permission: string,
  role: string | null | undefined,
  granted?: ReadonlySet<string> | readonly string[] | null
): boolean {
  const d = permissionDef(permission);
  if (!d) return false;
  if (granted) {
    const set = granted instanceof Set ? granted : new Set(granted as readonly string[]);
    return set.has(permission);
  }
  if (role === "owner" || role === "admin") return true;
  if (role === "employee") return d.employeeBaseline;
  return false;
}

/** Ľahké predvoľby — iba zaškrtnú konkrétne oprávnenia, nie je to rola. */
export const PERMISSION_PRESETS: { key: string; permissions: TeamPermission[] }[] = [
  { key: "readOnly", permissions: [] },
  {
    key: "operations",
    permissions: ["vehicles.create", "vehicles.edit", "machines.create", "machines.edit", "machines.manage_service", "inventory.adjust_stock"],
  },
  { key: "storekeeper", permissions: ["inventory.create", "inventory.edit", "inventory.adjust_stock"] },
  { key: "technician", permissions: ["machines.edit", "machines.manage_service", "vehicles.edit", "inventory.adjust_stock"] },
];
