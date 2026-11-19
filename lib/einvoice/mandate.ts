// =============================================================================
// E-Faktúra — elektronické poverenie (mandát) klienta. SERVER-ONLY logika bez I/O.
//
// Dôkaz (einvoice_mandates, migrácia 20261122100000): kto (user id + snapshot mena,
// e-mailu a roly v DB), kedy, akú verziu textu a jeho SHA-256 videl, v akom jazyku,
// rozsah (send / receive), pseudonymizované dôkazy požiadavky (request id, SHA-256
// IP a User-Agent — nikdy surové hodnoty) a SHA-256 odpovede poskytovateľa.
// Overovací kód FS sa sem NIKDY nedostane.
// =============================================================================

import { createHash } from "node:crypto";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales.ts";
import { hasTranslation, translate } from "../i18n/translate.ts";
import type { EinvoiceEnvironment, EnrollStatus, OrganizationInfo } from "./provider/types.ts";
import { EINVOICE_MANDATE_STATEMENT_KEY, EINVOICE_MANDATE_STATEMENT_VERSION } from "./mandate-statement.ts";
export { mandateAllows } from "./mandate-statement.ts";

import type { MandateScope } from "./mandate-statement.ts";
export type { MandateScope };
export type MandateGrantChannel = "enroll" | "regrant" | "operator_backfill";
export type MandateRevokeKind = "user" | "operator" | "provider_event" | "deregistration" | "system";

export type MandateStatement = { version: string; locale: Locale; text: string; sha256: string };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Presný text vyhlásenia v jazyku požiadavky (chýbajúci preklad → SK, a vtedy aj locale = sk). */
export function mandateStatement(locale: Locale): MandateStatement {
  const effective: Locale = hasTranslation(locale, EINVOICE_MANDATE_STATEMENT_KEY) ? locale : DEFAULT_LOCALE;
  const text = translate(effective, EINVOICE_MANDATE_STATEMENT_KEY);
  return {
    version: EINVOICE_MANDATE_STATEMENT_VERSION,
    locale: effective,
    text,
    sha256: sha256Hex(`${EINVOICE_MANDATE_STATEMENT_VERSION}\n${effective}\n${text}`),
  };
}

export type MandateEvidence = { requestId: string | null; ipSha256: string | null; userAgentSha256: string | null };

const PRINTABLE = /^[\x21-\x7e]{1,200}$/;

/**
 * Pseudonymizované dôkazy požiadavky. IP sa hashuje so soľou viazanou na firmu
 * (nie je to anonymizácia — je to osobný údaj v pseudonymizovanej forme; retencia
 * = rozhodnutie prevádzkovateľa). Surová IP ani User-Agent sa neukladajú.
 */
export function requestEvidence(headers: Headers, companyId: string): MandateEvidence {
  const rid = headers.get("x-vercel-id") ?? headers.get("x-request-id");
  const requestId = rid && PRINTABLE.test(rid.trim()) ? rid.trim() : null;
  const ip = (headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "").trim();
  const ua = (headers.get("user-agent") ?? "").trim();
  return {
    requestId,
    ipSha256: ip ? sha256Hex(`esblu-mandate-ip:v1:${companyId}:${ip}`) : null,
    userAgentSha256: ua ? sha256Hex(`esblu-mandate-ua:v1:${ua.slice(0, 1000)}`) : null,
  };
}

/** Kanonický JSON (zoradené kľúče) → SHA-256. Pre normalizované odpovede poskytovateľa. */
export function canonicalSha256(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return sha256Hex(JSON.stringify(canon(value)));
}

/** Účinný rozsah podľa výsledku enroll: send_only = príjem drží iný poskytovateľ. */
export function enrollEffectiveScope(status: EnrollStatus): MandateScope[] {
  return status === "send_only" ? ["send"] : ["send", "receive"];
}

/** Účinný rozsah pri opätovnom udelení pre už registrovanú organizáciu. */
export function regrantEffectiveScope(org: Pick<OrganizationInfo, "peppolEligible">, receptionActive: boolean): MandateScope[] {
  if (!org.peppolEligible) return [];
  return receptionActive ? ["send", "receive"] : ["send"];
}

export function mandateReasonCode(code: string | null | undefined, fallback = "MANDATE_LAPSED"): string {
  const c = (code ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 80);
  return /^[A-Z0-9_]{1,80}$/.test(c) ? c : fallback;
}

export type MandateGrantInput = {
  actorUserId: string;
  companyId: string;
  environment: EinvoiceEnvironment;
  scope: MandateScope[];
  statement: MandateStatement;
  channel: MandateGrantChannel;
  evidence: MandateEvidence;
};

export interface MandateStore {
  /** Zapíše udelenie (ešte nie účinné). Vráti id. */
  grant(input: MandateGrantInput): Promise<string>;
  /** Potvrdenie poskytovateľom → účinný mandát. Idempotentné. */
  confirm(input: { mandateId: string; scope: MandateScope[]; providerOutcome: string; providerResponseSha256: string | null; participantId: string | null }): Promise<void>;
  /** Odvolanie (všetkých neodvolaných v prostredí, alebo jedného). Vráti počet. */
  revoke(input: { companyId: string; environment: EinvoiceEnvironment; kind: MandateRevokeKind; actorUserId: string | null; reasonCode: string; mandateId?: string | null }): Promise<number>;
}

export class MandateStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "MandateStoreError";
    this.code = code;
  }
}
