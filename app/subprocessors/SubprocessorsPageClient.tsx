"use client";

import Link from "next/link";
import {
  LegalSection,
  PublicLegalLayout,
} from "@/app/components/PublicLegalLayout";
import { legalConfig } from "@/lib/legal-config";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const linkClass =
  "font-semibold text-accent-cyan underline decoration-accent-cyan/40 underline-offset-4 hover:decoration-accent-cyan";

// Klientská časť /subprocessors — pozri komentár v
// app/kontakt/ContactPageClient.tsx (rovnaký dôvod: bez cookie, bez
// vlastného .md súboru, čisto i18n slovník cez useLocale()).
export function SubprocessorsPageClient() {
  const { t } = useLocale();

  return (
    <PublicLegalLayout titleKey="legal.titles.subprocessors" updatedAt="16. augusta 2026">
      <p>
        {t("legal.subprocessors.introPart1")}{" "}
        <Link href="/dpa" className={linkClass}>
          {t("legal.subprocessors.introDpaLink")}
        </Link>
        .
      </p>

      <LegalSection title={t("legal.subprocessors.sectionVendorsTitle")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-subtle text-left">
                <th className="py-2 pr-4 font-semibold">
                  {t("legal.subprocessors.tableHeaderVendor")}
                </th>
                <th className="py-2 pr-4 font-semibold">
                  {t("legal.subprocessors.tableHeaderPurpose")}
                </th>
                <th className="py-2 pr-4 font-semibold">
                  {t("legal.subprocessors.tableHeaderDataCategories")}
                </th>
                <th className="py-2 pr-4 font-semibold">
                  {t("legal.subprocessors.tableHeaderLocation")}
                </th>
                <th className="py-2 font-semibold">
                  {t("legal.subprocessors.tableHeaderDocs")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-subtle align-top">
                <td className="py-2 pr-4 font-semibold">Supabase</td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.supabasePurpose")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.supabaseDataCategories")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.supabaseLocation")}
                </td>
                <td className="py-2">
                  <a
                    href="https://supabase.com/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    supabase.com/privacy
                  </a>
                </td>
              </tr>
              <tr className="border-b border-subtle align-top">
                <td className="py-2 pr-4 font-semibold">OpenAI</td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.openaiPurpose")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.openaiDataCategories")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.openaiLocation")}
                </td>
                <td className="py-2">
                  <a
                    href="https://openai.com/enterprise-privacy/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    openai.com/enterprise-privacy
                  </a>
                </td>
              </tr>
              <tr className="border-b border-subtle align-top">
                <td className="py-2 pr-4 font-semibold">Vercel</td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.vercelPurpose")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.vercelDataCategories")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.vercelLocation")}
                </td>
                <td className="py-2">
                  <a
                    href="https://vercel.com/legal/privacy-policy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    vercel.com/legal/privacy-policy
                  </a>
                </td>
              </tr>
              <tr className="border-b border-subtle align-top">
                <td className="py-2 pr-4 font-semibold">
                  Namecheap (Private Email)
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.namecheapPurpose")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.namecheapDataCategories")}
                </td>
                <td className="py-2 pr-4">
                  {t("legal.subprocessors.namecheapLocation")}
                </td>
                <td className="py-2">
                  <a
                    href="https://www.namecheap.com/legal/universal/data-processing-addendum/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    namecheap.com/legal/.../data-processing-addendum
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </LegalSection>

      <LegalSection title={t("legal.subprocessors.sectionEmailHistoryTitle")}>
        <p>{t("legal.subprocessors.emailHistoryPara1")}</p>
        <p>
          <strong>{t("legal.subprocessors.emailHistoryResendLabel")}</strong>{" "}
          {t("legal.subprocessors.emailHistoryResendText")}
        </p>
        <p>
          <strong>
            {t("legal.subprocessors.emailHistoryNamecheapLabel")}
          </strong>{" "}
          {t("legal.subprocessors.emailHistoryNamecheapText")}
        </p>
      </LegalSection>

      <LegalSection title={t("legal.subprocessors.sectionChangesTitle")}>
        <p>
          {t("legal.subprocessors.changesText", {
            date: legalConfig.effectiveDate,
          })}
        </p>
      </LegalSection>
    </PublicLegalLayout>
  );
}
