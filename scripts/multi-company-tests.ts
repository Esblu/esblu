// =============================================================================
// Multi-company / workspace model — kontraktné testy aplikácie (bez DB).
// DB správanie (RLS, RPC, zrušenie, billing) je v multi-company-pglite-tests.ts.
//   npm run test:multi-company
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { MOBILE_STATIC_ROUTES } from "@/lib/app-routes";
import sk from "@/lib/i18n/dictionaries/sk";
import en from "@/lib/i18n/dictionaries/en";
import de from "@/lib/i18n/dictionaries/de";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${(error as Error)?.stack?.split("\n").slice(0, 3).join("\n       ") ?? error}`);
  }
}
const read = (p: string) => readFileSync(p, "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const SOURCES = [...walk("app"), ...walk("lib"), ...walk("hooks"), ...walk("mobile/app")];
const MIGRATION = read("supabase/migrations/20261012140000_multi_company_workspaces.sql");

await check("active-company: žiadny kód nečíta „moje“ členstvo cez company_members + maybeSingle/limit 1", () => {
  const offenders = SOURCES.filter((f) => {
    const src = read(f);
    return /from\(\s*["']company_members["']\s*\)[\s\S]{0,200}?\.eq\(\s*["']user_id["'][\s\S]{0,120}?\.eq\(\s*["']status["']\s*,\s*["']active["']\s*\)[\s\S]{0,40}?\.maybeSingle\(\)/.test(src);
  }).map((f) => path.relative(".", f));
  assert.deepEqual(offenders, []);
});

await check("active-company: klient aj server berú aktívnu firmu z DB (RPC), nikdy z parametra klienta", () => {
  assert.match(read("lib/active-membership.ts"), /rpc\("esblu_my_active_membership"\)/);
  assert.match(read("lib/active-membership-server.ts"), /rpc\("esblu_active_membership_for_user", \{ p_user_id: userId \}\)/);
  assert.match(read("lib/company.ts"), /fetchMyActiveMembership\(supabase, session\.user\.id\)/);
  for (const route of ["app/api/assistant/intent/route.ts", "app/api/assistant/action/execute/route.ts"]) {
    assert.match(read(route), /fetchMyActiveMembership\(supabase, user\.id\)/, route);
  }
  for (const route of ["app/api/account/delete/route.ts", "app/api/account/preflight/route.ts"]) {
    assert.match(read(route), /resolveActiveMembershipForUser\(admin, user\.id\)/, route);
    assert.doesNotMatch(read(route), /company_id"?\s*:\s*body\./, `${route}: company_id z tela požiadavky`);
  }
});

await check("migrácia: každé „moje členstvo“ (user_id = auth.uid()/v_uid + status active) je zúžené na aktívnu firmu", () => {
  // funkcie s komentárom/explicitnou výnimkou: centrálne rozlíšenie, zoznam / voľba firmy, bootstrap, pozvánka, zrušenie
  const allowed = new Set([
    "esblu_my_active_company_id", "esblu_list_my_companies", "esblu_set_my_active_company", "esblu_create_my_company",
    "esblu_ensure_my_owner_company", "esblu_accept_company_invite", "esblu_my_active_membership",
    "esblu_can_manage_company_logo_object", "esblu_user_global_cleanup",
  ]);
  const fnRe = /create or replace function public\.([a-z0-9_]+)\s*\(([\s\S]*?)\$function\$;/gi;
  const bad: string[] = [];
  for (const m of MIGRATION.matchAll(fnRe)) {
    const [name, body] = [m[1], m[2]];
    if (allowed.has(name)) continue;
    const re = /\b(\w+)\.user_id\s*=\s*(auth\.uid\(\)|v_uid|authenticated_user_id)(?!\w)(?:(?!;|\bfrom\b)[\s\S]){0,120}?\b\1\.status\s*=\s*'active'/gi;
    for (const hit of body.matchAll(re)) {
      const after = body.slice(hit.index! + hit[0].length, hit.index! + hit[0].length + 120);
      if (!/company_id\s*=\s*public\.esblu_my_active_company_id\(\)/.test(after) && !/company_id\s*=\s*v_company_id/.test(after)) bad.push(name);
    }
  }
  assert.deepEqual(bad, []);
  assert.doesNotMatch(MIGRATION.slice(MIGRATION.indexOf("function public.esblu_my_active_company_id()"), MIGRATION.indexOf("comment on function public.esblu_my_active_company_id()")), /limit 1/i);
  assert.match(MIGRATION, /drop index if exists public\.company_members_one_active_per_user_idx/);
  assert.match(MIGRATION, /company_members_one_owner_per_company_idx[\s\S]{0,120}where role = 'owner' and status = 'active'/);
  assert.match(MIGRATION, /v_manage := v_member\.role = 'owner';/, "billing authority = owner");
  assert.doesNotMatch(MIGRATION, /drop table(?! if exists public\.user_active_company)|truncate|delete from public\.(?!settings|user_legal_acceptances|chat_conversation_members|company_members|user_active_company|chat_message_references|chat_attachments|chat_messages|chat_conversations|document_attachments|document_links|document_review_log|documents|inventory_photos|inventory_items|machine_photos|machine_services|machines|vehicle_photos|vehicle_vignettes|vehicle_services|vehicles|ai_evidence|company_invites|company_dpa_acceptances|companies)/i);
});

await check("switcher: prepnutie cez server, potom reset cache a plný reload (žiadny stale obsah / realtime)", () => {
  const ws = read("lib/company-workspaces.ts");
  assert.match(ws, /rpc\("esblu_set_my_active_company", \{ p_company_id: companyId \}\)/);
  assert.match(ws, /await setActiveCompany\(companyId\);\s*resetCompanyScopedClientState\(\);\s*navigateHard\(target\);/);
  assert.match(ws, /invalidateCompanyEntitlements\(\);\s*resetActiveMembershipCache\(\);/);
  assert.doesNotMatch(ws, /localStorage|sessionStorage/, "voľba firmy sa neukladá klientsky ako autorizácia");
  const sw = read("app/components/workspaces/CompanySwitcher.tsx");
  assert.match(sw, /switchCompanyAndReload\(company\.company_id, "\/"\)/);
  assert.match(sw, /href="\/firmy\/nova"/);
  assert.match(sw, /workspaces\.roles\.\$\{company\.role\}/);
  for (const place of ["app/nastavenia/page.tsx", "app/components/mobile/MobileTabBar.tsx"]) assert.match(read(place), /<CompanySwitcher /, place);
});

await check("startup: 2+ firiem bez platnej aktívnej firmy → výber firmy (nie náhodná firma)", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.match(dash, /if \(!membership\) \{\s*const companies = await listMyCompanies\(\)/);
  assert.match(dash, /if \(pickerCompanies\) \{\s*return <CompanyPicker companies=\{pickerCompanies\} \/>;/);
});

await check("create-second-company: stránka bez novej registrácie (iba názov), mobil + statická routa", () => {
  const page = read("app/firmy/nova/page.tsx");
  assert.match(page, /createMyCompany\(trimmed\)/);
  assert.doesNotMatch(page, /password|signUp|signInWith|email/i);
  assert.ok(MOBILE_STATIC_ROUTES.has("/firmy/nova"));
  assert.ok(existsSync("mobile/app/firmy/nova/page.tsx"));
});

await check("invite-existing-user: prijatie nepresmeruje na registráciu; pri ďalších firmách ponúkne „Prepnúť do firmy“", () => {
  const view = read("app/invite/InviteView.tsx");
  assert.match(view, /const companies = await listMyCompanies\(\)[\s\S]{0,80}if \(companies\.length > 1\)/);
  assert.match(view, /switchCompanyAndReload\(joined\.companyId, "\/"\)/);
  assert.match(view, /workspaces\.invite\.added/);
});

await check("zrušenie: odchod z firmy ≠ zrušenie firmy ≠ globálny login; login iba pri poslednej firme", () => {
  const route = read("app/api/account/delete/route.ts");
  assert.match(route, /if \(body\.scope === "global"\)/);
  assert.match(route, /kind: "global",\s*userId: user\.id,\s*companyId: null,\s*deleteAccount: true/);
  assert.match(route, /const deleteAccount = membershipCount === 1;/);
  assert.match(route, /ESBLU_ACTIVE_COMPANY_REQUIRED/);
  const page = read("app/nastavenia/page.tsx");
  assert.match(page, /deleteMyAccount\(locale, undefined, \{ scope: "global" \}\)/);
  assert.match(page, /if \(!accountDeleted\) \{[\s\S]{0,200}resetCompanyScopedClientState\(\);\s*navigateHard\("\/"\);/);
  assert.match(page, /canDeleteGlobalAccount/);
});

await check("i18n: workspace a zrušenie texty v SK / EN / DE", () => {
  for (const [name, d] of [["sk", sk], ["en", en], ["de", de]] as const) {
    const w = (d as unknown as Record<string, Record<string, unknown>>).workspaces;
    for (const k of ["switcherLabel", "addOwnCompany", "pickTitle", "pickBody"]) assert.ok(typeof w[k] === "string", `${name}.${k}`);
    for (const r of ["owner", "admin", "accountant", "employee"]) assert.ok((w.roles as Record<string, string>)[r], `${name}.roles.${r}`);
    const m = d.settings.deleteModal as Record<string, unknown>;
    for (const k of ["leaveTitle", "leaveBody", "keepsAccountNote", "leaveConfirm", "globalTitle", "globalBody", "globalBlockedOwns", "globalConfirm"]) assert.ok(typeof m[k] === "string", `${name}.${k}`);
    const e = d.settings.errors as Record<string, string>;
    for (const k of ["selectCompanyFirst", "globalDeleteOwnsCompany", "globalDeleteRetainedRecords", "ownerCannotLeave", "accountHasOtherCompanies"]) assert.ok(e[k], `${name}.${k}`);
  }
});

console.log(`\nmulti-company: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
