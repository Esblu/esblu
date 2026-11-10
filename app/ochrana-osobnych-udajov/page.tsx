import type { Metadata } from "next";
import { PublicLegalLayout } from "@/app/components/PublicLegalLayout";
import { LegalMarkdownLocalized } from "@/app/components/LegalMarkdownLocalized";
import { legalTranslationAvailability, readLegalMarkdownAllLocales } from "@/lib/legal-content";
import { legalConfig } from "@/lib/legal-config";

export const metadata: Metadata = {
  title: "Ochrana osobných údajov | Esblu",
  description: "Zásady spracúvania osobných údajov spoločnosti Esblu s. r. o.",
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
      updatedAt={`9. novembra 2026 (verzia ${legalConfig.privacyPolicyVersion})`}
    >
      <LegalMarkdownLocalized
        variants={markdownByLocale}
        translated={legalTranslationAvailability("privacy_policy", legalConfig.privacyPolicyVersion)}
      />
    </PublicLegalLayout>
  );
}
