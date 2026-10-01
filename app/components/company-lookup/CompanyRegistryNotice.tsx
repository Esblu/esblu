"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate, formatDateTime } from "@/lib/i18n/format";
import { DocumentNotice } from "@/app/components/document/DocumentLayout";
import type { CompanyDetailResponseBody } from "@/lib/company-lookup/types";

// =============================================================================
// Zhrnutie údajov prevzatých z registra: zdroj (CC BY 4.0 atribúcia),
// "Naposledy overené", právna forma, zrušený subjekt a varovania enrichmentu.
// Iba zobrazenie — o uložení rozhoduje používateľ vo formulári.
// =============================================================================

export default function CompanyRegistryNotice({ detail }: { detail: CompanyDetailResponseBody }) {
  const { t, locale } = useLocale();
  const { company } = detail;
  const terminated = company.status === "terminated";
  const ruzUsed = detail.sources.some((source) => source.id === "ruz" && source.status === "VERIFIED") && company.dic !== null;

  return (
    <div className="space-y-2">
      {terminated && (
        <DocumentNotice tone="critical" title={t("companyLookup.terminatedWarningTitle")}>
          {company.terminatedOn
            ? t("companyLookup.terminatedWarningBody", { date: formatDate(company.terminatedOn, locale) })
            : t("companyLookup.terminatedWarningBodyNoDate")}
        </DocumentNotice>
      )}

      <DocumentNotice tone="info" title={t("companyLookup.reviewTitle")}>
        <p>{t("companyLookup.reviewBody")}</p>
        {company.legalForm && <p className="mt-1">{t("companyLookup.legalForm", { name: company.legalForm.name })}</p>}
        {detail.warnings.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {detail.warnings.map((warning) => (
              <li key={warning}>{t(`companyLookup.warnings.${warning}`)}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs">
          {t("companyLookup.sourceRpo")}
          {ruzUsed ? ` · ${t("companyLookup.sourceRuz")}` : ""}
        </p>
        <p className="text-xs">{t("companyLookup.checkedAt", { date: formatDateTime(detail.checkedAt, locale) })}</p>
      </DocumentNotice>
    </div>
  );
}
