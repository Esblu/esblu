"use client";

import { LegalMarkdown } from "@/app/components/LegalMarkdown";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { Locale } from "@/lib/i18n/locales";

// Vyberie správnu jazykovú mutáciu nemenného .md obsahu na klientovi podľa
// useLocale() (localStorage) — appka nepoužíva cookie na server-side výber,
// pozri komentár v app/components/PublicLegalLayout.tsx a
// lib/legal-content.ts#readLegalMarkdownAllLocales. `variants` obsahuje
// všetky 3 jazyky naraz (prečítané server-side v samotnej stránke), takže
// tento prepínač nevyžaduje žiadny ďalší sieťový/FS request.
export function LegalMarkdownLocalized({
  variants,
  translated,
}: {
  variants: Record<Locale, string>;
  // J10: ktoré jazyky majú vlastný preklad (lib/legal-content.ts
  // #legalTranslationAvailability). Bez prekladu sa zobrazí slovenský
  // originál s jasným upozornením — nikdy nie neautorizovaný preklad.
  translated?: Record<Locale, boolean>;
}) {
  const { locale, t } = useLocale();
  const slovakOnly = translated ? translated[locale] === false : false;

  return (
    <>
      {slovakOnly && (
        <aside
          lang={locale}
          className="rounded-doc-sm border border-amber-300/30 bg-warning-soft p-3 font-medium text-amber-300"
        >
          {t("legal.slovakOnlyNotice")}
        </aside>
      )}
      <div lang={slovakOnly ? "sk" : undefined} className="space-y-6">
        <LegalMarkdown markdown={variants[locale]} />
      </div>
    </>
  );
}
