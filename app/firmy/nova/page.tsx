"use client";

// =============================================================================
// Pridať vlastnú firmu (multi-company 2026-10-12) — existujúci prihlásený
// používateľ si založí ďalší workspace, v ktorom je owner. Žiadna nová
// registrácia, e-mail ani heslo (rovnaká identita). Po vytvorení je nová
// firma aktívna a appka sa načíta nanovo na nástenke.
// Trial / nároky: existujúca logika pre každú novú firmu (žiadny pricing).
// =============================================================================

import { useState } from "react";
import BackLink from "@/app/components/BackLink";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { createMyCompany, resetCompanyScopedClientState, workspaceErrorKey } from "@/lib/company-workspaces";
import { navigateHard } from "@/lib/app-navigation";

export default function NewCompanyPage() {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || trimmed.length < 2) return;
    setSubmitting(true);
    setError("");
    try {
      await createMyCompany(trimmed);
      resetCompanyScopedClientState();
      navigateHard("/");
    } catch (createError) {
      setSubmitting(false);
      setError(t(workspaceErrorKey(createError)));
    }
  }

  return (
    <main className="app-shell-bg min-h-screen p-4 sm:p-6 lg:p-10">
      <BackLink href="/nastavenia" label={t("settings.pageTitle")} className="mb-4" />
      <section className="mx-auto max-w-lg rounded-doc border border-doc-border bg-surface-1 p-5 shadow-lg" aria-labelledby="new-company-title">
        <h1 id="new-company-title" className="text-xl font-semibold text-primary">{t("workspaces.create.title")}</h1>
        <p className="mt-2 text-sm text-secondary">{t("workspaces.create.body")}</p>
        <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
          <label className="block">
            <span className="ui-label">{t("workspaces.create.nameLabel")}</span>
            <input
              type="text"
              className="ui-input mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("workspaces.create.namePlaceholder")}
              maxLength={200}
              autoComplete="organization"
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "new-company-error" : undefined}
              required
            />
          </label>
          {error && (
            <p id="new-company-error" role="alert" className="ui-notice" data-tone="error">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="ui-btn ui-btn-secondary" onClick={() => navigateHard("/nastavenia")} disabled={submitting}>
              {t("workspaces.create.cancel")}
            </button>
            <button type="submit" className="ui-btn ui-btn-primary" disabled={submitting || trimmed.length < 2}>
              {submitting ? t("workspaces.create.creating") : t("workspaces.create.submit")}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
