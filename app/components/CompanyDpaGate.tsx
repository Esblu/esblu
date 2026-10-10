"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  acceptCompanyDpa,
  getMyCompanyDpaStatus,
  type CompanyDpaStatus,
} from "@/lib/company-dpa";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { navigateHard } from "@/lib/app-navigation";
import { LegalDocLink } from "@/app/components/LegalDocLink";
import { signOutOnThisDevice } from "@/lib/sign-out";

// -----------------------------------------------------------------------
// Legal-hold kontext: kým firma nemá platné company-level DPA acceptance,
// stránky vytvárajúce NOVÉ business dáta (vozidlá, stroje, sklad, AI
// evidencia — presne tie tabuľky, ktoré chráni
// esblu_require_company_dpa_before_insert v
// 20260816090000_add_company_dpa_acceptance.sql) majú svoje "pridať nové"
// akcie deaktivovať/skryť UŽ V UI, nielen nechať používateľa naraziť na
// ESBLU_COMPANY_DPA_NOT_ACCEPTED až pri ukladaní. Toto je iba pomocná UX
// vrstva — DB BEFORE INSERT trigger zostáva hlavnou a jedinou skutočne
// spoľahlivou ochranou (funguje aj keby táto UI vrstva mala chybu alebo
// by ju niekto obišiel priamym volaním Supabase klienta).
//
// Zámerne NEBLOKUJE úpravu/mazanie existujúcich záznamov ani ich
// prezeranie — iba vytváranie NOVÝCH riadkov v chránených tabuľkách.
// -----------------------------------------------------------------------
type CompanyDpaLegalHoldValue = { legalHold: boolean };

const CompanyDpaLegalHoldContext = createContext<CompanyDpaLegalHoldValue>({
  legalHold: false,
});

export function useCompanyDpaLegalHold(): CompanyDpaLegalHoldValue {
  return useContext(CompanyDpaLegalHoldContext);
}

// Rovnaký zoznam vynechaných ciest ako app/components/LegalAcceptanceGate.tsx
// (samostatná kópia, nie zdieľaná konštanta — obe komponenty majú vlastný,
// nezávisle čitateľný dôvod vynechania tých istých ciest: verejné právne
// stránky, prihlásenie/registrácia, obnova hesla, prijatie pozvánky).
const SKIP_PATH_PREFIXES = [
  "/login",
  "/invite",
  "/onboarding",
  "/reset-hesla",
  "/ochrana-osobnych-udajov",
  "/podmienky-pouzivania",
  "/cookies",
  "/dpa",
  "/subprocessors",
  "/kontakt",
  "/zrusenie-uctu",
  "/cennik",
];

// DÔLEŽITÉ poradie voči LegalAcceptanceGate: tento komponent sa v
// app/layout.tsx vnára DOVNÚTRA <LegalAcceptanceGate> (teda okolo toho
// istého {children}), takže obe komponenty bežia súčasne/nezávisle. Aby sa
// nikdy nezobrazili dva prekrývajúce sa full-screen modaly naraz
// nekoordinovane, tento gate používa NIŽŠÍ z-index (90) než
// LegalAcceptanceGate (100) — ak má používateľ nedoriešenú OSOBNÚ
// acceptance (Podmienky/Zásady), ten modal ju vizuálne prekryje ako
// prioritnejší; po jej potvrdení zostane tento company DPA modal (ak je
// relevantný) viditeľný bez potreby nového načítania.
const Z_INDEX = 90;

export default function CompanyDpaGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { t } = useLocale();
  const skip = SKIP_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname?.startsWith(prefix + "/")
  );

  const [status, setStatus] = useState<CompanyDpaStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [confirmedAuthority, setConfirmedAuthority] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [employeeNoticeDismissed, setEmployeeNoticeDismissed] =
    useState(false);

  useEffect(() => {
    if (skip) {
      return;
    }

    let cancelled = false;

    async function run() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        if (!cancelled) {
          setStatus(null);
          setChecked(true);
        }
        return;
      }

      const result = await getMyCompanyDpaStatus();

      if (!cancelled) {
        setStatus(result);
        setChecked(true);
      }
    }

    run();

    const { data: authListener } = supabase.auth.onAuthStateChange(() => {
      setChecked(false);
      setEmployeeNoticeDismissed(false);
      run();
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  async function handleLogout() {
    await signOutOnThisDevice();
    navigateHard("/login");
  }

  async function handleConfirm() {
    if (!confirmedAuthority || !status) {
      return;
    }

    setSubmitting(true);
    setSubmitError("");

    const ok = await acceptCompanyDpa(status.current_dpa_version);

    if (!ok) {
      setSubmitError(t("companyDpaGate.submitError"));
      setSubmitting(false);
      return;
    }

    setStatus({ ...status, has_current_acceptance: true });
    setSubmitting(false);
  }

  if (!checked || skip || !status || status.has_current_acceptance) {
    return <>{children}</>;
  }

  // REVÍZIA (štvrté kolo): iba OWNER smie DPA za firmu podpísať —
  // appková rola "admin" sama osebe nezakladá právne oprávnenie
  // uzatvárať zmluvy za firmu (rovnaká zmena ako v
  // esblu_accept_company_dpa() na DB strane, ktorá teraz DB-side
  // vyžaduje role='owner'). Admin je pre účely tohto gate v rovnakej
  // situácii ako employee: nesmie dostať možnosť DPA podpísať, iba
  // informáciu, že potvrdenie musí vykonať vlastník účtu.
  const isOwner = status.my_role === "owner";

  // Kým firma nemá platnú DPA acceptance, sme vždy v legal-hold režime —
  // táto vetva kódu (za skoro-return vyššie) sa vykoná IBA vtedy, keď
  // !status.has_current_acceptance. Sprístupňujeme to potomkom cez
  // kontext, aby stránky s vytváraním nových vozidiel/strojov/skladu/AI
  // evidencie mohli deaktivovať/skryť svoje "pridať nové" akcie —
  // pozri komentár pri CompanyDpaLegalHoldContext vyššie.
  return (
    <CompanyDpaLegalHoldContext.Provider value={{ legalHold: true }}>
      {children}

      {isOwner && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
          style={{ zIndex: Z_INDEX }}
        >
          <div className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-doc border border-doc-border bg-surface-1 p-4 shadow-2xl sm:p-6">
            <h2 className="text-lg font-semibold tracking-tight text-primary sm:text-xl">
              {t("companyDpaGate.title")}
            </h2>

            <p className="mt-2 text-sm leading-6 text-secondary">
              {t("companyDpaGate.description")}
            </p>

            <p className="mt-2 text-[13px]">
              <LegalDocLink path="/dpa" className="font-medium text-brand-300 hover:underline">
                {t("companyDpaGate.readCurrentDpa", {
                  version: status.current_dpa_version,
                })}
              </LegalDocLink>
            </p>

            <label className="mt-4 flex items-start gap-2.5 rounded-doc-sm border border-subtle bg-surface-2 p-3 text-[13px] leading-5 text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0"
                checked={confirmedAuthority}
                onChange={(event) =>
                  setConfirmedAuthority(event.target.checked)
                }
                disabled={submitting}
              />
              <span>
                {t("companyDpaGate.confirmAuthorityLabel", {
                  version: status.current_dpa_version,
                })}
              </span>
            </label>

            {submitError && (
              <p className="ui-error-text mt-3 text-[13px]">
                {submitError}
              </p>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={!confirmedAuthority || submitting}
              className="ui-btn ui-btn-primary mt-4 w-full"
            >
              {submitting
                ? t("legalGate.saving")
                : t("companyDpaGate.confirmButton")}
            </button>

            <button
              type="button"
              onClick={handleLogout}
              disabled={submitting}
              className="ui-btn ui-btn-ghost mt-2 w-full"
            >
              {t("legalGate.logout")}
            </button>
          </div>
        </div>
      )}

      {!isOwner && !employeeNoticeDismissed && (
        <div
          className="fixed inset-x-0 bottom-0 flex justify-center p-4"
          style={{ zIndex: Z_INDEX }}
        >
          <div className="w-full max-w-md rounded-doc border border-amber-300/30 bg-warning-soft p-3 shadow-2xl backdrop-blur-sm sm:p-4">
            <p className="text-sm font-semibold text-amber-300">
              {t("companyDpaGate.employeeNoticeTitle")}
            </p>
            <p className="mt-1 text-[13px] leading-5 text-amber-400">
              {t("companyDpaGate.employeeNoticeDescription")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setEmployeeNoticeDismissed(true)}
                className="ui-btn ui-btn-sm bg-amber-900 text-white hover:bg-amber-800"
              >
                {t("companyDpaGate.employeeNoticeDismiss")}
              </button>
              <LegalDocLink path="/dpa" className="ui-btn ui-btn-sm border-amber-300/40 bg-surface-1 text-amber-400 hover:bg-surface-hover">
                {t("companyDpaGate.viewDpa")}
              </LegalDocLink>
            </div>
          </div>
        </div>
      )}
    </CompanyDpaLegalHoldContext.Provider>
  );
}
