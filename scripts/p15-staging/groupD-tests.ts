// =============================================================================
// P1-5 skupina D — offline testy runnera výmazu (bez siete, bez stagingu).
//   node --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs scripts/p15-staging/groupD-tests.ts
// Časť C používa skutočný kód appky (lib/account-deletion-deps + orchestrator + storage) a skutočný supabase-js
// proti falošnému serveru za deletionGuardedFetch — dokazuje, že kód appky v behu D nič mimo cieľa neodošle.
// =============================================================================
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { orchestrateAccountDeletion, runCleanupJob } from "../../lib/account-deletion-orchestrator.ts";
import { supabaseDeletionDeps, supabaseTerminationDeps } from "../../lib/account-deletion-deps.ts";
import { parseStorageTargets } from "../../lib/account-deletion-storage.ts";
import { buildTerminationAck } from "../../lib/company-termination-ack.ts";
import { ALLOWED_ORIGIN, Stop } from "./runner-core.ts";
import { DELETE_ALLOWLIST, PROTECTED_ISO, deletionGuardedFetch, newScope, resolveDeletionTarget, type Target } from "./groupD-core.ts";
import { runCleanupOnly, runDeletionTarget, type DDeps } from "./groupD-runner.ts";
import { assertCleanProcessD, D_EXEC_ARGV } from "./groupD-pins.ts";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : e}`); }
}
const T1 = DELETE_ALLOWLIST.t1, T2 = DELETE_ALLOWLIST.t2;
const ORIGINAL = "0c7d3a52-6f0e-4d8a-9a51-1f6f3f2b7e10"; // ľubovoľné UUID mimo P15 (zastupuje 16 pôvodných firiem)
const BILLING = "billing-documents";

// ----------------------------------------------------------------------------- A. allowlist
await test("A1 allowlist: t1/t2/perf → presné páry firma-vlastník-názov-e-mail", () => {
  for (const k of ["t1", "t2", "perf"]) { const t = resolveDeletionTarget(k); assert.equal(t.key, k); assert.ok(t.email.endsWith("@esblu-qa.invalid")); }
});
await test("A2 allowlist: ISO, UUID ISO, pôvodná firma, UUID T1, prázdne, veľké písmená, medzera = STOP", () => {
  for (const bad of ["iso", PROTECTED_ISO.companyId, ORIGINAL, T1.companyId, "", "T1", "t1 ", "perf\n", "__proto__", "constructor", "toString"]) {
    assert.throws(() => resolveDeletionTarget(bad), Stop, bad);
  }
});
await test("A3 F-5: parametre Node a premenné prostredia", () => {
  assertCleanProcessD({ PATH: "x" }, D_EXEC_ARGV);
  assert.throws(() => assertCleanProcessD({}, ["--experimental-strip-types", "--no-warnings"]), Stop);
  assert.throws(() => assertCleanProcessD({}, [...D_EXEC_ARGV, "--require", "x"]), Stop);
  assert.throws(() => assertCleanProcessD({ NODE_OPTIONS: "--require x" }, D_EXEC_ARGV), Stop);
});

// ----------------------------------------------------------------------------- B. sieťová poistka
type Call = { m: string; url: string; body?: string };
function guarded(target: Target | null, jobId: string | null = null) {
  const calls: Call[] = [];
  const scope = newScope(target);
  scope.jobId = jobId;
  const inner = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ m: String(init?.method ?? "GET"), url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f: deletionGuardedFetch(scope, inner), calls, scope };
}
const u = (p: string) => `${ALLOWED_ORIGIN}${p}`;
const J = (o: unknown) => JSON.stringify(o);
async function denied(f: typeof fetch, url: string, init: RequestInit) {
  await assert.rejects(() => f(url, init), Stop);
}
await test("B1 bez aktívneho cieľa a iný projekt → nič sa neodošle", async () => {
  const g = guarded(null);
  await denied(g.f, u("/rest/v1/companies"), { method: "GET" });
  const h = guarded(T1);
  await denied(h.f, "https://fkpgvgvsmbpieduoatrt.supabase.co/rest/v1/companies", { method: "GET" });
  await denied(h.f, "https://cjbdijbbcujvmrzezusd.supabase.co.evil.example/rest/v1/x", { method: "GET" });
  assert.equal(g.calls.length + h.calls.length, 0);
});
await test("B2 RPC: cudzia firma / cudzí používateľ / nepovolená funkcia / iný job → zablokované", async () => {
  const g = guarded(T1, "job-1");
  await denied(g.f, u("/rest/v1/rpc/esblu_company_termination_execute"), { method: "POST", body: J({ p_user_id: T1.ownerId, p_company_id: PROTECTED_ISO.companyId }) });
  await denied(g.f, u("/rest/v1/rpc/esblu_company_termination_execute"), { method: "POST", body: J({ p_user_id: T1.ownerId, p_company_id: ORIGINAL }) });
  await denied(g.f, u("/rest/v1/rpc/esblu_company_termination_execute"), { method: "POST", body: J({ p_user_id: PROTECTED_ISO.ownerId, p_company_id: T1.companyId }) });
  await denied(g.f, u("/rest/v1/rpc/esblu_company_termination_execute"), { method: "POST", body: J({ p_user_id: T1.ownerId }) });
  for (const fn of ["esblu_company_termination_synthetic_purge", "esblu_account_deletion_commit", "esblu_owner_delete_company", "exec_sql"]) {
    await denied(g.f, u(`/rest/v1/rpc/${fn}`), { method: "POST", body: J({ p_user_id: T1.ownerId, p_company_id: T1.companyId }) });
  }
  await denied(g.f, u("/rest/v1/rpc/esblu_cleanup_job_confirm_storage"), { method: "POST", body: J({ p_job_id: "job-2" }) });
  assert.equal(g.calls.length, 0);
  await g.f(u("/rest/v1/rpc/esblu_company_termination_execute"), { method: "POST", body: J({ p_user_id: T1.ownerId, p_company_id: T1.companyId, p_delete_account: true }) });
  await g.f(u("/rest/v1/rpc/esblu_cleanup_job_confirm_storage"), { method: "POST", body: J({ p_job_id: "job-1" }) });
  assert.equal(g.calls.length, 2);
});
await test("B3 Storage: billing-documents, iný bucket, ISO/pôvodná firma, zmiešaná dávka, '..', upload → zablokované", async () => {
  const g = guarded(T1);
  await denied(g.f, u(`/storage/v1/object/${BILLING}`), { method: "DELETE", body: J({ prefixes: [`${T1.companyId}/x.pdf`] }) });
  await denied(g.f, u("/storage/v1/object/ai-evidence-documents"), { method: "DELETE", body: J({ prefixes: [`${T1.companyId}/x.jpg`] }) });
  await denied(g.f, u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: J({ prefixes: [`${PROTECTED_ISO.companyId}/a.xml`] }) });
  await denied(g.f, u("/storage/v1/object/ai-inbox-documents"), { method: "DELETE", body: J({ prefixes: [`${ORIGINAL}/a.pdf`] }) });
  await denied(g.f, u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: J({ prefixes: [`${T1.companyId}/a.xml`, `${PROTECTED_ISO.companyId}/b.xml`] }) });
  await denied(g.f, u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: J({ prefixes: [`${T1.companyId}/../${PROTECTED_ISO.companyId}/b.xml`] }) });
  await denied(g.f, u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: J({ prefixes: [] }) });
  await denied(g.f, u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: new Uint8Array([1]) as unknown as BodyInit });
  await denied(g.f, u(`/storage/v1/object/einvoice-documents/${T1.companyId}/x.xml`), { method: "POST", body: "x" });
  await denied(g.f, u(`/storage/v1/object/einvoice-documents/${PROTECTED_ISO.companyId}/x.xml`), { method: "GET" });
  await denied(g.f, u(`/storage/v1/object/list/einvoice-documents`), { method: "POST", body: J({ prefix: ORIGINAL }) });
  await denied(g.f, u(`/storage/v1/bucket/einvoice-documents`), { method: "DELETE" });
  assert.equal(g.calls.length, 0);
  await g.f(u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: J({ prefixes: [`${T1.companyId}/a.xml`, `${T1.companyId}/orphan/o.xml`] }) });
  await g.f(u(`/storage/v1/object/einvoice-documents/${T1.companyId}/a.xml`), { method: "HEAD" });
  await g.f(u(`/storage/v1/object/list/einvoice-documents`), { method: "POST", body: J({ prefix: PROTECTED_ISO.companyId }) });
  assert.equal(g.calls.length, 3);
});
await test("B4 REST mutácie a Auth: iba job tohto ukončenia a vlastník cieľa", async () => {
  const g = guarded(T1, "11111111-1111-4111-8111-111111111111");
  await denied(g.f, u("/rest/v1/companies?id=eq.x"), { method: "DELETE" });
  await denied(g.f, u("/rest/v1/companies?id=eq.x"), { method: "PATCH", body: "{}" });
  await denied(g.f, u("/rest/v1/account_deletion_cleanup_jobs?id=eq.22222222-2222-4222-8222-222222222222"), { method: "PATCH", body: "{}" });
  await denied(g.f, u("/rest/v1/account_deletion_cleanup_jobs?id=eq.11111111-1111-4111-8111-111111111111&or=(id.not.is.null)"), { method: "PATCH", body: "{}" });
  await denied(g.f, u("/rest/v1/einvoice_mandates"), { method: "POST", body: "{}" });
  await denied(g.f, u(`/auth/v1/admin/users/${PROTECTED_ISO.ownerId}`), { method: "DELETE" });
  await denied(g.f, u("/auth/v1/admin/users/f1500000-0000-4000-8000-000000000105"), { method: "DELETE" });
  await denied(g.f, u("/auth/v1/admin/generate_link"), { method: "POST", body: J({ type: "magiclink", email: "qa-p15-iso@esblu-qa.invalid" }) });
  await denied(g.f, u("/auth/v1/admin/generate_link"), { method: "POST", body: J({ type: "recovery", email: T1.email }) });
  await denied(g.f, u("/auth/v1/admin/users"), { method: "POST", body: "{}" });
  await denied(g.f, u("/functions/v1/anything"), { method: "POST", body: "{}" });
  assert.equal(g.calls.length, 0);
  await g.f(u("/rest/v1/account_deletion_cleanup_jobs?id=eq.11111111-1111-4111-8111-111111111111"), { method: "PATCH", body: "{}" });
  await g.f(u(`/auth/v1/admin/users/${T1.ownerId}`), { method: "DELETE", body: "{}" });
  await g.f(u("/auth/v1/admin/generate_link"), { method: "POST", body: J({ type: "magiclink", email: T1.email }) });
  assert.equal(g.calls.length, 3);
});
await test("B5 simulovaný výpadok: prvé DELETE v buckete vráti 503 bez odoslania, ďalšie prejde", async () => {
  const g = guarded(T2);
  g.scope.injectStorageFailure = "einvoice-documents";
  const r1 = await g.f(u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: J({ prefixes: [`${T2.companyId}/a.xml`] }) });
  assert.equal(r1.status, 503);
  assert.equal(g.calls.length, 0);
  await g.f(u("/storage/v1/object/einvoice-documents"), { method: "DELETE", body: J({ prefixes: [`${T2.companyId}/a.xml`] }) });
  assert.equal(g.calls.length, 1);
});

// ----------------------------------------------------------------------------- C. skutočný kód appky + supabase-js
type FakeState = { objects: Set<string>; users: Set<string>; jobs: Map<string, Record<string, unknown>>; executeTargets: Array<{ bucket: string; path: string }>; executeError?: string; rpcLog: string[] };
function fakeServer(st: FakeState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = String(init?.method ?? "GET").toUpperCase();
    const p = decodeURIComponent(url.pathname);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (p.startsWith("/rest/v1/rpc/")) {
      const fn = p.slice(13);
      st.rpcLog.push(fn);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (fn === "esblu_company_termination_execute") {
        if (st.executeError) return json({ code: "P0001", message: st.executeError }, 400);
        st.jobs.set("job-1", { id: "job-1", user_id: body.p_user_id, company_id: body.p_company_id, termination_id: "term-1", storage_targets: st.executeTargets, storage_status: "pending", auth_status: "pending", attempts: 0 });
        return json({ job_id: "job-1", storage_targets: st.executeTargets, delete_account: true, termination_id: "term-1" });
      }
      if (fn === "esblu_cleanup_job_confirm_storage") {
        const job = st.jobs.get(body.p_job_id)!;
        const pref = `${job.company_id}/`;
        const remaining = [...st.objects].filter((o) => o.split("|")[1].startsWith(pref)).length;
        if (!remaining) job.storage_status = "done";
        return json({ done: remaining === 0, remaining });
      }
      if (fn === "esblu_company_termination_record_failure") return json(null);
      return json(null);
    }
    if (p.startsWith("/rest/v1/account_deletion_cleanup_jobs") && m === "PATCH") {
      const id = url.searchParams.get("id")!.slice(3);
      Object.assign(st.jobs.get(id)!, JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (p.startsWith("/storage/v1/object/") && m === "DELETE") {
      const bucket = p.slice(19);
      const { prefixes } = JSON.parse(String(init?.body));
      const out = [];
      for (const x of prefixes) if (st.objects.delete(`${bucket}|${x}`)) out.push({ name: x });
      return json(out);
    }
    if (p.startsWith("/storage/v1/object/") && m === "HEAD") {
      const rest = p.slice(19);
      const i = rest.indexOf("/");
      return new Response(null, { status: st.objects.has(`${rest.slice(0, i)}|${rest.slice(i + 1)}`) ? 200 : 404 });
    }
    if (p.startsWith("/auth/v1/admin/users/")) {
      const id = p.slice(21);
      if (m === "DELETE") { st.users.delete(id); return json({}); }
      return st.users.has(id) ? json({ id }) : json({ code: 404, msg: "User not found" }, 404);
    }
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;
}
function appClient(scope: ReturnType<typeof newScope>, st: FakeState) {
  const f = deletionGuardedFetch(scope, fakeServer(st));
  return createClient(ALLOWED_ORIGIN, "sb_secret_offline_test_key_000000000000", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: f } });
}
function t1State(): FakeState {
  const objs = [`ai-inbox-documents|${T1.companyId}/p15/doc-1.pdf`, `ai-inbox-documents|${T1.companyId}/p15/att-1.pdf`, `einvoice-documents|${T1.companyId}/inbound/a.xml`, `einvoice-documents|${T1.companyId}/orphan/qa-p15-orphan.xml`,
    `einvoice-documents|${PROTECTED_ISO.companyId}/inbound/b.xml`, `ai-inbox-documents|${PROTECTED_ISO.companyId}/p15/doc-1.pdf`, `${BILLING}|2026/inv-1.pdf`, `einvoice-documents|${ORIGINAL}/inbound/c.xml`];
  return { objects: new Set(objs), users: new Set([T1.ownerId, PROTECTED_ISO.ownerId]), jobs: new Map(), rpcLog: [],
    executeTargets: objs.slice(0, 4).map((o) => ({ bucket: o.split("|")[0], path: o.split("|")[1] })) };
}
const ack = () => buildTerminationAck({ authorityConfirmed: true, locale: "sk", companyId: T1.companyId, headers: new Headers({ "user-agent": "test" }) })!;
const protectedLeft = (st: FakeState) => [...st.objects].filter((o) => !o.includes(T1.companyId) && !o.includes(T2.companyId)).length;

await test("C1 skutočný kód appky: výmaz T1 zmaže iba objekty T1, ISO/pôvodná firma/billing ostanú, žiadne DENY", async () => {
  const st = t1State();
  const scope = newScope(T1);
  const admin = appClient(scope, st);
  const base = supabaseTerminationDeps(admin, "exported", ack());
  const deps = { ...base, async commit(r: Parameters<typeof base.commit>[0]) { const c = await base.commit(r); if (c.ok) scope.jobId = c.jobId; return c; } };
  const res = await orchestrateAccountDeletion(deps, { kind: "owner", userId: T1.ownerId, companyId: T1.companyId, deleteAccount: true });
  assert.equal(res.status, "deleted");
  assert.equal([...st.objects].filter((o) => o.includes(T1.companyId)).length, 0);
  assert.equal(protectedLeft(st), 4);
  assert.ok(!st.users.has(T1.ownerId) && st.users.has(PROTECTED_ISO.ownerId));
  assert.deepEqual(scope.log.filter((l) => l.startsWith("DENY")), []);
});
await test("C2 DB by vrátila cudzí cieľ (ISO v ai-inbox, billing, pôvodná firma) → nič cudzie sa nezmaže, DENY + job pending", async () => {
  const st = t1State();
  st.executeTargets = [...st.executeTargets, { bucket: "ai-inbox-documents", path: `${PROTECTED_ISO.companyId}/p15/doc-1.pdf` }, { bucket: BILLING, path: "2026/inv-1.pdf" }, { bucket: "einvoice-documents", path: `${ORIGINAL}/inbound/c.xml` }];
  const scope = newScope(T1);
  const admin = appClient(scope, st);
  const base = supabaseTerminationDeps(admin, "exported", ack());
  const deps = { ...base, async commit(r: Parameters<typeof base.commit>[0]) { const c = await base.commit(r); if (c.ok) scope.jobId = c.jobId; return c; } };
  const res = await orchestrateAccountDeletion(deps, { kind: "owner", userId: T1.ownerId, companyId: T1.companyId, deleteAccount: true });
  assert.equal(protectedLeft(st), 4, "chránené objekty musia ostať");
  assert.ok(scope.log.some((l) => l.startsWith("DENY")), "sieťová poistka musí zasiahnuť");
  assert.equal(res.status === "deleted" && res.cleanupPending, true);
  assert.equal(st.jobs.get("job-1")!.storage_status, "pending");
});
await test("C3 DB odmietne (brána) → žiadny Storage DELETE ani zrušenie účtu, zapíše sa iba kód zlyhania", async () => {
  const st = t1State();
  st.executeError = "ESBLU_TERMINATION_EXPORT_STALE";
  const scope = newScope(T1);
  const admin = appClient(scope, st);
  const res = await orchestrateAccountDeletion(supabaseTerminationDeps(admin, "exported", ack()), { kind: "owner", userId: T1.ownerId, companyId: T1.companyId, deleteAccount: true });
  assert.deepEqual(res, { status: "db_failed", code: "ESBLU_TERMINATION_EXPORT_STALE" });
  assert.equal(st.objects.size, 8);
  assert.ok(st.users.has(T1.ownerId));
  assert.deepEqual(st.rpcLog, ["esblu_company_termination_execute", "esblu_company_termination_record_failure"]);
});
await test("C4 výpadok Storage + retry (ako cron): job pending → druhý pokus dokončí, DB potvrdí", async () => {
  const st = t1State();
  const scope = newScope(T1);
  scope.injectStorageFailure = "einvoice-documents";
  const admin = appClient(scope, st);
  const base = supabaseTerminationDeps(admin, "exported", ack());
  const deps = { ...base, async commit(r: Parameters<typeof base.commit>[0]) { const c = await base.commit(r); if (c.ok) scope.jobId = c.jobId; return c; } };
  const res = await orchestrateAccountDeletion(deps, { kind: "owner", userId: T1.ownerId, companyId: T1.companyId, deleteAccount: true });
  assert.ok(res.status === "deleted" && res.cleanupPending);
  const job = st.jobs.get("job-1")!;
  assert.equal(job.storage_status, "pending");
  assert.equal(job.attempts, 1);
  assert.match(String(job.last_error_code), /ESBLU_STORAGE_REMOVE_FAILED/);
  assert.ok([...st.objects].some((o) => o.includes(T1.companyId)), "po výpadku ostávajú súbory");
  const term = job.termination_id && job.company_id ? String(job.company_id) : null;
  const out = await runCleanupJob(supabaseDeletionDeps(admin), { id: "job-1", userId: String(job.user_id), terminationCompanyId: term,
    storageTargets: parseStorageTargets(job.storage_targets, { terminationCompanyId: term }), storagePending: true, authPending: job.auth_status === "pending", attempts: Number(job.attempts) });
  assert.ok(out.storageDone && out.authDone);
  assert.equal([...st.objects].filter((o) => o.includes(T1.companyId)).length, 0);
  assert.equal(protectedLeft(st), 4);
  assert.equal(job.storage_status, "done");
});

// ----------------------------------------------------------------------------- D. priebeh runnera (falošné závislosti)
type Model = { companies: Set<string>; rows: Record<string, Array<Record<string, unknown>>>; objects: Set<string>; exportStatus: string; lastSignIn: string | null; gate: string | null; terminate: string; retryOk: boolean; calls: string[]; mutateIso?: boolean };
function model(): Model {
  const c = T1.companyId, iso = PROTECTED_ISO.companyId;
  return {
    companies: new Set([c, T2.companyId, iso]),
    rows: {
      companies: [{ id: c, name: T1.name, owner_id: T1.ownerId }, { id: T2.companyId, name: T2.name, owner_id: T2.ownerId }, { id: iso, name: "QA-P15-ISO", owner_id: PROTECTED_ISO.ownerId }],
      company_members: [{ company_id: c, user_id: T1.ownerId, role: "owner", status: "active" }, { company_id: T2.companyId, user_id: T2.ownerId, role: "owner", status: "active" }, { company_id: iso, user_id: PROTECTED_ISO.ownerId, role: "owner", status: "active" }],
      einvoice_inbound: [{ id: "i1", company_id: c, xml_storage_path: `${c}/inbound/a.xml`, pdf_storage_path: null, last_error_code: null }, { id: "i2", company_id: c, xml_storage_path: `${c}/inbound/r3.xml`, last_error_code: "RECIPIENT_MISMATCH" }, { id: "i3", company_id: iso, xml_storage_path: `${iso}/inbound/b.xml` }],
      einvoice_outbound: [], documents: [{ id: "d1", company_id: c, storage_path: `${c}/p15/doc-1.pdf` }], document_attachments: [], einvoice_organizations: [], billing_invoice_documents: [],
      invoices: [{ id: "x1", company_id: c }, { id: "x2", company_id: iso }], einvoice_events: [], einvoice_mandates: [{ id: "m1", company_id: iso }], vehicles: [],
      company_terminations: [], account_deletion_cleanup_jobs: [], einvoice_misdelivery_incidents: [],
    },
    objects: new Set([`einvoice-documents|${c}/inbound/a.xml`, `einvoice-documents|${c}/inbound/r3.xml`, `ai-inbox-documents|${c}/p15/doc-1.pdf`, `einvoice-documents|${iso}/inbound/b.xml`]),
    exportStatus: "completed", lastSignIn: new Date().toISOString(), gate: null, terminate: "deleted", retryOk: true, calls: [],
  };
}
function fakeDeps(mo: Model): DDeps {
  const scope = newScope(null);
  const match = (row: Record<string, unknown>, filter: Record<string, string>) => Object.entries(filter).every(([k, v]) => String(row[k]) === v.slice(3));
  const purge = (cid: string) => {
    for (const t of Object.keys(mo.rows)) if (!["company_terminations", "account_deletion_cleanup_jobs", "einvoice_misdelivery_incidents"].includes(t)) mo.rows[t] = mo.rows[t].filter((r) => r.company_id !== cid && r.id !== cid);
  };
  return {
    scope,
    async read(table, filter) { mo.calls.push(`read:${table}`); return (mo.rows[table] ?? []).filter((r) => match(r, filter)); },
    async rpc(fn) { mo.calls.push(`rpc:${fn}`); return fn === "esblu_cleanup_health" ? { data: { exhausted: 0, termination_unpurged_24h: 0 }, error: null } : { data: mo.gate, error: null }; },
    async list(bucket, prefix) { return [...mo.objects].filter((o) => o.startsWith(`${bucket}|${prefix}/`)).map((o) => o.split("|")[1]); },
    async exportRefresh() { mo.calls.push("export"); return { status: mo.exportStatus, runId: "run-1" }; },
    async reauth() { mo.calls.push("reauth"); return { lastSignInAt: mo.lastSignIn }; },
    buildAck() { return { authority_confirmed: true, text_sha256: "a".repeat(64) }; },
    async terminate(t) {
      mo.calls.push("terminate");
      if (mo.terminate !== "deleted") return { status: "db_failed", code: mo.terminate };
      const r3 = mo.rows.einvoice_inbound.filter((r) => r.company_id === t.companyId && r.last_error_code === "RECIPIENT_MISMATCH").length;
      purge(t.companyId);
      scope.jobId = "job-1";
      const pending = Boolean(scope.injectStorageFailure);
      if (!pending) for (const o of [...mo.objects]) if (o.includes(`|${t.companyId}/`)) mo.objects.delete(o);
      mo.rows.company_terminations.push({ id: "term-1", company_id: t.companyId, status: "completed", termination_mode: "customer_delete", export_run_id: "run-1", cleanup_job_id: "job-1", storage_purged_at: pending ? null : "now" });
      mo.rows.account_deletion_cleanup_jobs.push({ id: "job-1", company_id: t.companyId, termination_id: "term-1", storage_status: pending ? "pending" : "done", auth_status: "done", attempts: pending ? 1 : 0, last_error_code: pending ? "ESBLU_STORAGE_REMOVE_FAILED:einvoice-documents" : null });
      for (let i = 0; i < r3; i++) mo.rows.einvoice_misdelivery_incidents.push({ id: `inc-${i}`, termination_id: "term-1" });
      if (mo.mutateIso) mo.rows.invoices.push({ id: "x3", company_id: PROTECTED_ISO.companyId });
      scope.injectStorageFailure = null;
      return { status: "deleted", jobId: "job-1", storageRemoved: pending ? 0 : 3, cleanupPending: pending, accountDeleted: true };
    },
    async retryJob(_row, t) {
      mo.calls.push("retry");
      if (!mo.retryOk) return { storageDone: false, authDone: true, errorCode: "ESBLU_STORAGE_NOT_PURGED" };
      for (const o of [...mo.objects]) if (o.includes(`|${t.companyId}/`)) mo.objects.delete(o);
      Object.assign(mo.rows.account_deletion_cleanup_jobs[0], { storage_status: "done" });
      Object.assign(mo.rows.company_terminations[0], { storage_purged_at: "now" });
      return { storageDone: true, authDone: true, errorCode: null };
    },
    now: () => new Date(),
    log: () => undefined,
  };
}
const ids = (r: { results: Array<{ id: string; status: string }> }) => r.results.map((x) => `${x.id}:${x.status}`).join(" ");

await test("D1 úplný beh T1: export → reauth → brána → výmaz → kontrola → ISO nezmenená", async () => {
  const mo = model();
  const r = await runDeletionTarget(fakeDeps(mo), "t1");
  assert.equal(r.exitCode, 0, ids(r));
  assert.ok(r.results.every((x) => x.status === "PASS"), ids(r));
  assert.deepEqual(mo.calls.filter((c) => !c.startsWith("read") && !c.startsWith("rpc")), ["export", "reauth", "terminate"]);
});
await test("D2 ISO / pôvodná firma ako cieľ → exit 2, žiadne volanie", async () => {
  for (const k of ["iso", ORIGINAL, PROTECTED_ISO.companyId]) {
    const mo = model();
    const r = await runDeletionTarget(fakeDeps(mo), k);
    assert.equal(r.exitCode, 2);
    assert.equal(mo.calls.length, 0);
  }
});
await test("D3 export nie je completed / staré prihlásenie / brána odmieta → výmaz sa nezavolá", async () => {
  for (const mut of [(m: Model) => { m.exportStatus = "failed"; }, (m: Model) => { m.lastSignIn = new Date(Date.now() - 31 * 60_000).toISOString(); }, (m: Model) => { m.lastSignIn = null; }, (m: Model) => { m.gate = "ESBLU_TERMINATION_EXPORT_STALE"; }]) {
    const mo = model();
    mut(mo);
    const r = await runDeletionTarget(fakeDeps(mo), "t1");
    assert.equal(r.exitCode, 1);
    assert.ok(!mo.calls.includes("terminate"), ids(r));
  }
});
await test("D4 precheck: druhé členstvo vlastníka / registrácia e-Faktúry / billing / cesta mimo prefixu / zlý názov → STOP pred výmazom", async () => {
  const muts: Array<(m: Model) => void> = [
    (m) => m.rows.company_members.push({ company_id: PROTECTED_ISO.companyId, user_id: T1.ownerId, role: "admin", status: "active" }),
    (m) => m.rows.einvoice_organizations.push({ id: "o", company_id: T1.companyId, provider_org_id: "x" }),
    (m) => m.rows.billing_invoice_documents.push({ id: "b", company_id: T1.companyId }),
    (m) => m.rows.documents.push({ id: "d2", company_id: T1.companyId, storage_path: `${PROTECTED_ISO.companyId}/p15/doc-1.pdf` }),
    (m) => m.rows.einvoice_inbound.push({ id: "i9", company_id: T1.companyId, xml_storage_path: `${T1.companyId}/../${PROTECTED_ISO.companyId}/x.xml` }),
    (m) => { m.rows.companies[0].name = "Skutočná firma s.r.o."; },
  ];
  for (const mut of muts) {
    const mo = model();
    mut(mo);
    const r = await runDeletionTarget(fakeDeps(mo), "t1");
    assert.equal(r.exitCode, 1);
    assert.ok(!mo.calls.includes("terminate"), ids(r));
  }
});
await test("D5 DB odmietne výmaz → FAIL, nič zmazané", async () => {
  const mo = model();
  mo.terminate = "ESBLU_TERMINATION_REAUTH_REQUIRED";
  const r = await runDeletionTarget(fakeDeps(mo), "t1");
  assert.equal(r.exitCode, 1);
  assert.equal(mo.objects.size, 4);
  assert.ok(mo.companies.has(T1.companyId));
});
await test("D6 T2 so simulovaným výpadkom: zaznamenané zlyhanie → health 0 → retry → PASS", async () => {
  const mo = model();
  mo.rows.companies[1] = { id: T2.companyId, name: T2.name, owner_id: T2.ownerId };
  mo.objects.add(`einvoice-documents|${T2.companyId}/inbound/t2.xml`);
  const d = fakeDeps(mo);
  const r = await runDeletionTarget(d, "t2", { injectStorageFailureBucket: "einvoice-documents" });
  assert.equal(r.exitCode, 0, ids(r));
  assert.ok(["D6.failure_recorded", "D6.not_marked_purged", "D6.health_before_retry", "D7.retry_cleanup"].every((id) => r.results.some((x) => x.id === id && x.status === "PASS")), ids(r));
});
await test("D7 retry zlyhá → FAIL (súbory ostali), ISO zmenená počas behu → FAIL", async () => {
  const mo = model();
  mo.objects.add(`einvoice-documents|${T2.companyId}/inbound/t2.xml`);
  mo.retryOk = false;
  const r = await runDeletionTarget(fakeDeps(mo), "t2", { injectStorageFailureBucket: "einvoice-documents" });
  assert.equal(r.exitCode, 1);
  const mo2 = model();
  mo2.mutateIso = true;
  const r2 = await runDeletionTarget(fakeDeps(mo2), "t1");
  assert.ok(r2.results.some((x) => x.id === "D9.iso_unchanged" && x.status === "FAIL"));
});

await test("D8 cleanup-only: dočistí commitnuté ukončenie T2 po výpadku; bez ukončenia / pre ISO → STOP bez zmien", async () => {
  const mo = model();
  mo.objects.add(`einvoice-documents|${T2.companyId}/inbound/t2.xml`);
  const d = fakeDeps(mo);
  await d.terminate(T2, {});
  d.scope.injectStorageFailure = null;
  // výpadok: ukončenie commitnuté, súbory T2 ostali
  Object.assign(mo.rows.account_deletion_cleanup_jobs[0], { storage_status: "pending" });
  Object.assign(mo.rows.company_terminations[0], { storage_purged_at: null });
  mo.objects.add(`einvoice-documents|${T2.companyId}/inbound/t2.xml`);
  const r = await runCleanupOnly(d, "t2");
  assert.equal(r.exitCode, 0, ids(r));
  assert.equal([...mo.objects].filter((o) => o.includes(T2.companyId)).length, 0);
  const mo2 = model();
  const r2 = await runCleanupOnly(fakeDeps(mo2), "t1");
  assert.equal(r2.exitCode, 1);
  assert.ok(!mo2.calls.includes("retry"));
  const r3 = await runCleanupOnly(fakeDeps(model()), "iso");
  assert.equal(r3.exitCode, 2);
});

console.log(`\np15-groupD-tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
