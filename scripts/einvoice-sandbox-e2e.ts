// =============================================================================
// E-Faktúra — SANDBOX E2E aktuálnej architektúry (Phase 1–6) proti eFaktura.sk.
//
// DEPRECATED (2026-10-05): viazané na STARÝ sandbox účet (mäkký sandbox, auto-enroll,
// organizácia „Tatra Servis" 9915:2099999999). Pre nový API partner účet používaj
// scripts/einvoice-partner-sandbox-e2e.ts (enroll, A → B, participant.*).
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
//
// Overenie samotného harnessu (bez siete, bez kľúča, fake sandbox v pamäti):
//   npm run test:einvoice-e2e-selftest
// =============================================================================

import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleOutboundSendRequest } from "../lib/einvoice/outbound/route-handler.ts";
import { loadEinvoiceReadiness } from "../lib/einvoice/readiness-server.ts";
import { loadFinalizedIssuedInvoiceSnapshot } from "../lib/einvoice/load-finalized-invoice.ts";
import { generateUbl } from "../lib/einvoice/ubl/generate.ts";
import { handleEinvoiceWebhook } from "../lib/einvoice/inbound/webhook.ts";
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
// --offline-selftest: overenie samotného harnessu BEZ siete a BEZ kľúča (lokálny
// fake sandbox v pamäti). Nikdy nevolá api.efaktura.sk — iba pre vývoj harnessu.
const SELFTEST = ARGS.get("offline-selftest") === "true";
if (!SELFTEST && ARGS.get("confirm-sandbox") !== "true") stop("chýba --confirm-sandbox (reálne volania sandbox API)");
if (!SELFTEST && process.env.ESBLU_EINVOICE_ENVIRONMENT?.trim() !== "sandbox") stop("ESBLU_EINVOICE_ENVIRONMENT musí byť 'sandbox'");
const SANDBOX_KEY = SELFTEST ? "efk_pk_test_" + "0".repeat(24) : process.env.ESBLU_EFAKTURA_API_KEY?.trim() ?? "";
if (!SANDBOX_KEY.startsWith("efk_pk_test_")) stop("ESBLU_EFAKTURA_API_KEY chýba alebo nie je sandbox kľúč (efk_pk_test_)");
const ORG_ID = ARGS.get("org") ?? (SELFTEST ? "5e1f7e57-0000-4000-8000-000000000001" : stop("chýba --org=<uuid sandbox organizácie>"));
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
// --- offline fake sandbox (iba --offline-selftest) ---------------------------------
// --selftest-legacy-numbering: reprodukcia L2 behu po 070ddef — čísla FA<rok>0001… ako
// v čerstvej DB a sandbox, ktorý už FA<rok>0002/0003 a DO<rok>0001 pozná z predošlého behu.
const LEGACY_NUMBERING = SELFTEST && ARGS.get("selftest-legacy-numbering") === "true";
const FAKE = {
  numbers: new Set<string>(LEGACY_NUMBERING ? [`FA${TODAY.slice(0, 4)}0002`, `FA${TODAY.slice(0, 4)}0003`, `DO${TODAY.slice(0, 4)}0001`] : []),
  idem: new Map<string, { bodySha: string; response: string }>(),
  sent: new Map<string, { xml: Uint8Array }>(),
  received: [] as { id: string; xml: Uint8Array; acknowledged_at: string | null; document_type: string; number: string }[],
  events: [] as Record<string, unknown>[],
};
function fakeJson(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
async function fakeSandbox(url: URL, method: string, init: RequestInit): Promise<Response> {
  const p = url.pathname;
  const id = p.split("/").filter(Boolean).at(-1) ?? "";
  if (method === "GET" && p.startsWith("/v1/agent/organizations/")) {
    return fakeJson(200, { organization_id: ORG_ID, participant_id: PARTICIPANT, status: "aktivne", peppol_status: "active", claim_status: "claimed", peppol_eligible: true });
  }
  if (p === "/v1/agent/peppol/recipient") return fakeJson(200, { data: { peppol_id: url.searchParams.get("peppolId"), found: true, sml_state: "active", lookup_unavailable: false } });
  if (p === "/v1/agent/peppol/preflight") return fakeJson(200, { data: { send_ready: true, validator_unavailable: false, validation: { ran: true, valid: true, error_count: 0, warning_count: 0 }, repair: [], recipient: { found: true } } });
  if (p === "/v1/agent/peppol/connector/send") {
    const key = new Headers(init.headers).get("Idempotency-Key") ?? "";
    const body = String(init.body ?? "");
    const prev = FAKE.idem.get(key);
    if (prev) return prev.bodySha === sha(body) ? new Response(prev.response, { status: 200, headers: { "content-type": "application/json" } }) : fakeJson(409, { error: { code: "CONFLICT" } });
    const parsed = JSON.parse(body) as { document: { xmlBase64: string } };
    const xml = new Uint8Array(Buffer.from(parsed.document.xmlBase64, "base64"));
    const invoiceId = randomUUID();
    const text = new TextDecoder().decode(xml);
    const number = /<cbc:ID>([^<]+)<\/cbc:ID>/.exec(text)?.[1] ?? "X";
    if (FAKE.numbers.has(number)) {
      // Docs connector: reason `ingest` = „the document number already exists as a native invoice".
      const rejected = JSON.stringify({ data: { status: "rejected", reason: "ingest", error: "Doklad s týmto číslom už existuje", send_ready: true } });
      FAKE.idem.set(key, { bodySha: sha(body), response: rejected });
      return new Response(rejected, { status: 200, headers: { "content-type": "application/json" } });
    }
    FAKE.numbers.add(number);
    FAKE.sent.set(invoiceId, { xml });
    const at = new Date().toISOString();
    FAKE.events.push({ occurred_at: at, event: "sent.queued", invoice_id: invoiceId, document_id: `${PARTICIPANT}#${number}`, message_id: null });
    FAKE.received.push({ id: randomUUID(), xml, acknowledged_at: null, document_type: text.includes("<CreditNote") ? "credit_note" : "invoice", number });
    const response = JSON.stringify({ data: { status: "queued", invoice_id: invoiceId, document_id: `${PARTICIPANT}#${number}`, job_id: "j", send_ready: true } });
    FAKE.idem.set(key, { bodySha: sha(body), response });
    return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (p.startsWith("/v1/agent/peppol/status/")) return fakeJson(200, { data: { invoice_id: id, state: "SENT", updated_at: new Date().toISOString() } });
  if (/\/peppol\/sent\/[^/]+\/evidence$/.test(p)) {
    const inv = p.split("/")[5];
    const x = FAKE.sent.get(inv);
    if (!x) return fakeJson(404, { error: { code: "NOT_FOUND" } });
    return fakeJson(200, { data: { invoice_id: inv, document_id: "d", ubl_sha256: sha(x.xml), delivery_status: { state: "delivered", at: new Date().toISOString() }, transactions: [{ state: "SENT", mode: "test" }] } });
  }
  if (p === "/v1/agent/peppol/events") return fakeJson(200, { data: FAKE.events });
  if (p === "/v1/agent/peppol/received") {
    return fakeJson(200, { data: FAKE.received.filter((r) => !r.acknowledged_at).map((r) => ({ id: r.id, sender_participant_id: PARTICIPANT, sender_name: "Tatra Servis s.r.o.", sender_ico: ORG_ICO, document_type: r.document_type, document_number: r.number, total: "12.30", currency: "EUR", status: "new", issue_date: TODAY, received_at: new Date().toISOString(), acknowledged_at: null, is_test: true })) });
  }
  if (/\/received\/[^/]+\/xml$/.test(p)) {
    const r = FAKE.received.find((x) => x.id === p.split("/")[5]);
    return r ? new Response(r.xml, { status: 200, headers: { "content-type": "application/xml" } }) : fakeJson(404, { error: { code: "NOT_FOUND" } });
  }
  if (/\/received\/[^/]+\/acknowledge$/.test(p)) {
    const r = FAKE.received.find((x) => x.id === p.split("/")[5]);
    if (!r) return fakeJson(404, { error: { code: "NOT_FOUND" } });
    const already = r.acknowledged_at !== null;
    r.acknowledged_at ??= new Date().toISOString();
    return fakeJson(200, { data: { id: r.id, acknowledged_at: r.acknowledged_at, already_acknowledged: already } });
  }
  return fakeJson(404, { error: { code: "NOT_FOUND" } });
}

type Fault = null | "unavailable-before-send" | "drop-response-after-send";
let fault: Fault = null;
const calls: string[] = [];
/**
 * Záznam KAŽDÉHO reálne doručeného connector/send (aj keď sa odpoveď lokálne
 * „stratí"). Iba bezpečné polia: HTTP status, data.status, kategória reason,
 * prefix SHA-256 invoice_id a Idempotency-Key — nikdy telo, XML ani kľúč API.
 */
type SendLogEntry = { http: number; status: string | null; reason: string | null; invoice: string | null; key: string | null; dropped: boolean };
const sendLog: SendLogEntry[] = [];
const hashPrefix = (v: string | null | undefined) => (v ? `sha256:${createHash("sha256").update(v).digest("hex").slice(0, 12)}` : null);
async function logSend(res: Response, init: RequestInit, dropped: boolean) {
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.clone().json()) as { data?: Record<string, unknown> }).data ?? {};
  } catch {
    data = {};
  }
  const reason = typeof data.reason === "string" && /^[a-z_]{1,40}$/.test(data.reason) ? data.reason : null;
  sendLog.push({
    http: res.status,
    status: typeof data.status === "string" ? data.status : null,
    reason,
    invoice: hashPrefix(typeof data.invoice_id === "string" ? data.invoice_id : null),
    key: hashPrefix(new Headers(init.headers).get("Idempotency-Key")),
    dropped,
  });
}
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
  const res = SELFTEST ? await fakeSandbox(url, method, init) : await fetch(input, init);
  if (url.pathname.endsWith("/connector/send")) {
    const dropped = fault === "drop-response-after-send";
    await logSend(res, init, dropped);
    if (dropped) {
      fault = null;
      await res.arrayBuffer();
      throw new TypeError("simulated lost response after send");
    }
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
/**
 * POST /api/einvoice/outbound presne cez produkčný route handler (Bearer → telo
 * {invoice_id, confirm_send:true} → orchestrácia). Overenie tokenu je jediná
 * náhrada: token = ID syntetického používateľa (iba lokálna PGlite DB).
 */
async function postOutbound(uid: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request("http://localhost/api/einvoice/outbound", {
    method: "POST",
    headers: { authorization: `Bearer e2e-${uid}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleOutboundSendRequest(req, {
    authenticate: async (_req, token) => (token === `e2e-${uid}` ? { userId: uid } : null),
    userDbFor: () => userDb(uid),
    store: () => store,
    runtime: () => ({ provider, environment: "sandbox" }),
    env: ENV,
  });
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

// Unikátne číslovanie PER BEH: sandbox organizácia je trvalá a poskytovateľ odmietne
// číslo dokladu, ktoré už existuje (connector reason `ingest`). Čerstvá PGlite DB by
// inak v každom behu generovala FA20260001, FA20260002… (L2 root cause O14/O15/I11).
if (!LEGACY_NUMBERING) await locked(() => db.exec(`
  insert into public.invoice_number_sequences (company_id, year, series_key, prefix)
  values ('${CA}', ${TODAY.slice(0, 4)}, 'regular', 'E2E${RUN}-'), ('${CA}', ${TODAY.slice(0, 4)}, 'credit_note', 'E2EDO${RUN}-');
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
      `insert into public.invoices (company_id, direction, kind, issue_date, currency, customer_business_partner_id, source, corrects_invoice_id, correction_reason)
       values ($1, 'issued', $3, $4, 'EUR', $2, 'manual', $5, $6) returning id`,
      [company, partner, kind, TODAY, corrects, kind === "credit_note" || kind === "debit_note" ? "E2E oprava: vrátenie tovaru" : null]
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, SELFTEST ? 1 : ms));

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
  // Zrkadlo produkčného lib/einvoice/inbound/supabase-store.ts (pôvodne tu boli
  // stuby z ops testov → poll nikdy nevidel organizáciu; L2 root cause I1–I4).
  async listOrganizations(provider, env) {
    const { rows } = await sql<Row>("select company_id, provider, provider_org_id, participant_id, peppol_eligible, environment from public.einvoice_organizations where provider = $1 and environment = $2 and peppol_eligible and provider_org_id is not null", [provider, env]);
    return rows.map((o) => ({ companyId: o.company_id as string, environment: o.environment as "sandbox", provider: o.provider as string, providerOrgId: o.provider_org_id as string, participantId: (o.participant_id as string) ?? null, peppolEligible: true }));
  },
  async companyForOrg(provider, env, orgId) {
    const { rows } = await sql<{ c: string }>("select company_id c from public.einvoice_organizations where provider = $1 and environment = $2 and provider_org_id = $3", [provider, env, orgId]);
    return rows[0]?.c ?? null;
  },
  async claimOutboundBySubmission(companyId, submissionId, lease) {
    const rows = await svcRows<{ j: OutboundRow }>("select to_jsonb(t) j from public.esblu_einvoice_claim_outbound_by_submission($1, $2, $3) t", [companyId, submissionId, lease]);
    return rows[0]?.j ?? null;
  },
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
// Výsledky (PASS / FAIL / PARTIAL / SKIP) s dôkazmi bez tajomstiev a PII.
// Kaskáda: krok s nesplneným predpokladom je SKIP „BLOCKED_BY", nie FAIL —
// report tak ukazuje iba skutočné príčiny.
// =============================================================================
type Verdict = "PASS" | "FAIL" | "PARTIAL" | "SKIP";
type StepOut = Record<string, unknown> | { verdict: Verdict; evidence: Record<string, unknown> };
const results: { id: string; label: string; verdict: Verdict; evidence: Record<string, unknown> }[] = [];
const verdictOf = (id: string) => results.find((r) => r.id === id)?.verdict;
async function step(id: string, label: string, requires: string[], fn: () => Promise<StepOut>) {
  const blocked = requires.filter((r) => verdictOf(r) !== "PASS" && verdictOf(r) !== "PARTIAL");
  if (blocked.length > 0) {
    results.push({ id, label, verdict: "SKIP", evidence: { blocked_by: blocked } });
    console.log(`SKIP    ${id} ${label}  (BLOCKED_BY ${blocked.join(",")})`);
    return;
  }
  try {
    const out = await fn();
    const wrapped = "verdict" in out && "evidence" in out ? (out as { verdict: Verdict; evidence: Record<string, unknown> }) : { verdict: "PASS" as Verdict, evidence: out as Record<string, unknown> };
    results.push({ id, label, ...wrapped });
    console.log(`${wrapped.verdict.padEnd(7)} ${id} ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error);
    results.push({ id, label, verdict: "FAIL", evidence: { error: message } });
    console.log(`FAIL    ${id} ${label}\n        ${message}`);
  }
}
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
/** Bezpečný identifikátor do reportu: iba prefix SHA-256 (nie samotné ID). */
const idHash = (v: unknown) => (typeof v === "string" && v ? `sha256:${sha(v).slice(0, 12)}` : null);
const outboundCount = async () => (await sql<{ n: number }>("select count(*)::int n from public.einvoice_outbound")).rows[0].n;

/** Snapshot + UBL presne tak, ako ich zostaví odoslanie (pod RLS ownera). */
async function snapshotFingerprint(invoiceId: string) {
  const loaded = await loadFinalizedIssuedInvoiceSnapshot(userDb(U.owner), invoiceId, CA);
  if (!loaded.ok) throw new Error(`snapshot: ${loaded.reason}`);
  const ubl = generateUbl(loaded.snapshot);
  if (!ubl.ok) throw new Error(`ubl: ${ubl.issues.map((i) => i.code).join(",")}`);
  return { snapshot: sha(JSON.stringify(loaded.snapshot)), ubl: ubl.sha256 };
}

/** Udalosti odoslania poskytovateľa za dnešok (iba allowlistované polia). */
async function sentEvents(): Promise<{ status: number; rows: { key: string; invoiceId: string | null; event: string }[] }> {
  const r = await sandboxGet(`/v1/agent/peppol/events?direction=sent&from=${TODAY}&to=${TODAY}&limit=1000`);
  const data = Array.isArray(r.json?.data) ? (r.json!.data as Record<string, unknown>[]) : [];
  return {
    status: r.status,
    rows: data.map((e) => ({
      key: `${e.occurred_at}|${e.event}|${e.document_id}|${e.message_id ?? ""}`,
      invoiceId: typeof e.invoice_id === "string" ? e.invoice_id : null,
      event: String(e.event),
    })),
  };
}

// Predpoklad: sandbox organizácia existuje a má aktívny Peppol účet (9915:DIČ).
await step("P0", "sandbox organizácia: aktívny Peppol účet a participant = 9915:DIČ", [], async () => {
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
let SENT_SHA_SOURCE = "";
await step("O1", "koncept faktúry (vydaná, syntetická, dnešný dátum vyhotovenia)", ["P0"], async () => {
  INV1 = await invoice(U.owner, CA, PARTNER_A, HEADER, false);
  const r = (await sql<Row>("select document_status, direction from public.invoices where id = $1", [INV1])).rows[0];
  assert.equal(r.document_status, "draft");
  return { document_status: r.document_status, direction: r.direction };
});
await step("O2", "finalizácia → nemenný kanonický snapshot: pokusy o zmenu nič nezmenia, snapshot aj UBL bajtovo rovnaké", ["O1"], async () => {
  await as(U.owner, () => db.query("select public.esblu_finalize_invoice($1)", [INV1]));
  const before = await snapshotFingerprint(INV1);
  // owner: RLS politika *_finance_draft → UPDATE zasiahne 0 riadkov (bez chyby) — overuje sa POČET, nie chyba.
  const items = await as(U.owner, () => db.query<{ id: string }>("update public.invoice_items set unit_price = 99, description = 'zmenené' where invoice_id = $1 returning id", [INV1]));
  const header = await as(U.owner, () => db.query<{ id: string }>("update public.invoices set issue_date = '2020-01-01' where id = $1 returning id", [INV1])).catch(() => ({ rows: [] as { id: string }[] }));
  // service_role (obchádza RLS): trigger esblu_block_finalized_invoice_items_mutation / snapshot guard musí odmietnuť.
  const svcItems = await errorOf(() => asService(() => db.query("update public.invoice_items set unit_price = 99 where invoice_id = $1", [INV1])));
  const svcParties = await errorOf(() => asService(() => db.query("update public.invoice_parties set legal_name = 'X' where invoice_id = $1", [INV1])));
  const after = await snapshotFingerprint(INV1);
  assert.equal(items.rows.length, 0, "owner zmenil finalizované položky");
  assert.equal(header.rows.length, 0, "owner zmenil hlavičku finalizovanej faktúry");
  assert.ok(svcItems.length > 0, "service_role zmenil finalizované položky");
  assert.ok(svcParties.length > 0, "service_role zmenil snapshot strán");
  assert.deepEqual(after, before, "snapshot / UBL sa zmenil");
  return { owner_items_rows_changed: 0, owner_header_rows_changed: 0, service_role_blocked: true, snapshot_sha256: before.snapshot.slice(0, 12), ubl_sha256: before.ubl.slice(0, 12), invariant: "byte-identical" };
});
await step("O3", "readiness (pre_send) pod RLS ownera = ready, bez issues", ["O2"], async () => {
  const r = await loadEinvoiceReadiness(userDb(U.owner), INV1, ENV);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return {};
  assert.equal(r.result.mode, "pre_send");
  assert.deepEqual(r.result.issues.map((i) => i.code), []);
  return { mode: r.result.mode, ready: r.result.ready, warnings: r.result.warnings.map((w) => w.code) };
});
await step("O4", "route cesta: bez presného confirm_send:true → 400; žiadny verify/preflight/pokus/odoslanie", ["O3"], async () => {
  const before = await outboundCount();
  const codes: string[] = [];
  for (const body of [{ invoice_id: INV1 }, { invoice_id: INV1, confirm_send: "true" }, { invoice_id: INV1, confirm_send: false }, { invoice_id: INV1, confirm_send: true, company_id: CB }, { invoice_id: "", confirm_send: true }]) {
    calls.length = 0;
    const r = await postOutbound(U.owner, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(calls, [], "poskytovateľ bol volaný");
    codes.push(String(r.body.code));
  }
  assert.equal(await outboundCount(), before, "vznikol pokus bez potvrdenia");
  return { status: 400, codes, provider_calls: 0, new_attempts: 0 };
});
await step("O5-O7", "route cesta s confirm_send:true → recipient verify → provider preflight → queue (202), nič neodoslané", ["O4"], async () => {
  calls.length = 0;
  const r = await postOutbound(U.owner, { invoice_id: INV1, confirm_send: true });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  OUT1 = String((r.body.outbound as { id: string }).id);
  assert.ok(calls.includes("GET /v1/agent/peppol/recipient"), "recipient lookup");
  assert.ok(calls.includes("POST /v1/agent/peppol/preflight"), "preflight");
  assert.ok(!calls.some((c) => c.endsWith("/connector/send")), "request nesmie odoslať");
  const row = await outboundOf(OUT1);
  assert.equal(row.state, "queued");
  return { status: r.status, code: r.body.code, provider_calls: [...calls], state: row.state };
});
await step("O8-O9", "worker claim + send (ten istý kľúč) → poskytovateľ prijal (sent, ID podania)", ["O5-O7"], async () => {
  calls.length = 0;
  const rep = await sendOnly(OUT1);
  const row = await outboundOf(OUT1);
  assert.equal(rep.claimed, 1);
  assert.ok(["sent", "delivered"].includes(row.state as string), `stav ${row.state} (${row.last_error_code ?? ""})`);
  assert.ok(row.provider_submission_id);
  return { claimed: rep.claimed, state: row.state, provider_submission: idHash(row.provider_submission_id), provider_calls: [...calls] };
});
await step("O10-O12", "reconciliation → SENT / delivered + allowlistovaný dôkaz (AS4/MLS)", ["O8-O9"], async () => {
  let row = await outboundOf(OUT1);
  for (let i = 0; i < 18 && row.state !== "delivered"; i++) {
    await sleep(5_000);
    await sql("update public.einvoice_outbound set updated_at = now() - interval '10 minutes' where id = $1", [OUT1]);
    await runOutboundReconcileBatch(workerDeps(), WOPTS);
    row = await outboundOf(OUT1);
  }
  const evidence = row.evidence as Record<string, unknown> | null;
  const verdict: Verdict = row.state === "delivered" ? "PASS" : row.state === "sent" ? "PARTIAL" : "FAIL";
  return { verdict, evidence: { state: row.state, provider_status: row.provider_status ?? null, evidence_keys: evidence ? Object.keys(evidence).sort() : [], evidence_delivery_state: evidence?.delivery_state ?? null } };
});
await step("O13", "UBL integrita: uložené bajty → SHA-256 = riadok = snapshot UBL = (ak je) hash v dôkaze poskytovateľa", ["O8-O9"], async () => {
  const row = await outboundOf(OUT1);
  const bytes = storage.get(row.ubl_storage_path as string);
  assert.ok(bytes, "UBL v storage");
  const h = sha(bytes!);
  assert.equal(h, row.ubl_sha256);
  assert.equal(h, (await snapshotFingerprint(INV1)).ubl, "UBL z nemenného snapshotu sa zhoduje s odoslanými bajtmi");
  SENT_SHA = h;
  SENT_SHA_SOURCE = "O8-O9";
  const ev = (row.evidence as Record<string, unknown> | null)?.ubl_sha256 ?? null;
  if (ev) assert.equal(ev, h, "hash v dôkaze poskytovateľa");
  return { sha256: h.slice(0, 12), provider_hash_matches: ev ? true : "n/a" };
});
let RETRY_SHA = "";
const safeReason = (r: unknown) => (typeof r === "string" ? (/^([a-z_]{1,40})/.exec(r)?.[1] ?? "other") : null);
const numberOf = async (inv: string) => String((await sql<Row>("select invoice_number from public.invoices where id = $1", [inv])).rows[0].invoice_number);
await step("O14", "retry: sieťová chyba PRED odoslaním (poskytovateľ dokument nevidí) → backoff, ten istý kľúč → prvé reálne podanie", ["P0"], async () => {
  const inv = await invoice(U.owner, CA, PARTNER_A, { ...HEADER, buyer_reference: `E2E-RETRY-${RUN}` });
  const r = await postOutbound(U.owner, { invoice_id: inv, confirm_send: true });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = String((r.body.outbound as { id: string }).id);
  const key = (await outboundOf(id)).idempotency_key as string;
  const log0 = sendLog.length;
  fault = "unavailable-before-send";
  await sendOnly(id);
  let row = await outboundOf(id);
  const realSendsFirst = sendLog.length - log0;
  assert.equal(realSendsFirst, 0, "prvý pokus sa NESMIE dostať k poskytovateľovi");
  assert.equal(row.state, "sending");
  await makeDue(id);
  await sendOnly(id);
  row = await outboundOf(id);
  const sends = sendLog.slice(log0);
  assert.equal(row.idempotency_key, key);
  RETRY_SHA = String(row.ubl_sha256);
  const evidence = {
    invoice_number_unique_per_run: (await numberOf(inv)).startsWith(`E2E${RUN}-`),
    real_sends_before_fault: realSendsFirst,
    real_sends_total: sends.length,
    provider_responses: sends.map((x) => ({ http: x.http, status: x.status, reason: x.reason })),
    same_key: sends.every((x) => x.key === hashPrefix(key)),
    final_state: row.state,
    reject_reason_category: safeReason(row.reject_reason),
    retry_count: row.retry_count,
  };
  return { verdict: ["sent", "delivered"].includes(row.state as string) && sends.length === 1 ? "PASS" : "FAIL", evidence };
});
await step("O15", "neistý výsledok: odpoveď stratená PO odoslaní → replay toho istého kľúča → presne JEDNO podanie (uložená odpoveď)", ["P0"], async () => {
  const before = await sentEvents();
  const known = new Set(before.rows.map((e) => e.key));
  const inv = await invoice(U.owner, CA, PARTNER_A, { ...HEADER, buyer_reference: `E2E-UNKNOWN-${RUN}` });
  const r = await postOutbound(U.owner, { invoice_id: inv, confirm_send: true });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = String((r.body.outbound as { id: string }).id);
  const key = (await outboundOf(id)).idempotency_key as string;
  const log0 = sendLog.length;
  fault = "drop-response-after-send";
  await sendOnly(id);
  let row = await outboundOf(id);
  assert.equal(row.state, "sending");
  assert.equal(row.send_outcome_unknown, true);
  await makeDue(id);
  await sendOnly(id);
  row = await outboundOf(id);
  const sends = sendLog.slice(log0);
  const [first, replay] = sends;
  assert.equal(row.idempotency_key, key, "replay musí použiť ten istý kľúč");
  // Provider-side: nové udalosti odoslania → koľko RÔZNYCH podaní (invoice_id) vzniklo.
  let fresh: { invoiceId: string | null; event: string }[] = [];
  for (let i = 0; i < 8; i++) {
    await sleep(5_000);
    fresh = (await sentEvents()).rows.filter((e) => !known.has(e.key));
    if (row.provider_submission_id && fresh.some((e) => e.invoiceId === row.provider_submission_id)) break;
  }
  await sleep(10_000);
  fresh = (await sentEvents()).rows.filter((e) => !known.has(e.key));
  const submissions = new Set(fresh.map((e) => e.invoiceId).filter((x): x is string => !!x));
  const identicalReplay = !!first && !!replay && first.status === replay.status && first.invoice === replay.invoice && first.http === replay.http;
  const evidence = {
    invoice_number_unique_per_run: (await numberOf(inv)).startsWith(`E2E${RUN}-`),
    real_sends: sends.length,
    first_response: first ? { http: first.http, status: first.status, reason: first.reason, invoice: first.invoice, dropped: first.dropped } : null,
    replay_response: replay ? { http: replay.http, status: replay.status, reason: replay.reason, invoice: replay.invoice } : null,
    replay_identical_to_first: identicalReplay,
    same_key: sends.every((x) => x.key === hashPrefix(key)),
    distinct_new_provider_submissions: submissions.size,
    final_state: row.state,
    provider_submission: hashPrefix(row.provider_submission_id as string | null),
    reject_reason_category: safeReason(row.reject_reason),
    note: "dôkaz pre tento replay; NEdokazuje retenčnú dobu Idempotency-Key (P1)",
  };
  if (submissions.size > 1) return { verdict: "FAIL", evidence };
  if (first?.status === "queued" && identicalReplay && submissions.size === 1 && ["sent", "delivered"].includes(row.state as string)) return { verdict: "PASS", evidence };
  // Bezpečný stav: replay vrátil uloženú odpoveď a nevzniklo druhé podanie, ale pôvodné podanie
  // poskytovateľ odmietol (business) → idempotencia preukázaná, happy-path nie.
  if (identicalReplay && submissions.size <= 1) return { verdict: "PARTIAL", evidence };
  return { verdict: "FAIL", evidence };
});
await step("O16", "reconciliation operátorom (sent/delivered riadok) → RECONCILED, nikdy neodošle", ["O8-O9"], async () => {
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
if (!SENT_SHA && RETRY_SHA) {
  SENT_SHA = RETRY_SHA;
  SENT_SHA_SOURCE = "O14";
}
let INBOUND_ROW: Row | null = null;
const inboundDeps = () => ({ store: inboundStore, provider, environment: "sandbox" as const });
await step("I1-I4", "prijatý sandbox doklad → poll → refetch XML od poskytovateľa → nemenné uloženie", [SENT_SHA_SOURCE || "O8-O9"], async () => {
  const diag = { polls: 0, listed_total: 0, registered_total: 0, sync_errors: [] as string[], processed: 0, processing_codes: [] as string[] };
  for (let i = 0; i < 18 && !INBOUND_ROW; i++) {
    await sleep(5_000);
    calls.length = 0;
    const r = await runInboundPoll(inboundDeps(), { batchSize: 10 });
    diag.polls++;
    diag.listed_total += r.sync.listed;
    diag.registered_total += r.sync.registered;
    diag.sync_errors.push(...r.sync.errors.map((e) => e.code));
    diag.processed += r.processed.claimed;
    diag.processing_codes.push(...r.processed.results.map((x) => `${x.from}->${x.to}:${x.code ?? "ok"}`));
    INBOUND_ROW = (await sql<Row>("select * from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2", [CA, SENT_SHA])).rows[0] ?? null;
  }
  const rows = (await sql<Row>("select processing_status s, last_error_code e, count(*)::int n from public.einvoice_inbound group by 1, 2")).rows;
  if (!INBOUND_ROW) {
    return { verdict: "FAIL", evidence: { reason: "žiadny prijatý doklad s hashom odoslaného UBL do 90 s", matched_sha_from: SENT_SHA_SOURCE, ...diag, inbound_rows: rows } };
  }
  const bytes = INBOUND_STORAGE.get(INBOUND_ROW.xml_storage_path as string);
  assert.ok(bytes, "XML v storage");
  return { matched_sha_from: SENT_SHA_SOURCE, ...diag, stored: true, size: bytes!.byteLength, inbound_rows: rows };
});
await step("I5", "hash: prijaté XML je byte-identické s odoslaným UBL (SHA-256)", ["I1-I4"], async () => {
  const h = sha(INBOUND_STORAGE.get(INBOUND_ROW!.xml_storage_path as string)!);
  assert.equal(h, INBOUND_ROW!.xml_sha256);
  assert.equal(h, SENT_SHA);
  return { sha256: h.slice(0, 12), equals_sent: true };
});
await step("I6-I9", "parse → koncept prijatej faktúry → ACK u poskytovateľa", ["I1-I4"], async () => {
  for (let i = 0; i < 3; i++) {
    await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where processing_status not in ('acknowledged','failed')");
    await runInboundProcessBatch(inboundDeps(), { batchSize: 10 });
  }
  const r = (await sql<Row>("select * from public.einvoice_inbound where id = $1", [INBOUND_ROW!.id])).rows[0];
  INBOUND_ROW = r;
  assert.ok(["acknowledged", "duplicate"].includes(r.processing_status as string), `${r.processing_status} ${r.last_error_code ?? ""}`);
  const inv = r.invoice_id ? (await sql<Row>("select direction, document_status, source from public.invoices where id = $1", [r.invoice_id])).rows[0] : null;
  return { status: r.processing_status, acknowledged: Boolean(r.acknowledged_at), draft: inv ? { direction: inv.direction, status: inv.document_status, source: inv.source } : null };
});
await step("I8b", "duplicate: opätovná registrácia toho istého dokladu nevytvorí nový koncept", ["I6-I9"], async () => {
  const before = (await sql<{ n: number }>("select count(*)::int n from public.invoices where company_id = $1 and direction = 'received'", [CA])).rows[0].n;
  await runInboundPoll(inboundDeps(), { batchSize: 10 });
  await inboundStore.register({ provider: provider.name, environment: "sandbox", providerOrgId: ORG_ID, providerReceivedId: String(INBOUND_ROW!.provider_received_id), source: "poll", meta: { sender_participant_id: null, sender_ico: null, document_number: null, document_type: null, is_test: true } });
  const after = (await sql<{ n: number }>("select count(*)::int n from public.invoices where company_id = $1 and direction = 'received'", [CA])).rows[0].n;
  const rows = (await sql<{ n: number }>("select count(*)::int n from public.einvoice_inbound where provider_received_id = $1", [INBOUND_ROW!.provider_received_id])).rows[0].n;
  assert.equal(rows, 1);
  assert.equal(after, before);
  return { drafts_before: before, drafts_after: after, inbound_rows_for_document: rows };
});
await step("I10", "ACK retry: opätovný ACK u poskytovateľa je idempotentný", ["I6-I9"], async () => {
  await provider.acknowledgeInbound(providerCtx, String(INBOUND_ROW!.provider_received_id));
  await provider.acknowledgeInbound(providerCtx, String(INBOUND_ROW!.provider_received_id));
  return { repeated_ack_ok: true };
});
await step("I11", "prijatý dobropis (CreditNote 381) → koncept opravy v review (nič sa neaplikuje automaticky), XML uložené, ACK", ["O2"], async () => {
  const cn = await invoice(U.owner, CA, PARTNER_A, { ...HEADER, buyer_reference: `E2E-CN-${RUN}` }, true, "credit_note", INV1);
  const r = await postOutbound(U.owner, { invoice_id: cn, confirm_send: true });
  if (r.status !== 202) return { verdict: "SKIP", evidence: { stage: "outbound_request", reason: "dobropis sa nedal zaradiť", status: r.status, code: r.body.code, issues: (r.body.issues as unknown[] | undefined)?.length ?? 0 } };
  const id = String((r.body.outbound as { id: string }).id);
  await sendOnly(id);
  const out = await outboundOf(id);
  if (!["sent", "delivered"].includes(out.state as string)) {
    return { verdict: "SKIP", evidence: { stage: "outbound_send", reason: "poskytovateľ dobropis neprijal", state: out.state, code: out.last_error_code, reject_reason_category: safeReason(out.reject_reason), number_unique_per_run: (await numberOf(cn)).startsWith(`E2EDO${RUN}-`) } };
  }
  let row: Row | undefined;
  for (let i = 0; i < 18 && !row; i++) {
    await sleep(5_000);
    await runInboundPoll(inboundDeps(), { batchSize: 10 });
    row = (await sql<Row>("select * from public.einvoice_inbound where company_id = $1 and xml_sha256 = $2", [CA, out.ubl_sha256])).rows[0];
  }
  if (!row) return { verdict: "PARTIAL", evidence: { stage: "inbound_delivery", reason: "odoslaný dobropis sa v sandboxe ako prijatý neobjavil do 90 s", outbound_state: out.state } };
  for (let i = 0; i < 2; i++) {
    await sql("update public.einvoice_inbound set next_retry_at = now() - interval '1 second', locked_until = null where processing_status not in ('acknowledged','failed')");
    await runInboundProcessBatch(inboundDeps(), { batchSize: 10 });
  }
  row = (await sql<Row>("select * from public.einvoice_inbound where id = $1", [row.id])).rows[0];
  // 20261008100005: dobropis vytvorí koncept opravy v stave review; účtovne platným ho urobí až používateľ.
  const draft = row.invoice_id ? (await sql<Row>("select kind, direction, document_status, correction_review_status, corrects_invoice_id, correction_review_reasons from public.invoices where id = $1", [row.invoice_id])).rows[0] : null;
  const ok = ["acknowledged", "draft_created", "ack_pending"].includes(row.processing_status as string) && Boolean(draft) && draft!.kind === "credit_note"
    && draft!.direction === "received" && draft!.document_status === "draft" && draft!.correction_review_status === "review" && INBOUND_STORAGE.has(row.xml_storage_path as string);
  return { verdict: ok ? "PASS" : "FAIL", evidence: { stage: "inbound_processing", status: row.processing_status, last_error_code: row.last_error_code, xml_stored: INBOUND_STORAGE.has(row.xml_storage_path as string),
    draft_kind: draft?.kind ?? null, review_status: draft?.correction_review_status ?? null, original_linked: Boolean(draft?.corrects_invoice_id), review_reasons: draft?.correction_review_reasons ?? null } };
});
await step("I12", "webhook (iba OFFLINE časť): docs tvar s data.orgId, HMAC t=…,v1=… → spracované; zlý podpis → 401", [], async () => {
  const secret = "whsec_local_e2e_only_" + RUN;
  const body = JSON.stringify({ event: "peppol.document.received", timestamp: new Date().toISOString(), data: { mode: "test", orgId: ORG_ID } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const deps = { inbound: inboundStore, outbound: store, provider, environment: "sandbox" as const, secrets: [secret], nowSeconds: () => Math.floor(Date.now() / 1000) };
  const ok = await handleEinvoiceWebhook(deps, { rawBody: new TextEncoder().encode(body), signatureHeader: `t=${t},v1=${sig}`, deliveryIdHeader: `e2e-${RUN}` });
  const bad = await handleEinvoiceWebhook(deps, { rawBody: new TextEncoder().encode(body), signatureHeader: `t=${t},v1=${"0".repeat(64)}`, deliveryIdHeader: `e2e-bad-${RUN}` });
  assert.equal(bad.status, 401);
  assert.ok(["PROCESSED", "ACCEPTED_RETRY_LATER"].includes(String(ok.body.code)), String(ok.body.code));
  return { verdict: "PARTIAL", evidence: { scope: "offline_only", note: "podpis/parsovanie/spracovanie overené lokálne s lokálnym secretom; doručenie webhooku z poskytovateľa vyžaduje verejný endpoint + secret z portálu (L3)", ok: ok.body.code, bad: bad.body.code } };
});
await step("I13", "tenant izolácia: firma B nevidí outbound/inbound firmy A; request na faktúru A → 404", ["O2"], async () => {
  const seeOut = (await as(U.b, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound"))).rows[0].n;
  const seeIn = (await as(U.b, () => db.query<{ n: number }>("select count(*)::int n from public.einvoice_inbound"))).rows[0].n;
  calls.length = 0;
  const r = await postOutbound(U.b, { invoice_id: INV1, confirm_send: true });
  assert.equal(seeOut, 0);
  assert.equal(seeIn, 0);
  assert.equal(r.status, 404);
  assert.deepEqual(calls, []);
  return { b_outbound_visible: seeOut, b_inbound_visible: seeIn, cross_request: r.status };
});

// =============================================================================
// AUTHZ MATRIX — cez route handler (zamietnuté nevolajú poskytovateľa; povolené sa iba zaradia)
// =============================================================================
async function matrix(uid: string, company: string, partner: string) {
  const inv = await invoice(company === CA ? U.owner : U.b, company, partner, { ...HEADER, buyer_reference: `E2E-AUTHZ-${RUN}` });
  calls.length = 0;
  const r = await postOutbound(uid, { invoice_id: inv, confirm_send: true });
  const sent = calls.some((c) => c.endsWith("/connector/send"));
  const outId = (r.body.outbound as { id?: string } | undefined)?.id;
  if (outId) await sql("update public.einvoice_outbound set next_retry_at = now() + interval '30 days' where id = $1", [outId]);
  return { status: r.status, code: r.body.code, provider_called: calls.length > 0, sent };
}
await step("A1", "owner + nárok → 202 (zaradené, neodoslané bez workera)", ["P0"], async () => {
  const m = await matrix(U.owner, CA, PARTNER_A);
  assert.equal(m.status, 202);
  assert.equal(m.sent, false);
  return m;
});
await step("A2", "accountant (finance.manage) + nárok → 202", ["P0"], async () => {
  const m = await matrix(U.acc, CA, PARTNER_A);
  assert.equal(m.status, 202);
  return m;
});
await step("A3", "admin bez finance.manage → 403, poskytovateľ sa nevolá", ["P0"], async () => {
  const m = await matrix(U.admin, CA, PARTNER_A);
  assert.equal(m.status, 403);
  assert.equal(m.provider_called, false);
  return m;
});
await step("A4", "admin s explicitným finance.manage → 202", ["P0"], async () => {
  const m = await matrix(U.adminFin, CA, PARTNER_A);
  assert.equal(m.status, 202);
  return m;
});
await step("A5", "employee (aj s finance flagom) → 403, poskytovateľ sa nevolá", ["P0"], async () => {
  const m = await matrix(U.emp, CA, PARTNER_A);
  assert.equal(m.status, 403);
  assert.equal(m.provider_called, false);
  return m;
});
await step("A6", "firma bez nároku einvoice → 403 EINVOICE_ENTITLEMENT_REQUIRED", ["P0"], async () => {
  const m = await matrix(U.b, CB, PARTNER_B);
  assert.equal(m.status, 403);
  assert.equal(m.code, "EINVOICE_ENTITLEMENT_REQUIRED");
  assert.equal(m.provider_called, false);
  return m;
});
await step("A7", "cross-company pokus → 404, poskytovateľ sa nevolá", ["O2"], async () => {
  calls.length = 0;
  const r = await postOutbound(U.b, { invoice_id: INV1, confirm_send: true });
  assert.equal(r.status, 404);
  assert.deepEqual(calls, []);
  return { status: r.status };
});
await step("A8", "rollout pozastavený (kill switch) → 403 ROLLOUT_NOT_ENABLED, poskytovateľ sa nevolá", ["P0"], async () => {
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
  environment: SELFTEST ? "offline-selftest (fake sandbox, bez siete)" : "sandbox",
  architecture: "Phase 1–6 moduly + route handler + PGlite (všetky migrácie) + reálne eFaktura.sk sandbox API",
  not_covered: ["Supabase PostgREST/Storage/RLS na skutočnom projekte", "Vercel routes a cron", "skutočné doručenie webhooku"],
  counts: results.reduce<Record<string, number>>((acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {}),
  results,
};
const reportPath = ARGS.get("report") ?? path.join(tmpdir(), SELFTEST ? "esblu-einvoice-e2e-selftest-report.json" : "esblu-einvoice-sandbox-e2e-report.json");
writeFileSync(reportPath, JSON.stringify(summary, null, 2));
console.log(`\nsandbox-e2e: ${JSON.stringify(summary.counts)}  report: ${reportPath}`);
if (results.some((r) => r.verdict === "FAIL")) process.exit(1);
