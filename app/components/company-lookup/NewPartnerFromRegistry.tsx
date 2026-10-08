"use client";

import { useId, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  DocumentNotice,
  docButtonPrimary,
  docButtonSecondary,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";
import CompanyLookupCombobox from "@/app/components/company-lookup/CompanyLookupCombobox";
import CompanyRegistryNotice from "@/app/components/company-lookup/CompanyRegistryNotice";
import {
  BUSINESS_PARTNER_DUPLICATE_ICO_ERROR,
  EMPTY_BUSINESS_PARTNER_FORM,
  createBusinessPartner,
  validateBusinessPartnerForm,
  type BusinessPartner,
  type BusinessPartnerForm,
  type BusinessPartnerValidationError,
} from "@/lib/business-partners";
import { applyCompanyDetailToForm, findPartnerWithIco } from "@/lib/company-lookup/prefill";
import { canonicalIco } from "@/lib/company-lookup/normalize";
import type { CompanyDetailResponseBody } from "@/lib/company-lookup/types";
import { type MutationKeyRef } from "@/lib/idempotent-insert";

// Idempotency kľúč pre retry toho istého vytvorenia (lib/idempotent-insert.ts).
const REGISTRY_PARTNER_MUTATION: MutationKeyRef = { current: null };

// =============================================================================
// "+ Nový partner z registra" pri vystavovaní faktúry.
// =============================================================================
// Vyhľadanie → predvyplnené, editovateľné polia → človek potvrdí "Vytvoriť
// partnera a vybrať". Ukladá sa EXISTUJÚCOU cestou (validateBusinessPartner
// Form + createBusinessPartner → RLS business_partners_insert_finance).
// Duplicitné IČO: najprv deterministická kontrola voči načítaným partnerom
// (kanonické IČO), potom DB unique constraint (ESBLU_DUPLICATE_ICO) — v oboch
// prípadoch sa ponúkne výber existujúceho, nikdy tichý druhý záznam.
// Ručné vyplnenie bez registra ostáva možné.
// =============================================================================

type Field = "legal_name" | "ico" | "dic" | "ic_dph" | "address_line1" | "city" | "postal_code" | "country_code";

const FIELDS: { field: Field; labelKey: string; full?: boolean }[] = [
  { field: "legal_name", labelKey: "businessPartners.form.legalNameLabel", full: true },
  { field: "ico", labelKey: "businessPartners.form.icoLabel" },
  { field: "dic", labelKey: "businessPartners.form.dicLabel" },
  { field: "ic_dph", labelKey: "businessPartners.form.icDphLabel" },
  { field: "address_line1", labelKey: "businessPartners.form.addressLine1Label", full: true },
  { field: "city", labelKey: "businessPartners.form.cityLabel" },
  { field: "postal_code", labelKey: "businessPartners.form.postalCodeLabel" },
  { field: "country_code", labelKey: "businessPartners.form.countryCodeLabel" },
];

export default function NewPartnerFromRegistry({
  companyId,
  userId,
  partners,
  disabled = false,
  onCreated,
  onSelectExisting,
  onCancel,
}: {
  companyId: string;
  userId: string;
  partners: BusinessPartner[];
  disabled?: boolean;
  onCreated: (partner: BusinessPartner) => void;
  onSelectExisting: (partner: BusinessPartner) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const baseId = useId();
  const [form, setForm] = useState<BusinessPartnerForm>({ ...EMPTY_BUSINESS_PARTNER_FORM, kind: "customer" });
  const [detail, setDetail] = useState<CompanyDetailResponseBody | null>(null);
  const [errors, setErrors] = useState<BusinessPartnerValidationError[]>([]);
  const [submitError, setSubmitError] = useState("");
  const [confirmTerminated, setConfirmTerminated] = useState(false);
  const [saving, setSaving] = useState(false);

  const existing = findPartnerWithIco(partners, form.ico);
  const detailMatchesForm = detail !== null && canonicalIco(form.ico) === detail.company.ico;
  const terminated = detailMatchesForm && detail?.company.status === "terminated";
  const createDisabled = disabled || saving || existing !== null || (terminated && !confirmTerminated);

  function handleSelect(next: CompanyDetailResponseBody) {
    setForm((previous) => applyCompanyDetailToForm(previous, next.company));
    setDetail(next);
    setErrors([]);
    setSubmitError("");
    setConfirmTerminated(false);
  }

  function update(field: Field, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  async function handleCreate() {
    setSubmitError("");
    const { errors: validationErrors, payload } = validateBusinessPartnerForm(form);
    setErrors(validationErrors);
    if (validationErrors.length > 0 || !payload) return;
    if (findPartnerWithIco(partners, form.ico)) return;

    setSaving(true);
    try {
      const created = await createBusinessPartner(companyId, userId, payload, { mutationRef: REGISTRY_PARTNER_MUTATION });
      onCreated(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubmitError(
        message === BUSINESS_PARTNER_DUPLICATE_ICO_ERROR
          ? t("businessPartners.errors.duplicateIco")
          : t("companyLookup.invoice.createFailed", { message })
      );
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (field: Field) => {
    const found = errors.find((error) => error.field === field);
    return found ? t(`businessPartners.errors.${found.messageKey}`) : "";
  };

  return (
    <div className="space-y-3 rounded-doc border border-doc-border bg-surface-2 p-4">
      <p className="text-sm font-semibold text-primary">{t("companyLookup.invoice.panelTitle")}</p>

      <CompanyLookupCombobox onSelect={handleSelect} disabled={disabled || saving} autoFocus />

      {detailMatchesForm && detail && <CompanyRegistryNotice detail={detail} />}

      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map(({ field, labelKey, full }) => {
          const id = `${baseId}-${field}`;
          const error = fieldError(field);
          return (
            <div key={field} className={full ? "sm:col-span-2" : undefined}>
              <label className={docLabel} htmlFor={id}>
                {t(labelKey)}
              </label>
              <input
                id={id}
                className={error ? `${docField} border-danger` : docField}
                value={form[field]}
                maxLength={field === "country_code" ? 2 : undefined}
                disabled={disabled || saving}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(event) => update(field, event.target.value)}
              />
              {error && (
                <p id={`${id}-error`} className="mt-1 text-xs font-medium text-danger">
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {existing && (
        <DocumentNotice tone="warning">
          <p>{t("companyLookup.existingPartner", { name: existing.legal_name })}</p>
          <button type="button" className={`${docButtonSecondary} mt-2`} onClick={() => onSelectExisting(existing)}>
            {t("companyLookup.selectExisting")}
          </button>
        </DocumentNotice>
      )}

      {terminated && (
        <label className="flex items-start gap-2 text-sm text-primary">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmTerminated}
            onChange={(event) => setConfirmTerminated(event.target.checked)}
          />
          <span>{t("companyLookup.invoice.confirmTerminated")}</span>
        </label>
      )}

      {submitError && <DocumentNotice tone="critical">{submitError}</DocumentNotice>}

      <div className="flex flex-wrap gap-3">
        <button type="button" className={docButtonPrimary} disabled={createDisabled} onClick={handleCreate}>
          {saving ? t("companyLookup.invoice.creating") : t("companyLookup.invoice.createAndSelect")}
        </button>
        <button type="button" className={docButtonSecondary} disabled={saving} onClick={onCancel}>
          {t("companyLookup.invoice.cancel")}
        </button>
      </div>
    </div>
  );
}
