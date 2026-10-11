"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import LanguageSwitcher from "./LanguageSwitcher";

type PublicLegalLayoutProps = {
  titleKey: string;
  updatedAt?: string;
  children: ReactNode;
};

// "use client" Component — používa useLocale() (localStorage-driven Context,
// pozri lib/i18n/LocaleProvider.tsx) namiesto server-side cookie/props, aby
// appka nepotrebovala žiadnu cookie na určenie jazyka pred prvým
// vykreslením (revidované — pôvodne Server Component s `locale` prop z
// getServerLocale()). Volajúca stránka (napr.
// app/podmienky-pouzivania/page.tsx) je Server Component, ktorý iba číta
// nemenný .md obsah zo súborového systému pre všetky 3 jazyky naraz
// (readLegalMarkdownAllLocales) a odovzdá ich ako deti — samotný výber
// správneho jazyka pre nadpis/menu/obsah rieši tento klientsky komponent.
export function PublicLegalLayout({
  titleKey,
  updatedAt,
  children,
}: PublicLegalLayoutProps) {
  const { t } = useLocale();
  const title = t(titleKey);

  return (
    <main className="app-shell-bg min-h-screen px-4 py-4 sm:px-6 sm:py-8">
      <article className="mx-auto max-w-3xl rounded-doc border border-doc-border bg-surface-1 p-4 sm:p-6">
        <header className="border-b border-subtle pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link
              href="/login"
              className="inline-flex min-h-8 items-center rounded-full bg-brand-500/12 px-3 py-1 text-xs font-semibold tracking-wide text-brand-300 transition hover:bg-brand-500/20"
            >
              ESBLU
            </Link>
            <LanguageSwitcher subtle />
          </div>

          <h1 className="mt-4 text-xl font-semibold tracking-tight text-primary sm:text-2xl">
            {title}
          </h1>

          {updatedAt && (
            <p className="mt-1 text-xs text-muted-esblu">
              {t("legal.updatedAtPrefix")} {updatedAt}
            </p>
          )}
        </header>

        <div className="mt-5 space-y-6 text-sm leading-6 text-secondary">
          {children}
        </div>

        <footer className="mt-8 border-t border-subtle pt-4">
          <nav
            aria-label={t("settings.legal.navAriaLabel")}
            className="flex flex-col gap-2 text-[13px] font-medium sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4"
          >
            <Link
              href="/ochrana-osobnych-udajov"
              className="text-brand-300 hover:underline"
            >
              {t("common.legalLinks.privacy")}
            </Link>
            <Link
              href="/podmienky-pouzivania"
              className="text-brand-300 hover:underline"
            >
              {t("common.legalLinks.terms")}
            </Link>
            <Link href="/cookies" className="text-brand-300 hover:underline">
              {t("common.legalLinks.cookies")}
            </Link>
            <Link href="/dpa" className="text-brand-300 hover:underline">
              {t("common.legalLinks.dpa")}
            </Link>
            <Link
              href="/subprocessors"
              className="text-brand-300 hover:underline"
            >
              {t("common.legalLinks.subprocessors")}
            </Link>
            <Link href="/kontakt" className="text-brand-300 hover:underline">
              {t("common.legalLinks.contact")}
            </Link>
          </nav>

          <Link href="/login" className="ui-btn ui-btn-secondary mt-4">
            {t("legal.backToLogin")}
          </Link>
        </footer>
      </article>
    </main>
  );
}

type LegalSectionProps = {
  title: string;
  children: ReactNode;
};

export function LegalSection({ title, children }: LegalSectionProps) {
  return (
    <section>
      <h2 className="text-base font-semibold text-primary sm:text-lg">{title}</h2>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  );
}
