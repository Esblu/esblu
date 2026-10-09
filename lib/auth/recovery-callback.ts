// =============================================================================
// Rozhodnutie /auth/callback pre e-mailové odkazy (fix 2026-10-09, staging).
//
// ROOT CAUSE: esblu-test používa vstavaný Supabase mailer, ktorý posiela
// predvolený odkaz {{ .ConfirmationURL }} (Supabase-hosted /auth/v1/verify →
// 303 na redirect_to), nie appkový token_hash odkaz. Appka posielala
// redirectTo = https://www.esblu.com/auth/callback (nie je v allowliste
// stagingu) → Supabase spadol na Site URL "/" → hlavná stránka, formulár na
// heslo sa nikdy neukázal.
//
// Podporované tvary (všetko ostatné = fail closed):
//   1. ?token_hash=…&type=recovery|email   → verifyOtp (vlastná e-mailová šablóna)
//   2. ?flow=recovery&code=…               → PKCE výmena (kód je bez code_verifiera
//                                            z TOHTO prehliadača bezcenný)
//   3. ?error_code=… / #error_code=…        → zrozumiteľná chyba (napr. otp_expired)
//   4. #access_token=…&type=recovery        → implicitné tokeny v URL sa NEPRIJÍMAJÚ
//                                            (podvrhnuteľné) → „požiadaj o nový odkaz"
// Modul je bez importov (testovateľný v Node).
// =============================================================================

export type EmailCallbackDecision =
  | { kind: "oauth" }
  | { kind: "token_hash"; tokenHash: string; type: "email" | "recovery" }
  | { kind: "pkce_recovery"; code: string }
  | { kind: "error"; reason: "expired" | "invalid" | "unsupported_link" };

function params(raw: string): URLSearchParams {
  return new URLSearchParams(raw.replace(/^[?#]/, ""));
}

export function decideEmailCallback(search: string, hash: string): EmailCallbackDecision {
  const q = params(search);
  const h = params(hash);
  if (q.has("oauth")) return { kind: "oauth" };

  const errorCode = q.get("error_code") ?? h.get("error_code") ?? q.get("error") ?? h.get("error");
  if (errorCode) return { kind: "error", reason: /expired/i.test(errorCode) ? "expired" : "invalid" };

  const tokenHash = q.get("token_hash");
  const type = q.get("type");
  if (tokenHash) {
    if (type === "recovery" || type === "email") return { kind: "token_hash", tokenHash, type };
    return { kind: "error", reason: "invalid" };
  }

  const code = q.get("code");
  if (code && q.get("flow") === "recovery") return { kind: "pkce_recovery", code };

  if (h.has("access_token")) return { kind: "error", reason: "unsupported_link" };
  return { kind: "error", reason: "invalid" };
}

/** Chyba verifyOtp → dôvod pre používateľa (expirovaný vs. neplatný). */
export function reasonForVerifyError(error: { code?: string | null; message?: string | null }): "expired" | "invalid" {
  return /expired/i.test(`${error.code ?? ""} ${error.message ?? ""}`) ? "expired" : "invalid";
}

/** Cieľ po úspešnom overení odkazu. Recovery VŽDY na formulár hesla, nikdy "/". */
export function destinationAfterVerifiedLink(kind: "recovery" | "email"): "/reset-hesla?verified=1" | null {
  return kind === "recovery" ? "/reset-hesla?verified=1" : null;
}

/**
 * Pristál auth odkaz na inej stránke (napr. "/" ako Site URL fallback)?
 * Vtedy ho treba odovzdať /auth/callback namiesto bežného signed-in/out
 * presmerovania (inak recovery skončí na hlavnej stránke).
 */
export function isStrayAuthLanding(search: string, hash: string): boolean {
  const q = params(search);
  const h = params(hash);
  return (
    q.has("token_hash") ||
    q.has("error_code") ||
    h.has("error_code") ||
    (q.get("flow") === "recovery" && q.has("code")) ||
    (h.has("access_token") && h.get("type") === "recovery")
  );
}

/** redirectTo pre resetPasswordForEmail: callback na TOM ISTOM origine (staging/prod/lokál). */
export function recoveryRedirectTo(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/auth/callback?flow=recovery`;
}
