import { createHash } from "node:crypto";
import {
  EinvoiceProviderError,
  type DeliveryEvidence,
  type EinvoiceEnvironment,
  type EinvoiceProvider,
  type InboundDocument,
  type InboundSummary,
  type OrganizationInfo,
  type OrganizationProvisionInput,
  type OutboundState,
  type OutboundStatus,
  type PreflightIssue,
  type PreflightResult,
  type ProviderContext,
  type RecipientLookup,
  type SendResult,
  type SendUblInput,
} from "./types.ts";
import { MAX_INBOUND_XML_BYTES } from "../ubl/parse.ts";

// =============================================================================
// eFaktura.sk Agent API — adaptér (Connector cesta, vlastný UBL). SERVER-ONLY.
//
// Zdroj kontraktu: verejná OpenAPI 3.1 špecifikácia
//   https://developers.efaktura.sk/agent-api.en.yaml  (audit 2026-09-30)
// + developers.efaktura.sk/en/docs (connector, preflight, recipient-lookup,
//   receiving, evidence, errors, rate-limits, authentication, changelog).
//
// Použité endpointy:
//   POST /v1/agent/organizations                   org:provision, bez X-Organization-Id, idempotentné podľa IČO
//   GET  /v1/agent/organizations/{id}              partner kľúč, odpoveď NIE JE obalená v `data`
//   GET  /v1/agent/peppol/recipient?peppolId=      invoice:read, vždy 200 (found:false nie je chyba)
//   POST /v1/agent/peppol/preflight                invoice:read, bez zápisu, bez kreditu
//   POST /v1/agent/peppol/connector/send           invoice:send, Idempotency-Key POVINNÝ
//   GET  /v1/agent/peppol/status/{invoiceId}       invoice:read
//   GET  /v1/agent/peppol/sent/{invoiceId}/evidence invoice:read, 404 = ešte žiadny prenos
//   GET  /v1/agent/peppol/received?acknowledged=false
//   GET  /v1/agent/peppol/received/{id}/xml        pôvodný UBL
//   POST /v1/agent/peppol/received/{id}/acknowledge idempotentné
//
// NEPOUŽÍVA sa POST /v1/agent/invoices — Esblu je source of truth faktúry.
// Auto-repair je vždy VYPNUTÝ: poskytovateľ nesmie odoslať iný dokument, než
// aký Esblu vygenerovalo a zahashovalo (needs_repair → rejected).
//
// Bezpečnosť:
//   - kľúč iba v pamäti (privátne pole), nikdy v chybách, logoch ani toJSON,
//   - base URL iba https a iba povolený host (kľúč nesmie odísť inam),
//   - redirect: "error" (kľúč sa neprenesie na presmerovaný host),
//   - timeout, limit veľkosti odpovede, validácia ID pred vložením do cesty,
//   - adaptér NEOPAKUJE požiadavky — retry robí volajúci podľa `retryable`.
// =============================================================================

/** Rovnaký host pre sandbox aj produkciu — prostredie určuje prefix kľúča (Stripe model). */
export const EFAKTURA_BASE_URL = "https://api.efaktura.sk";
export const EFAKTURA_ALLOWED_HOSTS: readonly string[] = ["api.efaktura.sk"];

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_MESSAGE = 300;
const RECEIVED_PAGE_MAX = 100;

export type EfakturaFetch = (input: string, init: RequestInit) => Promise<Response>;

export type EfakturaConfig = {
  /** Partnerský kľúč — iba server, iba z env. Nikdy do DB/logov/klienta. */
  apiKey: string;
  environment: EinvoiceEnvironment;
  /** Voliteľne z env (ESBLU_EFAKTURA_BASE_URL); overí sa proti EFAKTURA_ALLOWED_HOSTS. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Iba pre testy (fake fetch bez siete). */
  fetchImpl?: EfakturaFetch;
};

/** Kľúč musí zodpovedať prostrediu (zdokumentované prefixy partnerských kľúčov). */
export function assertEfakturaKeyMatchesEnvironment(apiKey: string, environment: EinvoiceEnvironment): void {
  const expected = environment === "sandbox" ? "efk_pk_test_" : "efk_pk_live_";
  if (!apiKey.startsWith(expected)) {
    throw new EinvoiceProviderError("EINVOICE_KEY_ENVIRONMENT_MISMATCH", "API kľúč nezodpovedá prostrediu");
  }
}

/** Base URL: iba https, iba povolený host, bez credentials/query/fragmentu. Vráti origin. */
export function resolveEfakturaBaseUrl(raw: string | undefined | null): string {
  const value = (raw ?? "").trim() || EFAKTURA_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EinvoiceProviderError("EINVOICE_BASE_URL_INVALID", "Neplatná base URL poskytovateľa");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new EinvoiceProviderError("EINVOICE_BASE_URL_INVALID", "Base URL musí byť čisté https");
  }
  if (!EFAKTURA_ALLOWED_HOSTS.includes(url.hostname.toLowerCase()) || (url.port && url.port !== "443")) {
    throw new EinvoiceProviderError("EINVOICE_BASE_URL_NOT_ALLOWED", "Host poskytovateľa nie je povolený");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/v1") {
    throw new EinvoiceProviderError("EINVOICE_BASE_URL_INVALID", "Base URL nesmie obsahovať cestu");
  }
  return url.origin;
}

/**
 * Hlavičky požiadavky. `providerOrgId` MUSÍ pochádzať z einvoice_organizations
 * pre firmu overenú na serveri — funkcia ho nikdy neberie z tela požiadavky.
 */
export function buildEfakturaHeaders(input: {
  apiKey: string;
  providerOrgId?: string;
  idempotencyKey?: string;
  contentType?: string;
  accept?: string;
}): Record<string, string> {
  const headers: Record<string, string> = { "X-API-Key": input.apiKey, Accept: input.accept ?? "application/json" };
  if (input.providerOrgId) headers["X-Organization-Id"] = input.providerOrgId;
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
  if (input.contentType) headers["Content-Type"] = input.contentType;
  return headers;
}

/**
 * Stavy GET /peppol/status (+ webhook DELIVERED) → neutrálny stav. Neznámy stav
 * vráti null (docs: neznáme hodnoty ignorovať) — volajúci ho NESMIE hádať.
 * SCHEDULED = zadržané v rade poskytovateľa (send_mode scheduled/manual).
 */
export function mapEfakturaSendState(state: string | null | undefined): OutboundState | null {
  switch (state) {
    case "not_sent": return "pending";
    case "SCHEDULED": return "queued";
    case "QUEUED": return "queued";
    case "SENDING": return "sending";
    case "SENT": return "sent";
    case "DEFERRED": return "deferred";
    case "DELIVERED": return "delivered";
    case "ERROR": return "failed";
    default: return null;
  }
}

/** Výsledky Connector odoslania (PeppolConnectorSendResult.status) → neutrálny stav. */
export function mapEfakturaConnectorStatus(status: string | null | undefined): OutboundState | null {
  switch (status) {
    case "queued": return "queued";
    case "rejected": return "rejected";
    case "validated": return "validated";
    case "staged": return "staged";
    default: return null;
  }
}

/** Peppol participant ID `<4 číslice schémy>:<hodnota>` (napr. 9915:DIČ sandbox, 0245:DIČ live). */
export function isValidParticipantId(value: string): boolean {
  return /^[0-9]{4}:[^\s:]{1,200}$/.test(value);
}

/** Bezpečný identifikátor do cesty URL (UUID a podobné). */
function assertPathId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new EinvoiceProviderError("EINVOICE_INVALID_ID", `${label}: neplatný identifikátor`);
  }
  return encodeURIComponent(value);
}

/** Odstráni čokoľvek, čo vyzerá ako kľúč/tajomstvo, a skráti text od poskytovateľa. */
export function scrubProviderText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/efk_(pk_)?(test|live)_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/whsec_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_ERROR_MESSAGE ? `${cleaned.slice(0, MAX_ERROR_MESSAGE)}…` : cleaned;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function bool(value: unknown): boolean {
  return value === true;
}
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function unwrapData(body: unknown): Record<string, unknown> {
  const root = obj(body);
  if (!root) throw new EinvoiceProviderError("EINVOICE_PROVIDER_BAD_RESPONSE", "Neočakávaná odpoveď poskytovateľa");
  const data = obj(root.data);
  return data ?? root;
}
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** HTTP chyba poskytovateľa → EinvoiceProviderError (bez tajomstiev). */
function errorFromResponse(status: number, body: unknown, retryAfter: string | null): EinvoiceProviderError {
  const root = obj(body);
  const nested = obj(root?.error);
  // Štandard: { error: { code, message } }; výnimka: plochý { error: "CODE", message }.
  const providerCode = str(nested?.code) ?? (typeof root?.error === "string" ? root.error : null);
  const message = scrubProviderText(nested?.message ?? root?.message) ?? `HTTP ${status}`;
  const suffix = providerCode ? ` [${providerCode}]` : "";

  if (status === 401) return new EinvoiceProviderError("EINVOICE_PROVIDER_UNAUTHORIZED", `Poskytovateľ odmietol kľúč${suffix}`);
  if (status === 403) return new EinvoiceProviderError("EINVOICE_PROVIDER_FORBIDDEN", `${message}${suffix}`);
  if (status === 404) return new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_FOUND", `${message}${suffix}`);
  if (status === 409) return new EinvoiceProviderError("EINVOICE_PROVIDER_CONFLICT", `${message}${suffix}`);
  if (status === 402) return new EinvoiceProviderError("EINVOICE_PROVIDER_INSUFFICIENT_CREDIT", `${message}${suffix}`);
  if (status === 429) {
    const seconds = Number(retryAfter);
    const hint = Number.isFinite(seconds) && seconds > 0 ? ` (Retry-After ${Math.min(seconds, 3600)} s)` : "";
    return new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", `Prekročený limit požiadaviek${hint}`, true);
  }
  if (status >= 500) return new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", `${message}${suffix}`, true);
  return new EinvoiceProviderError("EINVOICE_PROVIDER_REJECTED", `${message}${suffix}`);
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new EinvoiceProviderError("EINVOICE_PROVIDER_RESPONSE_TOO_LARGE", "Odpoveď poskytovateľa je príliš veľká");
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new EinvoiceProviderError("EINVOICE_PROVIDER_RESPONSE_TOO_LARGE", "Odpoveď poskytovateľa je príliš veľká");
  }
  return buffer;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return null;
  }
}

type RequestOptions = {
  method: "GET" | "POST";
  path: string;
  ctx?: ProviderContext;
  query?: Record<string, string>;
  json?: unknown;
  idempotencyKey?: string;
  accept?: string;
  maxBytes?: number;
};

export class EfakturaSkProvider implements EinvoiceProvider {
  readonly name = "efaktura_sk";

  readonly #apiKey: string;
  readonly #environment: EinvoiceEnvironment;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: EfakturaFetch;

  constructor(config: EfakturaConfig) {
    if (!config.apiKey) throw new EinvoiceProviderError("EINVOICE_PROVIDER_NOT_CONFIGURED");
    assertEfakturaKeyMatchesEnvironment(config.apiKey, config.environment);
    this.#apiKey = config.apiKey;
    this.#environment = config.environment;
    this.#baseUrl = resolveEfakturaBaseUrl(config.baseUrl);
    this.#timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? Math.min(config.timeoutMs, 120_000) : DEFAULT_TIMEOUT_MS;
    this.#fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Nikdy neprezradí kľúč pri logovaní / serializácii objektu. */
  toJSON() {
    return { name: this.name, environment: this.#environment };
  }

  #assertCtx(ctx: ProviderContext): string {
    if (ctx.environment !== this.#environment) {
      throw new EinvoiceProviderError("EINVOICE_ENVIRONMENT_MISMATCH", "Kontext nezodpovedá prostrediu poskytovateľa");
    }
    assertPathId(ctx.providerOrgId, "providerOrgId");
    return ctx.providerOrgId;
  }

  async #request(options: RequestOptions): Promise<{ status: number; bytes: Uint8Array; contentType: string | null }> {
    const url = new URL(options.path, this.#baseUrl);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

    const headers = buildEfakturaHeaders({
      apiKey: this.#apiKey,
      providerOrgId: options.ctx ? this.#assertCtx(options.ctx) : undefined,
      idempotencyKey: options.idempotencyKey,
      contentType: options.json !== undefined ? "application/json" : undefined,
      accept: options.accept,
    });

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: options.method,
        headers,
        body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new EinvoiceProviderError(
        timeout ? "EINVOICE_PROVIDER_TIMEOUT" : "EINVOICE_PROVIDER_NETWORK",
        timeout ? "Poskytovateľ neodpovedal včas" : "Sieťová chyba pri volaní poskytovateľa",
        true,
      );
    }

    const bytes = await readLimited(response, options.maxBytes ?? MAX_JSON_BYTES);
    if (!response.ok) {
      throw errorFromResponse(response.status, parseJson(bytes), response.headers.get("retry-after"));
    }
    return { status: response.status, bytes, contentType: response.headers.get("content-type") };
  }

  async #json(options: RequestOptions): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.#request(options);
    const parsed = parseJson(res.bytes);
    return { status: res.status, body: unwrapData(parsed) };
  }

  // ---------------------------------------------------------------------------
  // Organizácie
  // ---------------------------------------------------------------------------

  async provisionOrganization(input: OrganizationProvisionInput): Promise<OrganizationInfo> {
    if (input.environment !== this.#environment) {
      throw new EinvoiceProviderError("EINVOICE_ENVIRONMENT_MISMATCH", "Vstup nezodpovedá prostrediu poskytovateľa");
    }
    const name = input.legalName.trim();
    const ico = input.ico.trim();
    if (!name || name.length > 120) throw new EinvoiceProviderError("EINVOICE_INVALID_INPUT", "Názov firmy chýba alebo je príliš dlhý");
    if (!/^[0-9]{6,8}$/.test(ico)) throw new EinvoiceProviderError("EINVOICE_INVALID_INPUT", "Neplatné IČO");

    const payload: Record<string, unknown> = {
      name,
      ico,
      address: {
        street: input.address.street,
        city: input.address.city,
        postalCode: input.address.postalCode,
        country: input.address.countryCode,
      },
    };
    if (input.dic?.trim()) payload.dic = input.dic.trim();
    if (input.icDph?.trim()) payload.ic_dph = input.icDph.trim();

    const { status, body } = await this.#json({ method: "POST", path: "/v1/agent/organizations", json: payload });
    const orgId = str(body.org_id) ?? str(body.organization_id) ?? str(body.id);
    if (!orgId) throw new EinvoiceProviderError("EINVOICE_PROVIDER_BAD_RESPONSE", "Poskytovateľ nevrátil org_id");
    const reused = body.reused === true || status === 200;

    // Detail (participant_id, peppol_status, …) — POST vracia iba org_id/slug/status.
    const detail = await this.getOrganization({ environment: this.#environment, providerOrgId: orgId });
    return { ...detail, reused };
  }

  async getOrganization(ctx: ProviderContext): Promise<OrganizationInfo> {
    this.#assertCtx(ctx);
    const id = assertPathId(ctx.providerOrgId, "providerOrgId");
    // Identifikácia cez cestu; X-Organization-Id sa neposiela (nie je potrebné).
    const { body } = await this.#json({ method: "GET", path: `/v1/agent/organizations/${id}` });
    const participantId = str(body.participant_id);
    return {
      providerOrgId: str(body.organization_id) ?? ctx.providerOrgId,
      participantId: participantId && isValidParticipantId(participantId) ? participantId : null,
      orgStatus: str(body.status),
      peppolStatus: str(body.peppol_status),
      claimStatus: str(body.claim_status),
      peppolEligible: bool(body.peppol_eligible),
      reused: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Odoslanie
  // ---------------------------------------------------------------------------

  async verifyRecipient(ctx: ProviderContext, participantId: string): Promise<RecipientLookup> {
    if (!isValidParticipantId(participantId)) {
      throw new EinvoiceProviderError("EINVOICE_INVALID_PARTICIPANT", "Neplatný Peppol identifikátor príjemcu");
    }
    const { body } = await this.#json({
      method: "GET",
      path: "/v1/agent/peppol/recipient",
      ctx,
      query: { peppolId: participantId },
    });
    const lookupUnavailable = body.lookup_unavailable === true;
    return {
      participantId: str(body.peppol_id) ?? participantId,
      // Pri nedostupnom lookup-e nie je „found" spoľahlivé → nikdy true.
      found: !lookupUnavailable && body.found === true,
      lookupUnavailable,
    };
  }

  async preflight(ctx: ProviderContext, input: { ubl: Uint8Array; receiverParticipantId?: string }): Promise<PreflightResult> {
    const payload = this.#documentPayload(input.ubl, input.receiverParticipantId);
    const { body } = await this.#json({ method: "POST", path: "/v1/agent/peppol/preflight", ctx, json: payload });
    return mapPreflight(body);
  }

  async sendUbl(ctx: ProviderContext, input: SendUblInput): Promise<SendResult> {
    const key = input.idempotencyKey?.trim() ?? "";
    if (key.length < 16 || key.length > 200 || /[^\x21-\x7e]/.test(key)) {
      throw new EinvoiceProviderError("EINVOICE_INVALID_IDEMPOTENCY_KEY", "Idempotency-Key chýba alebo je neplatný");
    }
    // Integrita: poskytovateľovi ide presne ten dokument, ktorý Esblu zahashovalo.
    if (!/^[0-9a-f]{64}$/.test(input.ublSha256) || sha256Hex(input.ubl) !== input.ublSha256) {
      throw new EinvoiceProviderError("EINVOICE_UBL_HASH_MISMATCH", "UBL nezodpovedá uloženému SHA-256");
    }
    const payload = {
      ...this.#documentPayload(input.ubl, input.receiverParticipantId),
      options: { autoRepair: false, validateOnly: false, dispatch: "now" },
    };
    const { body } = await this.#json({
      method: "POST",
      path: "/v1/agent/peppol/connector/send",
      ctx,
      json: payload,
      idempotencyKey: key,
    });

    const state = mapEfakturaConnectorStatus(str(body.status));
    if (!state) {
      throw new EinvoiceProviderError("EINVOICE_PROVIDER_UNKNOWN_STATE", "Neznámy výsledok odoslania — stav sa nemení");
    }
    const invoiceId = str(body.invoice_id);
    if (state === "queued" && !invoiceId) {
      throw new EinvoiceProviderError("EINVOICE_PROVIDER_BAD_RESPONSE", "queued bez invoice_id");
    }
    let rejectReason: string | null = null;
    if (state === "rejected") {
      const reason = scrubProviderText(body.reason) ?? "unknown";
      const detail = scrubProviderText(body.error);
      rejectReason = detail ? `${reason}: ${detail}` : reason;
    }
    return {
      state,
      // invoice_id je kľúč pre /peppol/status a /peppol/sent/{id}/evidence.
      providerSubmissionId: invoiceId,
      providerStagedId: str(body.staged_id),
      rejectReason,
    };
  }

  async getOutboundStatus(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<OutboundStatus> {
    const id = assertPathId(submission.providerSubmissionId, "providerSubmissionId");
    const { body } = await this.#json({ method: "GET", path: `/v1/agent/peppol/status/${id}`, ctx });
    const state = mapEfakturaSendState(str(body.state));
    if (!state) {
      throw new EinvoiceProviderError("EINVOICE_PROVIDER_UNKNOWN_STATE", "Neznámy stav prenosu — stav sa nemení");
    }
    return {
      state,
      receiverIdentifier: str(body.receiver_identifier),
      documentId: str(body.document_id),
      errorMessage: scrubProviderText(body.error_message),
      updatedAt: str(body.updated_at),
    };
  }

  async getDeliveryEvidence(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<DeliveryEvidence | null> {
    const id = assertPathId(submission.providerSubmissionId, "providerSubmissionId");
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.#json({ method: "GET", path: `/v1/agent/peppol/sent/${id}/evidence`, ctx }));
    } catch (error) {
      // 404 = zatiaľ žiadny Peppol prenos (zdokumentované) → žiadny dôkaz.
      if (error instanceof EinvoiceProviderError && error.code === "EINVOICE_PROVIDER_NOT_FOUND") return null;
      throw error;
    }
    const delivery = obj(body.delivery_status);
    const ubl = str(body.ubl_sha256);
    return {
      documentId: str(body.document_id),
      ublSha256: ubl && /^[0-9a-f]{64}$/i.test(ubl) ? ubl.toLowerCase() : null,
      deliveredAt: delivery?.state === "delivered" ? str(delivery.at) : null,
      raw: body,
    };
  }

  // ---------------------------------------------------------------------------
  // Príjem
  // ---------------------------------------------------------------------------

  async listUnacknowledgedInbound(ctx: ProviderContext, options?: { limit?: number }): Promise<InboundSummary[]> {
    const limit = Math.max(1, Math.min(RECEIVED_PAGE_MAX, Math.floor(options?.limit ?? 50)));
    // Stránkovanie: docs (receiving) = limit/offset; OpenAPI uvádza page/per_page.
    // Posielame `limit` — overiť v sandboxe (TODO v reporte).
    const res = await this.#request({
      method: "GET",
      path: "/v1/agent/peppol/received",
      ctx,
      query: { acknowledged: "false", limit: String(limit) },
    });
    const root = obj(parseJson(res.bytes));
    const list = Array.isArray(root?.data) ? (root!.data as unknown[]) : null;
    if (!list) throw new EinvoiceProviderError("EINVOICE_PROVIDER_BAD_RESPONSE", "Neočakávaný zoznam prijatých dokladov");

    const out: InboundSummary[] = [];
    for (const raw of list) {
      const row = obj(raw);
      const id = str(row?.id);
      if (!row || !id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) continue;
      // Obrana: filter acknowledged=false mohol byť ignorovaný.
      if (row.acknowledged_at) continue;
      out.push({
        providerReceivedId: id,
        senderParticipantId: str(row.sender_participant_id),
        senderIco: str(row.sender_ico),
        documentNumber: str(row.document_number),
        documentType: str(row.document_type),
        receivedAt: str(row.received_at),
        isTest: row.is_test === true,
      });
    }
    return out;
  }

  async getInboundDocument(ctx: ProviderContext, providerReceivedId: string): Promise<InboundDocument> {
    const id = assertPathId(providerReceivedId, "providerReceivedId");
    const res = await this.#request({
      method: "GET",
      path: `/v1/agent/peppol/received/${id}/xml`,
      ctx,
      accept: "application/xml",
      maxBytes: MAX_INBOUND_XML_BYTES,
    });
    if (res.bytes.byteLength === 0) {
      throw new EinvoiceProviderError("EINVOICE_PROVIDER_BAD_RESPONSE", "Prázdny UBL od poskytovateľa");
    }
    // PDF poskytovateľa sa nesťahuje: je to render z UBL, nie originál; vizualizáciu robí Esblu.
    return { providerReceivedId, xml: res.bytes, pdf: null };
  }

  async acknowledgeInbound(ctx: ProviderContext, providerReceivedId: string): Promise<void> {
    const id = assertPathId(providerReceivedId, "providerReceivedId");
    const { body } = await this.#json({ method: "POST", path: `/v1/agent/peppol/received/${id}/acknowledge`, ctx });
    if (!str(body.acknowledged_at)) {
      throw new EinvoiceProviderError("EINVOICE_PROVIDER_BAD_RESPONSE", "Potvrdenie prevzatia bez acknowledged_at");
    }
  }

  // ---------------------------------------------------------------------------

  #documentPayload(ubl: Uint8Array, receiverParticipantId?: string): Record<string, unknown> {
    if (!(ubl instanceof Uint8Array) || ubl.byteLength === 0) {
      throw new EinvoiceProviderError("EINVOICE_INVALID_INPUT", "Chýba UBL dokument");
    }
    if (ubl.byteLength > MAX_INBOUND_XML_BYTES) {
      throw new EinvoiceProviderError("EINVOICE_INVALID_INPUT", "UBL dokument je príliš veľký");
    }
    const payload: Record<string, unknown> = { document: { format: "ubl", xmlBase64: toBase64(ubl) } };
    if (receiverParticipantId !== undefined) {
      if (!isValidParticipantId(receiverParticipantId)) {
        throw new EinvoiceProviderError("EINVOICE_INVALID_PARTICIPANT", "Neplatný Peppol identifikátor príjemcu");
      }
      payload.receiverPeppolId = receiverParticipantId;
    }
    return payload;
  }
}

function mapPreflight(body: Record<string, unknown>): PreflightResult {
  const validatorUnavailable = body.validator_unavailable === true;
  const issues: PreflightIssue[] = [];
  if (Array.isArray(body.repair)) {
    for (const raw of body.repair.slice(0, 200)) {
      const r = obj(raw);
      if (!r) continue;
      issues.push({
        code: scrubProviderText(r.code) ?? "UNKNOWN",
        message: scrubProviderText(r.message) ?? "",
        severity: r.severity === "warning" ? "warning" : "error",
        ...(scrubProviderText(r.field) ? { field: scrubProviderText(r.field)! } : {}),
      });
    }
  }
  const hasError = issues.some((i) => i.severity === "error");
  return {
    // Fail-closed: pripravené iba pri explicitnom true, dostupnom validátore a bez chýb.
    sendReady: !validatorUnavailable && body.send_ready === true && !hasError,
    validatorUnavailable,
    issues,
  };
}
