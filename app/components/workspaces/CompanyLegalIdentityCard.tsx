"use client";

// =============================================================================
// Nastavenia → „Identita firmy" (20261012160000).
//
// Owner aktívnej firmy doplní / overí IČO aj po vytvorení firmy. Overenie
// robí SERVER (register RPO); o skúšobnom období rozhoduje DB podľa histórie
// právneho subjektu — tu sa iba zobrazuje výsledok. Admin / účtovník vidia
// stav iba na čítanie; zamestnanec sekciu nevidí (rodič ju nevykreslí, DB by
// aj tak odmietla). Overené IČO je zamknuté (žiadny prepis kvôli trialu).
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { SettingsRow, SettingsSection } from "@/app/components/ui/SettingsList";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  loadActiveCompanyLegalIdentity,
  resetCompanyScopedClientState,
  verifyActiveCompanyLegalIdentity,
  workspaceErrorKey,
  type CompanyLegalIdentity,
} from "@/lib/company-workspaces";

export function legalIdentityStatusKey(identity: Pick<CompanyLegalIdentity, "verification_status" | "trial_status">): string {
  if (identity.verification_status === "verified" || identity.verification_status === "manual") {
    return identity.trial_status === "not_eligible_previous_trial" ? "workspaces.identity.status.trialUsed" : "workspaces.identity.status.verified";
  }
  if (identity.verification_status === "failed") return "workspaces.identity.status.failed";
  if (identity.verification_status === "unverified") return "workspaces.identity.status.pending";
  return "workspaces.identity.status.missing";
}

export function legalIdentityCtaKey(identity: Pick<CompanyLegalIdentity, "verification_status">): string | null {
  switch (identity.verification_status) {
    case "missing":
      return "workspaces.identity.cta.add";
    case "unverified":
    case "failed":
      return "workspaces.identity.cta.retry";
    default:
      return null; // overené = zamknuté
  }
}

export default function CompanyLegalIdentityCard() {
  const { t, locale } = useLocale();
  const [identity, setIdentity] = useState<CompanyLegalIdentity | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [ico, setIco] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);

  const apply = useCallback((next: CompanyLegalIdentity | null) => {
    setIdentity(next);
    setLoadFailed(false);
    if (next?.registration_id) setIco(next.registration_id);
  }, []);

  const load = useCallback(
    () => loadActiveCompanyLegalIdentity().then(apply, () => setLoadFailed(true)),
    [apply]
  );

  useEffect(() => {
    let alive = true;
    loadActiveCompanyLegalIdentity().then(
      (next) => {
        if (alive) apply(next);
      },
      () => {
        if (alive) setLoadFailed(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [apply]);

  if (loadFailed) {
    return (
      <SettingsSection title={t("workspaces.identity.title")}>
        <SettingsRow title={t("workspaces.identity.loadFailed")} />
      </SettingsSection>
    );
  }
  if (!identity) return null;

  const statusKey = legalIdentityStatusKey(identity);
  const ctaKey = identity.can_edit ? legalIdentityCtaKey(identity) : null;
  const trialEnds = identity.trial_ends_at ? new Date(identity.trial_ends_at).toLocaleDateString(locale) : "";
  const trialKey = `workspaces.identity.trial.${identity.trial_status}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ico.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await verifyActiveCompanyLegalIdentity(ico.trim());
      resetCompanyScopedClientState(); // nároky sa znova načítajú (trial)
      setEditing(false);
      setNotice({ tone: outcome === "granted" ? "success" : "info", text: t(`workspaces.identity.result.${outcome}`) });
    } catch (error) {
      setNotice({ tone: "error", text: t(workspaceErrorKey(error)) });
    } finally {
      setBusy(false);
      await load();
    }
  }

  return (
    <SettingsSection
      title={t("workspaces.identity.title")}
      footer={identity.can_edit ? t("workspaces.identity.footer") : t("workspaces.identity.readOnly")}
    >
      <SettingsRow title={t("workspaces.identity.companyName")} subtitle={identity.company_name ?? "—"} />
      <SettingsRow title={t("workspaces.identity.country")} subtitle={t(`workspaces.identity.countries.${identity.country_code ?? "SK"}`)} />
      <SettingsRow title={t("workspaces.identity.registrationId")} subtitle={identity.registration_id ?? t("workspaces.identity.notFilled")} />
      <SettingsRow
        title={t("workspaces.identity.statusLabel")}
        subtitle={
          <>
            <span data-testid="legal-identity-status">{t(statusKey)}</span>
            {identity.verification_status === "failed" && identity.last_error && (
              <span className="block">{t(`workspaces.identity.errors.${identity.last_error}`)}</span>
            )}
            {identity.verification_status === "unverified" && identity.last_error === "unavailable" && (
              <span className="block">{t("workspaces.identity.errors.unavailable")}</span>
            )}
          </>
        }
      />
      <SettingsRow title={t("workspaces.identity.trialLabel")} subtitle={t(trialKey, { date: trialEnds })} />
      {(identity.verification_status === "verified" || identity.verification_status === "manual") && identity.can_edit && (
        <SettingsRow title={t("workspaces.identity.lockedNote")} />
      )}
      {ctaKey && !editing && (
        <div className="px-3 py-2">
          <button type="button" className="ui-btn ui-btn-secondary" onClick={() => setEditing(true)}>
            {t(ctaKey)}
          </button>
        </div>
      )}
      {ctaKey && editing && (
        <form className="space-y-3 px-3 py-2" onSubmit={submit} noValidate>
          <label className="block">
            <span className="ui-label">{t("workspaces.identity.icoLabel")}</span>
            <input
              type="text"
              inputMode="numeric"
              className="ui-input mt-1"
              value={ico}
              onChange={(event) => setIco(event.target.value)}
              maxLength={16}
              autoComplete="off"
              disabled={busy}
              required
            />
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="ui-btn ui-btn-secondary" onClick={() => setEditing(false)} disabled={busy}>
              {t("workspaces.create.cancel")}
            </button>
            <button type="submit" className="ui-btn ui-btn-primary" disabled={busy || !ico.trim()}>
              {busy ? t("workspaces.identity.verifying") : t("workspaces.identity.cta.verify")}
            </button>
          </div>
        </form>
      )}
      {notice && (
        <p role={notice.tone === "error" ? "alert" : "status"} className="ui-notice mx-3 my-2" data-tone={notice.tone === "info" ? undefined : notice.tone}>
          {notice.text}
        </p>
      )}
    </SettingsSection>
  );
}
