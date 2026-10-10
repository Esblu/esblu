"use client";

import { LegalSection, PublicLegalLayout } from "@/app/components/PublicLegalLayout";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const emailLinkClass = "break-all font-semibold text-blue-700 underline decoration-blue-300 underline-offset-4";

// =============================================================================
// /zrusenie-uctu — verejná stránka zrušenia účtu (Google Play: account
// deletion web resource). Opisuje IBA existujúci flow (Nastavenia → Zrušiť
// účet, app/api/account/delete) a existujúce kontakty; texty o rozsahu
// mazania a zákonnej archivácii sú prevzaté zo settings.deleteAccount /
// settings.deleteModal (rovnaké znenie ako v appke). Žiadne nové právne tvrdenia.
// =============================================================================
export function AccountDeletionPageClient() {
  const { t } = useLocale();

  return (
    <PublicLegalLayout titleKey="legal.titles.accountDeletion">
      <p>{t("legal.accountDeletionPage.intro")}</p>

      <LegalSection title={t("legal.accountDeletionPage.inAppTitle")}>
        <ol className="list-decimal space-y-1 pl-5">
          <li>{t("legal.accountDeletionPage.inAppStep1")}</li>
          <li>{t("legal.accountDeletionPage.inAppStep2")}</li>
          <li>{t("legal.accountDeletionPage.inAppStep3")}</li>
        </ol>
      </LegalSection>

      <LegalSection title={t("legal.accountDeletionPage.scopeTitle")}>
        <p>{t("settings.deleteAccount.ownerDescription")}</p>
        <p>{t("settings.deleteAccount.memberDescription")}</p>
        <p>{t("settings.deleteModal.ownerBlockedRetention")}</p>
      </LegalSection>

      <LegalSection title={t("legal.accountDeletionPage.emailTitle")}>
        <p>
          {t("legal.accountDeletionPage.emailText")}{" "}
          <a href="mailto:privacy@esblu.com?subject=Esblu%20-%20zrusenie%20uctu" className={emailLinkClass}>
            privacy@esblu.com
          </a>
          .
        </p>
      </LegalSection>
    </PublicLegalLayout>
  );
}
