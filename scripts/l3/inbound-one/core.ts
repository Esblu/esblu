// =============================================================================
// L3-ONLY: spracovanie PRESNE JEDNÉHO prijatého dokladu zo sandboxu eFaktura.sk
// (self-send kópia vlastnej L3 faktúry z uzavretého zoznamu L3_INBOUND_TARGETS,
// jeden cieľ na beh) na stagingu esblu-test. NIE JE súčasť appky —
// žiadna route, žiadny cron, žiadny import z app/ ani lib/. Produkčné správanie
// inbound workeru sa NEMENÍ.
//
// Prečo nie /api/cron/einvoice-inbound: poll zaregistruje a spracuje (vrátane
// ACK) VŠETKY nepotvrdené doklady organizácie — v sandboxe čakajú aj 2 staré L2
// dobropisy, ktorých sa nesmieme dotknúť.
//
// Mechanizmus = EXISTUJÚCA produkčná logika, iba zacielená:
//   1) store.register(...)   — tá istá RPC esblu_einvoice_inbound_register ako
//                              poll/webhook, ale IBA pre cieľové provider ID,
//   2) runOperatorAction(... "inbound_reprocess" | "inbound_ack_retry")
//                            — tá istá operátorská akcia ako v UI: DB
//                              esblu_einvoice_operator_begin (autorizácia aktéra
//                              s finance.manage, stav, nárok, lease, cooldown,
//                              audit) → processInboundRow (stiahnutie XML → SHA-256
//                              → nemenný storage → parse → koncept → ACK až po
//                              koncepte). Žiadna paralelná kópia spracovania.
//
// Obrana do hĺbky (nezávisle od logiky vyššie):
//   - poskytovateľ je obalený: povolené je IBA čítanie zoznamu (sandbox +
//     cieľová organizácia), stiahnutie XML a ACK IBA pre cieľové ID (ACK iba v
//     režime run s výslovným potvrdením). Všetko ostatné (send, preflight,
//     status, evidence, provisioning, iné ID) → L3_PROVIDER_CALL_FORBIDDEN,
//   - inbound store: register / transition / koncept IBA pre cieľ a jeho riadok;
//     claim (dávka) a webhook RPC sú zakázané,
//   - outbound store a používateľský klient sú „mŕtve" (akýkoľvek prístup hádže),
//   - ops store: iba operator_begin pre kind=inbound, cieľový riadok, L3 aktéra.
// =============================================================================
import type { EinvoiceProvider, InboundSummary, ProviderContext } from "../../../lib/einvoice/provider/types.ts";
import type { InboundRow, InboundStore, OrganizationWithCompany } from "../../../lib/einvoice/inbound/store.ts";
import type { OpsStore, OperatorAction } from "../../../lib/einvoice/ops/store.ts";
import { runOperatorAction, type OperatorActionResult } from "../../../lib/einvoice/ops/actions.ts";
import { PRODUCTION_REF, STAGING_REF } from "../staging-guard.mjs";

export const L3_STAGING_REF = STAGING_REF; // cjbdijbbcujvmrzezusd
export const L3_PRODUCTION_REF = PRODUCTION_REF; // fkpgvgvsmbpieduoatrt — vždy zakázaný
export const L3_SUPABASE_URL = `https://${STAGING_REF}.supabase.co`;
export const L3_PROVIDER = "efaktura_sk";
export const L3_ENVIRONMENT = "sandbox" as const;
/** Sandbox organizácia firmy A (L2/L3). */
export const L3_SANDBOX_ORG = "b917aa7d-3a88-4518-91b2-2f2ef63db1cb";
/** Firma A (L3 seed). */
export const L3_COMPANY_A = "a1300000-0000-4000-8000-00000000000a";
/** l3-owner@example.com (staging, syntetický) — operátor s finance.manage. */
export const L3_ACTOR_USER_ID = "78cbe0c7-9e71-41ab-90f2-26c4b52e5882";
export const L3_ACTOR_EMAIL = "l3-owner@example.com";
/**
 * UZAVRETÝ zoznam L3 cieľov (self-send kópie vlastných L3 faktúr). Jeden beh =
 * jeden cieľ zvolený výslovne (--target=<číslo>); žiadny „všetko čakajúce".
 * Nový cieľ = vedomá zmena kódu + review, nie parameter z príkazového riadka.
 */
export type L3InboundTarget = { readonly documentNumber: string; readonly providerReceivedId: string };
export const L3_INBOUND_TARGETS: Readonly<Record<string, L3InboundTarget>> = Object.freeze({
  // spracovaný a ACKnutý 2026-10-03 (inbound 6adca190…) — ďalší beh je no-op
  FA20260004: Object.freeze({ documentNumber: "FA20260004", providerReceivedId: "ebcda9cf-d854-48a3-8d30-dde8970f8c78" }),
  // self-send kópia FA20260005 (received_at 2026-10-03T22:22:52.389Z, is_test)
  FA20260005: Object.freeze({ documentNumber: "FA20260005", providerReceivedId: "3c753470-3268-4898-b6bf-3b88dda18229" }),
});
/** Staré L2 dobropisy v tej istej sandbox organizácii — nikdy sa nesmú spracovať ani ACKnúť. */
export const L3_PROTECTED_L2_DOCUMENTS: readonly string[] = [
  "fb37f7bf-f7af-449e-8672-362fef261535", // E2EDOMURFPOCW-20260001
  "1dd69146-ddb3-4c3e-bbb2-6a475ca0adc4", // DO20260001
];

export class L3Stop extends Error {
  constructor(code: string) {
    super(code);
    this.name = "L3Stop";
  }
}

/** Cieľ podľa čísla dokladu — iba zo zoznamu vyššie; chránený L2 doklad nikdy. */
export function resolveL3Target(documentNumber: string | null | undefined): L3InboundTarget {
  const key = (documentNumber ?? "").trim();
  const target = Object.prototype.hasOwnProperty.call(L3_INBOUND_TARGETS, key) ? L3_INBOUND_TARGETS[key] : undefined;
  if (!target) throw new L3Stop("L3_STOP_TARGET_UNKNOWN");
  if (L3_PROTECTED_L2_DOCUMENTS.includes(target.providerReceivedId)) throw new L3Stop("L3_STOP_TARGET_PROTECTED");
  return target;
}

/**
 * Tvrdý guard env (hodnoty sa nikdy nevypisujú — iba kódy). Volá sa PRED
 * vytvorením akéhokoľvek klienta.
 */
export function assertL3InboundEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (k.includes(L3_PRODUCTION_REF) || (v ?? "").includes(L3_PRODUCTION_REF)) throw new L3Stop(`L3_STOP_PRODUCTION_REF:${k}`);
  }
  if ((vars.NEXT_PUBLIC_SUPABASE_URL ?? "").trim() !== L3_SUPABASE_URL) throw new L3Stop("L3_STOP_SUPABASE_URL_NOT_STAGING");
  if ((vars.ESBLU_EINVOICE_ENVIRONMENT ?? "").trim() !== L3_ENVIRONMENT) throw new L3Stop("L3_STOP_ENVIRONMENT_NOT_SANDBOX");
  if ((vars.ESBLU_EINVOICE_PROVIDER ?? "").trim() !== L3_PROVIDER) throw new L3Stop("L3_STOP_PROVIDER_NOT_EFAKTURA_SK");
  if (!(vars.ESBLU_EFAKTURA_API_KEY ?? "").trim().startsWith("efk_pk_test_")) throw new L3Stop("L3_STOP_API_KEY_NOT_SANDBOX");
  const live = (vars.ESBLU_EINVOICE_LIVE_ENABLED ?? "").trim().toLowerCase();
  if (live !== "" && live !== "false") throw new L3Stop("L3_STOP_LIVE_ENABLED");
  if ((vars.VERCEL_ENV ?? "").trim().toLowerCase() === "production") throw new L3Stop("L3_STOP_VERCEL_PRODUCTION");
  const base = (vars.ESBLU_EFAKTURA_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (base && base !== "https://api.efaktura.sk") throw new L3Stop("L3_STOP_BASE_URL");
}

// ---------------------------------------------------------------- guards

export type ProviderCall = { method: string; id: string | null };

function assertCtx(ctx: ProviderContext): void {
  if (ctx.environment !== L3_ENVIRONMENT || ctx.providerOrgId !== L3_SANDBOX_ORG) throw new L3Stop("L3_PROVIDER_CONTEXT_FORBIDDEN");
}

/** Poskytovateľ s allowlistom volaní. `calls` = auditný záznam (iba metóda + ID). */
export function guardProvider(inner: EinvoiceProvider, options: { allowAck: boolean; target: L3InboundTarget }): EinvoiceProvider & { calls: ProviderCall[] } {
  if (inner.name !== L3_PROVIDER) throw new L3Stop("L3_STOP_PROVIDER_NAME");
  const targetId = options.target.providerReceivedId;
  if (L3_PROTECTED_L2_DOCUMENTS.includes(targetId)) throw new L3Stop("L3_STOP_TARGET_PROTECTED");
  const calls: ProviderCall[] = [];
  const forbid = (method: string) => async (): Promise<never> => {
    calls.push({ method: `FORBIDDEN:${method}`, id: null });
    throw new L3Stop(`L3_PROVIDER_CALL_FORBIDDEN:${method}`);
  };
  const onlyTarget = (method: string, id: string) => {
    if (id !== targetId || L3_PROTECTED_L2_DOCUMENTS.includes(id)) {
      calls.push({ method: `FORBIDDEN:${method}`, id });
      throw new L3Stop(`L3_PROVIDER_TARGET_FORBIDDEN:${method}`);
    }
  };
  return {
    name: inner.name,
    calls,
    provisionOrganization: forbid("provisionOrganization"),
    getOrganization: forbid("getOrganization"),
    verifyRecipient: forbid("verifyRecipient"),
    preflight: forbid("preflight"),
    sendUbl: forbid("sendUbl"),
    getOutboundStatus: forbid("getOutboundStatus"),
    getDeliveryEvidence: forbid("getDeliveryEvidence"),
    findSubmissionByIdempotencyKey: forbid("findSubmissionByIdempotencyKey"),
    async listUnacknowledgedInbound(ctx, opts) {
      assertCtx(ctx);
      calls.push({ method: "listUnacknowledgedInbound", id: null });
      return inner.listUnacknowledgedInbound(ctx, opts);
    },
    async getInboundDocument(ctx, id) {
      assertCtx(ctx);
      onlyTarget("getInboundDocument", id);
      calls.push({ method: "getInboundDocument", id });
      return inner.getInboundDocument(ctx, id);
    },
    async acknowledgeInbound(ctx, id) {
      assertCtx(ctx);
      onlyTarget("acknowledgeInbound", id);
      if (!options.allowAck) {
        calls.push({ method: "FORBIDDEN:acknowledgeInbound", id });
        throw new L3Stop("L3_ACK_NOT_AUTHORIZED");
      }
      calls.push({ method: "acknowledgeInbound", id });
      return inner.acknowledgeInbound(ctx, id);
    },
  };
}

/** Inbound store: iba cieľ a jeho jediný riadok. Dávkový claim a webhook RPC sú zakázané. */
export function guardInboundStore(inner: InboundStore, target: L3InboundTarget): InboundStore & { bindRow(id: string): void } {
  const targetId = target.providerReceivedId;
  if (L3_PROTECTED_L2_DOCUMENTS.includes(targetId)) throw new L3Stop("L3_STOP_TARGET_PROTECTED");
  let rowId: string | null = null;
  const own = (id: string) => {
    if (!rowId || id !== rowId) throw new L3Stop("L3_STORE_ROW_FORBIDDEN");
  };
  const forbid = (name: string) => async (): Promise<never> => {
    throw new L3Stop(`L3_STORE_CALL_FORBIDDEN:${name}`);
  };
  return {
    bindRow(id: string) {
      if (rowId && rowId !== id) throw new L3Stop("L3_STORE_ROW_REBIND");
      rowId = id;
    },
    webhookRecord: forbid("webhookRecord"),
    webhookComplete: forbid("webhookComplete"),
    claim: forbid("claim"),
    claimOutboundBySubmission: forbid("claimOutboundBySubmission"),
    async register(input) {
      if (input.providerReceivedId !== targetId || L3_PROTECTED_L2_DOCUMENTS.includes(input.providerReceivedId)) {
        throw new L3Stop("L3_REGISTER_TARGET_FORBIDDEN");
      }
      if (input.provider !== L3_PROVIDER || input.environment !== L3_ENVIRONMENT || input.providerOrgId !== L3_SANDBOX_ORG) {
        throw new L3Stop("L3_REGISTER_CONTEXT_FORBIDDEN");
      }
      return inner.register(input);
    },
    async transition(id, expected, to, source, code, fields) {
      own(id);
      return inner.transition(id, expected, to, source, code, fields);
    },
    async createDraft(id, draft) {
      own(id);
      return inner.createDraft(id, draft);
    },
    findStoredXmlPath: (c, s, e) => inner.findStoredXmlPath(c, s, e),
    organizationFor: (c, e) => inner.organizationFor(c, e),
    listOrganizations: (p, e) => inner.listOrganizations(p, e),
    companyForOrg: (p, e, o) => inner.companyForOrg(p, e, o),
    putXml: (p, b) => inner.putXml(p, b),
    getXml: (p) => inner.getXml(p),
  };
}

/** Ops store: iba operator_begin pre cieľový inbound riadok a L3 aktéra. */
export function guardOpsStore(inner: OpsStore, rowId: () => string | null): OpsStore {
  const forbid = (name: string) => async (): Promise<never> => {
    throw new L3Stop(`L3_OPS_CALL_FORBIDDEN:${name}`);
  };
  return {
    async operatorBegin(input) {
      const allowed: OperatorAction[] = ["inbound_reprocess", "inbound_ack_retry"];
      if (input.kind !== "inbound" || !allowed.includes(input.action) || input.id !== rowId() || input.actorUserId !== L3_ACTOR_USER_ID) {
        throw new L3Stop("L3_OPERATOR_BEGIN_FORBIDDEN");
      }
      return inner.operatorBegin(input);
    },
    health: forbid("health"),
    outcomes24h: forbid("outcomes24h"),
    retention: forbid("retention"),
    storageConsistency: forbid("storageConsistency"),
    recordWebhookRejection: forbid("recordWebhookRejection"),
  };
}

/** Objekt, ktorého akékoľvek použitie zlyhá (outbound store, používateľský klient). */
export function deadObject<T>(name: string): T {
  return new Proxy({} as object, {
    get(_t, prop) {
      if (prop === "then") return undefined; // nie je thenable
      throw new L3Stop(`L3_${name}_FORBIDDEN:${String(prop)}`);
    },
  }) as T;
}

// ---------------------------------------------------------------- run

export type L3InboundReadRow = Pick<
  InboundRow,
  "id" | "company_id" | "provider" | "environment" | "provider_received_id" | "processing_status" | "xml_sha256" | "xml_size_bytes" | "xml_storage_path" | "invoice_id" | "last_error_code" | "locked_until"
> & { acknowledged_at?: string | null };

export type L3InboundDeps = {
  /** Neobalený poskytovateľ (guard sa aplikuje tu, nie u volajúceho). */
  provider: EinvoiceProvider;
  inbound: InboundStore;
  ops: OpsStore;
  /** Read-only: riadok einvoice_inbound podľa provider ID (iba cieľ). */
  readInbound(providerReceivedId: string): Promise<L3InboundReadRow | null>;
  now?: () => Date;
};

export type L3InboundReport = {
  mode: "check" | "run";
  target: string;
  targetDocumentNumber: string;
  listed: number;
  targetListed: boolean;
  targetMeta: Omit<InboundSummary, "providerReceivedId"> | null;
  otherPending: string[];
  protectedSeen: string[];
  stagingBefore: L3InboundReadRow | null;
  action: OperatorAction | null;
  registered: { inboundId: string; created: boolean } | null;
  operator: OperatorActionResult | null;
  stagingAfter: L3InboundReadRow | null;
  providerCalls: ProviderCall[];
  verdict: string;
};

const REPROCESS_STATES = new Set(["received", "stored", "parsed", "failed"]);
const ACK_STATES = new Set(["draft_created", "duplicate", "ack_pending"]);

export async function runL3InboundOne(
  deps: L3InboundDeps,
  options: { mode: "check" | "run"; target: L3InboundTarget; confirmDocument?: string | null }
): Promise<L3InboundReport> {
  // Cieľ musí byť presne položka uzavretého zoznamu (nie ľubovoľný objekt).
  const chosen = resolveL3Target(options.target?.documentNumber);
  if (chosen.providerReceivedId !== options.target.providerReceivedId) throw new L3Stop("L3_STOP_TARGET_UNKNOWN");
  const TARGET_ID = chosen.providerReceivedId;
  if (options.mode === "run" && options.confirmDocument !== TARGET_ID) throw new L3Stop("L3_STOP_CONFIRM_DOCUMENT_MISMATCH");
  const provider = guardProvider(deps.provider, { allowAck: options.mode === "run", target: chosen });
  const inbound = guardInboundStore(deps.inbound, chosen);
  let rowId: string | null = null;
  const ops = guardOpsStore(deps.ops, () => rowId);
  const ctx: ProviderContext = { environment: L3_ENVIRONMENT, providerOrgId: L3_SANDBOX_ORG };

  // 1) organizácia v staging DB = sandbox org firmy A
  const orgs: OrganizationWithCompany[] = await inbound.listOrganizations(L3_PROVIDER, L3_ENVIRONMENT);
  const org = orgs.find((o) => o.providerOrgId === L3_SANDBOX_ORG);
  if (!org || org.companyId !== L3_COMPANY_A) throw new L3Stop("L3_STOP_ORGANIZATION_MISMATCH");

  // 2) zoznam u poskytovateľa (iba čítanie) — nič iné ako cieľ sa ďalej nepoužije
  const list = await provider.listUnacknowledgedInbound(ctx, { limit: 50 });
  const target = list.find((i) => i.providerReceivedId === TARGET_ID) ?? null;
  const others = list.filter((i) => i.providerReceivedId !== TARGET_ID).map((i) => i.providerReceivedId);
  if (target && target.documentNumber && target.documentNumber !== chosen.documentNumber) throw new L3Stop("L3_STOP_TARGET_NUMBER_MISMATCH");

  const before = await deps.readInbound(TARGET_ID);
  if (before && (before.company_id !== L3_COMPANY_A || before.provider !== L3_PROVIDER || before.environment !== L3_ENVIRONMENT)) {
    throw new L3Stop("L3_STOP_STAGING_ROW_MISMATCH");
  }

  const base: L3InboundReport = {
    mode: options.mode,
    target: TARGET_ID,
    targetDocumentNumber: chosen.documentNumber,
    listed: list.length,
    targetListed: !!target,
    targetMeta: target
      ? { senderParticipantId: target.senderParticipantId, senderIco: target.senderIco, documentNumber: target.documentNumber, documentType: target.documentType, receivedAt: target.receivedAt, isTest: target.isTest }
      : null,
    otherPending: others,
    protectedSeen: others.filter((id) => L3_PROTECTED_L2_DOCUMENTS.includes(id)),
    stagingBefore: before,
    action: null,
    registered: null,
    operator: null,
    stagingAfter: before,
    providerCalls: provider.calls,
    verdict: "",
  };

  if (before?.processing_status === "acknowledged") return { ...base, verdict: "ALREADY_ACKNOWLEDGED" };
  if (!before && !target) return { ...base, verdict: "TARGET_NOT_PENDING" };

  const plannedAction: OperatorAction | null = !before || REPROCESS_STATES.has(before.processing_status)
    ? "inbound_reprocess"
    : ACK_STATES.has(before.processing_status) ? "inbound_ack_retry" : null;
  if (!plannedAction) throw new L3Stop(`L3_STOP_UNEXPECTED_STATE:${before?.processing_status}`);
  if (before?.locked_until && new Date(before.locked_until) > (deps.now?.() ?? new Date())) throw new L3Stop("L3_STOP_ROW_LOCKED");

  if (options.mode === "check") return { ...base, action: plannedAction, verdict: before ? "READY_EXISTING_ROW" : "READY_REGISTER_AND_PROCESS" };

  // 3) registrácia IBA cieľa (idempotentná, tá istá RPC ako poll/webhook)
  let registered: L3InboundReport["registered"] = null;
  if (!before) {
    const meta = target
      ? { sender_participant_id: target.senderParticipantId, sender_ico: target.senderIco, document_number: target.documentNumber, document_type: target.documentType, is_test: target.isTest }
      : {};
    const r = await inbound.register({ provider: L3_PROVIDER, environment: L3_ENVIRONMENT, providerOrgId: L3_SANDBOX_ORG, providerReceivedId: TARGET_ID, source: "poll", meta });
    if (r.companyId !== L3_COMPANY_A) throw new L3Stop("L3_STOP_REGISTER_COMPANY_MISMATCH");
    registered = { inboundId: r.inboundId, created: r.created };
    rowId = r.inboundId;
  } else {
    rowId = before.id;
  }
  inbound.bindRow(rowId);

  // 4) existujúca operátorská akcia (lease, audit, processInboundRow, ACK až po koncepte)
  const operator = await runOperatorAction(
    {
      ops,
      inbound,
      outbound: deadObject("OUTBOUND_STORE"),
      userDb: deadObject("USER_DB"),
      runtime: { provider, environment: L3_ENVIRONMENT },
      now: deps.now,
    },
    { userId: L3_ACTOR_USER_ID, kind: "inbound", id: rowId, action: plannedAction, reasonCode: "OPERATOR_REQUEST" }
  );

  const after = await deps.readInbound(TARGET_ID);
  const touched = provider.calls.filter((c) => c.id !== null && c.id !== TARGET_ID);
  if (touched.length > 0) throw new L3Stop("L3_STOP_NON_TARGET_TOUCHED");
  return { ...base, action: plannedAction, registered, operator, stagingAfter: after, verdict: after?.processing_status === "acknowledged" ? "ACKNOWLEDGED" : `STOPPED_AT:${after?.processing_status ?? "?"}` };
}
