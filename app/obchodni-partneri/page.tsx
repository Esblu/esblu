"use client";

import { Suspense, cloneElement, isValidElement, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import {
  getMyActiveMembership,
  hasFinanceManage,
  hasFinanceView,
  type MyActiveMembership,
} from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import BusinessPartnersIcon from "@/app/components/icons/BusinessPartnersIcon";
import {
  BUSINESS_PARTNER_DUPLICATE_ICO_ERROR,
  EMPTY_BUSINESS_PARTNER_FORM,
  businessPartnerToForm,
  createBusinessPartner,
  deleteBusinessPartner,
  listBusinessPartners,
  updateBusinessPartner,
  validateBusinessPartnerForm,
  type BusinessPartner,
  type BusinessPartnerForm,
  type BusinessPartnerKind,
  type BusinessPartnerValidationError,
} from "@/lib/business-partners";
import {
  DocumentSection,
  DocumentNotice,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";

type KindFilter = "all" | BusinessPartnerKind;

/**
 * Jedno pole partnera: label + pole + voliteľná pomôcka a chyba.
 * Nahrádza 14× opakovaný `<div><label…><input…>{fieldError && <p…>}</div>`.
 */
function PartnerField({
  label,
  hint,
  error,
  full,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  full?: boolean;
  children: React.ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  // Label musí byť previazaný s poľom, inak ho čítačka obrazovky neprečíta a
  // klik naň nezaostrí pole (§25). Id sa generuje, aby volajúci nemusel
  // vymýšľať unikátne reťazce pre 20 polí.
  const id = useId();
  const hintId = `${id}-hint`;
  const showHint = Boolean(hint) && !error;

  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        "aria-describedby": showHint || error ? hintId : undefined,
      })
    : children;

  return (
    <div className={full ? "sm:col-span-2" : undefined}>
      <label className={docLabel} htmlFor={id}>
        {label}
      </label>
      {control}
      {showHint && (
        <p id={hintId} className="mt-1 text-xs text-muted-esblu">
          {hint}
        </p>
      )}
      {error && (
        <p id={hintId} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// useSearchParams() vyžaduje Suspense boundary (Next.js App Router) — pozri
// rovnaký vzor v app/ai-evidencia/page.tsx (OpenFromQueryParam). Izolované
// do vlastného malého komponentu, aby Suspense fallback nezablokoval
// vykreslenie celej (väčšej) stránky, iba tento jeden efekt.
function EditFromQueryParam({ onEditId }: { onEditId: (id: string) => void }) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const editId = searchParams.get("edit");
    if (editId) {
      onEditId(editId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return null;
}

export default function ObchodniPartneriPage() {
  const { t } = useLocale();
  const { legalHold } = useCompanyDpaLegalHold();

  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  // Finance Access Hardening — obchodní partneri sú finančné/billing dáta.
  // canView/canEdit vychádzajú VÝHRADNE z permissions.finance.view/manage
  // (+ owner vždy), NIE z role==='admin'. Toto je iba UI vrstva — reálne
  // vynútenie je RLS (esblu_my_finance_view/manage()) na strane DB, takže
  // priame otvorenie tejto URL bez oprávnenia aj tak nič nenačíta.
  const [membership, setMembership] = useState<MyActiveMembership | null>(null);
  const [membershipLoaded, setMembershipLoaded] = useState(false);
  const canView = hasFinanceView(membership);
  const canEdit = hasFinanceManage(membership);

  const [partners, setPartners] = useState<BusinessPartner[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  const [form, setForm] = useState<BusinessPartnerForm>(EMPTY_BUSINESS_PARTNER_FORM);
  const [formErrors, setFormErrors] = useState<BusinessPartnerValidationError[]>([]);
  const [formSubmitError, setFormSubmitError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void init();
  }, []);

  // Otvorenie editácie z detailu (app/obchodni-partneri/[id]/page.tsx
  // "Upraviť" tlačidlo linkuje sem s ?edit=<id>, formulár žije iba na tejto
  // stránke — pozri EditFromQueryParam vyššie). Match + reset presunuté do
  // samostatnej funkcie (namiesto priameho setPendingEditId() v tele
  // efektu), aby efekt iba "sleduje" zmenu a nevykonáva setState synchrónne
  // vo svojom tele.
  useEffect(() => {
    if (!pendingEditId) return;

    const match = partners.find((partner) => partner.id === pendingEditId);
    if (match) {
      openPendingEdit(match);
    }
  }, [pendingEditId, partners]);

  function openPendingEdit(partner: BusinessPartner) {
    openEditForm(partner);
    setPendingEditId(null);
  }

  async function init() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      window.location.href = "/login";
      return;
    }

    setUserId(session.user.id);

    const activeMembership = await getMyActiveMembership();
    setMembership(activeMembership);
    setMembershipLoaded(true);

    if (!activeMembership) {
      setLoading(false);
      return;
    }

    setCompanyId(activeMembership.company_id);

    if (!hasFinanceView(activeMembership)) {
      // Bez finance view sú RLS na business_partners aj tak 0 riadkov —
      // vynechávame zbytočný fetch a rovno zobrazíme "Nemáte oprávnenie".
      setLoading(false);
      return;
    }

    await loadPartners(activeMembership.company_id);
  }

  async function loadPartners(activeCompanyId: string) {
    setLoading(true);
    setLoadError("");

    try {
      const rows = await listBusinessPartners(activeCompanyId);
      setPartners(rows);
    } catch (error) {
      console.error("Načítanie obchodných partnerov zlyhalo:", error);
      setLoadError(t("businessPartners.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  const filteredPartners = useMemo(() => {
    const query = search.trim().toLowerCase();

    return partners.filter((partner) => {
      if (kindFilter !== "all" && partner.kind !== kindFilter) {
        return false;
      }

      if (!query) return true;

      return (
        partner.legal_name.toLowerCase().includes(query) ||
        (partner.ico ?? "").toLowerCase().includes(query) ||
        (partner.city ?? "").toLowerCase().includes(query) ||
        (partner.email ?? "").toLowerCase().includes(query)
      );
    });
  }, [partners, search, kindFilter]);

  function openCreateForm() {
    setEditingId(null);
    setForm(EMPTY_BUSINESS_PARTNER_FORM);
    setFormErrors([]);
    setFormSubmitError("");
    setShowForm(true);
  }

  function openEditForm(partner: BusinessPartner) {
    setEditingId(partner.id);
    setForm(businessPartnerToForm(partner));
    setFormErrors([]);
    setFormSubmitError("");
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setFormErrors([]);
    setFormSubmitError("");
  }

  function updateField(field: keyof BusinessPartnerForm, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  function fieldError(field: keyof BusinessPartnerForm): string {
    const found = formErrors.find((error) => error.field === field);
    return found ? t(`businessPartners.errors.${found.messageKey}`) : "";
  }

  /** Chybný stav je okrem rámu vždy aj text pod poľom (§25 — nikdy len farba). */
  function fieldClass(field: keyof BusinessPartnerForm): string {
    return fieldError(field) ? `${docField} border-danger` : docField;
  }

  async function handleSubmit() {
    const { errors, payload } = validateBusinessPartnerForm(form);
    setFormErrors(errors);
    setFormSubmitError("");

    if (errors.length > 0 || !payload) {
      return;
    }

    setSaving(true);

    try {
      if (editingId) {
        const updated = await updateBusinessPartner(editingId, userId, payload);
        setPartners((previous) =>
          previous.map((partner) => (partner.id === editingId ? updated : partner))
        );
      } else {
        const created = await createBusinessPartner(companyId, userId, payload);
        setPartners((previous) => [...previous, created]);
      }

      closeForm();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message === BUSINESS_PARTNER_DUPLICATE_ICO_ERROR) {
        setFormSubmitError(t("businessPartners.errors.duplicateIco"));
      } else {
        setFormSubmitError(t("businessPartners.errors.saveFailedPrefix", { message }));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(partner: BusinessPartner) {
    const confirmed = confirm(
      t("businessPartners.errors.deleteConfirmPrefix", { name: partner.legal_name })
    );

    if (!confirmed) return;

    try {
      await deleteBusinessPartner(partner.id);
      setPartners((previous) => previous.filter((row) => row.id !== partner.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(t("businessPartners.errors.deleteFailedPrefix", { message }));
    }
  }

  function kindLabel(kind: BusinessPartnerKind): string {
    return t(`businessPartners.kind.${kind}`);
  }

  const createDisabled = !canEdit || legalHold;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-6 sm:px-6">
      <Suspense fallback={null}>
        <EditFromQueryParam onEditId={setPendingEditId} />
      </Suspense>

      <BackLink href="/" label={t("nav.dashboard")} className="mb-6" />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BusinessPartnersIcon size={32} />
          <div>
            <h1 className="text-2xl font-bold text-primary">
              {t("businessPartners.title")}
            </h1>
            <p className="text-sm text-secondary">{t("businessPartners.subtitle")}</p>
          </div>
        </div>

        {canView && canEdit && (
          <button
            type="button"
            onClick={openCreateForm}
            disabled={createDisabled}
            className={docButtonPrimary}
          >
            {t("businessPartners.addButton")}
          </button>
        )}
      </div>

      {!canView && membershipLoaded && (
        <p className="mt-3 rounded-doc border border-doc-border bg-surface-2 p-6 text-center text-sm text-secondary">
          {t("businessPartners.noFinanceAccess")}
        </p>
      )}

      {canView && !canEdit && (
        <p className="mt-3 text-sm text-secondary">{t("businessPartners.readOnlyNotice")}</p>
      )}

      {canView && legalHold && canEdit && (
        <p className="mt-3 text-sm font-medium text-warning">
          {t("businessPartners.legalHoldNotice")}
        </p>
      )}

      {canView && (
      <div className="mt-6 flex flex-wrap gap-3">
        <input
          className={`min-w-[240px] flex-1 ${docField}`}
          placeholder={t("businessPartners.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <select
          className={`w-auto ${docField}`}
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value as KindFilter)}
        >
          <option value="all">{t("businessPartners.kind.all")}</option>
          <option value="customer">{t("businessPartners.kind.customer")}</option>
          <option value="supplier">{t("businessPartners.kind.supplier")}</option>
          <option value="both">{t("businessPartners.kind.both")}</option>
        </select>
      </div>
      )}

      {canView && showForm && canEdit && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold text-primary">
            {editingId
              ? t("businessPartners.editFormTitle")
              : t("businessPartners.createFormTitle")}
          </h2>

          {formSubmitError && (
            <div className="mt-3">
              <DocumentNotice tone="critical">{formSubmitError}</DocumentNotice>
            </div>
          )}

          {/* Zoskupené sekcie namiesto jednej plochej mriežky 14 polí.
              Používateľ hľadá „kde sa zadáva IBAN“, nie „ktoré je siedme
              pole“. Poradie sleduje, ako doklad vzniká: kto to je →
              kde sídli → daňové údaje → ako sa platí → ako sa doručuje
              elektronicky. */}
          <div className="mt-5 space-y-4">
            <DocumentSection title={t("businessPartners.section.identity")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <PartnerField label={t("businessPartners.form.kindLabel")}>
                  <select
                    className={docField}
                    value={form.kind}
                    onChange={(event) => updateField("kind", event.target.value)}
                  >
                    <option value="customer">{t("businessPartners.kind.customer")}</option>
                    <option value="supplier">{t("businessPartners.kind.supplier")}</option>
                    <option value="both">{t("businessPartners.kind.both")}</option>
                  </select>
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.legalNameLabel")}
                  error={fieldError("legal_name")}
                >
                  <input
                    className={fieldClass("legal_name")}
                    value={form.legal_name}
                    onChange={(event) => updateField("legal_name", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.emailLabel")} error={fieldError("email")}>
                  <input
                    type="email"
                    className={fieldClass("email")}
                    value={form.email}
                    onChange={(event) => updateField("email", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.phoneLabel")}>
                  <input
                    className={docField}
                    value={form.phone}
                    onChange={(event) => updateField("phone", event.target.value)}
                  />
                </PartnerField>
              </div>
            </DocumentSection>

            <DocumentSection title={t("businessPartners.section.address")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <PartnerField label={t("businessPartners.form.addressLine1Label")} full>
                  <input
                    className={docField}
                    value={form.address_line1}
                    onChange={(event) => updateField("address_line1", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.addressLine2Label")} full>
                  <input
                    className={docField}
                    value={form.address_line2}
                    onChange={(event) => updateField("address_line2", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.cityLabel")}>
                  <input
                    className={docField}
                    value={form.city}
                    onChange={(event) => updateField("city", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.postalCodeLabel")}>
                  <input
                    className={docField}
                    value={form.postal_code}
                    onChange={(event) => updateField("postal_code", event.target.value)}
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.countryCodeLabel")}
                  error={fieldError("country_code")}
                >
                  <input
                    className={fieldClass("country_code")}
                    placeholder="SK"
                    maxLength={2}
                    value={form.country_code}
                    onChange={(event) => updateField("country_code", event.target.value)}
                  />
                </PartnerField>
              </div>
            </DocumentSection>

            {/* Daňové identifikátory. IČO/DIČ/IČ DPH sú lokálne polia, ktoré
                appka nesie historicky; vat_identifier (BT-31/BT-48) a
                legal_registration (BT-30/BT-47) sú ich medzinárodné EN16931
                ekvivalenty. Esblu ich zámerne NESTOTOŽŇUJE automaticky —
                „IČO = legal registration id“ platí na Slovensku, nie
                univerzálne (§14 zadania). */}
            <DocumentSection
              title={t("businessPartners.section.tax")}
              description={t("businessPartners.section.taxHint")}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <PartnerField label={t("businessPartners.form.icoLabel")}>
                  <input
                    className={docField}
                    value={form.ico}
                    onChange={(event) => updateField("ico", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.dicLabel")}>
                  <input
                    className={docField}
                    value={form.dic}
                    onChange={(event) => updateField("dic", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.icDphLabel")}>
                  <input
                    className={docField}
                    value={form.ic_dph}
                    onChange={(event) => updateField("ic_dph", event.target.value)}
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.vatIdentifierLabel")}
                  hint={t("businessPartners.form.vatIdentifierHint")}
                >
                  <input
                    className={docField}
                    value={form.vat_identifier}
                    onChange={(event) => updateField("vat_identifier", event.target.value)}
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.legalRegistrationIdLabel")}
                  error={fieldError("legal_registration_id")}
                >
                  <input
                    className={fieldClass("legal_registration_id")}
                    value={form.legal_registration_id}
                    onChange={(event) =>
                      updateField("legal_registration_id", event.target.value)
                    }
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.legalRegistrationSchemeLabel")}
                  hint={t("businessPartners.form.schemeHint")}
                  error={fieldError("legal_registration_scheme_id")}
                >
                  <input
                    className={fieldClass("legal_registration_scheme_id")}
                    placeholder="0158"
                    value={form.legal_registration_scheme_id}
                    onChange={(event) =>
                      updateField("legal_registration_scheme_id", event.target.value)
                    }
                  />
                </PartnerField>
              </div>
            </DocumentSection>

            <DocumentSection
              title={t("businessPartners.section.payment")}
              description={t("businessPartners.section.paymentHint")}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <PartnerField
                  label={t("businessPartners.form.ibanLabel")}
                  error={fieldError("iban")}
                >
                  <input
                    className={fieldClass("iban")}
                    autoComplete="off"
                    spellCheck={false}
                    value={form.iban}
                    onChange={(event) => updateField("iban", event.target.value)}
                  />
                </PartnerField>

                <PartnerField label={t("businessPartners.form.bicLabel")} error={fieldError("bic")}>
                  <input
                    className={fieldClass("bic")}
                    autoComplete="off"
                    spellCheck={false}
                    value={form.bic}
                    onChange={(event) => updateField("bic", event.target.value)}
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.paymentTermsLabel")}
                  error={fieldError("default_payment_terms_days")}
                >
                  <input
                    className={fieldClass("default_payment_terms_days")}
                    inputMode="numeric"
                    placeholder="14"
                    value={form.default_payment_terms_days}
                    onChange={(event) =>
                      updateField("default_payment_terms_days", event.target.value)
                    }
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.currencyLabel")}
                  error={fieldError("default_currency")}
                >
                  <input
                    className={fieldClass("default_currency")}
                    placeholder="EUR"
                    maxLength={3}
                    value={form.default_currency}
                    onChange={(event) => updateField("default_currency", event.target.value)}
                  />
                </PartnerField>
              </div>
            </DocumentSection>

            {/* eFaktúra — IBA adresácia. Táto úloha zámerne NEIMPLEMENTUJE
                Peppol provider ani XML transport (§ zadania): ukladá sa, kam
                by sa doklad raz doručil, nič sa neodosiela. */}
            <DocumentSection
              title={t("businessPartners.section.einvoice")}
              description={t("businessPartners.section.einvoiceHint")}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <PartnerField
                  label={t("businessPartners.form.electronicAddressLabel")}
                  error={fieldError("electronic_address")}
                >
                  <input
                    className={fieldClass("electronic_address")}
                    autoComplete="off"
                    spellCheck={false}
                    value={form.electronic_address}
                    onChange={(event) => updateField("electronic_address", event.target.value)}
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.electronicAddressSchemeLabel")}
                  hint={t("businessPartners.form.schemeHint")}
                  error={fieldError("electronic_address_scheme_id")}
                >
                  <input
                    className={fieldClass("electronic_address_scheme_id")}
                    placeholder="0088"
                    value={form.electronic_address_scheme_id}
                    onChange={(event) =>
                      updateField("electronic_address_scheme_id", event.target.value)
                    }
                  />
                </PartnerField>

                <PartnerField
                  label={t("businessPartners.form.peppolLabel")}
                  hint={t("businessPartners.form.peppolHint")}
                  full
                >
                  <input
                    className={docField}
                    autoComplete="off"
                    spellCheck={false}
                    value={form.peppol_identifier}
                    onChange={(event) => updateField("peppol_identifier", event.target.value)}
                  />
                </PartnerField>
              </div>
            </DocumentSection>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={closeForm}
              disabled={saving}
              className={docButtonSecondary}
            >
              {t("businessPartners.form.cancelButton")}
            </button>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className={docButtonPrimary}
            >
              {saving
                ? t("businessPartners.form.saving")
                : t("businessPartners.form.saveButton")}
            </button>
          </div>
        </div>
      )}

      {canView && (
      <div className="mt-6">
        {loading ? (
          <p className="text-sm text-secondary">{t("businessPartners.loading")}</p>
        ) : loadError ? (
          <p className="text-sm font-medium text-danger">{loadError}</p>
        ) : filteredPartners.length === 0 ? (
          <p className="rounded-doc border border-dashed border-doc-border bg-surface-2 p-6 text-center text-sm text-secondary">
            {t("businessPartners.empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {filteredPartners.map((partner) => (
              <li
                key={partner.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-doc border border-doc-border bg-doc-surface p-4 transition hover:bg-doc-surface-hover"
              >
                <Link
                  href={`/obchodni-partneri/${partner.id}`}
                  className="min-w-0 flex-1"
                >
                  <p className="truncate font-semibold text-primary">{partner.legal_name}</p>
                  <p className="mt-0.5 text-xs text-muted-esblu">
                    {kindLabel(partner.kind)}
                    {partner.ico ? ` · IČO ${partner.ico}` : ""}
                    {partner.city ? ` · ${partner.city}` : ""}
                  </p>
                </Link>

                {canEdit && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => openEditForm(partner)}
                      className={docButtonSecondary}
                    >
                      {t("common.buttons.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(partner)}
                      className={docButtonDanger}
                    >
                      {t("common.buttons.delete")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      )}
    </div>
  );
}
