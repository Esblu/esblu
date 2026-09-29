"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "./components/Dashboard";
import PublicLandingPage from "./components/PublicLandingPage";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { IS_MOBILE_BUILD } from "@/lib/build-target";

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

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setHasSession(Boolean(data.session));
      }
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
