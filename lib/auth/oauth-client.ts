"use client";

import { supabase } from "@/lib/supabase";
import { publicWebUrl } from "@/lib/public-url";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import {
  normalizeMobileOAuthRedirect,
  oauthFlowForRuntime,
  oauthProvidersForPlatform,
  parseEnabledOAuthProviders,
  readOAuthPending,
  type ClientPlatform,
  type OAuthFlow,
  type OAuthMode,
  type OAuthPending,
  type OAuthProvider,
} from "@/lib/auth/oauth-routing";

// Stav pred odoslaním na Google/Apple — localStorage (nie URL), jednorazový,
// platnosť 15 min. localStorage (nie sessionStorage), lebo návrat z
// poskytovateľa môže na Androide skončiť v inej karte toho istého profilu.
const KEY = "esblu.oauthPending.v1";

function isIosDevice(): boolean {
  return typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function runtimeOAuthFlow(): OAuthFlow {
  if (typeof window === "undefined") return "none";
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return oauthFlowForRuntime({ isCapacitorBuild: IS_MOBILE_BUILD, isIos: isIosDevice(), isStandalone });
}

function runtimePlatform(): ClientPlatform {
  if (!IS_MOBILE_BUILD) return "web";
  return isIosDevice() ? "ios" : "android";
}

/** Ktorí poskytovatelia sú zapnutí (ručné nastavenie v Supabase) a smú sa v tomto prostredí ponúknuť. */
export function enabledOAuthProviders(): OAuthProvider[] {
  if (runtimeOAuthFlow() === "none") return [];
  // Literálny odkaz na premennú — Next.js ju pri builde vloží do bundlu.
  return oauthProvidersForPlatform(runtimePlatform(), parseEnabledOAuthProviders(process.env.NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS));
}

export async function startOAuth(provider: OAuthProvider, options: { mode: OAuthMode; legalAccepted: boolean; inviteToken?: string }): Promise<string | null> {
  // Iba podporovaný a zapnutý poskytovateľ (obrana aj pri priamom volaní).
  if (!enabledOAuthProviders().includes(provider)) return "provider_not_enabled";
  const pending: OAuthPending = { provider, mode: options.mode, legalAccepted: options.legalAccepted, inviteToken: options.inviteToken, at: Date.now() };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Bez úložiska: pozvánka sa po návrate nedá dokončiť automaticky — používateľ
    // ju otvorí znova z odkazu; nič iné sa nemení.
  }
  if (provider === "apple" && runtimePlatform() === "ios") {
    // iOS: natívne Sign in with Apple (ASAuthorization) → signInWithIdToken.
    // Plugin chýba (starší build) → rovnaký systémový prehliadač ako Google.
    const native = await nativeAppleSignIn();
    if (native !== "unavailable") return native;
  }
  if (runtimeOAuthFlow() === "system_browser") {
    // Natívna appka: URL poskytovateľa v systémovom prehliadači (Custom Tab /
    // SFSafariViewController), NIKDY vo WebView. code_verifier ostáva v tomto WebView.
    const redirect = normalizeMobileOAuthRedirect(process.env.NEXT_PUBLIC_ESBLU_MOBILE_OAUTH_REDIRECT);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${redirect}?oauth=${provider}`, skipBrowserRedirect: true },
    });
    if (error || !data?.url) return error?.message ?? "oauth_url_missing";
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url: data.url });
    return null;
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${publicWebUrl("/auth/callback")}?oauth=${provider}` },
  });
  return error ? error.message : null;
}

/** Prečíta a ZMAŽE stav pred OAuth (jednorazový). */
export function takeOAuthPending(): OAuthPending | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    window.localStorage.removeItem(KEY);
    return raw ? readOAuthPending(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Prečíta bez zmazania (onboarding potrebuje iba súhlas). */
export function peekOAuthPending(): OAuthPending | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? readOAuthPending(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

type AppleSignInPlugin = { signIn(options: { nonce: string }): Promise<{ identityToken: string }> };

/**
 * Natívne Sign in with Apple. Výsledok: null = prihlásený (presmerovanie na
 * /auth/callback?oauth=apple, kde prebehne rovnaké smerovanie ako pri Google:
 * členstvo / onboarding / pozvánka), "unavailable" = plugin nie je v builde,
 * inak kód chyby. Bez capability a Apple providera v Supabase zlyhá (fail closed).
 */
async function nativeAppleSignIn(): Promise<string | null | "unavailable"> {
  const { Capacitor, registerPlugin } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("EsbluAppleSignIn")) return "unavailable";
  const { createAppleNonce } = await import("@/lib/auth/apple-nonce");
  const nonce = await createAppleNonce();
  let identityToken: string;
  try {
    ({ identityToken } = await registerPlugin<AppleSignInPlugin>("EsbluAppleSignIn").signIn({ nonce: nonce.hashed }));
  } catch (error) {
    return /CANCELED/.test(String((error as { message?: string })?.message ?? error)) ? "cancelled" : "apple_sign_in_failed";
  }
  const { error } = await supabase.auth.signInWithIdToken({ provider: "apple", token: identityToken, nonce: nonce.raw });
  if (error) return error.message;
  const { navigateHard } = await import("@/lib/app-navigation");
  navigateHard("/auth/callback?oauth=apple");
  return null;
}
