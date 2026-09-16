"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import { getMyActiveMembership, hasFinanceManage, type MyActiveMembership } from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDateTime } from "@/lib/i18n/format";
import {
  deleteBusinessPartner,
  getBusinessPartner,
  type BusinessPartner,
} from "@/lib/business-partners";

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;

  return (
    <div className="border-b border-subtle py-3 last:border-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-secondary">{label}</p>
      <p className="mt-1 text-primary">{value}</p>
    </div>
  );
}

export default function ObchodnyPartnerDetailPage() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { id } = useParams();
  const partnerId = String(id);

  // Finance Access Hardening — canEdit teraz vychádza z finance manage
  // (owner vždy, inak iba explicitné permissions.finance.manage), nie
  // z role==='admin'. Bez finance VIEW vráti RLS pre tohto partnera 0
  // riadkov (getBusinessPartner → null) — appka to zámerne nerozlišuje od
  // "neexistuje" (pozri komentár nižšie), takže tu netreba samostatný
  // "no permission" stav.
  const [membership, setMembership] = useState<MyActiveMembership | null>(null);
  const [partner, setPartner] = useState<BusinessPartner | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Rovnaký "mount effect volá async handler" vzor ako checkUser() v
  // app/nastavenia/page.tsx a app/components/Dashboard.tsx (existujúci,
  // zdokumentovaný pre-existing ESLint finding v oboch — pozri finálny
  // report Fázy 1B; nemeníme mimo scope tejto úlohy).
  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  async function init() {
    setLoading(true);
    setLoadError("");

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      window.location.href = "/login";
      return;
    }

    const activeMembership = await getMyActiveMembership();
    setMembership(activeMembership);

    try {
      const row = await getBusinessPartner(partnerId);
      // RLS (business_partners_select_company) vráti null aj pre partnera
      // z cudzej firmy — appka to nerozlišuje od "neexistuje", aby
      // nepriznala existenciu cudzieho záznamu (rovnaký princíp ako inde v
      // appke, napr. stroje/vozidlá detail).
      setPartner(row);

      if (!row) {
        setLoadError(t("businessPartners.errors.notFound"));
      }
    } catch (error) {
      console.error("Načítanie obchodného partnera zlyhalo:", error);
      setLoadError(t("businessPartners.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!partner) return;

    const confirmed = confirm(
      t("businessPartners.errors.deleteConfirmPrefix", { name: partner.legal_name })
    );

    if (!confirmed) return;

    try {
      await deleteBusinessPartner(partner.id);
      router.push("/obchodni-partneri");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(t("businessPartners.errors.deleteFailedPrefix", { message }));
    }
  }

  const canEdit = hasFinanceManage(membership);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-6 sm:px-6">
      <BackLink href="/obchodni-partneri" label={t("businessPartners.title")} className="mb-6" />

      {loading ? (
        <p className="text-sm text-secondary">{t("businessPartners.loading")}</p>
      ) : loadError || !partner ? (
        <p className="text-sm font-semibold text-red-600">
          {loadError || t("businessPartners.errors.notFound")}
        </p>
      ) : (
        <div className="rounded-3xl border border-subtle bg-surface-1 p-6 shadow-lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-primary">{partner.legal_name}</h1>
              <p className="text-sm text-secondary">
                {t(`businessPartners.kind.${partner.kind}`)}
              </p>
            </div>

            {canEdit && (
              <div className="flex gap-2">
                <Link
                  href={`/obchodni-partneri?edit=${partner.id}`}
                  className="rounded-xl border px-4 py-2 text-sm font-semibold"
                >
                  {t("common.buttons.edit")}
                </Link>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
                >
                  {t("common.buttons.delete")}
                </button>
              </div>
            )}
          </div>

          <div className="mt-6">
            <DetailRow label={t("businessPartners.form.icoLabel")} value={partner.ico ?? ""} />
            <DetailRow label={t("businessPartners.form.dicLabel")} value={partner.dic ?? ""} />
            <DetailRow
              label={t("businessPartners.form.icDphLabel")}
              value={partner.ic_dph ?? ""}
            />
            <DetailRow
              label={t("businessPartners.form.emailLabel")}
              value={partner.email ?? ""}
            />
            <DetailRow
              label={t("businessPartners.form.phoneLabel")}
              value={partner.phone ?? ""}
            />
            <DetailRow
              label={t("businessPartners.form.addressLine1Label")}
              value={partner.address_line1 ?? ""}
            />
            <DetailRow
              label={t("businessPartners.form.addressLine2Label")}
              value={partner.address_line2 ?? ""}
            />
            <DetailRow label={t("businessPartners.form.cityLabel")} value={partner.city ?? ""} />
            <DetailRow
              label={t("businessPartners.form.postalCodeLabel")}
              value={partner.postal_code ?? ""}
            />
            <DetailRow
              label={t("businessPartners.form.countryCodeLabel")}
              value={partner.country_code ?? ""}
            />
            <DetailRow
              label={t("businessPartners.form.peppolLabel")}
              value={partner.peppol_identifier ?? ""}
            />
            <DetailRow
              label={t("businessPartners.form.paymentTermsLabel")}
              value={
                partner.default_payment_terms_days === null
                  ? ""
                  : String(partner.default_payment_terms_days)
              }
            />
            <DetailRow
              label={t("businessPartners.form.currencyLabel")}
              value={partner.default_currency ?? ""}
            />
          </div>

          <p className="mt-4 text-xs text-secondary">
            {t("businessPartners.updatedAtPrefix")}{" "}
            {partner.updated_at
              ? formatDateTime(partner.updated_at, locale)
              : formatDateTime(partner.created_at, locale)}
          </p>
        </div>
      )}
    </div>
  );
}
