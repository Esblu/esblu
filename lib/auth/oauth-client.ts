"use client";

import { supabase } from "@/lib/supabase";
import { publicWebUrl } from "@/lib/public-url";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { oauthAllowedInRuntime, readOAuthPending, type OAuthMode, type OAuthPending, type OAuthProvider } from "@/lib/auth/oauth-routing";

// Stav pred odoslaním na Google/Apple — localStorage (nie URL), jednorazový,
// platnosť 15 min. localStorage (nie sessionStorage), lebo návrat z
// poskytovateľa môže na Androide skončiť v inej karte toho istého profilu.
const KEY = "esblu.oauthPending.v1";

function runtimeAllowsOAuth(): boolean {
  if (typeof window === "undefined") return false;
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return oauthAllowedInRuntime({ isCapacitorBuild: IS_MOBILE_BUILD, isIos, isStandalone });
}

/** Ktorí poskytovatelia sú zapnutí (ručné nastavenie v Supabase) a smú sa v tomto prostredí ponúknuť. */
export function enabledOAuthProviders(): OAuthProvider[] {
  if (!runtimeAllowsOAuth()) return [];
  const raw = (process.env.NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS ?? "").toLowerCase();
  return (["google", "apple"] as const).filter((provider) => raw.split(",").map((value) => value.trim()).includes(provider));
}

export async function startOAuth(provider: OAuthProvider, options: { mode: OAuthMode; legalAccepted: boolean; inviteToken?: string }): Promise<string | null> {
  const pending: OAuthPending = { provider, mode: options.mode, legalAccepted: options.legalAccepted, inviteToken: options.inviteToken, at: Date.now() };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Bez úložiska: pozvánka sa po návrate nedá dokončiť automaticky — používateľ
    // ju otvorí znova z odkazu; nič iné sa nemení.
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
