// =============================================================================
// E-Faktúra — Phase 4: recovery, operátorské akcie, retencia, health/alerty,
// správanie po zrušení nároku einvoice.
//
// SKUTOČNÝ PostgreSQL (PGlite) so všetkými migráciami E-Faktúry vrátane
// 20261002140000_einvoice_operations. Poskytovateľ je SKRIPTOVANÝ fake (žiadna
// sieť, žiadne kľúče, nič live). Operátorské akcie bežia cez rovnakú
// orchestráciu (lib/einvoice/ops/actions.ts) a tie isté serverové RPC ako produkcia.
//
// SPUSTENIE: npm run test:einvoice-ops   (PGlite: npm i --no-save @electric-sql/pglite@0.5.8)
// =============================================================================

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestOutboundForInvoice } from "../lib/einvoice/outbound/request.ts";
import { runOutboundReconcileBatch, runOutboundSendBatch } from "../lib/einvoice/outbound/worker.ts";
import { MAX_SEND_ATTEMPTS } from "../lib/einvoice/outbound/policy.ts";
import { dbErrorCode, OutboundStoreError, type OutboundRow, type OutboundStore } from "../lib/einvoice/outbound/store.ts";
import { sanitizeDeliveryEvidence } from "../lib/einvoice/evidence.ts";
import {
  EinvoiceProviderError,
  type DeliveryEvidence,
  type EinvoiceProvider,
  type OutboundState,
  type PreflightResult,
  type ProviderContext,
  type SendResult,
  type SendUblInput,
} from "../lib/einvoice/provider/types.ts";
import { generateUbl } from "../lib/einvoice/ubl/generate.ts";
import type { UblInvoiceSnapshot, UblParty } from "../lib/einvoice/ubl/model.ts";
import { InboundStoreError, type InboundRow, type InboundStore } from "../lib/einvoice/inbound/store.ts";
import { processInboundRow } from "../lib/einvoice/inbound/processor.ts";
import { runOperatorAction } from "../lib/einvoice/ops/actions.ts";
import { parseOperatorBody } from "../lib/einvoice/ops/request-body.ts";
import { inboundCategory, outboundCategory } from "../lib/einvoice/ops/categories.ts";
import { evaluateAlerts, sanitizeHealth } from "../lib/einvoice/ops/alerts.ts";
import { runEinvoiceMaintenance } from "../lib/einvoice/ops/maintenance.ts";
import { downloadStoredDocument } from "../lib/einvoice/ops/download.ts";
import { OpsStoreError, type OperatorAction, type OperatorBeginResult, type OperatorReasonCode, type OpsStore } from "../lib/einvoice/ops/store.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

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

// -----------------------------------------------------------------------------
// Schéma
// -----------------------------------------------------------------------------
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
  // --- predmet testu ---
  "20261002120000_einvoice_outbound_flow.sql",
  // regresia: Phase 3 nesmie zmeniť outbound správanie
  "20261002130000_einvoice_inbound_flow.sql",
  // --- predmet testu ---
  "20261002140000_einvoice_operations.sql",
  "20261002150000_einvoice_rollout_gate.sql",
  "20261003100000_einvoice_inbound_draft_totals.sql",
  "20261008100000_invoicing_sk_compliance.sql",
  "20261008100001_invoicing_sk_trigger_fn_revoke.sql",
  "20261008100002_finance_helpers_bind_active_company.sql",
  "20261008100003_fx_rate_date_exact.sql",
  "20261008100004_fx_official_reference_rates.sql",
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
// Pripojenia: jedno spojenie → všetky transakcie serializované zámkom
// -----------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  return locked(async () => {
    await db.exec("begin");
    try {
      if (uid) {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
        await db.exec("set local role authenticated");
      } else {
        await db.exec("set local role anon");
      }
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

/** Minimálny supabase-js klient nad PGlite pod JWT používateľa (RLS) — iba to, čo kód používa. */
function userDb(uid: string | null) {
  type Filter = { column: string; value: unknown };
  function builder(table: string) {
    let columns = "*";
    const filters: Filter[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    const run = async (single: boolean) => {
      const where = filters.map((f, i) => `${f.column} = $${i + 1}`).join(" and ");
      const inner = `select ${columns} from public.${table}${where ? ` where ${where}` : ""}${orderBy ? ` order by ${orderBy.column} ${orderBy.ascending ? "asc" : "desc"}` : ""}`;
      try {
        const res = await as(uid, () => db.query<{ j: Row }>(`select to_jsonb(t) j from (${inner}) t`, filters.map((f) => f.value)));
        const rows = res.rows.map((r) => r.j);
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    };
    const api = {
      select(cols: string) { columns = cols; return api; },
      eq(column: string, value: unknown) { filters.push({ column, value }); return api; },
      order(column: string, opts: { ascending: boolean }) { orderBy = { column, ascending: opts.ascending }; return api; },
      maybeSingle() { return run(true); },
      returns() { return run(false); },
    };
    return api;
  }
  return {
    from: builder,
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      try {
        const names = Object.keys(args);
        const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
        const res = await as(uid, () => db.query<{ j: unknown }>(`select to_jsonb(${call}) j`, names.map((n) => args[n])));
        return { data: res.rows[0]?.j ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  } as unknown as Parameters<typeof requestOutboundForInvoice>[0]["userDb"];
}

// -----------------------------------------------------------------------------
// Privilegovaná vrstva nad PGlite — tie isté serverové RPC ako supabase-store.ts.
// Storage = privátna mapa (nikdy neprepisuje).
// -----------------------------------------------------------------------------
const storage = new Map<string, Uint8Array>();
const store: OutboundStore = {
  async requestOutbound(a) {
    try {
      const { rows } = await asService(() =>
        db.query<Row>("select * from public.esblu_einvoice_request_outbound($1, $2, $3, $4, $5, $6, $7)", [
          a.actorUserId, a.invoiceId, a.environment, a.ublSha256, a.ublStoragePath, a.ublSizeBytes, a.receiverParticipantId,
        ])
      );
      const r = rows[0];
      return { outboundId: r.outbound_id as string, created: r.created as boolean, state: r.state as string, ublSha256: r.ubl_sha256 as string, idempotencyKey: r.idempotency_key as string };
    } catch (error) {
      throw new OutboundStoreError(dbErrorCode(error instanceof Error ? error.message : null));
    }
  },
  async claim(mode, limit, lease, after) {
    const { rows } = await asService(() =>
      db.query<{ j: OutboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_claim_outbound($1, $2, $3, $4) t", [mode, limit, lease, after ?? 300])
    );
    return rows.map((r) => r.j);
  },
  async transition(id, expected, to, source, code, fields) {
    try {
      const { rows } = await asService(() =>
        db.query<{ j: OutboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_outbound_transition($1, $2, $3, $4, $5, $6::jsonb) t", [
          id, expected, to, source, code, JSON.stringify(fields),
        ])
      );
      return rows[0].j;
    } catch (error) {
      throw new OutboundStoreError(dbErrorCode(error instanceof Error ? error.message : null));
    }
  },
  async organizationFor(companyId, environment) {
    const { rows } = await sql<Row>(
      "select provider, provider_org_id, participant_id, peppol_eligible from public.einvoice_organizations where company_id = $1 and environment = $2",
      [companyId, environment]
    );
    const o = rows[0];
    return o ? { provider: o.provider as string, providerOrgId: o.provider_org_id as string, participantId: o.participant_id as string, peppolEligible: o.peppol_eligible === true } : null;
  },
  async putUbl(p, bytes) {
    if (storage.has(p)) return "exists";
    storage.set(p, new Uint8Array(bytes));
    return "created";
  },
  async getUbl(p) {
    const b = storage.get(p);
    return b ? new Uint8Array(b) : null;
  },
};

// -----------------------------------------------------------------------------
// Skriptovaný poskytovateľ (sandbox semantika, žiadna sieť)
// -----------------------------------------------------------------------------
type SendScript = "ok" | "reject" | "staged" | EinvoiceProviderError;
class FakeProvider implements EinvoiceProvider {
  readonly name = "mock";
  calls: string[] = [];
  sendKeys: string[] = [];
  sendShas: string[] = [];
  knownRecipients = new Set<string>();
  lookupUnavailable = false;
  preflightResult: PreflightResult = { sendReady: true, validatorUnavailable: false, issues: [] };
  sendScript: SendScript[] = [];
  submissions = new Map<string, { id: string; sha: string }>();
  status = new Map<string, OutboundState>();
  evidenceBody = new Map<string, Record<string, unknown>>();
  statusError: EinvoiceProviderError | null = null;
  private orgs = new Set<string>(["org-a-synthetic", "org-b-synthetic"]);

  private ctx(c: ProviderContext) {
    if (c.environment !== "sandbox" || !this.orgs.has(c.providerOrgId)) throw new EinvoiceProviderError("EINVOICE_ORGANIZATION_NOT_FOUND");
  }
  async provisionOrganization(): Promise<never> { throw new Error("not used"); }
  async getOrganization(): Promise<never> { throw new Error("not used"); }
  async verifyRecipient(c: ProviderContext, participantId: string) {
    this.calls.push("verifyRecipient");
    this.ctx(c);
    return { participantId, found: !this.lookupUnavailable && this.knownRecipients.has(participantId), lookupUnavailable: this.lookupUnavailable };
  }
  async preflight(c: ProviderContext) {
    this.calls.push("preflight");
    this.ctx(c);
    return this.preflightResult;
  }
  async sendUbl(c: ProviderContext, input: SendUblInput): Promise<SendResult> {
    this.calls.push("sendUbl");
    this.ctx(c);
    this.sendKeys.push(input.idempotencyKey);
    const sha = createHash("sha256").update(input.ubl).digest("hex");
    this.sendShas.push(sha);
    if (sha !== input.ublSha256) throw new EinvoiceProviderError("EINVOICE_UBL_HASH_MISMATCH");
    const step = this.sendScript.shift() ?? "ok";
    if (step instanceof EinvoiceProviderError) throw step;
    if (step === "reject") return { state: "rejected", providerSubmissionId: null, providerStagedId: null, rejectReason: "validation_failed" };
    if (step === "staged") return { state: "staged", providerSubmissionId: null, providerStagedId: "stg-1", rejectReason: null };
    const existing = this.submissions.get(input.idempotencyKey);
    if (existing) {
      if (existing.sha !== sha) throw new EinvoiceProviderError("EINVOICE_PROVIDER_CONFLICT");
      return { state: "queued", providerSubmissionId: existing.id, providerStagedId: null, rejectReason: null };
    }
    const id = `prov-${this.submissions.size + 1}-${sha.slice(0, 8)}`;
    this.submissions.set(input.idempotencyKey, { id, sha });
    this.status.set(id, "queued");
    return { state: "queued", providerSubmissionId: id, providerStagedId: null, rejectReason: null };
  }
  async getOutboundStatus(c: ProviderContext, s: { providerSubmissionId: string }) {
    this.calls.push("getOutboundStatus");
    this.ctx(c);
    if (this.statusError) throw this.statusError;
    const state = this.status.get(s.providerSubmissionId);
    if (!state) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    return { state, receiverIdentifier: "9915:2040000000", documentId: state === "delivered" ? `doc-${s.providerSubmissionId}` : null, errorMessage: state === "failed" ? "AS4 error" : null, updatedAt: null };
  }
  async getDeliveryEvidence(c: ProviderContext, s: { providerSubmissionId: string }): Promise<DeliveryEvidence | null> {
    this.calls.push("getDeliveryEvidence");
    this.ctx(c);
    const body = this.evidenceBody.get(s.providerSubmissionId);
    if (!body) return null;
    const record = sanitizeDeliveryEvidence(body);
    return { documentId: record.document_id, ublSha256: record.ubl_sha256, deliveredAt: record.delivered_at, record };
  }
  async listUnacknowledgedInbound(): Promise<never> { throw new Error("not used"); }
  async findSubmissionByIdempotencyKey() { return { kind: "unknown" as const }; }
  async getInboundDocument(): Promise<never> { throw new Error("not used"); }
  async acknowledgeInbound(): Promise<never> { throw new Error("not used"); }
}
/** Phase 4: dohľadanie podľa kľúča, prijaté doklady, „prijal, ale odpoveď sa stratila". */
class OpsFakeProvider extends FakeProvider {
  lookupMode: "auto" | "unknown" = "auto";
  acceptThenTimeout = false;
  docs = new Map<string, { xml: Uint8Array; acknowledged: boolean }>();
  ackErrors: EinvoiceProviderError[] = [];
  get evidence() { return this.evidenceBody; }
  async sendUbl(c: ProviderContext, input: SendUblInput): Promise<SendResult> {
    if (this.acceptThenTimeout) {
      this.sendScript = ["ok"];
      await super.sendUbl(c, input);
      throw new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true);
    }
    return super.sendUbl(c, input);
  }
  async findSubmissionByIdempotencyKey(c: ProviderContext, key: string) {
    this.calls.push("findSubmissionByIdempotencyKey");
    if (this.lookupMode === "unknown") return { kind: "unknown" as const };
    const s = this.submissions.get(key);
    return s ? { kind: "found" as const, providerSubmissionId: s.id, state: (this.status.get(s.id) ?? "queued") as OutboundState } : { kind: "absent" as const };
  }
  async listUnacknowledgedInbound(): Promise<never> { throw new Error("not used"); }
  async getInboundDocument(_c: ProviderContext, id: string) {
    this.calls.push(`fetch:${id}`);
    const d = this.docs.get(id);
    if (!d) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    return { providerReceivedId: id, xml: new Uint8Array(d.xml), pdf: null };
  }
  async acknowledgeInbound(_c: ProviderContext, id: string) {
    this.calls.push(`ack:${id}`);
    const err = this.ackErrors.shift();
    if (err) throw err;
    const d = this.docs.get(id);
    if (!d) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND");
    d.acknowledged = true;
  }
}
const provider = new OpsFakeProvider();
const storageSize = () => storage.size;
// Readiness overuje konfiguráciu cez getEinvoiceProvider(env): syntetický sandbox kľúč
// (nikdy skutočný, žiadna sieť). Samotné volania idú na skriptovaný FakeProvider.
const ENV: Record<string, string | undefined> = {
  ESBLU_EINVOICE_PROVIDER: "efaktura_sk",
  ESBLU_EINVOICE_ENVIRONMENT: "sandbox",
  ESBLU_EFAKTURA_API_KEY: "efk_pk_test_" + "0".repeat(24),
};

function requestAs(uid: string | null, invoiceId: string) {
  return requestOutboundForInvoice(
    { userDb: userDb(uid), store, runtime: { provider, environment: "sandbox" }, env: ENV },
    { userId: uid ?? "00000000-0000-4000-8000-000000000000", invoiceId, confirmation: "user_confirm_send" }
  );
}
const workerDeps = () => ({ store, provider });
const WOPTS = { batchSize: 10, leaseSeconds: 120, reconcileAfterSeconds: 0 };

// -----------------------------------------------------------------------------
// Syntetické firmy, roly, faktúry
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
const PARTNER_A = "d0000000-0000-4000-8000-00000000000a";
const PARTNER_B = "d0000000-0000-4000-8000-00000000000b";
const BUYER = "9915:2040000000";

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
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code,
      country_code, iban, contact_email, electronic_address, electronic_address_scheme_id)
    values ('${CA}', 'Syntetická A s.r.o.', '11111111', '2020000000', 'SK2020000000', 'Testovacia 1', 'Bratislava', '81101',
      'SK', 'SK3112000000198742637541', 'fakturacia@example.test', '2020000000', '9915'),
           ('${CB}', 'Syntetická B s.r.o.', '22222222', '2030000000', 'SK2030000000', 'Skúšobná 2', 'Košice', '04001',
      'SK', null, null, '2030000000', '9915');
  insert into public.business_partners (id, company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city,
      postal_code, country_code, electronic_address, electronic_address_scheme_id)
    values ('${PARTNER_A}', '${CA}', 'customer', 'Odberateľ s.r.o.', '33333333', '2040000000', 'SK2040000000',
      'Príkladná 3', 'Žilina', '01001', 'SK', '2040000000', '9915'),
           ('${PARTNER_B}', '${CB}', 'customer', 'Odberateľ B', '44444444', '2050000000', 'SK2050000000', 'Iná 4', 'Nitra', '94901', 'SK', '2050000000', '9915');
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, org_status, peppol_eligible)
    values ('${CA}', 'mock', 'sandbox', 'org-a-synthetic', '9915:2020000000', 'active', true),
           ('${CB}', 'mock', 'sandbox', 'org-b-synthetic', '9915:2030000000', 'active', true);
  insert into public.company_entitlements (company_id, entitlement_key, source, note) values ('${CA}', 'einvoice', 'manual', 'test');
  insert into public.einvoice_rollout (company_id, environment, stage, changed_by)
    values ('${CA}', 'sandbox', 'internal', 'test'), ('${CB}', 'sandbox', 'internal', 'test');
`));

const ITEMS = [
  { description: "Práca", quantity: 2, unit: "hod", unit_code: "HUR", unit_price: 50, price_mode: "net",
    vat_category_code: "S", vat_rate: 23, line_net_amount: 100, line_vat_amount: 23, line_gross_amount: 123 },
];
const HEADER = {
  issue_date: "2026-10-01", due_date: "2026-10-15", delivery_date: "2026-09-30", variable_symbol: "2026001",
  currency: "EUR", customer_business_partner_id: PARTNER_A, buyer_reference: "OBJ-REF-1",
  purchase_order_reference: "PO-77", payment_means_code: "30", payment_reference: "2026001",
};
async function invoice(uid: string, company: string, partner: string, header: Row = HEADER, finalize = true): Promise<string> {
  const { rows } = await as(uid, () =>
    db.query<{ id: string }>(
      `insert into public.invoices (company_id, direction, kind, issue_date, currency, customer_business_partner_id, source)
       values ($1, 'issued', 'regular_invoice', '2026-10-01', 'EUR', $2, 'manual') returning id`,
      [company, partner]
    )
  );
  const id = rows[0].id;
  await as(uid, () => db.query("select id from public.esblu_save_invoice_draft($1, $2::jsonb, $3::jsonb, null)", [id, JSON.stringify({ ...header, customer_business_partner_id: partner }), JSON.stringify(ITEMS)]));
  if (finalize) await as(uid, () => db.query("select public.esblu_finalize_invoice($1)", [id]));
  return id;
}
const outboundOf = async (id: string) => (await sql<Row>("select * from public.einvoice_outbound where id = $1", [id])).rows[0];
/** Testovací posun času: riadok je hneď retry-ready (iba superuser test, aplikácia to nevie). */
const makeDue = (id: string) => sql("update public.einvoice_outbound set next_retry_at = now() - interval '1 second' where id = $1", [id]);
async function freshQueued(): Promise<{ invoiceId: string; outboundId: string }> {
  const invoiceId = await invoice(U.owner, CA, PARTNER_A);
  const r = await requestAs(U.owner, invoiceId);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return { invoiceId, outboundId: r.body.outbound!.id };
}
/** Spracuje iba jeden konkrétny riadok (ostatné queued sa dočasne odsunú). */
async function sendOnly(outboundId: string) {
  await sql("update public.einvoice_outbound set next_retry_at = now() + interval '1 day' where id <> $1 and state in ('queued','sending') and provider_submission_id is null and next_retry_at is not null", [outboundId]);
  return runOutboundSendBatch(workerDeps(), WOPTS);
}

provider.knownRecipients.add(BUYER);

// =============================================================================
// Phase 4 — dodatočné vrstvy: inbound + ops store nad PGlite, rozšírený fake
// =============================================================================
const INBOUND_STORAGE = new Map<string, Uint8Array>();
const svcRows = async <T>(text: string, params: unknown[]): Promise<T[]> => {
  try {
    return (await asService(() => db.query<T>(text, params))).rows;
  } catch (error) {
    throw new InboundStoreError(dbErrorCode(error instanceof Error ? error.message : null));
  }
};
const inboundStore: InboundStore = {
  async webhookRecord(i) {
    const [r] = await svcRows<Row>("select * from public.esblu_einvoice_webhook_record($1, $2, $3, $4, $5, $6)", [i.provider, i.environment, i.deliveryId, i.providerOrgId, i.event, i.bodySha256]);
    return { webhookEventId: r.webhook_event_id as string, inserted: r.inserted as boolean, bodyMatches: r.body_matches as boolean, companyId: (r.company_id as string) ?? null, processingStatus: r.processing_status as string };
  },
  async webhookComplete(id, status, code) {
    await svcRows("select public.esblu_einvoice_webhook_complete($1, $2, $3)", [id, status, code]);
  },
  async register(i) {
    const [r] = await svcRows<Row>("select * from public.esblu_einvoice_inbound_register($1, $2, $3, $4, $5, $6::jsonb)", [i.provider, i.environment, i.providerOrgId, i.providerReceivedId, i.source, JSON.stringify(i.meta)]);
    return { inboundId: r.inbound_id as string, created: r.created as boolean, processingStatus: r.processing_status as string, companyId: r.company_id as string };
  },
  async claim(limit, lease) {
    return (await svcRows<{ j: InboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_claim_inbound($1, $2) t", [limit, lease])).map((r) => r.j);
  },
  async transition(id, expected, to, source, code, fields) {
    const [r] = await svcRows<{ j: InboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_inbound_transition($1, $2, $3, $4, $5, $6::jsonb) t", [id, expected, to, source, code, JSON.stringify(fields)]);
    return r.j;
  },
  async createDraft(id, draft) {
    const [r] = await svcRows<{ j: Row }>("select public.esblu_einvoice_inbound_create_draft($1, $2::jsonb) j", [id, JSON.stringify(draft)]);
    return { status: r.j.status as "created" | "duplicate", invoiceId: r.j.invoice_id as string, matchedOn: (r.j.matched_on as string) ?? null };
  },
  async findStoredXmlPath(companyId, sha, except) {
    const { rows } = await sql<{ p: string }>("select xml_storage_path p from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2 and id <> $3 and xml_storage_path is not null limit 1", [companyId, sha, except]);
    return rows[0]?.p ?? null;
  },
  organizationFor: (c, e) => store.organizationFor(c, e),
  async listOrganizations() { return []; },
  async companyForOrg() { return null; },
  async claimOutboundBySubmission() { return null; },
  async putXml(p, bytes) {
    if (INBOUND_STORAGE.has(p)) return "exists";
    INBOUND_STORAGE.set(p, new Uint8Array(bytes));
    return "created";
  },
  async getXml(p) {
    const b = INBOUND_STORAGE.get(p);
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
  async health(m, a) {
    return (await asService(() => db.query<{ j: unknown }>("select public.esblu_einvoice_health($1, $2) j", [m, a]))).rows[0].j;
  },
  async outcomes24h() {
    return (await asService(() => db.query<{ j: unknown }>("select public.esblu_einvoice_outcomes_24h() j"))).rows[0].j;
  },
  async retention(d, l) {
    return (await asService(() => db.query<{ j: { older_than_days: number; webhook_events_deleted: number; rejection_buckets_deleted: number } }>("select public.esblu_einvoice_webhook_retention($1, $2) j", [d, l]))).rows[0].j;
  },
  async storageConsistency() {
    return (await asService(() => db.query<{ j: Record<string, number> }>("select public.esblu_einvoice_storage_consistency() j"))).rows[0].j;
  },
  async recordWebhookRejection(p, e, r) {
    await asService(() => db.query("select public.esblu_einvoice_webhook_rejection_record($1, $2, $3)", [p, e, r]));
  },
};

provider.lookupMode = "auto";
const runtime = { provider, environment: "sandbox" as const };
const op = (uid: string, kind: "outbound" | "inbound", id: string, action: OperatorAction, reasonCode: OperatorReasonCode | null = null) =>
  runOperatorAction({ ops: opsStore, outbound: store, inbound: inboundStore, runtime, userDb: userDb(uid), env: ENV }, { userId: uid, kind, id, action, reasonCode });
/** Test: cooldown a lease „uplynuli" (iba superuser test). */
const resetOperator = (table: "einvoice_outbound" | "einvoice_inbound", id: string) =>
  sql(`update public.${table} set operator_action_at = null, locked_until = null where id = $1`, [id]);
const actionEvents = async (column: "outbound_id" | "inbound_id", id: string) =>
  (await sql<Row>(`select source, provider_code, from_state, to_state, metadata from public.einvoice_events where ${column} = $1 and provider_code like 'OPERATOR_%' order by created_at, id`, [id])).rows;
async function exhaustUnknown(): Promise<{ invoiceId: string; outboundId: string }> {
  const q = await freshQueued();
  for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
    provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true)];
    await makeDue(q.outboundId);
    await sendOnly(q.outboundId);
  }
  const row = await outboundOf(q.outboundId);
  assert.equal(row.last_error_code, "EINVOICE_RETRY_EXHAUSTED_UNKNOWN");
  return q;
}

// =============================================================================
// Čisté časti
// =============================================================================
await check("kategórie: TS zrkadlo == DB funkcie pre všetky kombinácie stavov", async () => {
  const outCases: [string, string | null, string | null, string | null][] = [
    ["queued", null, "2026-10-01T00:00:00Z", null], ["sending", null, "2026-10-01T00:00:00Z", "EINVOICE_PROVIDER_TIMEOUT"],
    ["sending", null, null, "EINVOICE_RETRY_EXHAUSTED_UNKNOWN"], ["sending", null, null, "EINVOICE_PROVIDER_CONFLICT"],
    ["sent", "p1", null, null], ["deferred", "p1", null, null], ["delivered", "p1", null, null],
    ["failed", null, null, "X"], ["rejected", null, null, "X"],
  ];
  for (const [state, pid, next, code] of outCases) {
    const { rows } = await sql<{ c: string }>("select public.esblu_einvoice_outbound_category($1, $2, $3::timestamptz, $4) c", [state, pid, next, code]);
    assert.equal(rows[0].c, outboundCategory({ state, provider_submission_id: pid, next_retry_at: next, last_error_code: code }), `${state}/${pid}/${next}/${code}`);
  }
  for (const [status, dedupe] of [["received", null], ["stored", null], ["parsed", null], ["draft_created", null], ["duplicate", "xml_sha256"], ["ack_pending", null], ["acknowledged", null], ["acknowledged", "xml_sha256"], ["failed", null]] as const) {
    const { rows } = await sql<{ c: string }>("select public.esblu_einvoice_inbound_category($1, $2) c", [status, dedupe]);
    assert.equal(rows[0].c, inboundCategory({ processing_status: status, dedupe_matched_on: dedupe }), `${status}/${dedupe}`);
  }
});

await check("telo operátorskej akcie: iba confirm_action (+ reason_code z allowlistu); company_id/role/env/provider ID = 400", () => {
  assert.deepEqual(parseOperatorBody({ confirm_action: true }), { ok: true, reasonCode: null });
  assert.deepEqual(parseOperatorBody({ confirm_action: true, reason_code: "DATA_FIXED" }), { ok: true, reasonCode: "DATA_FIXED" });
  assert.deepEqual(parseOperatorBody({ confirm_action: true, reason_code: "free text" }), { ok: false, code: "INVALID_REASON_CODE" });
  assert.deepEqual(parseOperatorBody({}), { ok: false, code: "CONFIRMATION_REQUIRED" });
  for (const extra of ["company_id", "role", "environment", "provider_submission_id", "provider_received_id", "idempotency_key", "api_key", "note"]) {
    assert.deepEqual(parseOperatorBody({ confirm_action: true, [extra]: "x" }), { ok: false, code: "UNEXPECTED_FIELDS" }, extra);
  }
});

await check("grant: operátorské a prevádzkové RPC iba service_role", async () => {
  const { rows } = await sql<Row>(
    `select p.proname f, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('anon', p.oid, 'execute') anon,
            has_function_privilege('service_role', p.oid, 'execute') srv
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('esblu_einvoice_operator_begin', 'esblu_einvoice_health', 'esblu_einvoice_webhook_retention',
       'esblu_einvoice_storage_consistency', 'esblu_einvoice_webhook_rejection_record')`
  );
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.equal(r.auth, false, String(r.f));
    assert.equal(r.anon, false, String(r.f));
    assert.equal(r.srv, true, String(r.f));
  }
});

// =============================================================================
// OUTBOUND — manuálny retry / reconcile
// =============================================================================
await check("manual retry po rejected: nový pokus (attempt 2, NOVÝ kľúč), audit OPERATOR_OUTBOUND_RETRY (source=user, iba action/actor/reason)", async () => {
  const q = await freshQueued();
  provider.sendScript = ["reject"];
  await sendOnly(q.outboundId);
  const old = await outboundOf(q.outboundId);
  assert.equal(old.state, "rejected");
  const r = await op(U.owner, "outbound", q.outboundId, "outbound_retry", "DATA_FIXED");
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.code, "QUEUED");
  const next = await outboundOf(r.body.outbound!.id);
  assert.equal(next.attempt, 2);
  assert.notEqual(next.idempotency_key, old.idempotency_key);
  const ev = await actionEvents("outbound_id", q.outboundId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, "user");
  assert.equal(ev[0].provider_code, "OPERATOR_OUTBOUND_RETRY");
  assert.deepEqual(ev[0].metadata, { action: "outbound_retry", actor_user_id: U.owner, reason_code: "DATA_FIXED" });
  assert.equal(ev[0].from_state, ev[0].to_state);
});

await check("manual retry po potvrdenom failed (403 od poskytovateľa, bez neistoty) → povolený", async () => {
  const q = await freshQueued();
  provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_FORBIDDEN", "f", false)];
  await sendOnly(q.outboundId);
  assert.equal((await outboundOf(q.outboundId)).state, "failed");
  const r = await op(U.acc, "outbound", q.outboundId, "outbound_retry");
  assert.equal(r.status, 202, JSON.stringify(r.body));
});

let UNKNOWN: { invoiceId: string; outboundId: string };
await check("neistý výsledok (8× timeout): retry NIE je priamo možný → 409 RECONCILE_REQUIRED; žiadny nový pokus", async () => {
  UNKNOWN = await exhaustUnknown();
  const r = await op(U.owner, "outbound", UNKNOWN.outboundId, "outbound_retry");
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ESBLU_EINVOICE_RECONCILE_REQUIRED");
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound where invoice_id = $1", [UNKNOWN.invoiceId]);
  assert.equal(rows[0].n, 1);
});

await check("DB vynúti: ani priama požiadavka (RPC) nevytvorí nový pokus po neistom výsledku bez potvrdenej absencie", async () => {
  const q = await exhaustUnknown();
  // aj keby niekto riadok uzavrel ako failed, neistota ostáva → nový pokus zakázaný
  await sql("update public.einvoice_outbound set state = 'failed' where id = $1", [q.outboundId]);
  const row = await outboundOf(q.outboundId);
  const msg = await errorOf(() => store.requestOutbound({
    actorUserId: U.owner, invoiceId: q.invoiceId, environment: "sandbox", ublSha256: row.ubl_sha256 as string,
    ublStoragePath: row.ubl_storage_path as string, ublSizeBytes: row.ubl_size_bytes as number, receiverParticipantId: BUYER,
  }));
  assert.match(msg, /ESBLU_EINVOICE_PREVIOUS_OUTCOME_UNKNOWN/);
  await resetOperator("einvoice_outbound", q.outboundId);
  const r = await op(U.owner, "outbound", q.outboundId, "outbound_retry");
  assert.equal(r.body.code, "ESBLU_EINVOICE_RECONCILE_REQUIRED");
});

await check("neistý výsledok vyžaduje reconcile: poskytovateľ to nevie potvrdiť → RECONCILE_INCONCLUSIVE, nič sa nemení, retry stále blokovaný", async () => {
  provider.lookupMode = "unknown";
  provider.calls = [];
  const r = await op(U.owner, "outbound", UNKNOWN.outboundId, "outbound_reconcile");
  provider.lookupMode = "auto";
  assert.equal(r.body.code, "RECONCILE_INCONCLUSIVE");
  assert.equal(r.body.category, "retry_exhausted_unknown");
  assert.ok(!provider.calls.includes("sendUbl"));
  const row = await outboundOf(UNKNOWN.outboundId);
  assert.equal(row.state, "sending");
  assert.equal(row.locked_until, null);
  await resetOperator("einvoice_outbound", UNKNOWN.outboundId);
  assert.equal((await op(U.owner, "outbound", UNKNOWN.outboundId, "outbound_retry")).body.code, "ESBLU_EINVOICE_RECONCILE_REQUIRED");
});

await check("reconcile nájde pôvodné podanie → pokračuje sa s ním (sent, ID poskytovateľa), ŽIADNE nové odoslanie", async () => {
  const q = await freshQueued();
  // poskytovateľ prijal, ale odpoveď sa stratila (timeout) — 8×
  for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
    provider.acceptThenTimeout = i === 0;
    provider.sendScript = i === 0 ? [] : [new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true)];
    await makeDue(q.outboundId);
    await sendOnly(q.outboundId);
  }
  provider.acceptThenTimeout = false;
  const before = await outboundOf(q.outboundId);
  assert.equal(before.last_error_code, "EINVOICE_RETRY_EXHAUSTED_UNKNOWN");
  const sends = provider.sendKeys.length;
  const r = await op(U.owner, "outbound", q.outboundId, "outbound_reconcile", "PROVIDER_CONFIRMED");
  assert.equal(r.body.code, "ORIGINAL_FOUND");
  const row = await outboundOf(q.outboundId);
  assert.equal(row.state, "sent");
  assert.ok(row.provider_submission_id);
  assert.equal(row.reconciled_absent_at, null);
  assert.equal(provider.sendKeys.length, sends, "reconcile nesmie odoslať");
  // ďalej štandardná reconciliation stavu
  await resetOperator("einvoice_outbound", q.outboundId);
  const again = await op(U.owner, "outbound", q.outboundId, "outbound_reconcile");
  assert.equal(again.body.code, "RECONCILED");
  assert.equal(provider.sendKeys.length, sends);
});

await check("reconcile autoritatívne potvrdí absenciu → failed + reconciled_absent_at → až potom povolený nový pokus", async () => {
  await resetOperator("einvoice_outbound", UNKNOWN.outboundId);
  const r = await op(U.owner, "outbound", UNKNOWN.outboundId, "outbound_reconcile");
  assert.equal(r.body.code, "ABSENT_CONFIRMED");
  const row = await outboundOf(UNKNOWN.outboundId);
  assert.equal(row.state, "failed");
  assert.ok(row.reconciled_absent_at);
  assert.equal(row.send_outcome_unknown, true);
  assert.match(await errorOf(() => sql("update public.einvoice_outbound set reconciled_absent_at = now() + interval '1 day' where id = $1", [UNKNOWN.outboundId])), /IDENTITY_IMMUTABLE/);
  await resetOperator("einvoice_outbound", UNKNOWN.outboundId);
  const retry = await op(U.owner, "outbound", UNKNOWN.outboundId, "outbound_retry");
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  const next = await outboundOf(retry.body.outbound!.id);
  assert.equal(next.attempt, 2);
});

await check("duplicitná manuálna akcia: cooldown (429), aktívny lease (409), druhý retry nevytvorí ďalší pokus", async () => {
  const q = await freshQueued();
  provider.sendScript = ["ok"];
  await sendOnly(q.outboundId);
  const first = await op(U.owner, "outbound", q.outboundId, "outbound_reconcile");
  assert.equal(first.status, 200);
  const second = await op(U.owner, "outbound", q.outboundId, "outbound_reconcile");
  assert.deepEqual([second.status, second.body.code], [429, "ESBLU_EINVOICE_ACTION_RATE_LIMITED"]);
  await sql("update public.einvoice_outbound set operator_action_at = null, locked_until = now() + interval '1 minute' where id = $1", [q.outboundId]);
  const third = await op(U.owner, "outbound", q.outboundId, "outbound_reconcile");
  assert.deepEqual([third.status, third.body.code], [409, "ESBLU_EINVOICE_ACTION_IN_PROGRESS"]);
  // retry dvakrát po sebe
  const r = await freshQueued();
  provider.sendScript = ["reject"];
  await sendOnly(r.outboundId);
  assert.equal((await op(U.owner, "outbound", r.outboundId, "outbound_retry")).status, 202);
  const dup = await op(U.owner, "outbound", r.outboundId, "outbound_retry");
  assert.equal(dup.status, 429);
  await resetOperator("einvoice_outbound", r.outboundId);
  const dup2 = await op(U.owner, "outbound", r.outboundId, "outbound_retry");
  assert.equal(dup2.body.code, "ESBLU_EINVOICE_NOT_LATEST_ATTEMPT");
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound where invoice_id = $1", [r.invoiceId]);
  assert.equal(rows[0].n, 2);
});

await check("cross-tenant: owner inej firmy → 404 NOT_FOUND, žiadny audit, žiadne volanie poskytovateľa", async () => {
  provider.calls = [];
  const before = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_events where provider_code like 'OPERATOR_%'")).rows[0].n;
  for (const action of ["outbound_reconcile", "outbound_retry"] as const) {
    const r = await op(U.b, "outbound", UNKNOWN.outboundId, action);
    assert.deepEqual([r.status, r.body.code], [404, "ESBLU_EINVOICE_NOT_FOUND"], action);
  }
  const after = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_events where provider_code like 'OPERATOR_%'")).rows[0].n;
  assert.equal(after, before);
  assert.deepEqual(provider.calls, []);
});

await check("finance.manage povinné: admin bez financií, admin iba view, employee → 403", async () => {
  for (const uid of [U.admin, U.adminView, U.emp]) {
    for (const [kind, action] of [["outbound", "outbound_reconcile"], ["outbound", "outbound_retry"]] as const) {
      const r = await op(uid, kind, UNKNOWN.outboundId, action);
      assert.deepEqual([r.status, r.body.code], [403, "ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED"], `${uid} ${action}`);
    }
  }
});

// =============================================================================
// INBOUND — reprocess / ACK retry
// =============================================================================
const supplierParty = (over: Partial<UblParty> = {}): UblParty => ({
  role: "seller", legal_name: "Dodávateľ X s.r.o.", ico: "55555555", dic: "2055555555", ic_dph: "SK2055555555",
  address_line1: "Dodávateľská 5", address_line2: null, city: "Trnava", postal_code: "91701", country_code: "SK",
  iban: "SK3112000000198742637541", bic: "TESTSKBX", email: null, electronic_address: "2055555555", electronic_address_scheme_id: "9915",
  legal_registration_id: null, legal_registration_scheme_id: null, vat_identifier: null, ...over,
});
function inboundXml(number: string): Uint8Array {
  const s: UblInvoiceSnapshot = {
    invoice: {
      id: "f0000000-0000-4000-8000-000000000001", company_id: "x", direction: "issued", kind: "regular_invoice", document_status: "finalized",
      invoice_number: number, issue_date: "2026-10-01", due_date: "2026-10-15", delivery_date: null, tax_point_date: null, currency: "EUR",
      subtotal_amount: 100, vat_total_amount: 23, total_amount: 123, rounding_amount: 0, buyer_reference: "REF", purchase_order_reference: null,
      payment_means_code: "30", payment_reference: "VS1", corrects_invoice_id: null,
    },
    seller: supplierParty(),
    buyer: { ...supplierParty({ role: "buyer", legal_name: "Syntetická A s.r.o.", ico: "11111111", electronic_address: "2020000000", ic_dph: "SK2020000000", iban: null, bic: null }) },
    items: [{ position: 1, description: "Služba", quantity: 2, unit_code: "HUR", unit_price: 50, price_mode: "net", vat_category_code: "S", vat_rate: 23, line_net_amount: 100 }],
    taxBreakdowns: [{ vat_category_code: "S", vat_rate: 23, taxable_amount: 100, vat_amount: 23, vat_exemption_reason_code: null, vat_exemption_reason_text: null }],
    correctedInvoice: null,
  };
  const r = generateUbl(s);
  if (!r.ok) throw new Error(r.issues.map((i) => i.code).join(","));
  return r.bytes;
}
const inboundByPid = async (pid: string) => (await sql<Row>("select * from public.einvoice_inbound where provider_received_id = $1", [pid])).rows[0];
async function receive(pid: string, xml: Uint8Array) {
  provider.docs.set(pid, { xml, acknowledged: false });
  const reg = await inboundStore.register({ provider: "mock", environment: "sandbox", providerOrgId: "org-a-synthetic", providerReceivedId: pid, source: "poll", meta: {} });
  await sql("update public.einvoice_inbound set next_retry_at = now() + interval '1 day' where id <> $1 and processing_status not in ('acknowledged','failed')", [reg.inboundId]);
  await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second' where id = $1", [reg.inboundId]);
  const rows = await inboundStore.claim(10, 120);
  for (const row of rows) await processInboundRow({ store: inboundStore, provider, environment: "sandbox" }, row);
  return inboundByPid(pid);
}
async function expireTrialAndSuspend(company: string, suspend: boolean) {
  await sql("update public.company_entitlements set status = $2 where company_id = $1 and entitlement_key = 'einvoice'", [company, suspend ? "suspended" : "active"]);
  await locked(async () => {
    await db.exec("alter table public.companies disable trigger esblu_companies_trial_guard");
    await db.query("update public.companies set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '16 days' where id = $1", [company]);
    await db.exec("alter table public.companies enable trigger esblu_companies_trial_guard");
  });
}

await check("reprocess po zlyhaní konceptu (chýbajúci nárok) → po obnove nároku koncept + ACK; žiadny duplicitný koncept", async () => {
  await expireTrialAndSuspend(CA, true);
  const row = await receive("rcv-ops-1", inboundXml("FA-OPS-1"));
  assert.equal(row.processing_status, "parsed");
  assert.equal(row.last_error_code, "DRAFT_CREATE_FAILED");
  // bez nároku je reprocess zablokovaný
  const denied = await op(U.owner, "inbound", row.id as string, "inbound_reprocess");
  assert.equal(denied.status, 403);
  assert.match(String(denied.body.code), /ENTITLEMENT_DENIED/);
  await expireTrialAndSuspend(CA, false);
  const r = await op(U.owner, "inbound", row.id as string, "inbound_reprocess", "DATA_FIXED");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "acknowledged");
  const after = await inboundByPid("rcv-ops-1");
  assert.ok(after.invoice_id);
  // opakovaný reprocess → nepovolený, žiadny druhý koncept
  await resetOperator("einvoice_inbound", row.id as string);
  const again = await op(U.owner, "inbound", row.id as string, "inbound_reprocess");
  assert.deepEqual([again.status, again.body.code], [409, "ESBLU_EINVOICE_ACTION_NOT_ALLOWED"]);
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.invoices where supplier_invoice_number = 'FA-OPS-1'");
  assert.equal(rows[0].n, 1);
  const ev = await actionEvents("inbound_id", row.id as string);
  assert.deepEqual(ev.map((e) => e.provider_code), ["OPERATOR_INBOUND_REPROCESS"]);
});

await check("reprocess failed s uloženým XML: failed → stored (bez prepisu XML/hashu), dedupe ostáva; bez XML nepovolené", async () => {
  // dodávateľ bez akejkoľvek identity → trvalé zlyhanie konceptu
  const xml = new TextDecoder().decode(inboundXml("FA-OPS-2"))
    .replace(/<cbc:EndpointID schemeID="9915">2055555555<\/cbc:EndpointID>/, "")
    .replace(/<cac:PartyTaxScheme><cbc:CompanyID>SK2055555555<\/cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT<\/cbc:ID><\/cac:TaxScheme><\/cac:PartyTaxScheme>/, "")
    .replace(/<cbc:CompanyID schemeID="0158">55555555<\/cbc:CompanyID>/, "");
  const row = await receive("rcv-ops-2", new TextEncoder().encode(xml));
  assert.equal(row.processing_status, "failed", String(row.last_error_code));
  assert.equal(row.last_error_code, "DRAFT_CREATE_FAILED");
  const shaBefore = row.xml_sha256;
  const pathBefore = row.xml_storage_path;
  const r = await op(U.owner, "inbound", row.id as string, "inbound_reprocess");
  assert.equal(r.status, 200);
  const after = await inboundByPid("rcv-ops-2");
  assert.equal(after.processing_status, "failed"); // deterministicky znova (dáta sa nezmenili)
  assert.equal(after.xml_sha256, shaBefore);
  assert.equal(after.xml_storage_path, pathBefore);
  assert.equal(after.invoice_id, null);
  const trail = (await sql<Row>("select from_state, to_state, source from public.einvoice_events where inbound_id = $1 and provider_code is distinct from 'OPERATOR_INBOUND_REPROCESS' order by created_at, id", [row.id])).rows.map((e) => `${e.from_state}->${e.to_state}:${e.source}`);
  assert.ok(trail.includes("failed->stored:user"));
  // failed BEZ XML (napr. trvalá chyba sťahovania) → reprocess nepovolený
  await sql("insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id, processing_status, last_error_code) values ($1, 'mock', 'sandbox', 'rcv-noxml', 'failed', 'PROVIDER_FETCH_FAILED')", [CA]);
  const noxml = await inboundByPid("rcv-noxml");
  const d = await op(U.owner, "inbound", noxml.id as string, "inbound_reprocess");
  assert.deepEqual([d.status, d.body.code], [409, "ESBLU_EINVOICE_ACTION_NOT_ALLOWED"]);
});

await check("ACK retry: ack_pending → acknowledged (idempotentný ACK), kontrola uloženého XML; duplicitná akcia bez ďalšieho ACK", async () => {
  provider.ackErrors = [new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", "u", true)];
  const row = await receive("rcv-ops-3", inboundXml("FA-OPS-3"));
  assert.equal(row.processing_status, "ack_pending");
  const r = await op(U.owner, "inbound", row.id as string, "inbound_ack_retry");
  assert.equal(r.body.state, "acknowledged");
  const acks = provider.calls.filter((c) => c === "ack:rcv-ops-3").length;
  await resetOperator("einvoice_inbound", row.id as string);
  const dup = await op(U.owner, "inbound", row.id as string, "inbound_ack_retry");
  assert.deepEqual([dup.status, dup.body.code], [409, "ESBLU_EINVOICE_ACK_REQUIRES_DRAFT"]);
  assert.equal(provider.calls.filter((c) => c === "ack:rcv-ops-3").length, acks);
});

await check("ACK nemožný bez konceptu (failed pred konceptom / parsed) a pri poškodenom XML v storage", async () => {
  const failed = await inboundByPid("rcv-ops-2");
  await resetOperator("einvoice_inbound", failed.id as string);
  const r = await op(U.owner, "inbound", failed.id as string, "inbound_ack_retry");
  assert.deepEqual([r.status, r.body.code], [409, "ESBLU_EINVOICE_ACK_REQUIRES_DRAFT"]);
  assert.ok(!provider.calls.includes("ack:rcv-ops-2"));
  provider.ackErrors = [new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", "u", true)];
  const row = await receive("rcv-ops-4", inboundXml("FA-OPS-4"));
  assert.equal(row.processing_status, "ack_pending");
  const p = row.xml_storage_path as string;
  const tampered = new Uint8Array(INBOUND_STORAGE.get(p)!);
  tampered[10] = 0x41;
  INBOUND_STORAGE.set(p, tampered);
  const acksBefore = provider.calls.filter((c) => c === "ack:rcv-ops-4").length; // 1 = pôvodný zlyhaný pokus
  const t = await op(U.owner, "inbound", row.id as string, "inbound_ack_retry");
  assert.deepEqual([t.status, t.body.code], [409, "STORAGE_INTEGRITY"]);
  assert.equal(provider.calls.filter((c) => c === "ack:rcv-ops-4").length, acksBefore, "pri poškodenom XML žiadny ACK");
});

// =============================================================================
// RETENCIA
// =============================================================================
await check("retencia: uzavreté webhooky > 90 dní zmazané; novšie a nespracované ostávajú; faktúry/udalosti/XML/UBL nedotknuté", async () => {
  await sql(`insert into public.einvoice_webhook_events (provider, environment, delivery_id, company_id, event, body_sha256, processing_status, received_at, processed_at) values
    ('mock', 'sandbox', 'old-processed', $1, 'e', $2, 'processed', now() - interval '100 days', now() - interval '100 days'),
    ('mock', 'sandbox', 'old-rejected', null, 'e', $2, 'rejected', now() - interval '120 days', now() - interval '120 days'),
    ('mock', 'sandbox', 'recent-processed', $1, 'e', $2, 'processed', now() - interval '10 days', now() - interval '10 days'),
    ('mock', 'sandbox', 'old-unprocessed', $1, 'e', $2, 'received', now() - interval '100 days', null)`, [CA, "a".repeat(64)]);
  await sql("insert into public.einvoice_webhook_rejections (provider, environment, reason, bucket_start, count) values ('mock', 'sandbox', 'INVALID_SIGNATURE', now() - interval '100 days', 3)");
  const snapshot = async () => (await sql<Row>(
    "select (select count(*)::int from public.invoices) inv, (select count(*)::int from public.einvoice_events) ev, (select count(*)::int from public.einvoice_outbound) o, (select count(*)::int from public.einvoice_inbound) i, (select count(*)::int from public.invoice_events) ie, (select count(*)::int from public.einvoice_outbound where evidence is not null) evd"
  )).rows[0];
  const before = await snapshot();
  const storageBefore = [storageSize(), INBOUND_STORAGE.size];
  const r = await opsStore.retention(90, 1000);
  assert.equal(r.webhook_events_deleted, 2);
  assert.equal(r.rejection_buckets_deleted, 1);
  const left = (await sql<{ d: string }>("select delivery_id d from public.einvoice_webhook_events where delivery_id in ('old-processed','old-rejected','recent-processed','old-unprocessed') order by d")).rows.map((x) => x.d);
  assert.deepEqual(left, ["old-unprocessed", "recent-processed"]);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual([storageSize(), INBOUND_STORAGE.size], storageBefore);
  // minimum 30 dní aj pri nižšom parametri
  assert.equal((await opsStore.retention(1, 1000)).older_than_days, 30);
  assert.ok(left.includes("recent-processed"));
});

// =============================================================================
// HEALTH / ALERTY / STORAGE
// =============================================================================
await check("health: počty sedia s DB, výstup iba čísla — žiadne firmy, IČO, čísla dokladov, participant ID ani tajomstvá", async () => {
  await opsStore.recordWebhookRejection("mock", "sandbox", "INVALID_SIGNATURE");
  const raw = await opsStore.health(60, 60);
  const health = sanitizeHealth(raw);
  const c = async (q: string) => (await sql<{ n: number }>(q)).rows[0].n;
  assert.equal(health.outbound.queued, await c("select count(*)::int n from public.einvoice_outbound where state = 'queued'"));
  assert.equal(health.outbound.failed, await c("select count(*)::int n from public.einvoice_outbound where state = 'failed'"));
  assert.equal(health.outbound.rejected, await c("select count(*)::int n from public.einvoice_outbound where state = 'rejected'"));
  assert.equal(health.outbound.retry_exhausted_unknown, await c("select count(*)::int n from public.einvoice_outbound where state = 'sending' and provider_submission_id is null and last_error_code = 'EINVOICE_RETRY_EXHAUSTED_UNKNOWN'"));
  assert.equal(health.inbound.acknowledged + health.inbound.duplicate - (await c("select count(*)::int n from public.einvoice_inbound where processing_status = 'duplicate'")), await c("select count(*)::int n from public.einvoice_inbound where processing_status = 'acknowledged'"));
  assert.equal(health.inbound.failed, await c("select count(*)::int n from public.einvoice_inbound where processing_status = 'failed'"));
  assert.ok(health.webhook.signature_failures_1h >= 1);
  const text = JSON.stringify(raw);
  for (const forbidden of [CA, CB, "11111111", "55555555", "FA-OPS", "9915:", "org-a-synthetic", "efk_", "whsec_", "Syntetick"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  for (const group of [health.outbound, health.inbound, health.webhook]) {
    for (const v of Object.values(group)) assert.equal(typeof v, "number");
  }
});

await check("alert kandidáti: neistý výsledok / vyčerpané pokusy / podpisové zlyhania — strojovo čitateľné", async () => {
  for (let i = 0; i < 12; i++) await opsStore.recordWebhookRejection("mock", "sandbox", "INVALID_SIGNATURE");
  const report = await runEinvoiceMaintenance(opsStore, { retention: false });
  const codes = report.alerts.map((a) => a.code);
  assert.ok(codes.includes("WEBHOOK_SIGNATURE_FAILURES"), codes.join(","));
  assert.ok(codes.includes("OUTBOUND_PERMANENT_FAILURES"));
  for (const a of report.alerts) {
    assert.deepEqual(Object.keys(a).sort(), ["code", "severity", "threshold", "value"]);
  }
  const calm = evaluateAlerts(sanitizeHealth({}));
  assert.deepEqual(calm, []);
  // Phase 6: odmietnutia iba za 24 h; podiel ≥ 20 % pri ≥ 3 prípadoch = kritický alert
  const rate = evaluateAlerts(sanitizeHealth({ outbound: { rejected: 50, failed: 50 } }, { sent_24h: 2, delivered_24h: 1, rejected_24h: 2, failed_24h: 1 }));
  assert.deepEqual(rate.map((a) => a.code).sort(), ["OUTBOUND_PERMANENT_FAILURES", "OUTBOUND_REJECT_RATE_HIGH"]);
  const old = evaluateAlerts(sanitizeHealth({ outbound: { rejected: 50, failed: 50 } }, { sent_24h: 40 }));
  assert.deepEqual(old, [], "staré (kumulatívne) odmietnutia samy nealertujú");
  const low = evaluateAlerts(sanitizeHealth({}, { sent_24h: 100, rejected_24h: 3 }));
  assert.deepEqual(low.map((a) => a.code), ["OUTBOUND_PERMANENT_FAILURES"], "3/103 < 20 % → iba warning");
  const exhausted = evaluateAlerts(sanitizeHealth({ outbound: { retry_exhausted_unknown: 2, unknown_send_outcome: 2 }, inbound: { ack_pending_too_long: 1 } }));
  assert.deepEqual(exhausted.map((a) => a.code).sort(), ["INBOUND_ACK_PENDING_TOO_LONG", "OUTBOUND_RETRY_EXHAUSTED_UNKNOWN", "OUTBOUND_UNKNOWN_SEND_OUTCOME"]);
});

await check("konzistencia storage (iba čítanie): riadok bez objektu a objekt bez referencie sa spočítajú, nič sa nemaže", async () => {
  const anyOut = (await sql<{ p: string }>("select ubl_storage_path p from public.einvoice_outbound where ubl_storage_path is not null limit 1")).rows[0].p;
  await sql("insert into storage.objects (bucket_id, name) values ('einvoice-documents', $1), ('einvoice-documents', 'orphan/x.xml')", [anyOut]);
  const r = await opsStore.storageConsistency();
  assert.equal(r.objects_total, 2);
  assert.equal(r.objects_without_reference, 1);
  assert.ok(r.outbound_rows_missing_object >= 1);
  const still = (await sql<{ n: number }>("select count(*)::int n from storage.objects where bucket_id = 'einvoice-documents'")).rows[0].n;
  assert.equal(still, 2);
});

// =============================================================================
// ZRUŠENIE NÁROKU einvoice
// =============================================================================
await check("po zrušení nároku: história + UBL/XML download + dôkaz ostávajú; nové send/retry/reprocess blokované; server dokončí reconcile a ACK", async () => {
  // rozbehnuté veci pred zrušením
  const sent = await freshQueued();
  provider.sendScript = ["ok"];
  await sendOnly(sent.outboundId);
  const subId = (await outboundOf(sent.outboundId)).provider_submission_id as string;
  const pendingInvoice = await invoice(U.owner, CA, PARTNER_A);
  provider.ackErrors = [new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", "u", true)];
  const pendingAck = await receive("rcv-cancel", inboundXml("FA-CANCEL-1"));
  assert.equal(pendingAck.processing_status, "ack_pending");
  const rejectedQ = await freshQueued();
  provider.sendScript = ["reject"];
  await sendOnly(rejectedQ.outboundId);

  await expireTrialAndSuspend(CA, true);

  // história čitateľná podľa finance práv
  for (const uid of [U.owner, U.acc, U.adminView]) {
    const n = (await as(uid, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"))).rows[0].n;
    assert.ok(n > 0, uid);
  }
  // download už existujúcich dokumentov
  const ubl = await downloadStoredDocument({ userDb: userDb(U.acc), getObject: (p) => store.getUbl(p) }, "outbound", sent.outboundId);
  assert.ok(ubl.ok, JSON.stringify(ubl));
  if (ubl.ok) assert.equal(ubl.sha256, (await outboundOf(sent.outboundId)).ubl_sha256);
  const xml = await downloadStoredDocument({ userDb: userDb(U.owner), getObject: (p) => inboundStore.getXml(p) }, "inbound", pendingAck.id as string);
  assert.ok(xml.ok);
  const denied = await downloadStoredDocument({ userDb: userDb(U.emp), getObject: (p) => store.getUbl(p) }, "outbound", sent.outboundId);
  assert.deepEqual(denied, { ok: false, status: 404, code: "NOT_FOUND" });
  const foreign = await downloadStoredDocument({ userDb: userDb(U.b), getObject: (p) => store.getUbl(p) }, "outbound", sent.outboundId);
  assert.equal(foreign.ok, false);

  // nové operácie blokované
  const send = await requestAs(U.owner, pendingInvoice);
  assert.equal(send.status, 403);
  assert.equal(send.body.code, "EINVOICE_ENTITLEMENT_REQUIRED");
  const retry = await op(U.owner, "outbound", rejectedQ.outboundId, "outbound_retry");
  assert.equal(retry.status, 403);
  // server dokončí rozbehnutý transport
  provider.status.set(subId, "delivered");
  provider.evidence.set(subId, { invoice_id: subId, document_id: "as4-1", ubl_sha256: (await outboundOf(sent.outboundId)).ubl_sha256, delivery_status: { state: "delivered", at: "2026-10-02T08:00:00Z" } });
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  const delivered = await outboundOf(sent.outboundId);
  assert.equal(delivered.state, "delivered");
  const evidence = await as(U.acc, () => db.query<Row>("select evidence from public.einvoice_outbound where id = $1", [sent.outboundId]));
  assert.ok(evidence.rows[0].evidence, "dôkaz čitateľný");
  const ack = await op(U.owner, "inbound", pendingAck.id as string, "inbound_ack_retry");
  assert.equal(ack.body.state, "acknowledged");
  await expireTrialAndSuspend(CA, false);
});

await check("routes: operátor bez tokenu → 401; download bez tokenu → 401; maintenance bez CRON_SECRET → 401", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key";
  const ctx = { params: Promise.resolve({ id: UNKNOWN.outboundId }) };
  for (const mod of ["../app/api/einvoice/outbound/[id]/retry/route.ts", "../app/api/einvoice/outbound/[id]/reconcile/route.ts", "../app/api/einvoice/inbound/[id]/reprocess/route.ts", "../app/api/einvoice/inbound/[id]/ack-retry/route.ts"]) {
    const route = await import(mod);
    const res = await route.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ confirm_action: true }) }), ctx);
    assert.equal(res.status, 401, mod);
  }
  for (const mod of ["../app/api/einvoice/outbound/[id]/ubl/route.ts", "../app/api/einvoice/inbound/[id]/xml/route.ts"]) {
    const route = await import(mod);
    assert.equal((await route.GET(new Request("http://localhost/x"), ctx)).status, 401, mod);
  }
  const cron = await import("../app/api/cron/einvoice-maintenance/route.ts");
  assert.equal((await cron.GET(new Request("http://localhost/x"))).status, 401);
  for (const f of ["lib/einvoice/ops/actions.ts", "lib/einvoice/ops/routes.ts", "lib/einvoice/ops/maintenance.ts", "lib/einvoice/ops/download.ts", "lib/einvoice/ops/supabase-store.ts", "app/api/cron/einvoice-maintenance/route.ts"]) {
    assert.match(read(f), /^import "server-only";/, f);
    assert.doesNotMatch(read(f), /console\.(log|info|warn|error|debug)/, f);
  }
});

console.log(`\neinvoice-ops: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
