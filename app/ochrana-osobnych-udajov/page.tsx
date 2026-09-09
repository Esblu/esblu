import type { Metadata } from "next";
import { PublicLegalLayout } from "@/app/components/PublicLegalLayout";
import { LegalMarkdownLocalized } from "@/app/components/LegalMarkdownLocalized";
import { readLegalMarkdownAllLocales } from "@/lib/legal-content";
import { legalConfig } from "@/lib/legal-config";

export const metadata: Metadata = {
  title: "Zásady ochrany osobných údajov | Esblu",
  description: "Informácie o spracúvaní osobných údajov v službe Esblu.",
};

// Rendering shell — pozri komentár v app/podmienky-pouzivania/page.tsx
// (rovnaký vzor: žiadna cookie server-side, všetky 3 jazyky sa čítajú
// naraz, výber rieši klientsky LegalMarkdownLocalized).
export default function PrivacyPolicyPage() {
  const markdownByLocale = readLegalMarkdownAllLocales(
    "privacy_policy",
    legalConfig.privacyPolicyVersion
  );

  return (
    <PublicLegalLayout
      titleKey="legal.titles.privacy"
      updatedAt={`9. septembra 2026 (verzia ${legalConfig.privacyPolicyVersion})`}
    >
      <LegalMarkdownLocalized variants={markdownByLocale} />
    </PublicLegalLayout>
  );
}
