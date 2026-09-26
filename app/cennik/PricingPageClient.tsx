"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import LanguageSwitcher from "@/app/components/LanguageSwitcher";
import { TrialOfferList } from "@/app/components/pricing/TrialOfferList";
import {
  PRICING_MODULES,
  TRIAL_OFFER,
  formatEur,
  monthlyTotalExclVat,
  type PricingModuleId,
} from "@/lib/pricing";

// =============================================================================
// /cennik — verejný cenník (modulárny model). Všetky čísla z lib/pricing.ts.
//
// Kalkulačka je IBA informatívna: výber kariet nič neaktivuje, neukladá ani
// neúčtuje (žiadny billing provider neexistuje). CTA vedie na žiadosť o
// beta prístup — uzavretá beta ostáva autoritou pre registráciu.
// =============================================================================

const FAQ = ["1", "2", "3", "4", "5"] as const;

function BrandMark() {
  return (
    <span className="flex items-center gap-3">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent-cyan to-accent-blue-strong shadow-lg shadow-black/30">
        <span aria-hidden="true" className="h-5 w-5 rotate-45 rounded-sm border-[3px] border-[#051221]" />
      </span>
      <span className="text-2xl font-black tracking-tight text-white">Esblu</span>
    </span>
  );
}

export function PricingPageClient() {
  const { t, tCount, locale } = useLocale();
  const [selected, setSelected] = useState<PricingModuleId[]>([]);
  const total = useMemo(() => monthlyTotalExclVat(selected), [selected]);

  const toggle = (id: PricingModuleId) =>
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <div className="min-h-screen overflow-x-hidden bg-page-bg text-primary">
      <header className="sticky top-0 z-50 border-b border-subtle bg-slate-950/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" aria-label={t("pricing.nav.backHome")} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">
            <BrandMark />
          </Link>
          <div className="flex items-center gap-3">
            <LanguageSwitcher variant="dark" />
            <Link href="/login" className="btn-secondary inline-flex min-h-11 items-center px-4 py-2 text-sm">
              {t("pricing.nav.login")}
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden py-16 sm:py-20">
          <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[40rem] -translate-x-1/2 rounded-full bg-accent-cyan/10 blur-3xl" />
          <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-accent-cyan">{t("pricing.kicker")}</p>
            <h1 className="mt-3 text-4xl font-black tracking-tight text-primary sm:text-5xl">{t("pricing.headline")}</h1>
            <p className="mt-5 text-lg leading-8 text-secondary">{t("pricing.intro")}</p>
            <p className="mx-auto mt-6 max-w-2xl rounded-2xl border border-subtle bg-slate-950/60 px-4 py-3 text-sm leading-6 text-muted-esblu">
              {t("pricing.betaNotice")}
            </p>
          </div>
        </section>

        <section aria-labelledby="trial-title" className="pb-16">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="surface-card relative mx-auto max-w-2xl overflow-hidden p-6 shadow-2xl shadow-black/40 sm:p-8">
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-accent-cyan to-accent-blue-strong opacity-80" />
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-accent-cyan">{t("pricing.trial.badge")}</p>
              <h2 id="trial-title" className="mt-2 text-3xl font-black tracking-tight text-primary sm:text-4xl">
                {t("pricing.trial.title", { days: TRIAL_OFFER.days })}
              </h2>
              <p className="mt-2 text-4xl font-black text-primary">
                {t("pricing.trial.price")}{" "}
                {!TRIAL_OFFER.paymentCardRequired && (
                  <span className="text-base font-semibold text-muted-esblu">· {t("pricing.trial.priceNote")}</span>
                )}
              </p>
              <div className="mt-6">
                <TrialOfferList />
              </div>
              <div className="mt-6 space-y-2 text-sm leading-6 text-secondary">
                <p>{t("pricing.trial.after")}</p>
                <p className="font-semibold text-primary">{t("pricing.trial.keepData")}</p>
              </div>
              <a href="mailto:info@esblu.com" className="btn-primary mt-7 flex min-h-12 w-full items-center justify-center px-6 py-3 text-center">
                {t("pricing.trial.cta")}
              </a>
              <p className="mt-3 text-center text-xs text-muted-esblu">{t("pricing.trial.ctaNote")}</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="modules-title" className="border-t border-subtle py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <h2 id="modules-title" className="text-3xl font-black tracking-tight text-primary sm:text-4xl">{t("pricing.modules.title")}</h2>
              <p className="mt-4 leading-7 text-secondary">{t("pricing.modules.intro")}</p>
              <p className="mt-3 font-semibold text-accent-cyan">{t("pricing.modules.example")}</p>
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PRICING_MODULES.map((module) => {
                const isSelected = selected.includes(module.id);
                const available = module.availability === "available";
                return (
                  <article
                    key={module.id}
                    className={`surface-card flex flex-col p-5 transition sm:p-6 ${isSelected ? "ring-2 ring-accent-cyan" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-xl font-black text-primary">{t(`pricing.modules.items.${module.id}.name`)}</h3>
                      {!available && (
                        <span className="rounded-full bg-accent-orange/15 px-2.5 py-1 text-xs font-bold text-accent-orange">
                          {t("pricing.modules.comingSoon")}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 flex-1 text-sm leading-6 text-secondary">{t(`pricing.modules.items.${module.id}.description`)}</p>
                    {module.includedMonthlyUsage !== null && (
                      <p className="mt-3 text-sm font-semibold text-accent-teal">
                        {tCount("pricing.modules.includedAi", module.includedMonthlyUsage)}
                      </p>
                    )}
                    <p className="mt-4">
                      {module.monthlyPriceExclVat === null ? (
                        <span className="text-lg font-bold text-muted-esblu">{t("pricing.modules.priceTbd")}</span>
                      ) : (
                        <>
                          <span className="text-3xl font-black text-primary">{formatEur(module.monthlyPriceExclVat, locale)}</span>{" "}
                          <span className="text-sm text-muted-esblu">
                            {t("pricing.modules.perMonth")} · {t("pricing.modules.perCompany")}
                          </span>
                        </>
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => toggle(module.id)}
                      aria-pressed={isSelected}
                      disabled={!available || module.monthlyPriceExclVat === null}
                      className={`mt-4 inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm ${isSelected ? "btn-primary" : "btn-secondary"} disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {isSelected ? t("pricing.modules.selected") : t("pricing.modules.select")}
                    </button>
                  </article>
                );
              })}
            </div>

            <div className="surface-card mx-auto mt-8 max-w-2xl p-5 sm:p-6" aria-live="polite">
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-muted-esblu">{t("pricing.summary.title")}</p>
              {selected.length === 0 ? (
                <p className="mt-2 text-secondary">{t("pricing.summary.empty")}</p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-secondary">
                    {PRICING_MODULES.filter((m) => selected.includes(m.id))
                      .map((m) => t(`pricing.modules.items.${m.id}.name`))
                      .join(" + ")}
                  </p>
                  <p className="mt-1 text-2xl font-black text-primary">{t("pricing.summary.total", { amount: formatEur(total, locale) })}</p>
                </>
              )}
              <p className="mt-3 text-xs text-muted-esblu">{t("pricing.summary.disclaimer")}</p>
            </div>

            <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-muted-esblu">{t("pricing.usersNote")}</p>
          </div>
        </section>

        <section className="border-t border-subtle py-16">
          <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-2xl font-black text-primary sm:text-3xl">{t("pricing.dataSafety.title")}</h2>
            <p className="mt-4 leading-7 text-secondary">{t("pricing.dataSafety.text")}</p>
          </div>
        </section>

        <section aria-labelledby="faq-title" className="border-t border-subtle py-16 sm:py-20">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
            <h2 id="faq-title" className="text-center text-3xl font-black tracking-tight text-primary">{t("pricing.faq.title")}</h2>
            <div className="mt-8 space-y-3">
              {FAQ.map((n) => (
                <details key={n} className="surface-card group p-5">
                  <summary className="cursor-pointer list-none font-bold text-primary marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">
                    <span className="flex items-center justify-between gap-4">
                      {t(`pricing.faq.q${n}`)}
                      <span aria-hidden="true" className="text-accent-cyan transition group-open:rotate-45">+</span>
                    </span>
                  </summary>
                  <p className="mt-3 leading-7 text-secondary">{t(`pricing.faq.a${n}`)}</p>
                </details>
              ))}
            </div>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href="mailto:info@esblu.com" className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3">
                {t("pricing.trial.cta")}
              </a>
              <Link href="/" className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3">
                {t("pricing.nav.backHome")}
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
