// =============================================================================
// E-Faktúra — SANDBOX E2E pre API PARTNER účet eFaktura.sk („Sandbox ako produkcia").
//
// RUČNÉ spúšťanie. Reálne volania IBA na sandbox (kľúč efk_pk_test_…).
// NIE JE súčasťou CI. Produkciu sa nedotýka (PGlite v pamäti, žiadna Supabase).
//
// Pokrýva zadanie D–J:
//   D  POST /v1/agent/organizations — firmy A, B (+ C pre neplatný kód, D pre send_only),
//      mapovanie v Esblu, idempotencia (rovnaké IČO → reused, žiadny duplicitný riadok)
//   E  POST /v1/agent/peppol/enroll  a1b2c3 → enrolled, participant.activated, opakovanie bez duplicít
//   F  000000000000dead → 400, participant.failed, príjem neaktívny, opakovanie bezpečné
//   G  000000000000beef → send_only, príjem NEaktívny, odosielanie povolené, poll ho vynechá
//   H  webhook handler: každá udalosť z feedu (telo = presne telo webhooku), HMAC, replay, duplicity
//   I  A → B: UBL (EN 16931), identifikátory 9915:DIČ, sumy/DPH, send, sent/delivered, retry bez duplicity
//   J  B: GET /peppol/received + peppol.document.received → XML, koncept na kontrolu,
//      auto-založenie dodávateľa, duplicitný doklad, izolácia firiem
//
// Poistky: --confirm-sandbox; ESBLU_EINVOICE_ENVIRONMENT=sandbox; kľúč efk_pk_test_…
// (live kľúč → koniec pred akýmkoľvek volaním); fetch allowlist (žiadne deactivate,
// migration-out, webhooks, invoices, csv…); iba syntetické firmy; výstup bez kľúča,
// tokenov, XML a PII (iba stavy, kódy, počty, prefixy hashov).
//
// Použitie (PowerShell, koreň worktree, kľúč v .env.local):
//   node --env-file=.env.local --experimental-strip-types --no-warnings `
//     --import ./scripts/alias-loader.mjs scripts/einvoice-partner-sandbox-e2e.ts --confirm-sandbox
// Voliteľne: --seed=<text> (iné syntetické IČO/DIČ, ak by kolidovali v TEST SMP), --report=<cesta>
// Offline (bez siete a kľúča): npm run test:einvoice-partner-e2e-selftest
// =============================================================================

import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPartnerHarness, icoWithChecksum, type Row } from "./einvoice-partner-harness.ts";
import { createFakeSandbox } from "./einvoice-partner-fake-sandbox.ts";
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import type { PartnerEvent } from "../lib/einvoice/provider/types.ts";
import { enrollCompany, provisionCompany, receptionView } from "../lib/einvoice/onboarding.ts";
import { handleEinvoiceWebhook, processPartnerEventPage, type WebhookDeps } from "../lib/einvoice/inbound/webhook.ts";
import { handleOutboundSendRequest } from "../lib/einvoice/outbound/route-handler.ts";
import { loadEinvoiceReadiness } from "../lib/einvoice/readiness-server.ts";
import { runOutboundReconcileBatch, runOutboundSendBatch } from "../lib/einvoice/outbound/worker.ts";
import { runInboundPoll, runInboundProcessBatch } from "../lib/einvoice/inbound/processor.ts";
import { parseInboundUbl } from "../lib/einvoice/ubl/parse.ts";

// -----------------------------------------------------------------------------
// Argumenty a poistky (pred čímkoľvek iným)
// -----------------------------------------------------------------------------
const ARGS = new Map<string, string>();
for (const raw of process.argv.slice(2)) {
  const [k, ...v] = raw.replace(/^--/, "").split("=");
  ARGS.set(k, v.join("=") || "true");
}
function stop(message: string): never {
  console.error(`STOP: ${message}`);
  process.exit(2);
}
const SELFTEST = ARGS.get("offline-selftest") === "true";
if (!SELFTEST && ARGS.get("confirm-sandbox") !== "true") stop("chýba --confirm-sandbox (reálne volania sandbox API)");
if (!SELFTEST && process.env.ESBLU_EINVOICE_ENVIRONMENT?.trim() !== "sandbox") stop("ESBLU_EINVOICE_ENVIRONMENT musí byť 'sandbox'");
if (!SELFTEST && process.env.ESBLU_EINVOICE_LIVE_ENABLED?.trim()) stop("ESBLU_EINVOICE_LIVE_ENABLED nesmie byť nastavené pri sandbox E2E");
const KEY = SELFTEST ? "efk_pk_test_" + "0".repeat(24) : (process.env.ESBLU_EFAKTURA_API_KEY?.trim() ?? "");
if (!KEY.startsWith("efk_pk_test_")) stop("ESBLU_EFAKTURA_API_KEY chýba alebo nie je sandbox partner kľúč (efk_pk_test_…)");
if (!SELFTEST && process.env.ESBLU_EFAKTURA_BASE_URL?.trim() && !/^https:\/\/api\.efaktura\.sk\/?$/.test(process.env.ESBLU_EFAKTURA_BASE_URL.trim())) {
  stop("ESBLU_EFAKTURA_BASE_URL musí byť https://api.efaktura.sk alebo nenastavené");
}

const SEED = ARGS.get("seed") ?? "esblu-partner-sandbox-1";
const digits = (label: string, n: number) => {
  const h = createHash("sha256").update(`${SEED}:${label}`).digest();
  let s = "";
  for (let i = 0; s.length < n; i++) s += String(h[i % h.length] % 10);
  return s;
};
const ident = (label: string) => {
  const dic = `20${digits(`${label}:dic`, 8)}`;
  return { ico: icoWithChecksum(`3${digits(`${label}:ico`, 6)}`), dic, icDph: `SK${dic}`, participant: `9915:${dic}` };
};
const ID = { A: ident("A"), B: ident("B"), C: ident("C"), D: ident("D") };
const TOKENS = { ok: "a1b2c3", invalid: "000000000000dead", sendOnly: "000000000000beef" } as const;
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const RUN = Date.now().toString(36).toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, SELFTEST ? 1 : ms));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const idHash = (v: unknown) => (typeof v === "string" && v ? `sha256:${sha(v).slice(0, 12)}` : null);

// -----------------------------------------------------------------------------
// Poskytovateľ za allowlistom (reálny sandbox alebo fake)
// -----------------------------------------------------------------------------
const fake = SELFTEST ? createFakeSandbox() : null;
const ALLOWED: [string, RegExp][] = [
  ["POST", /^\/v1\/agent\/organizations$/],
  ["GET", /^\/v1\/agent\/organizations\/[0-9a-f-]{36}$/],
  ["POST", /^\/v1\/agent\/peppol\/enroll$/],
  ["GET", /^\/v1\/agent\/events$/],
  ["GET", /^\/v1\/agent\/peppol\/recipient$/],
  ["POST", /^\/v1\/agent\/peppol\/preflight$/],
  ["POST", /^\/v1\/agent\/peppol\/connector\/send$/],
  ["GET", /^\/v1\/agent\/peppol\/status\/[^/]+$/],
  ["GET", /^\/v1\/agent\/peppol\/sent\/[^/]+\/evidence$/],
  ["GET", /^\/v1\/agent\/peppol\/received$/],
  ["GET", /^\/v1\/agent\/peppol\/received\/[^/]+\/xml$/],
  ["POST", /^\/v1\/agent\/peppol\/received\/[^/]+\/acknowledge$/],
];
const calls: { method: string; path: string; status: number }[] = [];
const sendCalls: { org: string | null; status: number }[] = [];
const guardedFetch = async (input: string, init: RequestInit): Promise<Response> => {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  if (url.hostname !== "api.efaktura.sk") stop(`host ${url.hostname} nie je povolený`);
  if (!ALLOWED.some(([m, re]) => m === method && re.test(url.pathname))) stop(`${method} ${url.pathname} nie je na allowliste`);
  const res = fake ? await fake.fetch(input, init) : await fetch(input, init);
  const p = url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id");
  calls.push({ method, path: p, status: res.status });
  if (p.endsWith("/connector/send")) sendCalls.push({ org: idHash(new Headers(init.headers).get("X-Organization-Id")), status: res.status });
  return res;
};
const provider = new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: guardedFetch, timeoutMs: 30_000 });

// -----------------------------------------------------------------------------
// Esblu strana: PGlite so všetkými migráciami + syntetické firmy
// -----------------------------------------------------------------------------
const h = await createPartnerHarness();
const { sql, as, userDb } = h;
const CO = {
  A: "a0000000-0000-4000-8000-00000000000a",
  B: "b0000000-0000-4000-8000-00000000000b",
  C: "c0000000-0000-4000-8000-00000000000c",
  D: "d0000000-0000-4000-8000-00000000000d",
};
const U = {
  A: "10000000-0000-4000-8000-00000000000a",
  B: "10000000-0000-4000-8000-00000000000b",
  C: "10000000-0000-4000-8000-00000000000c",
  D: "10000000-0000-4000-8000-00000000000d",
  empA: "10000000-0000-4000-8000-0000000000ea",
};
const PARTNER_B_IN_A = "e0000000-0000-4000-8000-0000000000b1";
const NAMES = { A: "Esblu Sandbox A s.r.o.", B: "Esblu Sandbox B s.r.o.", C: "Esblu Sandbox C s.r.o.", D: "Esblu Sandbox D s.r.o." };
const billing = (k: keyof typeof ID, street: string, city: string, psc: string) =>
  `('${CO[k]}', '${NAMES[k]}', '${ID[k].ico}', '${ID[k].dic}', '${ID[k].icDph}', '${street}', '${city}', '${psc}', 'SK', null, '${ID[k].dic}', '9915')`;
await h.exec(`
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into public.companies (id, name) values ('${CO.A}', 'Sandbox A'), ('${CO.B}', 'Sandbox B'), ('${CO.C}', 'Sandbox C'), ('${CO.D}', 'Sandbox D');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CO.A}', '${U.A}', 'owner', '{}'), ('${CO.A}', '${U.empA}', 'employee', '{}'),
    ('${CO.B}', '${U.B}', 'owner', '{}'), ('${CO.C}', '${U.C}', 'owner', '{}'), ('${CO.D}', '${U.D}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code,
      country_code, contact_email, electronic_address, electronic_address_scheme_id)
    values ${billing("A", "Testovacia 1", "Bratislava", "81101")}, ${billing("B", "Skúšobná 2", "Košice", "04001")},
           ${billing("C", "Pokusná 3", "Nitra", "94901")}, ${billing("D", "Overovacia 4", "Žilina", "01001")};
  insert into public.business_partners (id, company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city,
      postal_code, country_code, electronic_address, electronic_address_scheme_id)
    values ('${PARTNER_B_IN_A}', '${CO.A}', 'customer', '${NAMES.B}', '${ID.B.ico}', '${ID.B.dic}', '${ID.B.icDph}',
      'Skúšobná 2', 'Košice', '04001', 'SK', '${ID.B.dic}', '9915');
  insert into public.company_entitlements (company_id, entitlement_key, source, note)
    values ('${CO.A}', 'einvoice', 'manual', 'partner-e2e'), ('${CO.B}', 'einvoice', 'manual', 'partner-e2e');
  insert into public.einvoice_rollout (company_id, environment, stage, changed_by)
    values ('${CO.A}', 'sandbox', 'internal', 'partner-e2e'), ('${CO.B}', 'sandbox', 'internal', 'partner-e2e');
  insert into public.invoice_number_sequences (company_id, year, series_key, prefix)
    values ('${CO.A}', ${TODAY.slice(0, 4)}, 'regular', 'PE2E${RUN}-');
`);

const onboardingDeps = { store: h.onboarding, provider, environment: "sandbox" as const, sleep: (ms: number) => sleep(ms) };
const inboundDeps = { store: h.inbound, provider, environment: "sandbox" as const };
const workerDeps = { store: h.outbound, provider };
const WOPTS = { batchSize: 10, leaseSeconds: 120, reconcileAfterSeconds: 0 };
const ENV = { ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox", ESBLU_EFAKTURA_API_KEY: KEY };
const LOCAL_SECRET = `whsec_local_partner_e2e_${randomUUID()}`;
const webhookDeps: WebhookDeps = { inbound: h.inbound, outbound: h.outbound, provider, environment: "sandbox", secrets: [LOCAL_SECRET], nowSeconds: () => Math.floor(Date.now() / 1000) };
const orgRow = async (c: string) => (await sql<Row>("select * from public.einvoice_organizations where company_id = $1 and environment = 'sandbox'", [c])).rows[0] ?? null;
const orgIdOf = async (c: string) => String((await orgRow(c))?.provider_org_id ?? "");

// -----------------------------------------------------------------------------
// Výsledky
// -----------------------------------------------------------------------------
type Verdict = "PASS" | "FAIL" | "PARTIAL" | "SKIP";
const results: { id: string; label: string; verdict: Verdict; evidence: Record<string, unknown> }[] = [];
const verdictOf = (id: string) => results.find((r) => r.id === id)?.verdict;
async function step(id: string, label: string, requires: string[], fn: () => Promise<Record<string, unknown> | { verdict: Verdict; evidence: Record<string, unknown> }>) {
  const blocked = requires.filter((r) => verdictOf(r) !== "PASS" && verdictOf(r) !== "PARTIAL");
  if (blocked.length) {
    results.push({ id, label, verdict: "SKIP", evidence: { blocked_by: blocked } });
    console.log(`SKIP    ${id} ${label}  (BLOCKED_BY ${blocked.join(",")})`);
    return;
  }
  try {
    const out = await fn();
    const w = "verdict" in out && "evidence" in out ? (out as { verdict: Verdict; evidence: Record<string, unknown> }) : { verdict: "PASS" as Verdict, evidence: out };
    results.push({ id, label, ...w });
    console.log(`${w.verdict.padEnd(7)} ${id} ${label}`);
  } catch (error) {
    const message = (error instanceof Error ? error.message.split("\n")[0] : String(error)).slice(0, 300);
    results.push({ id, label, verdict: "FAIL", evidence: { error: message } });
    console.log(`FAIL    ${id} ${label}\n        ${message}`);
  }
}

/** Partnerský feed — všetky udalosti našich syntetických organizácií (bez tiel do reportu). */
const feedSeen: PartnerEvent[] = [];
let feedCursor: string | undefined;
async function pullFeed(): Promise<void> {
  const ours = new Set((await sql<{ o: string }>("select provider_org_id o from public.einvoice_organizations where provider_org_id is not null")).rows.map((r) => r.o));
  for (let page = 0; page < 200; page++) {
    const res = await provider.listPartnerEvents({ after: feedCursor, limit: 500 });
    for (const e of res.events) if (e.orgId && ours.has(e.orgId) && !feedSeen.some((x) => x.id === e.id)) feedSeen.push(e);
    if (res.nextAfter) feedCursor = res.nextAfter;
    if (!res.hasMore) break;
  }
}
async function waitFeed(pred: (e: PartnerEvent) => boolean, tries = 12): Promise<PartnerEvent[]> {
  for (let i = 0; i < tries; i++) {
    await pullFeed();
    const hit = feedSeen.filter(pred);
    if (hit.length) return hit;
    await sleep(5_000);
  }
  return [];
}
const dataOf = (e: PartnerEvent) => (e.payload.data ?? {}) as Record<string, unknown>;

// =============================================================================
// D — organizácie
// =============================================================================
await step("D1", "POST /organizations firma A → org ID + mapovanie v Esblu (reception pending)", [], async () => {
  const r = await provisionCompany(onboardingDeps, CO.A);
  assert.ok(r.ok, JSON.stringify(r));
  const row = await orgRow(CO.A);
  assert.ok(row?.provider_org_id, "mapovanie");
  assert.equal(row!.reception_status, "pending");
  const http = calls.filter((c) => c.path === "/v1/agent/organizations").map((c) => c.status);
  return { http_status: http, org: idHash(row!.provider_org_id), reused_by_provider: r.ok && r.reused, participant_after_create: row!.participant_id ? "set (lenient sandbox?)" : null };
});
await step("D2", "idempotencia: opakované založenie A (aj priamo u poskytovateľa) → ten istý org, žiadny duplicitný riadok", ["D1"], async () => {
  const before = await orgIdOf(CO.A);
  const again = await provisionCompany(onboardingDeps, CO.A);
  const direct = await provider.provisionOrganization({ environment: "sandbox", legalName: NAMES.A, ico: ID.A.ico, dic: ID.A.dic, icDph: ID.A.icDph, address: { street: "Testovacia 1", city: "Bratislava", postalCode: "81101", countryCode: "SK" } });
  const n = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_organizations where company_id = $1", [CO.A])).rows[0].n;
  assert.ok(again.ok);
  assert.equal(direct.providerOrgId, before, "poskytovateľ vrátil iný org pre to isté IČO");
  assert.equal(direct.reused, true);
  assert.equal(n, 1);
  return { same_org: true, provider_reused: direct.reused, esblu_rows: n };
});
await step("D3", "POST /organizations firma B (+ C, D pre negatívne scenáre)", [], async () => {
  const out: Record<string, unknown> = {};
  for (const k of ["B", "C", "D"] as const) {
    const r = await provisionCompany(onboardingDeps, CO[k]);
    assert.ok(r.ok, `${k}: ${JSON.stringify(r)}`);
    out[k] = { org: idHash(await orgIdOf(CO[k])), reception: (await orgRow(CO[k]))?.reception_status };
  }
  const distinct = new Set(await Promise.all([CO.A, CO.B, CO.C, CO.D].map(orgIdOf)));
  assert.equal(distinct.size, 4);
  return out;
});

// =============================================================================
// E — enroll success
// =============================================================================
await step("E1", "enroll A (a1b2c3) → enrolled, 9915:DIČ_A, príjem aktívny", ["D1"], async () => {
  const r = await enrollCompany(onboardingDeps, CO.A, TOKENS.ok);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return {};
  const row = await orgRow(CO.A);
  if (r.status === "send_only") return { verdict: "FAIL", evidence: { status: r.status, hint: "syntetické DIČ koliduje v TEST SMP — spusti znova s --seed=<iný text>" } };
  assert.equal(r.status, "enrolled");
  assert.equal(row!.participant_id, ID.A.participant);
  assert.equal(row!.reception_status, "active");
  assert.equal(r.reception.receivingActive, true);
  return { status: r.status, participant_scheme: String(row!.participant_id).slice(0, 4), reception: row!.reception_status, warnings: r.warnings };
});
await step("E2", "enroll B (a1b2c3) → enrolled, príjem aktívny", ["D3"], async () => {
  const r = await enrollCompany(onboardingDeps, CO.B, TOKENS.ok);
  assert.ok(r.ok && r.status === "enrolled", JSON.stringify(r));
  const row = await orgRow(CO.B);
  assert.equal(row!.participant_id, ID.B.participant);
  assert.equal(row!.reception_status, "active");
  return { status: "enrolled", reception: row!.reception_status };
});
await step("E3", "opakovaný enroll A → stále enrolled/active, jeden riadok", ["E1"], async () => {
  const r = await enrollCompany(onboardingDeps, CO.A, TOKENS.ok);
  assert.ok(r.ok && r.status === "enrolled", JSON.stringify(r));
  const n = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_organizations where company_id = $1", [CO.A])).rows[0].n;
  assert.equal(n, 1);
  assert.equal((await orgRow(CO.A))!.reception_status, "active");
  return { status: r.status, rows: n };
});
await step("E4", "participant.activated pre A a B vo feede → spracované; opätovné spracovanie = DUPLICATE", ["E1", "E2"], async () => {
  const a = await orgIdOf(CO.A);
  const b = await orgIdOf(CO.B);
  const hits = await waitFeed((e) => e.event === "participant.activated" && (e.orgId === a || e.orgId === b));
  const forA = hits.filter((e) => e.orgId === a);
  const forB = hits.filter((e) => e.orgId === b);
  if (!forA.length || !forB.length) return { verdict: "FAIL", evidence: { activated_A: forA.length, activated_B: forB.length, note: "participant.activated sa vo feede neobjavil do ~60 s" } };
  const first = await processPartnerEventPage(webhookDeps, { events: [...forA, ...forB] });
  const second = await processPartnerEventPage(webhookDeps, { events: [...forA, ...forB] });
  assert.ok(first.results.every((r) => r.code === "PARTICIPANT_UPDATED"), JSON.stringify(first.results));
  assert.ok(second.results.every((r) => r.code === "DUPLICATE"), JSON.stringify(second.results));
  assert.equal((await orgRow(CO.A))!.reception_status, "active");
  return { activated_A: forA.length, activated_B: forB.length, mode: dataOf(forA[0]).mode ?? null, source: dataOf(forA[0]).source ?? null, first: first.results.map((r) => r.code), replay: second.results.map((r) => r.code) };
});

// =============================================================================
// F — neplatný kód
// =============================================================================
await step("F1", "enroll C 000000000000dead → 400, príjem failed, žiadny aktívny participant", ["D3"], async () => {
  const r = await enrollCompany(onboardingDeps, CO.C, TOKENS.invalid);
  assert.equal(r.ok, false);
  if (r.ok) return {};
  const http = calls.filter((c) => c.path === "/v1/agent/peppol/enroll").at(-1)?.status;
  const row = await orgRow(CO.C);
  assert.equal(http, 400);
  assert.equal(r.code, "EINVOICE_ENROLL_TOKEN_INVALID");
  assert.equal(row!.reception_status, "failed");
  assert.equal(row!.reception_error_code, "VERIFICATION_TOKEN_INVALID");
  assert.equal(row!.peppol_eligible, false);
  assert.equal(r.reception?.receivingActive, false);
  return { http_status: http, code: r.code, reception: row!.reception_status, error_code: row!.reception_error_code, receiving_active: false, sending_enabled: r.reception?.sendingEnabled ?? null };
});
await step("F2", "opakovanie dead → rovnaký výsledok, bezpečné; neplatný kód nezhorší aktívnu firmu A", ["F1", "E1"], async () => {
  const again = await enrollCompany(onboardingDeps, CO.C, TOKENS.invalid);
  assert.equal(again.ok, false);
  const onA = await enrollCompany(onboardingDeps, CO.A, TOKENS.invalid);
  const a = await orgRow(CO.A);
  assert.equal(onA.ok, false);
  assert.equal(a!.reception_status, "active", "neplatný kód zhoršil aktívny príjem");
  // Ak poskytovateľ pošle participant.failed aj pre aktívnu A, spracovanie ju nesmie zhoršiť.
  const aId = await orgIdOf(CO.A);
  const aFailed = await waitFeed((e) => e.event === "participant.failed" && e.orgId === aId, 2);
  if (aFailed.length) await processPartnerEventPage(webhookDeps, { events: aFailed });
  const a2 = await orgRow(CO.A);
  assert.equal(a2!.reception_status, "active", "participant.failed zhoršil aktívny príjem");
  return { c_again: again.ok ? "ok" : again.code, a_after_invalid: a!.reception_status, a_participant_failed_events: aFailed.length, a_after_event: a2!.reception_status };
});
await step("F3", "participant.failed pre C vo feede → spracované, stav ostáva failed", ["F1"], async () => {
  const c = await orgIdOf(CO.C);
  const hits = await waitFeed((e) => e.event === "participant.failed" && e.orgId === c, 6);
  if (!hits.length) return { verdict: "PARTIAL", evidence: { participant_failed_for_C: 0, note: "400 overené; webhook participant.failed sa vo feede neobjavil (docs: sandbox tabuľka ho uvádza, OpenAPI pri dead iba 400)" } };
  const res = await processPartnerEventPage(webhookDeps, { events: hits });
  const row = await orgRow(CO.C);
  assert.equal(row!.reception_status, "failed");
  return { participant_failed_for_C: hits.length, code: dataOf(hits[0]).code ?? null, processed: res.results.map((r) => r.code) };
});

// =============================================================================
// G — send_only
// =============================================================================
await step("G1", "enroll D 000000000000beef → send_only; príjem NEaktívny, odosielanie povolené", ["D3"], async () => {
  const r = await enrollCompany(onboardingDeps, CO.D, TOKENS.sendOnly);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return {};
  const row = await orgRow(CO.D);
  assert.equal(r.status, "send_only");
  assert.equal(row!.reception_status, "send_only");
  assert.equal(r.reception.receivingActive, false);
  assert.equal(r.reception.sendingEnabled, true);
  return { status: r.status, reception: row!.reception_status, receiving_active: r.reception.receivingActive, sending_enabled: r.reception.sendingEnabled, held_by_recorded: Boolean(row!.reception_held_by) };
});
await step("G2", "participant.failed PARTICIPANT_HELD_ELSEWHERE pre D → spracované, ostáva send_only (nie active, nie failed)", ["G1"], async () => {
  const d = await orgIdOf(CO.D);
  const hits = await waitFeed((e) => e.event === "participant.failed" && e.orgId === d, 6);
  if (!hits.length) return { verdict: "PARTIAL", evidence: { note: "send_only overené z odpovede; participant.failed pre D sa vo feede neobjavil" } };
  await processPartnerEventPage(webhookDeps, { events: hits });
  const row = await orgRow(CO.D);
  assert.equal(row!.reception_status, "send_only");
  return { events: hits.length, code: dataOf(hits[0]).code ?? null, reception: row!.reception_status };
});
await step("G3", "poll príjmu vynechá send_only (D) a failed (C); UI view nehlási aktívny príjem", ["G1"], async () => {
  const orgs = await h.inbound.listOrganizations(provider.name, "sandbox");
  const companies = orgs.map((o) => o.companyId);
  assert.ok(!companies.includes(CO.D));
  assert.ok(!companies.includes(CO.C));
  const viewD = receptionView(await h.onboarding.organization(CO.D, "sandbox"));
  assert.equal(viewD.receivingActive, false);
  return { polled_companies: companies.length, includes_D: false, includes_C: false, ui_state_D: viewD.state };
});

// =============================================================================
// I — outbound A → B
// =============================================================================
let INV = "";
let OUT = "";
let SENT_SHA = "";
let SUBMISSION = "";
await step("I1", "faktúra A → B (syntetická): readiness ready, UBL EN 16931, identifikátory a sumy", ["E1", "E2"], async () => {
  const { rows } = await as(U.A, () => h.db.query<{ id: string }>(
    "insert into public.invoices (company_id, direction, kind, issue_date, currency, customer_business_partner_id, source) values ($1, 'issued', 'regular_invoice', $2, 'EUR', $3, 'manual') returning id",
    [CO.A, TODAY, PARTNER_B_IN_A]
  ));
  INV = rows[0].id;
  const items = [{ description: "Sandbox partner E2E služba", quantity: 1, unit: "ks", unit_code: "H87", unit_price: 10, price_mode: "net", vat_category_code: "S", vat_rate: 23, line_net_amount: 10, line_vat_amount: 2.3, line_gross_amount: 12.3 }];
  const header = { issue_date: TODAY, due_date: TODAY, delivery_date: TODAY, currency: "EUR", buyer_reference: `PE2E-${RUN}`, customer_business_partner_id: PARTNER_B_IN_A };
  await as(U.A, () => h.db.query("select id from public.esblu_save_invoice_draft($1, $2::jsonb, $3::jsonb, null)", [INV, JSON.stringify(header), JSON.stringify(items)]));
  await as(U.A, () => h.db.query("select public.esblu_finalize_invoice($1)", [INV]));
  const r = await loadEinvoiceReadiness(userDb(U.A), INV, ENV);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return {};
  assert.deepEqual(r.result.issues.map((i) => i.code), []);
  return { readiness: "ready", warnings: r.result.warnings.map((w) => w.code) };
});
await step("I2", "route (confirm_send) → recipient + preflight → queued → worker send → poskytovateľ prijal", ["I1"], async () => {
  const req = new Request("http://localhost/api/einvoice/outbound", { method: "POST", headers: { authorization: `Bearer e2e-${U.A}`, "content-type": "application/json" }, body: JSON.stringify({ invoice_id: INV, confirm_send: true }) });
  const res = await handleOutboundSendRequest(req, {
    authenticate: async (_r, t) => (t === `e2e-${U.A}` ? { userId: U.A } : null),
    userDbFor: () => userDb(U.A),
    store: () => h.outbound,
    runtime: () => ({ provider, environment: "sandbox" }),
    env: ENV,
  });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  OUT = String((res.body.outbound as { id: string }).id);
  await runOutboundSendBatch(workerDeps, WOPTS);
  const row = (await sql<Row>("select * from public.einvoice_outbound where id = $1", [OUT])).rows[0];
  assert.ok(["sent", "delivered"].includes(row.state as string), `stav ${row.state} ${row.last_error_code ?? ""} ${String(row.reject_reason ?? "").slice(0, 60)}`);
  SUBMISSION = String(row.provider_submission_id);
  const ubl = h.ublStorage.get(row.ubl_storage_path as string)!;
  SENT_SHA = sha(ubl);
  assert.equal(SENT_SHA, row.ubl_sha256);
  const parsed = parseInboundUbl(ubl);
  assert.ok(parsed.ok, "vlastný UBL sa dá parsovať");
  const text = new TextDecoder().decode(ubl);
  const endpoints = [...text.matchAll(/<cbc:EndpointID schemeID="([0-9]{4})">([^<]+)<\/cbc:EndpointID>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(endpoints, [ID.A.participant, ID.B.participant]);
  const tag = (t: string) => new RegExp(`<cbc:${t} currencyID="EUR">([^<]+)</cbc:${t}>`).exec(text)?.[1] ?? null;
  assert.equal(tag("TaxExclusiveAmount"), "10.00");
  assert.equal(tag("TaxInclusiveAmount"), "12.30");
  assert.equal(tag("PayableAmount"), "12.30");
  assert.equal(new RegExp('<cac:TaxTotal>\\s*<cbc:TaxAmount currencyID="EUR">([^<]+)<').exec(text)?.[1] ?? null, "2.30");
  assert.ok(text.includes("urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0"));
  return {
    state: row.state, provider_calls: calls.filter((c) => /recipient|preflight|connector/.test(c.path)).map((c) => `${c.method} ${c.path} ${c.status}`),
    ubl_sha256: SENT_SHA.slice(0, 12), endpoints_scheme: endpoints.map((e) => e.slice(0, 4)), seller_is_A: endpoints[0] === ID.A.participant, buyer_is_B: endpoints[1] === ID.B.participant,
    totals: { net: "10.00", vat: "2.30", gross: "12.30" }, customization: "EN16931 / Peppol BIS 3.0", provider_preflight: "send_ready (vyžadované pred zaradením)",
  };
});
await step("I3", "reconciliation → delivered (dôkaz poskytovateľa) alebo sent", ["I2"], async () => {
  let row = (await sql<Row>("select * from public.einvoice_outbound where id = $1", [OUT])).rows[0];
  for (let i = 0; i < 12 && row.state !== "delivered"; i++) {
    await sleep(5_000);
    await sql("update public.einvoice_outbound set updated_at = now() - interval '10 minutes' where id = $1", [OUT]);
    await runOutboundReconcileBatch(workerDeps, WOPTS);
    row = (await sql<Row>("select * from public.einvoice_outbound where id = $1", [OUT])).rows[0];
  }
  const ev = row.evidence as Record<string, unknown> | null;
  return { verdict: row.state === "delivered" ? "PASS" : row.state === "sent" ? "PARTIAL" : "FAIL", evidence: { state: row.state, evidence_ubl_hash_matches: ev?.ubl_sha256 ? ev.ubl_sha256 === SENT_SHA : "n/a", evidence_keys: ev ? Object.keys(ev).sort() : [] } };
});
await step("I4", "peppol.document.sent / delivered pre A vo feede → webhook spracovanie RECONCILED/IGNORED, bez zmeny na horšie", ["I2"], async () => {
  const a = await orgIdOf(CO.A);
  const hits = await waitFeed((e) => e.orgId === a && /^peppol\.document\.(sent|delivered)$/.test(e.event) && dataOf(e).invoiceId === SUBMISSION);
  const kinds = [...new Set(hits.map((e) => e.event))].sort();
  if (!hits.length) return { verdict: "FAIL", evidence: { note: "žiadna peppol.document.sent/delivered udalosť pre podanie" } };
  const res = await processPartnerEventPage(webhookDeps, { events: hits });
  const row = (await sql<Row>("select state from public.einvoice_outbound where id = $1", [OUT])).rows[0];
  assert.ok(["sent", "delivered"].includes(row.state as string));
  return { verdict: kinds.includes("peppol.document.delivered") ? "PASS" : "PARTIAL", evidence: { events: kinds, mode: dataOf(hits[0]).mode ?? null, handler: res.results.map((r) => r.code), handler_note: "IGNORED = podanie je už terminálne (delivered) — stav sa overuje dotazom u poskytovateľa, nie z tela webhooku", state: row.state } };
});
await step("I5", "retry/duplicita: opakovaný request + worker → žiadne druhé podanie (1× connector/send)", ["I2"], async () => {
  const before = sendCalls.length;
  const req = new Request("http://localhost/api/einvoice/outbound", { method: "POST", headers: { authorization: `Bearer e2e-${U.A}`, "content-type": "application/json" }, body: JSON.stringify({ invoice_id: INV, confirm_send: true }) });
  const res = await handleOutboundSendRequest(req, {
    authenticate: async (_r, t) => (t === `e2e-${U.A}` ? { userId: U.A } : null),
    userDbFor: () => userDb(U.A), store: () => h.outbound, runtime: () => ({ provider, environment: "sandbox" }), env: ENV,
  });
  await runOutboundSendBatch(workerDeps, WOPTS);
  const attempts = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound where invoice_id = $1", [INV])).rows[0].n;
  assert.equal(sendCalls.length, before, "druhé podanie u poskytovateľa");
  assert.equal(attempts, 1);
  return { repeat_request: { status: res.status, code: res.body.code }, new_provider_sends: 0, attempts };
});

// =============================================================================
// J — inbound B
// =============================================================================
let INB: Row | null = null;
let SUPPLIER_PARTNERS_BEFORE = -1;
await step("J1", "B: GET /peppol/received → doklad z A (XML = odoslaný UBL, SHA-256)", ["I2"], async () => {
  const b = await orgIdOf(CO.B);
  SUPPLIER_PARTNERS_BEFORE = (await sql<{ n: number }>("select count(*)::int n from public.business_partners where company_id = $1 and ico = $2", [CO.B, ID.A.ico])).rows[0].n;
  let listed = 0;
  for (let i = 0; i < 18 && !INB; i++) {
    await sleep(5_000);
    listed = (await provider.listUnacknowledgedInbound({ environment: "sandbox", providerOrgId: b })).length;
    await runInboundPoll(inboundDeps, { batchSize: 10 });
    INB = (await sql<Row>("select * from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2", [CO.B, SENT_SHA])).rows[0] ?? null;
  }
  if (!INB) return { verdict: "FAIL", evidence: { listed_for_B: listed, note: "doklad sa u B neobjavil do 90 s" } };
  const inA = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where company_id = $1", [CO.A])).rows[0].n;
  return { listed_for_B: listed, stored_for_B: true, xml_equals_sent: INB.xml_sha256 === SENT_SHA, is_test: INB.is_test, inbound_rows_in_A: inA };
});
await step("J2", "peppol.document.received pre B vo feede → webhook spracovanie PROCESSED", ["J1"], async () => {
  const b = await orgIdOf(CO.B);
  const hits = await waitFeed((e) => e.orgId === b && e.event === "peppol.document.received");
  if (!hits.length) return { verdict: "FAIL", evidence: { note: "peppol.document.received pre B sa vo feede neobjavil" } };
  const res = await processPartnerEventPage(webhookDeps, { events: hits.slice(-1) });
  return { events: hits.length, handler: res.results.map((r) => r.code) };
});
await step("J3", "spracovanie → koncept prijatej faktúry (draft na kontrolu), ACK, auto-založený dodávateľ A v B", ["J1"], async () => {
  const partnersBefore = SUPPLIER_PARTNERS_BEFORE;
  assert.equal(partnersBefore, 0, "dodávateľ A v B nesmie existovať pred príjmom");
  for (let i = 0; i < 3; i++) {
    await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where processing_status not in ('acknowledged','failed')");
    await runInboundProcessBatch(inboundDeps, { batchSize: 10 });
  }
  INB = (await sql<Row>("select * from public.einvoice_inbound where id = $1", [INB!.id])).rows[0];
  assert.equal(INB.processing_status, "acknowledged", `${INB.processing_status} ${INB.last_error_code ?? ""}`);
  const inv = (await sql<Row>("select company_id, direction, document_status, source, supplier_business_partner_id from public.invoices where id = $1", [INB.invoice_id])).rows[0];
  assert.equal(inv.company_id, CO.B);
  assert.equal(inv.direction, "received");
  assert.equal(inv.document_status, "draft", "nesmie vzniknúť finálny účtovný zápis bez kontroly");
  const partners = (await sql<Row>("select id, kind from public.business_partners where company_id = $1 and ico = $2", [CO.B, ID.A.ico])).rows;
  assert.equal(partners.length, 1);
  return { status: INB.processing_status, acknowledged: Boolean(INB.acknowledged_at), draft: { direction: inv.direction, status: inv.document_status, source: inv.source }, supplier_partner_before: partnersBefore, supplier_partner_after: partners.length, supplier_linked: inv.supplier_business_partner_id === partners[0].id };
});
await step("J4", "duplicitný doklad: opätovný poll/registrácia → žiadny nový koncept ani partner", ["J3"], async () => {
  const drafts = async () => (await sql<{ n: number }>("select count(*)::int n from public.invoices where company_id = $1 and direction = 'received'", [CO.B])).rows[0].n;
  const before = await drafts();
  await runInboundPoll(inboundDeps, { batchSize: 10 });
  await h.inbound.register({ provider: provider.name, environment: "sandbox", providerOrgId: await orgIdOf(CO.B), providerReceivedId: String(INB!.provider_received_id), source: "poll", meta: {} });
  const after = await drafts();
  const rows = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where provider_received_id = $1", [INB!.provider_received_id])).rows[0].n;
  const partners = (await sql<{ n: number }>("select count(*)::int n from public.business_partners where company_id = $1 and ico = $2", [CO.B, ID.A.ico])).rows[0].n;
  assert.equal(after, before);
  assert.equal(rows, 1);
  assert.equal(partners, 1);
  return { drafts_before: before, drafts_after: after, inbound_rows: rows, supplier_partners: partners };
});
await step("J5", "izolácia firiem: A nevidí inbound B, B nevidí outbound A; zamestnanec A nevidí E-Faktúru", ["J1"], async () => {
  const aSeesIn = (await as(U.A, () => h.db.query<{ n: number }>("select count(*)::int n from public.einvoice_inbound"))).rows[0].n;
  const bSeesOut = (await as(U.B, () => h.db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"))).rows[0].n;
  const bSeesOrgs = (await as(U.B, () => h.db.query<{ c: string }>("select company_id c from public.einvoice_organizations"))).rows.map((r) => r.c);
  const empSees = (await as(U.empA, () => h.db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"))).rows[0].n;
  assert.equal(aSeesIn, 0);
  assert.equal(bSeesOut, 0);
  assert.ok(bSeesOrgs.every((c) => c === CO.B));
  assert.equal(empSees, 0);
  return { a_sees_b_inbound: aSeesIn, b_sees_a_outbound: bSeesOut, b_sees_foreign_orgs: bSeesOrgs.filter((c) => c !== CO.B).length, employee_sees_outbound: empSees };
});

// =============================================================================
// H — webhook endpoint (lokálne podpísané presné telá z feedu)
// =============================================================================
await step("H1", "webhook handler: každý typ udalosti (telo z feedu, HMAC) → správna vetva; neplatný podpis 401; stará pečiatka 401; duplicita 200 DUPLICATE; iné telo pod tým istým ID 409", [], async () => {
  await pullFeed();
  const byType = new Map<string, PartnerEvent>();
  for (const e of feedSeen) if (!byType.has(e.event)) byType.set(e.event, e);
  const synthetic = !byType.has("peppol.document.failed");
  if (synthetic) {
    // Sandbox nevie na požiadanie vyvolať finálne zlyhanie odoslania → syntetické telo v tvare z docs.
    byType.set("peppol.document.failed", { id: "0", event: "peppol.document.failed", eventId: null, orgId: await orgIdOf(CO.A), createdAt: null, payload: { event: "peppol.document.failed", timestamp: new Date().toISOString(), data: { invoiceId: SUBMISSION || randomUUID(), invoiceNumber: "X", documentType: "invoice", error: "synthetic", orgId: await orgIdOf(CO.A) } } });
  }
  const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", LOCAL_SECRET).update(`${t}.${body}`).digest("hex")}`;
  const perEvent: Record<string, string> = {};
  for (const [type, e] of byType) {
    const body = JSON.stringify(e.payload);
    const r = await handleEinvoiceWebhook(webhookDeps, { rawBody: new TextEncoder().encode(body), signatureHeader: sign(body), deliveryIdHeader: randomUUID() });
    perEvent[type] = `${r.status} ${r.body.code}`;
    assert.equal(r.status, 200, `${type}: ${r.body.code}`);
  }
  const body = JSON.stringify(byType.values().next().value!.payload);
  const id = randomUUID();
  const bad = await handleEinvoiceWebhook(webhookDeps, { rawBody: new TextEncoder().encode(body), signatureHeader: `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`, deliveryIdHeader: id });
  const stale = await handleEinvoiceWebhook(webhookDeps, { rawBody: new TextEncoder().encode(body), signatureHeader: sign(body, Math.floor(Date.now() / 1000) - 3600), deliveryIdHeader: id });
  const ok1 = await handleEinvoiceWebhook(webhookDeps, { rawBody: new TextEncoder().encode(body), signatureHeader: sign(body), deliveryIdHeader: id });
  const dup = await handleEinvoiceWebhook(webhookDeps, { rawBody: new TextEncoder().encode(body), signatureHeader: sign(body), deliveryIdHeader: id });
  const other = body.replace(/}$/, ',"x":1}');
  const replay = await handleEinvoiceWebhook(webhookDeps, { rawBody: new TextEncoder().encode(other), signatureHeader: sign(other), deliveryIdHeader: id });
  assert.equal(bad.status, 401);
  assert.equal(stale.status, 401);
  assert.equal(ok1.status, 200);
  assert.equal(dup.body.code, "DUPLICATE");
  assert.equal(replay.status, 409);
  const required = ["participant.activated", "participant.failed", "peppol.document.sent", "peppol.document.delivered", "peppol.document.failed", "peppol.document.received"];
  const missing = required.filter((t) => !perEvent[t]);
  return {
    verdict: missing.length ? "PARTIAL" : "PASS",
    evidence: { per_event: perEvent, peppol_document_failed_body: synthetic ? "synthetic (sandbox ho nevyvolá)" : "from feed", missing_types: missing, invalid_signature: bad.status, stale_timestamp: stale.status, duplicate: dup.body.code, same_id_other_body: replay.status, real_http_delivery: "NOT_RUN — vyžaduje verejný HTTPS endpoint (preview/staging deploy) a secret z portálu" },
  };
});

// =============================================================================
// K — únik tajomstiev (report, DB)
// =============================================================================
await step("K1", "žiadny API kľúč ani overovací kód v DB Esblu; žiadny kľúč v reporte", [], async () => {
  const dump = JSON.stringify((await sql<Row>(`
    select (select coalesce(jsonb_agg(o), '[]'::jsonb) from public.einvoice_organizations o) orgs,
           (select coalesce(jsonb_agg(w), '[]'::jsonb) from public.einvoice_webhook_events w) hooks,
           (select coalesce(jsonb_agg(e), '[]'::jsonb) from public.einvoice_events e) events,
           (select coalesce(jsonb_agg(x), '[]'::jsonb) from public.einvoice_outbound x) outbound,
           (select coalesce(jsonb_agg(i), '[]'::jsonb) from public.einvoice_inbound i) inbound`)).rows[0]);
  for (const needle of [KEY, "efk_pk_", "whsec_", TOKENS.invalid, TOKENS.sendOnly, `"${TOKENS.ok}"`]) assert.ok(!dump.includes(needle), "tajomstvo/kód v DB");
  const report = JSON.stringify(results);
  assert.ok(!report.includes(KEY) && !report.includes("efk_pk_") && !report.includes(LOCAL_SECRET), "tajomstvo v reporte");
  return { db_clean: true, report_clean: true };
});

// =============================================================================
// Report
// =============================================================================
const summary = {
  generated_at: new Date().toISOString(),
  environment: SELFTEST ? "offline-selftest (fake sandbox, bez siete)" : "eFaktura.sk sandbox (API partner)",
  seed: SEED,
  synthetic_identities: Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, { ico: v.ico, dic: v.dic }])),
  provider_calls: calls.reduce<Record<string, number>>((acc, c) => ((acc[`${c.method} ${c.path} ${c.status}`] = (acc[`${c.method} ${c.path} ${c.status}`] ?? 0) + 1), acc), {}),
  counts: results.reduce<Record<string, number>>((acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {}),
  results,
};
const out = JSON.stringify(summary, null, 2);
if (out.includes(KEY) || out.includes(LOCAL_SECRET)) stop("report by obsahoval tajomstvo — neukladá sa");
const reportPath = ARGS.get("report") ?? path.join(tmpdir(), SELFTEST ? "esblu-einvoice-partner-e2e-selftest.json" : "esblu-einvoice-partner-e2e-report.json");
writeFileSync(reportPath, out);
console.log(`\npartner-e2e: ${JSON.stringify(summary.counts)}  report: ${reportPath}`);
if (results.some((r) => r.verdict === "FAIL")) process.exit(1);
