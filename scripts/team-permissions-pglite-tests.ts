// =============================================================================
// Granulárne oprávnenia členov tímu — SKUTOČNÝ PostgreSQL (PGlite).
//
// Čistý replay VŠETKÝCH migrácií (bez auto-grantov, ako produkcia od
// 2026-10-30), potom matica A–N zo zadania nad reálnymi RLS politikami,
// RPC a triggermi z 20261023100000_team_granular_permissions.sql.
// Nikdy Supabase / staging / produkcia.
//
//   npm run test:team-permissions-db
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { TEAM_PERMISSION_REGISTRY, can, delegablePermissionsFor, PERMISSION_PRESETS } from "../lib/team-permissions.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MIGRATIONS = "supabase/migrations";
const REPLAY_ORDER_OVERRIDES: Array<[string, string]> = [
  ["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],
  ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"],
];
function replayOrder(files: string[]): string[] {
  let out = [...files].sort();
  for (const [file, before] of REPLAY_ORDER_OVERRIDES) {
    out = out.filter((f) => f !== file);
    out.splice(out.indexOf(before), 0, file);
  }
  return out;
}

type Row = Record<string, unknown>;
const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}

await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
for (const f of replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")))) {
  await db.exec(read(`${MIGRATIONS}/${f}`));
}

// ----------------------------------------------------------------------------- fixtures
const U = {
  ownerA: "b1000000-0000-4000-8000-0000000000a1",
  adminA: "b1000000-0000-4000-8000-0000000000a2",
  accountantA: "b1000000-0000-4000-8000-0000000000a3",
  employeeA: "b1000000-0000-4000-8000-0000000000a4",
  employee2A: "b1000000-0000-4000-8000-0000000000a5",
  ownerB: "b1000000-0000-4000-8000-0000000000b1",
  multi: "b1000000-0000-4000-8000-0000000000c1", // employee v A aj v B
};
const C = { a: "d1000000-0000-4000-8000-00000000000a", b: "d1000000-0000-4000-8000-00000000000b" };
const S = {
  ownerA: "e1000000-0000-4000-8000-0000000000a1", adminA: "e1000000-0000-4000-8000-0000000000a2",
  accountantA: "e1000000-0000-4000-8000-0000000000a3", employeeA: "e1000000-0000-4000-8000-0000000000a4",
  employee2A: "e1000000-0000-4000-8000-0000000000a5", ownerB: "e1000000-0000-4000-8000-0000000000b1",
  multiA: "e1000000-0000-4000-8000-0000000000c1", multiB: "e1000000-0000-4000-8000-0000000000c2",
};
const R = {
  invItemA: "f1000000-0000-4000-8000-0000000000a1", invItemB: "f1000000-0000-4000-8000-0000000000b1",
  vehA: "f1000000-0000-4000-8000-0000000000a2", machA: "f1000000-0000-4000-8000-0000000000a3",
};

await db.exec(`
  insert into auth.users (id, email) values
    ('${U.ownerA}', 'oa@example.invalid'), ('${U.adminA}', 'ada@example.invalid'), ('${U.accountantA}', 'aca@example.invalid'),
    ('${U.employeeA}', 'ea@example.invalid'), ('${U.employee2A}', 'e2a@example.invalid'), ('${U.ownerB}', 'ob@example.invalid'),
    ('${U.multi}', 'm@example.invalid');
  insert into auth.sessions (id, user_id) values
    ('${S.ownerA}', '${U.ownerA}'), ('${S.adminA}', '${U.adminA}'), ('${S.accountantA}', '${U.accountantA}'),
    ('${S.employeeA}', '${U.employeeA}'), ('${S.employee2A}', '${U.employee2A}'), ('${S.ownerB}', '${U.ownerB}'),
    ('${S.multiA}', '${U.multi}'), ('${S.multiB}', '${U.multi}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.ownerA}', 'Firma A'), ('${C.b}', '${U.ownerB}', 'Firma B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.ownerA}', 'owner', 'active', '{}'),
    ('${C.a}', '${U.adminA}', 'admin', 'active', '{}'),
    ('${C.a}', '${U.accountantA}', 'accountant', 'active', '{}'),
    ('${C.a}', '${U.employeeA}', 'employee', 'active', '{}'),
    ('${C.a}', '${U.employee2A}', 'employee', 'active', '{}'),
    ('${C.a}', '${U.multi}', 'employee', 'active', '{}'),
    ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${C.b}', '${U.multi}', 'employee', 'active', '{}');
  insert into public.session_active_company (session_id, user_id, company_id) values
    ('${S.multiA}', '${U.multi}', '${C.a}'), ('${S.multiB}', '${U.multi}', '${C.b}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select co, d.version, own, 'company_dpa_gate'
    from (values ('${C.a}'::uuid, '${U.ownerA}'::uuid), ('${C.b}'::uuid, '${U.ownerB}'::uuid)) v(co, own),
         (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period)
    select co, k, 'manual', 'active', 100, 'total'
    from unnest(array['${C.a}', '${C.b}']::uuid[]) co, unnest(array['vehicles', 'machines', 'inventory']) k;
  insert into public.vehicles (id, spz, user_id, company_id) values ('${R.vehA}', 'A-1', '${U.ownerA}', '${C.a}');
  insert into public.machines (id, name, user_id, company_id) values ('${R.machA}', 'Bager A', '${U.ownerA}', '${C.a}');
  insert into public.inventory_items (id, name, quantity, unit, user_id, company_id) values
    ('${R.invItemA}', 'Kábel A', 10, 'm', '${U.ownerA}', '${C.a}'),
    ('${R.invItemB}', 'Kábel B', 10, 'm', '${U.ownerB}', '${C.b}');
  set session_replication_role = origin;
`);

// ----------------------------------------------------------------------------- Data API simulácia
type Who = { role: "authenticated" | "service_role" | "anon"; uid?: string; session?: string };
const as = (uid: string, session: string): Who => ({ role: "authenticated", uid, session });
const ownerA = as(U.ownerA, S.ownerA), adminA = as(U.adminA, S.adminA), accountantA = as(U.accountantA, S.accountantA),
  employeeA = as(U.employeeA, S.employeeA), employee2A = as(U.employee2A, S.employee2A), ownerB = as(U.ownerB, S.ownerB),
  multiInA = as(U.multi, S.multiA), multiInB = as(U.multi, S.multiB);

type Outcome = { layer: "ok" | "privilege" | "rls" | "error"; rows: number; message: string; data: Row[] };
async function run(who: Who, sql: string, params: unknown[] = [], commit = false): Promise<Outcome> {
  await db.exec("begin");
  let ok = false;
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<Row>(sql, params);
    ok = true;
    const affected = (r as { affectedRows?: number }).affectedRows;
    return { layer: "ok", rows: r.rows.length || affected || 0, message: "", data: r.rows };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? String(error);
    if (e.code === "42501" && /permission denied/.test(message)) return { layer: "privilege", rows: 0, message, data: [] };
    if (e.code === "42501" && /row-level security/.test(message)) return { layer: "rls", rows: 0, message, data: [] };
    return { layer: "error", rows: 0, message: `${e.code ?? "?"} ${message}`, data: [] };
  } finally {
    await db.exec(commit && ok ? "commit" : "rollback");
  }
}
const attempt = (who: Who, sql: string, params: unknown[] = []) => run(who, sql, params, false);
const commitAs = (who: Who, sql: string, params: unknown[] = []) => run(who, sql, params, true);
async function expect(who: Who, sql: string, layer: Outcome["layer"], rows?: number, params: unknown[] = []) {
  const o = await attempt(who, sql, params);
  assert.equal(o.layer, layer, `${who.uid?.slice(-2) ?? who.role}: ${sql} → ${o.layer} ${o.message}`);
  if (rows !== undefined) assert.equal(o.rows, rows, `${sql} → ${o.rows} riadkov, čakalo sa ${rows}`);
  return o;
}
const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const memberId = async (company: string, user: string) =>
  (await su<{ id: string }>("select id from public.company_members where company_id = $1 and user_id = $2", [company, user]))[0].id;
const myPerms = async (who: Who) => ((await attempt(who, "select public.esblu_my_permissions() p")).data[0]?.p as string[]) ?? [];
const has = async (who: Who, p: string) => (await attempt(who, "select public.esblu_my_has_permission($1) h", [p])).data[0]?.h === true;
async function setPerms(who: Who, member: string, perms: string[]) {
  const o = await commitAs(who, "select public.esblu_set_member_permissions($1, $2) r", [member, perms]);
  if (o.layer !== "ok") throw new Error(o.message);
  return o.data[0].r as string[];
}
async function setPermsFails(who: Who, member: string, perms: string[], pattern: RegExp) {
  const o = await attempt(who, "select public.esblu_set_member_permissions($1, $2) r", [member, perms]);
  assert.notEqual(o.layer, "ok", "očakávané odmietnutie");
  assert.match(o.message, pattern);
}
const BASELINE = ["inventory.view", "machines.view", "vehicles.manage_service", "vehicles.view"];
const insMachine = (uid: string, company: string) =>
  `insert into public.machines (name, user_id, company_id) values ('Nový stroj', '${uid}', '${company}') returning id`;

const MEMBER = {
  employeeA: await memberId(C.a, U.employeeA),
  employee2A: await memberId(C.a, U.employee2A),
  multiA: await memberId(C.a, U.multi),
  multiB: await memberId(C.b, U.multi),
  ownerA: await memberId(C.a, U.ownerA),
  adminA: await memberId(C.a, U.adminA),
  accountantA: await memberId(C.a, U.accountantA),
};

// ----------------------------------------------------------------------------- registry
await check("registry: TS zrkadlo == DB esblu_permission_registry()", async () => {
  const dbReg = await su<{ permission: string; area: string; delegable: boolean; admin_may_grant: boolean; employee_baseline: boolean }>(
    "select * from public.esblu_permission_registry() order by permission");
  const ts = [...TEAM_PERMISSION_REGISTRY].sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(
    dbReg.map((r) => [r.permission, r.area, r.delegable, r.admin_may_grant, r.employee_baseline]),
    ts.map((d) => [d.key, d.area, d.delegable, d.adminMayGrant, d.employeeBaseline])
  );
  for (const preset of PERMISSION_PRESETS)
    for (const p of preset.permissions) assert.ok(ts.find((d) => d.key === p)?.delegable, `preset ${preset.key}: ${p} nie je delegovateľné`);
  assert.equal(can("billing.manage", "owner"), false, "neznáme oprávnenie = false aj pre ownera");
  assert.equal(delegablePermissionsFor("employee").length, 0);
  assert.equal(delegablePermissionsFor("accountant").length, 0);
});

await check("registry: nedelegovateľné / neznáme oprávnenie sa do tabuľky nedá zapísať ani priamo (CHECK)", async () => {
  await assert.rejects(su(`insert into public.company_member_permissions (member_id, company_id, permission) values ($1, $2, 'vehicles.view')`, [MEMBER.employeeA, C.a]), /company_member_permissions_delegable/);
  await assert.rejects(su(`insert into public.company_member_permissions (member_id, company_id, permission) values ($1, $2, 'billing.manage')`, [MEMBER.employeeA, C.a]), /company_member_permissions_delegable/);
});

// ----------------------------------------------------------------------------- A
await check("A: employee default — čítanie podľa dnešného základu, žiadne nové zápisy", async () => {
  assert.deepEqual([...(await myPerms(employeeA))].sort(), BASELINE);
  await expect(employeeA, "select id from public.vehicles", "ok", 1);
  await expect(employeeA, "select id from public.machines", "ok", 1);
  await expect(employeeA, "select id from public.inventory_items", "ok", 1);
  await expect(employeeA, insMachine(U.employeeA, C.a), "rls");
  await expect(employeeA, `insert into public.vehicles (spz, user_id, company_id) values ('E-1', '${U.employeeA}', '${C.a}')`, "rls");
  await expect(employeeA, `insert into public.inventory_items (name, user_id, company_id) values ('X', '${U.employeeA}', '${C.a}')`, "rls");
  await expect(employeeA, `update public.inventory_items set quantity = 5 where id = '${R.invItemA}'`, "ok", 0);
  await expect(employeeA, `update public.machines set name = 'Y' where id = '${R.machA}'`, "ok", 0);
  await expect(employeeA, `insert into public.machine_services (machine_id, title, user_id) values ('${R.machA}', 'S', '${U.employeeA}')`, "rls");
  // dnešný základ ostáva: servis vozidla smie zapísať aj zamestnanec
  await expect(employeeA, `insert into public.vehicle_services (vehicle_id, user_id, company_id) values ('${R.vehA}', '${U.employeeA}', '${C.a}') returning id`, "ok", 1);
  assert.equal(await has(employeeA, "machines.create"), false);
  assert.equal(await has(employeeA, "nonexistent.permission"), false, "neznáme = false");
});

// ----------------------------------------------------------------------------- B, C
await check("B: owner udelí machines.create → zamestnanec vytvorí stroj (iba v aktívnej firme)", async () => {
  assert.deepEqual(await setPerms(ownerA, MEMBER.employeeA, ["machines.create"]), ["machines.create"]);
  assert.ok((await myPerms(employeeA)).includes("machines.create"));
  await expect(employeeA, insMachine(U.employeeA, C.a), "ok", 1);
  await expect(employeeA, insMachine(U.employeeA, C.b), "rls");
  await expect(employeeA, `update public.machines set name = 'Y' where id = '${R.machA}'`, "ok", 0); // edit nemá
});

await check("C: owner odoberie machines.create → zápis DENY (UI zdroj esblu_my_permissions bez neho)", async () => {
  assert.deepEqual(await setPerms(ownerA, MEMBER.employeeA, []), []);
  assert.ok(!(await myPerms(employeeA)).includes("machines.create"));
  await expect(employeeA, insMachine(U.employeeA, C.a), "rls");
});

// ----------------------------------------------------------------------------- D
await check("D: sklad — adjust_stock smie iba množstvo, edit všetko, create nové položky", async () => {
  await setPerms(ownerA, MEMBER.employeeA, ["inventory.adjust_stock"]);
  await expect(employeeA, `update public.inventory_items set quantity = 7 where id = '${R.invItemA}'`, "ok", 1);
  const nameOnly = await attempt(employeeA, `update public.inventory_items set name = 'Iný' where id = '${R.invItemA}'`);
  assert.match(nameOnly.message, /ESBLU_PERMISSION_DENIED:inventory\.edit/);
  await expect(employeeA, `insert into public.inventory_items (name, user_id, company_id) values ('X', '${U.employeeA}', '${C.a}')`, "rls");
  await setPerms(ownerA, MEMBER.employeeA, ["inventory.edit"]);
  await expect(employeeA, `update public.inventory_items set name = 'Iný', quantity = 3 where id = '${R.invItemA}'`, "ok", 1);
  await setPerms(ownerA, MEMBER.employeeA, ["inventory.create"]);
  await expect(employeeA, `insert into public.inventory_items (name, user_id, company_id) values ('X', '${U.employeeA}', '${C.a}') returning id`, "ok", 1);
  const q = await attempt(employeeA, `update public.inventory_items set quantity = 1 where id = '${R.invItemA}'`);
  assert.equal(q.rows, 0, "create bez adjust/edit nemení existujúce položky");
  await setPerms(ownerA, MEMBER.employeeA, []);
});

// ----------------------------------------------------------------------------- E
await check("E: vozidlá a servis strojov — create / edit / manage_service podľa oprávnení", async () => {
  await setPerms(ownerA, MEMBER.employeeA, ["vehicles.create", "vehicles.edit", "machines.manage_service"]);
  await expect(employeeA, `insert into public.vehicles (spz, user_id, company_id) values ('E-1', '${U.employeeA}', '${C.a}') returning id`, "ok", 1);
  await expect(employeeA, `update public.vehicles set znacka = 'X' where id = '${R.vehA}'`, "ok", 1);
  await expect(employeeA, `insert into public.vehicle_vignettes (vehicle_id, country_code, valid_until, company_id) values ('${R.vehA}', 'SK', '2027-01-01', '${C.a}') returning id`, "ok", 1);
  await expect(employeeA, `insert into public.machine_services (machine_id, title, user_id) values ('${R.machA}', 'S', '${U.employeeA}') returning id`, "ok", 1);
  await setPerms(ownerA, MEMBER.employeeA, []);
  await expect(employeeA, `update public.vehicles set znacka = 'Z' where id = '${R.vehA}'`, "ok", 0);
  await expect(employeeA, `insert into public.machine_services (machine_id, title, user_id) values ('${R.machA}', 'S', '${U.employeeA}')`, "rls");
});

await check("E2: storage upload fotiek strojov/skladu podľa edit oprávnenia", async () => {
  const up = async (who: Who, bucket: string) => (await attempt(who, "select public.esblu_media_role_allows($1, 'upload') a", [bucket])).data[0]?.a;
  assert.equal(await up(employeeA, "machine-photos"), false);
  assert.equal(await up(employeeA, "vehicle-photos"), true, "základ: fotky vozidiel");
  await setPerms(ownerA, MEMBER.employeeA, ["machines.edit"]);
  assert.equal(await up(employeeA, "machine-photos"), true);
  assert.equal(await up(employeeA, "inventory-photos"), false);
  await setPerms(ownerA, MEMBER.employeeA, []);
  assert.equal(await up(ownerA, "inventory-photos"), true);
  assert.equal(await up(accountantA, "machine-photos"), false);
});

// ----------------------------------------------------------------------------- F
await check("F: multi-company — oprávnenie v A neplatí v B (aj pre toho istého používateľa)", async () => {
  await setPerms(ownerA, MEMBER.multiA, ["inventory.edit"]);
  assert.equal(await has(multiInA, "inventory.edit"), true);
  assert.equal(await has(multiInB, "inventory.edit"), false);
  await expect(multiInA, `update public.inventory_items set name = 'A2' where id = '${R.invItemA}'`, "ok", 1);
  await expect(multiInB, `update public.inventory_items set name = 'B2' where id = '${R.invItemB}'`, "ok", 0);
  await expect(multiInA, `update public.inventory_items set name = 'B3' where id = '${R.invItemB}'`, "ok", 0); // cudzia firma
  await setPerms(ownerA, MEMBER.multiA, []);
});

// ----------------------------------------------------------------------------- G, H
await check("G: self-escalation — zamestnanec si nič nepridá (RPC, priamy zápis, rola)", async () => {
  await setPermsFails(employeeA, MEMBER.employeeA, ["machines.create"], /ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN/);
  await expect(employeeA, `insert into public.company_member_permissions (member_id, company_id, permission) values ('${MEMBER.employeeA}', '${C.a}', 'machines.create')`, "privilege");
  await expect(employeeA, "select * from public.company_member_permissions", "privilege");
  await expect(employeeA, `update public.company_members set role = 'admin' where user_id = '${U.employeeA}'`, "privilege");
  await expect(employeeA, `update public.company_members set permissions = '{"finance":{"manage":true}}' where user_id = '${U.employeeA}'`, "privilege");
  await setPermsFails(adminA, MEMBER.adminA, ["machines.create"], /ESBLU_CANNOT_EDIT_OWN_PERMISSIONS/);
  await setPermsFails(ownerA, MEMBER.ownerA, ["machines.create"], /ESBLU_CANNOT_EDIT_OWN_PERMISSIONS/);
  assert.equal(await has(employeeA, "machines.create"), false);
});

await check("H: zamestnanec ani účtovník nespravujú oprávnenia (ani zoznam)", async () => {
  await setPermsFails(employeeA, MEMBER.employee2A, ["machines.create"], /ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN/);
  await setPermsFails(accountantA, MEMBER.employee2A, ["machines.create"], /ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN/);
  for (const who of [employeeA, accountantA]) {
    const o = await attempt(who, "select * from public.esblu_list_company_member_permissions()");
    assert.match(o.message, /ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN/);
  }
  await expect(as(U.employeeA, S.employeeA), "select * from public.company_member_permission_events", "privilege");
});

// ----------------------------------------------------------------------------- I, J
await check("I: admin udelí prevádzkové oprávnenie zamestnancovi → platí; audit zapíše kto/komu/čo", async () => {
  assert.deepEqual(await setPerms(adminA, MEMBER.employee2A, ["machines.create", "inventory.adjust_stock"]), ["inventory.adjust_stock", "machines.create"]);
  await expect(employee2A, insMachine(U.employee2A, C.a), "ok", 1);
  const list = await attempt(adminA, "select member_id, permission from public.esblu_list_company_member_permissions()");
  assert.deepEqual(list.data.filter((r) => r.member_id === MEMBER.employee2A).map((r) => r.permission), ["inventory.adjust_stock", "machines.create"]);
  const ev = await su<{ actor_user_id: string; target_user_id: string; company_id: string; permission: string; granted: boolean }>(
    "select actor_user_id, target_user_id, company_id, permission, granted from public.company_member_permission_events where member_id = $1 order by permission", [MEMBER.employee2A]);
  assert.deepEqual(ev.map((e) => [e.actor_user_id, e.target_user_id, e.company_id, e.permission, e.granted]),
    [[U.adminA, U.employee2A, C.a, "inventory.adjust_stock", true], [U.adminA, U.employee2A, C.a, "machines.create", true]]);
  await setPerms(adminA, MEMBER.employee2A, []);
});

await check("J: admin nesmie mimo registra — nedelegovateľné, neznáme, owner/admin/účtovník, cudzia firma", async () => {
  await setPermsFails(adminA, MEMBER.employee2A, ["vehicles.view"], /ESBLU_PERMISSION_NOT_DELEGABLE/);
  await setPermsFails(adminA, MEMBER.employee2A, ["billing.manage"], /ESBLU_UNKNOWN_PERMISSION/);
  await setPermsFails(adminA, MEMBER.employee2A, ["company.delete"], /ESBLU_UNKNOWN_PERMISSION/);
  await setPermsFails(adminA, MEMBER.ownerA, ["machines.create"], /ESBLU_PERMISSIONS_EMPLOYEE_ONLY/);
  await setPermsFails(adminA, MEMBER.accountantA, ["machines.create"], /ESBLU_PERMISSIONS_EMPLOYEE_ONLY/);
  await setPermsFails(ownerA, MEMBER.adminA, ["machines.create"], /ESBLU_PERMISSIONS_EMPLOYEE_ONLY/);
  await setPermsFails(adminA, MEMBER.multiB, ["machines.create"], /ESBLU_MEMBER_NOT_FOUND/);
  // registry V1 nemá owner-only oprávnenie; každé delegovateľné smie admin — overené explicitne
  assert.ok(TEAM_PERMISSION_REGISTRY.filter((d) => d.delegable).every((d) => d.adminMayGrant));
});

// ----------------------------------------------------------------------------- K, L, M, N
await check("K: účtovník bez zmeny — žiadne prevádzkové oprávnenia ani dáta", async () => {
  assert.deepEqual(await myPerms(accountantA), []);
  await expect(accountantA, "select id from public.vehicles", "ok", 0);
  await expect(accountantA, insMachine(U.accountantA, C.a), "rls");
});

await check("L: owner/admin bez regresie; billing nie je v registri a ostáva owner-only mimo tohto modelu", async () => {
  for (const who of [ownerA, adminA]) {
    assert.deepEqual([...(await myPerms(who))].sort(), [...TEAM_PERMISSION_REGISTRY.map((d) => d.key)].sort());
    await expect(who, insMachine(who.uid!, C.a), "ok", 1);
    await expect(who, `update public.inventory_items set name = 'Owner/Admin' where id = '${R.invItemA}'`, "ok", 1);
  }
  assert.ok(!TEAM_PERMISSION_REGISTRY.some((d) => /billing|subscription|owner|company|role|permission/.test(d.key)));
});

await check("M: presne jeden owner; zmena roly/odchod zruší delegované oprávnenia", async () => {
  await setPerms(ownerA, MEMBER.employee2A, ["machines.create"]);
  await su("update public.company_members set role = 'admin' where id = $1", [MEMBER.employee2A]);
  await su("update public.company_members set role = 'employee' where id = $1", [MEMBER.employee2A]);
  assert.equal(await has(employee2A, "machines.create"), false, "po zmene roly sa práva nevrátia");
  const owners = await su<{ n: number }>("select count(*)::int n from public.company_members where role = 'owner' and status = 'active' group by company_id");
  assert.deepEqual(owners.map((o) => o.n), [1, 1]);
});

await check("N: cudzia firma — owner B nevidí ani nemení oprávnenia firmy A; zamestnanec A nevidí B", async () => {
  await setPermsFails(ownerB, MEMBER.employeeA, ["machines.create"], /ESBLU_MEMBER_NOT_FOUND/);
  const list = await attempt(ownerB, "select member_id from public.esblu_list_company_member_permissions()");
  assert.equal(list.layer, "ok");
  assert.ok(list.data.every((r) => ![MEMBER.employeeA, MEMBER.employee2A, MEMBER.multiA].includes(r.member_id as string)));
  await expect(employeeA, `select id from public.inventory_items where id = '${R.invItemB}'`, "ok", 0);
  await expect({ role: "anon" }, "select public.esblu_my_permissions()", "privilege");
  await expect({ role: "anon" }, "select * from public.company_member_permissions", "privilege");
});

console.log(`\nteam-permissions-db: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
