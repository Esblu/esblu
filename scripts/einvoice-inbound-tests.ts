// =============================================================================
// E-Faktúra — Phase 3 INBOUND: webhook / poll → fetch XML → nemenné uloženie +
// hash → parse → dedupe → koncept prijatej faktúry → ACK.
//
// SKUTOČNÝ PostgreSQL (PGlite) so všetkými fakturačnými migráciami, nárokmi a
// migráciami E-Faktúry (vrátane 20261002130000_einvoice_inbound_flow).
// Poskytovateľ je SKRIPTOVANÝ fake (žiadna sieť, žiadne kľúče, nič live).
// Privilegovaná vrstva volá tie isté serverové RPC ako produkčné supabase-store.ts.
//
// SPUSTENIE: npm run test:einvoice-inbound   (PGlite: npm i --no-save @electric-sql/pglite@0.5.8)
// =============================================================================

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleEinvoiceWebhook, classifyWebhookEvent, WEBHOOK_MAX_BODY_BYTES } from "../lib/einvoice/inbound/webhook.ts";
import { processInboundRow, runInboundPoll, runInboundProcessBatch } from "../lib/einvoice/inbound/processor.ts";
import { InboundStoreError, inboundXmlPath, type InboundRow, type InboundStore } from "../lib/einvoice/inbound/store.ts";
import { mapInboundDraft } from "../lib/einvoice/inbound/mapping.ts";
import { dbErrorCode, OutboundStoreError, type OutboundRow, type OutboundStore } from "../lib/einvoice/outbound/store.ts";
import {
  EinvoiceProviderError,
  type EinvoiceProvider,
  type InboundSummary,
  type OutboundState,
  type ProviderContext,
} from "../lib/einvoice/provider/types.ts";
import { generateUbl } from "../lib/einvoice/ubl/generate.ts";
import { parseInboundUbl } from "../lib/einvoice/ubl/parse.ts";
import type { UblInvoiceSnapshot, UblParty } from "../lib/einvoice/ubl/model.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

// -----------------------------------------------------------------------------
// Zachytenie logov: E-Faktúra nesmie logovať telo webhooku, XML ani tajomstvá.
// -----------------------------------------------------------------------------
const logged: string[] = [];
for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    if (method === "error" || method === "log") original(...args);
  };
}

async function loadPglite(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  const crypto = dir ? pathToFileURL(path.join(dir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto";
  try {
    const { PGlite } = await import(main);
    const { pgcrypto } = await import(crypto);
    return new PGlite({ extensions: { pgcrypto } }) as Db;
  } catch (error) {
    console.error("PGlite nie je nainštalovaný: npm i --no-save @electric-sql/pglite@0.5.8  (alebo PGLITE_DIR=…)");
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

await db.exec(read("scripts/sql/pglite/einvoice-baseline.sql"));
for (const migration of [
  "20260916120000_add_company_billing_profile_and_business_partners.sql",
  "20260916094000_add_invoicing_core_schema.sql",
  "20260916095000_add_invoicing_core_rpc.sql",
  "20260916100000_harden_invoice_trigger_execute_grants.sql",
  "20260916140000_finance_access_hardening.sql",
  "20260916150000_finalize_invoice_category_aware_vat.sql",
  "20260917100000_add_invoicing_en16931_p0_fields.sql",
  "20260920120000_add_received_invoice_core.sql",
  "20260920121000_add_invoice_dedupe.sql",
  "20260920122000_add_invoicing_en16931_p1_fields.sql",
  "20260920140000_direction_aware_invoice_finalize.sql",
  "20260920150000_harden_finalized_invoice_immutability.sql",
  "20260921100000_add_received_invoice_intake.sql",
  "20260921120000_finance_document_access_hardening.sql",
  "20260921160000_partner_payment_identifiers.sql",
  "20260923100000_add_accounting_handoff_lifecycle.sql",
  "20260923140000_harden_accounting_handoff.sql",
  "20260923170000_harden_client_role_privileges.sql",
  "20260923190000_canonical_price_mode.sql",
  "20260923210000_complete_handoff_package.sql",
  "20260928100000_company_entitlements_trial.sql",
  "20260929100000_closed_beta_p0_hardening.sql",
  "20261002100000_einvoice_foundation.sql",
  "20261002110000_einvoice_en16931_fields.sql",
  "20261002120000_einvoice_outbound_flow.sql",
  // --- predmet testu ---
  "20261002130000_einvoice_inbound_flow.sql",
  // regresia: Phase 4 nesmie zmeniť inbound správanie
  "20261002140000_einvoice_operations.sql",
  "20261002150000_einvoice_rollout_gate.sql",
]) {
  try {
    await db.exec(read(`supabase/migrations/${migration}`));
  } catch (error) {
    console.error(`Migrácia ${migration} zlyhala: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
await db.exec(read("scripts/sql/pglite/einvoice-prod-helpers.sql"));

// -----------------------------------------------------------------------------
// Jedno spojenie → transakcie serializované zámkom
// -----------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  return locked(async () => {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await db.exec("set local role authenticated");
      const result = await fn();
      await db.exec("commit");
      return result;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  });
}
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  return locked(async () => {
    await db.exec("begin");
    try {
      await db.exec("set local role service_role");
      const result = await fn();
      await db.exec("commit");
      return result;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  });
}
const sql = <T = Row>(text: string, params: unknown[] = []) => locked(() => db.query<T>(text, params));
async function errorOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// -----------------------------------------------------------------------------
// Privilegovaná vrstva nad PGlite (tie isté RPC ako supabase-store.ts)
// -----------------------------------------------------------------------------
const storage = new Map<string, Uint8Array>();
let storageFail = false;
const svc = async <T>(text: string, params: unknown[]): Promise<T[]> => {
  try {
    return (await asService(() => db.query<T>(text, params))).rows;
  } catch (error) {
    throw new InboundStoreError(dbErrorCode(error instanceof Error ? error.message : null));
  }
};
const inboundStore: InboundStore = {
  async webhookRecord(i) {
    const [r] = await svc<Row>("select * from public.esblu_einvoice_webhook_record($1, $2, $3, $4, $5, $6)", [i.provider, i.environment, i.deliveryId, i.providerOrgId, i.event, i.bodySha256]);
    return { webhookEventId: r.webhook_event_id as string, inserted: r.inserted as boolean, bodyMatches: r.body_matches as boolean, companyId: (r.company_id as string) ?? null, processingStatus: r.processing_status as string };
  },
  async webhookComplete(id, status, code) {
    await svc("select public.esblu_einvoice_webhook_complete($1, $2, $3)", [id, status, code]);
  },
  async register(i) {
    const [r] = await svc<Row>("select * from public.esblu_einvoice_inbound_register($1, $2, $3, $4, $5, $6::jsonb)", [i.provider, i.environment, i.providerOrgId, i.providerReceivedId, i.source, JSON.stringify(i.meta)]);
    return { inboundId: r.inbound_id as string, created: r.created as boolean, processingStatus: r.processing_status as string, companyId: r.company_id as string };
  },
  async claim(limit, lease) {
    return (await svc<{ j: InboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_claim_inbound($1, $2) t", [limit, lease])).map((r) => r.j);
  },
  async transition(id, expected, to, source, code, fields) {
    const [r] = await svc<{ j: InboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_inbound_transition($1, $2, $3, $4, $5, $6::jsonb) t", [id, expected, to, source, code, JSON.stringify(fields)]);
    return r.j;
  },
  async createDraft(id, draft) {
    const [r] = await svc<{ j: Row }>("select public.esblu_einvoice_inbound_create_draft($1, $2::jsonb) j", [id, JSON.stringify(draft)]);
    return { status: r.j.status as "created" | "duplicate", invoiceId: r.j.invoice_id as string, matchedOn: (r.j.matched_on as string) ?? null };
  },
  async findStoredXmlPath(companyId, sha, except) {
    const rows = await sql<{ p: string }>(
      "select xml_storage_path p from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2 and id <> $3 and xml_storage_path is not null limit 1",
      [companyId, sha, except]
    );
    return rows.rows[0]?.p ?? null;
  },
  async organizationFor(companyId, env) {
    const { rows } = await sql<Row>("select provider, provider_org_id, participant_id, peppol_eligible from public.einvoice_organizations where company_id = $1 and environment = $2", [companyId, env]);
    const o = rows[0];
    return o ? { provider: o.provider as string, providerOrgId: o.provider_org_id as string, participantId: o.participant_id as string, peppolEligible: o.peppol_eligible === true } : null;
  },
  async listOrganizations(provider, env) {
    const { rows } = await sql<Row>("select company_id, provider, provider_org_id, participant_id, peppol_eligible, environment from public.einvoice_organizations where provider = $1 and environment = $2 and peppol_eligible and provider_org_id is not null", [provider, env]);
    return rows.map((o) => ({ companyId: o.company_id as string, environment: o.environment as "sandbox", provider: o.provider as string, providerOrgId: o.provider_org_id as string, participantId: o.participant_id as string, peppolEligible: true }));
  },
  async companyForOrg(provider, env, orgId) {
    const { rows } = await sql<{ c: string }>("select company_id c from public.einvoice_organizations where provider = $1 and environment = $2 and provider_org_id = $3", [provider, env, orgId]);
    return rows[0]?.c ?? null;
  },
  async claimOutboundBySubmission(companyId, submissionId, lease) {
    const rows = await svc<{ j: OutboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_claim_outbound_by_submission($1, $2, $3) t", [companyId, submissionId, lease]);
    return rows[0]?.j ?? null;
  },
  async putXml(p, bytes) {
    if (storageFail) throw new InboundStoreError("STORAGE_FAILED");
    if (storage.has(p)) return "exists";
    storage.set(p, new Uint8Array(bytes));
    return "created";
  },
  async getXml(p) {
    const b = storage.get(p);
    return b ? new Uint8Array(b) : null;
  },
};
const outboundStore: OutboundStore = {
  async requestOutbound() { throw new Error("not used"); },
  async claim() { return []; },
  async transition(id, expected, to, source, code, fields) {
    try {
      const { rows } = await asService(() => db.query<{ j: OutboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_outbound_transition($1, $2, $3, $4, $5, $6::jsonb) t", [id, expected, to, source, code, JSON.stringify(fields)]));
      return rows[0].j;
    } catch (error) {
      throw new OutboundStoreError(dbErrorCode(error instanceof Error ? error.message : null));
    }
  },
  async organizationFor(companyId, env) {
    return inboundStore.organizationFor(companyId, env);
  },
  async putUbl() { return "created"; },
  async getUbl() { return null; },
};

// -----------------------------------------------------------------------------
// Skriptovaný poskytovateľ
// -----------------------------------------------------------------------------
type Doc = { org: string; summary: InboundSummary; xml: Uint8Array; acknowledged: boolean };
class FakeProvider implements EinvoiceProvider {
  readonly name = "mock";
  calls: string[] = [];
  docs = new Map<string, Doc>();
  fetchError: EinvoiceProviderError | null = null;
  ackErrors: EinvoiceProviderError[] = [];
  listError: EinvoiceProviderError | null = null;
  status = new Map<string, OutboundState>();
  private orgs = new Set(["org-a", "org-b"]);
  private ctx(c: ProviderContext) {
    if (c.environment !== "sandbox" || !this.orgs.has(c.providerOrgId)) throw new EinvoiceProviderError("EINVOICE_ORGANIZATION_NOT_FOUND");
  }
  add(org: string, id: string, xml: Uint8Array) {
    this.docs.set(id, { org, xml, acknowledged: false, summary: { providerReceivedId: id, senderParticipantId: "9915:2055555555", senderIco: "55555555", documentNumber: "IN", documentType: "invoice", receivedAt: null, isTest: true } });
  }
  async provisionOrganization(): Promise<never> { throw new Error("not used"); }
  async getOrganization(): Promise<never> { throw new Error("not used"); }
  async verifyRecipient(): Promise<never> { throw new Error("not used"); }
  async preflight(): Promise<never> { throw new Error("not used"); }
  async sendUbl(): Promise<never> { throw new Error("NEVER SEND IN INBOUND"); }
  async getOutboundStatus(c: ProviderContext, s: { providerSubmissionId: string }) {
    this.calls.push(`status:${s.providerSubmissionId}`);
    this.ctx(c);
    const state = this.status.get(s.providerSubmissionId);
    if (!state) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    return { state, receiverIdentifier: null, documentId: null, errorMessage: null, updatedAt: null };
  }
  async getDeliveryEvidence() { return null; }
  async findSubmissionByIdempotencyKey() { return { kind: "unknown" as const }; }
  async listUnacknowledgedInbound(c: ProviderContext) {
    this.calls.push("list");
    this.ctx(c);
    if (this.listError) throw this.listError;
    return [...this.docs.values()].filter((d) => d.org === c.providerOrgId && !d.acknowledged).map((d) => d.summary);
  }
  async getInboundDocument(c: ProviderContext, id: string) {
    this.calls.push(`fetch:${id}`);
    this.ctx(c);
    if (this.fetchError) throw this.fetchError;
    const d = this.docs.get(id);
    if (!d || d.org !== c.providerOrgId) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    return { providerReceivedId: id, xml: new Uint8Array(d.xml), pdf: null };
  }
  async acknowledgeInbound(c: ProviderContext, id: string) {
    this.calls.push(`ack:${id}`);
    this.ctx(c);
    const err = this.ackErrors.shift();
    if (err) throw err;
    const d = this.docs.get(id);
    if (!d || d.org !== c.providerOrgId) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    d.acknowledged = true; // idempotentné
  }
}
const provider = new FakeProvider();
const SECRET = "whsec_" + "test".repeat(8); // syntetický
const deps = () => ({ store: inboundStore, provider, environment: "sandbox" as const });
const webhookDeps = (now = Math.floor(Date.now() / 1000)) => ({
  inbound: inboundStore, outbound: outboundStore, provider, environment: "sandbox" as const, secrets: [SECRET], nowSeconds: () => now,
});
function signed(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { rawBody: new TextEncoder().encode(body), signatureHeader: `t=${ts},v1=${sig}` };
}
async function webhook(body: Record<string, unknown>, deliveryId: string, opts: { ts?: number; secret?: string; now?: number } = {}) {
  const raw = JSON.stringify(body);
  const s = signed(raw, opts.ts, opts.secret);
  return handleEinvoiceWebhook(webhookDeps(opts.now), { ...s, deliveryIdHeader: deliveryId });
}
/** Testovací posun času: riadky hneď splatné (iba superuser test). */
const makeDue = () => sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where processing_status not in ('acknowledged','failed')");

// -----------------------------------------------------------------------------
// Firmy, roly
// -----------------------------------------------------------------------------
const CA = "a0000000-0000-4000-8000-000000000001";
const CB = "b0000000-0000-4000-8000-000000000002";
const U = {
  owner: "10000000-0000-4000-8000-000000000001",
  acc: "10000000-0000-4000-8000-000000000002",
  adminFin: "10000000-0000-4000-8000-000000000003",
  adminView: "10000000-0000-4000-8000-000000000004",
  admin: "10000000-0000-4000-8000-000000000005",
  emp: "10000000-0000-4000-8000-000000000006",
  b: "20000000-0000-4000-8000-000000000001",
};
await locked(() => db.exec(`
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into public.companies (id, name) values ('${CA}', 'Syntetická A s.r.o.'), ('${CB}', 'Syntetická B s.r.o.');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CA}', '${U.owner}', 'owner', '{}'),
    ('${CA}', '${U.acc}', 'accountant', '{}'),
    ('${CA}', '${U.adminFin}', 'admin', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.adminView}', 'admin', '{"finance":{"view":true}}'),
    ('${CA}', '${U.admin}', 'admin', '{}'),
    ('${CA}', '${U.emp}', 'employee', '{"finance":{"view":true,"manage":true}}'),
    ('${CB}', '${U.b}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code, electronic_address, electronic_address_scheme_id)
    values ('${CA}', 'Syntetická A s.r.o.', '11111111', '2020000000', 'SK2020000000', 'Testovacia 1', 'Bratislava', '81101', 'SK', '2020000000', '9915'),
           ('${CB}', 'Syntetická B s.r.o.', '22222222', '2030000000', 'SK2030000000', 'Skúšobná 2', 'Košice', '04001', 'SK', '2030000000', '9915');
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, org_status, peppol_eligible)
    values ('${CA}', 'mock', 'sandbox', 'org-a', '9915:2020000000', 'active', true),
           ('${CB}', 'mock', 'sandbox', 'org-b', '9915:2030000000', 'active', true);
  insert into public.company_entitlements (company_id, entitlement_key, source, note)
    values ('${CA}', 'einvoice', 'manual', 'test'), ('${CB}', 'einvoice', 'manual', 'test');
  insert into public.einvoice_rollout (company_id, environment, stage, changed_by)
    values ('${CA}', 'sandbox', 'internal', 'test'), ('${CB}', 'sandbox', 'internal', 'test');
`));

// -----------------------------------------------------------------------------
// Syntetické prijaté UBL (vygenerované naším generátorom — platné EN16931 XML)
// -----------------------------------------------------------------------------
const supplierParty = (over: Partial<UblParty> = {}): UblParty => ({
  role: "seller", legal_name: "Dodávateľ X s.r.o.", ico: "55555555", dic: "2055555555", ic_dph: "SK2055555555",
  address_line1: "Dodávateľská 5", address_line2: null, city: "Trnava", postal_code: "91701", country_code: "SK",
  iban: "SK3112000000198742637541", bic: "TESTSKBX", email: null,
  electronic_address: "2055555555", electronic_address_scheme_id: "9915",
  legal_registration_id: null, legal_registration_scheme_id: null, vat_identifier: null, ...over,
});
const customerParty = (endpoint = "2020000000", ico = "11111111"): UblParty => ({
  role: "buyer", legal_name: "Syntetická A s.r.o.", ico, dic: endpoint, ic_dph: `SK${endpoint}`,
  address_line1: "Testovacia 1", address_line2: null, city: "Bratislava", postal_code: "81101", country_code: "SK",
  iban: null, bic: null, email: null, electronic_address: endpoint, electronic_address_scheme_id: "9915",
  legal_registration_id: null, legal_registration_scheme_id: null, vat_identifier: null,
});
function inboundXml(number: string, opts: { category?: "S" | "K"; endpoint?: string; customerIco?: string; supplier?: Partial<UblParty> } = {}): Uint8Array {
  const cat = opts.category ?? "S";
  const s: UblInvoiceSnapshot = {
    invoice: {
      id: "f0000000-0000-4000-8000-000000000001", company_id: "x", direction: "issued", kind: "regular_invoice", document_status: "finalized",
      invoice_number: number, issue_date: "2026-10-01", due_date: "2026-10-15", delivery_date: "2026-09-30", tax_point_date: null,
      currency: "EUR", subtotal_amount: 100, vat_total_amount: cat === "S" ? 23 : 0, total_amount: cat === "S" ? 123 : 100, rounding_amount: 0,
      buyer_reference: "REF-1", purchase_order_reference: null, payment_means_code: "30", payment_reference: "VS123", corrects_invoice_id: null,
    },
    seller: supplierParty(opts.supplier),
    buyer: customerParty(opts.endpoint, opts.customerIco),
    items: [{ position: 1, description: "Služba", quantity: 2, unit_code: "HUR", unit_price: 50, price_mode: "net", vat_category_code: cat, vat_rate: cat === "S" ? 23 : 0, line_net_amount: 100 }],
    taxBreakdowns: [{ vat_category_code: cat, vat_rate: cat === "S" ? 23 : 0, taxable_amount: 100, vat_amount: cat === "S" ? 23 : 0, vat_exemption_reason_code: null, vat_exemption_reason_text: null }],
    correctedInvoice: null,
  };
  const r = generateUbl(s);
  if (!r.ok) throw new Error(`fixture UBL: ${r.issues.map((i) => i.code).join(",")}`);
  return r.bytes;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const inboundByPid = async (pid: string) => (await sql<Row>("select * from public.einvoice_inbound where provider_received_id = $1", [pid])).rows[0];
const eventsOf = async (id: string) =>
  (await sql<Row>("select from_state, to_state, source, provider_code from public.einvoice_events where inbound_id = $1 order by created_at, id", [id])).rows.map((e) => `${e.from_state}->${e.to_state}:${e.source}`);

// =============================================================================
// Čisté časti
// =============================================================================
await check("klasifikácia udalostí webhooku: inbound / outbound / iné", () => {
  assert.equal(classifyWebhookEvent("peppol.document.received"), "inbound");
  assert.equal(classifyWebhookEvent("invoice.delivered"), "outbound");
  assert.equal(classifyWebhookEvent("peppol.transmission.failed"), "outbound");
  assert.equal(classifyWebhookEvent("organization.updated"), "other");
});

await check("mapovanie: profil EN16931, dobropis a neznáma DPH kategória = UNSUPPORTED_PROFILE; chýbajúce údaje = INVALID_XML", () => {
  const ok = parseInboundUbl(inboundXml("FA-M-1"));
  assert.ok(ok.ok);
  if (!ok.ok) return;
  const m = mapInboundDraft(ok.document, ok.reviewReasons, "9915:2020000000");
  assert.ok(m.ok);
  if (m.ok) {
    assert.equal(m.draft.supplier.ico, "55555555");
    assert.equal(m.draft.items[0].vat_category_code, "S");
    assert.equal(m.draft.iban, "SK3112000000198742637541");
    assert.deepEqual(m.reviewReasons, []);
  }
  assert.deepEqual(mapInboundDraft({ ...ok.document, customizationId: "urn:other:profile" }, [], null), { ok: false, code: "UNSUPPORTED_PROFILE", detail: "CUSTOMIZATION_NOT_EN16931" });
  assert.deepEqual(mapInboundDraft({ ...ok.document, documentType: "CreditNote" }, [], null), { ok: false, code: "UNSUPPORTED_PROFILE", detail: "CREDIT_NOTE_NOT_SUPPORTED" });
  assert.deepEqual(mapInboundDraft({ ...ok.document, lines: [{ ...ok.document.lines[0], vatCategory: "L" }] }, [], null), { ok: false, code: "UNSUPPORTED_PROFILE", detail: "VAT_CATEGORY_UNSUPPORTED" });
  assert.deepEqual(mapInboundDraft({ ...ok.document, invoiceNumber: null }, [], null), { ok: false, code: "INVALID_XML", detail: "MISSING_INVOICE_NUMBER" });
  const wrongRecipient = mapInboundDraft(ok.document, [], "9915:9999999999");
  assert.ok(wrongRecipient.ok && wrongRecipient.reviewReasons.includes("RECIPIENT_ENDPOINT_MISMATCH"));
});

await check("grant: inbound RPC iba service_role; jadro konceptu nikto; verejná RPC AI Inboxu ostáva pre authenticated", async () => {
  const { rows } = await sql<Row>(
    `select p.proname f, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('anon', p.oid, 'execute') anon,
            has_function_privilege('service_role', p.oid, 'execute') srv
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('esblu_einvoice_webhook_record', 'esblu_einvoice_webhook_complete', 'esblu_einvoice_inbound_register',
       'esblu_einvoice_claim_inbound', 'esblu_einvoice_inbound_transition', 'esblu_einvoice_inbound_create_draft',
       'esblu_einvoice_claim_outbound_by_submission', 'esblu_received_invoice_draft_core', 'esblu_einvoice_org_company', 'esblu_create_received_invoice_draft')`
  );
  assert.equal(rows.length, 10);
  for (const r of rows) {
    assert.equal(r.anon, false, String(r.f));
    if (r.f === "esblu_create_received_invoice_draft") assert.equal(r.auth, true);
    else assert.equal(r.auth, false, String(r.f));
    if (r.f === "esblu_received_invoice_draft_core" || r.f === "esblu_einvoice_org_company") assert.equal(r.srv, false, String(r.f));
    else if (r.f !== "esblu_create_received_invoice_draft") assert.equal(r.srv, true, String(r.f));
  }
});

// =============================================================================
// Webhook
// =============================================================================
const XML_1 = inboundXml("FA-IN-001");
provider.add("org-a", "rcv-001", XML_1);

await check("zlý podpis → 401 INVALID_SIGNATURE, nič sa nezaznamená ani nenačíta", async () => {
  provider.calls = [];
  const r = await webhook({ event: "peppol.document.received", organization_id: "org-a" }, "dlv-bad", { secret: "whsec_wrongwrongwrongwrongwrong" });
  assert.deepEqual(r, { status: 401, body: { code: "INVALID_SIGNATURE" } });
  const r2 = await handleEinvoiceWebhook(webhookDeps(), { rawBody: new TextEncoder().encode("{}"), signatureHeader: null, deliveryIdHeader: "x" });
  assert.equal(r2.body.code, "INVALID_SIGNATURE");
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_webhook_events");
  assert.equal(rows[0].n, 0);
  assert.deepEqual(provider.calls, []);
});

await check("expirovaná pečiatka (mimo okna 300 s) → 401 REPLAYED_WEBHOOK", async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await webhook({ event: "peppol.document.received", organization_id: "org-a" }, "dlv-old", { ts: now - 3600, now });
  assert.deepEqual(r, { status: 401, body: { code: "REPLAYED_WEBHOOK" } });
});

await check("príliš veľké telo → 413 (pred overením podpisu)", async () => {
  const r = await handleEinvoiceWebhook(webhookDeps(), { rawBody: new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1), signatureHeader: "t=1,v1=" + "0".repeat(64), deliveryIdHeader: "x" });
  assert.deepEqual(r, { status: 413, body: { code: "PAYLOAD_TOO_LARGE" } });
});

await check("platný webhook: firma IBA z provider_org_id (company_id v tele sa ignoruje) → fetch → uloženie → koncept → ACK", async () => {
  provider.calls = [];
  const r = await webhook({ event: "peppol.document.received", organization_id: "org-a", company_id: CB, data: { company_id: CB, received_id: "rcv-FAKE" } }, "dlv-1");
  assert.deepEqual(r, { status: 200, body: { code: "PROCESSED" } });
  const row = await inboundByPid("rcv-001");
  assert.equal(row.company_id, CA);
  assert.equal(row.processing_status, "acknowledged");
  assert.ok(!provider.calls.includes("fetch:rcv-FAKE"), "ID z tela webhooku sa nepoužije");
  assert.ok(provider.calls.includes("list"));
  const wh = (await sql<Row>("select processing_status, company_id, body_sha256, error from public.einvoice_webhook_events where delivery_id = 'dlv-1'")).rows[0];
  assert.equal(wh.processing_status, "processed");
  assert.equal(wh.company_id, CA);
  assert.match(String(wh.body_sha256), /^[0-9a-f]{64}$/);
  const cols = (await sql<{ c: string }>("select column_name c from information_schema.columns where table_schema = 'public' and table_name = 'einvoice_webhook_events'")).rows.map((x) => x.c);
  assert.ok(!cols.some((c) => /body$|payload|raw/.test(c) && c !== "body_sha256"), "telo sa neukladá");
});

await check("úspešné uloženie: presné bajty, SHA-256, veľkosť, cesta firma/inbound/poskytovateľ/ID/hash", async () => {
  const row = await inboundByPid("rcv-001");
  assert.equal(row.xml_sha256, sha(XML_1));
  assert.equal(row.xml_size_bytes, XML_1.byteLength);
  assert.equal(row.xml_storage_path, inboundXmlPath(CA, "mock", "rcv-001", sha(XML_1)));
  assert.deepEqual(storage.get(row.xml_storage_path as string), XML_1);
  assert.ok(row.received_at);
  assert.match(await errorOf(() => sql("update public.einvoice_inbound set xml_sha256 = $1 where id = $2", ["0".repeat(64), row.id])), /IDENTITY_IMMUTABLE/);
});

await check("úspešný koncept: prijatá faktúra (draft, efaktura_peppol, transport ID), dodávateľ podľa IČO, položky, mena, platba", async () => {
  const row = await inboundByPid("rcv-001");
  const inv = (await sql<Row>("select * from public.invoices where id = $1", [row.invoice_id])).rows[0];
  assert.equal(inv.company_id, CA);
  assert.equal(inv.direction, "received");
  assert.equal(inv.document_status, "draft");
  assert.equal(inv.source, "efaktura_peppol");
  assert.equal(inv.supplier_invoice_number, "FA-IN-001");
  assert.equal(inv.transport_provider, "mock");
  assert.equal(inv.transport_message_id, "rcv-001");
  assert.equal(inv.currency, "EUR");
  assert.equal(inv.iban, "SK3112000000198742637541");
  assert.equal(inv.payment_reference, "VS123");
  assert.equal(inv.created_by, null);
  const bp = (await sql<Row>("select company_id, ico, ic_dph, kind, electronic_address from public.business_partners where id = $1", [inv.supplier_business_partner_id])).rows[0];
  assert.deepEqual(bp, { company_id: CA, ico: "55555555", ic_dph: "SK2055555555", kind: "supplier", electronic_address: "2055555555" });
  const items = (await sql<Row>("select vat_category_code, quantity::text q, unit_price::text p, unit_code from public.invoice_items where invoice_id = $1", [row.invoice_id])).rows;
  assert.equal(items.length, 1);
  assert.equal(items[0].vat_category_code, "S");
  const ev = (await sql<Row>("select event_type, actor_source from public.invoice_events where invoice_id = $1", [row.invoice_id])).rows;
  assert.deepEqual(ev, [{ event_type: "created", actor_source: "system" }]);
});

await check("udalosti inbound: každá zmena stavu presne raz (webhook → job → provider), bez duplicít", async () => {
  const row = await inboundByPid("rcv-001");
  assert.deepEqual(await eventsOf(row.id as string), [
    "null->received:webhook", "received->stored:job", "stored->parsed:job", "parsed->draft_created:job", "draft_created->acknowledged:provider",
  ]);
});

await check("ACK až po koncepte: ACK volaný presne raz a až po vzniku konceptu; DB nedovolí acknowledged bez konceptu", async () => {
  const ackIdx = provider.calls.indexOf("ack:rcv-001");
  assert.ok(ackIdx > provider.calls.indexOf("fetch:rcv-001"));
  assert.equal(provider.calls.filter((c) => c === "ack:rcv-001").length, 1);
  provider.add("org-a", "rcv-guard", inboundXml("FA-GUARD"));
  const reg = await inboundStore.register({ provider: "mock", environment: "sandbox", providerOrgId: "org-a", providerReceivedId: "rcv-guard", source: "poll", meta: {} });
  assert.match(await errorOf(() => inboundStore.transition(reg.inboundId, "received", "acknowledged", "job", null, { acknowledged_at: new Date().toISOString() })), /INVALID_TRANSITION|DRAFT_REQUIRED|XML_REQUIRED/);
  assert.match(await errorOf(() => sql("update public.einvoice_inbound set processing_status = 'draft_created' where id = $1", [reg.inboundId])), /INVALID_TRANSITION|XML_REQUIRED|DRAFT_REQUIRED/);
});

await check("duplicitný webhook (rovnaké ID aj telo) → 200 DUPLICATE, nič nové; iné telo pod tým istým ID → 409 REPLAYED_WEBHOOK", async () => {
  const body = { event: "peppol.document.received", organization_id: "org-a", company_id: CB, data: { company_id: CB, received_id: "rcv-FAKE" } };
  provider.calls = [];
  const again = await webhook(body, "dlv-1");
  assert.deepEqual(again, { status: 200, body: { code: "DUPLICATE" } });
  assert.deepEqual(provider.calls, []);
  const replay = await webhook({ ...body, event: "peppol.document.received.v2" }, "dlv-1");
  assert.deepEqual(replay, { status: 409, body: { code: "REPLAYED_WEBHOOK" } });
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where provider_received_id = 'rcv-001'");
  assert.equal(rows[0].n, 1);
  const inv = await sql<{ n: number }>("select count(*)::int n from public.invoices where transport_message_id = 'rcv-001'");
  assert.equal(inv.rows[0].n, 1);
});

await check("neznámy provider_org_id → 200 UNKNOWN_ORG, zaznamenané ako rejected bez firmy, žiadny inbound ani fetch", async () => {
  provider.calls = [];
  const r = await webhook({ event: "peppol.document.received", organization_id: "org-unknown", company_id: CA }, "dlv-unknown");
  assert.deepEqual(r, { status: 200, body: { code: "UNKNOWN_ORG" } });
  const wh = (await sql<Row>("select processing_status, company_id, error from public.einvoice_webhook_events where delivery_id = 'dlv-unknown'")).rows[0];
  assert.deepEqual(wh, { processing_status: "rejected", company_id: null, error: "UNKNOWN_ORG" });
  assert.deepEqual(provider.calls, []);
  assert.match(await errorOf(() => inboundStore.register({ provider: "mock", environment: "sandbox", providerOrgId: "org-unknown", providerReceivedId: "x1", source: "poll", meta: {} })), /ESBLU_EINVOICE_UNKNOWN_ORG/);
});

await check("duplicitné provider ID: druhá registrácia → created=false, ten istý riadok", async () => {
  const a = await inboundStore.register({ provider: "mock", environment: "sandbox", providerOrgId: "org-a", providerReceivedId: "rcv-001", source: "poll", meta: {} });
  assert.equal(a.created, false);
  assert.equal(a.processingStatus, "acknowledged");
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where provider_received_id = 'rcv-001'");
  assert.equal(rows[0].n, 1);
});

// =============================================================================
// Chyby spracovania
// =============================================================================
await check("timeout pri sťahovaní → ostáva received, PROVIDER_FETCH_FAILED, retry neskôr, žiadny ACK; potom úspech", async () => {
  provider.add("org-a", "rcv-timeout", inboundXml("FA-TO-1"));
  await inboundStore.register({ provider: "mock", environment: "sandbox", providerOrgId: "org-a", providerReceivedId: "rcv-timeout", source: "poll", meta: {} });
  await sql("update public.einvoice_inbound set next_retry_at = now() + interval '1 day' where provider_received_id <> 'rcv-timeout' and processing_status not in ('acknowledged','failed')");
  provider.fetchError = new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true);
  provider.calls = [];
  await runInboundProcessBatch(deps());
  let row = await inboundByPid("rcv-timeout");
  assert.equal(row.processing_status, "received");
  assert.equal(row.last_error_code, "PROVIDER_FETCH_FAILED");
  assert.ok(new Date(row.next_retry_at as string).getTime() > Date.now());
  assert.ok(!provider.calls.some((c) => c.startsWith("ack:")));
  provider.fetchError = null;
  await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where provider_received_id = 'rcv-timeout'");
  await runInboundProcessBatch(deps());
  row = await inboundByPid("rcv-timeout");
  assert.equal(row.processing_status, "acknowledged");
});

async function processSingle(pid: string, xml: Uint8Array | string, org = "org-a") {
  provider.add(org, pid, typeof xml === "string" ? new TextEncoder().encode(xml) : xml);
  const reg = await inboundStore.register({ provider: "mock", environment: "sandbox", providerOrgId: org, providerReceivedId: pid, source: "poll", meta: {} });
  const [claimed] = await inboundStore.claim(1, 120).then((rows) => rows.filter((r) => r.id === reg.inboundId));
  const row = claimed ?? (await inboundByPid(pid)) as unknown as InboundRow;
  await processInboundRow(deps(), row);
  return inboundByPid(pid);
}
await sql("update public.einvoice_inbound set next_retry_at = now() + interval '1 day' where processing_status not in ('acknowledged','failed')");

await check("poškodené XML → failed INVALID_XML (UBL_MALFORMED), bez konceptu a bez ACK", async () => {
  provider.calls = [];
  const row = await processSingle("rcv-malformed", "<Invoice><broken>");
  assert.equal(row.processing_status, "failed");
  assert.equal(row.last_error_code, "INVALID_XML");
  assert.equal(row.invoice_id, null);
  assert.ok(!provider.calls.includes("ack:rcv-malformed"));
  const ev = (await sql<Row>("select provider_code from public.einvoice_events where inbound_id = $1 and to_state = 'failed'", [row.id])).rows[0];
  assert.equal(ev.provider_code, "UBL_MALFORMED");
});

await check("XXE / DOCTYPE / ENTITY → odmietnuté pred parsovaním (INVALID_XML, UBL_DTD_NOT_ALLOWED), nič sa nerozbalí", async () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">&xxe;</cbc:ID></Invoice>`;
  const row = await processSingle("rcv-xxe", xxe);
  assert.equal(row.processing_status, "failed");
  assert.equal(row.last_error_code, "INVALID_XML");
  const ev = (await sql<Row>("select provider_code from public.einvoice_events where inbound_id = $1 and to_state = 'failed'", [row.id])).rows[0];
  assert.equal(ev.provider_code, "UBL_DTD_NOT_ALLOWED");
  assert.ok(!provider.calls.includes("ack:rcv-xxe"));
});

await check("nepodporovaný profil → failed UNSUPPORTED_PROFILE, bez ACK", async () => {
  const xml = new TextDecoder().decode(inboundXml("FA-PROF-1")).replace(/urn:cen\.eu:en16931:2017[^<]*/, "urn:example:custom:profile");
  const row = await processSingle("rcv-profile", xml);
  assert.equal(row.processing_status, "failed");
  assert.equal(row.last_error_code, "UNSUPPORTED_PROFILE");
  assert.equal(row.invoice_id, null);
});

await check("duplicitný hash (iné provider ID, rovnaké XML) → duplicate, ten istý koncept, ten istý storage objekt, ACK; žiadna druhá faktúra", async () => {
  const objectsBefore = storage.size;
  const row = await processSingle("rcv-001-redelivered", XML_1);
  const first = await inboundByPid("rcv-001");
  assert.equal(row.processing_status, "acknowledged");
  assert.equal(row.invoice_id, first.invoice_id);
  assert.equal(row.dedupe_matched_on, "xml_sha256");
  assert.equal(row.xml_storage_path, first.xml_storage_path);
  assert.equal(storage.size, objectsBefore);
  const inv = await sql<{ n: number }>("select count(*)::int n from public.invoices where supplier_invoice_number = 'FA-IN-001'");
  assert.equal(inv.rows[0].n, 1);
});

await check("sekundárny guard: iné XML, ten istý dodávateľ + číslo dokladu → duplicate (supplier_invoice_number)", async () => {
  const variant = new TextDecoder().decode(XML_1).replace("<cbc:Name>Služba</cbc:Name>", "<cbc:Name>Služba (opravený popis)</cbc:Name>");
  const row = await processSingle("rcv-001-variant", variant);
  const first = await inboundByPid("rcv-001");
  assert.equal(row.processing_status, "acknowledged");
  assert.equal(row.invoice_id, first.invoice_id);
  assert.equal(row.dedupe_matched_on, "supplier_invoice_number");
});

await check("kategória K (dodanie do EÚ) sa prijme ako koncept (rozšírenie len pre efaktura_peppol)", async () => {
  const row = await processSingle("rcv-k", inboundXml("FA-K-1", { category: "K" }));
  assert.equal(row.processing_status, "acknowledged");
  const items = (await sql<Row>("select vat_category_code from public.invoice_items where invoice_id = $1", [row.invoice_id])).rows;
  assert.deepEqual(items, [{ vat_category_code: "K" }]);
});

await check("AI Inbox regresia: verejná RPC ostáva pre používateľa so zdrojom ai_inbox a bez K/G/O", async () => {
  const bp = (await sql<{ id: string }>("select id from public.business_partners where company_id = $1 and ico = '55555555'", [CA])).rows[0].id;
  const items = [{ description: "Materiál", quantity: 1, unit_price: 10, vat_category_code: "S", vat_rate: 23 }];
  const { rows } = await as(U.owner, () => db.query<{ r: Row }>("select public.esblu_create_received_invoice_draft($1, 'AI-001', '2026-10-01', $2::jsonb) r", [bp, JSON.stringify(items)]));
  assert.equal(rows[0].r.status, "created");
  const inv = (await sql<Row>("select source, created_by, transport_provider from public.invoices where id = $1", [rows[0].r.invoice_id])).rows[0];
  assert.deepEqual(inv, { source: "ai_inbox", created_by: U.owner, transport_provider: null });
  assert.match(
    await errorOf(() => as(U.owner, () => db.query("select public.esblu_create_received_invoice_draft($1, 'AI-002', '2026-10-01', $2::jsonb)", [bp, JSON.stringify([{ ...items[0], vat_category_code: "K" }])]))),
    /ESBLU_INVALID_ITEM/
  );
  assert.match(await errorOf(() => as(U.emp, () => db.query("select public.esblu_create_received_invoice_draft($1, 'AI-003', '2026-10-01', $2::jsonb)", [bp, JSON.stringify(items)]))), /ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED/);
});

await check("ACK až po koncepte: zlyhanie konceptu (bez nároku) → bez ACK, retry; po obnove nároku koncept + ACK", async () => {
  await sql("update public.company_entitlements set status = 'suspended' where company_id = $1 and entitlement_key = 'einvoice'", [CA]);
  // firma A je v triale → invoicing by prešiel; trial ukončíme iba v teste
  await locked(async () => {
    await db.exec("alter table public.companies disable trigger esblu_companies_trial_guard");
    await db.query("update public.companies set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '16 days' where id = $1", [CA]);
    await db.exec("alter table public.companies enable trigger esblu_companies_trial_guard");
  });
  provider.calls = [];
  const row = await processSingle("rcv-noent", inboundXml("FA-NOENT-1"));
  assert.equal(row.processing_status, "parsed");
  assert.equal(row.last_error_code, "DRAFT_CREATE_FAILED");
  assert.equal(row.invoice_id, null);
  assert.ok(!provider.calls.includes("ack:rcv-noent"), "žiadny ACK bez konceptu");
  await sql("update public.company_entitlements set status = 'active' where company_id = $1 and entitlement_key = 'einvoice'", [CA]);
  await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where provider_received_id = 'rcv-noent'");
  const [claimed] = (await inboundStore.claim(10, 120)).filter((r) => r.provider_received_id === "rcv-noent");
  await processInboundRow(deps(), claimed);
  const after = await inboundByPid("rcv-noent");
  assert.equal(after.processing_status, "acknowledged");
  assert.ok(after.invoice_id);
});

await check("ACK retry: zlyhanie ACK → ack_pending (ACK_FAILED), koncept ostáva; ďalší pokus → acknowledged; ACK idempotentný", async () => {
  provider.ackErrors = [new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", "u", true)];
  const row = await processSingle("rcv-ack", inboundXml("FA-ACK-1"));
  assert.equal(row.processing_status, "ack_pending");
  assert.equal(row.last_error_code, "ACK_FAILED");
  assert.ok(row.invoice_id);
  await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where provider_received_id = 'rcv-ack'");
  const [claimed] = (await inboundStore.claim(10, 120)).filter((r) => r.provider_received_id === "rcv-ack");
  await processInboundRow(deps(), claimed);
  const after = await inboundByPid("rcv-ack");
  assert.equal(after.processing_status, "acknowledged");
  assert.equal(after.invoice_id, row.invoice_id);
  const ctx = { environment: "sandbox" as const, providerOrgId: "org-a" };
  await provider.acknowledgeInbound(ctx, "rcv-ack"); // opakovaný ACK u poskytovateľa = OK
  assert.deepEqual((await eventsOf(after.id as string)).slice(-2), ["draft_created->ack_pending:job", "ack_pending->acknowledged:provider"]);
});

await check("storage zlyhá → STORAGE_FAILED retry, nič nepostúpi", async () => {
  storageFail = true;
  const row = await processSingle("rcv-storage", inboundXml("FA-ST-1"));
  storageFail = false;
  assert.equal(row.processing_status, "received");
  assert.equal(row.last_error_code, "STORAGE_FAILED");
  assert.equal(row.xml_sha256, null);
});

await check("poll fallback (bez webhooku): zoznam → registrácia → spracovanie → ACK", async () => {
  provider.add("org-a", "rcv-poll", inboundXml("FA-POLL-1"));
  await makeDue();
  const r = await runInboundPoll(deps(), { batchSize: 10 });
  assert.ok(r.sync.registered >= 1);
  const row = await inboundByPid("rcv-poll");
  assert.equal(row.processing_status, "acknowledged");
  assert.equal((await eventsOf(row.id as string))[0], "null->received:poll");
});

// =============================================================================
// Outbound webhook → iba reconciliation
// =============================================================================
await check("outbound webhook: stav z tela sa NEpoužije — iba reconciliation podľa ID podania (potvrdené dotazom)", async () => {
  const inv = (await as(U.owner, () => db.query<{ id: string }>(
    `insert into public.invoices (company_id, direction, kind, issue_date, currency, source) values ($1, 'issued', 'regular_invoice', '2026-10-01', 'EUR', 'manual') returning id`, [CA]))).rows[0].id;
  const partner = (await sql<{ id: string }>("select id from public.business_partners where company_id = $1 and ico = '55555555'", [CA])).rows[0].id;
  await as(U.owner, () => db.query("select id from public.esblu_save_invoice_draft($1, $2::jsonb, $3::jsonb, null)", [inv,
    JSON.stringify({ issue_date: "2026-10-01", due_date: "2026-10-15", currency: "EUR", customer_business_partner_id: partner, buyer_reference: "R" }),
    JSON.stringify([{ description: "X", quantity: 1, unit: "ks", unit_code: "H87", unit_price: 10, price_mode: "net", vat_category_code: "S", vat_rate: 23, line_net_amount: 10, line_vat_amount: 2.3, line_gross_amount: 12.3 }])]));
  await as(U.owner, () => db.query("select public.esblu_finalize_invoice($1)", [inv]));
  const sha64 = "c".repeat(64);
  const out = (await sql<{ id: string }>(
    `insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key, state, provider_submission_id, ubl_sha256, ubl_storage_path, ubl_size_bytes, sent_at)
     values ($1, $2, 'mock', 'sandbox', 1, 'esblu-out-test-key-0001', 'sent', 'prov-out-1', $3, $4, 10, now()) returning id`,
    [CA, inv, sha64, `${CA}/outbound/${inv}/${sha64}.xml`])).rows[0].id;
  provider.status.set("prov-out-1", "sent"); // poskytovateľ: ešte NEdoručené
  provider.calls = [];
  const r = await webhook({ event: "invoice.delivered", organization_id: "org-a", data: { invoice_id: "prov-out-1", state: "DELIVERED" } }, "dlv-out-1");
  assert.deepEqual(r, { status: 200, body: { code: "RECONCILED" } });
  assert.deepEqual(provider.calls, ["status:prov-out-1"]);
  let row = (await sql<Row>("select state, provider_status from public.einvoice_outbound where id = $1", [out])).rows[0];
  assert.equal(row.state, "sent", "webhook tvrdil DELIVERED, poskytovateľ hovorí SENT → ostáva sent");
  provider.status.set("prov-out-1", "deferred");
  await webhook({ event: "invoice.deferred", organization_id: "org-a", data: { invoice_id: "prov-out-1" } }, "dlv-out-2");
  row = (await sql<Row>("select state from public.einvoice_outbound where id = $1", [out])).rows[0];
  assert.equal(row.state, "deferred");
  // ID podania inej firmy → nič (claim je viazaný na firmu z mapovania organizácie)
  const foreign = await webhook({ event: "invoice.delivered", organization_id: "org-b", data: { invoice_id: "prov-out-1" } }, "dlv-out-3");
  assert.deepEqual(foreign, { status: 200, body: { code: "IGNORED" } });
  assert.ok(!provider.calls.some((c) => c.startsWith("sendUbl")));
});

// =============================================================================
// Phase 6: presný tvar webhookov podľa dokumentácie poskytovateľa + rollout brána
// =============================================================================
await check("docs tvar: peppol.document.received s data.orgId (camelCase) → spracované", async () => {
  provider.add("org-a", "rcv-docs-1", inboundXml("FA-DOCS-1"));
  const r = await webhook({
    event: "peppol.document.received",
    timestamp: "2026-10-02T10:00:00.000Z",
    data: { senderName: "Dodávateľ", senderParticipantId: "9915:2020000099", documentNumber: "FA-DOCS-1", documentType: "invoice", total: "12.30", currency: "EUR", mode: "test", orgId: "org-a" },
  }, "dlv-docs-1");
  assert.deepEqual(r, { status: 200, body: { code: "PROCESSED" } });
  assert.equal((await inboundByPid("rcv-docs-1")).processing_status, "acknowledged");
});

await check("docs tvar: peppol.document.delivered s data.invoiceId → reconciliation (stav z tela sa nepoužije)", async () => {
  provider.status.set("prov-out-1", "sent");
  provider.calls = [];
  const r = await webhook({
    event: "peppol.document.delivered",
    timestamp: "2026-10-02T10:00:00.000Z",
    data: { invoiceId: "prov-out-1", invoiceNumber: "X", documentType: "invoice", mode: "test", state: "DELIVERED", orgId: "org-a" },
  }, "dlv-docs-2");
  assert.deepEqual(r, { status: 200, body: { code: "RECONCILED" } });
  assert.deepEqual(provider.calls, ["status:prov-out-1"]);
});

await check("data.mode z inej siete (live udalosť na sandbox serveri) → IGNORED, nič sa nespracuje", async () => {
  provider.calls = [];
  const r = await webhook({ event: "peppol.document.received", data: { mode: "live", orgId: "org-a" } }, "dlv-docs-3");
  assert.deepEqual(r, { status: 200, body: { code: "IGNORED" } });
  assert.deepEqual(provider.calls, []);
  const wh = (await sql<Row>("select processing_status, error from public.einvoice_webhook_events where delivery_id = 'dlv-docs-3'")).rows[0];
  assert.equal(wh.processing_status, "ignored");
  assert.equal(wh.error, "ENVIRONMENT_MISMATCH");
});

await check("rollout: pozastavená firma (stage paused) → doklad sa zaregistruje, ale nespracuje ani nepotvrdí; po povolení áno", async () => {
  await sql("update public.einvoice_rollout set stage = 'paused' where company_id = $1", [CB]);
  provider.add("org-b", "rcv-gate-1", inboundXml("FA-GATE-1", { endpoint: "2030000000", customerIco: "22222222" }));
  await makeDue();
  await runInboundPoll(deps(), { batchSize: 10 });
  let row = await inboundByPid("rcv-gate-1");
  assert.equal(row.processing_status, "received");
  assert.equal(row.invoice_id, null);
  assert.ok(!provider.calls.includes("ack:rcv-gate-1"));
  await sql("update public.einvoice_rollout set stage = 'pilot' where company_id = $1", [CB]);
  await makeDue();
  await runInboundPoll(deps(), { batchSize: 10 });
  row = await inboundByPid("rcv-gate-1");
  assert.equal(row.processing_status, "acknowledged");
});

await check("rollout tabuľka: klient (aj owner) ju nevidí ani nemení; brána nie je volateľná klientom", async () => {
  assert.match(await errorOf(() => as(U.owner, () => db.query("select * from public.einvoice_rollout"))), /permission denied/);
  assert.match(await errorOf(() => as(U.owner, () => db.query("insert into public.einvoice_rollout (company_id, environment, stage, changed_by) values ($1, 'live', 'ga', 'x')", [CA]))), /permission denied/);
  assert.match(await errorOf(() => as(U.owner, () => db.query("select public.esblu_einvoice_rollout_allowed($1, 'sandbox')", [CA]))), /permission denied/);
  const mine = (await as(U.owner, () => db.query<{ r: boolean }>("select public.esblu_einvoice_my_rollout('sandbox') r"))).rows[0].r;
  assert.equal(mine, true);
  const emp = (await as(U.emp, () => db.query<{ r: boolean }>("select public.esblu_einvoice_my_rollout('sandbox') r"))).rows[0].r;
  assert.equal(emp, false, "employee nikdy");
  const live = (await as(U.owner, () => db.query<{ r: boolean }>("select public.esblu_einvoice_my_rollout('live') r"))).rows[0].r;
  assert.equal(live, false, "live nie je povolené (default deny)");
});

await check("live organizácia s participant schémou 9915 (Peppol TEST) je v DB odmietnutá", async () => {
  assert.match(
    await errorOf(() => sql("insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id) values ($1, 'mock', 'live', 'org-a-live', '9915:2020000000')", [CA])),
    /participant_env_scheme/
  );
});

// =============================================================================
// Izolácia firiem a čítanie podľa finance práv
// =============================================================================
await check("cross-tenant: rovnaké XML do firmy B → vlastný koncept v B (hash z A sa neprezradí ani nepoužije)", async () => {
  const xmlForB = inboundXml("FA-IN-001", { endpoint: "2030000000", customerIco: "22222222" });
  const rowB = await processSingle("rcv-b-001", xmlForB, "org-b");
  assert.equal(rowB.company_id, CB);
  assert.equal(rowB.processing_status, "acknowledged");
  assert.notEqual(rowB.dedupe_matched_on, "xml_sha256");
  const invB = (await sql<Row>("select company_id from public.invoices where id = $1", [rowB.invoice_id])).rows[0];
  assert.equal(invB.company_id, CB);
  // úplne rovnaké bajty ako v A → v B aj tak nový koncept (dedupe je iba v rámci firmy)
  const rowB2 = await processSingle("rcv-b-same-bytes", XML_1, "org-b");
  assert.ok(rowB2.invoice_id);
  assert.notEqual(rowB2.dedupe_matched_on, "xml_sha256");
  const invB2 = (await sql<Row>("select company_id from public.invoices where id = $1", [rowB2.invoice_id])).rows[0];
  assert.equal(invB2.company_id, CB);
  const seen = await as(U.b, () => db.query<{ n: number }>(`select count(*)::int n from public.einvoice_inbound where company_id = '${CA}'`));
  assert.equal(seen.rows[0].n, 0);
  const seenInv = await as(U.b, () => db.query<{ n: number }>(`select count(*)::int n from public.invoices where company_id = '${CA}'`));
  assert.equal(seenInv.rows[0].n, 0);
});

await check("čítanie: owner a accountant vidia inbound + koncepty; admin iba s finance.view áno; admin bez financií a employee nie", async () => {
  const count = async (uid: string, table: string) => (await as(uid, () => db.query<{ n: number }>(`select count(*)::int n from public.${table}`))).rows[0].n;
  for (const uid of [U.owner, U.acc, U.adminFin, U.adminView]) {
    assert.ok((await count(uid, "einvoice_inbound")) > 0, uid);
    assert.ok((await count(uid, "einvoice_events")) > 0, uid);
    assert.ok((await count(uid, "einvoice_webhook_events")) > 0, uid);
  }
  for (const uid of [U.admin, U.emp]) {
    assert.equal(await count(uid, "einvoice_inbound"), 0, uid);
    assert.equal(await count(uid, "einvoice_events"), 0, uid);
    const recv = await as(uid, () => db.query<{ n: number }>("select count(*)::int n from public.invoices where direction = 'received'"));
    assert.equal(recv.rows[0].n, 0, uid);
  }
  // klient nikdy nezapisuje
  for (const q of ["update public.einvoice_inbound set processing_status = 'acknowledged'", "delete from public.einvoice_inbound", "select public.esblu_einvoice_claim_inbound(10, 120)"]) {
    await errorOf(() => as(U.owner, () => db.query(q)));
  }
  const still = await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where processing_status = 'acknowledged'");
  assert.ok(still.rows[0].n > 0);
});

await check("route: webhook bez konfigurácie → 503; príliš veľké telo → 413; cron bez CRON_SECRET → 401", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key";
  const route = await import("../app/api/einvoice/webhook/route.ts");
  const res = await route.POST(new Request("http://localhost/api/einvoice/webhook", { method: "POST", body: "{}" }));
  assert.equal(res.status, 503);
  const big = await route.POST(new Request("http://localhost/api/einvoice/webhook", { method: "POST", body: "x".repeat(WEBHOOK_MAX_BODY_BYTES + 10) }));
  assert.equal(big.status, 413);
  const cron = await import("../app/api/cron/einvoice-inbound/route.ts");
  assert.equal((await cron.GET(new Request("http://localhost/api/cron/einvoice-inbound"))).status, 401);
});

await check("žiadne logovanie tela webhooku, XML ani tajomstiev; zdroj E-Faktúry nepoužíva console", async () => {
  const text = logged.join("\n");
  for (const forbidden of [SECRET, "<Invoice", "<?xml", "organization_id", "Dodávateľ X", "SK3112000000198742637541"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    }
    return out;
  };
  for (const f of [...walk("lib/einvoice"), ...walk("app/api/einvoice"), "app/api/cron/einvoice-inbound/route.ts", "app/api/cron/einvoice-outbound/route.ts"]) {
    assert.doesNotMatch(read(f), /console\.(log|info|warn|error|debug)/, f);
  }
  for (const f of ["lib/einvoice/inbound/processor.ts", "lib/einvoice/inbound/webhook.ts", "lib/einvoice/inbound/supabase-store.ts", "app/api/einvoice/webhook/route.ts", "app/api/cron/einvoice-inbound/route.ts"]) {
    assert.match(read(f), /^import "server-only";/, f);
  }
  // Bezpečný parser: DTD/ENTITY sa odmietnu pred DOMParserom; adaptér: pevný host, bez redirectu, limit veľkosti.
  assert.match(read("lib/einvoice/ubl/parse.ts"), /<!DOCTYPE/);
  assert.match(read("lib/einvoice/provider/efaktura-sk.ts"), /redirect: "error"/);
  assert.match(read("lib/einvoice/provider/efaktura-sk.ts"), /maxBytes: MAX_INBOUND_XML_BYTES/);
});

console.log(`\neinvoice-inbound: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
