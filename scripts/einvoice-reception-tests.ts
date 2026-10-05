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
import { classifyAccessError, loadAccessFlags, type RpcLike } from "../lib/einvoice/ui/access.ts";
import { accessFailure, loadAccessResult } from "../lib/einvoice/ui/summary-server.ts";

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
  if (v.error || m.error) return { ok: false as const, kind: "temporary" as const };
  return { ok: true as const, financeView: v.data === true, access: { financeManage: m.data === true, entitlementActive: true, providerConfigured: true, rolloutEnabled: true, ...over } };
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
  assert.match(ui, /res\.status === 401\) return \{ state: "sessionExpired" \}/);
  assert.match(ui, /res\.status === 403\) return \{ state: "forbidden" \}/);
  assert.doesNotMatch(ui, /state: "hidden"/, "403/401 sa neskrývajú ani nemaskujú ako retry");
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


// --- ACCESS_CHECK_FAILED root cause (PGRST303 „JWT issued at future“) ---------------------
const skew = { code: "PGRST303", message: "JWT issued at future" };
const expired = { code: "PGRST303", message: "JWT expired" };
await check("klasifikácia: clock skew ≠ expirovaný JWT ≠ zamietnutie ≠ dočasná chyba", () => {
  assert.equal(classifyAccessError(skew, 401), "clock_skew");
  assert.equal(classifyAccessError(expired, 401), "unauthenticated");
  assert.equal(classifyAccessError({ code: "PGRST301", message: "JWSError" }, 401), "unauthenticated");
  assert.equal(classifyAccessError({ code: "42501", message: "permission denied" }, 403), "forbidden");
  assert.equal(classifyAccessError({ code: "57014", message: "canceling statement" }, 500), "temporary");
  assert.equal(classifyAccessError({ code: "", message: "fetch failed" }, 0), "temporary");
  assert.equal(classifyAccessError({ code: "P0001", message: "ESBLU_NO_ACTIVE_COMPANY" }, 400), "forbidden");
  assert.equal(classifyAccessError({ code: "28000", message: "NOT_AUTHENTICATED" }, 400), "unauthenticated");
});
function rpcScript(script: Record<string, ({ data: unknown; error: unknown; status?: number } | Error)[]>) {
  const calls: string[] = [];
  const rpc: RpcLike = async (fn) => {
    calls.push(fn);
    const q = script[fn] ?? [];
    const next = q.length > 1 ? q.shift()! : q[0] ?? { data: true, error: null };
    if (next instanceof Error) throw next;
    return next as { data: unknown; error: { code: string; message: string } | null; status?: number };
  };
  return { rpc, calls };
}
const ok = (data: unknown) => ({ data, error: null, status: 200 });
const fail = (error: unknown, status: number) => ({ data: null, error, status });
const noSleep = async () => undefined;
await check("cold start / čerstvý JWT: prvý pokus PGRST303 issued-at-future → ohraničené zopakovanie → OK (žiadne 500)", async () => {
  const { rpc, calls } = rpcScript({ esblu_my_finance_view: [fail(skew, 401), ok(true)], esblu_my_finance_manage: [ok(true)], esblu_get_my_company_entitlements: [ok({})] });
  const r = await loadAccessFlags(rpc, { rolloutEnvironment: null, sleep: noSleep });
  assert.ok(r.ok);
  assert.equal(calls.filter((c) => c === "esblu_my_finance_view").length, 2);
});
await check("pretrvávajúci clock skew → temporary (503), max 3 pokusy", async () => {
  const { rpc, calls } = rpcScript({ esblu_my_finance_view: [fail(skew, 401)] });
  const r = await loadAccessFlags(rpc, { rolloutEnvironment: null, sleep: noSleep });
  assert.deepEqual(r, { ok: false, kind: "temporary" });
  assert.equal(calls.filter((c) => c === "esblu_my_finance_view").length, 3);
  assert.deepEqual(accessFailure("temporary"), { ok: false, status: 503, code: "TEMPORARILY_UNAVAILABLE" });
});
await check("expirovaný JWT → 401 SESSION_EXPIRED bez opakovania (nie retry, nie 500)", async () => {
  const { rpc, calls } = rpcScript({ esblu_my_finance_manage: [fail(expired, 401)] });
  const r = await loadAccessFlags(rpc, { rolloutEnvironment: null, sleep: noSleep });
  assert.deepEqual(r, { ok: false, kind: "unauthenticated" });
  assert.ok(calls.length <= 3 && calls.filter((c) => c === "esblu_my_finance_manage").length === 1, "bez opakovania");
  assert.deepEqual(accessFailure("unauthenticated"), { ok: false, status: 401, code: "SESSION_EXPIRED" });
});
await check("dočasná DB chyba (aj pri nárokoch) → 503, NIE „E-Faktúra nie je zapnutá“", async () => {
  const { rpc } = rpcScript({ esblu_get_my_company_entitlements: [fail({ code: "57014", message: "statement timeout" }, 500)] });
  const r = await loadAccessFlags(rpc, { rolloutEnvironment: null, sleep: noSleep });
  assert.deepEqual(r, { ok: false, kind: "temporary" });
});
await check("chyba rollout RPC: dočasná → 503; zamietnutie → fail-closed (rollout false)", async () => {
  const t = await loadAccessFlags(rpcScript({ esblu_einvoice_my_rollout: [fail({ code: "08006", message: "connection failure" }, 503)] }).rpc, { rolloutEnvironment: "sandbox", sleep: noSleep });
  assert.deepEqual(t, { ok: false, kind: "temporary" });
  const f = await loadAccessFlags(rpcScript({ esblu_einvoice_my_rollout: [fail({ code: "42501", message: "denied" }, 403)] }).rpc, { rolloutEnvironment: "sandbox", sleep: noSleep });
  assert.ok(f.ok && f.flags.rollout === false);
});
await check("DB (RLS): chýbajúci membership a nedostatočné financie → financeView false → 403 (nie 500)", async () => {
  const NOMEMBER = "32000000-0000-4000-8000-000000000001";
  await h.exec(`insert into auth.users (id) values ('${NOMEMBER}')`);
  for (const uid of [NOMEMBER, U.employee, U.admin]) {
    const acc = await loadAccessResult(h.userDb(uid), {}, noSleep);
    assert.ok(acc.ok, uid);
    if (acc.ok) assert.equal(acc.financeView, false, uid);
    const r = await loadReception({ db: h.userDb(uid), access: (db) => loadAccessResult(db, {}, noSleep), environment: "sandbox" });
    assert.equal(r.status, 403, uid);
  }
  const owner = await loadReception({ db: h.userDb(U.owner), access: (db) => loadAccessResult(db, {}, noSleep), environment: "sandbox" });
  assert.equal(owner.status, 200);
});
await check("route: 401 / 403 / 503 sa prenášajú do odpovede (reception GET aj enroll)", async () => {
  for (const [kind, status] of [["unauthenticated", 401], ["forbidden", 403], ["temporary", 503]] as const) {
    const d = { db: h.userDb(U.owner), access: async () => ({ ok: false as const, kind }), environment: "sandbox" as const, onboarding: () => null };
    assert.equal((await loadReception(d)).status, status);
    assert.equal((await enrollReception(d, body(CODE_OK))).status, status);
  }
});
await check("klient: 401 → jeden refresh session a jeden nový pokus, potom 401 vráti volajúcemu", () => {
  const c = read("lib/einvoice/ui/client.ts");
  assert.match(c, /first\.status === 401/);
  assert.match(c, /supabase\.auth\.refreshSession\(\)/);
  assert.equal((c.match(/callOnce<T>\(path, locale, init\)/g) ?? []).length, 2, "najviac jeden opakovaný pokus");
});

console.log(`\neinvoice-reception: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
