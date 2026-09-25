"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { ensureMyOwnerCompany, getEnsureOwnerCompanyErrorMessage } from "@/lib/company";
import { acceptLegalDocumentAtRegistration } from "@/lib/legal-acceptance";
import { REQUIRED_ACCEPTANCE_DOCUMENTS } from "@/lib/legal-config";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import LanguageSwitcher from "@/app/components/LanguageSwitcher";
import { SocialAuthButtons } from "@/app/components/auth/SocialAuthButtons";

// Closed Beta (supabase/migrations/20260816130000_add_closed_beta_allowlist.sql):
// verejná owner registrácia je dočasne obmedzená iba na schválených beta
// testerov (server-side e-mail allowlist). Primárne vynútenie beží v
// Supabase Auth hooku "Before User Created"
// (esblu_before_user_created_beta_gate) — pre neschválený e-mail sa
// auth.users vôbec nevytvorí a signUp() nižšie vráti chybu priamo s touto
// slovenskou správou. ensureMyOwnerCompany() dole má rovnaký check ako
// defense-in-depth (pre prípad, že by Auth hook v Dashboarde ešte nebol
// zapnutý). Bežné prihlásenie (login()) a existujúci /invite/[token] flow
// touto zmenou nie sú nijako dotknuté.
const CLOSED_BETA_ERROR_MARKER = "uzavretej beta verzii";

// DÔLEŽITÉ: táto stránka slúži AJ existujúcim používateľom (owner, admin,
// employee) na bežné prihlásenie — login() preto NIKDY nesmie volať
// ensureMyOwnerCompany(). Keby ju volal, pozvaný employee/admin, ktorý sa
// omylom prihlási tu namiesto prijatia pozvánky na /invite/[token], by si
// automaticky založil vlastnú owner company a znemožnil by si tým prijatie
// pôvodnej pozvánky (esblu_accept_company_invite by následne zlyhala s
// ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP).
//
// register() SMIE volať ensureMyOwnerCompany() iba v prípade, že Supabase
// vráti session OKAMŽITE (email confirmation vypnuté) — vtedy sme stále
// vnútri explicitného "Registrovať firmu" klik-handlera, čiže intent je
// jednoznačný z volajúcej funkcie, nie odvodený z toho, či user má/nemá
// membership.
//
// Keď session okamžite nepríde (čaká sa na potvrdenie e-mailu), owner-
// registration intent sa NEPRENÁŠA cez /login (tá slúži univerzálne aj pre
// bežný login) — namiesto toho signUp() smeruje emailRedirectTo na
// samostatnú, explicitnú route /onboarding/company, ktorá jediná (mimo
// register() vyššie) smie zavolať bootstrap. Pozri
// app/onboarding/company/page.tsx.

export default function LoginPage() {
  const router = useRouter();
  const { t } = useLocale();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);

  const [accountDeletedNotice, setAccountDeletedNotice] = useState(false);
  // Nastaví sa pri vynútenom odhlásení po ČIASTOČNE dokončenom zrušení účtu
  // (app/nastavenia → confirmDeleteAccount(), keď server vráti
  // `partial: true` — DB/membership časť je nevrátne zmazaná, ale
  // auth.users účet ostal existovať). Odlišná správa od bežného
  // accountDeletedNotice, lebo tu treba používateľa nasmerovať na podporu,
  // nie iba potvrdiť úspech.
  const [accountDeletionPartialNotice, setAccountDeletionPartialNotice] =
    useState(false);
  // Návrat z Google/Apple bez prihlásenia (zrušené alebo chyba).
  const [oauthNotice, setOauthNotice] = useState<"" | "cancelled" | "error">("");

  // Jednorazová správa po úspešnom (alebo čiastočnom) samoobslužnom zrušení
  // účtu (app/nastavenia → lib/account-deletion.ts). Číta sa priamo z
  // window.location.search (nie useSearchParams()) zámerne — vyhýba sa
  // tak Suspense-boundary požiadavke Next.js pre useSearchParams() pri
  // statickom prerenderi tejto stránky. Query parameter sa po zobrazení
  // hneď odstráni z URL (replaceState), takže obnovenie stránky správu
  // znova nezobrazí.
  useEffect(() => {
    // setState beží zámerne v mikrotaskovom callbacku (nie synchrónne
    // priamo v tele efektu) — rovnaký princíp ako async checkUser() v
    // app/nastavenia, len bez skutočného async volania navyše.
    async function applyAccountDeletedNoticeFromUrl() {
      if (typeof window === "undefined") {
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const oauth = params.get("oauth");
      if (oauth === "cancelled" || oauth === "error") {
        await Promise.resolve();
        setOauthNotice(oauth);
        params.delete("oauth");
        const rest = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
      }
      const isFullyDeleted = params.get("ucet-zruseny") === "1";
      const isPartiallyDeleted =
        params.get("ucet-zruseny-ciastocne") === "1";

      if (!isFullyDeleted && !isPartiallyDeleted) {
        return;
      }

      await Promise.resolve();

      if (isPartiallyDeleted) {
        setAccountDeletionPartialNotice(true);
        params.delete("ucet-zruseny-ciastocne");
      } else {
        setAccountDeletedNotice(true);
        params.delete("ucet-zruseny");
      }

      const newSearch = params.toString();
      const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ""}`;
      window.history.replaceState(null, "", newUrl);
    }

    applyAccountDeletedNoticeFromUrl();
  }, []);

  function validateEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  async function login() {
    const normalizedEmail = email.trim().toLowerCase();

    if (!validateEmail(normalizedEmail)) {
      alert(t("auth.login.validationInvalidEmail"));
      return;
    }

    if (!password) {
      alert(t("auth.login.validationMissingPassword"));
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    setLoading(false);

    if (error) {
      alert(t("auth.login.loginFailed"));
      return;
    }

    // Zámerne ŽIADNY bootstrap tu — bežné prihlásenie iba pokračuje podľa
    // existujúceho membershipu používateľa (alebo jeho absencie). Pozri
    // komentár nad komponentom.
    router.push("/");
    router.refresh();
  }

  async function register() {
    const normalizedEmail = email.trim().toLowerCase();

    if (!validateEmail(normalizedEmail)) {
      alert(t("auth.login.validationInvalidEmail"));
      return;
    }

    if (password.length < 8) {
      alert(t("auth.login.validationPasswordTooShort"));
      return;
    }

    if (password !== confirmPassword) {
      alert(t("auth.login.validationPasswordMismatch"));
      return;
    }

    if (!agreedTerms || !agreedPrivacy) {
      alert(t("auth.login.validationMustAgreeLegal"));
      return;
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signUp({
  email: normalizedEmail,
  password,
  options: {
    // AUTH CALLBACK BEZPEČNOSTNÁ OPRAVA (2026-08-31, RELEASE BLOCKER,
    // TokenHash revízia): skutočný potvrdzovací odkaz, ktorý používateľ
    // dostane e-mailom, je od tejto zmeny riadený PRIAMO Supabase Email
    // Template (Dashboard → Authentication → Email Templates → Confirm
    // signup), manuálne nastaveným na
    // "{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email"
    // — NIE týmto `emailRedirectTo`. app/auth/callback/page.tsx explicitne
    // volá supabase.auth.verifyOtp({ token_hash, type }) a AŽ PO úspechu +
    // nezávislom getUser() overení presmeruje na /onboarding/company; nikdy
    // sa nedôveruje getSession() ani prípadnej existujúcej session iného
    // účtu (pôvodný root cause cross-account bugu). `emailRedirectTo` tu
    // ostáva iba ako neškodná fallback hodnota (Supabase ju v praxi
    // nepoužije, pokiaľ je template nastavená podľa vyššie — pozri
    // komentár v app/auth/callback/page.tsx pre presný text template).
    emailRedirectTo: "https://esblu.com/auth/callback",
  },
});

    if (error) {
      setLoading(false);
      // Closed Beta: ak signUp() zamietol Auth hook
      // (esblu_before_user_created_beta_gate), error.message je už
      // hotová, zrozumiteľná slovenská správa — zobraz ju priamo bez
      // technického prefixu.
      // Closed Beta hlášku posiela DB Auth hook vždy po slovensky (server-side,
      // bez znalosti UI jazyka) — tu ju nahradíme preloženou verziou podľa
      // aktuálneho jazyka namiesto zobrazenia surového SK textu z error.message.
      alert(
        error.message.includes(CLOSED_BETA_ERROR_MARKER)
          ? t("auth.closedBeta.message")
          : t("auth.login.registrationFailedPrefix") + error.message
      );
      return;
    }

    setPassword("");
    setConfirmPassword("");

    if (data.session) {
      // Explicitný owner-registration flow — session prišla hneď (email
      // confirmation je vypnuté alebo bolo už predtým potvrdené).
      try {
        await ensureMyOwnerCompany();
      } catch (bootstrapError) {
        // Defense-in-depth beta check v esblu_ensure_my_owner_company
        // zlyhal (bežne by k tomuto nemalo dôjsť — neschválený signUp() by
        // mal byť zamietnutý už vyššie priamo Auth hookom). Odhlás
        // používateľa, aby nezostal prihlásený v stave "má účet, ale nikdy
        // nebude mať firmu", a nechaj ho na prihlasovacej obrazovke so
        // zrozumiteľnou správou.
        console.error("Owner company bootstrap zlyhal:", bootstrapError);
        await supabase.auth.signOut();
        setLoading(false);
        alert(getEnsureOwnerCompanyErrorMessage(bootstrapError, t));
        setMode("login");
        return;
      }

      // Zápis acceptance hneď, keď už máme session — checkboxy boli
      // povinne odškrtnuté vyššie. Ak session príde až po potvrdení
      // e-mailu (branch nižšie), acceptance sa nezapíše tu, ale
      // LegalAcceptanceGate ju vyžiada pri prvom prihlásení po potvrdení
      // (fail-safe, nie "dôveruj a zabudni").
      await Promise.all(
        REQUIRED_ACCEPTANCE_DOCUMENTS.map((doc) =>
          acceptLegalDocumentAtRegistration(doc.type, doc.version)
        )
      );

      setLoading(false);
      alert(t("auth.login.accountCreatedImmediate"));
      router.push("/");
      router.refresh();
      return;
    }

    setLoading(false);

    alert(t("auth.login.accountCreatedPendingConfirm"));

    setMode("login");
  }
async function resetPassword() {
  const normalizedEmail = email.trim().toLowerCase();

  if (!validateEmail(normalizedEmail)) {
    alert(t("auth.resetPassword.validationInvalidEmail"));
    return;
  }

  setResetLoading(true);

  const { error } = await supabase.auth.resetPasswordForEmail(
    normalizedEmail,
    {
      // AUTH CALLBACK BEZPEČNOSTNÁ OPRAVA (2026-08-31, TokenHash revízia) —
      // rovnaký dôvod ako pri emailRedirectTo v register() vyššie: skutočný
      // recovery odkaz je riadený Supabase Email Template (Dashboard →
      // Reset Password), manuálne nastavenou na
      // "{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery"
      // — NIE týmto `redirectTo`. app/auth/callback/page.tsx explicitne
      // volá verifyOtp({ token_hash, type: "recovery" }) a AŽ PO úspechu +
      // getUser() overení presmeruje na /reset-hesla?verified=1; /reset-hesla
      // predtým dôverovala AKEJKOĽVEK existujúcej/ambientnej session (aj
      // "INITIAL_SESSION" bežne prihláseného používateľa) — pozri fix v
      // app/reset-hesla/page.tsx. `redirectTo` tu ostáva iba ako neškodná
      // fallback hodnota.
      redirectTo: "https://esblu.com/auth/callback",
    }
  );

  setResetLoading(false);

  if (error) {
    alert(t("auth.resetPassword.requestFailedPrefix") + error.message);
    return;
  }

  alert(t("auth.resetPassword.success"));
}
  function switchMode() {
    setMode((currentMode) =>
      currentMode === "login" ? "register" : "login"
    );

    setPassword("");
    setConfirmPassword("");
  }

  return (
    <main className="app-shell-bg flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-surface-1 p-8 shadow">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-3xl font-bold text-primary">
            {mode === "login"
              ? t("auth.login.title")
              : t("auth.login.registerTitle")}
          </h1>
          <LanguageSwitcher />
        </div>

        <p className="mt-2 text-muted-esblu">
          {mode === "login"
            ? t("auth.login.subtitleLogin")
            : t("auth.login.subtitleRegister")}
        </p>

        {oauthNotice && (
          <p className="mt-4 rounded-xl border border-subtle bg-surface-2 px-4 py-3 text-sm text-secondary">
            {t(oauthNotice === "cancelled" ? "auth.oauth.cancelled" : "auth.oauth.failed")}
          </p>
        )}

        {accountDeletedNotice && (
          <p className="mt-4 rounded-xl border border-subtle bg-surface-2 px-4 py-3 text-sm text-secondary">
            {t("auth.login.accountDeletedShort")}
          </p>
        )}

        {accountDeletionPartialNotice && (
          <p className="mt-4 rounded-xl bg-warning-soft px-4 py-3 text-sm leading-6 text-amber-400">
            {t("auth.login.accountDeletedPartialNotice")}
          </p>
        )}

        {mode === "register" && (
          <p className="mt-4 rounded-xl bg-info-soft px-4 py-3 text-sm leading-6 text-blue-800">
            {t("auth.closedBeta.registerNotice")}
          </p>
        )}

        <div className="mt-6 space-y-4">
          <input
            type="email"
            placeholder={t("auth.login.email")}
            autoComplete="email"
            className="w-full rounded-xl border p-3"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={loading}
          />

          <input
            type="password"
            placeholder={t("auth.login.password")}
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            className="w-full rounded-xl border p-3"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={loading}
          />

          {mode === "register" && (
            <input
              type="password"
              placeholder={t("auth.login.confirmPasswordPlaceholder")}
              autoComplete="new-password"
              className="w-full rounded-xl border p-3"
              value={confirmPassword}
              onChange={(event) =>
                setConfirmPassword(event.target.value)
              }
              disabled={loading}
            />
          )}
        </div>

        {mode === "register" && (
          <div className="mt-4 space-y-3">
            <label className="flex items-start gap-3 text-sm leading-6 text-secondary">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={agreedTerms}
                onChange={(event) => setAgreedTerms(event.target.checked)}
                disabled={loading}
              />
              <span>
                {t("auth.login.agreeTermsPrefix")}{" "}
                <Link
                  href="/podmienky-pouzivania"
                  target="_blank"
                  className="font-semibold text-blue-700 hover:underline"
                >
                  {t("auth.login.agreeTermsLink")}
                </Link>
                .
              </span>
            </label>

            <label className="flex items-start gap-3 text-sm leading-6 text-secondary">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={agreedPrivacy}
                onChange={(event) => setAgreedPrivacy(event.target.checked)}
                disabled={loading}
              />
              <span>
                {t("auth.login.agreePrivacyPrefix")}{" "}
                <Link
                  href="/ochrana-osobnych-udajov"
                  target="_blank"
                  className="font-semibold text-blue-700 hover:underline"
                >
                  {t("auth.login.agreePrivacyLink")}
                </Link>
                .
              </span>
            </label>
          </div>
        )}

        <button
  type="button"
  onClick={mode === "login" ? login : register}
  disabled={
    loading ||
    (mode === "register" && (!agreedTerms || !agreedPrivacy))
  }
  className="btn-primary mt-6 w-full px-6 py-3 text-center"
>
  {loading
    ? t("auth.login.working")
    : mode === "login"
      ? t("auth.login.submitLogin")
      : t("auth.login.submitRegister")}
</button>

{/* Google / Apple — registrácia iba so zaškrtnutým súhlasom (rovnako ako
    e-mail). Prístup aj tak rozhodne uzavretá beta a pozvánky. */}
<SocialAuthButtons
  mode={mode}
  legalAccepted={mode === "register" && agreedTerms && agreedPrivacy}
  disabled={loading || (mode === "register" && (!agreedTerms || !agreedPrivacy))}
/>

{mode === "login" && (
  <button
    type="button"
    onClick={resetPassword}
    disabled={loading || resetLoading}
    className="mt-3 w-full text-center text-sm font-semibold text-blue-700 hover:underline disabled:text-gray-400"
  >
    {resetLoading
      ? t("auth.login.sendingResetLink")
      : t("auth.login.forgotPassword")}
  </button>
)}

        <button
          type="button"
          onClick={switchMode}
          disabled={loading}
          className="mt-3 w-full rounded-xl border border-subtle px-6 py-3 font-semibold text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-gray-400"
        >
          {mode === "login"
            ? t("auth.login.switchToRegister")
            : t("auth.login.switchToLogin")}
        </button>

        <nav
          aria-label={t("settings.legal.navAriaLabel")}
          className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-2 border-t border-subtle pt-5 text-center text-xs font-medium text-secondary"
        >
          <Link href="/ochrana-osobnych-udajov" className="hover:text-blue-700 hover:underline">
            {t("common.legalLinks.privacy")}
          </Link>
          <Link href="/podmienky-pouzivania" className="hover:text-blue-700 hover:underline">
            {t("common.legalLinks.terms")}
          </Link>
          <Link href="/cookies" className="hover:text-blue-700 hover:underline">
            {t("common.legalLinks.cookies")}
          </Link>
          <Link href="/kontakt" className="hover:text-blue-700 hover:underline">
            {t("common.legalLinks.contact")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
