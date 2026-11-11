"use client";

import { LegalMarkdownLocalized } from "@/app/components/LegalMarkdownLocalized";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { Locale } from "@/lib/i18n/locales";

// B2B VOP 1.2 čl. 8.3: aktuálna aj predchádzajúce verzie sú verejne dostupné.
// Predchádzajúce verzie sa čítajú server-side zo nemenných súborov
// legal/<typ>/<verzia>.md (statický export pre mobile — žiadne query
// parametre), tu sa iba zobrazia v rozbaľovacích sekciách.
export type PreviousLegalVersion = {
  version: string;
  variants: Record<Locale, string>;
  translated: Record<Locale, boolean>;
};

export function PreviousLegalVersions({ versions }: { versions: PreviousLegalVersion[] }) {
  const { t } = useLocale();

  if (versions.length === 0) {
    return null;
  }

  return (
    <section className="mt-10 space-y-3 border-t border-subtle pt-6" data-testid="previous-legal-versions">
      <h2 className="text-base font-semibold text-primary">{t("legal.previousVersions")}</h2>
      {versions.map((item) => (
        <details key={item.version} className="rounded-doc-sm border border-subtle bg-surface-2 p-3">
          <summary className="cursor-pointer text-sm font-medium text-secondary">
            {t("legal.versionLabel", { version: item.version })}
          </summary>
          <div className="mt-4 space-y-6">
            <LegalMarkdownLocalized variants={item.variants} translated={item.translated} />
          </div>
        </details>
      ))}
    </section>
  );
}
