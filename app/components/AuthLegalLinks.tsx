"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";

// Odkazy na právne dokumenty pod prihlasovacími / registračnými obrazovkami
// (CLIA manuál 2.2.1 b: odkaz na Privacy Policy na registračnej a
// prihlasovacej obrazovke). Rovnaký vzhľad ako päta app/login/page.tsx;
// J10 doplnené aj na pozvánkovú registráciu (/invite) a obnovu hesla.
export function AuthLegalLinks({ className = "mt-4" }: { className?: string }) {
  const { t } = useLocale();
  const linkClass = "inline-flex min-h-7 items-center px-1 hover:text-brand-300 hover:underline";

  return (
    <nav
      aria-label={t("settings.legal.navAriaLabel")}
      className={`${className} flex flex-wrap justify-center gap-x-2 gap-y-0 border-t border-subtle pt-1.5 text-center text-xs font-medium text-muted-esblu`}
    >
      <Link href="/ochrana-osobnych-udajov" className={linkClass}>
        {t("common.legalLinks.privacy")}
      </Link>
      <Link href="/podmienky-pouzivania" className={linkClass}>
        {t("common.legalLinks.terms")}
      </Link>
      <Link href="/cookies" className={linkClass}>
        {t("common.legalLinks.cookies")}
      </Link>
      <Link href="/kontakt" className={linkClass}>
        {t("common.legalLinks.contact")}
      </Link>
    </nav>
  );
}
