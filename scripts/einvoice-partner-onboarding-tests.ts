// =============================================================================
// E-Faktúra — API partner onboarding: adaptér (enroll, feed), DB pravidlá
// (migrácia 20261005100000), webhook participant.*, retry a regresia úniku tajomstiev.
// Bez siete (fake fetch), PGlite. SPUSTENIE: npm run test:einvoice-partner
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import { EinvoiceProviderError } from "../lib/einvoice/provider/types.ts";
import { classifyWebhookEvent, processProviderEvent, type WebhookDeps } from "../lib/einvoice/inbound/webhook.ts";
import { enrollCompany, provisionCompany, receptionView, withRetry } from "../lib/einvoice/onboarding.ts";
import { createPartnerHarness } from "./einvoice-partner-harness.ts";
import { createFakeSandbox } from "./einvoice-partner-fake-sandbox.ts";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const KEY = "efk_pk_test_" + "k".repeat(24);
const ORG = "8c1f0b2e-1c0a-4a1b-9f2e-2b3c4d5e6f70";
type Captured = { url: string; init: RequestInit };
function providerWith(respond: (c: Captured) => Response, environment: "sandbox" | "live" = "sandbox") {
  const seen: Captured[] = [];
  const key = environment === "sandbox" ? KEY : "efk_pk_live_" + "k".repeat(24);
  const p = new EfakturaSkProvider({ apiKey: key, environment, fetchImpl: async (url, init) => { const c = { url, init }; seen.push(c); return respond(c); } });
  return { p, seen, ctx: { environment, providerOrgId: ORG } as const };
}
const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

// --- adaptér: enroll -------------------------------------------------------------------
await check("enroll: POST /v1/agent/peppol/enroll, X-API-Key + X-Organization-Id, telo iba verificationTokenHex", async () => {
  const { p, seen, ctx } = providerWith(() => json(201, { data: { status: "enrolled", registration_id: "r1", participant_id: "9915:2012345678", claim: null, reception: null } }));
  const r = await p.enrollPeppol(ctx, { verificationTokenHex: "a1b2c3" });
  assert.equal(r.status, "enrolled");
  assert.equal(r.participantId, "9915:2012345678");
  const h = new Headers(seen[0].init.headers);
  assert.equal(new URL(seen[0].url).pathname, "/v1/agent/peppol/enroll");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(h.get("X-API-Key"), KEY);
  assert.equal(h.get("X-Organization-Id"), ORG);
  assert.equal(h.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { verificationTokenHex: "a1b2c3" });
  assert.equal(seen[0].init.redirect, "error");
});
await check("enroll: send_only → receptionHeldBy, warnings iba kódy", async () => {
  const { p, ctx } = providerWith(() => json(201, { warnings: [{ code: "SANDBOX_TOKEN_MISSING", message: "x" }, { code: "bad code!" }], data: { status: "send_only", registration_id: null, participant_id: "9915:2012345678", reception: { held_by: { ap_host: "sandbox-other-ap.efaktura.test", cert_org: "Sandbox iný poštár" } } } }));
  const r = await p.enrollPeppol(ctx, { verificationTokenHex: "000000000000beef" });
  assert.equal(r.status, "send_only");
  assert.deepEqual(r.receptionHeldBy, { apHost: "sandbox-other-ap.efaktura.test", certOrg: "Sandbox iný poštár" });
  assert.deepEqual(r.warnings, ["SANDBOX_TOKEN_MISSING"]);
});
await check("enroll: 400 → EINVOICE_ENROLL_TOKEN_INVALID, token sa NEOBJAVÍ v chybe ani keď ho poskytovateľ zopakuje", async () => {
  const token = "000000000000dead";
  const { p, ctx } = providerWith(() => json(400, { error: { code: "VALIDATION_ERROR", message: `Verifikačný token ${token} nie je platný` } }));
  const err = await p.enrollPeppol(ctx, { verificationTokenHex: token }).then(() => null, (e) => e as EinvoiceProviderError);
  assert.ok(err);
  assert.equal(err!.code, "EINVOICE_ENROLL_TOKEN_INVALID");
  assert.equal(err!.retryable, false);
  assert.ok(!err!.message.includes(token) && !err!.message.includes(KEY));
});
await check("enroll: 409 → EINVOICE_ENROLL_CONFLICT; 503 → retryable; neznámy status → UNKNOWN_STATE", async () => {
  const a = providerWith(() => json(409, { error: { code: "CONFLICT", message: "x" } }));
  assert.equal((await a.p.enrollPeppol(a.ctx, { verificationTokenHex: "ab" }).catch((e) => e)).code, "EINVOICE_ENROLL_CONFLICT");
  const b = providerWith(() => json(503, { error: { code: "UNAVAILABLE", message: "x" } }));
  const e = await b.p.enrollPeppol(b.ctx, { verificationTokenHex: "ab" }).catch((x) => x);
  assert.equal(e.code, "EINVOICE_PROVIDER_UNAVAILABLE");
  assert.equal(e.retryable, true);
  const c = providerWith(() => json(201, { data: { status: "weird" } }));
  assert.equal((await c.p.enrollPeppol(c.ctx, { verificationTokenHex: "ab" }).catch((x) => x)).code, "EINVOICE_PROVIDER_UNKNOWN_STATE");
});
await check("enroll: nehex token / migračný kód v sandboxe → odmietnuté BEZ sieťového volania", async () => {
  const { p, seen, ctx } = providerWith(() => json(201, {}));
  assert.equal((await p.enrollPeppol(ctx, { verificationTokenHex: "xyz!" }).catch((e) => e)).code, "EINVOICE_ENROLL_TOKEN_FORMAT");
  assert.equal((await p.enrollPeppol(ctx, { verificationTokenHex: "" }).catch((e) => e)).code, "EINVOICE_ENROLL_TOKEN_FORMAT");
  assert.equal((await p.enrollPeppol(ctx, { verificationTokenHex: "ab", migrationCode: "ABCD1234EFGH" }).catch((e) => e)).code, "EINVOICE_ENROLL_MIGRATION_LIVE_ONLY");
  assert.equal(seen.length, 0);
});

// --- adaptér: feed ---------------------------------------------------------------------
await check("feed: GET /v1/agent/events bez X-Organization-Id, kurzor validovaný, chybné záznamy preskočené", async () => {
  const { p, seen } = providerWith(() => json(200, { data: [
    { id: "11", event: "participant.activated", event_id: null, org_id: ORG, created_at: "2026-10-05T00:00:00Z", payload: { event: "participant.activated", timestamp: "t", data: { orgId: ORG } } },
    { id: "x", event: "e", payload: {} },
    { id: "12", event: "e" },
  ], next_after: "11", has_more: false }));
  const r = await p.listPartnerEvents({ after: "10", limit: 9999 });
  assert.equal(r.events.length, 1);
  assert.equal(r.nextAfter, "11");
  const u = new URL(seen[0].url);
  assert.equal(u.pathname, "/v1/agent/events");
  assert.equal(u.searchParams.get("after"), "10");
  assert.equal(u.searchParams.get("limit"), "500");
  assert.equal(new Headers(seen[0].init.headers).get("X-Organization-Id"), null);
  assert.equal((await p.listPartnerEvents({ after: "1; drop" }).catch((e) => e)).code, "EINVOICE_INVALID_ID");
});

// --- klasifikácia ----------------------------------------------------------------------
await check("klasifikácia: participant.* PRED outbound (regresia: participant.failed nebol outbound)", () => {
  assert.equal(classifyWebhookEvent("participant.failed"), "participant");
  assert.equal(classifyWebhookEvent("participant.activated"), "participant");
  assert.equal(classifyWebhookEvent("participant.deactivated"), "participant");
  assert.equal(classifyWebhookEvent("peppol.document.failed"), "outbound");
  assert.equal(classifyWebhookEvent("peppol.document.sent"), "outbound");
  assert.equal(classifyWebhookEvent("peppol.document.delivered"), "outbound");
  assert.equal(classifyWebhookEvent("peppol.document.received"), "inbound");
  assert.equal(classifyWebhookEvent("usage.limit_exceeded"), "other");
  assert.equal(classifyWebhookEvent("webhook.test"), "other");
});

// --- DB pravidlá -----------------------------------------------------------------------
const h = await createPartnerHarness();
const CA = "a1000000-0000-4000-8000-000000000001";
const CB = "b1000000-0000-4000-8000-000000000002";
const UA = "11000000-0000-4000-8000-000000000001";
const UB = "21000000-0000-4000-8000-000000000001";
await h.exec(`
  insert into auth.users (id) values ('${UA}'), ('${UB}');
  insert into public.companies (id, name) values ('${CA}', 'A'), ('${CB}', 'B');
  insert into public.company_members (company_id, user_id, role, permissions) values ('${CA}', '${UA}', 'owner', '{}'), ('${CB}', '${UB}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code)
    values ('${CA}', 'Test A s.r.o.', '87654326', '2012345678', 'SK2012345678', 'Ulica 1', 'Bratislava', '81101', 'SK'),
           ('${CB}', 'Test B s.r.o.', '35759500', null, null, 'Ulica 2', 'Košice', '04001', 'SK');
`);
const upsert = (company: string, org: string, extra: Record<string, string> = {}) =>
  h.asService(() => h.db.query("select * from public.esblu_einvoice_org_upsert_provisioned($1,'efaktura_sk','sandbox',$2,null,null,null,null,false,$3::jsonb)", [company, org, JSON.stringify({ legal_name: "X", ...extra })]));
const org = async (c: string) => (await h.sql<Record<string, unknown>>("select * from public.einvoice_organizations where company_id = $1", [c])).rows[0];

await check("DB: upsert mapovania → pending; opakovanie idempotentné; iný org pre tú istú firmu → IDENTITY_IMMUTABLE", async () => {
  const r1 = await upsert(CA, "org-a-1");
  const r2 = await upsert(CA, "org-a-1");
  assert.equal((r1.rows[0] as { created: boolean }).created, true);
  assert.equal((r2.rows[0] as { created: boolean }).created, false);
  assert.equal((await org(CA)).reception_status, "pending");
  const err = await upsert(CA, "org-a-OTHER").then(() => "", (e) => String(e.message));
  assert.match(err, /IDENTITY_IMMUTABLE/);
});
await check("DB: snapshot s neočakávaným kľúčom (napr. token) → odmietnuté", async () => {
  const err = await upsert(CB, "org-b-1", { verification_token: "a1b2c3" }).then(() => "", (e) => String(e.message));
  assert.match(err, /INVALID_INPUT/);
});
const applyEnroll = (orgId: string, outcome: string, participant: string | null, err: string | null = null) =>
  h.asService(() => h.db.query("select * from public.esblu_einvoice_org_apply_enroll('efaktura_sk','sandbox',$1,$2,$3,$4,$5)", [orgId, outcome, participant, outcome === "send_only" ? "Iný poštár / ap.example" : null, err]));
const participantEvent = (orgId: string, event: string, participant: string | null, code: string | null, at: string | null) =>
  h.asService(() => h.db.query<{ applied: boolean; reception_status: string; company_id: string | null }>("select * from public.esblu_einvoice_org_participant_event('efaktura_sk','sandbox',$1,$2,$3,$4,$5)", [orgId, event, participant, code, at]));

await check("DB: enroll failed → failed, neeligible; enrolled → active + participant; neskorší failed NEZHORŠÍ active", async () => {
  await applyEnroll("org-a-1", "failed", null, "VERIFICATION_TOKEN_INVALID");
  let o = await org(CA);
  assert.equal(o.reception_status, "failed");
  assert.equal(o.peppol_eligible, false);
  await applyEnroll("org-a-1", "enrolled", "9915:2012345678");
  o = await org(CA);
  assert.equal(o.reception_status, "active");
  assert.equal(o.participant_id, "9915:2012345678");
  assert.equal(o.peppol_eligible, true);
  assert.equal(o.reception_error_code, null);
  await applyEnroll("org-a-1", "failed", null, "VERIFICATION_TOKEN_INVALID");
  o = await org(CA);
  assert.equal(o.reception_status, "active");
  // Staging E2E nález (20261005110000): aktívny príjem nedostane chybový kód neplatného FS kódu.
  assert.equal(o.reception_error_code, null);
});
await check("DB: send_only → send_only, odosielanie povolené, held_by uložené, kód PARTICIPANT_HELD_ELSEWHERE", async () => {
  await upsert(CB, "org-b-1");
  await applyEnroll("org-b-1", "send_only", "9915:2099999998");
  const o = await org(CB);
  assert.equal(o.reception_status, "send_only");
  assert.equal(o.peppol_eligible, true);
  assert.equal(o.reception_error_code, "PARTICIPANT_HELD_ELSEWHERE");
  assert.ok(o.reception_held_by);
  const view = receptionView({ providerOrgId: "org-b-1", participantId: "9915:2099999998", peppolEligible: true, receptionStatus: "send_only", receptionErrorCode: "PARTICIPANT_HELD_ELSEWHERE" });
  assert.equal(view.receivingActive, false);
  assert.equal(view.sendingEnabled, true);
});
await check("DB: participant udalosti — stará udalosť ignorovaná, neznáma org bez firmy, deactivated vypne odosielanie", async () => {
  const t1 = "2026-10-05T10:00:00Z";
  const t0 = "2026-10-05T09:00:00Z";
  const a = await participantEvent("org-b-1", "participant.activated", "9915:2099999998", null, t1);
  assert.equal(a.rows[0].applied, true);
  assert.equal((await org(CB)).reception_status, "active");
  const stale = await participantEvent("org-b-1", "participant.failed", null, "PARTICIPANT_HELD_ELSEWHERE", t0);
  assert.equal(stale.rows[0].applied, false);
  assert.equal((await org(CB)).reception_status, "active");
  const unknown = await participantEvent("org-nope", "participant.activated", null, null, t1);
  assert.equal(unknown.rows[0].applied, false);
  assert.equal(unknown.rows[0].company_id, null);
  await participantEvent("org-b-1", "participant.deactivated", null, null, "2026-10-05T11:00:00Z");
  const o = await org(CB);
  assert.equal(o.reception_status, "deactivated");
  assert.equal(o.peppol_eligible, false);
  const bad = await participantEvent("org-b-1", "participant.unknown", null, null, null).then(() => "", (e) => String(e.message));
  assert.match(bad, /INVALID_INPUT/);
});
await check("DB: authenticated/anon NEMÔŽU volať onboarding RPC; firma B nevidí org firmy A", async () => {
  for (const uid of [UA, null]) {
    for (const q of [
      "select public.esblu_einvoice_org_apply_enroll('efaktura_sk','sandbox','org-a-1','enrolled',null,null,null)",
      "select public.esblu_einvoice_org_participant_event('efaktura_sk','sandbox','org-a-1','participant.activated',null,null,null)",
      `select public.esblu_einvoice_org_upsert_provisioned('${CA}','efaktura_sk','sandbox','org-a-1',null,null,null,null,true,null)`,
    ]) {
      const err = await h.as(uid, () => h.db.query(q)).then(() => "", (e) => String(e.message));
      assert.match(err, /permission denied/i, q.slice(0, 60));
    }
  }
  const seen = (await h.as(UB, () => h.db.query<{ c: string }>("select company_id c from public.einvoice_organizations"))).rows.map((r) => r.c);
  assert.ok(!seen.includes(CA));
});
await check("poll príjmu: iba active (a legacy NULL); send_only / failed / deactivated / pending vynechané", async () => {
  const list = await h.inbound.listOrganizations("efaktura_sk", "sandbox");
  assert.deepEqual(list.map((o) => o.companyId), [CA]);
});

// --- webhook participant bez podpory v store -------------------------------------------
await check("webhook: store bez participantEvent → IGNORED (EVENT_NOT_HANDLED), nič sa nemení", async () => {
  const { participantEvent: _omit, ...rest } = h.inbound;
  void _omit;
  const deps: WebhookDeps = { inbound: rest, outbound: h.outbound, provider: { name: "efaktura_sk" } as WebhookDeps["provider"], environment: "sandbox", secrets: ["s"], nowSeconds: () => 0 };
  const r = await processProviderEvent(deps, { deliveryId: "d-1", payload: { event: "participant.activated", data: { orgId: "org-a-1", mode: "test" } }, bodySha256: "0".repeat(64) });
  assert.equal(r.body.code, "IGNORED");
});
await check("webhook: participant udalosť z live siete v sandbox prostredí → IGNORED (ENVIRONMENT_MISMATCH)", async () => {
  const deps: WebhookDeps = { inbound: h.inbound, outbound: h.outbound, provider: { name: "efaktura_sk" } as WebhookDeps["provider"], environment: "sandbox", secrets: ["s"], nowSeconds: () => 0 };
  const before = (await org(CA)).reception_status;
  const r = await processProviderEvent(deps, { deliveryId: "d-2", payload: { event: "participant.deactivated", data: { orgId: "org-a-1", mode: "live" } }, bodySha256: "1".repeat(64) });
  assert.equal(r.body.code, "IGNORED");
  assert.equal((await org(CA)).reception_status, before);
});

// --- onboarding služba ----------------------------------------------------------------
await check("withRetry: retryable chyba sa zopakuje s backoffom; neretryable nie", async () => {
  let n = 0;
  const waits: number[] = [];
  const v = await withRetry(async () => { if (++n < 3) throw new EinvoiceProviderError("X", "x", true); return 7; }, async (ms) => { waits.push(ms); });
  assert.equal(v, 7);
  assert.deepEqual(waits, [500, 2000]);
  let m = 0;
  await withRetry(async () => { m++; throw new EinvoiceProviderError("Y", "y", false); }, async () => {}).catch(() => {});
  assert.equal(m, 1);
});
await check("provisionCompany: bez DIČ → DIC_REQUIRED_FOR_PEPPOL bez volania poskytovateľa; 503 pri založení sa zopakuje (idempotentné podľa IČO)", async () => {
  const fake = createFakeSandbox({});
  let fail = 1;
  const p = new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: async (u, i) => (new URL(u).pathname === "/v1/agent/organizations" && fail-- > 0 ? json(503, { error: { code: "U", message: "u" } }) : fake.fetch(u, i)) });
  const deps = { store: h.onboarding, provider: p, environment: "sandbox" as const, sleep: async () => {} };
  const noDic = await provisionCompany(deps, CB);
  // CB už má org-b-1 z DB testov — overujeme vetvu bez DIČ na čerstvej firme:
  assert.ok(noDic.ok === false && noDic.code === "DIC_REQUIRED_FOR_PEPPOL");
  const CC = "c1000000-0000-4000-8000-000000000003";
  await h.exec(`insert into public.companies (id, name) values ('${CC}', 'C');
    insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code)
    values ('${CC}', 'Test C s.r.o.', '12345679', '2055555555', 'SK2055555555', 'Ulica 3', 'Nitra', '94901', 'SK');`);
  const r = await provisionCompany(deps, CC);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(fake.requests.filter((x) => x.path === "/v1/agent/organizations").length, 1);
});
await check("enrollCompany: 503 sa NEopakuje automaticky a stav sa nemení; token sa nikam neuloží", async () => {
  const CC = "c1000000-0000-4000-8000-000000000003";
  let calls = 0;
  const p = new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: async () => { calls++; return json(503, { error: { code: "U", message: "u" } }); } });
  const before = (await org(CC)).reception_status;
  const r = await enrollCompany({ store: h.onboarding, provider: p, environment: "sandbox" }, CC, "abcdef0123");
  assert.ok(!r.ok && r.retryable);
  assert.equal(calls, 1);
  assert.equal((await org(CC)).reception_status, before);
  const dump = JSON.stringify((await h.sql("select * from public.einvoice_organizations")).rows);
  assert.ok(!dump.includes("abcdef0123"));
});
await check("enrollCompany: neplatný FS kód pri aktívnom príjme → active, view bez chybového kódu (staging E2E nález)", async () => {
  const p = new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: async () => json(400, { error: { code: "VALIDATION_ERROR", message: "bad" } }) });
  assert.equal((await org(CA)).reception_status, "active");
  const r = await enrollCompany({ store: h.onboarding, provider: p, environment: "sandbox" }, CA, "000000000000dead");
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.code, "EINVOICE_ENROLL_TOKEN_INVALID");
  assert.equal(r.reception?.state, "active");
  assert.equal(r.reception?.receivingActive, true);
  assert.equal(r.reception?.errorCode, null);
  assert.equal((await org(CA)).reception_error_code, null);
});

// --- regresia úniku tajomstiev (statická) ----------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|md|sql|json|txt)$/.test(name)) out.push(full);
  }
  return out;
}
await check("únik: žiadny skutočný kľúč / webhook secret / SAPI secret v zdrojoch, docs ani testoch", () => {
  const files = [...walk("lib"), ...walk("app"), ...walk("scripts"), ...walk("docs"), ...walk("supabase")];
  // Zjavne falošné testovacie hodnoty (CANARY, wrong, fake, opakované znaky) sú povolené.
  const FAKE = /(CANARY|wrong|fake|dummy|local|example|(.)\2{7,})/i;
  const offenders = files.flatMap((f) => {
    const t = readFileSync(f, "utf8");
    const hits = [...t.matchAll(/efk_(?:pk_)?(?:test|live)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{24,}|sapi_(?:live|test)_[A-Za-z0-9]{12,}/g)].map((m) => m[0]);
    return hits.filter((v) => !FAKE.test(v)).map(() => f);
  });
  assert.deepEqual(offenders, []);
});
await check("únik: kľúč iba server-side — žiadne NEXT_PUBLIC_*EFAKTURA*, klientske komponenty neimportujú provider/onboarding", () => {
  const files = [...walk("lib"), ...walk("app")];
  assert.deepEqual(files.filter((f) => /NEXT_PUBLIC_[A-Z_]*(EFAKTURA|EINVOICE)/.test(readFileSync(f, "utf8"))), []);
  const client = files.filter((f) => /^\s*["']use client["']/m.test(readFileSync(f, "utf8")));
  assert.deepEqual(client.filter((f) => /einvoice\/(provider|onboarding|inbound\/webhook)/.test(readFileSync(f, "utf8"))), []);
  for (const f of ["lib/einvoice/provider/efaktura-sk.ts", "lib/einvoice/provider/index.ts", "lib/einvoice/onboarding.ts", "lib/einvoice/onboarding-supabase-store.ts", "lib/einvoice/inbound/webhook.ts"]) {
    assert.match(readFileSync(f, "utf8"), /^import "server-only";/m, f);
  }
});
await check("únik: E-Faktúra runtime kód nič nelogovať (žiadne console.*) a .env* je v .gitignore", () => {
  const files = [...walk("lib/einvoice"), ...walk("app/api/einvoice")];
  assert.deepEqual(files.filter((f) => /\bconsole\.(log|info|warn|error|debug)\(/.test(readFileSync(f, "utf8"))), []);
  assert.match(readFileSync(".gitignore", "utf8"), /^\.env\*$/m);
});

console.log(`einvoice-partner: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
