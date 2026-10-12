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
import { sessionIdFromAccessToken } from "@/lib/request-session";

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
  assert.match(read("lib/active-membership-server.ts"), /rpc\("esblu_active_membership_for_user", \{ p_user_id: userId, p_session_id: sessionId \}\)/);
  assert.match(read("lib/company.ts"), /fetchMyActiveMembership\(supabase, session\.user\.id\)/);
  for (const route of ["app/api/assistant/intent/route.ts", "app/api/assistant/action/execute/route.ts"]) {
    assert.match(read(route), /fetchMyActiveMembership\(supabase, user\.id\)/, route);
  }
  for (const route of ["app/api/account/delete/route.ts", "app/api/account/preflight/route.ts"]) {
    assert.match(read(route), /resolveActiveMembershipForUser\(admin, user\.id, requestSessionId\(req, user\.id\)\)/, route);
    assert.match(read(route), /memberCanManageBilling: false/, `${route}: billing iba owner`);
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
  assert.match(ws, /invalidateCompanyEntitlements\(\);\s*resetActiveMembershipCache\(\);/);
  assert.doesNotMatch(ws, /localStorage|sessionStorage/, "voľba firmy sa neukladá klientsky ako autorizácia");
  assert.match(ws, /await setActiveCompany\(companyId\);\s*rememberCompanyPreference\(await currentUserId\(\), companyId\);\s*resetCompanyScopedClientState\(\);\s*navigateHard\(target\);/);
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

const SESSION_MIGRATION = read("supabase/migrations/20261012150000_session_company_context_and_legal_entity_trial.sql");

await check("per-device: aktívna firma = session_id z JWT; žiadna globálna voľba; preferencia zariadenia iba návrh pre server", () => {
  assert.match(SESSION_MIGRATION, /sac\.session_id = public\.esblu_request_session_id\(\)\s*and sac\.user_id = auth\.uid\(\)/);
  const resolver = SESSION_MIGRATION.slice(SESSION_MIGRATION.indexOf("create or replace function public.esblu_my_active_company_id()"), SESSION_MIGRATION.indexOf("comment on function public.esblu_my_active_company_id()"));
  assert.doesNotMatch(resolver, /user_active_company|limit 1/i);
  assert.match(SESSION_MIGRATION, /ESBLU_SESSION_REQUIRED/);
  assert.match(SESSION_MIGRATION, /auth\.sessions s where s\.id = v_session and s\.user_id = v_uid/);
  const pref = read("lib/company-preference.ts");
  assert.match(pref, /localStorage\.getItem\(KEY_PREFIX \+ userId\)/, "per používateľ");
  assert.match(pref, /try \{[\s\S]*catch/);
  const ws = read("lib/company-workspaces.ts");
  assert.match(ws, /try \{\s*await setActiveCompany\(preferred\);\s*return true;\s*\} catch \{\s*forgetCompanyPreference\(userId\);/, "server overí; neplatná preferencia = výber");
  assert.match(read("app/components/Dashboard.tsx"), /if \(await restorePreferredCompany\(companies\)\) \{\s*resetCompanyScopedClientState\(\);\s*navigateHard\("\/"\);/);
  const rs = read("lib/request-session.ts");
  assert.match(rs, /payload\.sub !== verifiedUserId/);
  // žiadny kód nečíta preferenciu ako autorizáciu
  const readers = SOURCES.filter((f) => /readCompanyPreference\(/.test(read(f))).map((f) => path.relative(".", f).replace(/\\/g, "/")).sort();
  assert.deepEqual(readers, ["lib/company-preference.ts", "lib/company-workspaces.ts"]);
});

await check("request-session: session_id iba z tokenu overeného používateľa; zlý formát / iný sub / starý token = null", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tok = (p: unknown) => `${b64({ alg: "HS256" })}.${b64(p)}.sig`;
  const uid = "a0000000-0000-4000-8000-00000000000a";
  const sid = "51000000-0000-4000-8000-00000000000A";
  assert.equal(sessionIdFromAccessToken(tok({ sub: uid, session_id: sid }), uid), sid.toLowerCase());
  assert.equal(sessionIdFromAccessToken(tok({ sub: "other", session_id: sid }), uid), null);
  assert.equal(sessionIdFromAccessToken(tok({ sub: uid }), uid), null);
  assert.equal(sessionIdFromAccessToken(tok({ sub: uid, session_id: "x' or 1=1" }), uid), null);
  assert.equal(sessionIdFromAccessToken("garbage", uid), null);
});

await check("owner-only-billing: žiadna admin/billing.manage výnimka v app ani v novej migrácii", () => {
  for (const f of ["app/api/billing/manage/route.ts", "app/api/billing/checkout/route.ts"]) assert.doesNotMatch(read(f), /owner alebo admin|admin\+billing\.manage/, f);
  assert.doesNotMatch(SESSION_MIGRATION, /billing\.manage|v_manage/);
});

await check("trial-legal-entity: trial iba serverom po overení subjektu; route = owner + register; žiadny trial z klienta", () => {
  assert.match(SESSION_MIGRATION, /new\.trial_started_at := null;\s*new\.trial_ends_at := null;/);
  assert.match(SESSION_MIGRATION, /trial_claims[\s\S]{0,40}\(\s*claim_key text primary key/);
  assert.doesNotMatch(SESSION_MIGRATION.slice(SESSION_MIGRATION.indexOf("create table if not exists public.trial_claims"), SESSION_MIGRATION.indexOf("comment on table public.trial_claims")), /references public\.companies/, "história prežije zrušenie firmy");
  assert.match(SESSION_MIGRATION, /revoke all on function public\.esblu_record_company_legal_identity\(uuid, text, text, boolean, text\) from public, anon, authenticated;/);
  const route = read("app/api/company/legal-identity/route.ts");
  const handler = read("lib/company-legal-identity/handler.ts");
  assert.match(handler, /membership\.role !== "owner"/);
  assert.match(route, /companyLookupService\.detail\(ico\)/);
  assert.match(handler, /source\.id === "rpo" && source\.status === "VERIFIED"/);
  assert.match(handler, /deps\.recordVerified\(membership\.companyId, country, ico\)/);
  assert.match(route, /esblu_my_active_membership/);
  assert.doesNotMatch(route + handler, /input\.(company_?[iI]d|trial|verified)|body\??\.(company_?[iI]d|trial|verified)/);
  assert.match(read("app/firmy/nova/page.tsx"), /workspaces\.create\.trialNote/);
  for (const [name, d] of [["sk", sk], ["en", en], ["de", de]] as const) {
    const w = (d as unknown as { workspaces: { create: Record<string, string>; errors: Record<string, string> } }).workspaces;
    for (const k of ["icoLabel", "trialNote"]) assert.ok(w.create[k], `${name}.create.${k}`);
    for (const k of ["sessionExpired", "invalidIco", "icoNotFound", "icoTerminated", "registryUnavailable", "identityLocked"]) assert.ok(w.errors[k], `${name}.errors.${k}`);
  }
  assert.equal((sk as unknown as { workspaces: { create: { trialNote: string } } }).workspaces.create.trialNote, "Firmu môžete vytvoriť aj teraz. Skúšobné obdobie sa aktivuje až po overení IČO.");
});

await check("migrácie: 20261012140000 sa nemení; 20261012150000 nič nemaže", () => {
  assert.doesNotMatch(SESSION_MIGRATION, /\bdelete from\b|\btruncate\b|drop table|drop column/i);
  assert.ok(existsSync("supabase/rollback/20261012150000_session_company_context_and_legal_entity_trial_rollback.sql"));
});

const TRIAL_FINAL = read("supabase/migrations/20261012160000_legal_entity_trial_final.sql");

await check("trial-no-provisional-login: žiadny trial viazaný na login / workspace bez overenej identity", () => {
  const ensure = TRIAL_FINAL.slice(TRIAL_FINAL.indexOf("create or replace function public.esblu_ensure_my_owner_company()"));
  const ensureBody = ensure.slice(0, ensure.indexOf("$function$;", ensure.indexOf("as $function$") + 15));
  assert.doesNotMatch(ensureBody, /trial_claims|esblu_grant_company_trial_internal|esblu_claim_key\('user'/);
  assert.match(TRIAL_FINAL, /check \(claim_kind in \('legal_entity', 'legacy_workspace', 'manual_override'\)\)/);
  assert.match(TRIAL_FINAL, /check \(claim_key ~ '\^\(entity\|workspace\|override\):\[0-9a-f\]\{64\}\$'\)/);
  // grant trialu iba v try_claim po overenej identite (+ operátorská výnimka zo 150000)
  const grants = [...TRIAL_FINAL.matchAll(/perform public\.esblu_grant_company_trial_internal/g)].length;
  assert.equal(grants, 1);
  for (const f of SOURCES) assert.doesNotMatch(read(f), /provisional_user|esblu_grant_company_trial_internal|esblu_try_claim_company_trial/, f);
});

await check("company-settings-legal-identity: karta v Nastaveniach pre owner/admin/accountant, CTA podľa stavu, overené IČO zamknuté", () => {
  const page = read("app/nastavenia/page.tsx");
  assert.match(page, /\(myRole === "owner" \|\| myRole === "admin" \|\| myRole === "accountant"\) && <CompanyLegalIdentityCard \/>/);
  const card = read("app/components/workspaces/CompanyLegalIdentityCard.tsx");
  assert.match(card, /const ctaKey = identity\.can_edit \? legalIdentityCtaKey\(identity\) : null;/, "CTA iba owner");
  assert.match(card, /case "missing":\s*return "workspaces\.identity\.cta\.add";/);
  assert.match(card, /case "unverified":\s*case "failed":\s*return "workspaces\.identity\.cta\.retry";/);
  assert.match(card, /default:\s*return null; \/\/ overené = zamknuté/);
  assert.match(card, /resetCompanyScopedClientState\(\); \/\/ nároky sa znova načítajú/);
  assert.doesNotMatch(card, /esblu_record_company_legal_identity|trial_started_at|localStorage/);
  const ws = read("lib/company-workspaces.ts");
  assert.match(ws, /rpc\("esblu_my_company_legal_identity"\)/);
  for (const [name, d] of [["sk", sk], ["en", en], ["de", de]] as const) {
    const id = (d as unknown as { workspaces: { identity: Record<string, Record<string, string> | string> } }).workspaces.identity;
    for (const k of ["missing", "pending", "verified", "failed", "trialUsed"]) assert.ok((id.status as Record<string, string>)[k], `${name}.status.${k}`);
    for (const k of ["add", "verify", "retry"]) assert.ok((id.cta as Record<string, string>)[k], `${name}.cta.${k}`);
    for (const k of ["trial_active", "trial_used", "not_eligible_previous_trial", "pending_legal_identity", "eligible", "manual_override", "legacy_no_trial"]) assert.ok((id.trial as Record<string, string>)[k], `${name}.trial.${k}`);
    for (const k of ["granted", "already_has_trial", "not_eligible_previous_trial", "pending_legal_identity", "legacy_no_trial"]) assert.ok((id.result as Record<string, string>)[k], `${name}.result.${k}`);
    for (const k of ["not_found", "terminated", "unavailable"]) assert.ok((id.errors as Record<string, string>)[k], `${name}.errors.${k}`);
  }
  const skId = (sk as unknown as { workspaces: { identity: { cta: Record<string, string>; footer: string } } }).workspaces.identity;
  assert.deepEqual([skId.cta.add, skId.cta.verify, skId.cta.retry], ["Doplniť IČO", "Overiť firemné údaje", "Skúsiť overenie znova"]);
  assert.match(skId.footer, /^Skúšobné obdobie aktivujeme po overení firemných údajov\./);
});

console.log(`\nmulti-company: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
