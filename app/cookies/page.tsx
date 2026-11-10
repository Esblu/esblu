import type { Metadata } from "next";
import { PublicLegalLayout } from "@/app/components/PublicLegalLayout";
import { LegalMarkdownLocalized } from "@/app/components/LegalMarkdownLocalized";
import { readLegalMarkdownAllLocales } from "@/lib/legal-content";
import { legalConfig } from "@/lib/legal-config";

export const metadata: Metadata = {
  title: "Informácie o cookies | Esblu",
  description:
    "Prehľad cookies a obdobných technológií, ktoré Esblu skutočne používa.",
};

// Rendering shell — pozri komentár v app/podmienky-pouzivania/page.tsx.
// Sekcia „Informácie o cookies“ (CLIA manuál čl. VI, J10 2026-11-10) —
// verzia 1.1 = reálny inventár (pozri legalConfig.cookiePolicyVersion).
export default function CookiesPage() {
  const markdownByLocale = readLegalMarkdownAllLocales(
    "cookie_policy",
    legalConfig.cookiePolicyVersion
  );

  return (
    <PublicLegalLayout
      titleKey="legal.titles.cookies"
      updatedAt={`10. novembra 2026 (verzia ${legalConfig.cookiePolicyVersion})`}
    >
      <LegalMarkdownLocalized variants={markdownByLocale} />
    </PublicLegalLayout>
  );
}
