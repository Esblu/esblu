"use client";

import { useState, useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { enabledOAuthProviders, startOAuth } from "@/lib/auth/oauth-client";
import type { OAuthMode, OAuthProvider } from "@/lib/auth/oauth-routing";

// „Pokračovať cez Google / Apple". Zobrazí sa IBA pre poskytovateľov
// zapnutých v konfigurácii (NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS) — kým nie sú
// ručne nastavené v Supabase, tlačidlá sa neukážu.
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
          className="w-full rounded-xl border border-subtle px-6 py-3 font-semibold text-primary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t(provider === "google" ? "auth.oauth.google" : "auth.oauth.apple")}
        </button>
      ))}
      {error && <p className="text-center text-sm text-danger">{error}</p>}
    </div>
  );
}
