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
  | "/login?oauth=beta"
  | `/invite/${string}`;

/**
 * Odmietnutie Auth hookom uzavretej bety (esblu_before_user_created_beta_gate).
 * Supabase ho vráti ako `error=access_denied` (HTTP 403) s textom hooku v
 * `error_description` — bez tohto rozlíšenia by používateľ bez prístupu videl
 * zavádzajúce „Prihlásenie bolo zrušené". Text sa iba porovná, nikdy sa
 * nezobrazí ani nezaloguje.
 */
const BETA_GATE_REJECTION = /uzavretej beta|closed beta|beta verzii|beta access/i;

/**
 * Kam po návrate z Google/Apple. Iba pevné cesty; token pozvánky iba v
 * overenom tvare (64 hex). Zrušenie u poskytovateľa = späť na prihlásenie.
 */
export function decideOAuthDestination(input: {
  providerError: string | null;
  providerErrorDescription?: string | null;
  hasSession: boolean;
  hasActiveMembership: boolean;
  pending: OAuthPending | null;
}): OAuthDestination {
  if (input.providerError) {
    if (input.providerErrorDescription && BETA_GATE_REJECTION.test(input.providerErrorDescription)) {
      return "/login?oauth=beta";
    }
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
/**
 * Poskytovatelia, ktorých appka vôbec smie ponúknuť. Apple (Mobile Platform
 * 2026-10-08) je pripravený, ale FAIL CLOSED: ukáže sa IBA ak ho prevádzka
 * výslovne zapne v NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS — to sa smie až po
 * nastavení Apple providera v Supabase (Services ID, kľúč; APPLE USER ACTION).
 * Uzavretá beta: Apple prihlásenie prejde iba e-mailom z allowlistu —
 * pozvánková výnimka Auth hooku platí iba pre Google (zámerne, samostatná revízia).
 */
export const SUPPORTED_OAUTH_PROVIDERS: readonly OAuthProvider[] = ["google", "apple"];

/** Zapnutí poskytovatelia z konfigurácie (NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS), orezaní na podporovaných. */
export function parseEnabledOAuthProviders(raw: string | undefined | null): OAuthProvider[] {
  const requested = (raw ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  return SUPPORTED_OAUTH_PROVIDERS.filter((provider) => requested.includes(provider));
}

export function oauthAllowedInRuntime(input: { isCapacitorBuild: boolean; isIos: boolean; isStandalone: boolean }): boolean {
  if (input.isCapacitorBuild) return false;
  if (input.isIos && input.isStandalone) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Mobile Platform (2026-10-08): OAuth v natívnej appke cez SYSTÉMOVÝ prehliadač.
//
// Vložený WebView ostáva zakázaný (oauthAllowedInRuntime). Capacitor appka
// otvorí URL poskytovateľa v Chrome Custom Tab / SFSafariViewController
// (@capacitor/browser) — Google to povoľuje (nie je to embedded WebView).
// Návrat: Supabase presmeruje na custom scheme appky → DeepLinkBridge →
// /auth/callback.html?code=… → PKCE výmena v TOM ISTOM WebView, kde je
// uložený code_verifier. Odchytený `code` bez verifiera je bezcenný.
// -----------------------------------------------------------------------------

export type OAuthFlow = "redirect" | "system_browser" | "none";

export function oauthFlowForRuntime(input: { isCapacitorBuild: boolean; isIos: boolean; isStandalone: boolean }): OAuthFlow {
  if (input.isCapacitorBuild) return "system_browser";
  return oauthAllowedInRuntime(input) ? "redirect" : "none";
}

export type ClientPlatform = "web" | "android" | "ios";

/**
 * App Review Guideline 4.8: iOS appka, ktorá ponúka prihlásenie cez tretiu
 * stranu (Google), musí ponúknuť aj rovnocennú možnosť (Sign in with Apple).
 * Kým Apple nie je podporovaný, iOS appka Google NEPONÚKNE (iba e-mail/heslo).
 */
export function oauthProvidersForPlatform(platform: ClientPlatform, enabled: OAuthProvider[]): OAuthProvider[] {
  if (platform === "ios" && enabled.includes("google") && !enabled.includes("apple")) {
    return enabled.filter((provider) => provider !== "google");
  }
  return enabled;
}

/** Predvolený návrat OAuth do natívnej appky (custom scheme = applicationId / bundle id). */
export const DEFAULT_MOBILE_OAUTH_REDIRECT = "com.esblu.app://auth/callback";

/**
 * Návratová URL pre mobilné OAuth. Povolené iba:
 *   - com.esblu.app://auth/callback (custom scheme, PKCE),
 *   - https://www.esblu.com/auth/callback (overený App Link / Universal Link).
 * Čokoľvek iné (iný scheme/host/cesta, query, credentials) → predvolená hodnota.
 */
export function normalizeMobileOAuthRedirect(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_MOBILE_OAUTH_REDIRECT;
  const value = raw.trim();
  if (value === DEFAULT_MOBILE_OAUTH_REDIRECT || value === "https://www.esblu.com/auth/callback") return value;
  return DEFAULT_MOBILE_OAUTH_REDIRECT;
}
