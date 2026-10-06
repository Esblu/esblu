// =============================================================================
// Spoločná PGlite vrstva pre testy API partner onboardingu E-Faktúry
// (scripts/einvoice-partner-onboarding-tests.ts, scripts/einvoice-partner-sandbox-e2e.ts).
//
// PGlite so VŠETKÝMI migráciami E-Faktúry (vrátane 20261005100000) a RLS.
// Privilegované vrstvy volajú TIE ISTÉ RPC ako produkčné supabase-store.ts.
// Žiadna sieť, žiadne tajomstvá.
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbErrorCode, OutboundStoreError, type OutboundRow, type OutboundStore } from "../lib/einvoice/outbound/store.ts";
import { InboundStoreError, type InboundRow, type InboundStore } from "../lib/einvoice/inbound/store.ts";
import type { OnboardingStore, ReceptionStatus } from "../lib/einvoice/onboarding.ts";
import type { EventCursorStore } from "../lib/einvoice/inbound/feed.ts";
import type { EnrollAttemptLimiter } from "../lib/einvoice/ui/reception-server.ts";

export type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

export const EINVOICE_MIGRATIONS = [
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
  "20261005100000_einvoice_partner_onboarding.sql",
  "20261005110000_einvoice_enroll_error_code_active.sql",
  "20261006100000_einvoice_supplier_dic_feed_cursor.sql",
  "20261007100000_einvoice_event_ops_enroll_limit.sql",
  "20261008100000_invoicing_sk_compliance.sql",
  "20261008100001_invoicing_sk_trigger_fn_revoke.sql",
  "20261008100002_finance_helpers_bind_active_company.sql",
  "20261008100003_fx_rate_date_exact.sql",
  "20261008100004_fx_official_reference_rates.sql",
  "20261008100005_invoicing_corrections_payments_advances.sql",
  "20261008100006_einvoice_outbound_payment_received.sql",
  "20261008100007_einvoice_correction_backlink.sql",
];

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

export async function createPartnerHarness() {
  const db = await loadPglite();
  await db.exec(read("scripts/sql/pglite/einvoice-baseline.sql"));
  for (const m of EINVOICE_MIGRATIONS) {
    try {
      await db.exec(read(`supabase/migrations/${m}`));
    } catch (error) {
      throw new Error(`Migrácia ${m} zlyhala: ${error instanceof Error ? error.message : error}`);
    }
  }
  await db.exec(read("scripts/sql/pglite/einvoice-prod-helpers.sql"));

  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const tx = <T>(setup: (() => Promise<unknown>) | null, fn: () => Promise<T>) =>
    locked(async () => {
      await db.exec("begin");
      try {
        if (setup) await setup();
        const r = await fn();
        await db.exec("commit");
        return r;
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    });
  const as = <T>(uid: string | null, fn: () => Promise<T>) =>
    tx(async () => {
      if (uid) {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
        await db.exec("set local role authenticated");
      } else {
        await db.exec("set local role anon");
      }
    }, fn);
  const asService = <T>(fn: () => Promise<T>) => tx(() => db.exec("set local role service_role"), fn);
  const sql = <T = Row>(text: string, params: unknown[] = []) => locked(() => db.query<T>(text, params));
  const exec = (text: string) => locked(() => db.exec(text));

  /** Minimálny supabase-js klient pod JWT používateľa (RLS) — iba to, čo kód E-Faktúry používa. */
  function userDb(uid: string | null): SupabaseClient {
    function builder(table: string) {
      let columns = "*";
      const filters: { column: string; value: unknown }[] = [];
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
    } as unknown as SupabaseClient;
  }

  // --- outbound store (zrkadlo lib/einvoice/outbound/supabase-store.ts) -------------------
  const ublStorage = new Map<string, Uint8Array>();
  const outbound: OutboundStore = {
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
      if (ublStorage.has(p)) return "exists";
      ublStorage.set(p, new Uint8Array(bytes));
      return "created";
    },
    async getUbl(p) {
      const b = ublStorage.get(p);
      return b ? new Uint8Array(b) : null;
    },
  };

  // --- inbound store (zrkadlo lib/einvoice/inbound/supabase-store.ts) ---------------------
  const xmlStorage = new Map<string, Uint8Array>();
  const svcRows = async <T>(text: string, params: unknown[]): Promise<T[]> => {
    try {
      return (await asService(() => db.query<T>(text, params))).rows;
    } catch (error) {
      throw new InboundStoreError(dbErrorCode(error instanceof Error ? error.message : null));
    }
  };
  const inbound: InboundStore = {
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
    organizationFor: (c, e) => outbound.organizationFor(c, e),
    async listOrganizations(provider, env) {
      // Zrkadlo filtra v supabase-store.ts: príjem iba active alebo legacy NULL.
      const { rows } = await sql<Row>(
        "select company_id, provider, provider_org_id, participant_id, environment from public.einvoice_organizations where provider = $1 and environment = $2 and peppol_eligible and provider_org_id is not null and (reception_status is null or reception_status = 'active')",
        [provider, env]
      );
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
    async outboundStateBySubmission(companyId, submissionId) {
      const rows = await svcRows<{ state: string }>("select state from public.einvoice_outbound where company_id = $1 and provider_submission_id = $2 order by attempt desc limit 1", [companyId, submissionId]);
      return rows[0]?.state ?? null;
    },
    async webhookRetry(id) {
      const [r] = await svcRows<{ ok: boolean }>("select public.esblu_einvoice_webhook_retry($1, 5) ok", [id]);
      return r?.ok === true;
    },
    async participantEvent(i) {
      const [r] = await svcRows<Row>("select * from public.esblu_einvoice_org_participant_event($1, $2, $3, $4, $5, $6, $7)", [
        i.provider, i.environment, i.providerOrgId, i.event, i.participantId, i.code, i.occurredAt,
      ]);
      return { companyId: (r?.company_id as string) ?? null, applied: r?.applied === true, receptionStatus: (r?.reception_status as string) ?? null };
    },
    async putXml(p, bytes) {
      if (xmlStorage.has(p)) return "exists";
      xmlStorage.set(p, new Uint8Array(bytes));
      return "created";
    },
    async getXml(p) {
      const b = xmlStorage.get(p);
      return b ? new Uint8Array(b) : null;
    },
  };

  // --- onboarding store (zrkadlo lib/einvoice/onboarding-supabase-store.ts) ---------------
  const onboarding: OnboardingStore = {
    async billingIdentity(companyId) {
      const { rows } = await sql<Row>("select legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code from public.company_billing_profile where company_id = $1", [companyId]);
      const r = rows[0];
      return r
        ? { legal_name: r.legal_name as string, ico: r.ico as string, dic: r.dic as string, ic_dph: r.ic_dph as string, street: r.address_line1 as string, city: r.city as string, postal_code: r.postal_code as string, country_code: r.country_code as string }
        : null;
    },
    async organization(companyId, environment) {
      const { rows } = await sql<Row>("select provider_org_id, participant_id, peppol_eligible, reception_status, reception_error_code from public.einvoice_organizations where company_id = $1 and environment = $2", [companyId, environment]);
      const r = rows[0];
      return r
        ? { providerOrgId: (r.provider_org_id as string) ?? null, participantId: (r.participant_id as string) ?? null, peppolEligible: r.peppol_eligible === true, receptionStatus: (r.reception_status as ReceptionStatus) ?? null, receptionErrorCode: (r.reception_error_code as string) ?? null }
        : null;
    },
    async upsertProvisioned(i) {
      const [r] = await svcRows<Row>("select * from public.esblu_einvoice_org_upsert_provisioned($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)", [
        i.companyId, i.provider, i.environment, i.providerOrgId, i.participantId, i.orgStatus, i.peppolStatus, i.claimStatus, i.peppolEligible, JSON.stringify(i.snapshot),
      ]);
      return { created: r.created === true, receptionStatus: (r.reception_status as string) ?? null };
    },
    async applyEnroll(i) {
      const [r] = await svcRows<Row>("select * from public.esblu_einvoice_org_apply_enroll($1, $2, $3, $4, $5, $6, $7)", [
        i.provider, i.environment, i.providerOrgId, i.outcome, i.participantId, i.heldBy, i.errorCode,
      ]);
      return { receptionStatus: r.reception_status as string, peppolEligible: r.peppol_eligible === true };
    },
  };

  const cursor: EventCursorStore = {
    async claim(provider, environment, lease) {
      const [r] = await svcRows<Row>("select * from public.esblu_einvoice_event_cursor_claim($1, $2, $3)", [provider, environment, lease]);
      return r?.lock_token ? { lastEventId: Number(r.last_event_id), lockToken: r.lock_token as string } : null;
    },
    async advance(provider, environment, token, last, release, code = null) {
      const [r] = await svcRows<{ v: string }>("select public.esblu_einvoice_event_cursor_advance($1, $2, $3, $4, $5, $6) v", [provider, environment, token, last, release, code]);
      return Number(r.v);
    },
  };

  const limiter: EnrollAttemptLimiter = {
    async begin(companyId, userId) {
      const [r] = await svcRows<Row>("select * from public.esblu_einvoice_enroll_attempt_begin($1, $2)", [companyId, userId]);
      return { allowed: r?.allowed === true, attemptId: (r?.attempt_id as string) ?? null, retryAfterSeconds: Number(r?.retry_after_seconds ?? 0), reason: (r?.reason as string) ?? null };
    },
    async finish(id, outcome) {
      await svcRows("select public.esblu_einvoice_enroll_attempt_finish($1, $2)", [id, outcome.slice(0, 60)]);
    },
  };

  return { db, as, asService, sql, exec, userDb, outbound, inbound, onboarding, cursor, limiter, ublStorage, xmlStorage };
}

/** Slovenské IČO (8 číslic) s platnou kontrolnou číslicou z 7-ciferného základu. */
export function icoWithChecksum(base7: string): string {
  const d = base7.padStart(7, "0").slice(-7).split("").map(Number);
  const sum = d.reduce((acc, n, i) => acc + n * (8 - i), 0);
  const c = (11 - (sum % 11)) % 10;
  return `${d.join("")}${c}`;
}
