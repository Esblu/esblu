// =============================================================================
// Google / Apple prihlásenie — čistá logika po návrate z poskytovateľa.
//
// OAuth je IBA overenie totožnosti. O prístupe rozhodujú tie isté pravidlá
// Esblu ako pri e-maile a hesle:
//   - nový účet vytvorí Supabase iba ak prejde Auth hook uzavretej bety
//     (beta allowlist alebo platná pozvánka),
//   - firmu zakladá esblu_ensure_my_owner_company() (znova overí allowlist),
//   - členstvo zamestnanca vzniká až prijatím pozvánky s tokenom z odkazu,
//   - právne dokumenty: súhlas pri registrácii iba ak ho používateľ
//     zaškrtol pred odoslaním na Google/Apple; inak ich vyžiada
//     LegalAcceptanceGate,
//   - presmerovanie iba na pevné cesty Esblu (žiadny parameter „next").
// Modul je čistý (bez prehliadača) kvôli testom.
// =============================================================================

export type OAuthProvider = "google" | "apple";
export type OAuthMode = "login" | "register" | "invite";

export type OAuthPending = {
  provider: OAuthProvider;
  mode: OAuthMode;
  /** Súhlas s podmienkami a zásadami zaškrtnutý PRED odoslaním. */
  legalAccepted: boolean;
  /** Surový token pozvánky z odkazu /invite/<token> (64 hex znakov). */
  inviteToken?: string;
  at: number;
};

const INVITE_TOKEN = /^[0-9a-f]{64}$/;
const PENDING_TTL_MS = 15 * 60 * 1000;

export function isValidInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN.test(value);
}

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return value === "google" || value === "apple";
}

/** Overí tvar a vek uloženého záznamu (sessionStorage je vstup, nie pravda). */
export function readOAuthPending(raw: unknown, now = Date.now()): OAuthPending | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!isOAuthProvider(value.provider)) return null;
  if (value.mode !== "login" && value.mode !== "register" && value.mode !== "invite") return null;
  if (typeof value.at !== "number" || now - value.at > PENDING_TTL_MS || value.at > now + 60_000) return null;
  const inviteToken = isValidInviteToken(value.inviteToken) ? value.inviteToken : undefined;
  if (value.mode === "invite" && !inviteToken) return null;
  return { provider: value.provider, mode: value.mode, legalAccepted: value.legalAccepted === true, inviteToken, at: value.at };
}

export type OAuthDestination =
  | "/"
  | "/onboarding/company"
  | "/login?oauth=cancelled"
  | "/login?oauth=error"
  | `/invite/${string}`;

/**
 * Kam po návrate z Google/Apple. Iba pevné cesty; token pozvánky iba v
 * overenom tvare (64 hex). Zrušenie u poskytovateľa = späť na prihlásenie.
 */
export function decideOAuthDestination(input: {
  providerError: string | null;
  hasSession: boolean;
  hasActiveMembership: boolean;
  pending: OAuthPending | null;
}): OAuthDestination {
  if (input.providerError) {
    return /access_denied|cancel|user_cancelled/i.test(input.providerError) ? "/login?oauth=cancelled" : "/login?oauth=error";
  }
  if (!input.hasSession) return "/login?oauth=error";
  if (input.pending?.inviteToken && isValidInviteToken(input.pending.inviteToken)) {
    return `/invite/${input.pending.inviteToken}`;
  }
  if (input.hasActiveMembership) return "/";
  return "/onboarding/company";
}

/**
 * Zapísať súhlas pri registrácii?
 *
 * E-mail/heslo: áno (checkboxy sú povinné pred signUp). Google/Apple: IBA
 * ak záznam spred OAuth hovorí, že ich používateľ zaškrtol. Ak sa záznam
 * stratil (iný kontext prehliadača, inštalovaná PWA, vypršal), rozhoduje
 * poskytovateľ zo session — súhlas sa NEZAPÍŠE a vyžiada ho
 * LegalAcceptanceGate. Nikdy sa nezapíše súhlas, ktorý nezaznel.
 */
export function mayRecordRegistrationConsent(pending: OAuthPending | null, sessionProvider?: string | null): boolean {
  if (pending) return pending.legalAccepted;
  return !sessionProvider || sessionProvider === "email";
}

/**
 * Smie sa OAuth ponúknuť v tomto prostredí?
 *   - Capacitor (vložený WebView): NIE — Google vložený WebView blokuje a
 *     návrat by skončil v systémovom prehliadači mimo appky.
 *   - iOS nainštalovaná PWA (štandalone): NIE — OAuth sa otvorí v oddelenom
 *     Safari kontexte s inou úložiskou, session by do PWA neprišla.
 *   - bežný prehliadač (Android/iOS/desktop) a Android PWA: áno.
 */
export function oauthAllowedInRuntime(input: { isCapacitorBuild: boolean; isIos: boolean; isStandalone: boolean }): boolean {
  if (input.isCapacitorBuild) return false;
  if (input.isIos && input.isStandalone) return false;
  return true;
}
