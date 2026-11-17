"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { isVideoPublished } from "@/lib/landing-video";
import { LOGIN_HREF, REGISTER_HREF } from "@/lib/public-links";
import EsbluDemoVideo, { emitVideoCtaClick } from "./EsbluDemoVideo";
import LandingVideoJsonLd from "./LandingVideoJsonLd";
import ChatBubbleIcon from "./icons/ChatBubbleIcon";
import { CheckIcon, SparkleIcon } from "./icons/AppIcons";
import { TrialOfferList } from "./pricing/TrialOfferList";
import { PublicSiteFooter, PublicSiteHeader } from "./public/PublicSite";

// =============================================================================
// PublicLandingPage — verejná stránka pre neprihláseného návštevníka na "/"
// (app/page.tsx). Vizuálne zladená s aktuálnou aplikáciou:
//   - rovnaké tokeny a komponenty (app/globals.css: page-bg, surface-card,
//     btn-primary/secondary, brand-* modrá, icon-glow-*),
//   - rovnaké ilustrácie modulov ako Dashboard (/images/modules/<key>.svg),
//   - úvodná sekcia ukazuje skutočné obrazovky Esblu (Dashboard „Dnes“) s
//     demo údajmi — /images/landing/*.webp, generované skriptom
//     scripts/landing-screenshots (syntetická firma, žiadne reálne údaje).
// Obsah AI transparentnosti, bezpečnosti a právnych odkazov je prevzatý zo
// schválených textov (i18n landing.ai.*, landing.security.*, /legal).
// =============================================================================

type Accent = "cyan" | "blue" | "orange" | "teal";

const ACCENT: Record<Accent, { glow: string; chip: string }> = {
  cyan: { glow: "icon-glow-cyan", chip: "bg-accent-cyan/12 text-accent-cyan" },
  blue: { glow: "icon-glow-blue", chip: "bg-accent-blue/12 text-brand-300" },
  orange: { glow: "icon-glow-orange", chip: "bg-accent-orange/12 text-accent-orange" },
  teal: { glow: "icon-glow-teal", chip: "bg-accent-teal/12 text-accent-teal" },
};

// Rovnaké moduly, poradie farieb a ilustrácie ako Dashboard (ModuleCylinder).
const FEATURES: {
  module: string;
  titleKey: string;
  descKey: string;
  accent: Accent;
  exampleKeys?: string[];
  badgeTitleKey?: string;
  badgeDescKey?: string;
}[] = [
  {
    module: "inbox",
    titleKey: "landing.features.inboxTitle",
    descKey: "landing.features.inboxDesc",
    accent: "cyan",
    exampleKeys: [
      "landing.features.inboxExample1",
      "landing.features.inboxExample2",
      "landing.features.inboxExample3",
      "landing.features.inboxExample4",
      "landing.features.inboxExample5",
      "landing.features.inboxExample6",
      "landing.features.inboxExample7",
      "landing.features.inboxExampleMore",
    ],
  },
  {
    module: "invoices",
    titleKey: "landing.features.invoicesTitle",
    descKey: "landing.features.invoicesDesc",
    accent: "teal",
    // eFaktúra je zreteľne označená ako pripravovaná — nikdy ako dostupná.
    badgeTitleKey: "landing.features.efakturaBadge",
    badgeDescKey: "landing.features.efakturaDesc",
  },
  { module: "vehicles", titleKey: "landing.features.vehiclesTitle", descKey: "landing.features.vehiclesDesc", accent: "blue" },
  { module: "machines", titleKey: "landing.features.machinesTitle", descKey: "landing.features.machinesDesc", accent: "orange" },
  { module: "inventory", titleKey: "landing.features.inventoryTitle", descKey: "landing.features.inventoryDesc", accent: "teal" },
  { module: "partners", titleKey: "landing.features.businessPartnersTitle", descKey: "landing.features.businessPartnersDesc", accent: "blue" },
];

const AUDIENCE_KEYS = ["landing.audience.example1", "landing.audience.example2", "landing.audience.example3", "landing.audience.example4", "landing.audience.example5"];
const AI_POINT_KEYS = ["landing.ai.point1", "landing.ai.point2", "landing.ai.point3", "landing.ai.point4"];
const STEP_KEYS = [1, 2, 3] as const;

function SectionIntro({ kicker, title, subtitle, center = false, id }: { kicker: string; title: string; subtitle?: string; center?: boolean; id?: string }) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent-cyan sm:text-sm">{kicker}</p>
      <h2 id={id} className="mt-3 text-3xl font-black tracking-tight text-primary sm:text-4xl">{title}</h2>
      {subtitle && <p className="mt-4 text-base leading-7 text-secondary sm:text-lg sm:leading-8">{subtitle}</p>}
    </div>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-500/15 text-brand-300">
        <CheckIcon size={13} strokeWidth={2.6} />
      </span>
      <span>{children}</span>
    </li>
  );
}

/** Skutočné obrazovky aplikácie (demo údaje): počítač v rámci okna + mobil. */
function ProductShots() {
  const { t } = useLocale();
  return (
    <figure className="relative mx-auto w-full max-w-[40rem] lg:max-w-none" aria-label={t("landing.hero.screenshotsLabel")}>
      <div aria-hidden="true" className="absolute -inset-6 rounded-[2rem] bg-[radial-gradient(60%_60%_at_60%_40%,rgba(1,129,253,0.28),rgba(1,129,253,0)_70%)] blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-border-strong bg-surface-1 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-1.5 border-b border-subtle bg-page-bg-elevated px-3 py-2" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="ml-3 hidden h-5 flex-1 rounded-md bg-white/5 px-2 text-[10px] leading-5 text-muted-esblu sm:block">www.esblu.com</span>
        </div>
        <Image
          src="/images/landing/esblu-dashboard-desktop.webp"
          alt={t("landing.hero.screenshotDesktopAlt")}
          width={1440}
          height={900}
          priority
          sizes="(min-width: 1024px) 620px, 100vw"
          className="block h-auto w-full"
        />
      </div>
      <div className="absolute -bottom-8 -right-2 w-[30%] min-w-[7.5rem] max-w-[12.5rem] sm:-right-5">
        <div className="overflow-hidden rounded-[1.6rem] border-[5px] border-[#1a2232] bg-page-bg shadow-2xl shadow-black/70 ring-1 ring-border-strong">
          <Image
            src="/images/landing/esblu-dashboard-mobile.webp"
            alt={t("landing.hero.screenshotMobileAlt")}
            width={780}
            height={1560}
            sizes="200px"
            className="block h-auto w-full"
          />
        </div>
      </div>
      <figcaption className="mt-12 text-center text-xs text-muted-esblu lg:text-left">{t("landing.hero.screenshotCaption")}</figcaption>
    </figure>
  );
}

export default function PublicLandingPage() {
  const { t } = useLocale();
  const videoPublished = isVideoPublished();

  return (
    <div className="min-h-screen overflow-x-hidden bg-page-bg text-primary">
      <a
        href="#obsah"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        {t("landing.nav.skipToContent")}
      </a>
      <PublicSiteHeader onHome />

      <main id="obsah">
        {/* ÚVOD — čo Esblu je, ako vyzerá a kde si vytvoriť účet. */}
        <section id="uvod" className="relative scroll-mt-24 overflow-hidden">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_45%_at_80%_10%,rgba(56,189,248,0.10),rgba(56,189,248,0)_70%),radial-gradient(40%_40%_at_10%_0%,rgba(1,129,253,0.12),rgba(1,129,253,0)_70%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-8 sm:px-6 sm:pt-14 lg:grid-cols-[0.95fr_1.05fr] lg:gap-14 lg:px-8 lg:pb-24 lg:pt-20">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1.5 text-xs font-semibold text-brand-300 sm:text-sm">
                <SparkleIcon size={14} />
                {t("landing.hero.badge")}
              </p>
              <h1 className="mt-4 text-[2.25rem] font-black leading-[1.08] tracking-tight text-primary sm:mt-5 sm:text-5xl lg:text-6xl">
                {t("landing.hero.title")}
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-secondary sm:mt-5 sm:text-lg sm:leading-8">
                {t("landing.hero.subtitle")}
              </p>

              <div className="mt-6 flex flex-col gap-3 sm:mt-8 sm:flex-row sm:flex-wrap">
                <Link href={REGISTER_HREF} className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3 text-base">
                  {t("landing.hero.ctaPrimary")}
                </Link>
                {videoPublished ? (
                  <a href="#ukazka" className="btn-secondary inline-flex min-h-12 items-center justify-center gap-2 px-6 py-3">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.74-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
                    </svg>
                    {t("landing.hero.ctaVideo")}
                  </a>
                ) : (
                  <Link href={LOGIN_HREF} className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3">
                    {t("landing.hero.ctaSecondary")}
                  </Link>
                )}
              </div>

              <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-secondary">
                <Check>{t("landing.hero.point1")}</Check>
                <Check>{t("landing.hero.point2")}</Check>
                <Check>{t("landing.hero.point3")}</Check>
              </ul>
              <p className="mt-3 text-xs leading-5 text-muted-esblu sm:text-sm">{t("landing.hero.trialNote")}</p>
            </div>

            <ProductShots />
          </div>
        </section>

        {videoPublished && (
          <section id="ukazka" className="scroll-mt-24 border-y border-subtle bg-page-bg-elevated py-20 sm:py-24">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
              <SectionIntro kicker={t("landing.video.kicker")} title={t("landing.video.title")} subtitle={t("landing.video.subtitle")} />
              <EsbluDemoVideo />
              <LandingVideoJsonLd />
              <div className="surface-card mt-12 p-6 sm:p-10">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                  <div className="max-w-2xl">
                    <h3 className="text-2xl font-black tracking-tight text-primary sm:text-3xl">{t("landing.video.ctaTitle")}</h3>
                    <p className="mt-3 text-base leading-7 text-secondary">{t("landing.video.ctaDescription")}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
                    <Link href={REGISTER_HREF} onClick={emitVideoCtaClick} className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3">
                      {t("landing.video.ctaPrimary")}
                    </Link>
                    <a href="#funkcie" className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3">
                      {t("landing.video.ctaSecondary")}
                    </a>
                  </div>
                </div>
                <p className="mt-6 text-sm text-muted-esblu">{t("landing.video.publicNote")}</p>
              </div>
            </div>
          </section>
        )}

        {/* FUNKCIE — rovnaké moduly a ilustrácie ako Dashboard aplikácie. */}
        <section id="funkcie" aria-labelledby="funkcie-title" className="scroll-mt-24 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <SectionIntro id="funkcie-title" kicker={t("landing.features.kicker")} title={t("landing.features.title")} subtitle={t("landing.features.subtitle")} />

            <div className="mt-10 grid gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
              {FEATURES.map((feature) => {
                const accent = ACCENT[feature.accent];
                return (
                  <article key={feature.module} className="surface-card surface-card-hover flex flex-col p-5 sm:p-6">
                    <div className="flex items-center gap-4">
                      <span className={`grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-surface-2 ${accent.glow}`}>
                        <Image src={`/images/modules/${feature.module}.svg`} alt="" aria-hidden="true" width={56} height={56} className="h-14 w-14 object-contain" />
                      </span>
                      <h3 className="text-xl font-black text-primary">{t(feature.titleKey)}</h3>
                    </div>
                    <p className="mt-4 text-[0.95rem] leading-7 text-secondary">{t(feature.descKey)}</p>
                    {feature.exampleKeys && (
                      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label={t("landing.features.examplesAriaLabel")}>
                        {feature.exampleKeys.map((key) => (
                          <li key={key} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${accent.chip}`}>{t(key)}</li>
                        ))}
                      </ul>
                    )}
                    {feature.badgeTitleKey && feature.badgeDescKey && (
                      <div className="mt-4 rounded-xl border border-dashed border-subtle bg-surface-2 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-accent-cyan">{t(feature.badgeTitleKey)}</p>
                        <p className="mt-1.5 text-sm leading-6 text-muted-esblu">{t(feature.badgeDescKey)}</p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            <div className="surface-card-2 mt-5 flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-600 text-white">
                <ChatBubbleIcon size={24} className="h-6 w-6" />
              </span>
              <div>
                <p className="font-bold text-primary">{t("landing.features.chatTitle")}</p>
                <p className="mt-1 text-sm leading-6 text-secondary">{t("landing.features.chatDesc")}</p>
              </div>
            </div>
          </div>
        </section>

        {/* AKO ZAČAŤ — registrácia → firma + IČO (trial) → tím. */}
        <section id="ako-zacat" aria-labelledby="ako-zacat-title" className="scroll-mt-24 border-y border-subtle bg-page-bg-elevated py-20 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <SectionIntro id="ako-zacat-title" kicker={t("landing.steps.kicker")} title={t("landing.steps.title")} subtitle={t("landing.steps.subtitle")} />
            <ol className="mt-10 grid gap-4 md:grid-cols-3 md:gap-5">
              {STEP_KEYS.map((n) => (
                <li key={n} className="surface-card p-6">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-brand-600 text-base font-black text-white">{n}</span>
                  <h3 className="mt-4 text-lg font-black text-primary">{t(`landing.steps.step${n}Title`)}</h3>
                  <p className="mt-2 text-[0.95rem] leading-7 text-secondary">{t(`landing.steps.step${n}Desc`)}</p>
                </li>
              ))}
            </ol>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href={REGISTER_HREF} className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3">
                {t("landing.hero.ctaPrimary")}
              </Link>
              <Link href="/cennik" className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3">
                {t("pricing.landingCta")}
              </Link>
            </div>
          </div>
        </section>

        {/* AI SPRACOVANIE + TRANSPARENTNOSŤ — schválené formulácie bez mena poskytovateľa. */}
        <section id="ai-spracovanie" aria-labelledby="ai-title" className="scroll-mt-24 py-20 sm:py-24">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
            <div>
              <SectionIntro id="ai-title" kicker={t("landing.ai.kicker")} title={t("landing.ai.title")} subtitle={t("landing.ai.description")} />
              <ol className="mt-8 grid gap-3">
                {["landing.ai.step1", "landing.ai.step2", "landing.ai.step3"].map((key, index) => (
                  <li key={key} className="surface-card flex items-center gap-4 p-4">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-500/15 text-sm font-black text-brand-300">{index + 1}</span>
                    <span className="font-semibold leading-6 text-primary">{t(key)}</span>
                  </li>
                ))}
              </ol>
            </div>
            <aside className="surface-card self-start p-6 sm:p-8">
              <h3 className="text-lg font-black text-primary">{t("landing.ai.transparencyTitle")}</h3>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-secondary">
                {AI_POINT_KEYS.map((key) => (
                  <Check key={key}>{t(key)}</Check>
                ))}
              </ul>
              <p className="ui-notice mt-5" data-tone="warning">{t("landing.ai.warning")}</p>
              <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold">
                <Link href="/ochrana-osobnych-udajov" className="rounded text-brand-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">{t("landing.ai.privacyLink")}</Link>
                <Link href="/podmienky-pouzivania" className="rounded text-brand-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">{t("landing.ai.termsLink")}</Link>
              </div>
            </aside>
          </div>
        </section>

        {/* PRE KOHO */}
        <section id="pre-koho" aria-labelledby="pre-koho-title" className="scroll-mt-24 border-y border-subtle bg-page-bg-elevated py-20 sm:py-24">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
            <SectionIntro id="pre-koho-title" kicker={t("landing.audience.kicker")} title={t("landing.audience.title")} subtitle={t("landing.audience.description")} />
            <ul className="grid gap-3 sm:grid-cols-2">
              {AUDIENCE_KEYS.map((key) => (
                <li key={key} className="surface-card flex items-start gap-3 p-4 font-semibold leading-6 text-primary">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-500/15 text-brand-300">
                    <CheckIcon size={13} strokeWidth={2.6} />
                  </span>
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* SKÚŠOBNÁ VERZIA — obsah z TrialOfferList (čísla z lib/pricing.ts). */}
        <section id="bezplatny-plan" aria-labelledby="trial-title" className="scroll-mt-24 py-20 sm:py-24">
          <div className="mx-auto grid max-w-6xl items-start gap-10 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
            <div>
              <SectionIntro id="trial-title" kicker={t("landing.freePlan.kicker")} title={t("landing.freePlan.title")} subtitle={t("landing.freePlan.note")} />
              <div className="mt-8">
                <SectionIntro kicker={t("landing.security.kicker")} title={t("landing.security.title")} />
                <p className="mt-4 text-base leading-7 text-secondary">{t("landing.security.description")}</p>
                <ul className="mt-5 space-y-2.5 text-sm leading-6 text-secondary">
                  {["landing.security.point1", "landing.security.point2", "landing.security.point3"].map((key) => (
                    <Check key={key}>{t(key)}</Check>
                  ))}
                </ul>
              </div>
            </div>

            <div className="surface-card relative overflow-hidden p-6 shadow-2xl shadow-black/40 sm:p-8">
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-brand-sky to-brand-600" />
              <p className="text-sm font-bold text-brand-300">{t("landing.freePlan.badge")}</p>
              <p className="mt-2 text-5xl font-black tracking-tight text-primary">{t("landing.freePlan.price")}</p>
              <p className="mt-1 text-sm text-muted-esblu">{t("landing.freePlan.priceNote")}</p>
              <div className="mt-6">
                <TrialOfferList />
              </div>
              <Link href={REGISTER_HREF} className="btn-primary mt-7 flex min-h-12 w-full items-center justify-center px-6 py-3">
                {t("landing.freePlan.cta")}
              </Link>
              <Link href="/cennik" className="btn-secondary mt-3 flex min-h-12 w-full items-center justify-center px-6 py-3">
                {t("pricing.landingCta")}
              </Link>
            </div>
          </div>
        </section>

        {/* ZÁVEREČNÁ VÝZVA */}
        <section className="px-4 pb-20 sm:px-6 sm:pb-24 lg:px-8">
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[var(--radius-card-lg)] border border-brand-500/30 bg-surface-1 px-6 py-12 text-center sm:px-10 sm:py-16">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,rgba(1,129,253,0.22),rgba(1,129,253,0)_70%)]" />
            <div className="relative">
              <h2 className="mx-auto max-w-3xl text-3xl font-black tracking-tight text-primary sm:text-4xl">{t("landing.finalCta.title")}</h2>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-secondary sm:text-lg sm:leading-8">{t("landing.finalCta.description")}</p>
              <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                <Link href={REGISTER_HREF} className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3 text-base">
                  {t("landing.finalCta.ctaPrimary")}
                </Link>
                <Link href={LOGIN_HREF} className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3">
                  {t("landing.finalCta.ctaSecondary")}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </div>
  );
}
