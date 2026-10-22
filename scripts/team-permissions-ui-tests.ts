// =============================================================================
// Granulárne oprávnenia — UI kontrakty (bez DB). npm run test:team-permissions-ui
// Overuje: preklady pre každé delegovateľné oprávnenie (sk/en/de), že UI
// rozhoduje podľa oprávnení (nie iba podľa roly), mazanie ostáva owner/admin,
// editor zapisuje výhradne cez RPC a zobrazí sa iba ownerovi/adminovi pri
// zamestnancovi (nie sebe).
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { TEAM_PERMISSION_REGISTRY, TEAM_PERMISSION_AREAS, PERMISSION_PRESETS, can, delegablePermissionsFor } = await import("@/lib/team-permissions");
const { dictionaries } = await import("@/lib/i18n/dictionaries/index");

let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
const read = (p: string) => readFileSync(p, "utf8");
function lookup(locale: string, key: string): unknown {
  let node: unknown = (dictionaries as Record<string, unknown>)[locale];
  for (const part of key.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  return node;
}

check("preklady: každé delegovateľné oprávnenie, oblasť, predvoľba a chyba (sk/en/de)", () => {
  const keys = [
    ...TEAM_PERMISSION_REGISTRY.filter((d) => d.delegable).map((d) => `settings.permissions.labels.${d.key.replace(".", "_")}`),
    ...TEAM_PERMISSION_AREAS.flatMap((a) => [`settings.permissions.areas.${a}`, `settings.permissions.baseline.${a}`]),
    ...PERMISSION_PRESETS.map((p) => `settings.permissions.presets.${p.key}`),
    ...["own", "employeeOnly", "forbidden", "ownerOnly", "member", "generic"].map((e) => `settings.permissions.errors.${e}`),
    "settings.permissions.title", "settings.permissions.intro", "settings.permissions.save", "settings.permissions.notDelegated",
  ];
  for (const locale of ["sk", "en", "de"]) for (const key of keys) assert.equal(typeof lookup(locale, key), "string", `${locale}: ${key}`);
});

check("can(): rola bez množiny = správanie pred granulárnymi oprávneniami (nikdy viac)", () => {
  assert.equal(can("machines.create", "owner"), true);
  assert.equal(can("machines.create", "admin"), true);
  assert.equal(can("machines.create", "employee"), false);
  assert.equal(can("vehicles.manage_service", "employee"), true);
  assert.equal(can("machines.view", "accountant"), false);
  assert.equal(can("machines.create", "employee", new Set(["machines.create"])), true);
  assert.equal(can("machines.create", "owner", new Set()), false, "server je autorita, keď odpovie");
  assert.equal(delegablePermissionsFor("admin").length, TEAM_PERMISSION_REGISTRY.filter((d) => d.delegable && d.adminMayGrant).length);
});

check("stroje: pridanie/úprava podľa oprávnení, mazanie owner/admin", () => {
  const page = read("app/stroje/page.tsx");
  assert.ok(page.includes('const canCreateMachine = teamPermissions.can("machines.create");'));
  assert.ok(page.includes('const canEditMachine = teamPermissions.can("machines.edit");'));
  assert.ok(page.includes("{canManageMachines && (\n                        <button\n                          type=\"button\"\n                          onClick={() => deleteMachine(item.id)}"));
  assert.ok(page.includes('setCanManageMachines(membership.role === "owner" || membership.role === "admin");'), "mazanie ostáva owner/admin");
  const detail = read("app/stroje/MachineDetailView.tsx");
  assert.ok(detail.includes('const canManageService = teamPermissions.can("machines.manage_service");'));
});

check("sklad: create/edit/adjust oddelene, iba-množstvo posiela len quantity", () => {
  const page = read("app/sklad/page.tsx");
  for (const p of ["inventory.create", "inventory.edit", "inventory.adjust_stock"]) assert.ok(page.includes(`teamPermissions.can("${p}")`));
  assert.ok(page.includes(".update(stockOnly ? { quantity: payload.quantity } : payload)"));
  assert.ok(page.includes("disabled={stockOnly}"));
});

check("vozidlá: CTA pridania podľa vehicles.create (nie podľa roly employee)", () => {
  const page = read("app/vozidla/page.tsx");
  assert.ok(page.includes('const canCreateVehicle = teamPermissions.can("vehicles.create");'));
  assert.ok(!page.includes("canOperate(role)"), "staré tlačidlo pre každého zamestnanca (RLS ho aj tak odmietla) je preč");
  assert.ok(read("app/vozidla/VehicleDetailView.tsx").includes('const canEditVehicle = teamPermissions.can("vehicles.edit");'));
});

check("tím: editor iba pre owner/admin pri aktívnom zamestnancovi (nie sebe), zápis iba cez RPC", () => {
  const settings = read("app/nastavenia/page.tsx");
  assert.ok(settings.includes('(myRole === "owner" || myRole === "admin") &&\n                        member.role === "employee" &&'));
  assert.ok(settings.includes("member.user_id !== userId"));
  const editor = read("app/components/team/MemberPermissionsEditor.tsx");
  assert.ok(editor.includes("setMemberPermissions(memberId, [...selected])"));
  assert.ok(!/from\("company_member_permissions"\)/.test(editor + read("lib/team-permissions-client.ts")), "žiadny priamy zápis do tabuľky");
  assert.ok(read("lib/team-permissions-client.ts").includes('supabase.rpc("esblu_set_member_permissions"'));
});

console.log(`\nteam-permissions-ui: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
