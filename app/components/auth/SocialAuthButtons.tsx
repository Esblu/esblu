"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { enabledOAuthProviders, startOAuth } from "@/lib/auth/oauth-client";
import type { OAuthMode, OAuthProvider } from "@/lib/auth/oauth-routing";
import { IS_MOBILE_BUILD } from "@/lib/build-target";

// „Pokračovať cez Google / Apple". Zobrazí sa IBA pre poskytovateľov zapnutých
// v konfigurácii (NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS) a podporovaných appkou
// (lib/auth/oauth-routing.ts). Natívna appka: systémový prehliadač / natívne
// Sign in with Apple; iOS skryje Google, kým nie je zapnutý Apple (4.8);
// iOS PWA: nič (oauthFlowForRuntime).
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

  // Natívna appka: zatvorenie Custom Tab / SFSafariViewController bez
  // dokončenia prihlásenia → tlačidlo sa odblokuje (Mobile Platform).
  useEffect(() => {
    if (!IS_MOBILE_BUILD) return;
    let handle: { remove: () => void } | undefined;
    let cancelled = false;
    void import("@capacitor/browser").then(({ Browser }) =>
      Browser.addListener("browserFinished", () => setBusy(null)).then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
    );
    return () => {
      cancelled = true;
      handle?.remove();
    };
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
          className={
            provider === "apple"
              ? // Apple HIG: čierne tlačidlo s logom Apple, rovnako výrazné ako ostatné voľby.
                "flex w-full items-center justify-center gap-2 rounded-xl bg-black px-6 py-3 font-semibold text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
              : "w-full rounded-xl border border-subtle px-6 py-3 font-semibold text-primary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          }
        >
          {provider === "apple" && (
            <svg aria-hidden="true" viewBox="0 0 814 1000" className="h-4 w-4 fill-current">
              <path d="M788 341c-6 4-108 62-108 190 0 148 130 200 134 202-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-165-40c-77 0-104 41-166 41s-106-57-156-128C44 789 0 671 0 559 0 379 117 284 232 284c61 0 112 40 150 40 37 0 94-42 164-42 26 0 122 2 185 95zM554 160c29-34 49-82 49-129 0-7-1-13-2-18-47 2-102 31-136 70-26 30-51 78-51 126 0 7 1 15 2 17 3 1 8 1 12 1 42 0 95-28 126-67z" />
            </svg>
          )}
          {busy === provider
            ? t("auth.oauth.redirecting")
            : t(provider === "google" ? "auth.oauth.google" : "auth.oauth.apple")}
        </button>
      ))}
      {error && <p className="text-center text-sm text-danger">{error}</p>}
    </div>
  );
}
