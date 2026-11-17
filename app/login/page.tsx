"use client";

import { currentLegalAckMetadata, LEGAL_ACK_METADATA_KEY } from "@/lib/legal-ack-versions";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { canonicalWebUrl, mobileApiOrigin } from "@/lib/app-origin";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { recoveryRedirectTo } from "@/lib/auth/recovery-callback";
import { ensureMyOwnerCompany, getEnsureOwnerCompanyErrorMessage } from "@/lib/company";
import { acceptLegalDocumentAtRegistration } from "@/lib/legal-acceptance";
import { REQUIRED_ACCEPTANCE_DOCUMENTS } from "@/lib/legal-config";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import LanguageSwitcher from "@/app/components/LanguageSwitcher";
import { SocialAuthButtons } from "@/app/components/auth/SocialAuthButtons";
import { LegalDocLink } from "@/app/components/LegalDocLink";
import { signOutOnThisDevice } from "@/lib/sign-out";
import { wantsRegisterMode } from "@/lib/public-links";
import { BrandMark, PublicSiteFooter, PublicSiteHeader } from "@/app/components/public/PublicSite";
import { CheckIcon } from "@/app/components/icons/AppIcons";

// Verejná registrácia (20261117100000): o tom, či sa nový zákazník môže
// zaregistrovať, rozhoduje server — public.registration_policy (open /
// closed_beta), ktorú čítajú Auth hook esblu_before_user_created_beta_gate
// aj esblu_ensure_my_owner_company. V režime closed_beta hook odmietne
// signUp() slovenskou hláškou (stabilný marker nižšie; pôvodný marker
// ponechaný kvôli spätnému návratu) — tu sa nahradí lokalizovaným textom.
// Bežné prihlásenie (login()) a /invite/[token] flow tým nie sú dotknuté.
const REGISTRATION_CLOSED_MARKERS = ["dočasne pozastavená", "uzavretej beta verzii"];
const isRegistrationClosedMessage = (message: string) => REGISTRATION_CLOSED_MARKERS.some((marker) => message.includes(marker));

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
  const [oauthNotice, setOauthNotice] = useState<"" | "cancelled" | "error" | "beta">("");

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
      // Odkaz „Vytvoriť účet“ z verejného webu (/login?rezim=registracia).
      if (wantsRegisterMode(window.location.search)) {
        await Promise.resolve();
        setMode("register");
      }
      const oauth = params.get("oauth");
      if (oauth === "cancelled" || oauth === "error" || oauth === "beta") {
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
    emailRedirectTo: canonicalWebUrl("/auth/callback"),
    // J10 CLIA 2.2.4: verzie dokumentov zobrazené pri odškrtnutí — onboarding
    // ich zapíše presne (lib/legal-ack-versions.ts).
    data: { [LEGAL_ACK_METADATA_KEY]: currentLegalAckMetadata() },
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
        isRegistrationClosedMessage(error.message)
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
        await signOutOnThisDevice();
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
      //
      // Fix 2026-10-09: vstavaný Supabase mailer (staging) šablónu NEpoužije
      // a pošle Supabase-hosted odkaz → 303 na `redirectTo`. Preto callback na
      // TOM ISTOM origine (staging ostane na stagingu) s ?flow=recovery, kde
      // /auth/callback vymení PKCE kód za session a otvorí /reset-hesla.
      // Mobilná appka: webový origin backendu (staging/produkcia).
      redirectTo: recoveryRedirectTo(IS_MOBILE_BUILD ? mobileApiOrigin() : window.location.origin),
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

  const card = (
      <div className="w-full max-w-md rounded-[var(--radius-card-lg)] border border-subtle bg-surface-1 p-5 shadow-2xl shadow-black/40 sm:p-7">
        {IS_MOBILE_BUILD && (
          <div className="mb-4 flex items-center justify-between gap-3">
            <BrandMark size="sm" />
            <LanguageSwitcher subtle />
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight text-primary sm:text-2xl">
            {mode === "login"
              ? t("auth.login.title")
              : t("auth.login.registerTitle")}
          </h1>
          {!IS_MOBILE_BUILD && (
            <span className="lg:hidden">
              <LanguageSwitcher subtle />
            </span>
          )}
        </div>

        <p className="mt-0.5 text-[13px] leading-5 text-muted-esblu">
          {mode === "login"
            ? t("auth.login.subtitleLogin")
            : t("auth.login.subtitleRegister")}
        </p>

        {oauthNotice && (
          <p className="ui-notice mt-3">
            {t(oauthNotice === "cancelled" ? "auth.oauth.cancelled" : oauthNotice === "beta" ? "auth.oauth.betaRequired" : "auth.oauth.failed")}
          </p>
        )}

        {accountDeletedNotice && (
          <p className="ui-notice mt-3">
            {t("auth.login.accountDeletedShort")}
          </p>
        )}

        {accountDeletionPartialNotice && (
          <p className="ui-notice mt-3" data-tone="warning">
            {t("auth.login.accountDeletedPartialNotice")}
          </p>
        )}

        {mode === "register" && (
          <p className="ui-notice mt-3 border-brand-500/30 bg-info-soft text-brand-300">
            {t("auth.login.registerTrialNotice")}
          </p>
        )}

        <div className="mt-3 space-y-2.5">
          <input
            type="email"
            placeholder={t("auth.login.email")}
            aria-label={t("auth.login.email")}
            autoComplete="email"
            className="ui-input"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={loading}
          />

          <input
            type="password"
            placeholder={t("auth.login.password")}
            aria-label={t("auth.login.password")}
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            className="ui-input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={loading}
          />

          {mode === "register" && (
            <input
              type="password"
              placeholder={t("auth.login.confirmPasswordPlaceholder")}
              aria-label={t("auth.login.confirmPasswordPlaceholder")}
              autoComplete="new-password"
              className="ui-input"
              value={confirmPassword}
              onChange={(event) =>
                setConfirmPassword(event.target.value)
              }
              disabled={loading}
            />
          )}
        </div>

        {mode === "register" && (
          <div className="mt-3 space-y-2">
            <label className="flex items-start gap-2.5 text-[13px] leading-5 text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0"
                checked={agreedTerms}
                onChange={(event) => setAgreedTerms(event.target.checked)}
                disabled={loading}
              />
              <span>
                {t("auth.login.agreeTermsPrefix")}{" "}
                <LegalDocLink path="/podmienky-pouzivania" className="font-medium text-brand-300 hover:underline">
                  {t("auth.login.agreeTermsLink")}
                </LegalDocLink>
                {t("auth.login.agreeTermsSuffix") ? ` ${t("auth.login.agreeTermsSuffix")}` : ""}.
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-[13px] leading-5 text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0"
                checked={agreedPrivacy}
                onChange={(event) => setAgreedPrivacy(event.target.checked)}
                disabled={loading}
              />
              <span>
                {t("auth.login.agreePrivacyPrefix")}{" "}
                <LegalDocLink path="/ochrana-osobnych-udajov" className="font-medium text-brand-300 hover:underline">
                  {t("auth.login.agreePrivacyLink")}
                </LegalDocLink>{" "}
                {t("auth.login.agreePrivacySuffix")}
                {t("auth.login.agreePrivacySuffix").endsWith(".") ? "" : "."}
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
  className="ui-btn ui-btn-primary mt-3 w-full"
>
  {loading
    ? t("auth.login.working")
    : mode === "login"
      ? t("auth.login.submitLogin")
      : t("auth.login.submitRegister")}
</button>

{/* Google / Apple — registrácia iba so zaškrtnutým súhlasom (rovnako ako
    e-mail). O vzniku účtu rozhoduje server (registration_policy + pozvánky). */}
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
    className="mt-2 min-h-8 w-full text-center text-[13px] font-medium text-brand-300 hover:underline disabled:text-muted-esblu"
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
          className="ui-btn ui-btn-secondary mt-2 w-full"
        >
          {mode === "login"
            ? t("auth.login.switchToRegister")
            : t("auth.login.switchToLogin")}
        </button>

        <nav
          aria-label={t("settings.legal.navAriaLabel")}
          className="mt-3 flex flex-wrap justify-center gap-x-2 gap-y-0 border-t border-subtle pt-1.5 text-center text-xs font-medium text-muted-esblu"
        >
          <Link href="/ochrana-osobnych-udajov" className="inline-flex min-h-7 items-center px-1 hover:text-brand-300 hover:underline">
            {t("common.legalLinks.privacy")}
          </Link>
          <Link href="/podmienky-pouzivania" className="inline-flex min-h-7 items-center px-1 hover:text-brand-300 hover:underline">
            {t("common.legalLinks.terms")}
          </Link>
          <Link href="/cookies" className="inline-flex min-h-7 items-center px-1 hover:text-brand-300 hover:underline">
            {t("common.legalLinks.cookies")}
          </Link>
          <Link href="/kontakt" className="inline-flex min-h-7 items-center px-1 hover:text-brand-300 hover:underline">
            {t("common.legalLinks.contact")}
          </Link>
        </nav>
      </div>
  );

  // Mobilná appka: iba karta (bez marketingovej hlavičky webu).
  if (IS_MOBILE_BUILD) {
    return (
      <main className="app-shell-bg flex min-h-screen items-center justify-center px-4 py-6">
        {card}
      </main>
    );
  }

  // Web: spoločný rámec verejných stránok (hlavička + pätička) a vedľa
  // formulára stručne, čo nový zákazník po registrácii dostane.
  return (
    <div className="flex min-h-screen flex-col bg-page-bg text-primary">
      <PublicSiteHeader hideAuthLinks />
      <main className="relative flex-1 overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_45%_at_15%_0%,rgba(1,129,253,0.14),rgba(1,129,253,0)_70%)]" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 py-8 sm:px-6 sm:py-12 lg:grid-cols-[1fr_28rem] lg:gap-16 lg:px-8 lg:py-20">
          <section className="order-2 lg:order-1" aria-labelledby="login-aside-title">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent-cyan sm:text-sm">{t("landing.hero.badge")}</p>
            <h2 id="login-aside-title" className="mt-3 text-3xl font-black tracking-tight text-primary sm:text-4xl">{t("landing.hero.title")}</h2>
            <p className="mt-4 max-w-xl text-base leading-7 text-secondary">{t("landing.steps.subtitle")}</p>
            <ol className="mt-6 space-y-4">
              {[1, 2, 3].map((n) => (
                <li key={n} className="flex gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 text-sm font-black text-white">{n}</span>
                  <span>
                    <span className="block font-bold text-primary">{t(`landing.steps.step${n}Title`)}</span>
                    <span className="mt-0.5 block text-sm leading-6 text-secondary">{t(`landing.steps.step${n}Desc`)}</span>
                  </span>
                </li>
              ))}
            </ol>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-secondary">
              {["landing.hero.point1", "landing.hero.point2", "landing.hero.point3"].map((key) => (
                <li key={key} className="flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-500/15 text-brand-300">
                    <CheckIcon size={13} strokeWidth={2.6} />
                  </span>
                  {t(key)}
                </li>
              ))}
            </ul>
          </section>
          <div className="order-1 flex justify-center lg:order-2">{card}</div>
        </div>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
