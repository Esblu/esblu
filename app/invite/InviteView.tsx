"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  acceptCompanyInvite,
  getInviteErrorMessage,
  getInvitePreview,
  type InvitePreview,
} from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import LanguageSwitcher from "@/app/components/LanguageSwitcher";

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
        emailRedirectTo: `https://esblu.com/invite/${token}`,
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
    await supabase.auth.signOut();
    setSessionEmail(null);
    setFormError("");
  }

  if (state === "loading") {
    return (
      <Centered>
        <p className="text-secondary">{t("invite.loading")}</p>
      </Centered>
    );
  }

  if (state === "invalid") {
    return (
      <Centered>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-primary">
            {t("invite.invalidTitle")}
          </h1>
          <LanguageSwitcher />
        </div>
        <p className="mt-3 text-secondary">
          {t("invite.invalidDescription")}
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

  if (state === "accepted") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold text-primary">
          {t("invite.acceptedTitle")}
        </h1>
        <p className="mt-3 text-secondary">
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
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold text-primary">
          {t("invite.title")}
        </h1>
        <LanguageSwitcher />
      </div>

      <p className="mt-3 text-secondary">
        {t("invite.invitedWithRole")}{" "}
        <span className="font-semibold">{roleLabel}</span>.{" "}
        {t("invite.forEmail")}{" "}
        <span className="font-semibold">{preview.masked_email}</span>.
      </p>

      {formError && (
        <p className="mt-4 rounded-xl bg-danger-soft p-3 text-sm font-medium text-red-700">
          {formError}
        </p>
      )}

      {sessionEmail ? (
        <div className="mt-6">
          <p className="text-sm text-secondary">
            {t("invite.loggedInAs")}{" "}
            <span className="font-semibold">{sessionEmail}</span>.
          </p>

          <button
            type="button"
            onClick={handleAccept}
            disabled={state === "accepting"}
            className="mt-4 w-full rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
          >
            {state === "accepting"
              ? t("invite.acceptingButton")
              : t("invite.acceptButton")}
          </button>

          <button
            type="button"
            onClick={handleSignOutAndSwitch}
            disabled={state === "accepting"}
            className="mt-3 w-full rounded-xl border border-subtle px-6 py-3 font-semibold text-secondary hover:bg-surface-2"
          >
            {t("invite.signOutAndSwitch")}
          </button>
        </div>
      ) : awaitingEmailConfirmation ? (
        <p className="mt-6 rounded-xl bg-info-soft p-3 text-sm text-blue-800">
          {t("invite.awaitingEmailConfirmation")}
        </p>
      ) : (
        <div className="mt-6">
          <div className="flex rounded-xl border border-subtle p-1">
            <button
              type="button"
              onClick={() => {
                setMode("register");
                setFormError("");
              }}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold ${
                mode === "register"
                  ? "bg-blue-600 text-white"
                  : "text-secondary"
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
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold ${
                mode === "login" ? "bg-blue-600 text-white" : "text-secondary"
              }`}
            >
              {t("invite.tabLogin")}
            </button>
          </div>

          <div className="mt-4 space-y-3">
            <input
              type="email"
              placeholder={t("invite.emailPlaceholder")}
              autoComplete="email"
              className="w-full rounded-xl border p-3"
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
              className="w-full rounded-xl border p-3"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />

            {mode === "register" && (
              <input
                type="password"
                placeholder={t("invite.confirmPasswordPlaceholder")}
                autoComplete="new-password"
                className="w-full rounded-xl border p-3"
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
            className="mt-4 w-full rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
          >
            {submitting
              ? t("invite.working")
              : mode === "register"
                ? t("invite.submitRegister")
                : t("invite.submitLogin")}
          </button>
        </div>
      )}
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell-bg flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-surface-1 p-8 shadow">
        {children}
      </div>
    </main>
  );
}
