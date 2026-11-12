"use client";

import { useEffect, useState } from "react";
import { SettingsSection } from "@/app/components/ui/SettingsList";
import {
  listCompanyLegalAcceptances,
  type CompanyLegalAcceptanceRecord,
} from "@/lib/company-dpa";
import { useLocale } from "@/lib/i18n/LocaleProvider";

// VOP 8.3 / 8.5 (22/2004 § 5): záznam o uzatvorení Zmluvy (VOP) a DPA za
// aktívnu firmu je trvalo dostupný v Nastaveniach. Číta company_dpa_acceptances
// cez RLS (iba aktívni členovia firmy) — žiadny nový zdroj dát.
export function CompanyLegalAcceptancesSection({ companyId }: { companyId: string }) {
  const { t, locale } = useLocale();
  const [rows, setRows] = useState<CompanyLegalAcceptanceRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!companyId) return;
    listCompanyLegalAcceptances(companyId).then((result) => {
      if (!cancelled) setRows(result);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (!companyId) return null;

  return (
    <SettingsSection title={t("companyTermsGate.settingsTitle")} footer={t("companyTermsGate.settingsFooter")}>
      <div className="space-y-3 p-3 text-[13px] leading-5 text-secondary" data-testid="company-legal-acceptances">
        {rows === null ? null : rows.length === 0 ? (
          <p>{t("companyTermsGate.settingsEmpty")}</p>
        ) : (
          rows.map((row) => (
            <dl key={`${row.document_type}-${row.version}`} className="space-y-0.5">
              <dt className="font-medium text-primary">
                {row.document_type === "terms" ? t("companyTermsGate.docTerms") : t("companyTermsGate.docDpa")}{" "}
                {t("companyTermsGate.recordVersion")} {row.version}
              </dt>
              <dd>{t("companyTermsGate.recordAcceptedAt")}: {new Date(row.accepted_at).toLocaleString(locale)}</dd>
              <dd>{t("companyTermsGate.recordCompany")}: {row.company_name_snapshot ?? "—"} ({row.company_registration_id_snapshot ?? "—"})</dd>
              <dd>{t("companyTermsGate.recordRole")}: {row.accepted_role ?? "—"} · {t("companyTermsGate.recordLanguage")}: {row.display_locale ?? "—"}</dd>
              {row.document_type === "terms" && (
                <dd>
                  {t("companyTermsGate.recordB2b")}: {row.b2b_confirmed ? t("companyTermsGate.yes") : "—"} ·{" "}
                  {t("companyTermsGate.recordAuthority")}: {row.authority_confirmed ? t("companyTermsGate.yes") : "—"}
                </dd>
              )}
              <dd className="break-all">{t("companyTermsGate.recordHash")}: {row.document_content_hash ?? "—"}</dd>
            </dl>
          ))
        )}
      </div>
    </SettingsSection>
  );
}
