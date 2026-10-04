"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { enabledOAuthProviders, startOAuth } from "@/lib/auth/oauth-client";
import type { OAuthMode, OAuthProvider } from "@/lib/auth/oauth-routing";

// „Pokračovať cez Google". Zobrazí sa IBA pre poskytovateľov zapnutých v
// konfigurácii (NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS) a zároveň podporovaných
// appkou (lib/auth/oauth-routing.ts SUPPORTED_OAUTH_PROVIDERS — dnes iba
// Google; Apple sa neukáže ani pri omylom zapnutej konfigurácii). V Android
// (Capacitor) appke a v iOS PWA sa neukáže vôbec (oauthAllowedInRuntime).
function noopSubscribe(): () => void {
  return () => undefined;
}

export function SocialAuthButtons({
  mode,
  legalAccepted,
  inviteToken,
  disabled = false,
}: {
  mode: OAuthMode;
  legalAccepted: boolean;
  inviteToken?: string;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  // Prostredie (Capacitor / iOS PWA) pozná iba prehliadač — na serveri nič,
  // aby sa prerender a hydratácia nerozišli.
  const providerList = useSyncExternalStore(
    noopSubscribe,
    () => enabledOAuthProviders().join(","),
    () => ""
  );
  const providers = providerList ? (providerList.split(",") as OAuthProvider[]) : [];

  // Návrat tlačidlom Späť z Google (stránka z bfcache) — tlačidlo nesmie
  // ostať navždy v stave „Presmerúvame…".
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) setBusy(null);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  if (providers.length === 0) return null;

  async function go(provider: OAuthProvider) {
    setError("");
    setBusy(provider);
    const failure = await startOAuth(provider, { mode, legalAccepted, inviteToken });
    if (failure) {
      setError(t("auth.oauth.startFailed"));
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 space-y-2">
      <p className="text-center text-xs font-semibold uppercase tracking-wide text-muted-esblu">{t("auth.oauth.or")}</p>
      {providers.map((provider) => (
        <button
          key={provider}
          type="button"
          onClick={() => void go(provider)}
          disabled={disabled || busy !== null}
          aria-busy={busy === provider}
          className="w-full rounded-xl border border-subtle px-6 py-3 font-semibold text-primary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === provider
            ? t("auth.oauth.redirecting")
            : t(provider === "google" ? "auth.oauth.google" : "auth.oauth.apple")}
        </button>
      ))}
      {error && <p className="text-center text-sm text-danger">{error}</p>}
    </div>
  );
}
