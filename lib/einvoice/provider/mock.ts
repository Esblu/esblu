import { createHash } from "node:crypto";
import {
  EinvoiceProviderError,
  type DeliveryEvidence,
  type EinvoiceProvider,
  type InboundDocument,
  type InboundSummary,
  type OrganizationInfo,
  type OrganizationProvisionInput,
  type OutboundStatus,
  type PreflightResult,
  type ProviderContext,
  type RecipientLookup,
  type SendResult,
  type SendUblInput,
} from "./types.ts";
import { sanitizeDeliveryEvidence } from "../evidence.ts";

// =============================================================================
// MockEinvoiceProvider — iba pre testy a lokálny vývoj. Žiadna sieť, žiadne
// tajomstvá. Napodobňuje zdokumentované správanie, na ktorom Esblu stavia:
//   - založenie organizácie je idempotentné podľa IČO,
//   - odoslanie s rovnakým Idempotency-Key a rovnakým UBL vráti ten istý
//     výsledok; rovnaký kľúč s iným UBL = konflikt (EINVOICE_IDEMPOTENCY_CONFLICT),
//   - každá operácia je viazaná na organizáciu (cudzia organizácia = NOT_FOUND).
// =============================================================================

type Submission = { orgId: string; sha256: string; submissionId: string; state: SendResult["state"] };

export class MockEinvoiceProvider implements EinvoiceProvider {
  readonly name = "mock";
  private orgsByIco = new Map<string, OrganizationInfo>();
  private orgs = new Map<string, OrganizationInfo>();
  private submissions = new Map<string, Submission>();
  private inbound = new Map<string, { orgId: string; summary: InboundSummary; doc: InboundDocument; acknowledged: boolean }>();
  readonly calls: string[] = [];

  private id(prefix: string, value: string): string {
    return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  }

  private requireOrg(ctx: ProviderContext): OrganizationInfo {
    const org = this.orgs.get(`${ctx.environment}:${ctx.providerOrgId}`);
    if (!org) throw new EinvoiceProviderError("EINVOICE_ORGANIZATION_NOT_FOUND");
    return org;
  }

  async provisionOrganization(input: OrganizationProvisionInput): Promise<OrganizationInfo> {
    this.calls.push("provisionOrganization");
    const key = `${input.environment}:${input.ico}`;
    const existing = this.orgsByIco.get(key);
    if (existing) return { ...existing, reused: true };
    const orgId = this.id("org", key);
    // DIČ musí mať 10 číslic, inak sa organizácia na Peppol nezapíše (správanie z dokumentácie poskytovateľa).
    const eligible = !!input.dic && /^\d{10}$/.test(input.dic);
    const info: OrganizationInfo = {
      providerOrgId: orgId,
      participantId: eligible ? `${input.environment === "sandbox" ? "9915" : "0245"}:${input.dic}` : null,
      orgStatus: "active",
      peppolStatus: eligible ? "active" : null,
      claimStatus: eligible ? "claimed" : null,
      peppolEligible: eligible,
      reused: false,
    };
    this.orgsByIco.set(key, info);
    this.orgs.set(`${input.environment}:${orgId}`, info);
    return info;
  }

  async getOrganization(ctx: ProviderContext): Promise<OrganizationInfo> {
    this.calls.push("getOrganization");
    return { ...this.requireOrg(ctx), reused: false };
  }

  async verifyRecipient(ctx: ProviderContext, participantId: string): Promise<RecipientLookup> {
    this.calls.push("verifyRecipient");
    this.requireOrg(ctx);
    const known = [...this.orgs.values()].some((o) => o.participantId === participantId);
    return { participantId, found: known, lookupUnavailable: false };
  }

  async preflight(ctx: ProviderContext, input: { ubl: Uint8Array }): Promise<PreflightResult> {
    this.calls.push("preflight");
    this.requireOrg(ctx);
    const ok = input.ubl.byteLength > 0;
    return { sendReady: ok, validatorUnavailable: false, issues: ok ? [] : [{ code: "EMPTY", message: "empty", severity: "error" }] };
  }

  async sendUbl(ctx: ProviderContext, input: SendUblInput): Promise<SendResult> {
    this.calls.push("sendUbl");
    this.requireOrg(ctx);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) {
      throw new EinvoiceProviderError("EINVOICE_IDEMPOTENCY_KEY_INVALID");
    }
    const actual = createHash("sha256").update(input.ubl).digest("hex");
    if (actual !== input.ublSha256) throw new EinvoiceProviderError("EINVOICE_UBL_HASH_MISMATCH");
    const existing = this.submissions.get(input.idempotencyKey);
    if (existing) {
      if (existing.sha256 !== actual || existing.orgId !== ctx.providerOrgId) {
        throw new EinvoiceProviderError("EINVOICE_IDEMPOTENCY_CONFLICT");
      }
      return { state: existing.state, providerSubmissionId: existing.submissionId, providerStagedId: null, rejectReason: null };
    }
    const submissionId = this.id("sub", `${ctx.providerOrgId}:${input.idempotencyKey}`);
    this.submissions.set(input.idempotencyKey, { orgId: ctx.providerOrgId, sha256: actual, submissionId, state: "queued" });
    return { state: "queued", providerSubmissionId: submissionId, providerStagedId: null, rejectReason: null };
  }

  private findSubmission(ctx: ProviderContext, submissionId: string): Submission {
    const s = [...this.submissions.values()].find((x) => x.submissionId === submissionId && x.orgId === ctx.providerOrgId);
    if (!s) throw new EinvoiceProviderError("EINVOICE_SUBMISSION_NOT_FOUND");
    return s;
  }

  /** Testovací pomocník: posunie stav podania (napr. na „delivered"). */
  setSubmissionState(submissionId: string, state: SendResult["state"]): void {
    for (const s of this.submissions.values()) if (s.submissionId === submissionId) s.state = state;
  }

  async getOutboundStatus(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<OutboundStatus> {
    this.calls.push("getOutboundStatus");
    const s = this.findSubmission(ctx, submission.providerSubmissionId);
    return { state: s.state, receiverIdentifier: null, documentId: s.state === "delivered" ? `doc_${s.submissionId}` : null, errorMessage: null, updatedAt: null };
  }

  async getDeliveryEvidence(ctx: ProviderContext, submission: { providerSubmissionId: string }): Promise<DeliveryEvidence | null> {
    this.calls.push("getDeliveryEvidence");
    const s = this.findSubmission(ctx, submission.providerSubmissionId);
    if (s.state !== "delivered") return null;
    const record = sanitizeDeliveryEvidence({
      invoice_id: s.submissionId,
      document_id: `doc_${s.submissionId}`,
      ubl_sha256: s.sha256,
      delivery_status: { state: "delivered", at: "2026-01-01T00:00:00Z" },
    });
    return { documentId: record.document_id, ublSha256: record.ubl_sha256, deliveredAt: record.delivered_at, record };
  }

  /** Testovací pomocník: vloží prijatý doklad pre organizáciu. */
  addInbound(ctx: ProviderContext, summary: InboundSummary, xml: Uint8Array, pdf: Uint8Array | null = null): void {
    this.inbound.set(`${ctx.environment}:${summary.providerReceivedId}`, {
      orgId: ctx.providerOrgId,
      summary,
      doc: { providerReceivedId: summary.providerReceivedId, xml, pdf },
      acknowledged: false,
    });
  }

  private findInbound(ctx: ProviderContext, id: string) {
    const entry = this.inbound.get(`${ctx.environment}:${id}`);
    if (!entry || entry.orgId !== ctx.providerOrgId) throw new EinvoiceProviderError("EINVOICE_INBOUND_NOT_FOUND");
    return entry;
  }

  async listUnacknowledgedInbound(ctx: ProviderContext, options?: { limit?: number }): Promise<InboundSummary[]> {
    this.calls.push("listUnacknowledgedInbound");
    this.requireOrg(ctx);
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    return [...this.inbound.values()]
      .filter((e) => e.orgId === ctx.providerOrgId && !e.acknowledged)
      .map((e) => e.summary)
      .slice(0, limit);
  }

  async getInboundDocument(ctx: ProviderContext, providerReceivedId: string): Promise<InboundDocument> {
    this.calls.push("getInboundDocument");
    return this.findInbound(ctx, providerReceivedId).doc;
  }

  async acknowledgeInbound(ctx: ProviderContext, providerReceivedId: string): Promise<void> {
    this.calls.push("acknowledgeInbound");
    this.findInbound(ctx, providerReceivedId).acknowledged = true; // idempotentné
  }
}
