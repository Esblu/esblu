import type { Metadata } from "next";
import { PublicLegalLayout } from "@/app/components/PublicLegalLayout";
import { LegalMarkdownLocalized } from "@/app/components/LegalMarkdownLocalized";
import { readLegalMarkdownAllLocales } from "@/lib/legal-content";
import { legalConfig } from "@/lib/legal-config";

export const metadata: Metadata = {
  title: "Podmienky používania Esblu",
  description: "Podmienky používania bezplatnej testovacej verzie Esblu.",
};

// Táto stránka je iba rendering shell — právne záväzný text je nemenný
// súbor legal/terms/<version>.md (pozri lib/legal-content.ts), ktorého
// SHA-256 je uložený v legal_documents.content_hash. Úprava textu sa robí
// VÝHRADNE pridaním novej verzie (nový .md súbor + nová hodnota
// legalConfig.termsVersion), nikdy úpravou existujúceho .md súboru.
// DE/EN preklad (legal/terms/<version>.de.md, .en.md) je čisto zobrazovacia
// vec — nemení versioned/immutable legal acceptance model (ten eviduje iba
// document_type + version, nie locale, pozri lib/legal-content.ts). Appka
// nepoužíva cookie na výber jazyka server-side (pozri lib/i18n/locales.ts),
// preto táto Server Component stránka prečíta všetky 3 jazykové mutácie
// naraz a výber necháva na klientskom LegalMarkdownLocalized.
export default function TermsPage() {
  const markdownByLocale = readLegalMarkdownAllLocales(
    "terms",
    legalConfig.termsVersion
  );

  return (
    <PublicLegalLayout
      titleKey="legal.titles.terms"
      updatedAt={`9. septembra 2026 (verzia ${legalConfig.termsVersion})`}
    >
      <LegalMarkdownLocalized variants={markdownByLocale} />
    </PublicLegalLayout>
  );
}
