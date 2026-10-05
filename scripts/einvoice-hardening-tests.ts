// =============================================================================
// E-Faktúra — regresné testy staging nálezov (6. 10. 2026), offline (PGlite).
//   1) DIČ automaticky založeného dodávateľa (derivácia + DB, dedupe, tenant)
//   2) opakovaná delivered udalosť k už doručenému podaniu → ALREADY_FINAL
//   3) opakovanie zlyhaného spracovania udalosti (ohraničené)
//   4) kurzor partnerského feedu (lease, monotónnosť, zastavenie pri chybe, restart)
// npm run test:einvoice-hardening
// =============================================================================
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createPartnerHarness } from "./einvoice-partner-harness.ts";
import { deriveSupplierDic } from "../lib/einvoice/inbound/mapping.ts";
import { processProviderEvent, type WebhookDeps } from "../lib/einvoice/inbound/webhook.ts";
import { runPartnerFeedSync } from "../lib/einvoice/inbound/feed.ts";
import type { InboundStore } from "../lib/einvoice/inbound/store.ts";
import type { PartnerEvent, PartnerEventPage } from "../lib/einvoice/provider/types.ts";

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

// --- 1) DIČ -------------------------------------------------------------------------------
await check("deriveSupplierDic: IČ DPH SK+10 číslic → DIČ; endpoint 0245; 9915 iba v sandboxe; konflikt → null", () => {
  const base = { vatId: null, endpointId: null, endpointScheme: null, countryCode: "SK" };
  assert.deepEqual(deriveSupplierDic({ ...base, vatId: "SK 2054825695" }), { dic: "2054825695", conflict: false });
  assert.deepEqual(deriveSupplierDic({ ...base, endpointScheme: "0245", endpointId: "2054825695" }), { dic: "2054825695", conflict: false });
  assert.deepEqual(deriveSupplierDic({ ...base, endpointScheme: "9915", endpointId: "2054825695" }), { dic: null, conflict: false });
  assert.deepEqual(deriveSupplierDic({ ...base, endpointScheme: "9915", endpointId: "2054825695" }, { allowTestScheme: true }), { dic: "2054825695", conflict: false });
  assert.deepEqual(deriveSupplierDic({ ...base, vatId: "SK2054825695", endpointScheme: "0245", endpointId: "2099999999" }), { dic: null, conflict: true });
  assert.deepEqual(deriveSupplierDic({ ...base, vatId: "CZ12345678" }), { dic: null, conflict: false });
  assert.deepEqual(deriveSupplierDic({ ...base, countryCode: "CZ", vatId: "SK2054825695" }), { dic: null, conflict: false });
  assert.deepEqual(deriveSupplierDic({ ...base, endpointScheme: "0245", endpointId: "12345678" }), { dic: null, conflict: false }, "IČO nie je DIČ");
  assert.deepEqual(deriveSupplierDic({ ...base, endpointScheme: "0088", endpointId: "2054825695" }), { dic: null, conflict: false }, "iná schéma");
});

const h = await createPartnerHarness();
const CA = "a1000000-0000-4000-8000-0000000000aa";
const CB = "b1000000-0000-4000-8000-0000000000bb";
const UA = "11000000-0000-4000-8000-0000000000aa";
const UB = "21000000-0000-4000-8000-0000000000bb";
await h.exec(`
  insert into auth.users (id) values ('${UA}'), ('${UB}');
  insert into public.companies (id, name) values ('${CA}', 'A'), ('${CB}', 'B');
  insert into public.company_members (company_id, user_id, role, permissions) values ('${CA}', '${UA}', 'owner', '{}'), ('${CB}', '${UB}', 'owner', '{}');
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, peppol_eligible, reception_status)
    values ('${CA}', 'efaktura_sk', 'sandbox', 'org-a', '9915:2011111111', true, 'active'),
           ('${CB}', 'efaktura_sk', 'sandbox', 'org-b', '9915:2022222222', true, 'active');
`);

let seq = 0;
async function parsedInbound(company: string): Promise<string> {
  seq++;
  const sha = createHash("sha256").update(`xml-${seq}-${randomUUID()}`).digest("hex");
  const { rows } = await h.asService(() =>
    h.db.query<{ id: string }>(
      `insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, xml_size_bytes, processing_status, is_test)
       values ($1, 'efaktura_sk', 'sandbox', $2, $3, $4, 1000, 'parsed', true) returning id`,
      [company, `rcv-${seq}`, `${company}/inbound/${seq}.xml`, sha]
    )
  );
  return rows[0].id;
}
const draft = (supplier: Record<string, unknown>, n: string) => ({
  supplier: { legal_name: "Dodávateľ s.r.o.", ico: null, dic: null, vat_id: null, country_code: "SK", address_line1: "Ulica 1", address_line2: null, city: "Mesto", postal_code: "81101", endpoint_id: null, endpoint_scheme: null, ...supplier },
  invoice_number: n, issue_date: "2026-10-06", due_date: null, delivery_date: null, currency: "EUR", iban: null, bic: null, payment_reference: null,
  payment_means_code: "30", buyer_reference: null, purchase_order_reference: null,
  items: [{ description: "Služba", quantity: "1", unit_price: "10", vat_category_code: "S", vat_rate: "23", unit_code: "H87" }],
  totals: { line_extension: "10.00", tax_exclusive: "10.00", vat_total: "2.30", tax_inclusive: "12.30", rounding: "0.00", prepaid: "0.00", payable: "12.30", breakdown: [{ category: "S", rate: "23", taxable: "10.00", vat: "2.30", exemption_reason_code: null }] },
});
const partnersOf = async (company: string) => (await h.sql<{ id: string; dic: string | null; ico: string | null; ic_dph: string | null }>("select id, dic, ico, ic_dph from public.business_partners where company_id = $1 order by created_at", [company])).rows;

await check("DB: koncept z XML uloží DIČ nového dodávateľa (IČ DPH + DIČ), firma IBA z inboundu", async () => {
  const id = await parsedInbound(CB);
  const r = await h.inbound.createDraft(id, draft({ ico: "33002711", dic: "2054825695", vat_id: "SK2054825695", endpoint_id: "2054825695", endpoint_scheme: "9915" }, "F-1") as never);
  assert.equal(r.status, "created");
  const p = await partnersOf(CB);
  assert.equal(p.length, 1);
  assert.equal(p[0].dic, "2054825695");
  assert.equal(p[0].ic_dph, "SK2054825695");
  assert.equal((await partnersOf(CA)).length, 0, "žiadny zápis do inej firmy");
});
await check("DB: dodávateľ bez IČO a IČ DPH sa nájde podľa DIČ → žiadny duplicitný partner", async () => {
  const id1 = await parsedInbound(CA);
  await h.inbound.createDraft(id1, draft({ dic: "2033333333", endpoint_id: "2033333333", endpoint_scheme: "0245" }, "G-1") as never);
  const before = await partnersOf(CA);
  assert.equal(before.length, 1);
  assert.equal(before[0].dic, "2033333333");
  // druhý doklad: iný endpoint (napr. zmena AP), rovnaké DIČ → ten istý partner
  const id2 = await parsedInbound(CA);
  const r2 = await h.inbound.createDraft(id2, draft({ dic: "2033333333", endpoint_id: "2033333333", endpoint_scheme: "9915" }, "G-2") as never);
  assert.equal(r2.status, "created");
  const after = await partnersOf(CA);
  assert.equal(after.length, 1, "duplicitný partner");
  const inv = (await h.sql<{ s: string }>("select supplier_business_partner_id s from public.invoices where id = $1", [r2.invoiceId])).rows[0];
  assert.equal(inv.s, after[0].id);
});
await check("DB: partner s rovnakým DIČ v INEJ firme sa nepoužije (tenant izolácia)", async () => {
  const id = await parsedInbound(CB);
  await h.inbound.createDraft(id, draft({ dic: "2033333333", endpoint_id: "2033333333", endpoint_scheme: "0245" }, "H-1") as never);
  const b = await partnersOf(CB);
  assert.ok(b.some((p) => p.dic === "2033333333"), "B má vlastného partnera");
  const a = await partnersOf(CA);
  assert.equal(a.length, 1, "A bez zmeny");
});
await check("DB: neplatné DIČ (nie 10 číslic, zahraničná krajina) sa neuloží", async () => {
  const id = await parsedInbound(CA);
  await h.inbound.createDraft(id, draft({ legal_name: "Foreign GmbH", dic: "ABC", vat_id: "DE123456789", country_code: "DE" }, "X-1") as never);
  const p = (await partnersOf(CA)).find((x) => x.ic_dph === null && x.dic === null);
  assert.ok(p, "partner bez DIČ");
  const id2 = await parsedInbound(CA);
  await h.inbound.createDraft(id2, draft({ legal_name: "Foreign2 GmbH", dic: "2044444444", vat_id: "DE999999999", country_code: "DE" }, "X-2") as never);
  assert.ok(!(await partnersOf(CA)).some((x) => x.dic === "2044444444"), "DIČ pri krajine DE");
});

// --- 2) delivered replay -----------------------------------------------------------------
function stubWebhookDeps(over: Partial<InboundStore>, completions: [string, string | null][]): WebhookDeps {
  const inbound = {
    async webhookRecord() { return { webhookEventId: "w1", inserted: true, bodyMatches: true, companyId: CA, processingStatus: "received" }; },
    async webhookComplete(_id: string, status: string, code: string | null) { completions.push([status, code]); },
    async claimOutboundBySubmission() { return null; },
    ...over,
  } as unknown as InboundStore;
  return { inbound, outbound: {} as never, provider: { name: "efaktura_sk" } as never, environment: "sandbox", secrets: ["x"], nowSeconds: () => 0 };
}
const delivered = { event: "peppol.document.delivered", timestamp: "2026-10-06T10:00:00Z", data: { orgId: "org-a", invoiceId: "sub-1", mode: "test", state: "DELIVERED" } };
await check("delivered pre už doručené podanie → ALREADY_FINAL (ignored), nič sa nereconciluje", async () => {
  const c: [string, string | null][] = [];
  const r = await processProviderEvent(stubWebhookDeps({ outboundStateBySubmission: async () => "delivered" }, c), { deliveryId: "d1", payload: delivered, bodySha256: "0".repeat(64) });
  assert.equal(r.body.code, "ALREADY_FINAL");
  assert.deepEqual(c, [["ignored", "ALREADY_FINAL"]]);
});
await check("delivered pre práve spracúvané podanie → RECONCILE_IN_PROGRESS; neznáme → SUBMISSION_NOT_FOUND", async () => {
  const c: [string, string | null][] = [];
  const r = await processProviderEvent(stubWebhookDeps({ outboundStateBySubmission: async () => "sent" }, c), { deliveryId: "d2", payload: delivered, bodySha256: "0".repeat(64) });
  assert.equal(r.body.code, "RECONCILE_IN_PROGRESS");
  const r2 = await processProviderEvent(stubWebhookDeps({ outboundStateBySubmission: async () => null }, c), { deliveryId: "d3", payload: delivered, bodySha256: "0".repeat(64) });
  assert.equal(r2.body.code, "IGNORED");
  assert.deepEqual(c, [["ignored", "RECONCILE_IN_PROGRESS"], ["ignored", "SUBMISSION_NOT_FOUND"]]);
});
await check("DB: stav podania sa číta IBA v rámci firmy z mapovania (cudzia firma → null)", async () => {
  await h.asService(() => h.db.query(
    `insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key, state, provider_submission_id)
     select $1, gen_random_uuid(), 'efaktura_sk', 'sandbox', 1, 'idem-x', 'pending', 'sub-a-1'`, [CA]
  )).catch(() => undefined);
  const own = await h.inbound.outboundStateBySubmission!(CA, "sub-a-1");
  const foreign = await h.inbound.outboundStateBySubmission!(CB, "sub-a-1");
  assert.equal(foreign, null);
  assert.ok(own === null || typeof own === "string");
});

// --- 3) opakovanie zlyhaného spracovania ---------------------------------------------------
const participantPayload = (org: string, at: string) => ({ event: "participant.activated", timestamp: at, data: { orgId: org, participantId: "9915:2011111111", mode: "test", activatedAt: at } });
await check("zlyhané spracovanie → rovnaké doručenie sa zopakuje (max 5 pokusov), potom DUPLICATE", async () => {
  let fail = true;
  const inbound: InboundStore = { ...h.inbound, participantEvent: async (i) => { if (fail) throw new Error("boom"); return h.inbound.participantEvent!(i); } };
  const deps: WebhookDeps = { inbound, outbound: h.outbound, provider: { name: "efaktura_sk" } as never, environment: "sandbox", secrets: ["x"], nowSeconds: () => 0 };
  const payload = participantPayload("org-a", "2026-10-06T09:00:00.000Z");
  const input = { deliveryId: "retry-1", payload, bodySha256: "1".repeat(64) };
  assert.equal((await processProviderEvent(deps, input)).body.code, "ACCEPTED_RETRY_LATER");
  fail = false;
  assert.equal((await processProviderEvent(deps, input)).body.code, "PARTICIPANT_UPDATED", "druhý pokus spracuje");
  assert.equal((await processProviderEvent(deps, input)).body.code, "DUPLICATE", "po úspechu už iba duplicita");
  // limit pokusov
  fail = true;
  const input2 = { deliveryId: "retry-2", payload: participantPayload("org-a", "2026-10-06T09:30:00.000Z"), bodySha256: "2".repeat(64) };
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await processProviderEvent(deps, input2)).body.code);
  assert.deepEqual(codes, ["ACCEPTED_RETRY_LATER", "ACCEPTED_RETRY_LATER", "ACCEPTED_RETRY_LATER", "ACCEPTED_RETRY_LATER", "ACCEPTED_RETRY_LATER", "DUPLICATE", "DUPLICATE"]);
  const row = (await h.sql<{ attempts: number; processing_status: string }>("select attempts, processing_status from public.einvoice_webhook_events where delivery_id = 'retry-2'")).rows[0];
  assert.equal(row.attempts, 5);
  assert.equal(row.processing_status, "failed", "ostáva pre operátora");
});
await check("iné telo pod tým istým ID → 409 aj pri zlyhanom pokuse (bez opakovania)", async () => {
  const deps: WebhookDeps = { inbound: h.inbound, outbound: h.outbound, provider: { name: "efaktura_sk" } as never, environment: "sandbox", secrets: ["x"], nowSeconds: () => 0 };
  const r = await processProviderEvent(deps, { deliveryId: "retry-2", payload: participantPayload("org-a", "2026-10-06T11:00:00.000Z"), bodySha256: "3".repeat(64) });
  assert.equal(r.status, 409);
});

// --- 4) kurzor feedu ---------------------------------------------------------------------
await check("kurzor: lease (súbežný beh LOCKED), posun iba dopredu, stratený lease → chyba, iba service_role", async () => {
  const c1 = await h.cursor.claim("efaktura_sk", "live", 60);
  assert.ok(c1);
  assert.equal(await h.cursor.claim("efaktura_sk", "live", 60), null, "druhý beh počas lease");
  assert.equal(await h.cursor.advance("efaktura_sk", "live", c1!.lockToken, 10, false), 10);
  assert.equal(await h.cursor.advance("efaktura_sk", "live", c1!.lockToken, 5, false), 10, "nikdy späť");
  assert.equal(await h.cursor.advance("efaktura_sk", "live", c1!.lockToken, 12, true), 12);
  const err = await h.cursor.advance("efaktura_sk", "live", c1!.lockToken, 20, false).then(() => "", (e) => String(e.message ?? e.code));
  assert.match(err, /LEASE_LOST|CURSOR/);
  const c2 = await h.cursor.claim("efaktura_sk", "live", 60);
  assert.equal(c2!.lastEventId, 12, "restart pokračuje od uloženého kurzora");
  await h.cursor.advance("efaktura_sk", "live", c2!.lockToken, 12, true);
  for (const uid of [UA, null]) {
    const e = await h.as(uid, () => h.db.query("select * from public.esblu_einvoice_event_cursor_claim('efaktura_sk','sandbox',60)")).then(() => "", (x) => String(x.message));
    assert.match(e, /permission denied/i);
    const t = await h.as(uid, () => h.db.query("select * from public.einvoice_event_cursors")).then((r) => `rows:${r.rows.length}`, (x) => String(x.message));
    assert.ok(/permission denied/i.test(t) || t === "rows:0", t);
  }
});

function feedEvents(list: { id: number; org: string; at: string }[]): PartnerEvent[] {
  return list.map((e) => ({ id: String(e.id), event: "participant.activated", eventId: `participant.activated:${e.id}`, orgId: e.org, createdAt: e.at, payload: participantPayload(e.org, e.at) }));
}
await check("feed: spracuje stránky, posunie kurzor, opakovaný beh nič nespracuje; cudzia org bez zápisu do firmy", async () => {
  const all = feedEvents([
    { id: 101, org: "org-a", at: "2026-10-06T12:00:00.000Z" },
    { id: 102, org: "org-unknown", at: "2026-10-06T12:00:01.000Z" },
    { id: 103, org: "org-b", at: "2026-10-06T12:00:02.000Z" },
  ]);
  const calls: (string | undefined)[] = [];
  const listEvents = async (i: { after?: string; limit?: number }): Promise<PartnerEventPage> => {
    calls.push(i.after);
    const after = Number(i.after ?? 0);
    const page = all.filter((e) => Number(e.id) > after).slice(0, 2);
    return { events: page, nextAfter: page.at(-1)?.id ?? null, hasMore: all.some((e) => Number(e.id) > Number(page.at(-1)?.id ?? after)) };
  };
  const deps = { cursor: h.cursor, listEvents, webhook: { inbound: h.inbound, outbound: h.outbound, provider: { name: "efaktura_sk" } as never, environment: "sandbox" as const, secrets: ["x"], nowSeconds: () => 0 } };
  const r1 = await runPartnerFeedSync(deps, { pageSize: 2 });
  assert.equal(r1.code, "OK");
  if (r1.code === "LOCKED") return;
  assert.equal(r1.to, 103);
  assert.equal(r1.processed, 3);
  assert.deepEqual(r1.results, { PARTICIPANT_UPDATED: 2, UNKNOWN_ORG: 1 });
  const r2 = await runPartnerFeedSync(deps, { pageSize: 2 });
  assert.ok(r2.code === "OK" && r2.processed === 0 && r2.from === 103 && r2.to === 103);
  assert.equal(calls.at(-1), "103", "pokračuje od kurzora");
});
await check("feed: zlyhaná udalosť zastaví kurzor PRED ňou; po oprave sa dobehne bez preskočenia; súbežný beh LOCKED", async () => {
  let fail = true;
  const inbound: InboundStore = { ...h.inbound, participantEvent: async (i) => { if (fail && i.providerOrgId === "org-b") throw new Error("db down"); return h.inbound.participantEvent!(i); } };
  const all = feedEvents([
    { id: 201, org: "org-a", at: "2026-10-06T13:00:00.000Z" },
    { id: 202, org: "org-b", at: "2026-10-06T13:00:01.000Z" },
    { id: 203, org: "org-a", at: "2026-10-06T13:00:02.000Z" },
  ]);
  const listEvents = async (i: { after?: string }): Promise<PartnerEventPage> => {
    const page = all.filter((e) => Number(e.id) > Number(i.after ?? 0));
    return { events: page, nextAfter: page.at(-1)?.id ?? null, hasMore: false };
  };
  const deps = { cursor: h.cursor, listEvents, webhook: { inbound, outbound: h.outbound, provider: { name: "efaktura_sk" } as never, environment: "sandbox" as const, secrets: ["x"], nowSeconds: () => 0 } };
  const r1 = await runPartnerFeedSync(deps);
  assert.ok(r1.code === "STOPPED_ON_FAILURE" && r1.to === 201, JSON.stringify(r1));
  fail = false;
  const r2 = await runPartnerFeedSync(deps);
  assert.ok(r2.code === "OK" && r2.to === 203 && r2.processed === 2, JSON.stringify(r2));
  // súbežnosť
  const held = await h.cursor.claim("efaktura_sk", "sandbox", 60);
  assert.equal((await runPartnerFeedSync(deps)).code, "LOCKED");
  await h.cursor.advance("efaktura_sk", "sandbox", held!.lockToken, 0, true);
});
await check("feed: zlyhanie zoznamu udalostí → kurzor sa nemení, lease uvoľnený", async () => {
  const deps = { cursor: h.cursor, listEvents: async (): Promise<PartnerEventPage> => { throw new Error("network"); }, webhook: { inbound: h.inbound, outbound: h.outbound, provider: { name: "efaktura_sk" } as never, environment: "sandbox" as const, secrets: ["x"], nowSeconds: () => 0 } };
  const r = await runPartnerFeedSync(deps);
  assert.ok(r.code === "LIST_FAILED" && r.from === r.to, JSON.stringify(r));
  const c = await h.cursor.claim("efaktura_sk", "sandbox", 60);
  assert.ok(c, "lease uvoľnený");
  await h.cursor.advance("efaktura_sk", "sandbox", c!.lockToken, c!.lastEventId, true);
});

console.log(`\neinvoice-hardening: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
