"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import {
  DocumentPageShell,
  DocumentHeader,
  docButtonPrimary,
  docButtonSecondary,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";
import {
  getMyActiveMembership,
  hasFinanceManage,
  hasFinanceView,
  type MyActiveMembership,
} from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { invoiceDetailHref } from "@/lib/entity-links";
import {
  computeDueDateFromTerms,
  computePaymentTermsDaysFromDueDate,
  createDraftInvoice,
  getInvoice,
  type InvoiceKind,
} from "@/lib/invoices";
import { listBusinessPartners, type BusinessPartner } from "@/lib/business-partners";
import { todayLocalDate } from "@/lib/local-date";

// Dobropis/ťarchopis sa zakladá z detailu opravovanej faktúry
// ("Vytvoriť dobropis" tlačidlo v InvoiceDetailView) s ?corrects=<id> —
// rovnaký izolovaný Suspense-wrapped vzor ako EditFromQueryParam v
// app/obchodni-partneri/page.tsx, aby useSearchParams() nezablokoval
// vykreslenie zvyšku formulára.
function CorrectsFromQueryParam({ onCorrectsId }: { onCorrectsId: (id: string) => void }) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const correctsId = searchParams.get("corrects");
    if (correctsId) onCorrectsId(correctsId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return null;
}

// Kalendárny deň POUŽÍVATEĽA, nie UTC. `toISOString()` tu predtým o polnoci
// stredoeurópskeho času predvyplnil včerajšok — pozri lib/local-date.ts.
const TODAY = todayLocalDate();

export default function NewInvoicePage() {
  const router = useRouter();
  const { t } = useLocale();
  const { legalHold } = useCompanyDpaLegalHold();

  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [membership, setMembership] = useState<MyActiveMembership | null>(null);
  const [membershipLoaded, setMembershipLoaded] = useState(false);
  const canEdit = hasFinanceManage(membership);

  const [partners, setPartners] = useState<BusinessPartner[]>([]);

  const [kind, setKind] = useState<InvoiceKind>("regular_invoice");
  const [correctsInvoiceId, setCorrectsInvoiceId] = useState<string | null>(null);
  const [correctsInvoiceNumber, setCorrectsInvoiceNumber] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [issueDate, setIssueDate] = useState(TODAY);
  const [dueDate, setDueDate] = useState("");
  const [variableSymbol, setVariableSymbol] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("14");
  const [currency, setCurrency] = useState("EUR");

  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    void init();
  }, []);

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

    if (!activeMembership) return;

    // Bez finance view sa stránka ďalej vôbec nenačítava. Doteraz tu bola
    // iba premenná canEdit, takže zamestnanec síce nemohol uložiť, ale
    // zoznam obchodných partnerov sa mu aj tak stiahol.
    if (!hasFinanceView(activeMembership)) return;

    setCompanyId(activeMembership.company_id);

    try {
      const rows = await listBusinessPartners(activeMembership.company_id);
      setPartners(rows);
    } catch (error) {
      console.error("Načítanie obchodných partnerov zlyhalo:", error);
    }
  }

  async function handleCorrectsId(id: string) {
    setCorrectsInvoiceId(id);
    setKind("credit_note");

    try {
      const original = await getInvoice(id);
      if (original) {
        setCorrectsInvoiceNumber(original.invoice_number);
        if (original.customer_business_partner_id) {
          setCustomerId(original.customer_business_partner_id);
        }
        setCurrency(original.currency);
      }
    } catch (error) {
      console.error("Načítanie opravovanej faktúry zlyhalo:", error);
    }
  }

  // -----------------------------------------------------------------------------
  // Obojsmerná synchronizácia issue_date / payment_terms_days / due_date
  // (Model B, podľa zadania): zmena dní ALEBO dátumu vystavenia prepočíta
  // dátum splatnosti; zmena dátumu splatnosti prepočíta počet dní. Nikdy sa
  // nenecháva stav, kde by tieto tri hodnoty mohli byť navzájom nekonzistentné.
  // -----------------------------------------------------------------------------

  function handleIssueDateChange(value: string) {
    setIssueDate(value);
    const parsedDays = Number(paymentTermsDays);
    if (Number.isFinite(parsedDays) && parsedDays >= 0) {
      const due = computeDueDateFromTerms(value, parsedDays);
      if (due) setDueDate(due);
    }
  }

  function handlePaymentTermsDaysChange(days: string) {
    setPaymentTermsDays(days);
    const parsedDays = Number(days);
    if (Number.isFinite(parsedDays) && parsedDays >= 0) {
      const due = computeDueDateFromTerms(issueDate, parsedDays);
      if (due) setDueDate(due);
    }
  }

  function handleDueDateChange(value: string) {
    setDueDate(value);
    const days = computePaymentTermsDaysFromDueDate(issueDate, value);
    if (days !== null) setPaymentTermsDays(String(days));
  }

  async function handleSubmit() {
    setSubmitError("");

    if (!customerId) {
      setSubmitError(t("invoices.errors.missingBusinessPartner"));
      return;
    }

    setSaving(true);

    try {
      const parsedTerms = Number(paymentTermsDays);
      const created = await createDraftInvoice(companyId, userId, {
        direction: "issued",
        kind,
        currency,
        issue_date: issueDate,
        due_date: dueDate || null,
        customer_business_partner_id: customerId,
        variable_symbol: variableSymbol.trim() || null,
        payment_terms_days: Number.isFinite(parsedTerms) ? parsedTerms : null,
        corrects_invoice_id: correctsInvoiceId,
      });

      router.push(invoiceDetailHref(created.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubmitError(t("invoices.errors.saveFailedPrefix", { message }));
    } finally {
      setSaving(false);
    }
  }

  const createDisabled = !canEdit || legalHold || saving;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-6 sm:px-6">
      <Suspense fallback={null}>
        <CorrectsFromQueryParam onCorrectsId={handleCorrectsId} />
      </Suspense>

      <BackLink href="/faktury" label={t("invoices.backToList")} className="mb-6" />

      <h1 className="text-2xl font-bold text-primary">{t("invoices.newInvoice.title")}</h1>

      {membershipLoaded && !canEdit && (
        <p className="mt-3 rounded-2xl border border-subtle bg-surface-1 p-6 text-center text-secondary">
          {t("invoices.noFinanceAccess")}
        </p>
      )}

      {legalHold && canEdit && (
        <p className="mt-3 text-sm font-semibold text-amber-600">
          {t("invoices.legalHoldNotice")}
        </p>
      )}

      {canEdit && (
        <div className="mt-6 space-y-4 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5">
          {submitError && (
            <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              {submitError}
            </p>
          )}

          {correctsInvoiceId && (
            <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {t("invoices.newInvoice.correctsInvoiceLabel")}:{" "}
              {correctsInvoiceNumber ?? correctsInvoiceId}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {!correctsInvoiceId && (
              <div>
                <label className={docLabel}>
                  {t("invoices.newInvoice.kindLabel")}
                </label>
                <select
                  className={docField}
                  value={kind}
                  onChange={(event) => setKind(event.target.value as InvoiceKind)}
                >
                  <option value="regular_invoice">{t("invoices.kind.regular_invoice")}</option>
                  <option value="payment_received_invoice">
                    {t("invoices.kind.payment_received_invoice")}
                  </option>
                </select>
              </div>
            )}

            <div>
              <label className={docLabel}>
                {t("invoices.newInvoice.businessPartnerLabel")}
              </label>
              {partners.length === 0 ? (
                <p className="text-sm text-secondary">
                  {t("invoices.newInvoice.businessPartnerEmptyNotice")}
                </p>
              ) : (
                <select
                  className={docField}
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                >
                  <option value="">{t("invoices.newInvoice.businessPartnerPlaceholder")}</option>
                  {partners.map((partner) => (
                    <option key={partner.id} value={partner.id}>
                      {partner.legal_name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className={docLabel}>
                {t("invoices.newInvoice.issueDateLabel")}
              </label>
              <input
                type="date"
                className={docField}
                value={issueDate}
                onChange={(event) => handleIssueDateChange(event.target.value)}
              />
            </div>

            <div>
              <label className={docLabel}>
                {t("invoices.newInvoice.paymentTermsDaysLabel")}
              </label>
              <input
                className={docField}
                value={paymentTermsDays}
                onChange={(event) => handlePaymentTermsDaysChange(event.target.value)}
              />
            </div>

            <div>
              <label className={docLabel}>
                {t("invoices.newInvoice.dueDateLabel")}
              </label>
              <input
                type="date"
                className={docField}
                value={dueDate}
                onChange={(event) => handleDueDateChange(event.target.value)}
              />
            </div>

            <div>
              <label className={docLabel}>
                {t("invoices.newInvoice.currencyLabel")}
              </label>
              <input
                className={docField}
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
            </div>

            <div>
              <label className={docLabel}>
                {t("invoices.newInvoice.variableSymbolLabel")}
              </label>
              <input
                className={docField}
                value={variableSymbol}
                onChange={(event) => setVariableSymbol(event.target.value)}
              />
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={createDisabled}
              className={docButtonPrimary}
            >
              {saving
                ? t("invoices.newInvoice.saving")
                : t("invoices.newInvoice.saveDraftButton")}
            </button>

            <button
              type="button"
              onClick={() => router.push("/faktury")}
              disabled={saving}
              className={docButtonSecondary}
            >
              {t("invoices.newInvoice.cancelButton")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
