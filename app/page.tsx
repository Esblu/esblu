"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "./components/Dashboard";
import PublicLandingPage from "./components/PublicLandingPage";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { resolveStartupSession } from "@/lib/startup-session";

// Poznámka: táto stránka zámerne NEVOLÁ esblu_ensure_my_owner_company().
// Owner bootstrap sa spúšťa VÝHRADNE z explicitného owner-registration/
// onboarding flow v app/login/page.tsx (po úspešnom register()/login()) —
// nie globálne pri každej session. Dôvod: /invite/[token] flow zdieľa
// rovnaký Supabase Auth session storage (localStorage) naprieč kartami; keby
// táto stránka volala bootstrap pri každom SIGNED_IN evente, mohla by sa
// spustiť súbežne s prijímaním pozvánky v inej karte. Pozri report k tejto
// zmene pre detailný rozbor poradia volaní.

export default function Home() {
  const { t } = useLocale();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  // Štart nesmie visieť na „Načítavam Esblu…": chyba / timeout úložiska
  // session → explicitná chybová obrazovka (lib/startup-session.ts).
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void resolveStartupSession(() => supabase.auth.getSession()).then((result) => {
      if (!mounted) return;
      if (result.status === "error") {
        console.error("[startup] session sa nepodarilo načítať:", result.reason);
        setStartupError(result.reason);
        return;
      }
      setHasSession(result.status === "signed_in");
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) {
        setHasSession(Boolean(session));
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  if (startupError && hasSession === null) {
    return (
      <main className="grid min-h-dvh place-items-center bg-slate-950 px-6 text-center text-white">
        <div className="max-w-sm space-y-4" role="alert">
          <p className="text-base font-semibold">{t("common.misc.startupFailedTitle")}</p>
          <p className="text-sm text-slate-300">{t("common.misc.startupFailedBody")}</p>
          <p className="font-mono text-xs text-slate-500">{startupError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            {t("common.misc.startupRetry")}
          </button>
        </div>
      </main>
    );
  }

  if (hasSession === null) {
    return (
      <main className="grid min-h-dvh place-items-center bg-slate-950 text-white">
        <div className="flex items-center gap-3 text-sm font-medium text-slate-300">
          <span
            aria-hidden="true"
            className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
          />
          {t("common.misc.loadingEsblu")}
        </div>
      </main>
    );
  }

  if (hasSession) return <Dashboard />;
  // Mobile M1: natívna appka nemá marketingovú landing page (cenník, demo
  // video, webová navigácia) — neprihlásený používateľ ide rovno na
  // prihlásenie. Web ostáva bez zmeny.
  return IS_MOBILE_BUILD ? <MobileSignedOutRedirect /> : <PublicLandingPage />;
}

function MobileSignedOutRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/login");
  }, [router]);
  return null;
}
