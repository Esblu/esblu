"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  ensureMyOwnerCompany,
  getEnsureOwnerCompanyErrorMessage,
  isBetaAccessRequiredError,
} from "@/lib/company";
import { acceptLegalDocumentAtRegistration } from "@/lib/legal-acceptance";
import { REQUIRED_ACCEPTANCE_DOCUMENTS } from "@/lib/legal-config";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { takeOAuthPending } from "@/lib/auth/oauth-client";
import { mayRecordRegistrationConsent } from "@/lib/auth/oauth-routing";

// Explicitná, na jeden účel vyhradená route: JEDINÉ miesto (spolu s
// register() v app/login/page.tsx pri okamžitej session) v celej aplikácii,
// ktoré smie zavolať ensureMyOwnerCompany(). Sem smeruje výhradne
// emailRedirectTo zo signUp() volaného v "Registrovať firmu" flow (pozri
// app/login/page.tsx). Nič iné v aplikácii na túto route neodkazuje —
// app/invite/[token]/page.tsx má vlastný, nezávislý emailRedirectTo naspäť
// na seba samého a NIKDY túto stránku ani ensureMyOwnerCompany() nevolá.
//
// Bezpečnostný princíp (kľúčová oprava tohto kola): owner-registration
// intent sa NEODVODZUJE z toho, že prihlásený používateľ nemá membership —
// to by mohlo omylom "adoptovať" pozvaného employee/admina, ktorý sa sem
// akokoľvek dostane (napr. otvorením starého/zdieľaného odkazu). Intent je
// daný výhradne TÝM, ŽE POUŽÍVATEĽ SEM PRIŠIEL cez tento konkrétny
// emailRedirectTo odkaz z registračného flow, teda cestou (route), nie
// odvodeným stavom dát.

type PageState =
  | "checking"
  | "no-session"
  | "bootstrapping"
  | "error"
  | "beta-required";

export default function OnboardingCompanyPage() {
  const router = useRouter();
  const { t } = useLocale();
  const [state, setState] = useState<PageState>("checking");
  const [betaMessage, setBetaMessage] = useState("");

  // Zámerne žiadny synchrónny setState pred prvým `await` — prvý riadok je
  // `await supabase.auth.getSession()` (rovnaký vzor ako loadInvite() v
  // app/invite/[token]/page.tsx).
  async function runBootstrap() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      // Niekto otvoril túto route bez platnej session (napr. odkaz vypršal,
      // alebo sem niekto prišiel priamo bez potvrdenia e-mailu). Nič sa
      // nezakladá — bez session by aj server-side auth.uid() v RPC bolo
      // NULL a volanie by zlyhalo, tu to iba zobrazíme používateľovi
      // zrozumiteľne.
      setState("no-session");
      return;
    }

    setState("bootstrapping");

    try {
      await ensureMyOwnerCompany();

      // Session tu existuje prvýkrát až TERAZ (potvrdenie e-mailu bolo
      // vyžadované, takže signUp() v app/login/page.tsx nemohol zapísať
      // acceptance okamžite — auth.uid() by vtedy ešte bolo NULL). Checkboxy
      // "Súhlasím s Podmienkami" a "Potvrdzujem oboznámenie sa so Zásadami"
      // boli napriek tomu povinnou podmienkou PRED zavolaním signUp() na
      // registračnej stránke — táto route je jediné miesto, kam vedie
      // emailRedirectTo z toho istého signUp() volania, takže dosiahnutie
      // tejto stránky je vždy priamym pokračovaním presne toho istého
      // registračného flow. Acceptance sa preto zapisuje s
      // acceptance_method='registration' (esblu_accept_legal_document_
      // registration), NIE 'legal_gate' — 'legal_gate' je vyhradené pre
      // existujúcich používateľov, ktorí required verziu nepotvrdili pri
      // registrácii a boli kvôli tomu dodatočne zablokovaní
      // (LegalAcceptanceGate). Zámerne "fire and forget" (nečaká sa/nerobí
      // sa blokujúci error state) — ak by toto zlyhalo, LegalAcceptanceGate
      // to pri prvom reálnom vstupe do appky odchytí ako fail-safe.
      // Google / Apple: súhlas pri registrácii IBA ak ho používateľ zaškrtol
      // pred odoslaním na poskytovateľa. Inak ho vyžiada LegalAcceptanceGate
      // (nikdy sa nezapíše súhlas, ktorý nezaznel). E-mailová registrácia
      // (bez OAuth záznamu) ostáva bez zmeny.
      if (mayRecordRegistrationConsent(takeOAuthPending(), session.user.app_metadata?.provider ?? null)) {
        await Promise.all(
          REQUIRED_ACCEPTANCE_DOCUMENTS.map((doc) =>
            acceptLegalDocumentAtRegistration(doc.type, doc.version)
          )
        );
      }

      router.push("/");
      router.refresh();
    } catch (error) {
      console.error("Owner company bootstrap zlyhal:", error);

      // Closed Beta defense-in-depth (pozri
      // supabase/migrations/20260816130000_add_closed_beta_allowlist.sql):
      // za normálnych okolností by neschválený e-mail nikdy nedostal
      // session, lebo signUp() by bol zamietnutý už Auth hookom
      // (esblu_before_user_created_beta_gate) skôr, než by auth.users
      // vôbec vznikol. Ak sa napriek tomu sem dostal (napr. hook ešte nie
      // je zapnutý v Supabase Dashboarde), odhlás ho — nesmie zostať
      // prihlásený v stave "má účet, ale nikdy nebude mať firmu".
      if (isBetaAccessRequiredError(error)) {
        setBetaMessage(getEnsureOwnerCompanyErrorMessage(error, t));
        await supabase.auth.signOut();
        setState("beta-required");
        return;
      }

      setState("error");
    }
  }

  useEffect(() => {
    // runBootstrap() nevolá setState pred prvým await (pozri komentár pri
    // jej deklarácii). Pravidlo react-hooks/set-state-in-effect to napriek
    // tomu odmieta paušálne — rovnaké odôvodnenie ako v
    // app/invite/[token]/page.tsx; rovnaký fetch-on-mount vzor sa používa
    // naprieč celým projektom.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runBootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "checking" || state === "bootstrapping") {
    return (
      <Centered>
        <p className="text-secondary">
          {state === "checking"
            ? t("onboarding.checkingEmailConfirmation")
            : t("onboarding.bootstrappingCompany")}
        </p>
      </Centered>
    );
  }

  if (state === "beta-required") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold text-primary">{t("onboarding.betaRequiredTitle")}</h1>
        <p className="mt-3 text-secondary">{betaMessage}</p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700"
        >
          {t("invite.goToLogin")}
        </Link>
      </Centered>
    );
  }

  if (state === "no-session") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold text-primary">
          {t("onboarding.invalidLinkTitle")}
        </h1>
        <p className="mt-3 text-secondary">
          {t("onboarding.invalidLinkDescription")}
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
      <h1 className="text-2xl font-bold text-primary">
        {t("onboarding.genericErrorTitle")}
      </h1>
      <p className="mt-3 text-secondary">
        {t("onboarding.genericErrorDescription")}
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell-bg flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-surface-1 p-8 text-center shadow">
        {children}
      </div>
    </main>
  );
}
