"use client";

// =============================================================================
// Prepínač firmy (workspace) — multi-company 2026-10-12.
// Zobrazí aktívnu firmu + rolu; po otvorení zoznam vlastných členstiev a
// „Pridať vlastnú firmu". Prepnutie overí server (esblu_set_my_active_company)
// a appka sa načíta nanovo (žiadny stale obsah ani realtime z inej firmy).
// =============================================================================

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { listMyCompanies, switchCompanyAndReload, workspaceErrorKey, type MyCompany } from "@/lib/company-workspaces";

export default function CompanySwitcher({ className = "" }: { className?: string }) {
  const { t } = useLocale();
  const [companies, setCompanies] = useState<MyCompany[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    listMyCompanies()
      .then((rows) => {
        if (!cancelled) setCompanies(rows);
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!companies || companies.length === 0) return null;
  const active = companies.find((c) => c.is_active) ?? null;

  async function choose(company: MyCompany) {
    if (company.is_active || busyId) {
      setOpen(false);
      return;
    }
    setBusyId(company.company_id);
    setError("");
    try {
      await switchCompanyAndReload(company.company_id, "/");
    } catch (switchError) {
      setBusyId(null);
      setError(t(workspaceErrorKey(switchError)));
    }
  }

  return (
    <div className={`relative ${className}`.trim()}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-doc-sm border border-subtle bg-surface-1 px-3 text-left text-sm text-primary transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <span className="min-w-0">
          <span className="block truncate font-semibold">{active?.company_name ?? t("workspaces.pickTitle")}</span>
          {active && <span className="block text-xs text-muted-esblu">{t(`workspaces.roles.${active.role}`)}</span>}
        </span>
        <span aria-hidden="true" className="ml-auto text-muted-esblu">▾</span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t("workspaces.switcherLabel")}
          className="absolute left-0 z-[60] mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-doc border border-doc-border bg-surface-1 shadow-xl"
        >
          <ul className="max-h-[60dvh] overflow-y-auto py-1">
            {companies.map((company) => (
              <li key={company.company_id}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={company.is_active}
                  disabled={busyId !== null}
                  onClick={() => void choose(company)}
                  className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-primary">{company.company_name}</span>
                    <span className="block text-xs text-muted-esblu">{t(`workspaces.roles.${company.role}`)}</span>
                  </span>
                  {company.is_active && <span className="text-xs font-semibold text-brand-300">{t("workspaces.active")}</span>}
                  {busyId === company.company_id && <span className="text-xs text-muted-esblu">{t("workspaces.switching")}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-subtle p-1">
            <Link
              href="/firmy/nova"
              role="menuitem"
              className="flex min-h-11 items-center rounded-doc-sm px-3 text-sm font-semibold text-brand-300 hover:bg-surface-hover"
              onClick={() => setOpen(false)}
            >
              + {t("workspaces.addOwnCompany")}
            </Link>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
