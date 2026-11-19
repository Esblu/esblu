// =============================================================================
// E-Faktúra — mandát, deregistrácia, prevádzkové alerty: unit testy s MOCK
// poskytovateľom (žiadna sieť, žiadna DB). DB vrstva: scripts/einvoice-mandate-safety-pglite-tests.ts.
//   npm run test:einvoice-mandate
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EINVOICE_MANDATE_STATEMENT_VERSION, mandateAllows } from "../lib/einvoice/mandate-statement.ts";
import { canonicalSha256, enrollEffectiveScope, mandateReasonCode, mandateStatement, regrantEffectiveScope, requestEvidence, type MandateStore } from "../lib/einvoice/mandate.ts";
import { classifyDeactivateError, ensureCompanyDeregistered, runDeregistrationBatch, type DeregistrationJob, type DeregistrationStore } from "../lib/einvoice/deregistration.ts";
import { alertForProviderError, createOpsAlertSink, type OpsAlertInput, type OpsAlertNotification, type OpsAlertStore } from "../lib/einvoice/ops/alert-sink.ts";
import { maintenanceHttpStatus } from "../lib/einvoice/ops/maintenance.ts";
import { EinvoiceProviderError, type DeactivateResult, type ProviderContext } from "../lib/einvoice/provider/types.ts";
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import { classifyWebhookEvent, processProviderEvent, type WebhookDeps } from "../lib/einvoice/inbound/webhook.ts";
import { changeMandate, parseMandateBody } from "../lib/einvoice/ui/mandate-server.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}

// ----------------------------------------------------------------------------- mandát
// ZMENA TEXTU POVERENIA = NOVÁ VERZIA. Ak tento test zlyhá po úprave i18n textu, zvýšte
// EINVOICE_MANDATE_STATEMENT_VERSION (lib/einvoice/mandate-statement.ts) a pripnite nové hashe.
const PINNED: Record<string, Record<string, string>> = {
  "efaktura-mandate-2026-11-19": {
    sk: "798f63145691bafaecdc432829b75c2b5eef737c869e8cfbae7c66cf9c67c58e",
    en: "c3804b66f881066dd18f6b756bb434e41fff930207844b4e4786ad3456b2b7ff",
    de: "284554639d2daa3d8e38f4d0c050df4fbda7daec2aed5d5b27bf4aa5fb25343c",
  },
};
await check("vyhlásenie: verzia + SHA-256 zobrazeného textu pripnuté pre sk / en / de (zmena textu bez novej verzie zlyhá)", () => {
  const pinned = PINNED[EINVOICE_MANDATE_STATEMENT_VERSION];
  assert.ok(pinned, `chýbajú pripnuté hashe pre ${EINVOICE_MANDATE_STATEMENT_VERSION}`);
  for (const l of ["sk", "en", "de"] as const) {
    const s = mandateStatement(l);
    assert.equal(s.locale, l);
    assert.equal(s.version, EINVOICE_MANDATE_STATEMENT_VERSION);
    assert.equal(s.sha256, pinned[l], `${l}: text sa zmenil — zvýšte verziu`);
  }
  assert.match(mandateStatement("sk").text, /oprávnený\/á konať za túto firmu/);
  assert.match(mandateStatement("sk").text, /poverujem Esblu/);
});

await check("dôkazy požiadavky: request id validované, IP a User-Agent iba ako SHA-256 (so soľou firmy), nikdy surové", () => {
  const h = new Headers({ "x-vercel-id": "fra1::abc-123", "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "Mozilla/5.0 Test" });
  const a = requestEvidence(h, "c1");
  const b = requestEvidence(h, "c2");
  assert.equal(a.requestId, "fra1::abc-123");
  assert.match(a.ipSha256!, /^[0-9a-f]{64}$/);
  assert.notEqual(a.ipSha256, b.ipSha256, "soľ firmy");
  assert.ok(!JSON.stringify(a).includes("203.0.113.7") && !JSON.stringify(a).includes("Mozilla"));
  const none = requestEvidence(new Headers({ "x-request-id": "bad id with spaces" }), "c1");
  assert.deepEqual(none, { requestId: null, ipSha256: null, userAgentSha256: null });
});

await check("rozsah: enrolled/skipped = send+receive, send_only = send; regrant podľa spôsobilosti; fail-closed čítanie", () => {
  assert.deepEqual(enrollEffectiveScope("enrolled"), ["send", "receive"]);
  assert.deepEqual(enrollEffectiveScope("skipped"), ["send", "receive"]);
  assert.deepEqual(enrollEffectiveScope("send_only"), ["send"]);
  assert.deepEqual(regrantEffectiveScope({ peppolEligible: false }, true), []);
  assert.deepEqual(regrantEffectiveScope({ peppolEligible: true }, false), ["send"]);
  assert.equal(mandateAllows({ effective_scope: ["send"] }, "send"), true);
  for (const bad of [null, undefined, "send", { effective_scope: "send" }, { effective_scope: ["receive"] }, {}]) assert.equal(mandateAllows(bad, "send"), false);
  assert.equal(mandateReasonCode("einvoice-enroll.token invalid"), "EINVOICE_ENROLL_TOKEN_INVALID");
  assert.equal(canonicalSha256({ b: 1, a: [1, { d: 2, c: 3 }] }), canonicalSha256({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

// ----------------------------------------------------------------------------- mandát route
type Resp = { data: unknown; error: unknown };
function fakeDb(opts: { company?: string | null; org?: Record<string, unknown> | null; mandate?: unknown }) {
  return {
    rpc: async (fn: string): Promise<Resp> => {
      if (fn === "esblu_my_active_company_id") return { data: opts.company ?? null, error: null };
      if (fn === "esblu_einvoice_my_mandate") return { data: opts.mandate ?? null, error: null };
      return { data: null, error: { message: "unknown" } };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.org ?? null, error: null }) }) }) }),
  } as never;
}
function memoryMandates() {
  const log: string[] = [];
  const store: MandateStore = {
    async grant(i) { log.push(`grant:${i.channel}:${i.scope.join("+")}:${i.statement.sha256.slice(0, 8)}`); return "m-1"; },
    async confirm(i) { log.push(`confirm:${i.scope.join("+")}:${i.providerOutcome}:${i.providerResponseSha256 ? "hash" : "nohash"}`); },
    async revoke(i) { log.push(`revoke:${i.kind}:${i.reasonCode}`); return 2; },
  };
  return { store, log };
}
const okAccess = (over: Record<string, boolean> = {}) => async () => ({
  ok: true as const, financeView: true,
  access: { financeManage: true, entitlementActive: true, providerConfigured: true, rolloutEnabled: true, ...over },
}) as never;
const fakeOrgProvider = { name: "efaktura_sk", getOrganization: async () => ({ providerOrgId: "org-1", participantId: "9915:1", orgStatus: "active", peppolStatus: "active", claimStatus: null, peppolEligible: true, reused: false }) } as never;

await check("route mandátu: telo striktne; revoke = finance.manage, kind user; grant iba pre registrovanú org + hash overenia u poskytovateľa", async () => {
  assert.deepEqual(parseMandateBody({ action: "revoke", confirm_revoke: true }), { ok: true, body: { action: "revoke" } });
  assert.equal((parseMandateBody({ action: "revoke", confirm_revoke: true, company_id: "x" }) as { code: string }).code, "INVALID_BODY");
  assert.equal((parseMandateBody({ action: "grant", confirm_mandate: true, mandate_version: "old" }) as { code: string }).code, "MANDATE_STATEMENT_OUTDATED");
  const base = { userId: "u1", runtime: { provider: fakeOrgProvider, environment: "sandbox" as const }, statement: mandateStatement("sk"), evidence: () => ({ requestId: null, ipSha256: null, userAgentSha256: null }) };
  // employee / bez finance.manage
  let m = memoryMandates();
  let r = await changeMandate({ ...base, db: fakeDb({ company: "c1" }), access: okAccess({ financeManage: false }), store: () => m.store }, { action: "revoke", confirm_revoke: true });
  assert.equal(r.status, 403);
  assert.deepEqual(m.log, []);
  r = await changeMandate({ ...base, db: fakeDb({ company: "c1" }), access: okAccess(), store: () => m.store }, { action: "revoke", confirm_revoke: true });
  assert.deepEqual([r.status, r.body.code], [200, "REVOKED"]);
  assert.deepEqual(m.log, ["revoke:user:USER_REVOKED"]);
  // grant bez registrovanej org
  m = memoryMandates();
  r = await changeMandate({ ...base, db: fakeDb({ company: "c1", org: null }), access: okAccess(), store: () => m.store }, { action: "grant", confirm_mandate: true, mandate_version: EINVOICE_MANDATE_STATEMENT_VERSION });
  assert.deepEqual([r.status, r.body.code], [409, "ORGANIZATION_NOT_READY"]);
  assert.deepEqual(m.log, []);
  // grant pre registrovanú org (príjem aktívny)
  r = await changeMandate({ ...base, db: fakeDb({ company: "c1", org: { provider: "efaktura_sk", provider_org_id: "org-1", reception_status: "active" } }), access: okAccess(), store: () => m.store }, { action: "grant", confirm_mandate: true, mandate_version: EINVOICE_MANDATE_STATEMENT_VERSION });
  assert.deepEqual([r.status, r.body.code], [200, "GRANTED"]);
  assert.deepEqual(m.log, [`grant:regrant:send+receive:${mandateStatement("sk").sha256.slice(0, 8)}`, "confirm:send+receive:ORG_VERIFIED:hash"]);
  // deactivated org → nie
  r = await changeMandate({ ...base, db: fakeDb({ company: "c1", org: { provider: "efaktura_sk", provider_org_id: "org-1", reception_status: "deactivated" } }), access: okAccess(), store: () => m.store }, { action: "grant", confirm_mandate: true, mandate_version: EINVOICE_MANDATE_STATEMENT_VERSION });
  assert.equal(r.status, 409);
});

// ----------------------------------------------------------------------------- alerty
function memoryAlertStore() {
  const open = new Map<string, { n: number; notifiedAt: number }>();
  let now = 0;
  const store: OpsAlertStore & { tick(ms: number): void } = {
    tick(ms) { now += ms; },
    async raise(i) {
      const key = `${i.code}:${i.environment}:${i.companyId ?? "platform"}`;
      const e = open.get(key);
      if (!e) { open.set(key, { n: 1, notifiedAt: now }); return { alertId: key, created: true, notify: true, occurrences: 1 }; }
      e.n++;
      const notify = now - e.notifiedAt >= 6 * 3600_000;
      if (notify) e.notifiedAt = now;
      return { alertId: key, created: false, notify, occurrences: e.n };
    },
    async resolve(code, env, company) { return open.delete(`${code}:${env}:${company ?? "platform"}`) ? 1 : 0; },
    async openSummary() { return { critical: open.size, warning: 0, codes: [...open.keys()].map((k) => k.split(":")[0]) }; },
  };
  return store;
}
await check("alerty: dedupe — 100× 402 = 1 notifikácia; renotifikácia po 6 h; výpadok DB → notifikuje aj tak; nikdy nehádže", async () => {
  const store = memoryAlertStore();
  const sent: OpsAlertNotification[] = [];
  const sink = createOpsAlertSink(store, (n) => { sent.push(n); });
  const a: OpsAlertInput = { code: "PROVIDER_INSUFFICIENT_CREDIT", severity: "critical", provider: "efaktura_sk", environment: "live", detailCode: "EINVOICE_PROVIDER_INSUFFICIENT_CREDIT" };
  for (let i = 0; i < 100; i++) await sink.raise(a);
  assert.equal(sent.length, 1);
  store.tick(6 * 3600_000);
  await sink.raise(a);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].occurrences, 101);
  const broken = createOpsAlertSink({ ...store, raise: async () => { throw new Error("db down"); } }, (n) => { sent.push(n); });
  await broken.raise(a);
  assert.equal(sent.length, 3);
  const throwing = createOpsAlertSink({ ...store, raise: async () => { throw new Error("x"); } }, () => { throw new Error("notify down"); });
  await throwing.raise(a); // nehádže
  await throwing.resolve("PROVIDER_INSUFFICIENT_CREDIT", "live");
  assert.ok(!JSON.stringify(sent).includes("company"), "notifikácia bez firmy");
});
await check("alerty: mapovanie chýb poskytovateľa; otvorený kritický alert prepne maintenance na 503", () => {
  assert.deepEqual(alertForProviderError("EINVOICE_PROVIDER_INSUFFICIENT_CREDIT"), { code: "PROVIDER_INSUFFICIENT_CREDIT", severity: "critical" });
  assert.equal(alertForProviderError("EINVOICE_PROVIDER_UNAUTHORIZED")?.code, "PROVIDER_AUTH_FAILED");
  assert.equal(alertForProviderError("EINVOICE_PROVIDER_REJECTED"), null);
  assert.equal(maintenanceHttpStatus({ alerts: [], eventAlerts: [], opsAlerts: { critical: 1, warning: 0, codes: ["PROVIDER_INSUFFICIENT_CREDIT"] } }), 503);
  assert.equal(maintenanceHttpStatus({ alerts: [], eventAlerts: [], opsAlerts: { critical: 0, warning: 2, codes: [] } }), 200);
  assert.equal(maintenanceHttpStatus({ alerts: [], eventAlerts: [] }), 200);
});

await check("webhook usage.limit_exceeded → kritický alert (aj bez známej org); iné prostredie (mode) sa ignoruje; telo sa nepoužije", async () => {
  assert.equal(classifyWebhookEvent("usage.limit_exceeded"), "usage_limit");
  const raised: OpsAlertInput[] = [];
  const completed: string[] = [];
  const deps = {
    provider: { name: "efaktura_sk" },
    environment: "live",
    alerts: { raise: async (i: OpsAlertInput) => { raised.push(i); }, resolve: async () => undefined },
    inbound: {
      webhookRecord: async () => ({ webhookEventId: "w1", inserted: true, bodyMatches: true, companyId: null, processingStatus: "rejected" }),
      webhookComplete: async (id: string, status: string) => { completed.push(`${id}:${status}`); },
    },
  } as unknown as WebhookDeps;
  const r = await processProviderEvent(deps, { deliveryId: "d-1", payload: { event: "usage.limit_exceeded", data: { orgId: "org-x", mode: "live", balance: 0 } }, bodySha256: "0".repeat(64) });
  assert.deepEqual(r, { status: 200, body: { code: "ALERT_RAISED" } });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].code, "PROVIDER_USAGE_LIMIT_EXCEEDED");
  assert.equal(raised[0].severity, "critical");
  assert.ok(!JSON.stringify(raised).includes("org-x"));
  assert.deepEqual(completed, [], "neznáma org → doručenie ostáva rejected");
  await processProviderEvent(deps, { deliveryId: "d-2", payload: { event: "usage.limit_exceeded", data: { mode: "test" } }, bodySha256: "1".repeat(64) });
  assert.equal(raised.length, 1, "sandbox (test) udalosť v live nasadení sa ignoruje");
});

// ----------------------------------------------------------------------------- deregistrácia
class MemDereg implements DeregistrationStore {
  registered = true;
  jobs = new Map<string, DeregistrationJob & { next: number }>();
  finishes: string[] = [];
  clock = 0;
  async status() {
    const j = [...this.jobs.values()].at(-1);
    return { registered: this.registered, job: j ? { id: j.id, state: j.state, attempts: j.attempts, last_error_code: j.last_error_code } : null };
  }
  async request() {
    if (!this.registered) return { jobId: null, state: "not_registered", created: false };
    const open = [...this.jobs.values()].find((j) => j.state !== "completed" && j.state !== "failed");
    if (open) return { jobId: open.id, state: open.state, created: false };
    const id = `job-${this.jobs.size + 1}`;
    this.jobs.set(id, { id, company_id: "c1", provider: "efaktura_sk", environment: "sandbox", provider_org_id: "org-1", state: "requested", attempts: 0, max_attempts: 3, last_error_code: null, next: 0 });
    return { jobId: id, state: "requested", created: true };
  }
  async claim(provider: string, env: string, _l: number, _s: number, jobId?: string | null) {
    const j = [...this.jobs.values()].find((x) => (!jobId || x.id === jobId) && x.provider === provider && x.environment === env && (x.state === "requested" || x.state === "retry_wait") && x.next <= this.clock && x.attempts < x.max_attempts);
    if (!j) return [];
    j.state = "in_progress";
    j.attempts++;
    return [{ ...j }];
  }
  async finish(i: { jobId: string; outcome: "completed" | "retry" | "failed"; errorCode: string | null }) {
    const j = this.jobs.get(i.jobId)!;
    assert.equal(j.state, "in_progress", "finish iba z in_progress");
    this.finishes.push(`${i.outcome}:${i.errorCode ?? ""}`);
    if (i.outcome === "completed") { j.state = "completed"; this.registered = false; j.last_error_code = null; }
    else if (i.outcome === "retry" && j.attempts < j.max_attempts) { j.state = "retry_wait"; j.last_error_code = i.errorCode; j.next = this.clock + 1; }
    else { j.state = "failed"; j.last_error_code = i.outcome === "retry" ? "EINVOICE_DEREGISTRATION_RETRY_EXHAUSTED" : i.errorCode; }
    return { ...j };
  }
}
class FakeDeactivator {
  readonly name = "efaktura_sk";
  script: (DeactivateResult | EinvoiceProviderError)[] = [];
  calls: ProviderContext[] = [];
  async deactivatePeppol(ctx: ProviderContext): Promise<DeactivateResult> {
    this.calls.push(ctx);
    const s = this.script.shift() ?? { peppolStatus: "deactivated", responseSha256: "f".repeat(64) };
    if (s instanceof EinvoiceProviderError) throw s;
    return s;
  }
}

await check("deregistrácia: klasifikácia — 409/429/5xx/402/401 retry, 404 a iné 4xx failed (nikdy predpokladaný úspech)", () => {
  const c = (code: string, retryable = false) => classifyDeactivateError(new EinvoiceProviderError(code, code, retryable)).outcome;
  assert.equal(c("EINVOICE_PROVIDER_CONFLICT"), "retry");
  assert.equal(c("EINVOICE_PROVIDER_RATE_LIMITED", true), "retry");
  assert.equal(c("EINVOICE_PROVIDER_UNAVAILABLE", true), "retry");
  assert.equal(c("EINVOICE_PROVIDER_INSUFFICIENT_CREDIT"), "retry");
  assert.equal(c("EINVOICE_PROVIDER_UNAUTHORIZED"), "retry");
  assert.equal(c("EINVOICE_PROVIDER_NOT_FOUND"), "failed");
  assert.equal(c("EINVOICE_PROVIDER_REJECTED"), "failed");
  assert.equal(classifyDeactivateError(new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", "Prekročený limit požiadaviek (Retry-After 120 s)", true)).retryAfterSeconds, 120);
});

await check("deregistrácia (termination): 409 v behu → pending; ďalší beh cronu → completed; opakovanie idempotentné (1 job)", async () => {
  const store = new MemDereg();
  const provider = new FakeDeactivator();
  provider.script.push(new EinvoiceProviderError("EINVOICE_PROVIDER_CONFLICT", "transfers in progress"));
  const raised: string[] = [];
  const runtime = { provider, environment: "sandbox" as const, alerts: { raise: async (i: OpsAlertInput) => { raised.push(i.code); }, resolve: async () => undefined } };
  const first = await ensureCompanyDeregistered({ store, runtime }, { companyId: "c1", actorUserId: "u1", reason: "company_termination" }, "sandbox");
  assert.deepEqual(first, { done: false, jobId: "job-1", state: "retry_wait", code: "EINVOICE_DEREGISTRATION_PENDING" });
  const again = await ensureCompanyDeregistered({ store, runtime }, { companyId: "c1", actorUserId: "u1", reason: "company_termination" }, "sandbox");
  assert.equal(again.done, false);
  assert.equal(store.jobs.size, 1, "žiadny druhý job");
  store.clock = 1; // backoff uplynul
  const batch = await runDeregistrationBatch({ store, ...runtime }, { batchSize: 5 });
  assert.deepEqual(batch.results, [{ id: "job-1", state: "completed", code: null }]);
  const done = await ensureCompanyDeregistered({ store, runtime }, { companyId: "c1", actorUserId: "u1", reason: "company_termination" }, "sandbox");
  assert.deepEqual(done, { done: true, jobId: "job-1" });
  assert.deepEqual(provider.calls.map((c) => c.providerOrgId), ["org-1", "org-1"]);
  assert.deepEqual(raised, []);
});

await check("deregistrácia: 404 → failed + kritický alert DEREGISTRATION_FAILED; vyčerpané pokusy → failed + alert; 402 → alert kreditu", async () => {
  let store = new MemDereg();
  let provider = new FakeDeactivator();
  let raised: string[] = [];
  const alerts = { raise: async (i: OpsAlertInput) => { raised.push(`${i.code}:${i.detailCode ?? ""}`); }, resolve: async () => undefined };
  provider.script.push(new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND", "404"));
  let r = await ensureCompanyDeregistered({ store, runtime: { provider, environment: "sandbox", alerts } }, { companyId: "c1", actorUserId: "u1", reason: "owner_request" }, "sandbox");
  assert.deepEqual(r, { done: false, jobId: "job-1", state: "failed", code: "EINVOICE_DEREGISTRATION_FAILED" });
  assert.deepEqual(raised, ["DEREGISTRATION_FAILED:EINVOICE_PROVIDER_NOT_FOUND"]);
  assert.equal(store.registered, true, "mapovanie ostáva");

  store = new MemDereg();
  provider = new FakeDeactivator();
  raised = [];
  for (let i = 0; i < 3; i++) provider.script.push(new EinvoiceProviderError("EINVOICE_PROVIDER_INSUFFICIENT_CREDIT", "402"));
  await ensureCompanyDeregistered({ store, runtime: { provider, environment: "sandbox", alerts } }, { companyId: "c1", actorUserId: "u1", reason: "owner_request" }, "sandbox");
  store.clock = 1;
  await runDeregistrationBatch({ store, provider, environment: "sandbox", alerts });
  store.clock = 2;
  await runDeregistrationBatch({ store, provider, environment: "sandbox", alerts });
  assert.equal([...store.jobs.values()][0].state, "failed");
  assert.equal([...store.jobs.values()][0].last_error_code, "EINVOICE_DEREGISTRATION_RETRY_EXHAUSTED");
  assert.ok(raised.includes("PROVIDER_INSUFFICIENT_CREDIT:EINVOICE_PROVIDER_INSUFFICIENT_CREDIT"));
  assert.ok(raised.includes("DEREGISTRATION_FAILED:EINVOICE_DEREGISTRATION_RETRY_EXHAUSTED"));
});

await check("deregistrácia: bez poskytovateľa / iné prostredie → nič sa nevolá; neregistrovaná firma → done hneď", async () => {
  const store = new MemDereg();
  const provider = new FakeDeactivator();
  const r = await ensureCompanyDeregistered({ store, runtime: null }, { companyId: "c1", actorUserId: "u1", reason: "company_termination" }, "sandbox");
  assert.equal(r.done, false);
  assert.equal((r as { code: string }).code, "EINVOICE_PROVIDER_NOT_CONFIGURED");
  const live = await runDeregistrationBatch({ store, provider, environment: "live" });
  assert.equal(live.claimed, 0, "sandbox job sa v live nasadení nezoberie");
  assert.equal(provider.calls.length, 0);
  store.registered = false;
  const n = await ensureCompanyDeregistered({ store, runtime: null }, { companyId: "c1", actorUserId: "u1", reason: "company_termination" }, null);
  assert.equal(n.done, false, "bez prostredia sa nerozhoduje");
});

await check("adaptér eFaktura.sk: POST /v1/agent/organizations/{id}/peppol/deactivate, kľúč iba v hlavičke, SHA-256 odpovede; 409 → retry", async () => {
  const reqs: { url: string; method: string; body: string | null }[] = [];
  let status = 200;
  const p = new EfakturaSkProvider({
    apiKey: "efk_pk_test_" + "k".repeat(24),
    environment: "sandbox",
    fetchImpl: async (url, init) => {
      reqs.push({ url, method: String(init.method), body: (init.body as string) ?? null });
      const body = status === 200 ? JSON.stringify({ data: { peppol_status: "deactivated" } }) : JSON.stringify({ error: { code: "TRANSFERS_IN_PROGRESS", message: "busy" } });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    },
  });
  const r = await p.deactivatePeppol({ environment: "sandbox", providerOrgId: "org_123" });
  assert.equal(r.peppolStatus, "deactivated");
  assert.match(r.responseSha256!, /^[0-9a-f]{64}$/);
  assert.equal(reqs[0].method, "POST");
  assert.equal(reqs[0].url, "https://api.efaktura.sk/v1/agent/organizations/org_123/peppol/deactivate");
  assert.ok(!JSON.stringify(reqs).includes("efk_pk_test_"), "kľúč nie je v URL ani tele");
  status = 409;
  const err = await p.deactivatePeppol({ environment: "sandbox", providerOrgId: "org_123" }).then(() => null, (e: unknown) => e);
  // 409 „prenosy prebiehajú“ → CONFLICT alebo (podľa textu) IDEMPOTENCY_IN_PROGRESS — oboje = retry jobu
  assert.ok(err instanceof EinvoiceProviderError && /^EINVOICE_PROVIDER_(CONFLICT|IDEMPOTENCY_IN_PROGRESS)$/.test(err.code), String(err));
  assert.equal(classifyDeactivateError(err).outcome, "retry");
  await assert.rejects(() => p.deactivatePeppol({ environment: "live", providerOrgId: "org_123" }), /EINVOICE_ENVIRONMENT_MISMATCH|prostrediu/);
  await assert.rejects(() => p.deactivatePeppol({ environment: "sandbox", providerOrgId: "../x" }));
});

// ----------------------------------------------------------------------------- statické invarianty
await check("invarianty: lib/einvoice nelogovuje; ukončenie firmy volá deregistráciu pred výmazom; UI posiela verziu poverenia", () => {
  for (const f of ["lib/einvoice/mandate.ts", "lib/einvoice/deregistration.ts", "lib/einvoice/ops/alert-sink.ts", "lib/einvoice/ui/mandate-server.ts"]) {
    assert.doesNotMatch(read(f), /console\./, f);
  }
  const route = read("app/api/account/delete/route.ts");
  const dereg = route.indexOf("ensureCompanyDeregistered(");
  const orchestrate = route.indexOf("orchestrateAccountDeletion(\n        blocker && terminationMode");
  assert.ok(dereg > 0 && orchestrate > dereg, "deregistrácia pred orchestráciou výmazu");
  assert.match(read("lib/einvoice/ui/client.ts"), /mandate_version: EINVOICE_MANDATE_STATEMENT_VERSION/);
  assert.match(read("lib/einvoice/outbound/request.ts"), /MANDATE_REQUIRED/);
  for (const f of ["supabase/migrations/20261122100000_einvoice_mandates.sql", "supabase/migrations/20261122110000_einvoice_deregistration_jobs.sql", "supabase/migrations/20261122120000_einvoice_ops_alerts.sql"]) {
    const rb = f.replace("migrations/", "rollback/").replace(".sql", "_rollback.sql");
    assert.match(read(rb), /esblu_audit_archive/, rb);
    assert.doesNotMatch(read(rb).replace(/execute 'drop table public\.[a-z_]+'/g, ""), /drop table (if exists )?public\.einvoice_(mandates|deregistrations|ops_alerts)\b/, `${rb}: nepodmienený drop`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
