"use client";

import {
  LegalSection,
  PublicLegalLayout,
} from "@/app/components/PublicLegalLayout";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const emailLinkClass =
  "break-all font-medium text-brand-300 underline decoration-brand-300/40 underline-offset-4";

// Klientská časť /kontakt — appka nepoužíva cookie na server-side výber
// jazyka (pozri lib/i18n/locales.ts), preto sa celý obsah tejto stránky
// (bez vlastného .md súboru, iba i18n slovník) renderuje na klientovi cez
// useLocale(). Metadata (<title> a pod.) exportuje nadradený
// app/kontakt/page.tsx (Server Component), keďže "use client" súbory
// export const metadata nepodporujú.
export function ContactPageClient() {
  const { t } = useLocale();

  return (
    <PublicLegalLayout titleKey="legal.titles.contact">
      <p>{t("legal.contactPage.intro")}</p>

      <LegalSection title={t("legal.contactPage.generalTitle")}>
        <p>
          {t("legal.contactPage.generalText")}{" "}
          <a href="mailto:info@esblu.com" className={emailLinkClass}>
            info@esblu.com
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title={t("legal.contactPage.privacyTitle")}>
        <p>
          {t("legal.contactPage.privacyText")}{" "}
          <a href="mailto:privacy@esblu.com" className={emailLinkClass}>
            privacy@esblu.com
          </a>
          .
        </p>
      </LegalSection>

      <p className="rounded-doc-sm border border-subtle bg-surface-2 p-3 text-[13px] leading-5 text-secondary">
        {t("legal.contactPage.supportNote")}
      </p>
    </PublicLegalLayout>
  );
}
