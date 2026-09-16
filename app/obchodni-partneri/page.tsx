"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import {
  getMyActiveMembership,
  isOwnerOrAdmin,
  type CompanyMemberRole,
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

type KindFilter = "all" | BusinessPartnerKind;

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
  const [myRole, setMyRole] = useState<CompanyMemberRole | null>(null);
  const canEdit = isOwnerOrAdmin(myRole);

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

    const membership = await getMyActiveMembership();

    if (!membership) {
      setLoading(false);
      return;
    }

    setCompanyId(membership.company_id);
    setMyRole(membership.role);

    await loadPartners(membership.company_id);
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

        {canEdit && (
          <button
            type="button"
            onClick={openCreateForm}
            disabled={createDisabled}
            className="rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
          >
            {t("businessPartners.addButton")}
          </button>
        )}
      </div>

      {!canEdit && myRole && (
        <p className="mt-3 text-sm text-secondary">{t("businessPartners.readOnlyNotice")}</p>
      )}

      {legalHold && canEdit && (
        <p className="mt-3 text-sm font-semibold text-amber-600">
          {t("businessPartners.legalHoldNotice")}
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <input
          className="min-w-[240px] flex-1 rounded-xl border p-3"
          placeholder={t("businessPartners.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <select
          className="rounded-xl border p-3"
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value as KindFilter)}
        >
          <option value="all">{t("businessPartners.kind.all")}</option>
          <option value="customer">{t("businessPartners.kind.customer")}</option>
          <option value="supplier">{t("businessPartners.kind.supplier")}</option>
          <option value="both">{t("businessPartners.kind.both")}</option>
        </select>
      </div>

      {showForm && canEdit && (
        <div className="mt-6 rounded-3xl border border-subtle bg-surface-1 p-6 shadow-lg">
          <h2 className="text-lg font-bold text-primary">
            {editingId
              ? t("businessPartners.editFormTitle")
              : t("businessPartners.createFormTitle")}
          </h2>

          {formSubmitError && (
            <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              {formSubmitError}
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.kindLabel")}
              </label>
              <select
                className="w-full rounded-xl border p-3"
                value={form.kind}
                onChange={(event) => updateField("kind", event.target.value)}
              >
                <option value="customer">{t("businessPartners.kind.customer")}</option>
                <option value="supplier">{t("businessPartners.kind.supplier")}</option>
                <option value="both">{t("businessPartners.kind.both")}</option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.legalNameLabel")}
              </label>
              <input
                className={`w-full rounded-xl border p-3 ${fieldError("legal_name") ? "border-red-500" : ""}`}
                value={form.legal_name}
                onChange={(event) => updateField("legal_name", event.target.value)}
              />
              {fieldError("legal_name") && (
                <p className="mt-1 text-xs font-semibold text-red-600">
                  {fieldError("legal_name")}
                </p>
              )}
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.icoLabel")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.ico}
                onChange={(event) => updateField("ico", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.dicLabel")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.dic}
                onChange={(event) => updateField("dic", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.icDphLabel")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.ic_dph}
                onChange={(event) => updateField("ic_dph", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.emailLabel")}
              </label>
              <input
                type="email"
                className={`w-full rounded-xl border p-3 ${fieldError("email") ? "border-red-500" : ""}`}
                value={form.email}
                onChange={(event) => updateField("email", event.target.value)}
              />
              {fieldError("email") && (
                <p className="mt-1 text-xs font-semibold text-red-600">{fieldError("email")}</p>
              )}
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.phoneLabel")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.phone}
                onChange={(event) => updateField("phone", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.addressLine1Label")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.address_line1}
                onChange={(event) => updateField("address_line1", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.addressLine2Label")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.address_line2}
                onChange={(event) => updateField("address_line2", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.cityLabel")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.city}
                onChange={(event) => updateField("city", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.postalCodeLabel")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.postal_code}
                onChange={(event) => updateField("postal_code", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.countryCodeLabel")}
              </label>
              <input
                className={`w-full rounded-xl border p-3 ${fieldError("country_code") ? "border-red-500" : ""}`}
                placeholder="SK"
                value={form.country_code}
                onChange={(event) => updateField("country_code", event.target.value)}
              />
              {fieldError("country_code") && (
                <p className="mt-1 text-xs font-semibold text-red-600">
                  {fieldError("country_code")}
                </p>
              )}
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.peppolLabel")}
              </label>
              <input
                className="w-full rounded-xl border p-3"
                value={form.peppol_identifier}
                onChange={(event) => updateField("peppol_identifier", event.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.paymentTermsLabel")}
              </label>
              <input
                className={`w-full rounded-xl border p-3 ${fieldError("default_payment_terms_days") ? "border-red-500" : ""}`}
                placeholder="14"
                value={form.default_payment_terms_days}
                onChange={(event) =>
                  updateField("default_payment_terms_days", event.target.value)
                }
              />
              {fieldError("default_payment_terms_days") && (
                <p className="mt-1 text-xs font-semibold text-red-600">
                  {fieldError("default_payment_terms_days")}
                </p>
              )}
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                {t("businessPartners.form.currencyLabel")}
              </label>
              <input
                className={`w-full rounded-xl border p-3 ${fieldError("default_currency") ? "border-red-500" : ""}`}
                placeholder="EUR"
                value={form.default_currency}
                onChange={(event) => updateField("default_currency", event.target.value)}
              />
              {fieldError("default_currency") && (
                <p className="mt-1 text-xs font-semibold text-red-600">
                  {fieldError("default_currency")}
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className="rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
            >
              {saving
                ? t("businessPartners.form.saving")
                : t("businessPartners.form.saveButton")}
            </button>

            <button
              type="button"
              onClick={closeForm}
              disabled={saving}
              className="rounded-xl border px-6 py-3 font-semibold"
            >
              {t("businessPartners.form.cancelButton")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-6">
        {loading ? (
          <p className="text-sm text-secondary">{t("businessPartners.loading")}</p>
        ) : loadError ? (
          <p className="text-sm font-semibold text-red-600">{loadError}</p>
        ) : filteredPartners.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-400 bg-surface-1 p-6 text-center text-secondary">
            {t("businessPartners.empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {filteredPartners.map((partner) => (
              <li
                key={partner.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-subtle bg-surface-1 p-4"
              >
                <Link
                  href={`/obchodni-partneri/${partner.id}`}
                  className="min-w-0 flex-1"
                >
                  <p className="truncate font-semibold text-primary">{partner.legal_name}</p>
                  <p className="text-xs text-secondary">
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
                      className="rounded-xl border px-4 py-2 text-sm font-semibold"
                    >
                      {t("common.buttons.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(partner)}
                      className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
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
    </div>
  );
}
