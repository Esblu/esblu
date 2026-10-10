"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { canonicalWebUrl } from "@/lib/app-origin";
import {
  acceptCompanyInvite,
  getInviteErrorMessage,
  getInvitePreview,
  type InvitePreview,
} from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import LanguageSwitcher from "@/app/components/LanguageSwitcher";
import { SocialAuthButtons } from "@/app/components/auth/SocialAuthButtons";
import { signOutOnThisDevice } from "@/lib/sign-out";

// Táto stránka NIKDY nevolá ensureMyOwnerCompany() / esblu_ensure_my_owner_company().
// Registrácia aj prihlásenie tu vždy skončí zavolaním
// esblu_accept_company_invite(token) a AŽ PO jeho úspechu presmerovaním na
// "/" — pred tým ostáva používateľ na tejto route. Vďaka tomu invite flow
// nikdy nezaloží vlastnú owner company.
//
// ZDIEĽANÁ business logika a JSX pre web aj mobile (MOBILE AUTH + DEEP LINKS
// fáza). `token` sa sem odovzdáva ako obyčajný prop — presne jeden hook na
// jeho získanie žije v konkrétnom route wrapperi:
// - web    → app/invite/[token]/page.tsx    volá useParams()
// - mobile → mobile/app/invite/page.tsx     volá useSearchParams() (?token=)
// Rovnaký vzor ako VehicleDetailView/MachineDetailView/InventoryItemDetailView
// (pozri app/vozidla/VehicleDetailView.tsx).

type PageState = "loading" | "invalid" | "ready" | "accepting" | "accepted";

export default function InviteView({ token }: { token: string }) {
  const router = useRouter();
  const { t } = useLocale();

  // Počiatočná hodnota sa počíta priamo z `token` (dostupný synchrónne z
  // props pri prvom rendri) — bez tohto by prázdny token vyžadoval
  // synchrónny setState("invalid") v tele efektu, čo eslint (react-hooks/
  // set-state-in-effect) odmieta.
  const [state, setState] = useState<PageState>(
    token ? "loading" : "invalid"
  );
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  const [mode, setMode] = useState<"register" | "login">("register");
  const [formEmail, setFormEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [awaitingEmailConfirmation, setAwaitingEmailConfirmation] =
    useState(false);

  function validateEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  // Zámerne žiadny synchrónny setState pred prvým `await` — prvý riadok tela
  // je `await getInvitePreview(...)`, takže volanie tejto funkcie z efektu
  // nižšie nikdy nespôsobí synchrónnu aktualizáciu stavu v rámci samotného
  // tela efektu (react-hooks/set-state-in-effect).
  async function loadInvite() {
    try {
      const invitePreview = await getInvitePreview(token);

      if (!invitePreview || !invitePreview.valid) {
        setState("invalid");
        return;
      }

      setPreview(invitePreview);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      setSessionEmail(session?.user.email ?? null);
      setState("ready");
    } catch (error) {
      console.error("Načítanie pozvánky zlyhalo:", error);
      setState("invalid");
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    // react-hooks/set-state-in-effect: loadInvite() volá setState iba PO
    // prvom `await` (nikdy synchrónne v rámci tela efektu — pozri komentár
    // pri deklarácii loadInvite vyššie). Pravidlo to napriek tomu odmieta
    // paušálne pre akúkoľvek funkciu, ktorá setState obsahuje kdekoľvek vo
    // svojom tele, bez ohľadu na async poradie. Rovnaký fetch-on-mount vzor
    // (useEffect → async funkcia deklarovaná v komponente → setState) sa
    // používa naprieč celým projektom (Dashboard.tsx, sklad, stroje,
    // vozidla) — architektonická zmena tohto vzoru je mimo rozsahu tejto
    // opravy.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInvite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function finalizeAcceptance() {
    setState("accepting");
    setFormError("");

    try {
      await acceptCompanyInvite(token);
      // Token pozvánky už nie je potrebný — odstráni sa z metadát účtu
      // (best effort; slúžil iba na návrat po overení e-mailu).
      await supabase.auth.updateUser({ data: { esblu_invite_token: null } }).catch(() => undefined);
      setState("accepted");

      setTimeout(() => {
        router.push("/");
        router.refresh();
      }, 1200);
    } catch (error) {
      setState("ready");
      setFormError(getInviteErrorMessage(error, t));
    }
  }

  async function handleAccept() {
    await finalizeAcceptance();
  }

  async function handleRegister() {
    setFormError("");

    const normalizedEmail = formEmail.trim().toLowerCase();

    if (!validateEmail(normalizedEmail)) {
      setFormError(t("invite.validationInvalidEmail"));
      return;
    }

    if (password.length < 8) {
      setFormError(t("invite.validationPasswordTooShort"));
      return;
    }

    if (password !== confirmPassword) {
      setFormError(t("invite.validationPasswordMismatch"));
      return;
    }

    setSubmitting(true);

    const { data, error } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        // Zámerne natvrdo "https://esblu.com" (nie publicWebUrl()/
        // window.location.origin) — e-mailový confirmation odkaz musí VŽDY
        // smerovať na stabilnú produkčnú doménu, nezávisle od toho, či bol
        // tento signUp() spustený z web appky alebo z mobile appky (mobile
        // origin by tu bol nepoužiteľný, presne ten istý dôvod ako pri
        // publicWebUrl(), pozri lib/public-url.ts). Web wrapper ani mobile
        // wrapper toto správanie nemenia.
        // Mobile M0: kanonický host z lib/app-origin.ts (www; apex presmerúva).
        emailRedirectTo: canonicalWebUrl(`/invite/${token}`),
        // Closed Beta (supabase/migrations/20260816130000_add_closed_beta_
        // allowlist.sql): raw invite token sa posiela ako user_metadata, aby
        // ho Auth hook esblu_before_user_created_beta_gate mohol NEZÁVISLE
        // overiť voči company_invites a obísť beta gate — pozvaný
        // admin/employee nikdy nepotrebuje byť na beta_allowlist. Samotné
        // prijatie pozvánky (finalizeAcceptance → acceptCompanyInvite)
        // zostáva úplne nezmenené.
        data: { esblu_invite_token: token },
      },
    });

    setSubmitting(false);

    if (error) {
      setFormError(t("invite.registrationFailedPrefix") + error.message);
      return;
    }

    if (data.session) {
      setSessionEmail(data.session.user.email ?? normalizedEmail);
      await finalizeAcceptance();
      return;
    }

    setAwaitingEmailConfirmation(true);
  }

  async function handleLogin() {
    setFormError("");

    const normalizedEmail = formEmail.trim().toLowerCase();

    if (!validateEmail(normalizedEmail)) {
      setFormError(t("invite.validationInvalidEmail"));
      return;
    }

    if (!password) {
      setFormError(t("invite.validationMissingPassword"));
      return;
    }

    setSubmitting(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    setSubmitting(false);

    if (error) {
      setFormError(t("invite.loginFailed"));
      return;
    }

    setSessionEmail(data.session?.user.email ?? normalizedEmail);
    await finalizeAcceptance();
  }

  async function handleSignOutAndSwitch() {
    await signOutOnThisDevice();
    setSessionEmail(null);
    setFormError("");
  }

  if (state === "loading") {
    return (
      <Centered>
        <p className="text-sm text-secondary">{t("invite.loading")}</p>
      </Centered>
    );
  }

  if (state === "invalid") {
    return (
      <Centered>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-primary sm:text-[22px]">
            {t("invite.invalidTitle")}
          </h1>
          <LanguageSwitcher />
        </div>
        <p className="mt-2 text-sm leading-6 text-secondary">
          {t("invite.invalidDescription")}
        </p>
        <Link
          href="/login"
          className="ui-btn ui-btn-primary mt-4"
        >
          {t("invite.goToLogin")}
        </Link>
      </Centered>
    );
  }

  if (state === "accepted") {
    return (
      <Centered>
        <h1 className="text-xl font-semibold tracking-tight text-primary sm:text-[22px]">
          {t("invite.acceptedTitle")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-secondary">
          {t("invite.acceptedRedirecting")}
        </p>
      </Centered>
    );
  }

  if (!preview) {
    return null;
  }

  const roleLabel =
    preview.role === "admin" ||
    preview.role === "accountant" ||
    preview.role === "employee"
      ? t(`common.roles.${preview.role}`)
      : preview.role;

  return (
    <Centered>
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-primary sm:text-[22px]">
          {t("invite.title")}
        </h1>
        <LanguageSwitcher />
      </div>

      <p className="mt-2 text-sm leading-6 text-secondary">
        {t("invite.invitedWithRole")}{" "}
        <span className="font-semibold">{roleLabel}</span>.{" "}
        {t("invite.forEmail")}{" "}
        <span className="font-semibold">{preview.masked_email}</span>.
      </p>

      {formError && (
        <p className="ui-notice mt-3" data-tone="error">
          {formError}
        </p>
      )}

      {sessionEmail ? (
        <div className="mt-4">
          <p className="text-[13px] text-secondary">
            {t("invite.loggedInAs")}{" "}
            <span className="font-semibold">{sessionEmail}</span>.
          </p>

          <button
            type="button"
            onClick={handleAccept}
            disabled={state === "accepting"}
            className="ui-btn ui-btn-primary mt-3 w-full"
          >
            {state === "accepting"
              ? t("invite.acceptingButton")
              : t("invite.acceptButton")}
          </button>

          <button
            type="button"
            onClick={handleSignOutAndSwitch}
            disabled={state === "accepting"}
            className="ui-btn ui-btn-secondary mt-2 w-full"
          >
            {t("invite.signOutAndSwitch")}
          </button>
        </div>
      ) : awaitingEmailConfirmation ? (
        <p className="ui-notice mt-4 border-brand-500/30 bg-info-soft text-brand-300">
          {t("invite.awaitingEmailConfirmation")}
        </p>
      ) : (
        <div className="mt-4">
          <div className="flex gap-0.5 rounded-doc-sm border border-subtle bg-surface-2 p-0.5">
            <button
              type="button"
              onClick={() => {
                setMode("register");
                setFormError("");
              }}
              className={`min-h-8 flex-1 rounded-md px-3 py-1 text-[13px] font-semibold transition-colors ${
                mode === "register"
                  ? "bg-accent-esblu text-on-accent"
                  : "text-secondary hover:text-primary"
              }`}
            >
              {t("invite.tabRegister")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setFormError("");
              }}
              className={`min-h-8 flex-1 rounded-md px-3 py-1 text-[13px] font-semibold transition-colors ${
                mode === "login" ? "bg-accent-esblu text-on-accent" : "text-secondary hover:text-primary"
              }`}
            >
              {t("invite.tabLogin")}
            </button>
          </div>

          <div className="mt-3 space-y-3">
            <input
              type="email"
              placeholder={t("invite.emailPlaceholder")}
              autoComplete="email"
              className="ui-input"
              value={formEmail}
              onChange={(event) => setFormEmail(event.target.value)}
              disabled={submitting}
            />

            <input
              type="password"
              placeholder={t("invite.passwordPlaceholder")}
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
              className="ui-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />

            {mode === "register" && (
              <input
                type="password"
                placeholder={t("invite.confirmPasswordPlaceholder")}
                autoComplete="new-password"
                className="ui-input"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={submitting}
              />
            )}
          </div>

          <button
            type="button"
            onClick={mode === "register" ? handleRegister : handleLogin}
            disabled={submitting}
            className="ui-btn ui-btn-primary mt-3 w-full"
          >
            {submitting
              ? t("invite.working")
              : mode === "register"
                ? t("invite.submitRegister")
                : t("invite.submitLogin")}
          </button>

          {/* Google / Apple — po návrate sa otvorí táto istá pozvánka a
              prijme sa rovnakou cestou (kontrola e-mailu na serveri). */}
          <SocialAuthButtons mode="invite" legalAccepted={false} inviteToken={token} disabled={submitting} />
        </div>
      )}
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell-bg flex min-h-screen items-center justify-center px-4 py-6">
      <div className="w-full max-w-sm rounded-doc border border-doc-border bg-surface-1 p-4 sm:p-6">
        {children}
      </div>
    </main>
  );
}
