// =============================================================================
// E-Faktúra — stav príjmu + aktivácia FS kódom (server + UI invarianty), offline.
// PGlite (všetky migrácie, RLS) + fake eFaktura.sk sandbox. npm run test:einvoice-reception
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPartnerHarness } from "./einvoice-partner-harness.ts";
import { createFakeSandbox } from "./einvoice-partner-fake-sandbox.ts";
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import { enrollReception, loadReception, parseEnrollBody } from "../lib/einvoice/ui/reception-server.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  ✗ ${label}\n    ${error instanceof Error ? error.stack?.split("\n").slice(0, 3).join("\n    ") : error}`);
  }
}
// Nič z E-Faktúry nesmie logovať (najmä nie overovací kód).
const logged: string[] = [];
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => {
    logged.push(a.map(String).join(" "));
    if (m === "log") orig(...a);
  };
}

const CODE_OK = "a1b2c3d4e5";
const CODE_BAD = "000000000000dead";
const CODE_SENDONLY = "000000000000beef";

await check("telo: presne {verification_code, confirm_enroll:true}; formát hex; kód sa nevráti v chybe", () => {
  assert.deepEqual(parseEnrollBody({ verification_code: "a1b2", confirm_enroll: true }), { ok: true, code: "a1b2" });
  assert.deepEqual(parseEnrollBody({ verification_code: "a1 b2", confirm_enroll: true }), { ok: true, code: "a1b2" });
  assert.equal((parseEnrollBody({ verification_code: "a1b2", confirm_enroll: true, company_id: "x" }) as { code: string }).code, "INVALID_BODY");
  assert.equal((parseEnrollBody({ verification_code: "a1b2", confirm_enroll: "true" }) as { code: string }).code, "CONFIRMATION_REQUIRED");
  assert.equal((parseEnrollBody({ verification_code: "zz-not-hex", confirm_enroll: true }) as { code: string }).code, "INVALID_CODE_FORMAT");
  assert.equal((parseEnrollBody([]) as { code: string }).code, "INVALID_BODY");
  assert.ok(!JSON.stringify(parseEnrollBody({ verification_code: "SECRETXYZ", confirm_enroll: true })).includes("SECRETXYZ"));
});

const h = await createPartnerHarness();
const CA = "a2000000-0000-4000-8000-0000000000aa";
const CB = "b2000000-0000-4000-8000-0000000000bb";
const U = {
  owner: "12000000-0000-4000-8000-000000000001",
  adminFin: "12000000-0000-4000-8000-000000000002",
  admin: "12000000-0000-4000-8000-000000000003",
  employee: "12000000-0000-4000-8000-000000000004",
  accountant: "12000000-0000-4000-8000-000000000005",
  otherOwner: "22000000-0000-4000-8000-000000000001",
};
await h.exec(`
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into public.companies (id, name) values ('${CA}', 'A'), ('${CB}', 'B');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CA}', '${U.owner}', 'owner', '{}'),
    ('${CA}', '${U.adminFin}', 'admin', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.admin}', 'admin', '{}'),
    ('${CA}', '${U.employee}', 'employee', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.accountant}', 'accountant', '{}'),
    ('${CB}', '${U.otherOwner}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code)
    values ('${CA}', 'Recepcia A s.r.o.', '35759500', '2021111111', 'SK2021111111', 'Ulica 1', 'Bratislava', '81101', 'SK'),
           ('${CB}', 'Recepcia B s.r.o.', '36421928', '2022222220', 'SK2022222220', 'Ulica 2', 'Košice', '04001', 'SK');
`);

const fake = createFakeSandbox();
const provider = new EfakturaSkProvider({ apiKey: "efk_pk_test_" + "r".repeat(24), environment: "sandbox", fetchImpl: (u, i) => fake.fetch(String(u), i ?? {}) });
const access = (over: Partial<{ entitlementActive: boolean; rolloutEnabled: boolean; providerConfigured: boolean }> = {}) => async (db: SupabaseClient) => {
  const [v, m] = await Promise.all([db.rpc("esblu_my_finance_view"), db.rpc("esblu_my_finance_manage")]);
  if (v.error || m.error) return null;
  return { financeView: v.data === true, access: { financeManage: m.data === true, entitlementActive: true, providerConfigured: true, rolloutEnabled: true, ...over } };
};
let providerCalls = 0;
const deps = (uid: string, over = {}) => ({
  db: h.userDb(uid),
  access: access(over),
  environment: "sandbox" as const,
  onboarding: () => {
    providerCalls++;
    return { store: h.onboarding, provider, environment: "sandbox" as const };
  },
});
const orgRow = async (c: string) => (await h.sql<Record<string, unknown>>("select * from public.einvoice_organizations where company_id = $1", [c])).rows[0] ?? null;
const body = (code: string) => ({ verification_code: code, confirm_enroll: true });

await check("employee (aj s finance flagmi), admin bez financií → 403, poskytovateľ sa nevolá, nič sa nezapíše", async () => {
  for (const uid of [U.employee, U.admin]) {
    const before = providerCalls;
    const r = await enrollReception(deps(uid), body(CODE_OK));
    assert.equal(r.status, 403, uid);
    assert.equal(providerCalls, before);
    const g = await loadReception(deps(uid));
    assert.equal(g.status, 403, "GET stav: employee/admin bez financií nevidia");
  }
  assert.equal(await orgRow(CA), null);
  assert.equal(fake.requests.length, 0);
});
await check("bez nároku / rolloutu / poskytovateľa → 403 / 503 bez volania poskytovateľa", async () => {
  assert.equal((await enrollReception(deps(U.owner, { entitlementActive: false }), body(CODE_OK))).status, 403);
  assert.equal((await enrollReception(deps(U.owner, { rolloutEnabled: false }), body(CODE_OK))).status, 403);
  assert.equal((await enrollReception(deps(U.owner, { providerConfigured: false }), body(CODE_OK))).status, 503);
  assert.equal(fake.requests.length, 0);
});
await check("neplatné telo → 400 PRED kontrolou oprávnení aj poskytovateľom", async () => {
  const before = providerCalls;
  assert.equal((await enrollReception(deps(U.employee), { verification_code: CODE_OK })).status, 400);
  assert.equal((await enrollReception(deps(U.owner), { verification_code: "xyz!", confirm_enroll: true })).status, 400);
  assert.equal(providerCalls, before);
});
await check("GET pred aktiváciou: owner / admin-fin / accountant vidia not_configured; príjem a odosielanie oddelene", async () => {
  for (const uid of [U.owner, U.adminFin, U.accountant]) {
    const r = await loadReception(deps(uid));
    assert.equal(r.status, 200);
    const b = r.body as { reception: { state: string; receivingActive: boolean; sendingEnabled: boolean } };
    assert.deepEqual(b.reception, { state: "not_configured", receivingActive: false, sendingEnabled: false, errorCode: null });
  }
});
await check("neplatný FS kód (owner) → 422, stav failed, príjem neaktívny; firma IBA z aktívneho členstva", async () => {
  const r = await enrollReception(deps(U.owner), body(CODE_BAD));
  assert.equal(r.status, 422, JSON.stringify(r.body));
  const b = r.body as { code: string; reception: { state: string; receivingActive: boolean } };
  assert.equal(b.code, "EINVOICE_ENROLL_TOKEN_INVALID");
  assert.equal(b.reception.state, "failed");
  assert.equal(b.reception.receivingActive, false);
  assert.equal((await orgRow(CA))?.reception_status, "failed");
  assert.equal(await orgRow(CB), null, "iná firma bez zmeny");
});
await check("platný kód (admin s finance.manage) → 200 ENROLLED, príjem aj odosielanie aktívne", async () => {
  const r = await enrollReception(deps(U.adminFin), body(CODE_OK));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body as { code: string; reception: { state: string; receivingActive: boolean; sendingEnabled: boolean } };
  assert.equal(b.code, "ENROLLED");
  assert.deepEqual([b.reception.state, b.reception.receivingActive, b.reception.sendingEnabled], ["active", true, true]);
  const g = await loadReception(deps(U.accountant));
  assert.equal((g.body as { reception: { state: string } }).reception.state, "active");
});
await check("send_only (iná firma B, vlastný owner) → 200 SEND_ONLY: odosielanie áno, príjem nie; A nevidí B", async () => {
  const r = await enrollReception(deps(U.otherOwner), body(CODE_SENDONLY));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body as { code: string; reception: { state: string; receivingActive: boolean; sendingEnabled: boolean; errorCode: string | null } };
  assert.equal(b.code, "SEND_ONLY");
  assert.deepEqual([b.reception.state, b.reception.receivingActive, b.reception.sendingEnabled, b.reception.errorCode], ["send_only", false, true, "PARTICIPANT_HELD_ELSEWHERE"]);
  const ga = await loadReception(deps(U.owner));
  assert.equal((ga.body as { reception: { state: string } }).reception.state, "active", "A vidí iba svoj stav");
});
await check("overovací kód sa nikde neuloží ani nezaloguje; odpoveď neobsahuje ID poskytovateľa ani participant ID", async () => {
  const dump = JSON.stringify((await h.sql("select * from public.einvoice_organizations")).rows) + JSON.stringify((await h.sql("select * from public.einvoice_webhook_events")).rows);
  for (const c of [CODE_OK, CODE_BAD, CODE_SENDONLY]) {
    assert.ok(!dump.includes(c), "DB");
    assert.ok(!logged.some((l) => l.includes(c)), "log");
  }
  const g = await loadReception(deps(U.owner));
  const s = JSON.stringify(g.body);
  assert.ok(!/9915:|provider_org|providerOrgId|participant/i.test(s), s);
});
await check("UI: panel bez localStorage/console, input type=password + autocomplete off, kód sa po odoslaní maže; render iba pri financeView", () => {
  const ui = read("app/components/einvoice/EinvoiceReceptionPanel.tsx");
  assert.doesNotMatch(ui, /localStorage|sessionStorage|console\./);
  assert.match(ui, /type="password"/);
  assert.match(ui, /autoComplete="off"/);
  assert.match(ui, /setCode\(""\)/);
  assert.match(ui, /res\.status === 401 \|\| res\.status === 403\) return \{ state: "hidden" \}/);
  const page = read("app/nastavenia/page.tsx");
  assert.match(page, /\{financeView && <EinvoiceReceptionPanel \/>\}/);
  for (const f of ["app/api/einvoice/reception/route.ts", "app/api/einvoice/reception/enroll/route.ts", "lib/einvoice/ui/reception-routes.ts", "lib/einvoice/ui/reception-server.ts"]) {
    assert.match(read(f), /^import "server-only";/, f);
    assert.doesNotMatch(read(f), /console\./, f);
  }
  const client = read("lib/einvoice/ui/client.ts");
  assert.match(client, /body: \{ verification_code: verificationCode, confirm_enroll: true \}/);
});
await check("i18n: všetky stavy príjmu majú preklad v sk / en / de", () => {
  for (const lang of ["sk", "en", "de"]) {
    const d = read(`lib/i18n/dictionaries/${lang}.ts`);
    const block = d.slice(d.indexOf("reception: {"), d.indexOf("panel: {", d.indexOf("reception: {")));
    for (const s of ["not_configured", "pending", "active", "send_only", "failed", "deactivated", "legacy"]) assert.ok(block.includes(`${s}:`), `${lang} ${s}`);
  }
});

console.log(`\neinvoice-reception: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
