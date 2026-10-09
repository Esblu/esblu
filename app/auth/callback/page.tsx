"use client";

import { useEffect, useState } from "react";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { inviteReturnPath, pendingInviteTokenFromMetadata } from "@/lib/auth/invite-return";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { peekOAuthPending, takeOAuthPending } from "@/lib/auth/oauth-client";
import { decideOAuthDestination } from "@/lib/auth/oauth-routing";
import { getMyActiveMembership } from "@/lib/company";
import { decideEmailCallback, destinationAfterVerifiedLink, reasonForVerifyError } from "@/lib/auth/recovery-callback";

// =============================================================================
// Esblu — Dedikovaný Auth Callback (RELEASE BLOCKER FIX, 2026-08-31)
// =============================================================================
// ROOT CAUSE (pôvodný bug, pre kontext): signup confirmation aj reset-hesla
// odkazy predtým smerovali priamo na /onboarding/company resp. /reset-hesla,
// kde sa dôverovalo supabase.auth.getSession() bez akéhokoľvek overenia, že
// táto session naozaj vznikla PRÁVE spracovaním tohto konkrétneho odkazu.
// Ak mal používateľ v prehliadači aktívnu session INÉHO účtu, mohol po
// kliknutí na potvrdzovací odkaz ticho skončiť pokračujúci ako TEN pôvodný,
// iný účet. Dátová integrita/RLS/company_id izolácia touto chybou nikdy
// nebola narušená (esblu_ensure_my_owner_company je pre existujúceho ownera
// čistý no-op) — išlo o session/navigačnú chybu.
//
// ARCHITEKTÚRA (finálna, TokenHash — nahrádza pôvodný PKCE
// exchangeCodeForSession()/expected_email návrh): Supabase Email Templates
// (Dashboard, upravené manuálne — pozri poznámku na konci tohto komentára)
// odkazujú PRIAMO na túto stránku tvaru
// `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email`
// (signup) alebo `...&type=recovery` (reset hesla) — NIE cez Supabase-hosted
// `/auth/v1/verify?...&redirect_to=...` presmerovanie. Vďaka tomu:
//   - `token_hash` je samostatný, zo servera priamo overiteľný dôkaz — jeho
//     platnosť sa ustanovuje explicitným volaním supabase.auth.verifyOtp()
//     (priamy POST na Supabase Auth server), nikdy sa nečaká na ambientné
//     spracovanie URL a nikdy sa nedôveruje getSession().
//   - žiadna závislosť na PKCE code_verifier uloženom v konkrétnom
//     prehliadači/zariadení — potvrdenie preto funguje aj vtedy, keď
//     registrácia začala na PC a potvrdzovací e-mail sa otvorí na mobile
//     alebo v inom prehliadači (bežný, legitímny scenár pre Esblu).
//   - žiadny "expected_email" cross-check nie je potrebný — verifyOtp() je
//     sama osebe dostatočným dôkazom identity (server vráti session presne
//     pre účet, ktorému token_hash patrí, nič sa neodvodzuje z client-
//     controlled query parametra).
//   - `lib/supabase.ts` nepotrebuje žiadnu špeciálnu `flowType`/
//     `detectSessionInUrl` konfiguráciu kvôli tejto stránke — token_hash flow
//     je na nich úplne nezávislý. app/invite/InviteView.tsx (jediné iné
//     miesto v appke s emailRedirectTo signUp() volaním) touto zmenou nie je
//     dotknutý.
//
// FAIL CLOSED (bezpodmienečne, v každom z týchto prípadov):
//   - chýbajúci token_hash,
//   - `type` iný než presne "email" (signup) alebo "recovery",
//   - verifyOtp() vráti chybu,
//   - getUser() (nezávislé, server-side potvrdenie identity PO verifyOtp())
//     vráti chybu alebo žiadneho používateľa.
// V každom z týchto prípadov sa NIKDY nezavolá getSession() ani sa
// nepokračuje na základe akejkoľvek existujúcej/ambientnej session.
//
// Token/hash sa nikde nelogujú. Po úspechu sa URL vyčistí
// (history.replaceState) skôr, než appka pokračuje ďalej.
//
// MANUÁLNA ZMENA V SUPABASE DASHBOARDE (Authentication → Email Templates) —
// nutná podmienka pre funkčnosť, appka sama túto konfiguráciu zmeniť nevie:
//   Confirm signup:   {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email
//   Reset Password:   {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery
//   Invite user:      NEMENENÉ (vlastný, nezávislý flow — pozri
//                      app/invite/InviteView.tsx).
// =============================================================================

type CallbackState = "processing" | "failed";
type FailureReason = "expired" | "invalid" | "unsupported_link";

export default function AuthCallbackPage() {
  const router = useRouter();
  const { t } = useLocale();
  const [state, setState] = useState<CallbackState>("processing");
  const [failure, setFailure] = useState<FailureReason>("invalid");

  function fail(reason: FailureReason) {
    // Token/kód/chyba sa nesmú držať v adrese ani v histórii.
    window.history.replaceState(null, "", window.location.pathname);
    setFailure(reason);
    setState("failed");
  }

  // Zámerne žiadny synchrónny setState pred prvým await (rovnaký vzor ako
  // runBootstrap() v app/onboarding/company/page.tsx) — funkcia je
  // deklarovaná PRED useEffect nižšie, ktorý ju volá.
  async function handleCallback() {
    if (typeof window === "undefined") {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);

    // --- Návrat z Google (OAuth, PKCE — lib/supabase.ts). Supabase klient
    // vymení jednorazový `?code=` za session sám (detectSessionInUrl) a IBA
    // s code_verifierom z tohto prehliadača; tu sa iba rozhodne, kam
    // ďalej — výhradne na pevné cesty Esblu (lib/auth/oauth-routing.ts).
    // Žiadny parameter next/returnTo/redirectTo sa nečíta.
    if (searchParams.has("oauth")) {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const providerError = searchParams.get("error") ?? hash.get("error") ?? searchParams.get("error_code") ?? hash.get("error_code");
      // Iba na rozlíšenie odmietnutia uzavretou betou; nezobrazuje sa ani neloguje.
      const providerErrorDescription = searchParams.get("error_description") ?? hash.get("error_description");
      const pending = peekOAuthPending();
      let hasSession = false;
      let hasActiveMembership = false;
      if (!providerError) {
        // Výsledok výmeny kódu (PKCE). Ak zlyhala (chýba code_verifier, kód
        // vypršal/použitý, podvrhnutý odkaz), NEPOKRAČUJE sa na základe
        // prípadnej staršej session iného účtu v tomto prehliadači.
        const { error: initError } = await supabase.auth.initialize();
        const { data: userData, error: userError } = initError ? { data: { user: null }, error: initError } : await supabase.auth.getUser();
        hasSession = !initError && !userError && Boolean(userData.user);
        if (hasSession) hasActiveMembership = Boolean(await getMyActiveMembership().catch(() => null));
      }
      // Tokeny ani chyby poskytovateľa nesmú ostať v adrese ani v histórii.
      window.history.replaceState(null, "", window.location.pathname);
      const destination = decideOAuthDestination({ providerError, providerErrorDescription, hasSession, hasActiveMembership, pending });
      // Záznam si prečíta a zmaže onboarding (súhlas pri registrácii);
      // inde sa zmaže hneď.
      if (destination !== "/onboarding/company") takeOAuthPending();
      router.replace(destination);
      return;
    }

    // Fix 2026-10-09: rozhodnutie podľa tvaru odkazu (lib/auth/recovery-callback.ts).
    const decision = decideEmailCallback(window.location.search, window.location.hash);

    if (decision.kind === "error") {
      fail(decision.reason);
      return;
    }

    if (decision.kind === "pkce_recovery") {
      // Reset hesla cez vstavaný Supabase mailer: ?code= sa vymení za session
      // IBA s code_verifierom uloženým v TOMTO prehliadači pri žiadosti o
      // reset (supabase-js detectSessionInUrl, PKCE). Cudzí/podvrhnutý kód
      // ani kód otvorený v inom prehliadači neprejde — fail closed.
      const { error: initError } = await supabase.auth.initialize();
      const { data: userData, error: userError } = initError
        ? { data: { user: null }, error: initError }
        : await supabase.auth.getUser();
      if (initError || userError || !userData.user) {
        fail("invalid");
        return;
      }
      window.history.replaceState(null, "", window.location.pathname);
      router.replace(destinationAfterVerifiedLink("recovery")!);
      return;
    }

    if (decision.kind === "oauth") {
      fail("invalid");
      return;
    }

    const { tokenHash, type } = decision;

    const { error: verifyOtpError } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });

    if (verifyOtpError) {
      // Neplatný, už použitý alebo expirovaný token_hash — fail closed.
      fail(reasonForVerifyError(verifyOtpError));
      return;
    }

    // Nezávislé potvrdenie identity priamo voči Supabase Auth serveru — nie
    // lokálne dekódovanie JWT, nie dôvera vo vyššie volanie samo osebe.
    const { data: verifyData, error: getUserError } = await supabase.auth.getUser();

    if (getUserError || !verifyData.user) {
      fail("invalid");
      return;
    }

    // Token hash sa už nesmie objaviť v adresnom riadku ani v histórii
    // prehliadača.
    window.history.replaceState(null, "", window.location.pathname);

    const recoveryDestination = destinationAfterVerifiedLink(type);
    if (recoveryDestination) {
      router.replace(recoveryDestination);
      return;
    }

    // Pozvaný používateľ (token v metadátach OVERENÉHO účtu) ide späť na
    // pozvánku, nie do owner onboardingu (lib/auth/invite-return.ts).
    const inviteToken = pendingInviteTokenFromMetadata(verifyData.user.user_metadata);
    const invitePath = inviteToken ? inviteReturnPath(inviteToken, IS_MOBILE_BUILD) : null;
    if (invitePath) {
      router.replace(invitePath);
      return;
    }

    router.replace("/onboarding/company");
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void handleCallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "failed") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold text-primary">
          {t("authCallback.failedTitle")}
        </h1>
        <p className="mt-3 text-secondary">
          {failure === "expired"
            ? t("authCallback.expiredDescription")
            : failure === "unsupported_link"
              ? t("authCallback.unsupportedLinkDescription")
              : t("authCallback.failedDescription")}
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700"
        >
          {t("invite.goToLogin")}
        </Link>
      </Centered>
    );
  }

  return (
    <Centered>
      <p className="text-secondary">{t("authCallback.processing")}</p>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell-bg flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-surface-1 p-8 text-center shadow">
        {children}
      </div>
    </main>
  );
}
