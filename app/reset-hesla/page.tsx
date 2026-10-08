"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { signOutOnThisDevice } from "@/lib/sign-out";

export default function ResetHeslaPage() {
  const router = useRouter();
  const { t } = useLocale();

  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);

  useEffect(() => {
    // AUTH CALLBACK BEZPEČNOSTNÁ OPRAVA (2026-08-31, RELEASE BLOCKER):
    // predtým táto stránka nastavila recoveryReady=true pri ĽUBOVOĽNEJ
    // existujúcej/ambientnej session — vrátane "INITIAL_SESSION" (bežná
    // session obyčajne prihláseného používateľa, ŽIADNY reset odkaz vôbec
    // nebol potrebný) a "SIGNED_IN" (ktorý, ako dokázal audit cross-account
    // bugu, môže znamenať aj ticho ponechanú STARÚ session iného účtu, nie
    // skutočne overený recovery odkaz). Toto by v najhoršom prípade dovolilo
    // komukoľvek s aktívnou session zmeniť si heslo bez toho, aby vôbec
    // prešiel cez e-mailový recovery odkaz.
    //
    // Jediný legitímny zdroj pravdy je teraz app/auth/callback/page.tsx —
    // ten explicitne ustanoví session priamo z recovery odkazu cez
    // supabase.auth.verifyOtp({ token_hash, type: "recovery" }) (nie
    // ambientne, nie dôverou v getSession()) a AŽ PO nezávislom overení
    // identity (getUser()) sem presmeruje s `?verified=1` markerom. Bez
    // tohto markera recoveryReady zostáva false bez ohľadu na to, aká
    // session prípadne existuje.
    const verified =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("verified") === "1";

    if (!verified) {
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setRecoveryReady(true);
      }
    });
  }, []);

  async function updatePassword() {
    if (!recoveryReady) {
      alert(t("auth.resetPassword.linkInvalid"));
      return;
    }

    if (newPassword.length < 8) {
      alert(t("settings.password.tooShort"));
      return;
    }

    if (newPassword !== confirmNewPassword) {
      alert(t("settings.password.mismatch"));
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    setLoading(false);

    if (error) {
      alert(t("settings.password.changeFailedPrefix", { message: error.message }));
      return;
    }

    setNewPassword("");
    setConfirmNewPassword("");

    alert(t("auth.resetPassword.updatedRedirect"));

    await signOutOnThisDevice();

    router.push("/login");
    router.refresh();
  }

  return (
    <main className="app-shell-bg flex min-h-screen items-center justify-center p-6">
      <div className="surface-card w-full max-w-md p-8 shadow-xl">
        <h1 className="text-3xl font-bold text-primary">
          {t("auth.resetPassword.pageTitle")}
        </h1>

        <p className="mt-2 text-secondary">
          {t("auth.resetPassword.pageSubtitle")}
        </p>

        <div className="mt-6 space-y-4">
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t("auth.resetPassword.newPassword")}
            className="input-dark w-full p-3"
            value={newPassword}
            onChange={(event) =>
              setNewPassword(event.target.value)
            }
            disabled={loading}
          />

          <input
            type="password"
            autoComplete="new-password"
            placeholder={t("auth.resetPassword.confirmPassword")}
            className="input-dark w-full p-3"
            value={confirmNewPassword}
            onChange={(event) =>
              setConfirmNewPassword(event.target.value)
            }
            disabled={loading}
          />
        </div>

        <button
          type="button"
          onClick={updatePassword}
          disabled={loading || !recoveryReady}
          className="btn-primary mt-6 w-full px-6 py-3"
        >
          {loading
            ? t("settings.password.changing")
            : t("auth.resetPassword.submitNew")}
        </button>

        {!recoveryReady && (
          <p className="mt-4 text-center text-sm text-muted-esblu">
            {t("auth.resetPassword.waitingForLink")}
          </p>
        )}
      </div>
    </main>
  );
}