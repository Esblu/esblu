import type { Metadata } from "next";
import { PublicLegalLayout } from "@/app/components/PublicLegalLayout";
import { LegalMarkdownLocalized } from "@/app/components/LegalMarkdownLocalized";
import { readLegalMarkdownAllLocales } from "@/lib/legal-content";
import { legalConfig } from "@/lib/legal-config";

export const metadata: Metadata = {
  title: "Zmluva o spracúvaní osobných údajov (DPA) | Esblu",
  description:
    "Podmienky spracúvania osobných údajov podľa čl. 28 GDPR pre firemných zákazníkov Esblu.",
};

// Rendering shell — pozri komentár v app/podmienky-pouzivania/page.tsx.
export default function DpaPage() {
  const markdownByLocale = readLegalMarkdownAllLocales(
    "dpa",
    legalConfig.dpaVersion
  );

  return (
    <PublicLegalLayout
      titleKey="legal.titles.dpa"
      updatedAt={`9. septembra 2026 (verzia ${legalConfig.dpaVersion})`}
    >
      <LegalMarkdownLocalized variants={markdownByLocale} />
    </PublicLegalLayout>
  );
}
