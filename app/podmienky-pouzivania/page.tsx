import type { Metadata } from "next";
import { PublicLegalLayout } from "@/app/components/PublicLegalLayout";
import { LegalMarkdownLocalized } from "@/app/components/LegalMarkdownLocalized";
import { PreviousLegalVersions } from "@/app/components/PreviousLegalVersions";
import { legalTranslationAvailability, readLegalMarkdownAllLocales } from "@/lib/legal-content";
import { legalConfig, PREVIOUS_TERMS_VERSIONS } from "@/lib/legal-config";

export const metadata: Metadata = {
  title: "Všeobecné obchodné podmienky | Esblu",
  description:
    "Všeobecné obchodné podmienky poskytovania aplikácie Esblu pre podnikateľov (B2B).",
};

// Táto stránka je iba rendering shell — právne záväzný text je nemenný
// súbor legal/terms/<version>.md (pozri lib/legal-content.ts), ktorého
// SHA-256 je uložený v legal_documents.content_hash. Úprava textu sa robí
// VÝHRADNE pridaním novej verzie (nový .md súbor + nová hodnota
// legalConfig.termsVersion), nikdy úpravou existujúceho .md súboru.
// DE/EN preklad (legal/terms/<version>.de.md, .en.md) je preklad tej istej
// verzie (VOP 8.3: záväzné je slovenské znenie); jazyk zobrazenia sa eviduje
// v metadata potvrdenia. Appka nepoužíva cookie na výber jazyka server-side
// (pozri lib/i18n/locales.ts), preto stránka prečíta všetky 3 jazykové
// mutácie naraz a výber necháva na klientskom LegalMarkdownLocalized.
// Predchádzajúce verzie (VOP 1.2 čl. 8.3) sa zobrazujú pod aktuálnou.
export default function TermsPage() {
  const markdownByLocale = readLegalMarkdownAllLocales(
    "terms",
    legalConfig.termsVersion
  );

  const previous = PREVIOUS_TERMS_VERSIONS.map((version) => ({
    version,
    variants: readLegalMarkdownAllLocales("terms", version),
    translated: legalTranslationAvailability("terms", version),
  }));

  return (
    <PublicLegalLayout
      titleKey="legal.titles.terms"
      updatedAt={`${legalConfig.termsUpdatedAt} (verzia ${legalConfig.termsVersion})`}
    >
      <LegalMarkdownLocalized
        variants={markdownByLocale}
        translated={legalTranslationAvailability("terms", legalConfig.termsVersion)}
      />
      <PreviousLegalVersions versions={previous} />
    </PublicLegalLayout>
  );
}
