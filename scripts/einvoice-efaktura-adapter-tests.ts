// =============================================================================
// eFaktura.sk adaptér — kontraktové testy BEZ SIETE (fake fetch).
//
// Tvary požiadaviek a odpovedí zodpovedajú verejnej OpenAPI špecifikácii
// https://developers.efaktura.sk/agent-api.en.yaml (audit 2026-09-30).
// Všetky údaje sú syntetické; kľúč je fiktívny.
// Spustenie: npm run test:einvoice-efaktura
// =============================================================================

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  EfakturaSkProvider,
  resolveEfakturaBaseUrl,
  scrubProviderText,
  mapEfakturaSendState,
  type EfakturaFetch,
} from "../lib/einvoice/provider/efaktura-sk.ts";
import { getEinvoiceProvider } from "../lib/einvoice/provider/index.ts";
import { EinvoiceProviderError } from "../lib/einvoice/provider/types.ts";
import { EVIDENCE_TOP_LEVEL_KEYS, sanitizeDeliveryEvidence } from "../lib/einvoice/evidence.ts";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const FAKE_KEY = "efk_pk_test_" + "0".repeat(24); // syntetický, nikdy skutočný
const ORG = "8c1f0b2e-1c0a-4a1b-9f2e-2b3c4d5e6f70";
const INV = "b1f0d7a2-0000-4000-8000-000000000001";
const RCV = "f3a10000-0000-4000-8000-000000000001";
const ctx = { environment: "sandbox" as const, providerOrgId: ORG };

type Recorded = { url: URL; method: string; headers: Record<string, string>; body: unknown; redirect?: RequestRedirect };
type Reply = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; headers?: Record<string, string> };

function fake(routes: Array<(req: Recorded) => Reply | undefined>) {
  const calls: Recorded[] = [];
  const impl: EfakturaFetch = async (input, init) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const req: Recorded = {
      url: new URL(input),
      method: String(init.method),
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
    };
    calls.push(req);
    for (const route of routes) {
      const r = route(req);
      if (!r) continue;
      const payload = r.bytes ?? new TextEncoder().encode(r.json !== undefined ? JSON.stringify(r.json) : r.text ?? "");
      return new Response(payload as unknown as BodyInit, { status: r.status ?? 200, headers: r.headers ?? { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }), { status: 404 });
  };
  return { impl, calls };
}
const provider = (impl: EfakturaFetch) => new EfakturaSkProvider({ apiKey: FAKE_KEY, environment: "sandbox", fetchImpl: impl });
const is = (method: string, path: string) => (req: Recorded) => req.method === method && req.url.pathname === path;
const codeOf = (code: string) => (e: unknown) => e instanceof EinvoiceProviderError && e.code === code;

// -----------------------------------------------------------------------------

await check("base URL: default api.efaktura.sk; iba https + allowlist; bez cesty/query", () => {
  assert.equal(resolveEfakturaBaseUrl(undefined), "https://api.efaktura.sk");
  assert.equal(resolveEfakturaBaseUrl("https://api.efaktura.sk/v1/"), "https://api.efaktura.sk");
  assert.throws(() => resolveEfakturaBaseUrl("http://api.efaktura.sk"), codeOf("EINVOICE_BASE_URL_INVALID"));
  assert.throws(() => resolveEfakturaBaseUrl("https://evil.example"), codeOf("EINVOICE_BASE_URL_NOT_ALLOWED"));
  assert.throws(() => resolveEfakturaBaseUrl("https://api.efaktura.sk.evil.example"), codeOf("EINVOICE_BASE_URL_NOT_ALLOWED"));
  assert.throws(() => resolveEfakturaBaseUrl("https://u:p@api.efaktura.sk"), codeOf("EINVOICE_BASE_URL_INVALID"));
  assert.throws(() => resolveEfakturaBaseUrl("https://api.efaktura.sk/x"), codeOf("EINVOICE_BASE_URL_INVALID"));
  assert.throws(() => getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox", ESBLU_EFAKTURA_API_KEY: FAKE_KEY, ESBLU_EFAKTURA_BASE_URL: "https://evil.example" }));
});

await check("provisionOrganization: POST bez X-Organization-Id, snake_case payload, potom detail", async () => {
  const f = fake([
    (r) => is("POST", "/v1/agent/organizations")(r) ? { status: 201, json: { data: { org_id: ORG, partner_id: "p", slug: "s", reused: false, status: "caka_na_token" } } } : undefined,
    (r) => is("GET", `/v1/agent/organizations/${ORG}`)(r) ? { json: { organization_id: ORG, ico: "99999901", status: "caka_na_token", participant_id: "9915:9999999901", peppol_status: "active", claim_status: null, peppol_eligible: true, pending_mandate: false } } : undefined,
  ]);
  const info = await provider(f.impl).provisionOrganization({
    environment: "sandbox", legalName: "Syntetická Testovacia s.r.o.", ico: "99999901", dic: "9999999901", icDph: "SK9999999901",
    address: { street: "Testovacia 1", city: "Bratislava", postalCode: "81101", countryCode: "SK" },
  });
  assert.equal(f.calls.length, 2);
  const [post, get] = f.calls;
  assert.equal(post.url.origin, "https://api.efaktura.sk");
  assert.equal(post.headers["X-API-Key"], FAKE_KEY);
  assert.equal(post.headers["X-Organization-Id"], undefined);
  assert.equal(post.headers["Content-Type"], "application/json");
  assert.equal(post.redirect, "error");
  assert.deepEqual(post.body, {
    name: "Syntetická Testovacia s.r.o.", ico: "99999901", dic: "9999999901", ic_dph: "SK9999999901",
    address: { street: "Testovacia 1", city: "Bratislava", postalCode: "81101", country: "SK" },
  });
  assert.equal(get.headers["X-Organization-Id"], undefined);
  assert.deepEqual(info, {
    providerOrgId: ORG, participantId: "9915:9999999901", orgStatus: "caka_na_token", peppolStatus: "active",
    claimStatus: null, peppolEligible: true, reused: false,
  });
});

await check("provisionOrganization: 200 = existujúca organizácia (idempotentne podľa IČO) → reused", async () => {
  const f = fake([
    (r) => is("POST", "/v1/agent/organizations")(r) ? { status: 200, json: { data: { org_id: ORG } } } : undefined,
    (r) => is("GET", `/v1/agent/organizations/${ORG}`)(r) ? { json: { organization_id: ORG, participant_id: null, peppol_eligible: false } } : undefined,
  ]);
  const info = await provider(f.impl).provisionOrganization({
    environment: "sandbox", legalName: "Syntetická", ico: "99999901", dic: null, icDph: null,
    address: { street: "T 1", city: "BA", postalCode: "81101", countryCode: "SK" },
  });
  assert.equal(info.reused, true);
  assert.equal(info.participantId, null);
  assert.equal((f.calls[0].body as Record<string, unknown>).dic, undefined);
});

await check("getOrganization: odpoveď nie je obalená v data; neplatný participant → null", async () => {
  const f = fake([(r) => is("GET", `/v1/agent/organizations/${ORG}`)(r) ? { json: { organization_id: ORG, participant_id: "bad id", status: "aktivne", peppol_eligible: true } } : undefined]);
  const info = await provider(f.impl).getOrganization(ctx);
  assert.equal(info.participantId, null);
  assert.equal(info.orgStatus, "aktivne");
});

await check("verifyRecipient: GET s peppolId + X-Organization-Id; lookup_unavailable nikdy nie je found", async () => {
  const f = fake([(r) => is("GET", "/v1/agent/peppol/recipient")(r)
    ? { json: { data: { peppol_id: r.url.searchParams.get("peppolId"), found: r.url.searchParams.get("peppolId") === "9915:9999999902", lookup_unavailable: r.url.searchParams.get("peppolId") === "9915:9999999903" } } }
    : undefined]);
  const p = provider(f.impl);
  assert.deepEqual(await p.verifyRecipient(ctx, "9915:9999999902"), { participantId: "9915:9999999902", found: true, lookupUnavailable: false });
  assert.deepEqual(await p.verifyRecipient(ctx, "9915:9999999909"), { participantId: "9915:9999999909", found: false, lookupUnavailable: false });
  assert.deepEqual(await p.verifyRecipient(ctx, "9915:9999999903"), { participantId: "9915:9999999903", found: false, lookupUnavailable: true });
  assert.equal(f.calls[0].headers["X-Organization-Id"], ORG);
});

await check("preflight: base64 UBL, mapovanie repair; fail-closed pri nedostupnom validátore", async () => {
  const ubl = new TextEncoder().encode("<Invoice/>");
  let reply: unknown = { data: { send_ready: false, validator_unavailable: false, validation: { ran: true, valid: false, error_count: 1, warning_count: 1 },
    repair: [{ field: "cac:TaxTotal", code: "BR-CO-15", message: "Súčet nesedí", severity: "error" }, { code: "W1", message: "pozor", severity: "warning" }] } };
  const f = fake([(r) => is("POST", "/v1/agent/peppol/preflight")(r) ? { json: reply } : undefined]);
  const p = provider(f.impl);
  const a = await p.preflight(ctx, { ubl, receiverParticipantId: "9915:9999999902" });
  assert.deepEqual(f.calls[0].body, { document: { format: "ubl", xmlBase64: Buffer.from(ubl).toString("base64") }, receiverPeppolId: "9915:9999999902" });
  assert.equal(a.sendReady, false);
  assert.deepEqual(a.issues, [
    { code: "BR-CO-15", message: "Súčet nesedí", severity: "error", field: "cac:TaxTotal" },
    { code: "W1", message: "pozor", severity: "warning" },
  ]);
  reply = { data: { send_ready: null, validator_unavailable: true, repair: [] } };
  const b = await p.preflight(ctx, { ubl });
  assert.deepEqual(b, { sendReady: false, validatorUnavailable: true, issues: [] });
  reply = { data: { send_ready: true, validator_unavailable: false, repair: [{ code: "W", message: "w", severity: "warning" }] } };
  assert.equal((await p.preflight(ctx, { ubl })).sendReady, true);
});

await check("sendUbl: Connector, povinný Idempotency-Key, autoRepair=false, invoice_id ako submission", async () => {
  const ubl = new TextEncoder().encode("<Invoice>synthetic</Invoice>");
  const sha = createHash("sha256").update(ubl).digest("hex");
  const f = fake([(r) => is("POST", "/v1/agent/peppol/connector/send")(r)
    ? { json: { data: { status: "queued", invoice_id: INV, document_id: "9915:9999999902#T1", job_id: "j", send_ready: true, validator_unavailable: false } } }
    : undefined]);
  const res = await provider(f.impl).sendUbl(ctx, { ubl, ublSha256: sha, idempotencyKey: "einv-out-0000000000000001", receiverParticipantId: "9915:9999999902" });
  const req = f.calls[0];
  assert.equal(req.headers["Idempotency-Key"], "einv-out-0000000000000001");
  assert.equal(req.headers["X-Organization-Id"], ORG);
  assert.deepEqual(req.body, {
    document: { format: "ubl", xmlBase64: Buffer.from(ubl).toString("base64") },
    receiverPeppolId: "9915:9999999902",
    options: { autoRepair: false, validateOnly: false, dispatch: "now" },
  });
  assert.deepEqual(res, { state: "queued", providerSubmissionId: INV, providerStagedId: null, rejectReason: null });
});

await check("sendUbl: rejected (reason + error), neznámy status → chyba, 409 → CONFLICT", async () => {
  const ubl = new TextEncoder().encode("<Invoice/>");
  const sha = createHash("sha256").update(ubl).digest("hex");
  let reply: Reply = { json: { data: { status: "rejected", reason: "ingest", error: "Organizácia nemá Peppol účet", send_ready: true } } };
  const f = fake([(r) => is("POST", "/v1/agent/peppol/connector/send")(r) ? reply : undefined]);
  const p = provider(f.impl);
  const input = { ubl, ublSha256: sha, idempotencyKey: "einv-out-0000000000000002" };
  assert.deepEqual(await p.sendUbl(ctx, input), { state: "rejected", providerSubmissionId: null, providerStagedId: null, rejectReason: "ingest: Organizácia nemá Peppol účet" });
  reply = { json: { data: { status: "teleported" } } };
  await assert.rejects(p.sendUbl(ctx, input), codeOf("EINVOICE_PROVIDER_UNKNOWN_STATE"));
  reply = { json: { data: { status: "queued" } } };
  await assert.rejects(p.sendUbl(ctx, input), codeOf("EINVOICE_PROVIDER_BAD_RESPONSE"));
  reply = { status: 409, json: { error: { code: "CONFLICT", message: "Idempotency-Key reused" } } };
  await assert.rejects(p.sendUbl(ctx, input), (e: unknown) => codeOf("EINVOICE_PROVIDER_CONFLICT")(e) && !(e as EinvoiceProviderError).retryable);
});

await check("getOutboundStatus: mapovanie stavov vrátane SCHEDULED; neznámy stav sa nehádá", async () => {
  let state = "SENT";
  const f = fake([(r) => is("GET", `/v1/agent/peppol/status/${INV}`)(r)
    ? { json: { data: { invoice_id: INV, state, error_message: state === "ERROR" ? "Chýba adresa" : null, receiver_identifier: "9915:9999999902", document_id: "d", updated_at: "2026-09-30T10:00:05.000Z" } } }
    : undefined]);
  const p = provider(f.impl);
  assert.deepEqual(await p.getOutboundStatus(ctx, { providerSubmissionId: INV }), {
    state: "sent", receiverIdentifier: "9915:9999999902", documentId: "d", errorMessage: null, updatedAt: "2026-09-30T10:00:05.000Z",
  });
  state = "ERROR";
  const e = await p.getOutboundStatus(ctx, { providerSubmissionId: INV });
  assert.equal(e.state, "failed");
  assert.equal(e.errorMessage, "Chýba adresa");
  state = "SCHEDULED";
  assert.equal((await p.getOutboundStatus(ctx, { providerSubmissionId: INV })).state, "queued");
  state = "WHATEVER";
  await assert.rejects(p.getOutboundStatus(ctx, { providerSubmissionId: INV }), codeOf("EINVOICE_PROVIDER_UNKNOWN_STATE"));
  assert.equal(mapEfakturaSendState("not_sent"), "pending");
});

await check("getDeliveryEvidence: delivered → deliveredAt + sha; 404 → null", async () => {
  let status = 200;
  const f = fake([(r) => is("GET", `/v1/agent/peppol/sent/${INV}/evidence`)(r)
    ? (status === 200
      ? { json: { data: { invoice_id: INV, document_id: "m@ap", ubl_sha256: "AB".repeat(32), delivery_status: { state: "delivered", at: "2026-09-30T10:00:05.000Z" }, layers: {}, transactions: [] } } }
      : { status: 404, json: { error: { code: "NOT_FOUND", message: "No Peppol send transaction found for this invoice." } } })
    : undefined]);
  const p = provider(f.impl);
  const ev = await p.getDeliveryEvidence(ctx, { providerSubmissionId: INV });
  assert.equal(ev?.deliveredAt, "2026-09-30T10:00:05.000Z");
  assert.equal(ev?.ublSha256, "ab".repeat(32));
  assert.equal(ev?.documentId, "m@ap");
  status = 404;
  assert.equal(await p.getDeliveryEvidence(ctx, { providerSubmissionId: INV }), null);
});

await check("listUnacknowledgedInbound: acknowledged=false, limit 1–100, obranný filter acknowledged_at", async () => {
  const f = fake([(r) => is("GET", "/v1/agent/peppol/received")(r)
    ? { json: { data: [
      { id: RCV, sender_participant_id: "9915:9999999901", sender_ico: "99999901", document_type: "invoice", document_number: "T-1", received_at: "2026-09-30T08:15:00.000Z", acknowledged_at: null, is_test: true },
      { id: "f3a10000-0000-4000-8000-000000000002", acknowledged_at: "2026-09-30T08:20:00.000Z" },
      { id: "../../etc" },
    ] } }
    : undefined]);
  const p = provider(f.impl);
  const list = await p.listUnacknowledgedInbound(ctx, { limit: 500 });
  assert.equal(f.calls[0].url.searchParams.get("acknowledged"), "false");
  assert.equal(f.calls[0].url.searchParams.get("limit"), "100");
  assert.deepEqual(list, [{
    providerReceivedId: RCV, senderParticipantId: "9915:9999999901", senderIco: "99999901", documentNumber: "T-1",
    documentType: "invoice", receivedAt: "2026-09-30T08:15:00.000Z", isTest: true,
  }]);
});

await check("getInboundDocument: surové XML bajty, Accept XML, limit veľkosti", async () => {
  const xml = new TextEncoder().encode("<?xml version=\"1.0\"?><Invoice/>");
  let big = false;
  const f = fake([(r) => is("GET", `/v1/agent/peppol/received/${RCV}/xml`)(r)
    ? (big
      ? { bytes: new Uint8Array(6 * 1024 * 1024), headers: { "content-type": "application/xml" } }
      : { bytes: xml, headers: { "content-type": "application/xml" } })
    : undefined]);
  const p = provider(f.impl);
  const doc = await p.getInboundDocument(ctx, RCV);
  assert.equal(f.calls[0].headers.Accept, "application/xml");
  assert.deepEqual(Buffer.from(doc.xml), Buffer.from(xml));
  assert.equal(doc.pdf, null);
  big = true;
  await assert.rejects(p.getInboundDocument(ctx, RCV), codeOf("EINVOICE_PROVIDER_RESPONSE_TOO_LARGE"));
});

await check("acknowledgeInbound: POST, idempotentné (already_acknowledged)", async () => {
  const f = fake([(r) => is("POST", `/v1/agent/peppol/received/${RCV}/acknowledge`)(r)
    ? { json: { data: { id: RCV, acknowledged_at: "2026-09-30T08:20:11.000Z", already_acknowledged: true } } }
    : undefined]);
  await provider(f.impl).acknowledgeInbound(ctx, RCV);
  assert.equal(f.calls[0].method, "POST");
});

await check("chyby: 401/403/429/5xx/sieť; kľúč sa nikdy neobjaví v chybe", async () => {
  const cases: Array<[Reply, string, boolean]> = [
    [{ status: 401, json: { error: { code: "UNAUTHORIZED", message: `bad key ${FAKE_KEY}` } } }, "EINVOICE_PROVIDER_UNAUTHORIZED", false],
    [{ status: 403, json: { error: { code: "FORBIDDEN", message: `scope ${FAKE_KEY}` } } }, "EINVOICE_PROVIDER_FORBIDDEN", false],
    [{ status: 429, json: { error: { code: "RATE_LIMITED", message: "slow" } }, headers: { "retry-after": "7" } }, "EINVOICE_PROVIDER_RATE_LIMITED", true],
    [{ status: 503, text: "<html>down</html>" }, "EINVOICE_PROVIDER_UNAVAILABLE", true],
    [{ status: 402, json: { error: "INSUFFICIENT_CREDIT", message: "top up" } }, "EINVOICE_PROVIDER_INSUFFICIENT_CREDIT", false],
  ];
  for (const [reply, code, retryable] of cases) {
    const f = fake([() => reply]);
    const err = await provider(f.impl).verifyRecipient(ctx, "9915:9999999902").then(() => null, (e: unknown) => e);
    assert.ok(err instanceof EinvoiceProviderError, code);
    assert.equal(err.code, code);
    assert.equal(err.retryable, retryable, code);
    assert.doesNotMatch(`${err.message} ${JSON.stringify(err)} ${err.stack}`, /efk_pk_test_0{8}/, code);
  }
  const net = new EfakturaSkProvider({ apiKey: FAKE_KEY, environment: "sandbox", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(net.getOrganization(ctx), (e: unknown) => codeOf("EINVOICE_PROVIDER_NETWORK")(e) && (e as EinvoiceProviderError).retryable);
  assert.equal(scrubProviderText(`x ${FAKE_KEY} whsec_abc y`), "x [redacted] [redacted] y");
});

await check("kľúč sa neprezradí serializáciou ani inšpekciou objektu", async () => {
  const p = provider(fake([]).impl);
  assert.doesNotMatch(JSON.stringify(p), /efk_pk_/);
  assert.doesNotMatch(JSON.stringify({ p }), /efk_pk_/);
  const { inspect } = await import("node:util");
  assert.doesNotMatch(inspect(p, { depth: 5, showHidden: true }), /efk_pk_test_0{8}/);
  assert.deepEqual(Object.keys(p), ["name"]);
});

await check("evidence allowlist: neznáme polia, hlavičky, tokeny ani surové telá sa NEUKLADAJÚ", async () => {
  const hostile = {
    data: {
      invoice_id: INV,
      document_id: "m@ap",
      ubl_sha256: "CD".repeat(32),
      delivery_status: { state: "delivered", at: "2026-09-30T10:00:05Z", internal_note: "x" },
      layers: { as4: { raw: "<soap:Envelope>…</soap:Envelope>" } },
      headers: { authorization: "Bearer secret-token", "x-api-key": FAKE_KEY },
      raw_request: "POST /v1/…", raw_response: "{…}", token: "whsec_abcdef", customer_email: "person@example.test",
      transactions: [
        { message_id: "as4-msg-1", status: "DELIVERED", at: "2026-09-30T10:00:04Z", receiver_participant_id: "9915:2040000000",
          sender_participant_id: "9915:2020000000", payload_base64: "PD94bWwg", signature: "abc", headers: { a: "b" } },
        { garbage: true },
        "not-an-object",
      ],
    },
  };
  const f = fake([(r) => (is("GET", `/v1/agent/peppol/sent/${INV}/evidence`)(r) ? { json: hostile } : undefined)]);
  const ev = await provider(f.impl).getDeliveryEvidence(ctx, { providerSubmissionId: INV });
  assert.ok(ev);
  assert.equal("raw" in (ev as object), false, "žiadne raw pole");
  assert.deepEqual(Object.keys(ev!.record).sort(), [...EVIDENCE_TOP_LEVEL_KEYS].sort());
  assert.deepEqual(ev!.record, {
    schema: "esblu.einvoice.evidence.v1",
    provider_invoice_id: INV,
    document_id: "m@ap",
    ubl_sha256: "cd".repeat(32),
    delivery_state: "delivered",
    delivered_at: "2026-09-30T10:00:05.000Z",
    transactions: [{ message_id: "as4-msg-1", status: "delivered", at: "2026-09-30T10:00:04.000Z",
      sender_participant_id: "9915:2020000000", receiver_participant_id: "9915:2040000000" }],
  });
  const serialized = JSON.stringify(ev);
  for (const forbidden of ["secret-token", FAKE_KEY, "whsec_", "Envelope", "person@example.test", "PD94bWwg", "raw_request", "internal_note"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

await check("evidence allowlist: zrkadlí DB CHECK (rovnaké kľúče v migrácii), neplatné hodnoty → null", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261002100000_einvoice_foundation.sql", import.meta.url), "utf8");
  const m = /evidence - array\[([^\]]+)\]/.exec(migration);
  assert.ok(m, "CHECK na evidence v migrácii");
  const dbKeys = [...m![1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(dbKeys, [...EVIDENCE_TOP_LEVEL_KEYS].sort());
  const bad = sanitizeDeliveryEvidence({ invoice_id: "../../etc", document_id: "x".repeat(500), ubl_sha256: "nothex",
    delivery_status: { state: "DELIVERED; DROP", at: "včera" }, transactions: new Array(50).fill({ message_id: "ok-1" }) });
  assert.equal(bad.provider_invoice_id, null);
  assert.equal(bad.document_id, null);
  assert.equal(bad.ubl_sha256, null);
  assert.equal(bad.delivery_state, null);
  assert.equal(bad.delivered_at, null);
  assert.equal(bad.transactions.length, 10);
  assert.deepEqual(sanitizeDeliveryEvidence(null).transactions, []);
});

console.log(`\neinvoice-efaktura-adapter: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
