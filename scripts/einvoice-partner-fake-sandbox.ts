// =============================================================================
// Fake eFaktura.sk sandbox (API partner, „Sandbox ako produkcia") — BEZ SIETE.
// Iba pre testy a --offline-selftest. Napodobňuje zdokumentované správanie
// (developers.efaktura.sk/docs: sandbox, webhooks, receiving, agent-api.en.yaml):
//   - POST /organizations idempotentné podľa IČO (201 / 200 reused), BEZ auto-enroll,
//   - POST /peppol/enroll: token povinný; 000000000000dead → 400 + participant.failed;
//     000000000000beef → 201 send_only + participant.failed PARTICIPANT_HELD_ELSEWHERE;
//     iný hex → 201 enrolled + participant.activated (9915:<DIČ>),
//   - odoslanie bez aktívneho Peppol účtu → rejected (ingest),
//   - connector/send A → B (EndpointID 9915:DIČ) → prijatý doklad pre org B
//     + peppol.document.sent / delivered (A) a peppol.document.received (B),
//   - GET /v1/agent/events (cursor) = telá webhookov.
// =============================================================================

import { createHash, randomUUID } from "node:crypto";

type Org = { id: string; ico: string; dic: string | null; name: string; participant: string | null; reception: "none" | "active" | "send_only" };
type Received = { id: string; orgId: string; xml: Uint8Array; senderParticipant: string; number: string; acknowledgedAt: string | null };

export type FakeSandboxOptions = { failSendTimes?: number };

export function createFakeSandbox(options: FakeSandboxOptions = {}) {
  const orgs = new Map<string, Org>();
  const idem = new Map<string, { bodySha: string; response: string }>();
  const sent = new Map<string, { orgId: string; xml: Uint8Array; number: string }>();
  const received: Received[] = [];
  const events: { id: string; event: string; event_id: string | null; org_id: string; created_at: string; payload: Record<string, unknown> }[] = [];
  const requests: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  let failSend = options.failSendTimes ?? 0;
  let seq = 1000;

  const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const emit = (event: string, orgId: string, data: Record<string, unknown>, eventId: string | null = null) => {
    const at = new Date().toISOString();
    events.push({ id: String(++seq), event, event_id: eventId, org_id: orgId, created_at: at, payload: { event, timestamp: at, data: { ...data, orgId } } });
  };
  const orgByHeader = (h: Headers) => orgs.get(h.get("x-organization-id") ?? "") ?? null;

  async function handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    requests.push({ method, path: url.pathname, headers: Object.fromEntries(headers.entries()), body });
    if (!headers.get("x-api-key")?.startsWith("efk_pk_test_")) return json(401, { error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
    const p = url.pathname;

    if (method === "POST" && p === "/v1/agent/organizations") {
      const b = JSON.parse(body) as { name: string; ico: string; dic?: string };
      const existing = [...orgs.values()].find((o) => o.ico === b.ico);
      if (existing) return json(200, { data: { org_id: existing.id, partner_id: "p", slug: "x", reused: true, peppol_sandbox: null } });
      const org: Org = { id: randomUUID(), ico: b.ico, dic: b.dic ?? null, name: b.name, participant: null, reception: "none" };
      orgs.set(org.id, org);
      return json(201, { data: { org_id: org.id, partner_id: "p", slug: "x", reused: false, peppol_sandbox: null } });
    }
    if (method === "GET" && p.startsWith("/v1/agent/organizations/")) {
      const org = orgs.get(p.split("/").at(-1) ?? "");
      if (!org) return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
      return json(200, {
        organization_id: org.id, ico: org.ico,
        status: org.reception === "active" ? "aktivne" : "caka_na_token",
        participant_id: org.participant, peppol_status: org.reception === "active" ? "active" : null,
        claim_status: org.reception === "active" ? "claimed" : null,
        peppol_eligible: org.participant !== null, pending_mandate: false,
      });
    }
    if (method === "POST" && p === "/v1/agent/peppol/enroll") {
      const org = orgByHeader(headers);
      if (!org) return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
      const b = JSON.parse(body || "{}") as { verificationTokenHex?: string };
      const token = (b.verificationTokenHex ?? "").toLowerCase();
      if (!token) return json(400, { error: { code: "VALIDATION_ERROR", message: "verificationTokenHex je povinný" } });
      if (token === "000000000000dead") {
        emit("participant.failed", org.id, { participantId: `9915:${org.dic}`, scheme: "9915", mode: "test", source: "api_enroll", failedAt: new Date().toISOString(), code: "VERIFICATION_TOKEN_INVALID", message: "Verifikačný token nie je platný" });
        return json(400, { error: { code: "VALIDATION_ERROR", message: "Verifikačný token nie je platný" } });
      }
      if (token === "000000000000beef") {
        org.participant = `9915:${org.dic}`;
        org.reception = "send_only";
        emit("participant.failed", org.id, { participantId: org.participant, scheme: "9915", mode: "test", source: "api_enroll", failedAt: new Date().toISOString(), code: "PARTICIPANT_HELD_ELSEWHERE", message: "held elsewhere" });
        return json(201, { data: { status: "send_only", registration_id: null, participant_id: org.participant, claim: null, reception: { held_by: { ap_host: "sandbox-other-ap.efaktura.test", cert_org: "Sandbox iný poštár" } } } });
      }
      org.participant = `9915:${org.dic}`;
      const already = org.reception === "active";
      org.reception = "active";
      if (!already) emit("participant.activated", org.id, { participantId: org.participant, scheme: "9915", mode: "test", source: "api_enroll", activatedAt: new Date().toISOString() });
      return json(201, { data: { status: "enrolled", registration_id: `reg-${org.id.slice(0, 8)}`, participant_id: org.participant, claim: null, reception: null } });
    }
    if (method === "GET" && p === "/v1/agent/events") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const page = events.filter((e) => Number(e.id) > after).slice(0, limit);
      const last = page.at(-1)?.id ?? (after ? String(after) : null);
      return json(200, { data: page, next_after: last, has_more: events.filter((e) => Number(e.id) > Number(last ?? 0)).length > 0 });
    }
    const org = orgByHeader(headers);
    if (!org) return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    if (method === "GET" && p === "/v1/agent/peppol/recipient") {
      const id = url.searchParams.get("peppolId") ?? "";
      return json(200, { data: { peppol_id: id, found: [...orgs.values()].some((o) => o.participant === id), lookup_unavailable: false } });
    }
    if (method === "POST" && p === "/v1/agent/peppol/preflight") {
      return json(200, { data: { send_ready: org.participant !== null, validator_unavailable: false, repair: [] } });
    }
    if (method === "POST" && p === "/v1/agent/peppol/connector/send") {
      if (failSend > 0) {
        failSend--;
        return json(503, { error: { code: "UNAVAILABLE", message: "temporarily unavailable" } });
      }
      const key = headers.get("idempotency-key") ?? "";
      const prev = idem.get(key);
      if (prev) return prev.bodySha === sha(body) ? new Response(prev.response, { status: 200, headers: { "content-type": "application/json" } }) : json(409, { error: { code: "CONFLICT", message: "Idempotency-Key reuse" } });
      const parsed = JSON.parse(body) as { document: { xmlBase64: string } };
      const xml = new Uint8Array(Buffer.from(parsed.document.xmlBase64, "base64"));
      const text = new TextDecoder().decode(xml);
      const number = /<cbc:ID>([^<]+)<\/cbc:ID>/.exec(text)?.[1] ?? "X";
      let response: string;
      if (!org.participant) {
        response = JSON.stringify({ data: { status: "rejected", reason: "ingest", error: "Peppol účet nie je aktívny — zavolajte enroll" } });
      } else {
        const endpoints = [...text.matchAll(/<cbc:EndpointID schemeID="([0-9]{4})">([^<]+)<\/cbc:EndpointID>/g)].map((m) => `${m[1]}:${m[2]}`);
        const receiverParticipant = endpoints[1] ?? null;
        const target = [...orgs.values()].find((o) => o.participant === receiverParticipant && o.reception === "active");
        const invoiceId = randomUUID();
        sent.set(invoiceId, { orgId: org.id, xml, number });
        emit("peppol.document.sent", org.id, { invoiceId, invoiceNumber: number, documentType: "invoice", mode: "test", state: "SENT", messageId: "m", transactionId: "t" }, `peppol.document.sent:${invoiceId}`);
        if (target) {
          const rid = randomUUID();
          received.push({ id: rid, orgId: target.id, xml, senderParticipant: org.participant, number, acknowledgedAt: null });
          emit("peppol.document.delivered", org.id, { invoiceId, invoiceNumber: number, documentType: "invoice", mode: "test", state: "DELIVERED", messageId: "m", transactionId: "t" }, `peppol.document.delivered:${invoiceId}`);
          emit("peppol.document.received", target.id, { senderName: org.name, senderParticipantId: org.participant, documentNumber: number, documentType: "invoice", total: "12.30", currency: "EUR" }, `peppol.document.received:${rid}`);
        }
        response = JSON.stringify({ data: { status: "queued", invoice_id: invoiceId, document_id: `${org.participant}#${number}`, send_ready: true } });
      }
      idem.set(key, { bodySha: sha(body), response });
      return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && p.startsWith("/v1/agent/peppol/status/")) {
      const s = sent.get(p.split("/").at(-1) ?? "");
      return s && s.orgId === org.id ? json(200, { data: { invoice_id: p.split("/").at(-1), state: "SENT", updated_at: new Date().toISOString() } }) : json(200, { data: { state: "not_sent" } });
    }
    if (method === "GET" && /\/peppol\/sent\/[^/]+\/evidence$/.test(p)) {
      const inv = p.split("/")[5];
      const s = sent.get(inv);
      if (!s || s.orgId !== org.id) return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
      const delivered = received.some((r) => r.xml === s.xml);
      return json(200, { data: { invoice_id: inv, document_id: "d", ubl_sha256: sha(s.xml), delivery_status: delivered ? { state: "delivered", at: new Date().toISOString() } : null, transactions: [{ state: "SENT", mode: "test" }] } });
    }
    if (method === "GET" && p === "/v1/agent/peppol/received") {
      const onlyNew = url.searchParams.get("acknowledged") === "false";
      return json(200, {
        data: received
          .filter((r) => r.orgId === org.id && (!onlyNew || !r.acknowledgedAt))
          .map((r) => ({ id: r.id, sender_participant_id: r.senderParticipant, sender_name: "x", sender_ico: null, document_type: "invoice", document_number: r.number, total: "12.30", currency: "EUR", status: "new", received_at: new Date().toISOString(), acknowledged_at: r.acknowledgedAt, is_test: true })),
      });
    }
    if (method === "GET" && /\/received\/[^/]+\/xml$/.test(p)) {
      const r = received.find((x) => x.id === p.split("/")[5] && x.orgId === org.id);
      return r ? new Response(r.xml, { status: 200, headers: { "content-type": "application/xml" } }) : json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    }
    if (method === "POST" && /\/received\/[^/]+\/acknowledge$/.test(p)) {
      const r = received.find((x) => x.id === p.split("/")[5] && x.orgId === org.id);
      if (!r) return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
      const already = r.acknowledgedAt !== null;
      r.acknowledgedAt ??= new Date().toISOString();
      return json(200, { data: { id: r.id, acknowledged_at: r.acknowledgedAt, already_acknowledged: already } });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
  }

  return { fetch: handle, orgs, events, received, sent, requests };
}
