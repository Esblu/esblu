"use client";

import { useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { CompanyExportError, downloadCompanyExport } from "@/lib/company-export-client";

// VOP 1.2 čl. 19 / 20.6, DPA: export všetkých údajov firmy (owner).
// Údaje JSON/CSV + originálne súbory po dávkach; každý ZIP overený SHA-256.
export function CompanyExportButton({ onDone }: { onDone?: () => void }) {
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await downloadCompanyExport(locale, (done, total) =>
        setProgress(t("settings.companyExport.progress", { done, total }))
      );
      setMessage({
        tone: "success",
        text: result.missingFiles > 0
          ? t("settings.companyExport.doneWithMissing", { count: result.missingFiles })
          : t("settings.companyExport.done"),
      });
      onDone?.();
    } catch (error) {
      const code = error instanceof CompanyExportError ? error.code : "EXPORT_FAILED";
      setMessage({ tone: "error", text: error instanceof CompanyExportError && error.message !== code ? error.message : t(`settings.companyExport.errors.${code}`) });
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  return (
    <div className="space-y-2" data-testid="company-export">
      <button type="button" onClick={run} disabled={busy} className="ui-btn ui-btn-secondary w-full sm:w-auto">
        {busy ? progress || t("settings.companyExport.running") : t("settings.companyExport.button")}
      </button>
      {message && (
        <p className="ui-notice" data-tone={message.tone === "error" ? "error" : "success"} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
