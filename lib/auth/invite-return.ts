// =============================================================================
// Návrat pozvaného používateľa na pozvánku po overení e-mailu.
//
// PREČO
// -----
// Audit 2026-09-26 (P0): signUp() z pozvánky posiela emailRedirectTo na
// /invite/{token}, ale šablóna „Confirm signup" v Supabase vedie na
// {{ .SiteURL }}/auth/callback, ktorý každého posielal do OWNER onboardingu.
// Pozvaný tak buď narazil na beta bránu, alebo si založil vlastnú firmu — a
// pozvánku (jedno aktívne členstvo na používateľa) už nikdy neprijal.
//
// AKO
// ---
// InviteView pri registrácii ukladá token do user_metadata
// (`esblu_invite_token`, už to robil kvôli Auth hooku beta brány). Po
// verifyOtp callback aj onboarding tento token prečítajú z OVERENÉHO
// používateľa (getUser zo servera Supabase) a vrátia ho na pozvánku.
// Funguje aj keď sa e-mail otvorí na inom zariadení (nie je to localStorage).
//
// BEZPEČNOSŤ
//   - token sa prijme iba v presnom tvare (64 hex znakov) → žiadny open
//     redirect, cieľ je vždy pevná cesta /invite/<token> tej istej appky,
//   - token sám nič neudeľuje: esblu_accept_company_invite overí zhodu
//     e-mailu, platnosť, jednorazovosť a oprávnenie pozývajúceho,
//   - token sa po prijatí z metadát odstráni (best effort) a nikdy sa
//     neloguje ani nenecháva v adrese po spracovaní callbacku.
// Server navyše odmietne založiť vlastnú firmu, kým má e-mail platnú
// nevybavenú pozvánku (esblu_ensure_my_owner_company → ESBLU_PENDING_INVITE_EXISTS).
// =============================================================================

const INVITE_TOKEN_FORMAT = /^[0-9a-f]{64}$/;

export const INVITE_TOKEN_METADATA_KEY = "esblu_invite_token";

/** Token pozvánky z user_metadata overeného používateľa — iba v platnom tvare. */
export function pendingInviteTokenFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[INVITE_TOKEN_METADATA_KEY];
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return INVITE_TOKEN_FORMAT.test(token) ? token : null;
}

/** Pevná relatívna cesta na pozvánku (web: /invite/<token>, mobil: /invite?token=). */
export function inviteReturnPath(token: string, isMobileBuild: boolean): string | null {
  if (!INVITE_TOKEN_FORMAT.test(token)) return null;
  return isMobileBuild ? `/invite?token=${token}` : `/invite/${token}`;
}

export function isPendingInviteError(error: unknown): boolean {
  const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : String(error ?? "");
  return message.includes("ESBLU_PENDING_INVITE_EXISTS");
}
