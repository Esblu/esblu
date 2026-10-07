// =============================================================================
// E-Faktúra — Phase 2 OUTBOUND: request → readiness → nemenné UBL → príjemca →
// preflight → queued → worker (claim / send / retry) → reconciliation → dôkaz.
//
// SKUTOČNÝ PostgreSQL (PGlite) so všetkými fakturačnými migráciami, nárokmi a
// migráciami E-Faktúry (vrátane 20261002120000_einvoice_outbound_flow).
// Poskytovateľ je SKRIPTOVANÝ fake (žiadna sieť, žiadne kľúče, nič live).
// Orchestrácia (lib/einvoice/outbound/request.ts) beží so skutočnou readiness
// pod RLS používateľa; privilegovaná vrstva volá tie isté serverové RPC ako
// produkčný supabase-store.ts.
//
// SPUSTENIE: npm run test:einvoice-outbound   (PGlite: npm i --no-save @electric-sql/pglite@0.5.8)
// =============================================================================

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestOutboundForInvoice } from "../lib/einvoice/outbound/request.ts";
import { handleOutboundSendRequest } from "../lib/einvoice/outbound/route-handler.ts";
import { parseOutboundRequestBody } from "../lib/einvoice/outbound/request-body.ts";
import { runOutboundReconcileBatch, runOutboundSendBatch } from "../lib/einvoice/outbound/worker.ts";
import { backoffMs, classifySendError, MAX_SEND_ATTEMPTS, planAfterError } from "../lib/einvoice/outbound/policy.ts";
import { dbErrorCode, OutboundStoreError, outboundUblPath, type OutboundRow, type OutboundStore } from "../lib/einvoice/outbound/store.ts";
import { sanitizeDeliveryEvidence, EVIDENCE_TOP_LEVEL_KEYS } from "../lib/einvoice/evidence.ts";
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
import { loadFinalizedIssuedInvoiceSnapshot } from "../lib/einvoice/load-finalized-invoice.ts";

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
  "20261008100009_taxed_advance_deduction_lines.sql",
  "20261008100010_received_advance_match_safeupdate.sql",
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
let storageWrites = 0;
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
    storageWrites++;
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
const provider = new FakeProvider();
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
const eventsOf = async (id: string) =>
  (await sql<Row>("select from_state, to_state, source, provider_code from public.einvoice_events where outbound_id = $1 order by created_at, id", [id])).rows;
/** Testovací posun času: riadok je hneď retry-ready (iba superuser test, aplikácia to nevie). */
const makeDue = (id: string) => sql("update public.einvoice_outbound set next_retry_at = now() - interval '1 second' where id = $1", [id]);
const expireLease = (id: string) => sql("update public.einvoice_outbound set locked_until = now() - interval '1 second', next_retry_at = now() - interval '1 second' where id = $1", [id]);
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
// Politika (čistá)
// =============================================================================
await check("politika: backoff 1m, 2m, 4m, 8m … strop 6 h; max 8 pokusov", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n) / 60_000), [1, 2, 4, 8, 16, 32, 64, 128]);
  assert.equal(backoffMs(20), 6 * 60 * 60 * 1000);
  assert.equal(MAX_SEND_ATTEMPTS, 8);
});

await check("politika: 429 / 5xx / sieť / timeout = retry (5xx/sieť/timeout neistý výsledok); 4xx = reject/fail; konflikt = hold", () => {
  const c = (code: string, retryable = false) => classifySendError(new EinvoiceProviderError(code, code, retryable));
  assert.deepEqual(c("EINVOICE_PROVIDER_RATE_LIMITED", true), { kind: "retry", code: "EINVOICE_PROVIDER_RATE_LIMITED", outcomeUnknown: false });
  for (const code of ["EINVOICE_PROVIDER_UNAVAILABLE", "EINVOICE_PROVIDER_TIMEOUT", "EINVOICE_PROVIDER_NETWORK"]) {
    assert.deepEqual(c(code, true), { kind: "retry", code, outcomeUnknown: true });
  }
  assert.equal(c("EINVOICE_PROVIDER_REJECTED").kind, "reject");
  for (const code of ["EINVOICE_PROVIDER_FORBIDDEN", "EINVOICE_PROVIDER_UNAUTHORIZED", "EINVOICE_PROVIDER_INSUFFICIENT_CREDIT", "EINVOICE_UBL_HASH_MISMATCH"]) {
    assert.equal(c(code).kind, "fail", code);
  }
  assert.equal(c("EINVOICE_PROVIDER_CONFLICT").kind, "hold");
  assert.deepEqual(classifySendError(new Error("bug")), { kind: "retry", code: "EINVOICE_INTERNAL_ERROR", outcomeUnknown: true });
  // „fail" po predchádzajúcom neistom pokuse sa NEuzatvára (mohlo by dôjsť k zdvojeniu novým pokusom)
  assert.equal(planAfterError({ disposition: { kind: "fail", code: "X" }, attemptsMade: 2, priorOutcomeUnknown: true, now: new Date() }).action, "hold");
});

await check("telo požiadavky: iba invoice_id + confirm_send=true; company_id/environment/role/participant = 400", () => {
  const inv = "f0000000-0000-4000-8000-000000000001";
  assert.deepEqual(parseOutboundRequestBody({ invoice_id: inv, confirm_send: true }), { ok: true, invoiceId: inv });
  assert.deepEqual(parseOutboundRequestBody({ invoice_id: inv }), { ok: false, code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(parseOutboundRequestBody({ invoice_id: inv, confirm_send: "true" }), { ok: false, code: "CONFIRMATION_REQUIRED" });
  for (const extra of ["company_id", "environment", "role", "receiver_participant_id", "provider", "api_key"]) {
    assert.deepEqual(parseOutboundRequestBody({ invoice_id: inv, confirm_send: true, [extra]: "x" }), { ok: false, code: "UNEXPECTED_FIELDS" }, extra);
  }
  assert.deepEqual(parseOutboundRequestBody({ invoice_id: "nope", confirm_send: true }), { ok: false, code: "INVALID_INVOICE_ID" });
  assert.deepEqual(parseOutboundRequestBody(null), { ok: false, code: "INVALID_BODY" });
});

await check("route: bez Bearer tokenu → 401 UNAUTHENTICATED (nič sa nečíta ani neposiela)", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key";
  const route = await import("../app/api/einvoice/outbound/route.ts");
  const res = await route.POST(new Request("http://localhost/api/einvoice/outbound", { method: "POST", body: JSON.stringify({ invoice_id: CA, confirm_send: true }) }));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { code: "UNAUTHENTICATED" });
  const cron = await import("../app/api/cron/einvoice-outbound/route.ts");
  const c = await cron.GET(new Request("http://localhost/api/cron/einvoice-outbound"));
  assert.equal(c.status, 401);
});

await check("grant: nové RPC iba service_role; stará verzia (uuid, uuid, text) neexistuje", async () => {
  const { rows } = await sql<Row>(
    `select p.proname f, pg_get_function_identity_arguments(p.oid) args,
            has_function_privilege('authenticated', p.oid, 'execute') auth,
            has_function_privilege('anon', p.oid, 'execute') anon,
            has_function_privilege('service_role', p.oid, 'execute') srv
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('esblu_einvoice_request_outbound', 'esblu_einvoice_claim_outbound', 'esblu_einvoice_outbound_transition')`
  );
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.auth, false, String(r.f));
    assert.equal(r.anon, false, String(r.f));
    assert.equal(r.srv, true, String(r.f));
  }
  assert.ok(!rows.some((r) => r.args === "p_actor_user_id uuid, p_invoice_id uuid, p_environment text"));
});

// =============================================================================
// Požiadavka (route orchestrácia)
// =============================================================================
const INV = await invoice(U.owner, CA, PARTNER_A);

await check("unauthorized: anon / používateľ bez členstva → odmietnuté bez volania poskytovateľa", async () => {
  provider.calls = [];
  const anon = await requestAs(null, INV);
  assert.ok([401, 403, 500].includes(anon.status), String(anon.status));
  assert.notEqual(anon.body.code, "QUEUED");
  const stranger = "30000000-0000-4000-8000-0000000000ff";
  await sql("insert into auth.users (id) values ($1) on conflict do nothing", [stranger]);
  const r = await requestAs(stranger, INV);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "NO_ACTIVE_COMPANY");
  assert.deepEqual(provider.calls, []);
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound");
  assert.equal(rows[0].n, 0);
});

await check("finance.manage chýba: admin bez financií / employee → FORBIDDEN; admin iba view → FINANCE_MANAGE_REQUIRED", async () => {
  provider.calls = [];
  for (const uid of [U.admin, U.emp]) {
    const r = await requestAs(uid, INV);
    assert.equal(r.status, 403, uid);
    assert.equal(r.body.code, "FORBIDDEN", uid);
  }
  const view = await requestAs(U.adminView, INV);
  assert.equal(view.status, 403);
  assert.equal(view.body.code, "FINANCE_MANAGE_REQUIRED");
  assert.deepEqual(provider.calls, []);
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound");
  assert.equal(rows[0].n, 0);
});

const INV_B = await invoice(U.b, CB, PARTNER_B);

await check("nárok chýba: firma bez einvoice → 403 EINVOICE_ENTITLEMENT_REQUIRED; aj priame RPC → ENTITLEMENT_DENIED", async () => {
  provider.calls = [];
  const r = await requestAs(U.b, INV_B);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "EINVOICE_ENTITLEMENT_REQUIRED");
  assert.deepEqual(provider.calls, []);
  const msg = await errorOf(() => store.requestOutbound({
    actorUserId: U.b, invoiceId: INV_B, environment: "sandbox", ublSha256: "a".repeat(64),
    ublStoragePath: outboundUblPath(CB, INV_B, "a".repeat(64)), ublSizeBytes: 10, receiverParticipantId: "9915:2050000000",
  }));
  assert.match(msg, /ENTITLEMENT_DENIED:ENTITLEMENT_REQUIRED:einvoice/);
});

await check("cross-tenant: owner B nevidí ani neodošle faktúru firmy A (404)", async () => {
  provider.calls = [];
  const r = await requestAs(U.b, INV);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "NOT_FOUND");
  assert.deepEqual(provider.calls, []);
});

await check("readiness fail: koncept → 409; chýbajúca referencia → 422 READINESS_FAILED; poskytovateľ sa nevolá", async () => {
  provider.calls = [];
  const draft = await invoice(U.owner, CA, PARTNER_A, HEADER, false);
  const d = await requestAs(U.owner, draft);
  assert.equal(d.status, 409);
  assert.equal(d.body.code, "INVOICE_NOT_FINALIZED");
  const bad = await invoice(U.owner, CA, PARTNER_A, { ...HEADER, buyer_reference: null, purchase_order_reference: null });
  const r = await requestAs(U.owner, bad);
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "READINESS_FAILED");
  assert.ok(r.body.readiness!.issues.some((i) => i.code === "MISSING_BUYER_OR_ORDER_REFERENCE"));
  assert.deepEqual(provider.calls, []);
  assert.equal(storageWrites, 0);
});

await check("BR-61: kód úhrady 30 bez IBAN dodávateľa → 422 READINESS_FAILED/BANK_TRANSFER_IBAN_MISSING PRED poskytovateľom", async () => {
  provider.calls = [];
  const writesBefore = storageWrites;
  await sql("update public.company_billing_profile set iban = null where company_id = $1", [CA]);
  try {
    const id = await invoice(U.owner, CA, PARTNER_A); // HEADER: payment_means_code 30
    const r = await requestAs(U.owner, id);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, "READINESS_FAILED");
    const issue = r.body.readiness!.issues.find((i) => i.code === "BANK_TRANSFER_IBAN_MISSING");
    assert.ok(issue, JSON.stringify(r.body.readiness!.issues.map((i) => i.code)));
    assert.equal(issue!.rule, "BR-61 (BT-84)");
    assert.deepEqual(provider.calls, [], "žiadny recipient lookup ani preflight");
    assert.equal(storageWrites, writesBefore);
    assert.equal((await sql<Row>("select count(*)::int as n from public.einvoice_outbound where invoice_id = $1", [id])).rows[0].n, 0);
  } finally {
    await sql("update public.company_billing_profile set iban = 'SK3112000000198742637541' where company_id = $1", [CA]);
  }
});

await check("príjemca nenájdený / lookup nedostupný → 422 / 503, nič sa neuloží ani nezaradí", async () => {
  const other = await invoice(U.owner, CA, PARTNER_A);
  provider.knownRecipients.delete(BUYER);
  const r = await requestAs(U.owner, other);
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "RECIPIENT_NOT_FOUND");
  provider.lookupUnavailable = true;
  const u = await requestAs(U.owner, other);
  assert.equal(u.status, 503);
  assert.equal(u.body.code, "RECIPIENT_LOOKUP_UNAVAILABLE");
  provider.lookupUnavailable = false;
  provider.knownRecipients.add(BUYER);
  assert.ok(!provider.calls.includes("preflight"));
  assert.equal(storageWrites, 0);
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound where invoice_id = $1", [other]);
  assert.equal(rows[0].n, 0);
});

await check("preflight fail → 422 PREFLIGHT_FAILED so strojovými kódmi (bez textu poskytovateľa), nič sa nezaradí", async () => {
  const other = await invoice(U.owner, CA, PARTNER_A);
  provider.preflightResult = { sendReady: false, validatorUnavailable: false, issues: [{ code: "BR-CO-15", message: "Secret detail <script>", severity: "error", field: "cbc:PayableAmount" }] };
  const r = await requestAs(U.owner, other);
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "PREFLIGHT_FAILED");
  assert.deepEqual(r.body.issues, [{ code: "BR-CO-15", severity: "error", field: "cbc:PayableAmount" }]);
  assert.ok(!JSON.stringify(r.body).includes("Secret detail"));
  provider.preflightResult = { sendReady: false, validatorUnavailable: true, issues: [] };
  assert.equal((await requestAs(U.owner, other)).body.code, "PREFLIGHT_UNAVAILABLE");
  provider.preflightResult = { sendReady: true, validatorUnavailable: false, issues: [] };
  assert.equal(storageWrites, 0);
});

let OUT = "";
let KEY = "";
let SHA = "";
await check("úspešné zaradenie: 202 QUEUED, nemenné UBL v storage (presné bajty + SHA), overený príjemca, žiadne odoslanie", async () => {
  provider.calls = [];
  const r = await requestAs(U.owner, INV);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.code, "QUEUED");
  assert.equal(r.body.outbound!.state, "queued");
  assert.equal(r.body.readiness!.ready, true);
  assert.deepEqual(provider.calls, ["verifyRecipient", "preflight"]);
  OUT = r.body.outbound!.id;
  const row = await outboundOf(OUT);
  SHA = row.ubl_sha256 as string;
  KEY = row.idempotency_key as string;
  const loaded = await loadFinalizedIssuedInvoiceSnapshot(userDb(U.owner) as never, INV, CA);
  assert.ok(loaded.ok);
  const ubl = generateUbl((loaded as { ok: true; snapshot: Parameters<typeof generateUbl>[0] }).snapshot);
  assert.ok(ubl.ok);
  assert.equal(SHA, (ubl as { sha256: string }).sha256);
  assert.equal(row.ubl_storage_path, `${CA}/outbound/${INV}/${SHA}.xml`);
  assert.equal(row.ubl_size_bytes, (ubl as { bytes: Uint8Array }).bytes.byteLength);
  assert.ok(row.ubl_generated_at);
  assert.equal(row.receiver_participant_id, BUYER);
  assert.ok(row.receiver_verified_at);
  assert.equal(row.state, "queued");
  assert.equal(row.retry_count, 0);
  const stored = storage.get(row.ubl_storage_path as string)!;
  assert.equal(createHash("sha256").update(stored).digest("hex"), SHA);
  assert.equal(KEY, `esblu-out-${INV.replace(/-/g, "")}-1-${SHA.slice(0, 16)}`);
  // Odpoveď neobsahuje nič zo servera navyše (žiadne kľúče, cesty, ID organizácie).
  assert.deepEqual(Object.keys(r.body).sort(), ["code", "outbound", "readiness"]);
  assert.doesNotMatch(JSON.stringify(r.body), /org-a-synthetic|efk_|outbound\/|idempotency/);
});

await check("dvojklik: druhá požiadavka → 200 ALREADY_REQUESTED, ten istý riadok, žiadny nový dokument ani volanie poskytovateľa", async () => {
  provider.calls = [];
  const writes = storageWrites;
  const r = await requestAs(U.owner, INV);
  assert.equal(r.status, 200);
  assert.equal(r.body.code, "ALREADY_REQUESTED");
  assert.equal(r.body.outbound!.id, OUT);
  assert.deepEqual(provider.calls, []);
  assert.equal(storageWrites, writes);
  const acc = await requestAs(U.acc, INV);
  assert.equal(acc.body.outbound!.id, OUT);
  const { rows } = await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound where invoice_id = $1", [INV]);
  assert.equal(rows[0].n, 1);
});

await check("súbežná požiadavka (bez pred-kontroly) → RPC vráti ten istý pokus (created=false), rovnaká hranica idempotencie", async () => {
  const again = await store.requestOutbound({
    actorUserId: U.adminFin, invoiceId: INV, environment: "sandbox", ublSha256: SHA,
    ublStoragePath: outboundUblPath(CA, INV, SHA), ublSizeBytes: storage.get(outboundUblPath(CA, INV, SHA))!.byteLength, receiverParticipantId: BUYER,
  });
  assert.equal(again.outboundId, OUT);
  assert.equal(again.created, false);
  assert.equal(again.idempotencyKey, KEY);
  // Rovnaká faktúra = rovnaké bajty = rovnaký objekt (cesta adresovaná obsahom), nikdy prepísaný.
  assert.equal(await store.putUbl(outboundUblPath(CA, INV, SHA), new Uint8Array([1, 2, 3])), "exists");
  assert.equal(createHash("sha256").update(storage.get(outboundUblPath(CA, INV, SHA))!).digest("hex"), SHA);
});

await check("RPC obrana: podvrhnutý príjemca, cesta mimo firmy alebo zlý hash sú odmietnuté", async () => {
  const other = await invoice(U.owner, CA, PARTNER_A);
  const base = { actorUserId: U.owner, invoiceId: other, environment: "sandbox" as const, ublSha256: "b".repeat(64), ublStoragePath: outboundUblPath(CA, other, "b".repeat(64)), ublSizeBytes: 100, receiverParticipantId: BUYER };
  assert.match(await errorOf(() => store.requestOutbound({ ...base, receiverParticipantId: "9915:9999999999" })), /ESBLU_EINVOICE_RECEIVER_MISMATCH/);
  assert.match(await errorOf(() => store.requestOutbound({ ...base, ublStoragePath: outboundUblPath(CB, other, "b".repeat(64)) })), /ESBLU_EINVOICE_UBL_PATH_INVALID/);
  assert.match(await errorOf(() => store.requestOutbound({ ...base, ublSha256: "XYZ" })), /ESBLU_EINVOICE_UBL_HASH_INVALID/);
  assert.match(await errorOf(() => store.requestOutbound({ ...base, ublSizeBytes: 0 })), /ESBLU_EINVOICE_UBL_SIZE_INVALID/);
});

await check("udalosti: zaradenie = presne 1 einvoice_event (null→queued, user) + 1 invoice_events einvoice_send_requested", async () => {
  assert.deepEqual(await eventsOf(OUT), [{ from_state: null, to_state: "queued", source: "user", provider_code: null }]);
  const { rows } = await sql<Row>("select event_type, actor_user_id, actor_source from public.invoice_events where invoice_id = $1 and event_type like 'einvoice_%'", [INV]);
  assert.deepEqual(rows, [{ event_type: "einvoice_send_requested", actor_user_id: U.owner, actor_source: "user" }]);
});

// =============================================================================
// Worker: claim / send / retry
// =============================================================================
await check("claim: riadok → sending, retry_count 1, lease, in_flight; ten istý riadok sa druhýkrát nezoberie", async () => {
  await sql("update public.einvoice_outbound set next_retry_at = now() + interval '1 day' where id <> $1 and provider_submission_id is null and next_retry_at is not null", [OUT]);
  const first = await store.claim("send", 10, 120);
  assert.deepEqual(first.map((r) => r.id), [OUT]);
  assert.equal(first[0].state, "sending");
  assert.equal(first[0].retry_count, 1);
  assert.equal(first[0].send_in_flight, true);
  assert.ok(first[0].locked_until);
  const second = await store.claim("send", 10, 120);
  assert.deepEqual(second, []);
  // aj keď je riadok „splatný", aktívny lease ho chráni pred druhým workerom
  await makeDue(OUT);
  assert.deepEqual(await store.claim("send", 10, 120), []);
  assert.match(read("supabase/migrations/20261002120000_einvoice_outbound_flow.sql"), /for update skip locked/);
  assert.deepEqual((await eventsOf(OUT)).map((e) => `${e.from_state}->${e.to_state}:${e.source}`), ["null->queued:user", "queued->sending:job"]);
});

await check("pád workera: lease vyprší s in_flight → ďalší claim označí výsledok ako NEISTÝ a zopakuje TEN ISTÝ kľúč", async () => {
  await expireLease(OUT);
  const again = await store.claim("send", 10, 120);
  assert.deepEqual(again.map((r) => r.id), [OUT]);
  assert.equal(again[0].retry_count, 2);
  assert.equal(again[0].send_outcome_unknown, true);
  // vrátiť do stavu pre ďalšie testy (iba test)
  await sql("update public.einvoice_outbound set locked_until = null, send_in_flight = false, next_retry_at = now() - interval '1 second' where id = $1", [OUT]);
});

await check("timeout → NIE failed: ostáva sending, neistý výsledok, retry o 4 min (3. pokus), ten istý kľúč", async () => {
  provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true)];
  const report = await sendOnly(OUT);
  assert.equal(report.claimed, 1);
  const row = await outboundOf(OUT);
  assert.equal(row.state, "sending");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_TIMEOUT");
  assert.equal(row.send_outcome_unknown, true);
  assert.equal(row.send_in_flight, false);
  assert.equal(row.retry_count, 3);
  const delay = new Date(row.next_retry_at as string).getTime() - Date.now();
  assert.ok(delay > 3 * 60_000 && delay <= 4 * 60_000 + 5_000, String(delay));
  assert.deepEqual(provider.sendKeys, [KEY]);
});

await check("retry s tým istým kľúčom: úspech → sent s ID poskytovateľa; kľúč aj bajty pri všetkých pokusoch zhodné", async () => {
  await makeDue(OUT);
  await sendOnly(OUT);
  const row = await outboundOf(OUT);
  assert.equal(row.state, "sent");
  assert.ok(row.provider_submission_id);
  assert.ok(row.sent_at);
  assert.equal(row.last_error_code, null);
  assert.equal(row.next_retry_at, null);
  assert.equal(row.locked_until, null);
  assert.deepEqual(provider.sendKeys, [KEY, KEY]);
  assert.deepEqual(provider.sendShas, [SHA, SHA]);
  // sent sa už neposiela znovu
  provider.calls = [];
  await runOutboundSendBatch(workerDeps(), WOPTS);
  assert.ok(!provider.calls.includes("sendUbl") || provider.sendKeys.filter((k) => k === KEY).length === 2);
  assert.match(await errorOf(() => sql("update public.einvoice_outbound set provider_submission_id = 'other' where id = $1", [OUT])), /IDENTITY_IMMUTABLE/);
});

await check("udalosti bez duplicít: každá zmena stavu = 1 einvoice_event; provider_code; invoice_events einvoice_sent raz", async () => {
  const ev = (await eventsOf(OUT)).map((e) => `${e.from_state}->${e.to_state}:${e.source}:${e.provider_code ?? ""}`);
  assert.deepEqual(ev, ["null->queued:user:", "queued->sending:job:", "sending->sent:provider:queued"]);
  const { rows } = await sql<Row>("select event_type from public.invoice_events where invoice_id = $1 and event_type like 'einvoice_%' order by created_at", [INV]);
  assert.deepEqual(rows.map((r) => r.event_type), ["einvoice_send_requested", "einvoice_sent"]);
});

await check("429 → retry s backoffom 1m, potom 2m; výsledok je istý (neprijaté), kľúč zhodný", async () => {
  const { outboundId } = await freshQueued();
  provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", "r", true), new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", "r", true)];
  const before = provider.sendKeys.length;
  await sendOnly(outboundId);
  let row = await outboundOf(outboundId);
  assert.equal(row.state, "sending");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_RATE_LIMITED");
  assert.equal(row.send_outcome_unknown, false);
  let delay = new Date(row.next_retry_at as string).getTime() - Date.now();
  assert.ok(delay > 50_000 && delay <= 65_000, String(delay));
  await makeDue(outboundId);
  await sendOnly(outboundId);
  row = await outboundOf(outboundId);
  delay = new Date(row.next_retry_at as string).getTime() - Date.now();
  assert.ok(delay > 110_000 && delay <= 125_000, String(delay));
  const keys = provider.sendKeys.slice(before);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], row.idempotency_key);
});

await check("5xx → retry, výsledok NEISTÝ (send_outcome_unknown)", async () => {
  const { outboundId } = await freshQueued();
  provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", "u", true)];
  await sendOnly(outboundId);
  const row = await outboundOf(outboundId);
  assert.equal(row.state, "sending");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_UNAVAILABLE");
  assert.equal(row.send_outcome_unknown, true);
});

await check("permanentná 4xx: odmietnutý obsah → rejected; 403 → failed; obe terminálne, s kódom", async () => {
  const a = await freshQueued();
  provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_REJECTED", "bad", false)];
  await sendOnly(a.outboundId);
  let row = await outboundOf(a.outboundId);
  assert.equal(row.state, "rejected");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_REJECTED");
  const b = await freshQueued();
  provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_FORBIDDEN", "no", false)];
  await sendOnly(b.outboundId);
  row = await outboundOf(b.outboundId);
  assert.equal(row.state, "failed");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_FORBIDDEN");
  const c = await freshQueued();
  provider.sendScript = ["reject"];
  await sendOnly(c.outboundId);
  row = await outboundOf(c.outboundId);
  assert.equal(row.state, "rejected");
  assert.equal(row.reject_reason, "validation_failed");
  // Phase 6: bežné „Odoslať" po terminálnom stave NEvytvorí nový pokus — iba operátorská akcia.
  provider.calls = [];
  const plain = await requestAs(U.owner, c.invoiceId);
  assert.equal(plain.status, 409);
  assert.equal(plain.body.code, "RETRY_REQUIRES_OPERATOR_ACTION");
  assert.deepEqual(provider.calls, []);
  // po terminálnom stave smie vzniknúť NOVÝ pokus (nový kľúč) iba ručnou operátorskou požiadavkou
  const again = await requestOutboundForInvoice(
    { userDb: userDb(U.owner), store, runtime: { provider, environment: "sandbox" }, env: ENV },
    { userId: U.owner, invoiceId: c.invoiceId, allowNewAttempt: true, confirmation: "operator_confirm_action" }
  );
  assert.equal(again.status, 202);
  const second = await outboundOf(again.body.outbound!.id);
  assert.equal(second.attempt, 2);
  assert.notEqual(second.idempotency_key, row.idempotency_key);
});

await check("max pokusov: 8× 429 → failed EINVOICE_RETRY_EXHAUSTED; 9. claim neexistuje", async () => {
  const { outboundId } = await freshQueued();
  for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
    provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", "r", true)];
    await makeDue(outboundId);
    await sendOnly(outboundId);
  }
  const row = await outboundOf(outboundId);
  assert.equal(row.retry_count, 8);
  assert.equal(row.state, "failed");
  assert.equal(row.last_error_code, "EINVOICE_RETRY_EXHAUSTED");
  provider.sendScript = [];
});

await check("max pokusov s neistým výsledkom (timeouty) → NIE failed: sending, EXHAUSTED_UNKNOWN, bez plánovania; nový pokus sa nevytvorí", async () => {
  const { invoiceId, outboundId } = await freshQueued();
  for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
    provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true)];
    await makeDue(outboundId);
    await sendOnly(outboundId);
  }
  const row = await outboundOf(outboundId);
  assert.equal(row.state, "sending");
  assert.equal(row.last_error_code, "EINVOICE_RETRY_EXHAUSTED_UNKNOWN");
  assert.equal(row.next_retry_at, null);
  assert.equal(row.send_outcome_unknown, true);
  assert.deepEqual(await store.claim("send", 10, 120), []);
  const again = await requestAs(U.owner, invoiceId);
  assert.equal(again.body.code, "ALREADY_REQUESTED");
  assert.equal(again.body.outbound!.id, outboundId);
  // ani DB nedovolí neisté → isté
  assert.match(await errorOf(() => sql("update public.einvoice_outbound set send_outcome_unknown = false where id = $1", [outboundId])), /OUTCOME_UNKNOWN_STICKY/);
});

await check("hash mismatch: zmenené bajty v storage → NEodošle sa, failed EINVOICE_UBL_HASH_MISMATCH", async () => {
  const { outboundId } = await freshQueued();
  const row = await outboundOf(outboundId);
  const p = row.ubl_storage_path as string;
  const tampered = new Uint8Array(storage.get(p)!);
  tampered[tampered.length - 2] = 0x20;
  storage.set(p, tampered);
  const sendsBefore = provider.sendKeys.length;
  await sendOnly(outboundId);
  const after = await outboundOf(outboundId);
  assert.equal(after.state, "failed");
  assert.equal(after.last_error_code, "EINVOICE_UBL_HASH_MISMATCH");
  assert.equal(provider.sendKeys.length, sendsBefore, "sendUbl sa nesmel zavolať");
});

await check("staged/validated bez ID (neočakávané) → neistý výsledok, opakovanie tým istým kľúčom", async () => {
  const { outboundId } = await freshQueued();
  provider.sendScript = ["staged"];
  await sendOnly(outboundId);
  const row = await outboundOf(outboundId);
  assert.equal(row.state, "sending");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_UNEXPECTED_RESULT");
  assert.equal(row.send_outcome_unknown, true);
});

// =============================================================================
// Reconciliation + dôkaz doručenia
// =============================================================================
await check("reconciliation: poskytovateľ SENT → ostáva sent (provider_status), bez novej udalosti; DEFERRED → deferred", async () => {
  const subId = (await outboundOf(OUT)).provider_submission_id as string;
  provider.status.set(subId, "sent");
  const eventsBefore = (await eventsOf(OUT)).length;
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  let row = await outboundOf(OUT);
  assert.equal(row.state, "sent");
  assert.equal(row.provider_status, "sent");
  assert.ok(row.status_checked_at);
  assert.equal((await eventsOf(OUT)).length, eventsBefore);
  provider.status.set(subId, "deferred");
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  row = await outboundOf(OUT);
  assert.equal(row.state, "deferred");
  assert.equal((await eventsOf(OUT)).at(-1)!.source, "reconcile");
});

await check("reconciliation: DELIVERED bez dôkazu → čaká (EVIDENCE_PENDING); s dôkazom → delivered + iba allowlist dôkazu", async () => {
  const subId = (await outboundOf(OUT)).provider_submission_id as string;
  provider.status.set(subId, "delivered");
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  let row = await outboundOf(OUT);
  assert.equal(row.state, "deferred");
  assert.equal(row.last_error_code, "EINVOICE_EVIDENCE_PENDING");
  provider.evidenceBody.set(subId, {
    invoice_id: subId, document_id: "as4-doc-1", ubl_sha256: SHA,
    delivery_status: { state: "delivered", at: "2026-10-01T10:00:05Z" },
    headers: { authorization: "Bearer secret-token" }, raw_response: "{…}", layers: { as4: "<Envelope/>" },
    transactions: [{ message_id: "as4-msg-1", status: "DELIVERED", at: "2026-10-01T10:00:04Z", receiver_participant_id: BUYER, payload: "PD94" }],
  });
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  row = await outboundOf(OUT);
  assert.equal(row.state, "delivered");
  assert.equal(row.delivered_at !== null, true);
  assert.equal(row.document_id, "as4-doc-1");
  const evidence = row.evidence as Row;
  assert.deepEqual(Object.keys(evidence).sort(), [...EVIDENCE_TOP_LEVEL_KEYS].sort());
  assert.equal(evidence.ubl_sha256, SHA);
  const text = JSON.stringify(evidence);
  for (const forbidden of ["secret-token", "raw_response", "Envelope", "PD94", "headers"]) assert.ok(!text.includes(forbidden), forbidden);
  const { rows } = await sql<Row>("select event_type from public.invoice_events where invoice_id = $1 and event_type like 'einvoice_%' order by created_at", [INV]);
  assert.deepEqual(rows.map((r) => r.event_type), ["einvoice_send_requested", "einvoice_sent", "einvoice_delivered"]);
  // terminálne — ďalšia reconciliation ho už neberie
  const report = await runOutboundReconcileBatch(workerDeps(), WOPTS);
  assert.ok(!report.results.some((r) => r.outboundId === OUT));
});

await check("reconciliation: dôkaz s iným hashom než uložené UBL → NIE delivered (EVIDENCE_HASH_MISMATCH)", async () => {
  const { outboundId } = await freshQueued();
  provider.sendScript = ["ok"];
  await sendOnly(outboundId);
  const subId = (await outboundOf(outboundId)).provider_submission_id as string;
  provider.status.set(subId, "delivered");
  provider.evidenceBody.set(subId, { invoice_id: subId, document_id: "x", ubl_sha256: "f".repeat(64), delivery_status: { state: "delivered", at: "2026-10-01T10:00:05Z" } });
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  const row = await outboundOf(outboundId);
  assert.equal(row.state, "sent");
  assert.equal(row.last_error_code, "EINVOICE_EVIDENCE_HASH_MISMATCH");
  assert.equal(row.evidence, null);
});

await check("reconciliation: poskytovateľ potvrdí ERROR → failed (transport); timeout pri dotaze stav nemení", async () => {
  const { outboundId } = await freshQueued();
  provider.sendScript = ["ok"];
  await sendOnly(outboundId);
  const subId = (await outboundOf(outboundId)).provider_submission_id as string;
  provider.statusError = new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true);
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  let row = await outboundOf(outboundId);
  assert.equal(row.state, "sent");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_TIMEOUT");
  provider.statusError = null;
  provider.status.set(subId, "failed");
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  row = await outboundOf(outboundId);
  assert.equal(row.state, "failed");
  assert.equal(row.last_error_code, "EINVOICE_PROVIDER_TRANSPORT_ERROR");
});

await check("reconciliation: pád workera na 8. pokuse (bez ID) → EXHAUSTED_UNKNOWN, nič neodoslané ani uzavreté", async () => {
  const crash = await freshQueued();
  await sql("update public.einvoice_outbound set retry_count = 7 where id = $1", [crash.outboundId]);
  await sql("update public.einvoice_outbound set next_retry_at = now() + interval '1 day' where id <> $1 and provider_submission_id is null and next_retry_at is not null", [crash.outboundId]);
  const claimed = await store.claim("send", 10, 120);
  assert.deepEqual(claimed.map((r) => r.id), [crash.outboundId]);
  await expireLease(crash.outboundId); // worker spadol, nič nezapísal
  const sends = provider.sendKeys.length;
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  const row = await outboundOf(crash.outboundId);
  assert.equal(row.state, "sending");
  assert.equal(row.retry_count, 8);
  assert.equal(row.last_error_code, "EINVOICE_RETRY_EXHAUSTED_UNKNOWN");
  assert.equal(row.send_outcome_unknown, true);
  assert.equal(row.next_retry_at, null);
  assert.equal(provider.sendKeys.length, sends);
});

await check("transition RPC: neplatný prechod, neznáme pole, zdroj 'user' a zastaraný stav sú odmietnuté", async () => {
  const { outboundId } = await freshQueued();
  assert.match(await errorOf(() => store.transition(outboundId, "queued", "delivered", "job", null, {})), /ESBLU_EINVOICE_INVALID_TRANSITION|ESBLU_EINVOICE_PROVIDER_ID_REQUIRED|DB_ERROR/);
  assert.match(await errorOf(() => store.transition(outboundId, "queued", null, "job", null, { retry_count: 0 } as never)), /ESBLU_EINVOICE_TRANSITION_FIELDS_INVALID/);
  assert.match(await errorOf(() => store.transition(outboundId, "queued", null, "user" as never, null, {})), /ESBLU_EINVOICE_TRANSITION_SOURCE_INVALID/);
  assert.match(await errorOf(() => store.transition(outboundId, "sent", null, "job", null, {})), /ESBLU_EINVOICE_OUTBOUND_STALE/);
  assert.match(await errorOf(() => store.transition(outboundId, "queued", null, "job", null, { evidence: { raw: {} } as never })), /DB_ERROR|check/);
});

await check("klient (aj owner) nemôže meniť outbound ani volať worker RPC; čítanie podľa finance práv", async () => {
  for (const q of [
    ["update public.einvoice_outbound set state = 'delivered' where id = $1", [OUT]],
    ["select public.esblu_einvoice_claim_outbound('send', 10, 120, 0)", []],
    ["select public.esblu_einvoice_outbound_transition($1, 'delivered', 'failed', 'job', null, '{}'::jsonb)", [OUT]],
  ] as const) {
    const msg = await errorOf(() => as(U.owner, () => db.query(q[0], [...q[1]])));
    const { rows } = await sql<{ s: string }>("select state s from public.einvoice_outbound where id = $1", [OUT]);
    assert.equal(rows[0].s, "delivered", `${q[0]} → ${msg}`);
  }
  const visible = await as(U.acc, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"));
  assert.ok(visible.rows[0].n > 0);
  const hidden = await as(U.emp, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"));
  assert.equal(hidden.rows[0].n, 0);
  const foreign = await as(U.b, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"));
  assert.equal(foreign.rows[0].n, 0);
});

// =============================================================================
// Phase 6: rollout allowlist (fail-closed), nárok vo workeri, termín behu
// =============================================================================
await check("rollout: firma bez povolenia → 403 ROLLOUT_NOT_ENABLED PRED volaním poskytovateľa; DB trigger odmietne aj priame RPC", async () => {
  await sql("delete from public.einvoice_rollout where company_id = $1", [CA]);
  try {
    const invoiceId = await invoice(U.owner, CA, PARTNER_A);
    provider.calls = [];
    const r = await requestAs(U.owner, invoiceId);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "ROLLOUT_NOT_ENABLED");
    assert.deepEqual(provider.calls, [], "žiadny lookup, preflight ani send");
    const msg = await errorOf(() => store.requestOutbound({
      actorUserId: U.owner, invoiceId, environment: "sandbox", ublSha256: "b".repeat(64),
      ublStoragePath: outboundUblPath(CA, invoiceId, "b".repeat(64)), ublSizeBytes: 10, receiverParticipantId: BUYER,
    }));
    assert.match(msg, /ESBLU_EINVOICE_ROLLOUT_NOT_ENABLED/);
  } finally {
    await sql("insert into public.einvoice_rollout (company_id, environment, stage, changed_by) values ($1, 'sandbox', 'internal', 'test')", [CA]);
  }
});

await check("rollout: povolené iba sandbox — live prostredie ostáva zamietnuté (iné prostredie = iný záznam)", async () => {
  const allowed = (await sql<{ a: boolean; b: boolean }>("select public.esblu_einvoice_rollout_allowed($1, 'sandbox') a, public.esblu_einvoice_rollout_allowed($1, 'live') b", [CA])).rows[0];
  assert.deepEqual(allowed, { a: true, b: false });
});

await check("kill switch: stage paused → worker NEODOŠLE zaradený riadok (ostáva queued, bez in_flight); po obnovení odošle", async () => {
  const { outboundId } = await freshQueued();
  await sql("update public.einvoice_rollout set stage = 'paused' where company_id = $1", [CA]);
  try {
    provider.calls = [];
    const r = await sendOnly(outboundId);
    assert.equal(r.claimed, 0);
    const row = await outboundOf(outboundId);
    assert.equal(row.state, "queued");
    assert.equal(row.send_in_flight, false);
    assert.ok(!provider.calls.some((c) => c.startsWith("sendUbl")));
  } finally {
    await sql("update public.einvoice_rollout set stage = 'internal' where company_id = $1", [CA]);
  }
  provider.sendScript = ["ok"];
  await sendOnly(outboundId);
  assert.equal((await outboundOf(outboundId)).state, "sent");
});

await check("strata nároku: zaradený (ešte neodoslaný) riadok sa NEODOŠLE; riadok s neistým výsledkom zopakuje TEN ISTÝ kľúč", async () => {
  const fresh = await freshQueued();
  const unknown = await freshQueued();
  // neistý výsledok: prvý pokus timeout
  provider.sendScript = [new EinvoiceProviderError("EINVOICE_PROVIDER_TIMEOUT", "t", true)];
  await sendOnly(unknown.outboundId);
  const before = await outboundOf(unknown.outboundId);
  assert.equal(before.send_outcome_unknown, true);
  await sql("update public.company_entitlements set status = 'revoked' where company_id = $1 and entitlement_key = 'einvoice'", [CA]);
  try {
    await makeDue(fresh.outboundId);
    provider.calls = [];
    const r1 = await sendOnly(fresh.outboundId);
    assert.equal(r1.claimed, 0, "bez nároku sa nové odoslanie nespustí");
    assert.equal((await outboundOf(fresh.outboundId)).state, "queued");
    await makeDue(unknown.outboundId);
    provider.sendScript = ["ok"];
    const r2 = await sendOnly(unknown.outboundId);
    assert.equal(r2.claimed, 1, "neistý výsledok sa dorieši replayom toho istého kľúča");
    const after = await outboundOf(unknown.outboundId);
    assert.equal(after.idempotency_key, before.idempotency_key);
    assert.equal(after.state, "sent");
  } finally {
    await sql("update public.company_entitlements set status = 'active' where company_id = $1 and entitlement_key = 'einvoice'", [CA]);
  }
  provider.sendScript = ["ok"];
  await makeDue(fresh.outboundId);
  await sendOnly(fresh.outboundId);
  assert.equal((await outboundOf(fresh.outboundId)).state, "sent");
});

await check("termín behu: ak by sa riadok nestihol, NECLAIMNE sa (žiadny falošný in_flight / neistý výsledok)", async () => {
  const { outboundId } = await freshQueued();
  await sql("update public.einvoice_outbound set next_retry_at = now() + interval '1 day' where id <> $1 and state in ('queued','sending') and provider_submission_id is null and next_retry_at is not null", [outboundId]);
  const r = await runOutboundSendBatch(workerDeps(), { ...WOPTS, deadlineMs: Date.now() + 1_000, itemBudgetMs: 25_000 });
  assert.equal(r.claimed, 0);
  const row = await outboundOf(outboundId);
  assert.equal(row.state, "queued");
  assert.equal(row.send_in_flight, false);
  assert.equal(row.retry_count, 0);
  provider.sendScript = ["ok"];
  await sendOnly(outboundId);
  assert.equal((await outboundOf(outboundId)).state, "sent");
});

// =============================================================================
// Phase 6 (L2 forenzika): route cesta, potvrdenie, UUID kontrakt, nemenný snapshot
// =============================================================================
const routeDeps = (uid: string | null) => ({
  authenticate: async () => (uid ? { userId: uid } : null),
  userDbFor: () => userDb(uid),
  store: () => store,
  runtime: () => ({ provider, environment: "sandbox" as const }),
  env: ENV,
});
const post = (body: unknown, token = "test-token") =>
  new Request("http://localhost/api/einvoice/outbound", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const outboundCount = async () => (await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound")).rows[0].n;

await check("reconciliation (reálny vzor eFaktura.sk): status SENT + dôkaz delivery_status=delivered → delivered; dôkaz pending/rejected → ostáva sent", async () => {
  const { invoiceId, outboundId } = await freshQueued();
  provider.sendScript = ["ok"];
  await sendOnly(outboundId);
  const row0 = await outboundOf(outboundId);
  assert.equal(row0.state, "sent");
  const subId = row0.provider_submission_id as string;
  const sha = row0.ubl_sha256 as string;
  provider.status.set(subId, "sent");
  provider.evidenceBody.set(subId, { invoice_id: subId, document_id: "d1", ubl_sha256: sha, delivery_status: { state: "pending" }, transactions: [] });
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  assert.equal((await outboundOf(outboundId)).state, "sent", "pending dôkaz nie je doručenie");
  provider.evidenceBody.set(subId, { invoice_id: subId, document_id: "d1", ubl_sha256: sha, delivery_status: { state: "rejected" }, transactions: [] });
  await sql("update public.einvoice_outbound set updated_at = now() - interval '1 hour' where id = $1", [outboundId]);
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  assert.equal((await outboundOf(outboundId)).state, "sent", "MLS rejected → stav sa NEMENÍ na delivered");
  provider.evidenceBody.set(subId, { invoice_id: subId, document_id: "d1", ubl_sha256: sha, delivery_status: { state: "delivered", at: "2026-10-02T10:00:00Z" }, transactions: [{ state: "SENT" }] });
  await sql("update public.einvoice_outbound set updated_at = now() - interval '1 hour' where id = $1", [outboundId]);
  await runOutboundReconcileBatch(workerDeps(), WOPTS);
  const row = await outboundOf(outboundId);
  assert.equal(row.state, "delivered");
  assert.ok(row.delivered_at);
  assert.ok(invoiceId);
});

await check("route handler: bez presného confirm_send:true → 400, žiadny verify/preflight/queue/send", async () => {
  const inv = await invoice(U.owner, CA, PARTNER_A);
  const before = await outboundCount();
  for (const body of [
    { invoice_id: inv },
    { invoice_id: inv, confirm_send: "true" },
    { invoice_id: inv, confirm_send: 1 },
    { invoice_id: inv, confirm_send: false },
    { invoice_id: inv, confirm_send: true, company_id: CB },
    { invoice_id: "", confirm_send: true },
    "nie-json",
  ]) {
    provider.calls = [];
    const r = await handleOutboundSendRequest(post(body), routeDeps(U.owner));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(provider.calls, [], `poskytovateľ volaný pre ${JSON.stringify(body)}`);
  }
  assert.equal(await outboundCount(), before, "nevznikol žiadny pokus");
  const noAuth = await handleOutboundSendRequest(post({ invoice_id: inv, confirm_send: true }), routeDeps(null));
  assert.equal(noAuth.status, 401);
  const ok = await handleOutboundSendRequest(post({ invoice_id: inv, confirm_send: true }), routeDeps(U.owner));
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(await outboundCount(), before + 1);
});

await check("orchestrácia: bez výslovného potvrdenia v kontrakte → 400 CONFIRMATION_REQUIRED; \"\" ako UUID → 400 (nikdy DB chyba)", async () => {
  const inv = await invoice(U.owner, CA, PARTNER_A);
  provider.calls = [];
  const deps = { userDb: userDb(U.owner), store, runtime: { provider, environment: "sandbox" as const }, env: ENV };
  const missing = await requestOutboundForInvoice(deps, { userId: U.owner, invoiceId: inv } as unknown as Parameters<typeof requestOutboundForInvoice>[1]);
  assert.deepEqual([missing.status, missing.body.code], [400, "CONFIRMATION_REQUIRED"]);
  const empty = await requestOutboundForInvoice(deps, { userId: U.owner, invoiceId: "", confirmation: "user_confirm_send" });
  assert.deepEqual([empty.status, empty.body.code], [400, "INVALID_INVOICE_ID"]);
  assert.deepEqual(provider.calls, []);
});

await check("nemenný snapshot: po finalizácii owner (RLS) zmení 0 riadkov, service_role (trigger) je odmietnutý; snapshot aj UBL bajtovo rovnaké", async () => {
  const inv = await invoice(U.owner, CA, PARTNER_A);
  const ublOf = async () => {
    const loaded = await loadFinalizedIssuedInvoiceSnapshot(userDb(U.owner), inv, CA);
    assert.ok(loaded.ok);
    if (!loaded.ok) throw new Error("snapshot");
    const u = generateUbl(loaded.snapshot);
    assert.ok(u.ok);
    if (!u.ok) throw new Error("ubl");
    return { snap: createHash("sha256").update(JSON.stringify(loaded.snapshot)).digest("hex"), ubl: u.sha256 };
  };
  const before = await ublOf();
  const items = await as(U.owner, () => db.query<{ id: string }>("update public.invoice_items set unit_price = 99, description = 'zmenené' where invoice_id = $1 returning id", [inv]));
  assert.equal(items.rows.length, 0, "RLS: finalizované položky sa nedajú meniť (0 riadkov, bez chyby)");
  const header = await as(U.owner, () => db.query<{ id: string }>("update public.invoices set issue_date = '2020-01-01' where id = $1 returning id", [inv]).catch((e: Error) => ({ rows: [], error: e.message })));
  assert.equal(header.rows.length, 0);
  assert.match(await errorOf(() => asService(() => db.query("update public.invoice_items set unit_price = 99 where invoice_id = $1", [inv]))), /.+/, "trigger blokuje aj service_role");
  assert.match(await errorOf(() => asService(() => db.query("update public.invoice_parties set legal_name = 'X' where invoice_id = $1", [inv]))), /.+/);
  const after = await ublOf();
  assert.deepEqual(after, before, "snapshot a UBL bajtovo rovnaké");
});

await check("service_role iba v privilegovanej vrstve: supabase-store.ts; route/worker/orchestrácia ho priamo nedržia", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    }
    return out;
  };
  const files = [...walk("lib/einvoice"), ...walk("app/api/einvoice"), ...walk("app/api/cron/einvoice-outbound"), ...walk("app/api/cron/einvoice-maintenance")];
  const admin = files.filter((f) => /supabase-admin|getSupabaseAdmin|SUPABASE_SERVICE_ROLE_KEY/.test(read(f)));
  // app/api/einvoice/staging-e2e: STAGING-ONLY driver (hard guard → 404 mimo preview einvoice-port so staging DB);
  // staging-e2e/guard.ts iba overuje ref v SUPABASE_SERVICE_ROLE_KEY (nevytvára klienta).
  assert.deepEqual(admin.sort(), ["app/api/einvoice/staging-e2e/route.ts", "lib/einvoice/inbound/supabase-store.ts", "lib/einvoice/onboarding-supabase-store.ts", "lib/einvoice/ops/supabase-store.ts", "lib/einvoice/outbound/supabase-store.ts", "lib/einvoice/staging-e2e/guard.ts"]);
  for (const f of files.filter((x) => x.startsWith("app/") || /(outbound|inbound)\/(worker|request|supabase-store|processor|webhook)\.ts$/.test(x))) {
    assert.match(read(f), /^import "server-only";/, f);
  }
  // Route nikdy priamo neposiela — iba orchestrácia požiadavky (bez sendUbl).
  assert.doesNotMatch(read("lib/einvoice/outbound/request.ts"), /sendUbl/);
  assert.doesNotMatch(read("app/api/einvoice/outbound/route.ts"), /sendUbl|runOutboundSendBatch/);
});

console.log(`\neinvoice-outbound: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
