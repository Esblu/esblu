"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import LanguageSwitcher from "./LanguageSwitcher";
import EsbluDemoVideo, { emitVideoCtaClick } from "./EsbluDemoVideo";
import LandingVideoJsonLd from "./LandingVideoJsonLd";
import { isVideoPublished } from "@/lib/landing-video";
import InboxDocumentIcon from "./icons/InboxDocumentIcon";
import ChatBubbleIcon from "./icons/ChatBubbleIcon";
import BusinessPartnersIcon from "./icons/BusinessPartnersIcon";
import InvoicesIcon from "./icons/InvoicesIcon";
import { TrialOfferList } from "./pricing/TrialOfferList";

// =============================================================================
// PublicLandingPage — verejná marketingová stránka (neprihlásený návštevník
// na "/", pozri app/page.tsx). Čisto vizuálny + textový redesign zosúladený
// s aktuálnym tmavým dizajnovým jazykom appky (app/globals.css: surface-card,
// btn-primary/btn-secondary, icon-glow-*, accent-cyan/blue/orange/teal) —
// žiadne zmeny routov, logiky, dát ani business funkcií. Accent mapovanie
// modulov je zámerne zhodné s app/components/Dashboard.tsx (modules[]):
// Inbox = cyan, Vozidlá = blue, Stroje = orange, Sklad = teal, Obchodní
// partneri = blue (rovnako ako Dashboard), Faktúry = teal (rovnako ako
// Dashboard) — iba 4 accent farby existujú v dizajnovom systéme, preto sa
// pri 6 moduloch prirodzene opakujú, presne ako na Dashboarde appky.
//
// AKTUALIZÁCIA (verejný landing podľa aktuálneho stavu appky): landing
// predtým opisoval iba 4 moduly (Vozidlá/Stroje/Sklad + Inbox) — appka má
// dnes reálne 6 hlavných modulov (Dashboard.tsx: Inbox, Vozidlá, Stroje,
// Sklad, Obchodní partneri, Faktúry, mimo Nastavení). Firemný chat NIE JE
// samostatný modul v appke (je to plávajúci FloatingChatWidget dostupný
// naprieč appkou) — preto tu zostáva iba ako kratšia doplnková zmienka pod
// hlavnou 6-dlaždicovou mriežkou, nie ako rovnocenná 7. karta modulu.
// =============================================================================

type FeatureAccent = "cyan" | "blue" | "orange" | "teal";

const FEATURE_ACCENT_STYLES: Record<
  FeatureAccent,
  { icon: string; glow: string; chip: string; kicker: string }
> = {
  cyan: {
    icon: "bg-accent-cyan/14 text-accent-cyan",
    glow: "icon-glow-cyan",
    chip: "bg-accent-cyan/12 text-accent-cyan",
    kicker: "text-accent-cyan",
  },
  blue: {
    icon: "bg-accent-blue/14 text-accent-blue",
    glow: "icon-glow-blue",
    chip: "bg-accent-blue/12 text-accent-blue",
    kicker: "text-accent-blue",
  },
  orange: {
    icon: "bg-accent-orange/14 text-accent-orange",
    glow: "icon-glow-orange",
    chip: "bg-accent-orange/12 text-accent-orange",
    kicker: "text-accent-orange",
  },
  teal: {
    icon: "bg-accent-teal/14 text-accent-teal",
    glow: "icon-glow-teal",
    chip: "bg-accent-teal/12 text-accent-teal",
    kicker: "text-accent-teal",
  },
};

// Rovnaké moduly a rovnaké obrázky ako v app/components/Dashboard.tsx
// (modules[]) — landing page zámerne nepoužíva vlastné/nové obrázky.
// Samotný text (title/description/examples) sa prekladá cez t() vnútri
// komponentu nižšie (getFeatureCards) — tu ostávajú iba jazykovo neutrálne
// metadáta (obrázok/ikona, accent farba, prekladové kľúče).
//
// ÚPRAVA VEREJNÉHO WEBU (Inbox vizuál + vyváženie veľkostí + Firemný chat):
// - Inbox teraz používa rovnakú zdieľanú `InboxDocumentIcon` SVG ako
//   Dashboard (predtým `/images/ai-evidencia.png`, starý rastrový mockup)
//   — `icon` má prednosť pred `image` v render bloku nižšie, rovnaký `icon
//   ?? image` vzor ako `app/components/ModuleCard.tsx`.
// - `imageZoom` (voliteľné, default 1) — identická kalibrácia ako
//   `app/components/Dashboard.tsx` (modules[], KOREKCIA v5): rastrové
//   produktové fotky (van/excavator/warehouse .png) majú v samom súbore
//   výrazný priehľadný okraj okolo motívu (zmerané cez alfa kanál), takže
//   pri mechanicky rovnakom CSS boxe pôsobia vizuálne menšie než nová
//   Inbox SVG, ktorá kreslí takmer na celú plochu viewBoxu. Hodnoty (van
//   1.2, excavator 1.6, warehouse 1.7) sú rovnaké čísla, rovnaké assety —
//   pozri komentár pri ModuleCard.tsx pre plné odvodenie/rezervu pred
//   orezaním motívu.
// - Firemný chat je nová 5. karta (icon = zdieľaná `ChatBubbleIcon`,
//   rovnaká ikona ako trigger tlačidlo `FloatingChatWidget.tsx` v appke) —
//   žiadny nový vizuálny jazyk, accent cyan zvolený zámerne zhodne s
//   `bg-accent-cyan` chat trigger tlačidlom v appke.
const featureCardDefs: {
  titleKey: string;
  descKey: string;
  image?: string;
  icon?: ReactNode;
  imageZoom?: number;
  accent: FeatureAccent;
  exampleKeys?: string[];
  spanFull?: boolean;
  // eFaktúra — jasne označená ako "pripravujeme" (bod 10 zadania), pripojená
  // priamo ku karte Faktúry. Nikdy nesmie tvrdiť, že eFaktúra/Peppol je už
  // podporovaná/dostupná — pozri i18n kľúč landing.features.efakturaDesc.
  badgeTitleKey?: string;
  badgeDescKey?: string;
}[] = [
  {
    titleKey: "landing.features.inboxTitle",
    descKey: "landing.features.inboxDesc",
    icon: <InboxDocumentIcon size={36} className="h-9 w-9" />,
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
    titleKey: "landing.features.vehiclesTitle",
    descKey: "landing.features.vehiclesDesc",
    image: "/images/van.png",
    imageZoom: 1.2,
    accent: "blue",
  },
  {
    titleKey: "landing.features.machinesTitle",
    descKey: "landing.features.machinesDesc",
    image: "/images/excavator.png",
    imageZoom: 1.6,
    accent: "orange",
  },
  {
    titleKey: "landing.features.inventoryTitle",
    descKey: "landing.features.inventoryDesc",
    image: "/images/warehouse.png",
    imageZoom: 1.7,
    accent: "teal",
  },
  {
    titleKey: "landing.features.businessPartnersTitle",
    descKey: "landing.features.businessPartnersDesc",
    icon: <BusinessPartnersIcon size={36} className="h-9 w-9" />,
    accent: "blue",
  },
  {
    titleKey: "landing.features.invoicesTitle",
    descKey: "landing.features.invoicesDesc",
    icon: <InvoicesIcon size={36} className="h-9 w-9" />,
    accent: "teal",
    badgeTitleKey: "landing.features.efakturaBadge",
    badgeDescKey: "landing.features.efakturaDesc",
  },
];

const audienceExampleKeys = [
  "landing.audience.example1",
  "landing.audience.example2",
  "landing.audience.example3",
  "landing.audience.example4",
  "landing.audience.example5",
];

// Obsah skúšobnej verzie: app/components/pricing/TrialOfferList.tsx (čísla z lib/pricing.ts).

// AI transparentnosť (bod 1 zadania) — konzervatívne, vopred schválené
// formulácie. Zámerne bez mena konkrétneho AI poskytovateľa (ten je
// zdokumentovaný na /ochrana-osobnych-udajov a /subprocessors).
const aiTransparencyPointKeys = [
  "landing.ai.point1",
  "landing.ai.point2",
  "landing.ai.point3",
  "landing.ai.point4",
];

function BrandMark() {
  return (
    <span className="flex items-center gap-3">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent-cyan to-accent-blue-strong shadow-lg shadow-black/30">
        <span
          aria-hidden="true"
          className="h-5 w-5 rotate-45 rounded-sm border-[3px] border-[#051221]"
        />
      </span>
      <span className="text-2xl font-black tracking-tight text-white">
        Esblu
      </span>
    </span>
  );
}

function CheckIcon({ className = "text-accent-cyan" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className={`mt-0.5 h-5 w-5 shrink-0 ${className}`}
    >
      <path
        d="m5 10 3 3 7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const desktopNavLinkClass =
  "whitespace-nowrap rounded-lg px-2 py-2 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan";
const mobileNavLinkClass =
  "flex min-h-12 items-center rounded-lg px-2 text-base font-semibold text-slate-200 transition hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan";

const footerLinkClass =
  "rounded text-slate-300 transition hover:text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan";

// Tailwind (v4, statická analýza zdrojového kódu) nevie rozpoznať dynamicky
// poskladané triedy ako `bg-accent-${accent}` — preto mapa s VÝSLOVNE
// vypísanými plnými triedami pre každý accent (rovnaké 4 farby ako
// FEATURE_ACCENT_STYLES vyššie, iba samotné pozadie bodky v hero mockupe).
const DOT_ACCENT_BG: Record<FeatureAccent, string> = {
  cyan: "bg-accent-cyan",
  blue: "bg-accent-blue",
  orange: "bg-accent-orange",
  teal: "bg-accent-teal",
};

export default function PublicLandingPage() {
  const currentYear = new Date().getFullYear();
  const { t } = useLocale();
  // Sekcia s produktovou ukážkou sa zapne až vtedy, keď sú video súbory
  // reálne nasadené (pozri lib/landing-video.ts). Dovtedy sa nevykreslí ani
  // sekcia, ani odkazy na ňu — landing page zostáva presne taká, aká bola.
  const videoPublished = isVideoPublished();
  const [menuOpen, setMenuOpen] = useState(false);

  // Mobilné menu: Esc ho zavrie; pri prechode na desktop šírku sa zavrie.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onChange);
    };
  }, [menuOpen]);

  const navItems: { href: string; label: string; route?: boolean }[] = [
    ...(videoPublished ? [{ href: "#ukazka", label: t("landing.nav.demo") }] : []),
    { href: "#funkcie", label: t("landing.nav.features") },
    { href: "#bezplatny-plan", label: t("landing.nav.freePlan") },
    { href: "/cennik", label: t("landing.nav.pricing"), route: true },
    { href: "#kontakt", label: t("landing.nav.contact") },
  ];

  return (
    <div className="min-h-screen overflow-x-hidden bg-page-bg text-primary">
      {/* HLAVIČKA — desktop (lg+): jeden riadok logo · navigácia · jazyk ·
          prihlásenie. Mobil/tablet (<lg): kompaktný riadok logo ·
          prihlásenie · menu; navigácia (a pod sm aj jazyk) je v rozbaľovacom
          paneli, aby sa nič nemuselo tlačiť do jedného riadku. */}
      <header className="sticky top-0 z-50 border-b border-subtle bg-slate-950/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:py-4 lg:px-8">
          <a
            href="#uvod"
            aria-label={t("landing.nav.backToTop")}
            className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
            onClick={() => setMenuOpen(false)}
          >
            <BrandMark />
          </a>

          <nav
            aria-label={t("landing.nav.mainNavAriaLabel")}
            className="hidden items-center gap-5 text-sm font-semibold text-slate-300 lg:flex"
          >
            {navItems.map((item) =>
              item.route ? (
                <Link key={item.href} href={item.href} className={desktopNavLinkClass}>
                  {item.label}
                </Link>
              ) : (
                <a key={item.href} href={item.href} className={desktopNavLinkClass}>
                  {item.label}
                </a>
              )
            )}
          </nav>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <div className="hidden sm:block">
              <LanguageSwitcher variant="dark" />
            </div>
            <Link
              href="/login"
              className="btn-secondary inline-flex min-h-11 items-center whitespace-nowrap px-4 py-2 text-sm"
            >
              {t("landing.nav.login")}
            </Link>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-menu"
              aria-label={menuOpen ? t("landing.nav.closeMenu") : t("landing.nav.openMenu")}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-subtle text-slate-200 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan lg:hidden"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          </div>
        </div>

        {menuOpen && (
          <div id="landing-mobile-menu" className="border-t border-subtle bg-slate-950 lg:hidden">
            <nav
              aria-label={t("landing.nav.mainNavAriaLabel")}
              className="mx-auto flex max-w-6xl flex-col px-4 py-2 sm:px-6"
            >
              {navItems.map((item) =>
                item.route ? (
                  <Link key={item.href} href={item.href} className={mobileNavLinkClass} onClick={() => setMenuOpen(false)}>
                    {item.label}
                  </Link>
                ) : (
                  <a key={item.href} href={item.href} className={mobileNavLinkClass} onClick={() => setMenuOpen(false)}>
                    {item.label}
                  </a>
                )
              )}
            </nav>
            <div className="mx-auto max-w-6xl px-4 pb-4 sm:hidden">
              <LanguageSwitcher variant="dark" />
            </div>
          </div>
        )}
      </header>

      <main>
        {/* HERO — tmavé pozadie appky + jemný cyan/modrý ambient glow, bez
            pixel-perfect kopírovania referencie, iba rovnaký dizajnový
            jazyk (near-black navy, cyan/blue akcent, premium tech karta). */}
        <section
          id="uvod"
          className="relative scroll-mt-28 overflow-hidden bg-slate-950"
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-cover bg-center opacity-45"
            style={{ backgroundImage: "url('/images/background-dark.png')" }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-br from-slate-950/95 via-slate-950/80 to-slate-950/50"
          />
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent-cyan/40 to-transparent"
          />

          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 pb-14 pt-10 sm:gap-12 sm:px-6 sm:py-20 lg:grid-cols-[1.12fr_0.88fr] lg:px-8 lg:py-28">
            <div>
              <p className="inline-flex rounded-full border border-accent-cyan/30 bg-accent-cyan/10 px-3.5 py-1.5 text-xs font-bold text-accent-cyan sm:px-4 sm:py-2 sm:text-sm">
                {t("landing.hero.badge")}
              </p>
              <h1 className="mt-5 max-w-3xl text-[2.125rem] font-black leading-[1.12] tracking-tight text-white sm:mt-6 sm:text-5xl sm:leading-tight lg:text-6xl">
                {t("landing.hero.title")}
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-slate-300 sm:mt-6 sm:max-w-2xl sm:text-xl sm:leading-8">
                {t("landing.hero.subtitle")}
              </p>

              {/* CTA — poradie je zámerné: obchodný kontakt, potom ukážka
                  produktu, až potom prihlásenie. Návštevník z obchodného
                  e-mailu musí vidieť odkaz na demo video hneď v hero časti,
                  bez skrolovania a bez hľadania v menu. */}
              <div className="mt-7 flex flex-col gap-3 sm:mt-8 sm:flex-row sm:flex-wrap">
                <a
                  href="mailto:info@esblu.com"
                  className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3"
                >
                  {t("landing.hero.ctaPrimary")}
                </a>
                {videoPublished && (
                  <a
                    href="#ukazka"
                    className="btn-secondary inline-flex min-h-12 items-center justify-center gap-2 px-6 py-3"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4 shrink-0"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.74-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
                    </svg>
                    {t("landing.hero.ctaVideo")}
                  </a>
                )}
                <Link
                  href="/login"
                  className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3"
                >
                  {t("landing.hero.ctaSecondary")}
                </Link>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-esblu sm:mt-4">
                {t("landing.hero.betaNotice")}
              </p>
            </div>

            <div className="relative mx-auto w-full max-w-lg" aria-hidden="true">
              <div className="absolute -inset-8 rounded-full bg-gradient-to-br from-accent-cyan/25 via-accent-blue/15 to-transparent blur-3xl" />
              <div className="surface-card relative p-5 shadow-2xl shadow-black/40 sm:p-7">
                <div className="flex items-center justify-between border-b border-subtle pb-5">
                  <div>
                    <p className="text-sm font-semibold text-accent-cyan">
                      {t("landing.hero.cardKicker")}
                    </p>
                    <p className="mt-1 text-xl font-black text-primary">
                      {t("landing.hero.cardTitle")}
                    </p>
                  </div>
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-accent-cyan to-accent-blue-strong">
                    <span className="h-5 w-5 rotate-45 rounded-sm border-[3px] border-[#051221]" />
                  </span>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3">
                  {(
                    [
                      [
                        t("landing.features.inboxTitle"),
                        t("landing.hero.moduleInboxDesc"),
                        "cyan",
                      ],
                      [
                        t("landing.features.vehiclesTitle"),
                        t("landing.hero.moduleVehiclesDesc"),
                        "blue",
                      ],
                      [
                        t("landing.features.machinesTitle"),
                        t("landing.hero.moduleMachinesDesc"),
                        "orange",
                      ],
                      [
                        t("landing.features.inventoryTitle"),
                        t("landing.hero.moduleInventoryDesc"),
                        "teal",
                      ],
                      [
                        t("landing.features.businessPartnersTitle"),
                        t("landing.hero.moduleBusinessPartnersDesc"),
                        "blue",
                      ],
                      [
                        t("landing.features.invoicesTitle"),
                        t("landing.hero.moduleInvoicesDesc"),
                        "teal",
                      ],
                    ] as [string, string, FeatureAccent][]
                  ).map(([title, description, accent]) => (
                    <div
                      key={title}
                      className="rounded-2xl border border-subtle bg-surface-2 p-4"
                    >
                      <span
                        aria-hidden="true"
                        className={`block h-2.5 w-2.5 rounded-full ${DOT_ACCENT_BG[accent]}`}
                      />
                      <p className="mt-4 font-bold text-primary">{title}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-esblu">
                        {description}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex items-center gap-3 rounded-2xl bg-info-soft p-4 text-sm font-semibold text-accent-cyan">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-cyan text-[#051221]">
                    AI
                  </span>
                  {t("landing.hero.cardAiNote")}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* UKÁŽKA PRODUKTU — zámerne hneď pod hero, ešte pred zoznamom
            funkcií. Landing page slúži aj ako cieľ obchodných e-mailov:
            návštevník, ktorý príde priamo na esblu.com, musí demo nájsť
            v prvom skrolovaní, nie až na konci stránky. Video je verejné,
            bez registrácie — beta prístup je až následný krok pod ním. */}
        {videoPublished && (
        <section
          id="ukazka"
          className="scroll-mt-28 border-y border-subtle bg-slate-950 py-20 sm:py-24"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-3xl">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-accent-cyan">
                {t("landing.video.kicker")}
              </p>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
                {t("landing.video.title")}
              </h2>
              <p className="mt-4 text-lg leading-8 text-slate-300">
                {t("landing.video.subtitle")}
              </p>
            </div>

            <EsbluDemoVideo />
            <LandingVideoJsonLd />

            {/* CTA pod videom — používa existujúci beta workflow appky
                (mailto na info@esblu.com), nezavádza nový formulár ani
                endpoint, ktorý dnes neexistuje. */}
            <div className="mt-12 rounded-3xl border border-subtle bg-gradient-to-br from-slate-900 to-slate-950 p-6 sm:p-10">
              {/* Dva stĺpce až od lg — na tablete (≈834 px) by sa nadpis lámal
                  do štyroch úzkych riadkov vedľa tlačidiel. */}
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-2xl">
                  <h3 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
                    {t("landing.video.ctaTitle")}
                  </h3>
                  <p className="mt-3 text-base leading-7 text-slate-300">
                    {t("landing.video.ctaDescription")}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
                  <a
                    href="mailto:info@esblu.com"
                    onClick={emitVideoCtaClick}
                    className="btn-primary inline-flex min-h-12 items-center justify-center px-6 py-3"
                  >
                    {t("landing.video.ctaPrimary")}
                  </a>
                  <a
                    href="#funkcie"
                    className="btn-secondary inline-flex min-h-12 items-center justify-center px-6 py-3"
                  >
                    {t("landing.video.ctaSecondary")}
                  </a>
                </div>
              </div>
              <p className="mt-6 text-sm text-muted-esblu">
                {t("landing.video.betaNotice")}
              </p>
            </div>
          </div>
        </section>
        )}

        {/* FUNKCIE — moduly (Inbox/Vozidlá/Stroje/Sklad) + Firemný chat v
            rovnakom vizuálnom jazyku ako ModuleCard na Dashboarde
            (surface-card + farebný ikonový chip s icon-glow), bohatšie na
            obsah, keďže ide o marketingovú kartu, nie o kompaktnú appkovú
            dlaždicu. Chat je 5. (posledná) karta — na desktope 2-stĺpcovej
            mriežky by ako nepárna osamotene "trčala" v novom riadku s
            prázdnym miestom vedľa seba, preto dostáva md:col-span-2
            (prirodzené uzatvárajúce zhrnutie sekcie, nie nalepený
            zvyšok). */}
        <section id="funkcie" className="scroll-mt-28 bg-page-bg py-20 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-accent-cyan">
                {t("landing.features.kicker")}
              </p>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-primary sm:text-4xl">
                {t("landing.features.title")}
              </h2>
              <p className="mt-4 text-lg leading-8 text-secondary">
                {t("landing.features.subtitle")}
              </p>
            </div>

            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {featureCardDefs.map((feature) => {
                const styles = FEATURE_ACCENT_STYLES[feature.accent];
                const title = t(feature.titleKey);

                return (
                  <article
                    key={feature.titleKey}
                    className={`surface-card surface-card-hover flex min-h-full flex-col p-6 transition sm:p-7 ${
                      feature.spanFull ? "sm:col-span-2 lg:col-span-3" : ""
                    }`}
                  >
                    <div
                      className={`flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl ${styles.icon} ${styles.glow}`}
                    >
                      {feature.icon ??
                        (feature.image ? (
                          <Image
                            src={feature.image}
                            alt=""
                            aria-hidden="true"
                            width={40}
                            height={40}
                            className="h-9 w-9 object-contain"
                            style={
                              feature.imageZoom && feature.imageZoom !== 1
                                ? { transform: `scale(${feature.imageZoom})` }
                                : undefined
                            }
                          />
                        ) : null)}
                    </div>
                    <h3 className="mt-6 text-2xl font-black text-primary">
                      {title}
                    </h3>
                    <p className="mt-3 leading-7 text-secondary">
                      {t(feature.descKey)}
                    </p>
                    {feature.exampleKeys && (
                      <ul
                        className="mt-5 flex flex-wrap gap-1.5 sm:gap-2"
                        aria-label={t("landing.features.examplesAriaLabel")}
                      >
                        {feature.exampleKeys.map((exampleKey) => (
                          <li
                            key={exampleKey}
                            className={`rounded-full px-2.5 py-1 text-xs font-semibold sm:px-3 sm:text-sm ${styles.chip}`}
                          >
                            {t(exampleKey)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* eFaktúra — "pripravujeme" info blok (bod 10 zadania).
                        Zámerne vizuálne odlíšený (bordered box, nie chip) —
                        musí byť jasné, že ide o budúcu/pripravovanú funkciu,
                        nikdy nie o už dostupnú. */}
                    {feature.badgeTitleKey && feature.badgeDescKey && (
                      <div className="mt-5 rounded-xl border border-dashed border-subtle bg-surface-2 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-accent-cyan">
                          {t(feature.badgeTitleKey)}
                        </p>
                        <p className="mt-1.5 text-sm leading-6 text-muted-esblu">
                          {t(feature.badgeDescKey)}
                        </p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            {/* Firemný chat — doplnková funkcia appky (plávajúci
                FloatingChatWidget), zámerne NIE je 7. rovnocenná karta
                modulu (bod 11 zadania) — kompaktnejšia zmienka pod hlavnou
                mriežkou 6 modulov. */}
            <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-subtle bg-surface-1 p-5 sm:flex-row sm:items-center">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-cyan/14 text-accent-cyan">
                <ChatBubbleIcon size={26} className="h-6 w-6" />
              </span>
              <div>
                <p className="font-bold text-primary">
                  {t("landing.features.chatTitle")}
                </p>
                <p className="mt-1 text-sm leading-6 text-secondary">
                  {t("landing.features.chatDesc")}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* AI SPRACOVANIE + AI TRANSPARENTNOSŤ (bod 1 zadania). Konkrétny AI
            poskytovateľ sa tu zámerne NEMENUJE — je zdokumentovaný na
            /ochrana-osobnych-udajov (sekcia F) a /subprocessors. */}
        <section
          id="ai-spracovanie"
          className="scroll-mt-28 bg-slate-950 py-20 text-white sm:py-24"
        >
          <div className="mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-accent-cyan">
                {t("landing.ai.kicker")}
              </p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                {t("landing.ai.title")}
              </h2>
              <p className="mt-5 text-lg leading-8 text-slate-300">
                {t("landing.ai.description")}
              </p>

              <aside className="mt-7 rounded-2xl border border-subtle bg-surface-2 p-6">
                <h3 className="text-base font-black text-primary">
                  {t("landing.ai.transparencyTitle")}
                </h3>

                <ul className="mt-4 space-y-3">
                  {aiTransparencyPointKeys.map((pointKey) => (
                    <li key={pointKey} className="flex items-start gap-3">
                      <CheckIcon />
                      <span className="text-sm leading-6 text-slate-200">
                        {t(pointKey)}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="mt-5 rounded-xl bg-warning-soft px-4 py-3 text-sm font-semibold leading-6 text-amber-400">
                  {t("landing.ai.warning")}
                </p>

                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold">
                  <Link
                    href="/ochrana-osobnych-udajov"
                    className="text-accent-cyan hover:underline"
                  >
                    {t("landing.ai.privacyLink")}
                  </Link>
                  <Link
                    href="/podmienky-pouzivania"
                    className="text-accent-cyan hover:underline"
                  >
                    {t("landing.ai.termsLink")}
                  </Link>
                </div>
              </aside>
            </div>

            <ol className="grid gap-4">
              {["landing.ai.step1", "landing.ai.step2", "landing.ai.step3"].map(
                (stepKey, index) => (
                  <li
                    key={stepKey}
                    className="flex items-center gap-5 rounded-2xl border border-subtle bg-surface-2 p-5"
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent-cyan to-accent-blue-strong text-lg font-black text-[#051221]">
                      {index + 1}
                    </span>
                    <span className="text-lg font-semibold leading-7">
                      {t(stepKey)}
                    </span>
                  </li>
                )
              )}
            </ol>
          </div>
        </section>

        <section
          id="pre-koho"
          className="scroll-mt-28 bg-surface-2 py-20 sm:py-24"
        >
          <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-accent-cyan">
                {t("landing.audience.kicker")}
              </p>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-primary sm:text-4xl">
                {t("landing.audience.title")}
              </h2>
              <p className="mt-5 text-lg leading-8 text-secondary">
                {t("landing.audience.description")}
              </p>
            </div>

            <ul className="grid gap-3 sm:grid-cols-2">
              {audienceExampleKeys.map((exampleKey) => (
                <li
                  key={exampleKey}
                  className="flex items-start gap-3 rounded-2xl border border-subtle bg-surface-1 p-5 font-semibold leading-6 text-primary shadow-sm"
                >
                  <CheckIcon />
                  {t(exampleKey)}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* BEZPLATNÝ PLÁN — predtým svetlá (blue-50 → white) sekcia,
            teraz plne tmavá, karta v .surface-card s cyan/blue accent
            borderom namiesto border-blue-200. */}
        <section
          id="bezplatny-plan"
          className="scroll-mt-28 bg-page-bg py-20 sm:py-24"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-accent-cyan">
                {t("landing.freePlan.kicker")}
              </p>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-primary sm:text-4xl">
                {t("landing.freePlan.title")}
              </h2>
            </div>

            <div className="surface-card relative mx-auto mt-10 max-w-xl overflow-hidden p-6 shadow-2xl shadow-black/40 sm:p-8">
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-accent-cyan to-accent-blue-strong opacity-80"
              />
              <p className="text-lg font-bold text-accent-cyan">
                {t("landing.freePlan.badge")}
              </p>
              <p className="mt-3 text-5xl font-black tracking-tight text-primary">
                {t("landing.freePlan.price")}
              </p>
              <p className="mt-2 text-sm text-muted-esblu">
                {t("landing.freePlan.priceNote")}
              </p>

              <div className="mt-7">
                <TrialOfferList />
              </div>

              <a
                href="mailto:info@esblu.com"
                className="btn-primary mt-8 flex min-h-12 w-full items-center justify-center px-6 py-3"
              >
                {t("landing.freePlan.cta")}
              </a>
              <Link
                href="/cennik"
                className="btn-secondary mt-3 flex min-h-12 w-full items-center justify-center px-6 py-3"
              >
                {t("pricing.landingCta")}
              </Link>
            </div>

            <p className="mx-auto mt-7 max-w-2xl text-center leading-7 text-secondary">
              {t("landing.freePlan.note")}
            </p>
          </div>
        </section>

        <section
          id="bezpecnost"
          className="scroll-mt-28 bg-page-bg py-20 sm:py-24"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="rounded-3xl border border-subtle bg-slate-950 p-6 text-white shadow-xl sm:p-10 lg:p-12">
              <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
                <div>
                  <p className="text-sm font-bold uppercase tracking-[0.18em] text-accent-cyan">
                    {t("landing.security.kicker")}
                  </p>
                  <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                    {t("landing.security.title")}
                  </h2>
                  <p className="mt-5 text-lg leading-8 text-slate-300">
                    {t("landing.security.description")}
                  </p>
                </div>

                <ul className="space-y-4">
                  {[
                    "landing.security.point1",
                    "landing.security.point2",
                    "landing.security.point3",
                  ].map((itemKey) => (
                    <li
                      key={itemKey}
                      className="flex items-start gap-3 rounded-2xl bg-surface-2 p-4 leading-7 text-slate-200"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-accent-cyan"
                      />
                      {t(itemKey)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Záverečné CTA — gradient zhodný s .btn-primary (cyan→blue),
            namiesto plnej bg-blue-600 plochy. */}
        <section className="bg-gradient-to-br from-accent-cyan to-accent-blue-strong py-16 sm:py-20">
          <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-3xl font-black tracking-tight text-[#051221] sm:text-4xl">
              {t("landing.finalCta.title")}
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-[#051221]/80">
              {t("landing.finalCta.description")}
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="mailto:info@esblu.com"
                className="inline-flex min-h-12 items-center justify-center rounded-xl bg-page-bg px-6 py-3 font-bold text-primary transition hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#051221] focus-visible:ring-offset-2"
              >
                {t("landing.finalCta.ctaPrimary")}
              </a>
              <Link
                href="/login"
                className="inline-flex min-h-12 items-center justify-center rounded-xl px-6 py-3 font-bold text-[#051221] underline decoration-[#051221]/40 underline-offset-4 transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#051221]"
              >
                {t("landing.finalCta.ctaSecondary")}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer id="kontakt" className="scroll-mt-28 bg-slate-950 text-slate-300">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1fr_auto] lg:px-8">
          <div>
            <BrandMark />
            <p className="mt-4 text-sm text-muted-esblu">
              {t("landing.footer.tagline")}
            </p>
            <a
              href="mailto:info@esblu.com"
              className="mt-3 inline-block break-all rounded text-sm font-semibold text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
            >
              info@esblu.com
            </a>
            <div className="mt-5">
              <LanguageSwitcher variant="dark" />
            </div>
          </div>

          {/* Právne odkazy (bod 2 zadania) — doplnené Cookies/DPA/
              Sprostredkovatelia popri existujúcich, rovnaké poradie a
              formulácia ako v app/components/PublicLegalLayout.tsx. */}
          <nav
            aria-label={t("settings.legal.navAriaLabel")}
            className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm font-semibold sm:grid-cols-3"
          >
            <Link href="/ochrana-osobnych-udajov" className={footerLinkClass}>
              {t("landing.footer.privacy")}
            </Link>
            <Link href="/podmienky-pouzivania" className={footerLinkClass}>
              {t("landing.footer.terms")}
            </Link>
            <Link href="/cookies" className={footerLinkClass}>
              {t("landing.footer.cookies")}
            </Link>
            <Link href="/dpa" className={footerLinkClass}>
              {t("landing.footer.dpa")}
            </Link>
            <Link href="/subprocessors" className={footerLinkClass}>
              {t("landing.footer.subprocessors")}
            </Link>
            <Link href="/cennik" className={footerLinkClass}>
              {t("landing.nav.pricing")}
            </Link>
            <Link href="/kontakt" className={footerLinkClass}>
              {t("landing.footer.contact")}
            </Link>
            <Link href="/login" className={footerLinkClass}>
              {t("landing.footer.login")}
            </Link>
          </nav>
        </div>
        <div className="border-t border-subtle px-4 py-5 text-center text-xs text-muted-esblu">
          {t("landing.footer.copyright", { year: currentYear })}
        </div>
      </footer>
    </div>
  );
}
