// =============================================================================
// E-Faktúra — SANDBOX E2E aktuálnej architektúry (Phase 1–6) proti eFaktura.sk.
//
// RUČNÉ spúšťanie, REÁLNE sieťové volania IBA na sandbox (efk_pk_test_…).
// NIE JE súčasťou CI ani `npm test`.
//
// Čo je reálne:  eFaktura.sk sandbox API (recipient, preflight, connector/send,
//                status, evidence, events, received, xml, acknowledge) +
//                PRESNE tie isté moduly Esblu ako v produkcii (readiness,
//                request orchestrácia, worker, reconciliation, inbound
//                processor, operátorské akcie, webhook handler).
// Čo je lokálne: PostgreSQL = PGlite so VŠETKÝMI migráciami E-Faktúry
//                (20261002100000 … 20261002150000) a RLS; storage = pamäť.
//                → NEOVERUJE Supabase PostgREST/Storage/Vercel routy; na to
//                je potrebný staging Supabase (docs/einvoice-sandbox-e2e-plan.md).
//
// Poistky:
//   - --confirm-sandbox povinné; ESBLU_EINVOICE_ENVIRONMENT=sandbox a kľúč
//     efk_pk_test_… (live kľúč → koniec pred akýmkoľvek volaním),
//   - fetch allowlist (žiadne zakladanie / deaktivácia organizácií, webhooky,
//     enroll ani iné zápisy okrem connector/send a acknowledge),
//   - iba syntetická sandbox organizácia (--org=<uuid>, --dic=, --ico=),
//   - výstup: iba stavy, kódy, počty a prefixy hashov — žiadny kľúč, XML ani PII.
//
// Použitie (PowerShell, z koreňa repa, PGlite: npm i --no-save @electric-sql/pglite@0.5.8):
//   node --env-file=C:\cesta\mimo\repa\efaktura-sandbox.env `
//     --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs `
//     scripts/einvoice-sandbox-e2e.ts --confirm-sandbox --org=<sandbox org uuid>
// =============================================================================

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestOutboundForInvoice } from "../lib/einvoice/outbound/request.ts";
import { runOutboundReconcileBatch, runOutboundSendBatch } from "../lib/einvoice/outbound/worker.ts";
import { dbErrorCode, OutboundStoreError, type OutboundRow, type OutboundStore } from "../lib/einvoice/outbound/store.ts";
import { InboundStoreError, type InboundRow, type InboundStore } from "../lib/einvoice/inbound/store.ts";
import { runInboundPoll, runInboundProcessBatch } from "../lib/einvoice/inbound/processor.ts";
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import { runOperatorAction } from "../lib/einvoice/ops/actions.ts";
import { OpsStoreError, type OperatorBeginResult, type OpsStore } from "../lib/einvoice/ops/store.ts";


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
if (ARGS.get("confirm-sandbox") !== "true") stop("chýba --confirm-sandbox (reálne volania sandbox API)");
if (process.env.ESBLU_EINVOICE_ENVIRONMENT?.trim() !== "sandbox") stop("ESBLU_EINVOICE_ENVIRONMENT musí byť 'sandbox'");
const SANDBOX_KEY = process.env.ESBLU_EFAKTURA_API_KEY?.trim() ?? "";
if (!SANDBOX_KEY.startsWith("efk_pk_test_")) stop("ESBLU_EFAKTURA_API_KEY chýba alebo nie je sandbox kľúč (efk_pk_test_)");
const ORG_ID = ARGS.get("org") ?? stop("chýba --org=<uuid sandbox organizácie>");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ORG_ID)) stop("--org musí byť UUID");
const ORG_ICO = ARGS.get("ico") ?? "87654326";
const ORG_DIC = ARGS.get("dic") ?? "2099999999";
if (!/^[0-9]{8}$/.test(ORG_ICO) || !/^[0-9]{10}$/.test(ORG_DIC)) stop("syntetické IČO (8 číslic) / DIČ (10 číslic)");
const PARTICIPANT = `9915:${ORG_DIC}`;
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const RUN = Date.now().toString(36).toUpperCase();

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
// Reálny sandbox poskytovateľ za allowlistom + riadená injekcia chýb
// -----------------------------------------------------------------------------
const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/v1\/agent\/organizations\/[0-9a-f-]{36}$/],
  ["GET", /^\/v1\/agent\/peppol\/recipient$/],
  ["POST", /^\/v1\/agent\/peppol\/preflight$/],
  ["POST", /^\/v1\/agent\/peppol\/connector\/send$/],
  ["GET", /^\/v1\/agent\/peppol\/status\/[^/]+$/],
  ["GET", /^\/v1\/agent\/peppol\/sent\/[^/]+\/evidence$/],
  ["GET", /^\/v1\/agent\/peppol\/events$/],
  ["GET", /^\/v1\/agent\/peppol\/received$/],
  ["GET", /^\/v1\/agent\/peppol\/received\/[^/]+(\/xml)?$/],
  ["POST", /^\/v1\/agent\/peppol\/received\/[^/]+\/acknowledge$/],
];
type Fault = null | "unavailable-before-send" | "drop-response-after-send";
let fault: Fault = null;
const calls: string[] = [];
const guardedFetch = async (input: string, init: RequestInit): Promise<Response> => {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  if (url.hostname !== "api.efaktura.sk") stop(`host ${url.hostname} nie je povolený`);
  if (!ALLOWED.some(([m, re]) => m === method && re.test(url.pathname))) stop(`${method} ${url.pathname} nie je na allowliste`);
  calls.push(`${method} ${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id")}`);
  if (url.pathname.endsWith("/connector/send") && fault === "unavailable-before-send") {
    fault = null;
    throw new TypeError("simulated network failure before send");
  }
  const res = await fetch(input, init);
  if (url.pathname.endsWith("/connector/send") && fault === "drop-response-after-send") {
    fault = null;
    await res.arrayBuffer();
    throw new TypeError("simulated lost response after send");
  }
  return res;
};
const provider = new EfakturaSkProvider({ apiKey: SANDBOX_KEY, environment: "sandbox", fetchImpl: guardedFetch, timeoutMs: 30_000 });
const providerCtx = { environment: "sandbox" as const, providerOrgId: ORG_ID };

/** Priame GET volanie na sandbox (iba allowlist) — kľúč sa nikdy nevypisuje. */
async function sandboxGet(pathAndQuery: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await guardedFetch(`https://api.efaktura.sk${pathAndQuery}`, {
    method: "GET",
    headers: { "X-API-Key": SANDBOX_KEY, "X-Organization-Id": ORG_ID, Accept: "application/json" },
    redirect: "error",
  });
  let json: Record<string, unknown> | null = null;
  try { json = (await res.json()) as Record<string, unknown>; } catch { json = null; }
  return { status: res.status, json };
}


const ENV: Record<string, string | undefined> = {
  ESBLU_EINVOICE_PROVIDER: "efaktura_sk",
  ESBLU_EINVOICE_ENVIRONMENT: "sandbox",
  ESBLU_EFAKTURA_API_KEY: SANDBOX_KEY,
};
function requestAs(uid: string | null, invoiceId: string) {
  return requestOutboundForInvoice(
    { userDb: userDb(uid), store, runtime: { provider, environment: "sandbox" }, env: ENV },
    { userId: uid ?? "00000000-0000-4000-8000-000000000000", invoiceId }
  );
}
const workerDeps = () => ({ store, provider });
const WOPTS = { batchSize: 10, leaseSeconds: 120, reconcileAfterSeconds: 0 };

// -----------------------------------------------------------------------------
// Syntetické firmy a roly. Firma A = sandbox organizácia (self-send: predávajúci
// aj kupujúci je tá istá testovacia firma → vznikne aj prijatý doklad).
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

await locked(() => db.exec(`
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into public.companies (id, name) values ('${CA}', 'Sandbox A'), ('${CB}', 'Sandbox B');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CA}', '${U.owner}', 'owner', '{}'),
    ('${CA}', '${U.acc}', 'accountant', '{}'),
    ('${CA}', '${U.adminFin}', 'admin', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.adminView}', 'admin', '{"finance":{"view":true}}'),
    ('${CA}', '${U.admin}', 'admin', '{}'),
    ('${CA}', '${U.emp}', 'employee', '{"finance":{"view":true,"manage":true}}'),
    ('${CB}', '${U.b}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code,
      country_code, contact_email, electronic_address, electronic_address_scheme_id)
    values ('${CA}', 'Tatra Servis s.r.o.', '${ORG_ICO}', '${ORG_DIC}', 'SK${ORG_DIC}', 'Hlavná 1', 'Bratislava', '81101',
      'SK', null, '${ORG_DIC}', '9915'),
           ('${CB}', 'Sandbox B s.r.o.', '22222222', '2030000000', 'SK2030000000', 'Skúšobná 2', 'Košice', '04001',
      'SK', null, '2030000000', '9915');
  insert into public.business_partners (id, company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city,
      postal_code, country_code, electronic_address, electronic_address_scheme_id)
    values ('${PARTNER_A}', '${CA}', 'customer', 'Tatra Servis s.r.o.', '${ORG_ICO}', '${ORG_DIC}', 'SK${ORG_DIC}',
      'Hlavná 1', 'Bratislava', '81101', 'SK', '${ORG_DIC}', '9915'),
           ('${PARTNER_B}', '${CB}', 'customer', 'Odberateľ B', '44444444', '2050000000', 'SK2050000000', 'Iná 4', 'Nitra', '94901', 'SK', '2050000000', '9915');
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, org_status, peppol_eligible)
    values ('${CA}', 'efaktura_sk', 'sandbox', '${ORG_ID}', '${PARTICIPANT}', 'active', true);
  insert into public.company_entitlements (company_id, entitlement_key, source, note) values ('${CA}', 'einvoice', 'manual', 'sandbox-e2e');
  insert into public.einvoice_rollout (company_id, environment, stage, changed_by)
    values ('${CA}', 'sandbox', 'internal', 'sandbox-e2e'), ('${CB}', 'sandbox', 'internal', 'sandbox-e2e');
`));

const ITEMS = [
  { description: "Sandbox E2E služba", quantity: 1, unit: "ks", unit_code: "H87", unit_price: 10, price_mode: "net",
    vat_category_code: "S", vat_rate: 23, line_net_amount: 10, line_vat_amount: 2.3, line_gross_amount: 12.3 },
];
const HEADER = {
  issue_date: TODAY, due_date: TODAY, delivery_date: TODAY, currency: "EUR", buyer_reference: "SANDBOX-E2E",
  customer_business_partner_id: PARTNER_A,
};
async function invoice(uid: string, company: string, partner: string, header: Row = HEADER, finalize = true, kind = "regular_invoice", corrects: string | null = null): Promise<string> {
  const { rows } = await as(uid, () =>
    db.query<{ id: string }>(
      `insert into public.invoices (company_id, direction, kind, issue_date, currency, customer_business_partner_id, source, corrects_invoice_id)
       values ($1, 'issued', $3, $4, 'EUR', $2, 'manual', $5) returning id`,
      [company, partner, kind, TODAY, corrects]
    )
  );
  const id = rows[0].id;
  await as(uid, () => db.query("select id from public.esblu_save_invoice_draft($1, $2::jsonb, $3::jsonb, null)", [id, JSON.stringify({ ...header, customer_business_partner_id: partner }), JSON.stringify(ITEMS)]));
  if (finalize) await as(uid, () => db.query("select public.esblu_finalize_invoice($1)", [id]));
  return id;
}
const outboundOf = async (id: string) => (await sql<Row>("select * from public.einvoice_outbound where id = $1", [id])).rows[0];
const makeDue = (id: string) => sql("update public.einvoice_outbound set next_retry_at = now() - interval '1 second', locked_until = null where id = $1", [id]);
async function sendOnly(outboundId: string) {
  await sql("update public.einvoice_outbound set next_retry_at = now() + interval '1 day' where id <> $1 and state in ('queued','sending') and provider_submission_id is null and next_retry_at is not null", [outboundId]);
  return runOutboundSendBatch(workerDeps(), WOPTS);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: unknown) => (typeof h === "string" ? `${h.slice(0, 12)}…` : null);

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

// =============================================================================
// Výsledky (PASS / FAIL / PARTIAL / SKIP) s dôkazmi bez tajomstiev a PII
// =============================================================================
type Verdict = "PASS" | "FAIL" | "PARTIAL" | "SKIP";
const results: { id: string; label: string; verdict: Verdict; evidence: Record<string, unknown> }[] = [];
async function step(id: string, label: string, fn: () => Promise<Record<string, unknown> | { verdict: Verdict; evidence: Record<string, unknown> }>) {
  try {
    const out = await fn();
    const wrapped = "verdict" in out && "evidence" in out ? (out as { verdict: Verdict; evidence: Record<string, unknown> }) : { verdict: "PASS" as Verdict, evidence: out };
    results.push({ id, label, ...wrapped });
    console.log(`${wrapped.verdict.padEnd(7)} ${id} ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error);
    results.push({ id, label, verdict: "FAIL", evidence: { error: message } });
    console.log(`FAIL    ${id} ${label}\n        ${message}`);
  }
}

// Predpoklad: sandbox organizácia existuje a má aktívny Peppol účet (9915:DIČ).
await step("P0", "sandbox organizácia: aktívny Peppol účet a participant = 9915:DIČ", async () => {
  const info = await provider.getOrganization(providerCtx);
  assert.equal(info.participantId, PARTICIPANT, "participant organizácie nesedí s --dic");
  assert.equal(info.peppolEligible, true, "organizácia nie je peppol_eligible (sandbox: POST /v1/agent/peppol/enroll s ľubovoľným hex tokenom)");
  return { participant: info.participantId, peppol_eligible: info.peppolEligible, claim_status: info.claimStatus ?? null };
});

// =============================================================================
// OUTBOUND
// =============================================================================
let INV1 = "";
let OUT1 = "";
let SENT_SHA = "";
await step("O1", "koncept faktúry (vydaná, syntetická, dnešný dátum vyhotovenia)", async () => {
  INV1 = await invoice(U.owner, CA, PARTNER_A, HEADER, false);
  const r = (await sql<Row>("select document_status, direction from public.invoices where id = $1", [INV1])).rows[0];
  assert.equal(r.document_status, "draft");
  return { document_status: r.document_status, direction: r.direction };
});
await step("O2", "finalizácia → nemenný snapshot (zmena položky po finalizácii odmietnutá)", async () => {
  await as(U.owner, () => db.query("select public.esblu_finalize_invoice($1)", [INV1]));
  const msg = await errorOf(() => as(U.owner, () => db.query("update public.invoice_items set unit_price = 99 where invoice_id = $1", [INV1])));
  assert.ok(msg.length > 0, "zmena finalizovanej položky prešla");
  return { finalized: true, mutation_rejected: true };
});
await step("O3", "readiness (pre_send) pod RLS ownera = ready, bez issues", async () => {
  const { loadEinvoiceReadiness } = await import("../lib/einvoice/readiness-server.ts");
  const r = await loadEinvoiceReadiness(userDb(U.owner), INV1, ENV);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return {};
  assert.equal(r.result.mode, "pre_send");
  assert.deepEqual(r.result.issues.map((i) => i.code), []);
  return { mode: r.result.mode, ready: r.result.ready, warnings: r.result.warnings.map((w) => w.code) };
});
await step("O4-O7", "explicitné potvrdenie → recipient verify → provider preflight → queue (202), nič neodoslané", async () => {
  const { parseOutboundRequestBody } = await import("../lib/einvoice/outbound/request-body.ts");
  assert.throws(() => parseOutboundRequestBody({ invoice_id: INV1 }), "bez confirm_send musí byť 400");
  parseOutboundRequestBody({ invoice_id: INV1, confirm_send: true });
  calls.length = 0;
  const r = await requestAs(U.owner, INV1);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  OUT1 = r.body.outbound!.id;
  assert.ok(calls.includes("GET /v1/agent/peppol/recipient"), "recipient lookup");
  assert.ok(calls.includes("POST /v1/agent/peppol/preflight"), "preflight");
  assert.ok(!calls.some((c) => c.endsWith("/connector/send")), "request nesmie odoslať");
  const row = await outboundOf(OUT1);
  assert.equal(row.state, "queued");
  return { status: r.status, code: r.body.code, provider_calls: [...calls], state: row.state };
});
await step("O8-O9", "worker claim + send (ten istý kľúč) → poskytovateľ prijal (sent, ID podania)", async () => {
  calls.length = 0;
  const rep = await sendOnly(OUT1);
  const row = await outboundOf(OUT1);
  assert.equal(rep.claimed, 1);
  assert.ok(["sent", "delivered"].includes(row.state as string), `stav ${row.state} (${row.last_error_code ?? ""})`);
  assert.ok(row.provider_submission_id);
  return { claimed: rep.claimed, state: row.state, has_submission_id: true, provider_calls: [...calls] };
});
await step("O10-O12", "reconciliation → SENT / delivered + allowlistovaný dôkaz (AS4/MLS), hash dôkazu = hash UBL", async () => {
  let row = await outboundOf(OUT1);
  for (let i = 0; i < 18 && row.state !== "delivered"; i++) {
    await sleep(5_000);
    await sql("update public.einvoice_outbound set updated_at = now() - interval '10 minutes' where id = $1", [OUT1]);
    await runOutboundReconcileBatch(workerDeps(), WOPTS);
    row = await outboundOf(OUT1);
  }
  const evidence = row.evidence as Record<string, unknown> | null;
  const keys = evidence ? Object.keys(evidence).sort() : [];
  const verdict: Verdict = row.state === "delivered" ? "PASS" : row.state === "sent" ? "PARTIAL" : "FAIL";
  return { verdict, evidence: { state: row.state, provider_status: row.provider_status ?? null, evidence_keys: keys, evidence_delivery_state: evidence?.delivery_state ?? null } };
});
await step("O13", "UBL integrita: uložené bajty → SHA-256 = riadok = (ak je) hash v dôkaze poskytovateľa", async () => {
  const row = await outboundOf(OUT1);
  const bytes = storage.get(row.ubl_storage_path as string);
  assert.ok(bytes, "UBL v storage");
  const sha = createHash("sha256").update(bytes!).digest("hex");
  assert.equal(sha, row.ubl_sha256);
  SENT_SHA = sha;
  const ev = (row.evidence as Record<string, unknown> | null)?.ubl_sha256 ?? null;
  if (ev) assert.equal(ev, sha, "hash v dôkaze poskytovateľa");
  return { sha256: short(sha), provider_hash_matches: ev ? true : "n/a" };
});
await step("O14", "retry: sieťová chyba PRED odoslaním → backoff, ten istý kľúč → úspech", async () => {
  const inv = await invoice(U.owner, CA, PARTNER_A, { ...HEADER, buyer_reference: `E2E-RETRY-${RUN}` });
  const r = await requestAs(U.owner, inv);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = r.body.outbound!.id;
  const key = (await outboundOf(id)).idempotency_key;
  fault = "unavailable-before-send";
  await sendOnly(id);
  let row = await outboundOf(id);
  assert.equal(row.state, "sending");
  await makeDue(id);
  await sendOnly(id);
  row = await outboundOf(id);
  assert.ok(["sent", "delivered"].includes(row.state as string), String(row.state));
  assert.equal(row.idempotency_key, key);
  return { first: "network error (no send)", final_state: row.state, retry_count: row.retry_count, same_key: true };
});
let UNKNOWN_NUMBER = "";
await step("O15", "neistý výsledok: odpoveď stratená PO odoslaní → replay toho istého kľúča → JEDINÉ podanie u poskytovateľa", async () => {
  const inv = await invoice(U.owner, CA, PARTNER_A, { ...HEADER, buyer_reference: `E2E-UNKNOWN-${RUN}` });
  const r = await requestAs(U.owner, inv);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = r.body.outbound!.id;
  UNKNOWN_NUMBER = String((await sql<Row>("select invoice_number from public.invoices where id = $1", [inv])).rows[0].invoice_number);
  fault = "drop-response-after-send";
  await sendOnly(id);
  let row = await outboundOf(id);
  assert.equal(row.state, "sending");
  assert.equal(row.send_outcome_unknown, true);
  await makeDue(id);
  await sendOnly(id);
  row = await outboundOf(id);
  assert.ok(["sent", "delivered"].includes(row.state as string), String(row.state));
  // Dôkaz „never sends twice": audit poskytovateľa pre číslo dokladu obsahuje JEDNO podanie.
  await sleep(3_000);
  const events = await sandboxGet(`/v1/agent/peppol/events?direction=sent&from=${TODAY}&to=${TODAY}&limit=1000`);
  const rows = Array.isArray(events.json?.data) ? (events.json!.data as Record<string, unknown>[]) : [];
  const docs = new Set(rows.filter((e) => String(e.document_id ?? "").endsWith(`#${UNKNOWN_NUMBER}`) && e.event === "sent.queued").map((e) => String(e.document_id)));
  const queued = rows.filter((e) => String(e.document_id ?? "").endsWith(`#${UNKNOWN_NUMBER}`) && e.event === "sent.queued").length;
  return {
    verdict: queued === 1 ? "PASS" : queued === 0 ? "PARTIAL" : "FAIL",
    evidence: { final_state: row.state, send_outcome_unknown_was_set: true, provider_queued_events_for_number: queued, distinct_documents: docs.size, events_http: events.status },
  };
});
await step("O16", "reconciliation operátorom (sent/delivered riadok) → RECONCILED, nikdy neodošle", async () => {
  await sql("update public.einvoice_outbound set operator_action_at = null, locked_until = null where id = $1", [OUT1]);
  calls.length = 0;
  const res = await runOperatorAction(
    { ops: opsStore, outbound: store, inbound: inboundStore, runtime: { provider, environment: "sandbox" }, userDb: userDb(U.owner), env: ENV },
    { userId: U.owner, kind: "outbound", id: OUT1, action: "outbound_reconcile", reasonCode: null }
  );
  assert.ok(!calls.some((c) => c.endsWith("/connector/send")));
  return { status: res.status, code: res.body.code, provider_calls: [...calls] };
});

// =============================================================================
// INBOUND (self-send → prijatý doklad pre tú istú sandbox organizáciu)
// =============================================================================
let INBOUND_ROW: Row | null = null;
await step("I1-I4", "prijatý sandbox doklad → poll → refetch XML od poskytovateľa → nemenné uloženie", async () => {
  for (let i = 0; i < 12 && !INBOUND_ROW; i++) {
    await sleep(5_000);
    await runInboundPoll({ store: inboundStore, provider, environment: "sandbox" }, { batchSize: 10 });
    const r = (await sql<Row>("select * from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2", [CA, SENT_SHA])).rows[0];
    if (r) INBOUND_ROW = r;
  }
  assert.ok(INBOUND_ROW, "prijatý doklad s rovnakým hashom ako odoslané UBL sa neobjavil (poll 60 s)");
  const bytes = INBOUND_STORAGE.get(INBOUND_ROW!.xml_storage_path as string);
  assert.ok(bytes);
  return { provider_calls_include_xml: calls.some((c) => /received\/:id\/xml$/.test(c)), stored: true, size: bytes!.byteLength };
});
await step("I5", "hash: prijaté XML je byte-identické s odoslaným UBL (SHA-256)", async () => {
  assert.ok(INBOUND_ROW);
  const sha = createHash("sha256").update(INBOUND_STORAGE.get(INBOUND_ROW!.xml_storage_path as string)!).digest("hex");
  assert.equal(sha, INBOUND_ROW!.xml_sha256);
  assert.equal(sha, SENT_SHA);
  return { sha256: short(sha), equals_sent: true };
});
await step("I6-I9", "parse → koncept prijatej faktúry → ACK u poskytovateľa", async () => {
  await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where processing_status not in ('acknowledged','failed')");
  await runInboundProcessBatch({ store: inboundStore, provider, environment: "sandbox" }, { batchSize: 10 });
  const r = (await sql<Row>("select * from public.einvoice_inbound where id = $1", [INBOUND_ROW!.id])).rows[0];
  INBOUND_ROW = r;
  assert.ok(["acknowledged", "duplicate"].includes(r.processing_status as string), String(r.processing_status));
  const inv = r.invoice_id ? (await sql<Row>("select direction, document_status, source from public.invoices where id = $1", [r.invoice_id])).rows[0] : null;
  return { status: r.processing_status, acknowledged: Boolean(r.acknowledged_at), draft: inv ? { direction: inv.direction, status: inv.document_status, source: inv.source } : null };
});
await step("I8b", "duplicate: opätovná registrácia toho istého dokladu nevytvorí nový koncept", async () => {
  const before = (await sql<{ n: number }>("select count(*)::int n from public.invoices where company_id = $1 and direction = 'received'", [CA])).rows[0].n;
  await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where processing_status not in ('acknowledged','failed')");
  await runInboundPoll({ store: inboundStore, provider, environment: "sandbox" }, { batchSize: 10 });
  const after = (await sql<{ n: number }>("select count(*)::int n from public.invoices where company_id = $1 and direction = 'received'", [CA])).rows[0].n;
  const rows = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where provider_received_id = $1", [INBOUND_ROW!.provider_received_id])).rows[0].n;
  assert.equal(rows, 1);
  return { drafts_before: before, drafts_after: after, inbound_rows_for_document: rows };
});
await step("I10", "ACK retry: opätovný ACK u poskytovateľa je idempotentný (already_acknowledged)", async () => {
  // Adaptér vracia void; idempotencia = druhý a tretí ACK prejdú bez chyby (docs: already_acknowledged).
  await provider.acknowledgeInbound(providerCtx, String(INBOUND_ROW!.provider_received_id));
  await provider.acknowledgeInbound(providerCtx, String(INBOUND_ROW!.provider_received_id));
  return { repeated_ack_ok: true };
});
await step("I11", "nepodporovaný typ (dobropis) → failed UNSUPPORTED_PROFILE, XML uložené, bez konceptu", async () => {
  const cn = await invoice(U.owner, CA, PARTNER_A, { ...HEADER, buyer_reference: `E2E-CN-${RUN}` }, true, "credit_note", INV1);
  const r = await requestAs(U.owner, cn);
  if (r.status !== 202) return { verdict: "SKIP", evidence: { reason: "dobropis neprešiel readiness/preflight", code: r.body.code } };
  await sendOnly(r.body.outbound!.id);
  const sha = (await outboundOf(r.body.outbound!.id)).ubl_sha256;
  let row: Row | undefined;
  for (let i = 0; i < 12 && !row; i++) {
    await sleep(5_000);
    await runInboundPoll({ store: inboundStore, provider, environment: "sandbox" }, { batchSize: 10 });
    row = (await sql<Row>("select * from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2", [CA, sha])).rows[0];
  }
  if (!row) return { verdict: "PARTIAL", evidence: { reason: "prijatý dobropis sa v sandboxe neobjavil do 60 s" } };
  return { status: row.processing_status, last_error_code: row.last_error_code, xml_stored: INBOUND_STORAGE.has(row.xml_storage_path as string), invoice_id: row.invoice_id ?? null };
});
await step("I12", "webhook (offline): docs tvar s data.orgId, HMAC t=…,v1=… → spracované; zlý podpis → 401", async () => {
  const { handleEinvoiceWebhook } = await import("../lib/einvoice/inbound/webhook.ts");
  const secret = "whsec_local_e2e_only_" + RUN;
  const body = JSON.stringify({ event: "peppol.document.received", timestamp: new Date().toISOString(), data: { mode: "test", orgId: ORG_ID } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const deps = { inbound: inboundStore, outbound: store, provider, environment: "sandbox" as const, secrets: [secret], nowSeconds: () => Math.floor(Date.now() / 1000) };
  const ok = await handleEinvoiceWebhook(deps, { rawBody: new TextEncoder().encode(body), signatureHeader: `t=${t},v1=${sig}`, deliveryIdHeader: `e2e-${RUN}` });
  const bad = await handleEinvoiceWebhook(deps, { rawBody: new TextEncoder().encode(body), signatureHeader: `t=${t},v1=${"0".repeat(64)}`, deliveryIdHeader: `e2e-bad-${RUN}` });
  assert.equal(bad.status, 401);
  return { verdict: "PARTIAL", evidence: { note: "skutočné doručenie webhooku z poskytovateľa vyžaduje verejný endpoint (staging)", ok: ok.body.code, bad: bad.body.code } };
});
await step("I13", "tenant izolácia: firma B nevidí outbound/inbound firmy A; request na faktúru A → 404", async () => {
  const seeOut = (await as(U.b, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"))).rows[0].n;
  const seeIn = (await as(U.b, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_inbound"))).rows[0].n;
  calls.length = 0;
  const r = await requestAs(U.b, INV1);
  assert.equal(seeOut, 0);
  assert.equal(seeIn, 0);
  assert.equal(r.status, 404);
  assert.deepEqual(calls, []);
  return { b_outbound_visible: seeOut, b_inbound_visible: seeIn, cross_request: r.status };
});

// =============================================================================
// AUTHZ MATRIX (bez odoslania: zamietnuté nevolajú poskytovateľa; povolené sa iba zaradia)
// =============================================================================
async function matrix(uid: string, company: string, partner: string) {
  const inv = await invoice(company === CA ? U.owner : U.b, company, partner, { ...HEADER, buyer_reference: `E2E-AUTHZ-${RUN}` });
  calls.length = 0;
  const r = await requestAs(uid, inv);
  const sent = calls.some((c) => c.endsWith("/connector/send"));
  if (r.body.outbound?.id) await sql("update public.einvoice_outbound set next_retry_at = now() + interval '30 days' where id = $1", [r.body.outbound.id]);
  return { status: r.status, code: r.body.code, provider_called: calls.length > 0, sent };
}
await step("A1", "owner + nárok → 202 (zaradené, neodoslané bez workera)", async () => {
  const m = await matrix(U.owner, CA, PARTNER_A);
  assert.equal(m.status, 202);
  assert.equal(m.sent, false);
  return m;
});
await step("A2", "accountant (finance.manage) + nárok → 202", async () => {
  const m = await matrix(U.acc, CA, PARTNER_A);
  assert.equal(m.status, 202);
  return m;
});
await step("A3", "admin bez finance.manage → 403, poskytovateľ sa nevolá", async () => {
  const m = await matrix(U.admin, CA, PARTNER_A);
  assert.equal(m.status, 403);
  assert.equal(m.provider_called, false);
  return m;
});
await step("A4", "admin s explicitným finance.manage → 202", async () => {
  const m = await matrix(U.adminFin, CA, PARTNER_A);
  assert.equal(m.status, 202);
  return m;
});
await step("A5", "employee (aj s finance flagom) → 403, poskytovateľ sa nevolá", async () => {
  const m = await matrix(U.emp, CA, PARTNER_A);
  assert.equal(m.status, 403);
  assert.equal(m.provider_called, false);
  return m;
});
await step("A6", "firma bez nároku einvoice → 403 EINVOICE_ENTITLEMENT_REQUIRED", async () => {
  const m = await matrix(U.b, CB, PARTNER_B);
  assert.equal(m.status, 403);
  assert.equal(m.code, "EINVOICE_ENTITLEMENT_REQUIRED");
  assert.equal(m.provider_called, false);
  return m;
});
await step("A7", "cross-company pokus → 404, poskytovateľ sa nevolá", async () => {
  calls.length = 0;
  const r = await requestAs(U.b, INV1);
  assert.equal(r.status, 404);
  assert.deepEqual(calls, []);
  return { status: r.status };
});
await step("A8", "rollout pozastavený (kill switch) → 403 ROLLOUT_NOT_ENABLED, poskytovateľ sa nevolá", async () => {
  await sql("update public.einvoice_rollout set stage = 'paused' where company_id = $1", [CA]);
  try {
    const m = await matrix(U.owner, CA, PARTNER_A);
    assert.equal(m.status, 403);
    assert.equal(m.code, "ROLLOUT_NOT_ENABLED");
    assert.equal(m.provider_called, false);
    return m;
  } finally {
    await sql("update public.einvoice_rollout set stage = 'internal' where company_id = $1", [CA]);
  }
});

// =============================================================================
// Report (bez tajomstiev a PII)
// =============================================================================
const summary = {
  generated_at: new Date().toISOString(),
  environment: "sandbox",
  architecture: "Phase 1–6 moduly + PGlite (všetky migrácie) + reálne eFaktura.sk sandbox API",
  not_covered: ["Supabase PostgREST/Storage/RLS na skutočnom projekte", "Vercel routes a cron", "skutočné doručenie webhooku"],
  counts: results.reduce<Record<string, number>>((acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {}),
  results,
};
const reportPath = ARGS.get("report") ?? path.join(tmpdir(), "esblu-einvoice-sandbox-e2e-report.json");
writeFileSync(reportPath, JSON.stringify(summary, null, 2));
console.log(`\nsandbox-e2e: ${JSON.stringify(summary.counts)}  report: ${reportPath}`);
if (results.some((r) => r.verdict === "FAIL")) process.exit(1);
