"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import {
  getMyActiveMembership,
  hasFinanceManage,
  hasFinanceView,
  type MyActiveMembership,
} from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDateTime } from "@/lib/i18n/format";
import {
  deleteBusinessPartner,
  getBusinessPartner,
  type BusinessPartner,
} from "@/lib/business-partners";
import {
  DocumentPageShell,
  DocumentHeader,
  DocumentSection,
  DocumentMetadataGrid,
  DocumentNotice,
  docButtonSecondary,
  docButtonDanger,
} from "@/app/components/document/DocumentLayout";

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

    // Explicitný view gate. RLS by síce vrátila null, ale spoliehať sa na
    // to znamená poslať dotaz, ktorý sa nemal nikdy odoslať.
    if (!hasFinanceView(activeMembership)) {
      setLoadError(t("businessPartners.noFinanceAccess"));
      setLoading(false);
      return;
    }

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

  // Adresa sa zobrazuje ako jeden blok, nie ako päť samostatných riadkov —
  // používateľ ju číta ako adresu, nie ako päť nesúvisiacich polí.
  const addressLines = partner
    ? [
        partner.address_line1,
        partner.address_line2,
        [partner.postal_code, partner.city].filter(Boolean).join(" "),
        partner.country_code,
      ].filter((line): line is string => Boolean(line && line.trim()))
    : [];

  return (
    <DocumentPageShell>
      <BackLink href="/obchodni-partneri" label={t("businessPartners.title")} className="mb-6" />

      {loading ? (
        <p className="text-sm text-secondary">{t("businessPartners.loading")}</p>
      ) : loadError || !partner ? (
        <DocumentNotice tone="critical">
          {loadError || t("businessPartners.errors.notFound")}
        </DocumentNotice>
      ) : (
        <>
          <DocumentHeader
            eyebrow={t(`businessPartners.kind.${partner.kind}`)}
            title={partner.legal_name}
            meta={
              <>
                {t("businessPartners.updatedAtPrefix")}{" "}
                {partner.updated_at
                  ? formatDateTime(partner.updated_at, locale)
                  : formatDateTime(partner.created_at, locale)}
              </>
            }
            aside={
              canEdit ? (
                <div className="flex gap-2">
                  <Link
                    href={`/obchodni-partneri?edit=${partner.id}`}
                    className={docButtonSecondary}
                  >
                    {t("common.buttons.edit")}
                  </Link>
                  <button type="button" onClick={handleDelete} className={docButtonDanger}>
                    {t("common.buttons.delete")}
                  </button>
                </div>
              ) : null
            }
          />

          {/* Rovnaké zoskupenie ako editačný formulár — používateľ nájde
              údaj na tom istom mieste, kde ho zadával. DocumentMetadataGrid
              si prázdne hodnoty odfiltruje sám, takže partner bez IBAN-u
              nedostane prázdnu sekciu s pomlčkami. */}
          <div className="mt-6 space-y-4">
            <DocumentSection title={t("businessPartners.section.identity")}>
              <DocumentMetadataGrid
                items={[
                  { label: t("businessPartners.form.emailLabel"), value: partner.email },
                  { label: t("businessPartners.form.phoneLabel"), value: partner.phone },
                ]}
              />
            </DocumentSection>

            {addressLines.length > 0 && (
              <DocumentSection title={t("businessPartners.section.address")}>
                <div className="space-y-0.5 text-sm text-primary">
                  {addressLines.map((line, index) => (
                    <p key={index}>{line}</p>
                  ))}
                </div>
              </DocumentSection>
            )}

            <DocumentSection title={t("businessPartners.section.tax")}>
              <DocumentMetadataGrid
                items={[
                  { label: t("businessPartners.form.icoLabel"), value: partner.ico },
                  { label: t("businessPartners.form.dicLabel"), value: partner.dic },
                  { label: t("businessPartners.form.icDphLabel"), value: partner.ic_dph },
                  {
                    label: t("businessPartners.form.vatIdentifierLabel"),
                    value: partner.vat_identifier ?? null,
                  },
                  {
                    label: t("businessPartners.form.legalRegistrationIdLabel"),
                    // Schéma sa zobrazuje pri hodnote, nie ako samostatný
                    // riadok — "0158" bez kontextu nikomu nič nepovie.
                    value: partner.legal_registration_id
                      ? partner.legal_registration_scheme_id
                        ? `${partner.legal_registration_id} (${partner.legal_registration_scheme_id})`
                        : partner.legal_registration_id
                      : null,
                  },
                ]}
              />
            </DocumentSection>

            <DocumentSection title={t("businessPartners.section.payment")}>
              <DocumentMetadataGrid
                items={[
                  { label: t("businessPartners.form.ibanLabel"), value: partner.iban ?? null },
                  { label: t("businessPartners.form.bicLabel"), value: partner.bic ?? null },
                  {
                    label: t("businessPartners.form.paymentTermsLabel"),
                    value:
                      partner.default_payment_terms_days === null
                        ? null
                        : String(partner.default_payment_terms_days),
                  },
                  {
                    label: t("businessPartners.form.currencyLabel"),
                    value: partner.default_currency,
                  },
                ]}
              />
            </DocumentSection>

            <DocumentSection
              title={t("businessPartners.section.einvoice")}
              description={t("businessPartners.section.einvoiceHint")}
            >
              <DocumentMetadataGrid
                items={[
                  {
                    label: t("businessPartners.form.electronicAddressLabel"),
                    value: partner.electronic_address
                      ? partner.electronic_address_scheme_id
                        ? `${partner.electronic_address} (${partner.electronic_address_scheme_id})`
                        : partner.electronic_address
                      : null,
                  },
                  {
                    label: t("businessPartners.form.peppolLabel"),
                    value: partner.peppol_identifier,
                  },
                ]}
              />
              {!partner.electronic_address && !partner.peppol_identifier && (
                <p className="text-sm text-muted-esblu">
                  {t("businessPartners.section.einvoiceEmpty")}
                </p>
              )}
            </DocumentSection>
          </div>
        </>
      )}
    </DocumentPageShell>
  );
}
