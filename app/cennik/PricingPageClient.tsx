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
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8 lg:py-4">
          <Link href="/" aria-label={t("pricing.nav.backHome")} className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">
            <BrandMark />
          </Link>
          {/* Pod sm sa jazyk presúva do úvodu stránky (nižšie), aby sa hlavička netlačila. */}
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <div className="hidden sm:block">
              <LanguageSwitcher variant="dark" />
            </div>
            <Link href="/login" className="btn-secondary inline-flex min-h-11 items-center whitespace-nowrap px-4 py-2 text-sm">
              {t("pricing.nav.login")}
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden pb-8 pt-6 sm:py-20">
          <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[40rem] -translate-x-1/2 rounded-full bg-accent-cyan/10 blur-3xl" />
          <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
            <div className="mb-5 flex justify-center sm:hidden">
              <LanguageSwitcher variant="dark" />
            </div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-accent-cyan sm:text-sm">{t("pricing.kicker")}</p>
            <h1 className="mt-2 text-[1.875rem] font-black leading-[1.15] tracking-tight text-primary sm:mt-3 sm:text-5xl sm:leading-tight">{t("pricing.headline")}</h1>
            <p className="mt-3 text-base leading-7 text-secondary sm:mt-5 sm:text-lg sm:leading-8">{t("pricing.intro")}</p>
            <p className="mx-auto mt-4 max-w-2xl rounded-2xl border border-subtle bg-slate-950/60 px-3.5 py-2.5 text-xs leading-5 text-muted-esblu sm:mt-6 sm:px-4 sm:py-3 sm:text-sm sm:leading-6">
              {t("pricing.betaNotice")}
            </p>
          </div>
        </section>

        <section aria-labelledby="trial-title" className="pb-10 sm:pb-16">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="surface-card relative mx-auto max-w-2xl overflow-hidden p-5 shadow-2xl shadow-black/40 sm:p-8">
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-accent-cyan to-accent-blue-strong opacity-80" />
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-cyan sm:text-sm">{t("pricing.trial.badge")}</p>
              <h2 id="trial-title" className="mt-1.5 text-2xl font-black tracking-tight text-primary sm:mt-2 sm:text-4xl">
                {t("pricing.trial.title", { days: TRIAL_OFFER.days })}
              </h2>
              <p className="mt-1.5 text-3xl font-black text-primary sm:mt-2 sm:text-4xl">
                {t("pricing.trial.price")}{" "}
                {!TRIAL_OFFER.paymentCardRequired && (
                  <span className="text-sm font-semibold text-muted-esblu sm:text-base">· {t("pricing.trial.priceNote")}</span>
                )}
              </p>
              <div className="mt-5 sm:mt-6">
                <TrialOfferList />
              </div>
              <div className="mt-5 space-y-1.5 text-sm leading-6 text-secondary sm:mt-6 sm:space-y-2">
                <p>{t("pricing.trial.after")}</p>
                <p className="font-semibold text-primary">{t("pricing.trial.keepData")}</p>
              </div>
              <a href="mailto:info@esblu.com" className="btn-primary mt-5 flex min-h-12 w-full items-center justify-center px-5 py-3 text-center sm:mt-7 sm:px-6">
                {t("pricing.trial.cta")}
              </a>
              <p className="mt-3 text-center text-xs text-muted-esblu">{t("pricing.trial.ctaNote")}</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="modules-title" className="border-t border-subtle py-10 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <h2 id="modules-title" className="text-2xl font-black leading-tight tracking-tight text-primary sm:text-4xl">{t("pricing.modules.title")}</h2>
              <p className="mt-2 text-[0.95rem] leading-6 text-secondary sm:mt-4 sm:text-base sm:leading-7">{t("pricing.modules.intro")}</p>
              <p className="mt-2 text-[0.95rem] font-semibold leading-6 text-accent-cyan sm:mt-3 sm:text-base">{t("pricing.modules.example")}</p>
            </div>

            <div className="mt-6 grid gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
              {PRICING_MODULES.map((module) => {
                const isSelected = selected.includes(module.id);
                const available = module.availability === "available";
                return (
                  <article
                    key={module.id}
                    className={`surface-card flex flex-col p-4 transition sm:p-6 ${isSelected ? "ring-2 ring-accent-cyan" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-lg font-black leading-snug text-primary sm:text-xl">{t(`pricing.modules.items.${module.id}.name`)}</h3>
                      {!available && (
                        <span className="rounded-full bg-accent-orange/15 px-2.5 py-1 text-xs font-bold text-accent-orange">
                          {t("pricing.modules.comingSoon")}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 flex-1 text-sm leading-[1.35rem] text-secondary sm:mt-2 sm:leading-6">{t(`pricing.modules.items.${module.id}.description`)}</p>
                    {module.includedMonthlyUsage !== null && (
                      <p className="mt-2 text-sm font-semibold text-accent-teal sm:mt-3">
                        {tCount("pricing.modules.includedAi", module.includedMonthlyUsage)}
                      </p>
                    )}
                    {/* Mobil: cena a tlačidlo v jednom riadku; od sm pod sebou. */}
                    <div className="mt-3 flex items-center justify-between gap-3 sm:mt-4 sm:block">
                    <p className="min-w-0">
                      {module.monthlyPriceExclVat === null ? (
                        <span className="text-lg font-bold text-muted-esblu">{t("pricing.modules.priceTbd")}</span>
                      ) : (
                        <>
                          <span className="text-2xl font-black text-primary sm:text-3xl">{formatEur(module.monthlyPriceExclVat, locale)}</span>{" "}
                          <span className="block text-xs leading-5 text-muted-esblu sm:inline sm:text-sm">
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
                      className={`inline-flex min-h-10 shrink-0 items-center justify-center whitespace-nowrap px-3.5 py-2 text-sm sm:mt-4 sm:min-h-11 sm:w-full sm:px-4 ${isSelected ? "btn-primary" : "btn-secondary"} disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {isSelected ? t("pricing.modules.selected") : t("pricing.modules.select")}
                    </button>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="surface-card mx-auto mt-6 max-w-2xl p-4 sm:mt-8 sm:p-6" aria-live="polite">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-esblu sm:text-sm">{t("pricing.summary.title")}</p>
              {selected.length === 0 ? (
                <p className="mt-2 text-secondary">{t("pricing.summary.empty")}</p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-secondary">
                    {PRICING_MODULES.filter((m) => selected.includes(m.id))
                      .map((m) => t(`pricing.modules.items.${m.id}.name`))
                      .join(" + ")}
                  </p>
                  <p className="mt-1 text-xl font-black text-primary sm:text-2xl">{t("pricing.summary.total", { amount: formatEur(total, locale) })}</p>
                </>
              )}
              <p className="mt-3 text-xs text-muted-esblu">{t("pricing.summary.disclaimer")}</p>
            </div>

            <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-muted-esblu sm:mt-6">{t("pricing.usersNote")}</p>
          </div>
        </section>

        <section className="border-t border-subtle py-10 sm:py-16">
          <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-xl font-black text-primary sm:text-3xl">{t("pricing.dataSafety.title")}</h2>
            <p className="mt-2 text-[0.95rem] leading-6 text-secondary sm:mt-4 sm:text-base sm:leading-7">{t("pricing.dataSafety.text")}</p>
          </div>
        </section>

        <section aria-labelledby="faq-title" className="border-t border-subtle py-10 sm:py-20">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
            <h2 id="faq-title" className="text-center text-2xl font-black tracking-tight text-primary sm:text-3xl">{t("pricing.faq.title")}</h2>
            <div className="mt-5 space-y-2 sm:mt-8 sm:space-y-3">
              {FAQ.map((n) => (
                <details key={n} className="surface-card group p-4 sm:p-5">
                  <summary className="cursor-pointer list-none rounded-lg text-[0.95rem] font-bold leading-6 text-primary marker:hidden sm:text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan">
                    <span className="flex items-center justify-between gap-4">
                      {t(`pricing.faq.q${n}`)}
                      <span aria-hidden="true" className="text-accent-cyan transition group-open:rotate-45">+</span>
                    </span>
                  </summary>
                  <p className="mt-2 text-[0.95rem] leading-6 text-secondary sm:mt-3 sm:text-base sm:leading-7">{t(`pricing.faq.a${n}`)}</p>
                </details>
              ))}
            </div>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:mt-10 sm:flex-row sm:items-center">
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
