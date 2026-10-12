"use client";

// =============================================================================
// Výber firmy pri štarte (multi-company 2026-10-12): používateľ s 2+ firmami
// bez platnej aktívnej firmy (napr. jeho voľba už neplatí — odchod, revoke,
// zrušená firma). Nikdy sa nevyberá náhodná firma.
// =============================================================================

import { useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { switchCompanyAndReload, workspaceErrorKey, type MyCompany } from "@/lib/company-workspaces";

export default function CompanyPicker({ companies }: { companies: MyCompany[] }) {
  const { t } = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  return (
    <main className="app-shell-bg grid min-h-dvh place-items-center px-4 py-8">
      <section className="w-full max-w-md rounded-doc border border-doc-border bg-surface-1 p-5 shadow-xl" aria-labelledby="company-picker-title">
        <h1 id="company-picker-title" className="text-xl font-semibold text-primary">{t("workspaces.pickTitle")}</h1>
        <p className="mt-2 text-sm text-secondary">{t("workspaces.pickBody")}</p>
        <ul className="mt-4 space-y-2">
          {companies.map((company) => (
            <li key={company.company_id}>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={async () => {
                  setBusyId(company.company_id);
                  setError("");
                  try {
                    await switchCompanyAndReload(company.company_id, "/");
                  } catch (switchError) {
                    setBusyId(null);
                    setError(t(workspaceErrorKey(switchError)));
                  }
                }}
                className="flex min-h-12 w-full items-center gap-3 rounded-doc-sm border border-subtle px-3 py-2 text-left hover:bg-surface-hover disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-primary">{company.company_name}</span>
                  <span className="block text-xs text-muted-esblu">{t(`workspaces.roles.${company.role}`)}</span>
                </span>
                {busyId === company.company_id && <span className="text-xs text-muted-esblu">{t("workspaces.switching")}</span>}
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        <Link href="/firmy/nova" className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-brand-300">
          + {t("workspaces.addOwnCompany")}
        </Link>
      </section>
    </main>
  );
}
