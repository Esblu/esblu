// =============================================================================
// Ukončenie firmy (GDPR 2.0 / DPA 2.0, 20261127100000) — potvrdenie oprávnenej osoby. SERVER-ONLY, bez I/O.
//
// DB brána vyžaduje: výslovné vyhlásenie o oprávnení konať za firmu (boolean), verziu a SHA-256 PRESNE
// zobrazeného textu, čas potvrdenia (≤ 15 min) a čerstvé prihlásenie (≤ 30 min). Text a jeho SHA-256 počíta
// server z i18n slovníka (klient posiela iba boolean), takže dôkaz zodpovedá textu, ktorý UI zobrazilo.
// IP a User-Agent sa ukladajú iba ako SHA-256 so soľou viazanou na firmu.
// =============================================================================

import { createHash } from "node:crypto";
import { DEFAULT_LOCALE, type Locale } from "./i18n/locales.ts";
import { hasTranslation, translate } from "./i18n/translate.ts";

export const TERMINATION_AUTHORITY_TEXT_KEY = "settings.termination.authority";
/** Zmena textu vyhlásenia = nová verzia (DB ukladá verziu aj SHA-256). */
export const TERMINATION_AUTHORITY_TEXT_VERSION = "termination-authority-2026-11-23";

export type TerminationAck = {
  authority_confirmed: true;
  text_version: string;
  text_sha256: string;
  confirmed_at: string;
  ip_sha256: string | null;
  user_agent_sha256: string | null;
};

/** Kódy brány ukončenia (DB) — nič sa nezmazalo, klient môže opraviť a zopakovať. */
export const TERMINATION_GATE_ERROR_KEYS: Record<string, string> = {
  ESBLU_TERMINATION_EXPORT_NOT_VERIFIED: "settings.errors.terminationExportNotVerified",
  ESBLU_TERMINATION_EXPORT_STALE: "settings.errors.terminationExportStale",
  ESBLU_TERMINATION_EXPORT_REQUIRED: "settings.errors.terminationExportRequired",
  ESBLU_TERMINATION_ACK_REQUIRED: "settings.errors.terminationAckRequired",
  ESBLU_TERMINATION_REAUTH_REQUIRED: "settings.errors.terminationReauthRequired",
  ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED: "settings.errors.terminationAckRequired",
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function terminationAuthorityStatement(locale: Locale): { version: string; locale: Locale; text: string; sha256: string } {
  const effective: Locale = hasTranslation(locale, TERMINATION_AUTHORITY_TEXT_KEY) ? locale : DEFAULT_LOCALE;
  const text = translate(effective, TERMINATION_AUTHORITY_TEXT_KEY);
  return {
    version: `${TERMINATION_AUTHORITY_TEXT_VERSION}.${effective}`,
    locale: effective,
    text,
    sha256: sha256Hex(`${TERMINATION_AUTHORITY_TEXT_VERSION}\n${effective}\n${text}`),
  };
}

/** Potvrdenie iba ak klient poslal výslovné `authorityConfirmed: true` (nie „truthy“ hodnotu). */
export function buildTerminationAck(
  input: { authorityConfirmed: unknown; locale: Locale; companyId: string; headers: Headers; now?: Date }
): TerminationAck | null {
  if (input.authorityConfirmed !== true) return null;
  const statement = terminationAuthorityStatement(input.locale);
  const ip = (input.headers.get("x-forwarded-for")?.split(",")[0] ?? input.headers.get("x-real-ip") ?? "").trim();
  const ua = (input.headers.get("user-agent") ?? "").trim();
  return {
    authority_confirmed: true,
    text_version: statement.version,
    text_sha256: statement.sha256,
    confirmed_at: (input.now ?? new Date()).toISOString(),
    ip_sha256: ip ? sha256Hex(`esblu-termination-ip:v1:${input.companyId}:${ip}`) : null,
    user_agent_sha256: ua ? sha256Hex(`esblu-termination-ua:v1:${ua.slice(0, 1000)}`) : null,
  };
}
