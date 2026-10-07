// =============================================================================
// L3-ONLY: testy zacieleného spracovania jedného sandbox inbound dokladu
// (scripts/l3/inbound-one/core.ts) — guardy, zacielenie a dôkaz, že ostatné
// čakajúce doklady (2 staré L2 dobropisy) sa nespracujú ani neACKnú.
//
// SKUTOČNÝ PostgreSQL (PGlite) so všetkými E-Faktúra migráciami a tie isté
// serverové RPC ako produkcia (register, operator_begin, transition, koncept).
// Poskytovateľ je skriptovaný fake s menom "efaktura_sk" (žiadna sieť, žiadne kľúče).
//
// SPUSTENIE: npm run test:l3-inbound-one   (PGlite: npm i --no-save @electric-sql/pglite@0.5.8)
// =============================================================================
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dbErrorCode } from "../../lib/einvoice/outbound/store.ts";
import { EinvoiceProviderError, type EinvoiceProvider, type InboundSummary, type ProviderContext } from "../../lib/einvoice/provider/types.ts";
import { generateUbl } from "../../lib/einvoice/ubl/generate.ts";
import type { UblInvoiceSnapshot, UblParty } from "../../lib/einvoice/ubl/model.ts";
import { InboundStoreError, type InboundRow, type InboundStore } from "../../lib/einvoice/inbound/store.ts";
import { OpsStoreError, type OperatorBeginResult, type OpsStore } from "../../lib/einvoice/ops/store.ts";
import {
  assertL3InboundEnv,
  deadObject,
  guardInboundStore,
  guardOpsStore,
  guardProvider,
  L3_ACTOR_USER_ID,
  L3_COMPANY_A,
  L3_INBOUND_TARGETS,
  L3_PROTECTED_L2_DOCUMENTS,
  L3_SANDBOX_ORG,
  L3Stop,
  resolveL3Target,
  runL3InboundOne,
  type L3InboundReadRow,
} from "./inbound-one/core.ts";
import { parseCliArgs } from "./inbound-one/cli.ts";
import { PRODUCTION_REF, STAGING_REF } from "./staging-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const T4 = L3_INBOUND_TARGETS.FA20260004;
const T5 = L3_INBOUND_TARGETS.FA20260005;
const L3_INBOUND_TARGET = T4.providerReceivedId;
const T5_ID = T5.providerReceivedId;
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
type Row = Record<string, unknown>;
type Db = { exec: (sql: string) => Promise<unknown>; query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

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
    console.log(`ok - ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
async function stopCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "";
  } catch (error) {
    assert.ok(error instanceof L3Stop, `očakávaný L3Stop, dostal: ${error instanceof Error ? error.message : String(error)}`);
    return error.message;
  }
}

// ----------------------------------------------------------------- schéma
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
  "20261002130000_einvoice_inbound_flow.sql",
  "20261002140000_einvoice_operations.sql",
  "20261002150000_einvoice_rollout_gate.sql",
  "20261003100000_einvoice_inbound_draft_totals.sql",
  "20261008100000_invoicing_sk_compliance.sql",
  "20261008100001_invoicing_sk_trigger_fn_revoke.sql",
  "20261008100002_finance_helpers_bind_active_company.sql",
  "20261008100003_fx_rate_date_exact.sql",
  "20261008100004_fx_official_reference_rates.sql",
  "20261008100005_invoicing_corrections_payments_advances.sql",
  "20261008100006_einvoice_outbound_payment_received.sql",
  "20261008100007_einvoice_correction_backlink.sql",
  "20261008100008_received_advances.sql",
]) {
  await db.exec(read(`supabase/migrations/${migration}`));
}
await db.exec(read("scripts/sql/pglite/einvoice-prod-helpers.sql"));

let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
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

// ----------------------------------------------------------------- staging-like seed (syntetické)
const OTHER_USER = "20000000-0000-4000-8000-000000000001";
await locked(() => db.exec(`
  insert into auth.users (id) values ('${L3_ACTOR_USER_ID}'), ('${OTHER_USER}');
  insert into public.companies (id, name) values ('${L3_COMPANY_A}', 'L3 Tatra Servis s.r.o.');
  insert into public.company_members (company_id, user_id, role, permissions) values ('${L3_COMPANY_A}', '${L3_ACTOR_USER_ID}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code, iban,
      electronic_address, electronic_address_scheme_id)
    values ('${L3_COMPANY_A}', 'Tatra Servis s.r.o.', '87654326', '2099999999', 'SK2099999999', 'Hlavná 1', 'Bratislava', '81101', 'SK',
      'SK3112000000198742637541', '2099999999', '9915');
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, org_status, peppol_eligible)
    values ('${L3_COMPANY_A}', 'efaktura_sk', 'sandbox', '${L3_SANDBOX_ORG}', '9915:2099999999', 'active', true);
  insert into public.company_entitlements (company_id, entitlement_key, source, note) values ('${L3_COMPANY_A}', 'einvoice', 'manual', 'test');
  insert into public.einvoice_rollout (company_id, environment, stage, changed_by) values ('${L3_COMPANY_A}', 'sandbox', 'internal', 'test');
`));

// ----------------------------------------------------------------- stores nad PGlite (tie isté RPC ako supabase-store.ts)
const STORAGE = new Map<string, Uint8Array>();
const svc = async <T>(text: string, params: unknown[]): Promise<T[]> => {
  try {
    return (await asService(() => db.query<T>(text, params))).rows;
  } catch (error) {
    throw new InboundStoreError(dbErrorCode(error instanceof Error ? error.message : null));
  }
};
const inboundStore: InboundStore = {
  async webhookRecord() { throw new Error("nepoužíva sa"); },
  async webhookComplete() { throw new Error("nepoužíva sa"); },
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
    const { rows } = await sql<{ p: string }>("select xml_storage_path p from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2 and id <> $3 and xml_storage_path is not null limit 1", [companyId, sha, except]);
    return rows[0]?.p ?? null;
  },
  async organizationFor(companyId, environment) {
    const { rows } = await sql<Row>("select provider, provider_org_id, participant_id, peppol_eligible from public.einvoice_organizations where company_id = $1 and environment = $2", [companyId, environment]);
    const o = rows[0];
    return o ? { provider: o.provider as string, providerOrgId: o.provider_org_id as string, participantId: o.participant_id as string, peppolEligible: o.peppol_eligible === true } : null;
  },
  async listOrganizations(provider, environment) {
    const { rows } = await sql<Row>("select company_id, provider, provider_org_id, participant_id, peppol_eligible, environment from public.einvoice_organizations where provider = $1 and environment = $2 and peppol_eligible and provider_org_id is not null", [provider, environment]);
    return rows.map((o) => ({ companyId: o.company_id as string, environment: o.environment as "sandbox", provider: o.provider as string, providerOrgId: o.provider_org_id as string, participantId: o.participant_id as string, peppolEligible: true }));
  },
  async companyForOrg() { return null; },
  async claimOutboundBySubmission() { return null; },
  async putXml(p, bytes) {
    if (STORAGE.has(p)) return "exists";
    STORAGE.set(p, new Uint8Array(bytes));
    return "created";
  },
  async getXml(p) {
    const b = STORAGE.get(p);
    return b ? new Uint8Array(b) : null;
  },
};
const opsStore: OpsStore = {
  async operatorBegin(i) {
    try {
      const { rows } = await asService(() => db.query<{ j: OperatorBeginResult }>("select public.esblu_einvoice_operator_begin($1, $2, $3, $4, $5, $6, $7) j", [
        i.actorUserId, i.kind, i.id, i.action, i.reasonCode, i.leaseSeconds, i.cooldownSeconds,
      ]));
      return rows[0].j;
    } catch (error) {
      throw new OpsStoreError(dbErrorCode(error instanceof Error ? error.message : null));
    }
  },
  async health() { throw new Error("nepoužíva sa"); },
  async outcomes24h() { throw new Error("nepoužíva sa"); },
  async retention() { throw new Error("nepoužíva sa"); },
  async storageConsistency() { throw new Error("nepoužíva sa"); },
  async recordWebhookRejection() { throw new Error("nepoužíva sa"); },
};
const readInbound = async (pid: string): Promise<L3InboundReadRow | null> =>
  ((await sql<{ j: L3InboundReadRow }>("select to_jsonb(i) j from public.einvoice_inbound i where provider_received_id = $1", [pid])).rows[0]?.j) ?? null;

// ----------------------------------------------------------------- sandbox fake: 3 nepotvrdené doklady
const tatra = (over: Partial<UblParty> = {}): UblParty => ({
  role: "seller", legal_name: "Tatra Servis s.r.o.", ico: "87654326", dic: "2099999999", ic_dph: "SK2099999999",
  address_line1: "Hlavná 1", address_line2: null, city: "Bratislava", postal_code: "81101", country_code: "SK",
  iban: "SK3112000000198742637541", bic: null, email: null, electronic_address: "2099999999", electronic_address_scheme_id: "9915",
  legal_registration_id: null, legal_registration_scheme_id: null, vat_identifier: null, ...over,
});
function ubl(kind: "regular_invoice" | "credit_note", number: string): Uint8Array {
  const s: UblInvoiceSnapshot = {
    invoice: {
      id: "f0000000-0000-4000-8000-000000000004", company_id: "x", direction: "issued", kind, document_status: "finalized",
      invoice_number: number, issue_date: "2026-10-03", due_date: "2026-12-11", delivery_date: null, tax_point_date: null, currency: "EUR",
      subtotal_amount: 1000, vat_total_amount: 230, total_amount: 1230, rounding_amount: 0, buyer_reference: "L3-REF-002", purchase_order_reference: null,
      payment_means_code: "30", payment_reference: null, corrects_invoice_id: kind === "credit_note" ? "f0000000-0000-4000-8000-000000000009" : null, correction_reason: kind === "credit_note" ? "Vrátenie tovaru" : null,
    },
    seller: tatra(),
    buyer: tatra({ role: "buyer", iban: null }),
    items: [{ position: 1, description: "vykop", quantity: 1, unit_code: "H87", unit_price: 1000, price_mode: "net", vat_category_code: "S", vat_rate: 23, line_net_amount: 1000 }],
    taxBreakdowns: [{ vat_category_code: "S", vat_rate: 23, taxable_amount: 1000, vat_amount: 230, vat_exemption_reason_code: null, vat_exemption_reason_text: null }],
    correctedInvoice: kind === "credit_note" ? { invoice_number: "OLD-1", issue_date: "2026-09-01" } : null,
  };
  const r = generateUbl(s);
  if (!r.ok) throw new Error(r.issues.map((i) => i.code).join(","));
  return r.bytes;
}
const [L2_A, L2_B] = L3_PROTECTED_L2_DOCUMENTS;
class SandboxFake implements EinvoiceProvider {
  readonly name = "efaktura_sk";
  log: string[] = [];
  ackErrors: EinvoiceProviderError[] = [];
  docs = new Map<string, { meta: InboundSummary; xml: Uint8Array; acknowledged: boolean; fetched: number }>([
    [L3_INBOUND_TARGET, { meta: { providerReceivedId: L3_INBOUND_TARGET, senderParticipantId: "9915:2099999999", senderIco: "87654326", documentNumber: "FA20260004", documentType: "invoice", receivedAt: "2026-10-03T21:09:46.601Z", isTest: true }, xml: ubl("regular_invoice", "FA20260004"), acknowledged: false, fetched: 0 }],
    [L2_A, { meta: { providerReceivedId: L2_A, senderParticipantId: "9915:2099999999", senderIco: "87654326", documentNumber: "E2EDOMURFPOCW-20260001", documentType: "credit_note", receivedAt: "2026-10-01T10:00:00Z", isTest: true }, xml: ubl("credit_note", "E2EDOMURFPOCW-20260001"), acknowledged: false, fetched: 0 }],
    [L2_B, { meta: { providerReceivedId: L2_B, senderParticipantId: "9915:2099999999", senderIco: "87654326", documentNumber: "DO20260001", documentType: "credit_note", receivedAt: "2026-10-01T11:00:00Z", isTest: true }, xml: ubl("credit_note", "DO20260001"), acknowledged: false, fetched: 0 }],
  ]);
  private ctx(c: ProviderContext) {
    if (c.environment !== "sandbox" || c.providerOrgId !== L3_SANDBOX_ORG) throw new EinvoiceProviderError("EINVOICE_ORGANIZATION_NOT_FOUND");
  }
  private no(name: string) { this.log.push(`UNEXPECTED:${name}`); return Promise.reject(new Error(`unexpected ${name}`)); }
  provisionOrganization() { return this.no("provisionOrganization"); }
  getOrganization() { return this.no("getOrganization"); }
  verifyRecipient() { return this.no("verifyRecipient"); }
  preflight() { return this.no("preflight"); }
  sendUbl() { return this.no("sendUbl"); }
  getOutboundStatus() { return this.no("getOutboundStatus"); }
  getDeliveryEvidence() { return this.no("getDeliveryEvidence"); }
  findSubmissionByIdempotencyKey() { return this.no("findSubmissionByIdempotencyKey"); }
  async listUnacknowledgedInbound(c: ProviderContext) {
    this.ctx(c);
    this.log.push("list");
    return [...this.docs.values()].filter((d) => !d.acknowledged).map((d) => d.meta);
  }
  async getInboundDocument(c: ProviderContext, id: string) {
    this.ctx(c);
    this.log.push(`fetch:${id}`);
    const d = this.docs.get(id);
    if (!d) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    d.fetched++;
    return { providerReceivedId: id, xml: new Uint8Array(d.xml), pdf: null };
  }
  async acknowledgeInbound(c: ProviderContext, id: string) {
    this.ctx(c);
    this.log.push(`ack:${id}`);
    const err = this.ackErrors.shift();
    if (err) throw err;
    const d = this.docs.get(id);
    if (!d) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    d.acknowledged = true;
  }
}
const provider = new SandboxFake();
const deps = () => ({ provider, inbound: inboundStore, ops: opsStore, readInbound });
const assertL2Untouched = async () => {
  for (const id of L3_PROTECTED_L2_DOCUMENTS) {
    const d = provider.docs.get(id)!;
    assert.equal(d.acknowledged, false, `${id} ACK`);
    assert.equal(d.fetched, 0, `${id} fetch`);
    assert.ok(!provider.log.some((l) => l.endsWith(`:${id}`)), `${id} v logu poskytovateľa`);
    const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where provider_received_id = $1", [id]);
    assert.equal(rows[0].n, 0, `${id} staging riadok`);
  }
  assert.ok(!provider.log.some((l) => l.startsWith("UNEXPECTED")), provider.log.join(","));
};

// =============================================================================
// Guardy env / argumentov
// =============================================================================
const GOOD_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
  ESBLU_EINVOICE_ENVIRONMENT: "sandbox",
  ESBLU_EINVOICE_PROVIDER: "efaktura_sk",
  ESBLU_EFAKTURA_API_KEY: "efk_pk_test_" + "0".repeat(24),
};

await check("env guard: staging + sandbox + efaktura_sk + test kľúč → OK", () => {
  assert.doesNotThrow(() => assertL3InboundEnv(GOOD_ENV));
});

await check("env guard: produkčný ref kdekoľvek, iná URL, live, iný provider, live kľúč, LIVE_ENABLED, VERCEL_ENV=production, iný base URL → STOP", async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ ...GOOD_ENV, NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }, /L3_STOP_PRODUCTION_REF/],
    [{ ...GOOD_ENV, CRON_SECRET: `x-${PRODUCTION_REF}-y` }, /L3_STOP_PRODUCTION_REF:CRON_SECRET/],
    [{ ...GOOD_ENV, NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }, /L3_STOP_SUPABASE_URL_NOT_STAGING/],
    [{ ...GOOD_ENV, ESBLU_EINVOICE_ENVIRONMENT: "live" }, /L3_STOP_ENVIRONMENT_NOT_SANDBOX/],
    [{ ...GOOD_ENV, ESBLU_EINVOICE_PROVIDER: "mock" }, /L3_STOP_PROVIDER_NOT_EFAKTURA_SK/],
    [{ ...GOOD_ENV, ESBLU_EFAKTURA_API_KEY: "efk_pk_live_" + "0".repeat(24) }, /L3_STOP_API_KEY_NOT_SANDBOX/],
    [{ ...GOOD_ENV, ESBLU_EINVOICE_LIVE_ENABLED: "true" }, /L3_STOP_LIVE_ENABLED/],
    [{ ...GOOD_ENV, VERCEL_ENV: "production" }, /L3_STOP_VERCEL_PRODUCTION/],
    [{ ...GOOD_ENV, ESBLU_EFAKTURA_BASE_URL: "https://evil.example.com" }, /L3_STOP_BASE_URL/],
  ];
  for (const [env, re] of cases) assert.match(await stopCode(() => assertL3InboundEnv(env)), re);
});

await check("CLI argumenty: --run vyžaduje presne cieľový --confirm-document; --check+--run, neznámy argument a chýbajúci režim → STOP", async () => {
  assert.deepEqual(parseCliArgs(["--check", "--target=FA20260005"]), { mode: "check", target: T5, confirm: null, envFile: null });
  assert.equal(parseCliArgs(["--run", "--target=FA20260005", `--confirm-document=${T5_ID}`]).mode, "run");
  assert.equal(parseCliArgs(["--run", "--target=FA20260004", `--confirm-document=${L3_INBOUND_TARGET}`]).target, T4);
  assert.match(await stopCode(() => parseCliArgs(["--check"])), /TARGET_REQUIRED/);
  assert.match(await stopCode(() => parseCliArgs(["--run", "--target=FA20260005"])), /CONFIRM_DOCUMENT_MISMATCH/);
  // potvrdenie iného cieľa (starý FA20260004) ani L2 dokladu nestačí
  assert.match(await stopCode(() => parseCliArgs(["--run", "--target=FA20260005", `--confirm-document=${L3_INBOUND_TARGET}`])), /CONFIRM_DOCUMENT_MISMATCH/);
  for (const id of L3_PROTECTED_L2_DOCUMENTS) assert.match(await stopCode(() => parseCliArgs(["--run", "--target=FA20260005", `--confirm-document=${id}`])), /CONFIRM_DOCUMENT_MISMATCH/);
  for (const bad of ["--target=E2EDOMURFPOCW-20260001", "--target=DO20260001", "--target=FA20260006", "--target=__proto__", "--target=constructor", `--target=${T5_ID}`]) {
    assert.match(await stopCode(() => parseCliArgs(["--check", bad])), /TARGET_UNKNOWN/, bad);
  }
  assert.match(await stopCode(() => parseCliArgs(["--check", "--target=FA20260005", "--target=FA20260004"])), /MULTIPLE_TARGETS/);
  assert.match(await stopCode(() => parseCliArgs(["--check", "--run", "--target=FA20260005"])), /CHECK_AND_RUN/);
  assert.match(await stopCode(() => parseCliArgs(["--check", "--target=FA20260005", "--all"])), /UNKNOWN_ARGUMENT/);
  assert.match(await stopCode(() => parseCliArgs([])), /MODE_REQUIRED/);
});

// =============================================================================
// Guardy poskytovateľa / store / ops
// =============================================================================
const ctxOk: ProviderContext = { environment: "sandbox", providerOrgId: L3_SANDBOX_ORG };

await check("guardProvider: send/preflight/status/evidence/provisioning zakázané; fetch/ACK iných ID zakázané; ACK bez povolenia zakázaný; iná org zakázaná", async () => {
  const inner = new SandboxFake();
  const gp = guardProvider(inner, { allowAck: false, target: T4 });
  for (const fn of [
    () => gp.sendUbl(ctxOk, {} as never), () => gp.preflight(ctxOk, { ubl: new Uint8Array() }), () => gp.verifyRecipient(ctxOk, "x"),
    () => gp.getOutboundStatus(ctxOk, { providerSubmissionId: "x" }), () => gp.getDeliveryEvidence(ctxOk, { providerSubmissionId: "x" }),
    () => gp.findSubmissionByIdempotencyKey(ctxOk, "x"), () => gp.getOrganization(ctxOk), () => gp.provisionOrganization({} as never),
  ]) assert.match(await stopCode(fn), /L3_PROVIDER_CALL_FORBIDDEN/);
  for (const id of [...L3_PROTECTED_L2_DOCUMENTS, "other"]) {
    assert.match(await stopCode(() => gp.getInboundDocument(ctxOk, id)), /L3_PROVIDER_TARGET_FORBIDDEN/);
    assert.match(await stopCode(() => gp.acknowledgeInbound(ctxOk, id)), /L3_PROVIDER_TARGET_FORBIDDEN/);
  }
  assert.match(await stopCode(() => gp.acknowledgeInbound(ctxOk, L3_INBOUND_TARGET)), /L3_ACK_NOT_AUTHORIZED/);
  assert.match(await stopCode(() => gp.listUnacknowledgedInbound({ environment: "sandbox", providerOrgId: "other-org" })), /CONTEXT_FORBIDDEN/);
  assert.match(await stopCode(() => gp.listUnacknowledgedInbound({ environment: "live", providerOrgId: L3_SANDBOX_ORG })), /CONTEXT_FORBIDDEN/);
  assert.deepEqual(inner.log, [], "vnútorný poskytovateľ sa nesmel zavolať");
  assert.equal([...inner.docs.values()].some((d) => d.acknowledged || d.fetched), false);
  assert.match(await stopCode(() => guardProvider({ ...inner, name: "mock" } as EinvoiceProvider, { allowAck: true, target: T4 })), /PROVIDER_NAME/);
});

await check("guardInboundStore / guardOpsStore / deadObject: claim, webhook, register iných ID, cudzí riadok, iná akcia/aktér → STOP", async () => {
  const gs = guardInboundStore(inboundStore, T4);
  assert.match(await stopCode(() => gs.claim(5, 120)), /CALL_FORBIDDEN:claim/);
  assert.match(await stopCode(() => gs.webhookRecord({} as never)), /CALL_FORBIDDEN/);
  for (const id of L3_PROTECTED_L2_DOCUMENTS) {
    assert.match(await stopCode(() => gs.register({ provider: "efaktura_sk", environment: "sandbox", providerOrgId: L3_SANDBOX_ORG, providerReceivedId: id, source: "poll", meta: {} })), /REGISTER_TARGET_FORBIDDEN/);
  }
  assert.match(await stopCode(() => gs.register({ provider: "efaktura_sk", environment: "live", providerOrgId: L3_SANDBOX_ORG, providerReceivedId: L3_INBOUND_TARGET, source: "poll", meta: {} })), /REGISTER_CONTEXT_FORBIDDEN/);
  assert.match(await stopCode(() => gs.transition("x", "received", "stored", "job", null, {})), /ROW_FORBIDDEN/);
  gs.bindRow("row-1");
  assert.match(await stopCode(() => gs.transition("row-2", "received", "stored", "job", null, {})), /ROW_FORBIDDEN/);
  assert.match(await stopCode(() => gs.bindRow("row-2")), /REBIND/);
  const go = guardOpsStore(opsStore, () => "row-1");
  const base = { actorUserId: L3_ACTOR_USER_ID, kind: "inbound" as const, id: "row-1", action: "inbound_reprocess" as const, reasonCode: null, leaseSeconds: 120, cooldownSeconds: 60 };
  for (const bad of [{ kind: "outbound" as const }, { action: "outbound_retry" as const }, { id: "row-2" }, { actorUserId: OTHER_USER }]) {
    assert.match(await stopCode(() => go.operatorBegin({ ...base, ...bad })), /OPERATOR_BEGIN_FORBIDDEN/);
  }
  assert.match(await stopCode(() => go.retention(90, 100)), /OPS_CALL_FORBIDDEN/);
  const dead = deadObject<{ claim(): void }>("OUTBOUND_STORE");
  assert.match(await stopCode(() => dead.claim()), /OUTBOUND_STORE_FORBIDDEN:claim/);
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound");
  assert.equal(rows[0].n, 0, "guard testy nič nezapísali");
});

// =============================================================================
// Zacielenie end-to-end (PGlite + produkčná logika)
// =============================================================================
await check("run s nesprávnym potvrdením → STOP pred akýmkoľvek volaním", async () => {
  assert.match(await stopCode(() => runL3InboundOne(deps(), { mode: "run", target: T4, confirmDocument: L2_A })), /CONFIRM_DOCUMENT_MISMATCH/);
  assert.deepEqual(provider.log, []);
});

await check("--check: iba zoznam u poskytovateľa, žiadny zápis, žiadne stiahnutie, žiadny ACK; L2 vidí, ale nedotkne sa", async () => {
  const r = await runL3InboundOne(deps(), { mode: "check", target: T4 });
  assert.equal(r.verdict, "READY_REGISTER_AND_PROCESS");
  assert.equal(r.action, "inbound_reprocess");
  assert.equal(r.listed, 3);
  assert.equal(r.targetListed, true);
  assert.equal(r.targetMeta?.documentNumber, "FA20260004");
  assert.deepEqual([...r.otherPending].sort(), [...L3_PROTECTED_L2_DOCUMENTS].sort());
  assert.equal(r.protectedSeen.length, 2);
  assert.deepEqual(provider.log, ["list"]);
  assert.deepEqual(r.providerCalls.map((c) => c.method), ["listUnacknowledgedInbound"]);
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound");
  assert.equal(rows[0].n, 0);
  await assertL2Untouched();
});

let firstRowId = "";
await check("--run, ACK zlyhá u poskytovateľa → koncept existuje, riadok ack_pending, nič iné; L2 nedotknuté", async () => {
  provider.log = [];
  provider.ackErrors = [new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", "t", true)];
  const r = await runL3InboundOne(deps(), { mode: "run", target: T4, confirmDocument: L3_INBOUND_TARGET });
  assert.equal(r.registered?.created, true);
  firstRowId = r.registered!.inboundId;
  assert.equal(r.stagingAfter?.processing_status, "ack_pending", JSON.stringify(r.operator));
  assert.ok(r.stagingAfter?.invoice_id, "koncept prijatej faktúry");
  assert.equal(r.verdict, "STOPPED_AT:ack_pending");
  assert.deepEqual(provider.log, ["list", `fetch:${L3_INBOUND_TARGET}`, `ack:${L3_INBOUND_TARGET}`]);
  assert.equal(provider.docs.get(L3_INBOUND_TARGET)!.acknowledged, false);
  await assertL2Untouched();
});

await check("--run znova (po cooldowne) → iba inbound_ack_retry, bez opätovného stiahnutia a bez druhého konceptu → acknowledged", async () => {
  await sql("update public.einvoice_inbound set operator_action_at = null, locked_until = null where id = $1", [firstRowId]); // test: cooldown uplynul
  provider.log = [];
  const before = await readInbound(L3_INBOUND_TARGET);
  const r = await runL3InboundOne(deps(), { mode: "run", target: T4, confirmDocument: L3_INBOUND_TARGET });
  assert.equal(r.action, "inbound_ack_retry");
  assert.equal(r.registered, null);
  assert.equal(r.verdict, "ACKNOWLEDGED", JSON.stringify(r.operator));
  assert.deepEqual(provider.log, ["list", `ack:${L3_INBOUND_TARGET}`]);
  const after = r.stagingAfter!;
  assert.equal(after.invoice_id, before!.invoice_id);
  assert.equal(after.xml_sha256, before!.xml_sha256);
  assert.equal(provider.docs.get(L3_INBOUND_TARGET)!.acknowledged, true);
  assert.equal(provider.docs.get(L3_INBOUND_TARGET)!.fetched, 1, "XML stiahnuté presne raz");
  await assertL2Untouched();
});

await check("výsledok: presne 1 staging inbound riadok (cieľ), nemenné XML = bajty od poskytovateľa (SHA-256 + veľkosť), 1 prijatý koncept vo firme A", async () => {
  const { rows } = await sql<Row>("select * from public.einvoice_inbound");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.provider_received_id, L3_INBOUND_TARGET);
  assert.equal(row.company_id, L3_COMPANY_A);
  assert.equal(row.processing_status, "acknowledged");
  const xml = provider.docs.get(L3_INBOUND_TARGET)!.xml;
  assert.equal(row.xml_sha256, createHash("sha256").update(xml).digest("hex"));
  assert.equal(row.xml_size_bytes, xml.byteLength);
  const stored = STORAGE.get(row.xml_storage_path as string)!;
  assert.deepEqual(Buffer.from(stored), Buffer.from(xml));
  assert.equal(STORAGE.size, 1);
  const inv = await sql<Row>("select company_id, direction, document_status, supplier_invoice_number from public.invoices where id = $1", [row.invoice_id]);
  assert.equal(inv.rows[0].company_id, L3_COMPANY_A);
  assert.equal(inv.rows[0].direction, "received");
  assert.equal(inv.rows[0].supplier_invoice_number, "FA20260004");
  const ev = (await sql<Row>("select from_state, to_state, source, provider_code from public.einvoice_events where inbound_id = $1 order by created_at, id", [row.id])).rows;
  assert.ok(ev.some((e) => e.provider_code === "OPERATOR_INBOUND_REPROCESS"));
  assert.ok(ev.some((e) => e.provider_code === "OPERATOR_INBOUND_ACK_RETRY"));
  assert.equal(ev.filter((e) => e.to_state === "acknowledged").length, 1);
  assert.equal((await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound")).rows[0].n, 0, "outbound sa nedotkol");
});

await check("po ACK: --check aj --run sú no-op (ALREADY_ACKNOWLEDGED), žiadne ďalšie stiahnutie ani ACK", async () => {
  provider.log = [];
  assert.equal((await runL3InboundOne(deps(), { mode: "check", target: T4 })).verdict, "ALREADY_ACKNOWLEDGED");
  assert.equal((await runL3InboundOne(deps(), { mode: "run", target: T4, confirmDocument: L3_INBOUND_TARGET })).verdict, "ALREADY_ACKNOWLEDGED");
  assert.deepEqual(provider.log, ["list", "list"]);
  await assertL2Untouched();
});

// =============================================================================
// Nový cieľ FA20260005 (self-send po FA20260004) — ten istý mechanizmus, iný jediný cieľ
// =============================================================================
await check("uzavretý zoznam cieľov: iba FA20260004 / FA20260005; neznámy, prototypový alebo podvrhnutý cieľ → STOP", async () => {
  assert.equal(resolveL3Target("FA20260005").providerReceivedId, "3c753470-3268-4898-b6bf-3b88dda18229");
  assert.equal(resolveL3Target("FA20260004").providerReceivedId, "ebcda9cf-d854-48a3-8d30-dde8970f8c78");
  for (const bad of ["", "FA20260006", "__proto__", "constructor", "toString", T5_ID, L2_A]) assert.match(await stopCode(() => resolveL3Target(bad)), /TARGET_UNKNOWN/, bad);
  assert.ok(Object.isFrozen(L3_INBOUND_TARGETS) && Object.isFrozen(T5));
  for (const t of Object.values(L3_INBOUND_TARGETS)) assert.ok(!L3_PROTECTED_L2_DOCUMENTS.includes(t.providerReceivedId));
  // podvrhnutý objekt cieľa (správne číslo, cudzie ID) sa nepripustí
  provider.log = [];
  for (const forged of [{ documentNumber: "FA20260005", providerReceivedId: L2_A }, { documentNumber: "FA20260005", providerReceivedId: L3_INBOUND_TARGET }]) {
    assert.match(await stopCode(() => runL3InboundOne(deps(), { mode: "check", target: forged })), /TARGET_UNKNOWN/);
  }
  assert.match(await stopCode(() => guardProvider(new SandboxFake(), { allowAck: true, target: { documentNumber: "X", providerReceivedId: L2_B } })), /TARGET_PROTECTED/);
  assert.match(await stopCode(() => guardInboundStore(inboundStore, { documentNumber: "X", providerReceivedId: L2_A })), /TARGET_PROTECTED/);
  assert.deepEqual(provider.log, []);
});

await check("guardy pre cieľ FA20260005: fetch/ACK/registrácia starého FA20260004 aj oboch L2 zakázané, ešte pred poskytovateľom", async () => {
  const inner = new SandboxFake();
  const gp = guardProvider(inner, { allowAck: true, target: T5 });
  for (const id of [L3_INBOUND_TARGET, ...L3_PROTECTED_L2_DOCUMENTS]) {
    assert.match(await stopCode(() => gp.getInboundDocument(ctxOk, id)), /L3_PROVIDER_TARGET_FORBIDDEN/);
    assert.match(await stopCode(() => gp.acknowledgeInbound(ctxOk, id)), /L3_PROVIDER_TARGET_FORBIDDEN/);
  }
  assert.deepEqual(inner.log, []);
  const gs = guardInboundStore(inboundStore, T5);
  for (const id of [L3_INBOUND_TARGET, ...L3_PROTECTED_L2_DOCUMENTS]) {
    assert.match(await stopCode(() => gs.register({ provider: "efaktura_sk", environment: "sandbox", providerOrgId: L3_SANDBOX_ORG, providerReceivedId: id, source: "poll", meta: {} })), /REGISTER_TARGET_FORBIDDEN/);
  }
});

const T5_DOC = { meta: { providerReceivedId: T5_ID, senderParticipantId: "9915:2099999999", senderIco: "87654326", documentNumber: "FA20260005", documentType: "invoice", receivedAt: "2026-10-03T22:22:52.389Z", isTest: true }, xml: ubl("regular_invoice", "FA20260005"), acknowledged: false, fetched: 0 };

await check("FA20260005 --check: iba zoznam; čakajú FA20260005 + 2 L2 (FA20260004 už ACK), nič sa nezapíše ani nestiahne", async () => {
  provider.docs.set(T5_ID, T5_DOC);
  provider.log = [];
  const rowsBefore = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound")).rows[0].n;
  const r = await runL3InboundOne(deps(), { mode: "check", target: T5 });
  assert.equal(r.verdict, "READY_REGISTER_AND_PROCESS");
  assert.equal(r.target, T5_ID);
  assert.equal(r.targetDocumentNumber, "FA20260005");
  assert.equal(r.listed, 3);
  assert.equal(r.targetMeta?.documentNumber, "FA20260005");
  assert.deepEqual([...r.otherPending].sort(), [...L3_PROTECTED_L2_DOCUMENTS].sort());
  assert.equal(r.protectedSeen.length, 2);
  assert.deepEqual(provider.log, ["list"]);
  assert.equal((await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound")).rows[0].n, rowsBefore);
  assert.equal(provider.docs.get(T5_ID)!.fetched, 0);
  await assertL2Untouched();
});

await check("FA20260005 --run: potvrdenie starého ID → STOP; správne potvrdenie → iba fetch+ACK FA20260005, koncept so súčtami z XML; FA20260004 ani L2 sa nedotkne", async () => {
  provider.log = [];
  assert.match(await stopCode(() => runL3InboundOne(deps(), { mode: "run", target: T5, confirmDocument: L3_INBOUND_TARGET })), /CONFIRM_DOCUMENT_MISMATCH/);
  assert.deepEqual(provider.log, []);
  const fa4Fetched = provider.docs.get(L3_INBOUND_TARGET)!.fetched;
  const r = await runL3InboundOne(deps(), { mode: "run", target: T5, confirmDocument: T5_ID });
  assert.equal(r.verdict, "ACKNOWLEDGED", JSON.stringify(r.operator));
  assert.equal(r.action, "inbound_reprocess");
  assert.deepEqual(provider.log, ["list", `fetch:${T5_ID}`, `ack:${T5_ID}`]);
  assert.deepEqual(r.providerCalls.map((c) => `${c.method}:${c.id ?? ""}`), ["listUnacknowledgedInbound:", `getInboundDocument:${T5_ID}`, `acknowledgeInbound:${T5_ID}`]);
  assert.equal(provider.docs.get(T5_ID)!.acknowledged, true);
  assert.equal(provider.docs.get(T5_ID)!.fetched, 1);
  assert.equal(provider.docs.get(L3_INBOUND_TARGET)!.fetched, fa4Fetched, "FA20260004 sa znova nestiahol");
  const rows = (await sql<Row>("select provider_received_id, processing_status, invoice_id, xml_sha256, xml_size_bytes from public.einvoice_inbound order by received_at")).rows;
  assert.deepEqual(rows.map((x) => x.provider_received_id), [L3_INBOUND_TARGET, T5_ID]);
  const row5 = rows[1];
  assert.equal(row5.processing_status, "acknowledged");
  assert.equal(row5.xml_sha256, createHash("sha256").update(T5_DOC.xml).digest("hex"));
  assert.equal(row5.xml_size_bytes, T5_DOC.xml.byteLength);
  const inv = (await sql<Row>("select company_id, direction, document_status, supplier_invoice_number, subtotal_amount::text s, vat_total_amount::text v, total_amount::text t, payment_means_code pm from public.invoices where id = $1", [row5.invoice_id])).rows[0];
  assert.deepEqual(inv, { company_id: L3_COMPANY_A, direction: "received", document_status: "draft", supplier_invoice_number: "FA20260005", s: "1000.00", v: "230.00", t: "1230.00", pm: "30" });
  await assertL2Untouched();
  // opakovanie → no-op
  provider.log = [];
  assert.equal((await runL3InboundOne(deps(), { mode: "run", target: T5, confirmDocument: T5_ID })).verdict, "ALREADY_ACKNOWLEDGED");
  assert.deepEqual(provider.log, ["list"]);
  await assertL2Untouched();
});

await check("izolácia: nič v app/ ani lib/ neimportuje scripts/l3 (produkčné správanie inbound workeru je nezmenené)", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(p);
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /scripts\/l3|inbound-one/, f);
  const cron = read("app/api/cron/einvoice-inbound/route.ts");
  assert.match(cron, /runInboundPoll/);
});

console.log(`\nl3-inbound-one: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
