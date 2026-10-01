import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEinvoiceReadiness } from "../readiness-server.ts";
import type { ReadinessResult } from "../readiness.ts";
import { generateUbl } from "../ubl/generate.ts";
import type { EinvoiceEnvironment, EinvoiceProvider, PreflightIssue } from "../provider/types.ts";
import { errorCode } from "./policy.ts";
import { dbErrorCode, outboundUblPath, OutboundStoreError, type OutboundStore } from "./store.ts";

// =============================================================================
// E-Faktúra outbound — používateľská požiadavka „odoslať". SERVER-ONLY.
//
//   JWT (route) → readiness (finance.manage, nárok einvoice, organizácia,
//   EN16931/SK pravidlá — pod RLS volajúceho) → kanonické UBL z NEMENNÉHO
//   snapshotu → SHA-256 → overenie príjemcu u poskytovateľa → preflight →
//   uloženie presných bajtov (cesta adresovaná obsahom, nikdy neprepisuje) →
//   RPC esblu_einvoice_request_outbound (riadok `queued`).
//
// NIČ NEODOSIELA. Odoslanie robí worker. Opakovaná požiadavka (dvojklik)
// vráti existujúci aktívny pokus — žiadny nový dokument, riadok ani kľúč.
// Firma, prostredie, organizácia aj príjemca sú VÝHRADNE serverové údaje.
// =============================================================================

export type OutboundRequestDeps = {
  /** User-scoped klient (Bearer JWT volajúceho) — RLS ostáva autorita. */
  userDb: SupabaseClient;
  /** Privilegovaná serverová vrstva (service_role) — iba RPC + privátny storage. */
  store: OutboundStore;
  /** Poskytovateľ zo serverovej konfigurácie, alebo null (nenakonfigurované). */
  runtime: { provider: EinvoiceProvider; environment: EinvoiceEnvironment } | null;
  env?: Record<string, string | undefined>;
};

export type OutboundRequestInput = { userId: string; invoiceId: string };

export type OutboundApiBody = {
  code: string;
  outbound?: { id: string; state: string };
  readiness?: ReadinessResult;
  /** Strojové kódy (preflight / UBL) — bez textu poskytovateľa. */
  issues?: { code: string; field?: string; severity?: "error" | "warning" }[];
};

export type OutboundRequestResult = { status: number; body: OutboundApiBody };

const ACTIVE_EXCLUDED = new Set(["failed", "rejected"]);
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

function participantOf(party: { electronic_address: string | null; electronic_address_scheme_id: string | null }): string | null {
  const value = party.electronic_address?.trim();
  const scheme = party.electronic_address_scheme_id?.trim();
  if (!value || !scheme) return null;
  const id = `${scheme}:${value}`;
  return /^[0-9]{4}:[^\s:]{1,200}$/.test(id) ? id : null;
}

function preflightIssues(issues: PreflightIssue[]): OutboundApiBody["issues"] {
  return issues.slice(0, 50).map((i) => ({
    code: SAFE_CODE.test(i.code) ? i.code : "PROVIDER_ISSUE",
    severity: i.severity,
    ...(i.field && /^[A-Za-z0-9_.:/[\]-]{1,120}$/.test(i.field) ? { field: i.field } : {}),
  }));
}

function statusForDbCode(code: string): number {
  if (code.startsWith("ENTITLEMENT_DENIED")) return 403;
  if (code === "ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED" || code === "ESBLU_NO_ACTIVE_COMPANY") return 403;
  if (code === "NOT_AUTHENTICATED") return 401;
  if (code === "ESBLU_INVOICE_NOT_FOUND") return 404;
  if (code.startsWith("ESBLU_EINVOICE_")) return 409;
  return 500;
}

async function findActiveOutbound(userDb: SupabaseClient, invoiceId: string): Promise<{ id: string; state: string } | null | "error"> {
  const { data, error } = await userDb
    .from("einvoice_outbound")
    .select("id, state, attempt")
    .eq("invoice_id", invoiceId)
    .returns<{ id: string; state: string; attempt: number }[]>();
  if (error) return "error";
  const active = (data ?? []).filter((r) => !ACTIVE_EXCLUDED.has(r.state)).sort((a, b) => b.attempt - a.attempt)[0];
  return active ? { id: active.id, state: active.state } : null;
}

export async function requestOutboundForInvoice(deps: OutboundRequestDeps, input: OutboundRequestInput): Promise<OutboundRequestResult> {
  // 1) Readiness pod RLS volajúceho (finance.manage, nárok, organizácia, doklad).
  const loaded = await loadEinvoiceReadiness(deps.userDb, input.invoiceId, deps.env ?? process.env);
  if (!loaded.ok) return { status: loaded.status, body: { code: loaded.code } };
  const { result: readiness, context } = loaded;

  if (readiness.mode !== "pre_send" || !context.finalizedSnapshot) {
    return { status: 409, body: { code: "INVOICE_NOT_FINALIZED", readiness } };
  }
  if (!readiness.ready) {
    const access = readiness.issues.find((i) => i.category === "access" || i.category === "entitlement");
    return { status: access ? 403 : 422, body: { code: access ? access.code : "READINESS_FAILED", readiness } };
  }

  // 2) Idempotencia požiadavky: aktívny pokus už existuje → vrátiť ho, nič nové.
  const existing = await findActiveOutbound(deps.userDb, input.invoiceId);
  if (existing === "error") return { status: 500, body: { code: "QUERY_FAILED" } };
  if (existing) return { status: 200, body: { code: "ALREADY_REQUESTED", outbound: existing, readiness } };

  // 3) Serverová konfigurácia poskytovateľa a organizácia firmy.
  const runtime = deps.runtime;
  const org = context.organization;
  if (!runtime || !context.environment || runtime.environment !== context.environment) {
    return { status: 503, body: { code: "PROVIDER_NOT_CONFIGURED", readiness } };
  }
  if (!org || !org.providerOrgId || org.provider !== runtime.provider.name) {
    return { status: 409, body: { code: "ORGANIZATION_NOT_READY", readiness } };
  }
  const ctx = { environment: runtime.environment, providerOrgId: org.providerOrgId };

  // 4) Kanonické UBL z nemenného snapshotu + SHA-256.
  const ubl = generateUbl(context.finalizedSnapshot);
  if (!ubl.ok) {
    return { status: 422, body: { code: "UBL_NOT_READY", issues: ubl.issues.map((i) => ({ code: i.code, severity: "error" as const })), readiness } };
  }

  // 5) Príjemca: odvodený zo snapshotu, použije sa IBA po potvrdení poskytovateľom.
  const receiver = participantOf(context.finalizedSnapshot.buyer);
  if (!receiver) return { status: 422, body: { code: "RECIPIENT_INVALID", readiness } };
  try {
    const lookup = await runtime.provider.verifyRecipient(ctx, receiver);
    if (lookup.lookupUnavailable) return { status: 503, body: { code: "RECIPIENT_LOOKUP_UNAVAILABLE", readiness } };
    if (!lookup.found) return { status: 422, body: { code: "RECIPIENT_NOT_FOUND", readiness } };
  } catch (error) {
    return { status: 502, body: { code: errorCode(error), readiness } };
  }

  // 6) Preflight poskytovateľa (bez zápisu, bez kreditu) — musí prejsť.
  try {
    const preflight = await runtime.provider.preflight(ctx, { ubl: ubl.bytes, receiverParticipantId: receiver });
    if (preflight.validatorUnavailable) return { status: 503, body: { code: "PREFLIGHT_UNAVAILABLE", readiness } };
    if (!preflight.sendReady) {
      return { status: 422, body: { code: "PREFLIGHT_FAILED", issues: preflightIssues(preflight.issues), readiness } };
    }
  } catch (error) {
    return { status: 502, body: { code: errorCode(error), readiness } };
  }

  // 7) Presné bajty do privátneho storage (adresované obsahom; existujúci objekt sa overí, nikdy neprepíše).
  const path = outboundUblPath(context.companyId, input.invoiceId, ubl.sha256);
  try {
    const put = await deps.store.putUbl(path, ubl.bytes);
    if (put === "exists") {
      const stored = await deps.store.getUbl(path);
      if (!stored || createHash("sha256").update(stored).digest("hex") !== ubl.sha256) {
        return { status: 500, body: { code: "STORAGE_INTEGRITY_ERROR" } };
      }
    }
  } catch {
    return { status: 500, body: { code: "STORAGE_WRITE_FAILED" } };
  }

  // 8) Riadok `queued` (RPC: autorizácia aktéra, nárok, nemenná väzba, idempotencia).
  try {
    const queued = await deps.store.requestOutbound({
      actorUserId: input.userId,
      invoiceId: input.invoiceId,
      environment: runtime.environment,
      ublSha256: ubl.sha256,
      ublStoragePath: path,
      ublSizeBytes: ubl.bytes.byteLength,
      receiverParticipantId: receiver,
    });
    return {
      status: queued.created ? 202 : 200,
      body: { code: queued.created ? "QUEUED" : "ALREADY_REQUESTED", outbound: { id: queued.outboundId, state: queued.state }, readiness },
    };
  } catch (error) {
    const code = error instanceof OutboundStoreError ? error.code : dbErrorCode(error instanceof Error ? error.message : null);
    return { status: statusForDbCode(code), body: { code, readiness } };
  }
}
