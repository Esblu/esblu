"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { isVideoPublished } from "@/lib/landing-video";
import { CONTACT_EMAIL, LEGAL_LINKS, LOGIN_HREF, REGISTER_HREF } from "@/lib/public-links";
import LanguageSwitcher from "../LanguageSwitcher";

// =============================================================================
// Spoločný rámec verejného webu (landing, cenník, právne podstránky,
// prihlásenie/registrácia na webe). Rovnaký vizuálny jazyk ako aplikácia
// (app/globals.css: page-bg, surface-glass, btn-primary/secondary, brand
// tokeny) a rovnaká značka ako bočný panel appky (Dashboard.tsx — gradient
// brand-sky → brand-500 s „diamantom“).
// =============================================================================

export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-9 w-9" : "h-10 w-10";
  return (
    <span className="flex items-center gap-2.5">
      <span className={`grid ${box} shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-sky to-brand-500 shadow-lg shadow-black/30`}>
        <span aria-hidden="true" className="h-4 w-4 rotate-45 rounded-md border-[3px] border-[#051221]" />
      </span>
      <span className="text-xl font-black tracking-tight text-primary sm:text-2xl">Esblu</span>
    </span>
  );
}

const navLinkClass =
  "whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-semibold text-secondary transition hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400";
const mobileNavLinkClass =
  "flex min-h-12 items-center rounded-lg px-3 text-base font-semibold text-secondary transition hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400";

type NavItem = { href: string; label: string };

function useNavItems(onHome: boolean): NavItem[] {
  const { t } = useLocale();
  const anchor = (id: string) => (onHome ? `#${id}` : `/#${id}`);
  return [
    ...(isVideoPublished() ? [{ href: anchor("ukazka"), label: t("landing.nav.demo") }] : []),
    { href: anchor("funkcie"), label: t("landing.nav.features") },
    { href: anchor("ako-zacat"), label: t("landing.nav.howItWorks") },
    { href: "/cennik", label: t("landing.nav.pricing") },
    { href: "/kontakt", label: t("landing.nav.contact") },
  ];
}

function NavLink({ item, className, onClick }: { item: NavItem; className: string; onClick?: () => void }) {
  // Kotvy na tej istej stránke = obyčajné <a> (plynulý posun bez routera).
  if (item.href.startsWith("#")) {
    return (
      <a href={item.href} className={className} onClick={onClick}>
        {item.label}
      </a>
    );
  }
  return (
    <Link href={item.href} className={className} onClick={onClick}>
      {item.label}
    </Link>
  );
}

/**
 * Hlavička verejného webu. Desktop (lg+): logo · navigácia · jazyk ·
 * Prihlásiť sa · Vytvoriť účet. Mobil: logo · Vytvoriť účet · menu
 * (navigácia, prihlásenie a jazyk v rozbaľovacom paneli).
 */
export function PublicSiteHeader({ onHome = false, hideAuthLinks = false }: { onHome?: boolean; hideAuthLinks?: boolean }) {
  const { t } = useLocale();
  const navItems = useNavItems(onHome);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const close = () => setMenuOpen(false);

  return (
    <header className="sticky top-0 z-50 border-b border-subtle bg-page-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        {onHome ? (
          <a href="#uvod" aria-label={t("landing.nav.backToTop")} className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400" onClick={close}>
            <BrandMark />
          </a>
        ) : (
          <Link href="/" aria-label={t("pricing.nav.backHome")} className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
            <BrandMark />
          </Link>
        )}

        <nav aria-label={t("landing.nav.mainNavAriaLabel")} className="hidden items-center gap-1 lg:flex">
          {navItems.map((item) => (
            <NavLink key={item.href} item={item} className={navLinkClass} />
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden lg:block">
            <LanguageSwitcher variant="dark" />
          </div>
          {!hideAuthLinks && (
            <>
              <Link href={LOGIN_HREF} className="btn-secondary hidden min-h-11 items-center whitespace-nowrap px-4 py-2 text-sm sm:inline-flex">
                {t("landing.nav.login")}
              </Link>
              <Link href={REGISTER_HREF} className="btn-primary inline-flex min-h-11 items-center whitespace-nowrap px-4 py-2 text-sm">
                {t("landing.nav.register")}
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="public-mobile-menu"
            aria-label={menuOpen ? t("landing.nav.closeMenu") : t("landing.nav.openMenu")}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-subtle bg-surface-1 text-secondary transition hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 lg:hidden"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div id="public-mobile-menu" className="border-t border-subtle bg-page-bg lg:hidden">
          <nav aria-label={t("landing.nav.mainNavAriaLabel")} className="mx-auto flex max-w-6xl flex-col px-4 py-2 sm:px-6">
            {navItems.map((item) => (
              <NavLink key={item.href} item={item} className={mobileNavLinkClass} onClick={close} />
            ))}
            {!hideAuthLinks && (
              <Link href={LOGIN_HREF} className={mobileNavLinkClass} onClick={close}>
                {t("landing.nav.login")}
              </Link>
            )}
          </nav>
          <div className="mx-auto max-w-6xl px-4 pb-4 sm:px-6">
            <LanguageSwitcher variant="dark" />
          </div>
        </div>
      )}
    </header>
  );
}

const footerLinkClass =
  "rounded text-sm text-secondary transition hover:text-brand-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400";

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-esblu">{title}</p>
      <ul className="mt-3 space-y-2.5">{children}</ul>
    </div>
  );
}

/** Pätička verejného webu: značka, produkt, právne dokumenty, kontakt. */
export function PublicSiteFooter() {
  const { t } = useLocale();
  const year = new Date().getFullYear();

  return (
    <footer id="kontakt" className="scroll-mt-24 border-t border-subtle bg-page-bg-elevated">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-8">
        <div>
          <BrandMark />
          <p className="mt-4 max-w-xs text-sm leading-6 text-secondary">{t("landing.footer.tagline")}</p>
          <div className="mt-5">
            <LanguageSwitcher variant="dark" />
          </div>
        </div>

        <FooterColumn title={t("landing.footer.productHeading")}>
          <li><Link href="/#funkcie" className={footerLinkClass}>{t("landing.footer.features")}</Link></li>
          <li><Link href="/cennik" className={footerLinkClass}>{t("landing.nav.pricing")}</Link></li>
          <li><Link href={REGISTER_HREF} className={footerLinkClass}>{t("landing.footer.register")}</Link></li>
          <li><Link href={LOGIN_HREF} className={footerLinkClass}>{t("landing.footer.login")}</Link></li>
        </FooterColumn>

        <FooterColumn title={t("landing.footer.legalHeading")}>
          {LEGAL_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className={footerLinkClass}>{t(link.labelKey)}</Link>
            </li>
          ))}
        </FooterColumn>

        <FooterColumn title={t("landing.footer.contactHeading")}>
          <li><Link href="/kontakt" className={footerLinkClass}>{t("landing.footer.contact")}</Link></li>
          <li>
            <a href={`mailto:${CONTACT_EMAIL}`} className={`${footerLinkClass} break-all font-semibold text-brand-300`}>{CONTACT_EMAIL}</a>
          </li>
        </FooterColumn>
      </div>
      <div className="border-t border-subtle">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-5 text-xs text-muted-esblu sm:flex-row sm:justify-between sm:px-6 lg:px-8">
          <span>{t("landing.footer.copyright", { year })}</span>
          <span>{t("landing.footer.operator")}</span>
        </div>
      </div>
    </footer>
  );
}
