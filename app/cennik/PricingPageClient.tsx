"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { TrialOfferList } from "@/app/components/pricing/TrialOfferList";
import { PublicSiteFooter, PublicSiteHeader } from "@/app/components/public/PublicSite";
import { REGISTER_HREF } from "@/lib/public-links";
import {
  ADDON_IDS,
  ADDONS,
  COMPLETE_ALLOWANCES,
  MODULAR_ALLOWANCES,
  COMPLETE_PRICE_CENTS,
  MODULE_PRICE_CENTS,
  SECONDARY_COMPLETE_PRICE_CENTS,
  TRIAL_OFFER,
  BASE_MODULE_IDS,
  formatEurCents,
} from "@/lib/pricing";

// =============================================================================
// /cennik — cenník (Esblu Komplet / samostatné moduly / add-ony).
// Všetky čísla a výpočty výhradne z lib/pricing.ts (kanonický engine).
// Bez textu o DPH (Esblu s.r.o. nie je platiteľ DPH).
//
// Rozhodnutie vlastníka 2026-11-27: pri spustení sa predáva IBA Esblu Komplet
// (mesačne, objednávka v Nastavenia → Predplatné). Samostatné moduly, rozšírenia
// a zvýhodnená ďalšia firma sú „Pripravujeme“ — bez výberu a bez kalkulačky; nákup
// ich odmietne aj server (lib/billing/order-gate.ts, poistka LIVE cien v DB).
// =============================================================================

const FAQ = ["1", "2", "3", "4", "5"] as const;

export function PricingPageClient() {
  const { t, locale } = useLocale();
  const billingUi = process.env.NEXT_PUBLIC_ESBLU_BILLING_UI === "1";

  return (
    <div className="min-h-screen overflow-x-hidden bg-page-bg text-primary">
      <PublicSiteHeader />

      <main>
        <section className="relative overflow-hidden pb-8 pt-6 sm:py-20">
          <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[40rem] -translate-x-1/2 rounded-full bg-brand-500/10 blur-3xl" />
          <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-accent-cyan sm:text-sm">{t("pricing.kicker")}</p>
            <h1 className="mt-2 text-[1.875rem] font-black leading-[1.15] tracking-tight text-primary sm:mt-3 sm:text-5xl sm:leading-tight">{t("pricing.headline")}</h1>
            <p className="mt-3 text-base leading-7 text-secondary sm:mt-5 sm:text-lg sm:leading-8">{t("pricing.intro")}</p>
            <p className="mx-auto mt-4 max-w-2xl rounded-2xl border border-subtle bg-slate-950/60 px-3.5 py-2.5 text-xs leading-5 text-muted-esblu sm:mt-6 sm:px-4 sm:py-3 sm:text-sm sm:leading-6">
              {billingUi ? t("pricing.liveNotice") : t("pricing.betaNotice")}
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
              <Link href={REGISTER_HREF} className="btn-primary mt-5 flex min-h-12 w-full items-center justify-center px-5 py-3 text-center sm:mt-7 sm:px-6">
                {t("pricing.trial.cta")}
              </Link>
              <p className="mt-3 text-center text-xs text-muted-esblu">{t("pricing.trial.ctaNote")}</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="complete-title" className="border-t border-subtle py-10 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="surface-card relative mx-auto max-w-2xl overflow-hidden p-5 ring-2 ring-accent-cyan sm:p-8">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-cyan sm:text-sm">{t("pricing.complete.badge")}</p>
              <h2 id="complete-title" className="mt-1.5 text-2xl font-black tracking-tight text-primary sm:text-4xl">{t("pricing.complete.title")}</h2>
              <p className="mt-2">
                <span className="text-4xl font-black text-primary sm:text-5xl">{formatEurCents(COMPLETE_PRICE_CENTS, locale)}</span>{" "}
                <span className="text-sm text-muted-esblu sm:text-base">{t("pricing.complete.perMonth")} · {t("pricing.complete.perCompany")}</span>
              </p>
              <ul className="mt-5 space-y-2 text-secondary">
                {[
                  t("pricing.complete.allModules"),
                  t("pricing.complete.users", { count: COMPLETE_ALLOWANCES.users }),
                  t("pricing.complete.chat"),
                  t("pricing.complete.ai", { count: COMPLETE_ALLOWANCES.aiProcessingsPerMonth }),
                  t("pricing.complete.voice", { count: COMPLETE_ALLOWANCES.voiceMinutesPerMonth }),
                  t("pricing.complete.storage", { gb: COMPLETE_ALLOWANCES.storageMb / 1024 }),
                  t("pricing.complete.einvoice", { count: COMPLETE_ALLOWANCES.einvoiceTransactionsPerMonth }),
                ].map((text) => (
                  <li key={text} className="flex items-start gap-3">
                    <span aria-hidden="true" className="mt-0.5 text-accent-cyan">✓</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="modules-title" className="border-t border-subtle py-10 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <span className="inline-block rounded-full bg-accent-orange/15 px-3 py-1 text-xs font-bold text-accent-orange">{t("pricing.modules.comingSoon")}</span>
              <h2 id="modules-title" className="mt-2 text-2xl font-black leading-tight tracking-tight text-primary sm:text-4xl">{t("pricing.modules.title")}</h2>
              <p className="mt-2 text-[0.95rem] leading-6 text-secondary sm:mt-4 sm:text-base sm:leading-7">
                {t("pricing.modules.intro", { price: formatEurCents(MODULE_PRICE_CENTS, locale) })}
              </p>
              <p className="mt-2 text-sm text-secondary">
                {t("pricing.modules.paidBase", { users: MODULAR_ALLOWANCES.users, gb: MODULAR_ALLOWANCES.storageMb / 1024 })}
              </p>
              <p className="mt-1 text-sm text-muted-esblu">
                {t("pricing.modules.voiceNote", { units: ADDONS.voice_60.units, price: formatEurCents(ADDONS.voice_60.priceCents, locale) })}
              </p>
            </div>

            <div className="mt-6 grid gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
              {BASE_MODULE_IDS.map((module) => (
                <article key={module} className="surface-card flex flex-col p-4 sm:p-6">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-lg font-black leading-snug text-primary sm:text-xl">{t(`pricing.modules.items.${module}.name`)}</h3>
                    <span className="rounded-full bg-accent-orange/15 px-2.5 py-1 text-xs font-bold text-accent-orange">{t("pricing.modules.comingSoon")}</span>
                  </div>
                  <p className="mt-1 flex-1 text-sm leading-[1.35rem] text-secondary sm:mt-2 sm:leading-6">{t(`pricing.modules.items.${module}.description`)}</p>
                  {module === "documents" && (
                    <p className="mt-2 text-sm font-semibold text-accent-teal sm:mt-3">{t("pricing.modules.includedAi", { count: MODULAR_ALLOWANCES.aiProcessingsPerMonthWithDocuments })}</p>
                  )}
                  <p className="mt-3 min-w-0 sm:mt-4">
                    <span className="text-2xl font-black text-primary sm:text-3xl">{formatEurCents(MODULE_PRICE_CENTS, locale)}</span>{" "}
                    <span className="block text-xs leading-5 text-muted-esblu sm:inline sm:text-sm">
                      {t("pricing.modules.perMonth")} · {t("pricing.modules.perCompany")}
                    </span>
                  </p>
                </article>
              ))}
            </div>

            <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-muted-esblu sm:mt-8">{t("pricing.modules.notYet")}</p>
          </div>
        </section>

        <section aria-labelledby="addons-title" className="border-t border-subtle py-10 sm:py-16">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
            <p className="text-center"><span className="inline-block rounded-full bg-accent-orange/15 px-3 py-1 text-xs font-bold text-accent-orange">{t("pricing.modules.comingSoon")}</span></p>
            <h2 id="addons-title" className="mt-2 text-center text-2xl font-black tracking-tight text-primary sm:text-3xl">{t("pricing.addons.title")}</h2>
            <p className="mt-2 text-center text-secondary">{t("pricing.addons.intro")}</p>
            <ul className="mt-5 divide-y divide-white/10 surface-card">
              {ADDON_IDS.map((id) => (
                <li key={id} className="flex items-center justify-between gap-3 p-4">
                  <span className="text-primary">
                    {t(`pricing.addons.${id}`, { units: ADDONS[id].units })}
                    <span className="ml-2 text-xs text-accent-orange">{t("pricing.modules.comingSoon")}</span>
                  </span>
                  <span className="whitespace-nowrap font-bold text-primary">{t("pricing.addons.perMonth", { price: formatEurCents(ADDONS[id].priceCents, locale) })}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-center text-xs text-muted-esblu">{t("pricing.addons.einvoiceNote")}</p>
          </div>
        </section>

        <section aria-labelledby="secondary-title" className="border-t border-subtle py-10 sm:py-16">
          <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
            <span className="inline-block rounded-full bg-accent-orange/15 px-3 py-1 text-xs font-bold text-accent-orange">{t("pricing.modules.comingSoon")}</span>
            <h2 id="secondary-title" className="mt-2 text-xl font-black text-primary sm:text-3xl">{t("pricing.secondary.title")}</h2>
            <p className="mt-2 text-secondary">{t("pricing.secondary.text", { price: formatEurCents(SECONDARY_COMPLETE_PRICE_CENTS, locale) })}</p>
            <p className="mx-auto mt-4 max-w-2xl text-sm text-muted-esblu">{t("pricing.usersNote")}</p>
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
              <Link href={REGISTER_HREF} className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3">
                {t("pricing.trial.cta")}
              </Link>
              <Link href="/" className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3">
                {t("pricing.nav.backHome")}
              </Link>
            </div>
          </div>
        </section>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
