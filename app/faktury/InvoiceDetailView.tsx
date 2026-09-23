"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import {
  getMyActiveMembership,
  hasFinanceManage,
  hasFinanceView,
  type MyActiveMembership,
} from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import {
  listAccountingStates,
  setAccountingStatus as saveAccountingStatus,
} from "@/lib/invoicing/accounting-state";
import type { AccountingStatus } from "@/lib/invoicing/accounting-lifecycle";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import {
  addInvoicePayment,
  computeDueDateFromTerms,
  computePaymentTermsDaysFromDueDate,
  deleteDraftInvoice,
  finalizeInvoice,
  findUnresolvedVatRateErrors,
  getInvoice,
  listInvoiceItems,
  listInvoiceParties,
  listInvoicePayments,
  listInvoiceTaxBreakdowns,
  isInvoiceOverdue,
  parseFinalizeErrorCode,
  previewDraftTotals,
  removeInvoicePayment,
  replaceDraftInvoiceItems,
  updateDraftInvoiceHeader,
  validateDraftBeforeFinalize,
  type DraftInvoiceItemInput,
  type Invoice,
  type InvoiceParty,
  type InvoicePayment,
  type InvoiceTaxBreakdown,
  type VatCategoryCode,
} from "@/lib/invoices";
import { listBusinessPartners, type BusinessPartner } from "@/lib/business-partners";
import {
  DocumentPageShell,
  DocumentHeader,
  DocumentSection,
  DocumentMetadataGrid,
  DocumentPartyBlock,
  DocumentTotalsBlock,
  DocumentNotice,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";
import {
  DocumentStatusBadge,
  DocumentSourceBadge,
} from "@/app/components/document/DocumentStatusBadge";
import { getCompanyBillingProfile } from "@/lib/company-billing-profile";
import { todayLocalDate } from "@/lib/local-date";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { downloadBlob } from "@/lib/file-actions";

const VAT_CATEGORIES: VatCategoryCode[] = ["S", "Z", "E", "AE"];
// Kalendárny deň POUŽÍVATEĽA, nie UTC — predvyplňuje dátum vystavenia aj
// dátum úhrady. Pozri lib/local-date.ts.
const TODAY = todayLocalDate();

// Žiadny hardcoded country-specific universal VAT default (20/23/19/5 %
// a pod.) — Esblu má byť použiteľné medzinárodne a nesmie samo rozhodovať,
// aká sadzba je "správna". Nová S-kategória položka sa predvyplní iba
// hodnotou company_billing_profile.default_vat_rate danej firmy; ak firma
// default nemá nastavený, sadzba zostáva nerozlíšená (`NaN` sentinel — pozri
// findUnresolvedVatRateErrors v lib/invoices.ts) a používateľ ju musí zadať
// sám pred uložením/finalizáciou.
function emptyItem(defaultVatRate: number | null): DraftInvoiceItemInput {
  return {
    description: "",
    quantity: 1,
    unit: "ks",
    unit_price: 0,
    vat_category_code: "S",
    vat_rate: defaultVatRate ?? NaN,
  };
}

/**
 * NOT a hook — obyčajná funkcia komponentu volaná unconditionally z web aj
 * mobile wrapperu (app/faktury/[id]/page.tsx, budúci mobile/app/faktury/
 * detail/page.tsx), rovnaký vzor ako VehicleDetailView({ entityId }).
 */
export default function InvoiceDetailView({ entityId }: { entityId: string }) {
  const router = useRouter();
  const { t, locale } = useLocale();
  const { legalHold } = useCompanyDpaLegalHold();

  const [userId, setUserId] = useState("");
  const [membership, setMembership] = useState<MyActiveMembership | null>(null);
  const [membershipLoaded, setMembershipLoaded] = useState(false);
  const canView = hasFinanceView(membership);
  const canEdit = hasFinanceManage(membership);

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  // Stav spracovania v účtovníctve. Žije mimo `invoices`, lebo finalizovaný
  // doklad je immutable a „zaúčtované" je stav nášho procesu, nie vlastnosť
  // daňového dokladu.
  const [accountingStatus, setAccountingStatus] = useState<AccountingStatus>("unprocessed");
  const [accountingBusy, setAccountingBusy] = useState(false);

  async function handleToggleAccounted() {
    if (!invoice || accountingBusy || !userId) return;

    const next: AccountingStatus =
      accountingStatus === "accounted" ? "unprocessed" : "accounted";

    setAccountingBusy(true);
    try {
      await saveAccountingStatus(invoice.id, next, userId);
      setAccountingStatus(next);
    } catch (error) {
      console.error("Zmena účtovného stavu zlyhala:", error);
    } finally {
      setAccountingBusy(false);
    }
  }

  const [parties, setParties] = useState<InvoiceParty[]>([]);
  const [taxBreakdowns, setTaxBreakdowns] = useState<InvoiceTaxBreakdown[]>([]);
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [partners, setPartners] = useState<BusinessPartner[]>([]);
  // Firemný VAT default (company_billing_profile.default_vat_rate) — iba
  // prefill zdroj pre NOVÉ S-kategórie položky, nikdy hardcoded universal
  // fallback. null = firma default nemá nastavený (žiadny 20/23/19/5 % odhad).
  const [companyDefaultVatRate, setCompanyDefaultVatRate] = useState<number | null>(null);

  // Draft edit state (iba kým document_status='draft').
  const [customerId, setCustomerId] = useState("");
  // Received-only identita. Pri direction='issued' zostávajú prázdne a
  // neodosielajú sa — DB CHECK invoices_supplier_only_when_received by ich
  // aj tak odmietol.
  const [supplierId, setSupplierId] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState(TODAY);
  const [dueDate, setDueDate] = useState("");
  const [variableSymbol, setVariableSymbol] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [draftItems, setDraftItems] = useState<DraftInvoiceItemInput[]>([]);
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");

  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");

  // PDF (iba finalized) — pozri handleDownloadPdf, FÁZA 3A.
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");

  // Payment form state (iba finalized).
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(TODAY);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState("");

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

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

    if (!activeMembership || !hasFinanceView(activeMembership)) {
      setLoading(false);
      return;
    }

    await loadAll();
  }

  async function loadAll() {
    setLoading(true);

    try {
      const inv = await getInvoice(entityId);
      if (!inv) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setInvoice(inv);

      // Účtovný stav. Zlyhanie tu nesmie zhodiť celý detail — bez neho sa
      // doklad zobrazí ako nezaúčtovaný, čo je pravda aj vtedy, keď stav
      // ešte nikto nenastavil.
      try {
        const states = await listAccountingStates();
        setAccountingStatus(states[inv.id]?.accounting_status ?? "unprocessed");
      } catch (error) {
        console.error("Načítanie účtovného stavu zlyhalo:", error);
      }

      if (inv.document_status === "draft") {
        const [items, partnerRows, billingProfile] = await Promise.all([
          listInvoiceItems(inv.id),
          listBusinessPartners(inv.company_id),
          getCompanyBillingProfile(inv.company_id).catch((error) => {
            // Prefill je len pohodlie, nie kritická cesta — ak zlyhá (napr.
            // firma ešte nemá billing profile riadok), nová položka jednoducho
            // zostane s nerozlíšenou sadzbou, nič sa nehádaje.
            console.error("Načítanie firemného VAT defaultu zlyhalo:", error);
            return null;
          }),
        ]);
        const defaultVatRate = billingProfile?.default_vat_rate ?? null;
        setCompanyDefaultVatRate(defaultVatRate);
        setCustomerId(inv.customer_business_partner_id ?? "");
        setSupplierId(inv.supplier_business_partner_id ?? "");
        setSupplierInvoiceNumber(inv.supplier_invoice_number ?? "");
        setIssueDate(inv.issue_date);
        setDueDate(inv.due_date ?? "");
        setVariableSymbol(inv.variable_symbol ?? "");
        setPaymentTermsDays(inv.payment_terms_days != null ? String(inv.payment_terms_days) : "");
        setCurrency(inv.currency);
        setDraftItems(
          items.length > 0
            ? items.map((item) => ({
                description: item.description,
                quantity: item.quantity,
                unit: item.unit,
                unit_price: item.unit_price,
                vat_category_code: item.vat_category_code,
                vat_rate: item.vat_rate,
              }))
            : [emptyItem(defaultVatRate)]
        );
        setPartners(partnerRows);
      } else {
        const [partyRows, breakdownRows, paymentRows] = await Promise.all([
          listInvoiceParties(inv.id),
          listInvoiceTaxBreakdowns(inv.id),
          listInvoicePayments(inv.id),
        ]);
        setParties(partyRows);
        setTaxBreakdowns(breakdownRows);
        setPayments(paymentRows);
      }
    } catch (error) {
      console.error("Načítanie faktúry zlyhalo:", error);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }

  function updateDraftItem(index: number, patch: Partial<DraftInvoiceItemInput>) {
    setDraftItems((previous) =>
      previous.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );
  }

  // Z/E/AE nikdy nemajú skutočnú percentuálnu sadzbu (pozri effectiveVatRate
  // v lib/invoicing/vat-engine.ts) — pri prepnutí kategórie preč od S sa
  // preto sadzba vynúti na 0 (input je pre tieto kategórie disabled, viď
  // JSX nižšie). Pri prepnutí SPÄŤ na S sa sadzba predvyplní firemným
  // defaultom, alebo zostane nerozlíšená (NaN), presne ako pri novej položke
  // — nikdy sa nehádaje podľa krajiny/názvu/typu služby.
  function handleVatCategoryChange(index: number, code: VatCategoryCode) {
    updateDraftItem(index, {
      vat_category_code: code,
      vat_rate: code === "S" ? companyDefaultVatRate ?? NaN : 0,
    });
  }

  function handleVatRateChange(index: number, rawValue: string) {
    updateDraftItem(index, { vat_rate: rawValue === "" ? NaN : Number(rawValue) });
  }

  function addDraftItem() {
    setDraftItems((previous) => [...previous, emptyItem(companyDefaultVatRate)]);
  }

  function removeDraftItem(index: number) {
    setDraftItems((previous) => previous.filter((_, i) => i !== index));
  }

  // -----------------------------------------------------------------------------
  // Obojsmerná synchronizácia issue_date / payment_terms_days / due_date
  // (Model B, podľa zadania) — identická logika ako v app/faktury/new/page.tsx,
  // aby sa draft po uložení a opätovnom otvorení správal rovnako ako pri
  // vytváraní novej faktúry (predtým tu chýbala akákoľvek synchronizácia).
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

  async function handleSaveDraft() {
    if (!invoice) return;
    setSaveNotice("");

    const cleanedItems = draftItems.filter((item) => item.description.trim().length > 0);

    // Esblu nesmie nikdy zapísať do DB S-kategóriu položku s nerozlíšenou
    // (nehádanou) sadzbou DPH — táto brána platí pred uložením AJ pred
    // finalizáciou (zdieľaná s validateDraftBeforeFinalize), nielen pred
    // finalizáciou, aby sa "prázdna" sadzba nikdy potichu nezapísala ako 0.
    const vatRateErrors = findUnresolvedVatRateErrors(cleanedItems);
    if (vatRateErrors.length > 0) {
      setDraftErrors(vatRateErrors.map((error) => t(`invoices.errors.${error.messageKey}`)));
      return;
    }
    setDraftErrors([]);
    setSavingDraft(true);

    try {
      const parsedTerms = Number(paymentTermsDays);
      const updated = await updateDraftInvoiceHeader(invoice.id, userId, {
        ...directionHeaderPatch(),
        issue_date: issueDate,
        due_date: dueDate || null,
        variable_symbol: variableSymbol.trim() || null,
        payment_terms_days: Number.isFinite(parsedTerms) && paymentTermsDays !== "" ? parsedTerms : null,
        currency,
      });

      await replaceDraftInvoiceItems(invoice.id, cleanedItems);

      setInvoice(updated);
      setDraftItems(cleanedItems.length > 0 ? cleanedItems : [emptyItem(companyDefaultVatRate)]);
      setSaveNotice(t("invoices.detail.draftSavedNotice"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveNotice(t("invoices.errors.saveFailedPrefix", { message }));
    } finally {
      setSavingDraft(false);
    }
  }

  const isReceived = invoice?.direction === "received";

  /**
   * Hlavička draftu podľa smeru. Prijatá faktúra má protistranu v
   * supplier_business_partner_id a vlastnú identitu v supplier_invoice_number;
   * customer_business_partner_id pri nej MUSÍ zostať NULL (DB CHECK
   * invoices_customer_only_when_issued) a naopak.
   */
  function directionHeaderPatch() {
    return isReceived
      ? {
          supplier_business_partner_id: supplierId || null,
          supplier_invoice_number: supplierInvoiceNumber.trim() || null,
        }
      : { customer_business_partner_id: customerId || null };
  }

  async function handleFinalize() {
    if (!invoice) return;

    const relevantItems = draftItems.filter((item) => item.description.trim().length > 0);
    const errors = validateDraftBeforeFinalize(
      {
        issue_date: issueDate,
        due_date: dueDate || undefined,
        payment_terms_days: paymentTermsDays !== "" ? Number(paymentTermsDays) : undefined,
        direction: invoice.direction,
        customer_business_partner_id: customerId || null,
        supplier_business_partner_id: supplierId || null,
        supplier_invoice_number: supplierInvoiceNumber.trim() || null,
        kind: invoice.kind,
        corrects_invoice_id: invoice.corrects_invoice_id,
      },
      relevantItems
    );

    if (errors.length > 0) {
      setDraftErrors(errors.map((error) => t(`invoices.errors.${error.messageKey}`)));
      return;
    }
    setDraftErrors([]);

    const confirmed = confirm(t("invoices.detail.finalizeConfirmBody"));
    if (!confirmed) return;

    setFinalizing(true);
    setFinalizeError("");

    try {
      // Najprv ulož posledné zmeny hlavičky/riadkov (finalize prepočíta
      // autoritatívne v DB, ale drafte musia byť uložené, aby ich RPC videla).
      await updateDraftInvoiceHeader(invoice.id, userId, {
        ...directionHeaderPatch(),
        issue_date: issueDate,
        due_date: dueDate || null,
        variable_symbol: variableSymbol.trim() || null,
        payment_terms_days: paymentTermsDays !== "" ? Number(paymentTermsDays) : null,
        currency,
      });
      await replaceDraftInvoiceItems(invoice.id, relevantItems);
      await finalizeInvoice(invoice.id);
      await loadAll();
    } catch (error) {
      const code = parseFinalizeErrorCode(error);
      setFinalizeError(
        code ? t(`invoices.errors.${code}`) : t("invoices.errors.finalizeFailedGeneric")
      );
    } finally {
      setFinalizing(false);
    }
  }

  async function handleDeleteDraft() {
    if (!invoice) return;
    const confirmed = confirm(t("invoices.errors.deleteConfirmPrefix"));
    if (!confirmed) return;

    try {
      await deleteDraftInvoice(invoice.id);
      router.push("/faktury");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(t("invoices.errors.deleteFailedPrefix", { message }));
    }
  }

  /**
   * Stiahnutie PDF finalizovanej faktúry — GET /api/invoices/[id]/pdf.
   * Autorizácia (finance.view, finalized-only, cross-company) sa VŽDY
   * nezávisle overuje na serveri (RLS + explicitné RPC re-check, pozri
   * app/api/invoices/[id]/pdf/route.ts) — tento handler iba zavolá endpoint
   * a stiahnutý súbor odovzdá zdieľanému downloadBlob() helperu (web aj
   * mobile Capacitor Share sheet, pozri lib/file-actions.ts).
   */
  async function handleDownloadPdf() {
    if (!invoice) return;
    setPdfError("");
    setDownloadingPdf(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("invoices.errors.pdfNotAuthenticated"));
      }

      const response = await fetch(apiUrl(`/api/invoices/${invoice.id}/pdf`), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
      });

      if (!response.ok) {
        let message = t("invoices.errors.pdfGenerationFailed");
        try {
          const data = await response.json();
          if (data?.error) message = data.error;
        } catch {
          // response bez JSON tela — ponechaj generickú hlášku.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      await downloadBlob(blob, `${invoice.invoice_number ?? invoice.id}.pdf`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPdfError(t("invoices.errors.pdfDownloadFailedPrefix", { message }));
    } finally {
      setDownloadingPdf(false);
    }
  }

  async function handleAddPayment() {
    if (!invoice) return;
    setPaymentError("");

    const amount = Number(paymentAmount);
    if (!(amount > 0)) {
      setPaymentError(t("invoices.errors.invalidPaymentAmount"));
      return;
    }

    setSavingPayment(true);

    try {
      await addInvoicePayment(
        invoice.id,
        amount,
        paymentDate,
        paymentMethod.trim() || null,
        paymentNote.trim() || null
      );
      setPaymentAmount("");
      setPaymentMethod("");
      setPaymentNote("");
      await loadAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPaymentError(t("invoices.errors.paymentFailedPrefix", { message }));
    } finally {
      setSavingPayment(false);
    }
  }

  async function handleRemovePayment(payment: InvoicePayment) {
    const confirmed = confirm(t("invoices.detail.removePaymentConfirmPrefix"));
    if (!confirmed) return;

    try {
      await removeInvoicePayment(payment.id);
      await loadAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(t("invoices.errors.removePaymentFailedPrefix", { message }));
    }
  }

  function formatMoney(amount: number, curr: string): string {
    return formatNumber(amount, locale, { style: "currency", currency: curr });
  }

  if (loading) {
    return <div className="p-10 text-secondary">{t("invoices.loading")}</div>;
  }

  if (!membershipLoaded) {
    return <div className="p-10 text-secondary">{t("invoices.loading")}</div>;
  }

  if (!canView || notFound || !invoice) {
    return (
      <DocumentPageShell uiContext={{ module: "invoice", entityType: "invoice", entityId: entityId }}>
        <BackLink href="/faktury" label={t("invoices.backToList")} className="mb-6" />
        <DocumentNotice>
          {!canView ? t("invoices.noFinanceAccess") : t("invoices.errors.notFound")}
        </DocumentNotice>
      </DocumentPageShell>
    );
  }

  const totalPaid = payments.reduce((sum, payment) => sum + payment.paid_amount, 0);
  const overdue = isInvoiceOverdue(invoice.due_date, invoice.payment_status);
  const seller = parties.find((party) => party.role === "seller");
  const buyer = parties.find((party) => party.role === "buyer");
  const preview = previewDraftTotals(draftItems.filter((item) => item.description.trim()));

  return (
    <DocumentPageShell uiContext={{ module: "invoice", entityType: "invoice", entityId: entityId }}>
      <BackLink href="/faktury" label={t("invoices.backToList")} className="mb-6" />

      <DocumentHeader
        eyebrow={t(`invoices.kind.${invoice.kind}`)}
        title={
          /* Prijatá faktúra nemá a nikdy nedostane interné číslo Esblu — jej
             identitou je číslo dodávateľa. Zobraziť tu "FA…" fallback by
             klamalo o pôvode dokladu. */
          isReceived
            ? (invoice.supplier_invoice_number ?? t("invoices.numberFallback"))
            : (invoice.invoice_number ?? t("invoices.numberFallback"))
        }
        badges={
          <>
            <DocumentStatusBadge kind={isReceived ? "received" : "issued"} />
            {invoice.document_status === "draft" ? (
              <DocumentStatusBadge kind="draft" />
            ) : (
              <DocumentStatusBadge kind={invoice.payment_status} />
            )}
            {overdue && <DocumentStatusBadge kind="overdue" />}
            {invoice.source !== "manual" && <DocumentSourceBadge source={invoice.source} />}
          </>
        }
        aside={
          <p className="text-2xl font-semibold tabular-nums text-primary">
            {invoice.document_status === "draft"
              ? formatMoney(Number(preview.totalAmount), invoice.currency)
              : formatMoney(invoice.total_amount, invoice.currency)}
          </p>
        }
      />

      {invoice.document_status === "draft" ? (
        <>
          {canEdit && legalHold && (
            <div className="mt-4">
              <DocumentNotice tone="warning">{t("invoices.legalHoldNotice")}</DocumentNotice>
            </div>
          )}

          {!canEdit && (
            <p className="mt-4 text-sm text-muted-esblu">{t("invoices.readOnlyNotice")}</p>
          )}

          {draftErrors.length > 0 && (
            <div className="mt-4">
              <DocumentNotice tone="critical" title={t("invoices.detail.fixBeforeFinalize")}>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {draftErrors.map((error, i) => (
                    <li key={i}>{error}</li>
                  ))}
                </ul>
              </DocumentNotice>
            </div>
          )}

          {finalizeError && (
            <div className="mt-4">
              <DocumentNotice tone="critical">{finalizeError}</DocumentNotice>
            </div>
          )}

          <div className="mt-6 space-y-4 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {isReceived && (
                <div className="sm:col-span-2">
                  <label className={docLabel}>
                    {t("invoices.detail.supplierInvoiceNumberLabel")}
                  </label>
                  <input
                    className={docField}
                    value={supplierInvoiceNumber}
                    disabled={!canEdit}
                    onChange={(event) => setSupplierInvoiceNumber(event.target.value)}
                  />
                  <p className="mt-1 text-xs text-secondary">
                    {t("invoices.detail.supplierInvoiceNumberHint")}
                  </p>
                </div>
              )}

              <div>
                <label className={docLabel}>
                  {isReceived
                    ? t("invoices.detail.supplierPartnerLabel")
                    : t("invoices.newInvoice.businessPartnerLabel")}
                </label>
                <select
                  className={docField}
                  value={isReceived ? supplierId : customerId}
                  disabled={!canEdit}
                  onChange={(event) =>
                    isReceived ? setSupplierId(event.target.value) : setCustomerId(event.target.value)
                  }
                >
                  <option value="">{t("invoices.newInvoice.businessPartnerPlaceholder")}</option>
                  {partners.map((partner) => (
                    <option key={partner.id} value={partner.id}>
                      {partner.legal_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className={docLabel}>
                  {t("invoices.newInvoice.issueDateLabel")}
                </label>
                <input
                  type="date"
                  className={docField}
                  value={issueDate}
                  disabled={!canEdit}
                  onChange={(event) => handleIssueDateChange(event.target.value)}
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
                  disabled={!canEdit}
                  onChange={(event) => handleDueDateChange(event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel}>
                  {t("invoices.newInvoice.paymentTermsDaysLabel")}
                </label>
                <input
                  className={docField}
                  value={paymentTermsDays}
                  disabled={!canEdit}
                  onChange={(event) => handlePaymentTermsDaysChange(event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel}>
                  {t("invoices.newInvoice.currencyLabel")}
                </label>
                <input
                  className={docField}
                  value={currency}
                  disabled={!canEdit}
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
                  disabled={!canEdit}
                  onChange={(event) => setVariableSymbol(event.target.value)}
                />
              </div>
            </div>

            <h2 className="mt-8 text-lg font-semibold text-primary">
              {t("invoices.newInvoice.itemsTitle")}
            </h2>

            <div className="mt-4 space-y-3">
              {draftItems.map((item, index) => (
                <div
                  key={index}
                  className="grid gap-2 rounded-doc-sm border border-doc-border bg-surface-2 p-3 sm:grid-cols-12"
                >
                  <input
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-4"
                    placeholder={t("invoices.newInvoice.itemDescriptionLabel")}
                    value={item.description}
                    disabled={!canEdit}
                    onChange={(event) => updateDraftItem(index, { description: event.target.value })}
                  />
                  <input
                    type="number"
                    step="any"
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-1"
                    placeholder={t("invoices.newInvoice.itemQuantityLabel")}
                    value={item.quantity}
                    disabled={!canEdit}
                    onChange={(event) =>
                      updateDraftItem(index, { quantity: Number(event.target.value) })
                    }
                  />
                  <input
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-1"
                    placeholder={t("invoices.newInvoice.itemUnitLabel")}
                    value={item.unit}
                    disabled={!canEdit}
                    onChange={(event) => updateDraftItem(index, { unit: event.target.value })}
                  />
                  <input
                    type="number"
                    step="any"
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-2"
                    placeholder={t("invoices.newInvoice.itemUnitPriceLabel")}
                    value={item.unit_price}
                    disabled={!canEdit}
                    onChange={(event) =>
                      updateDraftItem(index, { unit_price: Number(event.target.value) })
                    }
                  />
                  <select
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-2"
                    value={item.vat_category_code}
                    disabled={!canEdit}
                    onChange={(event) =>
                      handleVatCategoryChange(index, event.target.value as VatCategoryCode)
                    }
                  >
                    {VAT_CATEGORIES.map((code) => (
                      <option key={code} value={code}>
                        {t(`invoices.newInvoice.vatCategory.${code}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="any"
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-1"
                    placeholder={
                      item.vat_category_code === "S"
                        ? t("invoices.newInvoice.itemVatRateLabel")
                        : undefined
                    }
                    title={
                      item.vat_category_code !== "S"
                        ? t("invoices.newInvoice.vatRateNotPercentageHint")
                        : undefined
                    }
                    value={
                      item.vat_category_code === "S"
                        ? Number.isFinite(item.vat_rate)
                          ? item.vat_rate
                          : ""
                        : 0
                    }
                    disabled={!canEdit || item.vat_category_code !== "S"}
                    onChange={(event) => handleVatRateChange(index, event.target.value)}
                  />
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => removeDraftItem(index)}
                      className="rounded-lg border px-2 text-xs font-semibold text-red-600 sm:col-span-1"
                    >
                      {t("invoices.newInvoice.removeItemButton")}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {canEdit && (
              <button
                type="button"
                onClick={addDraftItem}
                className="mt-3 rounded-xl border px-4 py-2 text-sm font-semibold"
              >
                {t("invoices.newInvoice.addItemButton")}
              </button>
            )}

            <div className="mt-4 rounded-doc border border-doc-border bg-surface-2 p-4">
              <p className="flex justify-between">
                <span>{t("invoices.newInvoice.subtotalLabel")}</span>
                <span className="font-semibold">{formatMoney(Number(preview.subtotalAmount), currency)}</span>
              </p>
              <p className="flex justify-between">
                <span>{t("invoices.newInvoice.vatTotalLabel")}</span>
                <span className="font-semibold">{formatMoney(Number(preview.vatTotalAmount), currency)}</span>
              </p>
              <p className="flex justify-between text-base font-bold text-primary">
                <span>{t("invoices.newInvoice.totalLabel")}</span>
                <span>{formatMoney(Number(preview.totalAmount), currency)}</span>
              </p>
            </div>

            {canEdit && (
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleSaveDraft}
                  disabled={savingDraft}
                  className="rounded-xl border px-6 py-3 font-semibold"
                >
                  {savingDraft ? t("invoices.newInvoice.saving") : t("common.buttons.save")}
                </button>

                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={finalizing || legalHold}
                  className={docButtonPrimary}
                >
                  {finalizing
                    ? t("invoices.detail.finalizing")
                    : t("invoices.detail.finalizeButton")}
                </button>

                <button
                  type="button"
                  onClick={handleDeleteDraft}
                  className="rounded-xl bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-700"
                >
                  {t("invoices.detail.deleteDraftButton")}
                </button>

                {saveNotice && <span className="text-xs text-secondary">{saveNotice}</span>}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {pdfError && (
            <div className="mt-4">
              <DocumentNotice tone="critical">{pdfError}</DocumentNotice>
            </div>
          )}

          {/* Dvojstĺpcový doklad na desktope: vľavo obsah, vpravo metadáta a
              akcie. Na mobile sa poskladá pod seba a akcie idú navrch, aby
              "otvoriť originál" nebolo až na konci dlhého dokladu. */}
          <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
            <div className="order-2 space-y-4 lg:order-1">
              <div className="grid gap-4 sm:grid-cols-2">
                {seller && (
                  <DocumentPartyBlock
                    role={t("invoices.detail.sellerTitle")}
                    note={isReceived ? t("invoices.detail.externalPartyNote") : undefined}
                    name={seller.legal_name}
                    lines={[
                      seller.ico ? `${t("invoices.pdf.icoLabel")}: ${seller.ico}` : null,
                      seller.ic_dph ? `${t("invoices.pdf.icDphLabel")}: ${seller.ic_dph}` : null,
                      seller.address_line1
                        ? [seller.address_line1, seller.city].filter(Boolean).join(", ")
                        : null,
                      seller.iban ? `${t("invoices.pdf.ibanLabel")}: ${seller.iban}` : null,
                      seller.bic ? `${t("invoices.pdf.bicLabel")}: ${seller.bic}` : null,
                      seller.electronic_address
                        ? `${t("businessPartners.form.electronicAddressLabel")}: ${seller.electronic_address}`
                        : null,
                    ]}
                  />
                )}

                {buyer && (
                  <DocumentPartyBlock
                    role={t("invoices.detail.buyerTitle")}
                    note={isReceived ? t("invoices.detail.ourCompanyNote") : undefined}
                    name={buyer.legal_name}
                    lines={[
                      buyer.ico ? `${t("invoices.pdf.icoLabel")}: ${buyer.ico}` : null,
                      buyer.ic_dph ? `${t("invoices.pdf.icDphLabel")}: ${buyer.ic_dph}` : null,
                      buyer.address_line1
                        ? [buyer.address_line1, buyer.city].filter(Boolean).join(", ")
                        : null,
                    ]}
                  />
                )}
              </div>
          <h2 className="mt-8 text-lg font-semibold text-primary">{t("invoices.detail.itemsTitle")}</h2>
          <div className="mt-3 space-y-2">
            <ItemsTableLoader invoiceId={invoice.id} currency={invoice.currency} locale={locale} />
          </div>

          <h2 className="mt-8 text-lg font-semibold text-primary">{t("invoices.detail.taxBreakdownTitle")}</h2>

          {/* Desktop/tablet — klasická tabuľka, nezmenené. */}
          <table className="mt-3 hidden w-full text-sm sm:table">
            <thead>
              <tr className="text-left text-secondary">
                <th className="pb-2">{t("invoices.newInvoice.itemVatCategoryLabel")}</th>
                <th className="pb-2 text-right">{t("invoices.detail.taxBreakdownTaxable")}</th>
                <th className="pb-2 text-right">{t("invoices.detail.taxBreakdownVat")}</th>
              </tr>
            </thead>
            <tbody>
              {taxBreakdowns.map((row) => (
                <tr key={row.id} className="border-t border-doc-border">
                  <td className="py-2">
                    {row.vat_category_code} ({formatNumber(row.vat_rate, locale)}%)
                  </td>
                  <td className="py-2 text-right">{formatMoney(row.taxable_amount, invoice.currency)}</td>
                  <td className="py-2 text-right">{formatMoney(row.vat_amount, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile (< sm) — card/stack layout, rovnaký pattern ako pri
              riadkových položkách vyššie. */}
          <div className="mt-3 space-y-3 sm:hidden">
            {taxBreakdowns.map((row) => (
              <div key={row.id} className="rounded-doc border border-doc-border bg-surface-2 p-4">
                <p className="text-xs font-semibold text-secondary">
                  {t("invoices.newInvoice.itemVatCategoryLabel")}
                </p>
                <p className="text-sm font-semibold text-primary">
                  {row.vat_category_code} ({formatNumber(row.vat_rate, locale)}%)
                </p>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs font-semibold text-secondary">
                      {t("invoices.detail.taxBreakdownTaxable")}
                    </p>
                    <p className="text-sm text-primary">
                      {formatMoney(row.taxable_amount, invoice.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-secondary">
                      {t("invoices.detail.taxBreakdownVat")}
                    </p>
                    <p className="text-sm font-semibold text-primary">
                      {formatMoney(row.vat_amount, invoice.currency)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

            </div>

            {/* Metadáta + akcie. Na mobile navrchu (order-1). */}
            <aside className="order-1 space-y-4 lg:order-2 lg:sticky lg:top-4">
              <DocumentSection title={t("invoices.detail.actionsTitle")}>
                <div className="flex flex-col gap-2">
                  {/* PDF generuje Esblu iba pre VLASTNÉ vydané doklady. Prijatá
                      faktúra je dokument dodávateľa — vyrobiť jej vlastné PDF by
                      znamenalo vydávať prerozprávanie cudzieho dokladu za doklad. */}
                  {!isReceived ? (
                    <button
                      type="button"
                      onClick={handleDownloadPdf}
                      disabled={downloadingPdf}
                      className={docButtonPrimary}
                    >
                      {downloadingPdf
                        ? t("invoices.detail.downloadingPdf")
                        : t("invoices.detail.downloadPdfButton")}
                    </button>
                  ) : invoice.source_document_id ? (
                    <Link
                      href={`/ai-evidencia?openDocument=${invoice.source_document_id}`}
                      className={docButtonPrimary}
                    >
                      {t("invoices.detail.openSourceDocumentButton")}
                    </Link>
                  ) : (
                    <p className="text-sm text-muted-esblu">
                      {t("invoices.detail.noSourceDocument")}
                    </p>
                  )}

                  {/* ZAÚČTOVANÉ NIE JE UHRADENÉ.
                      Stav účtovníctva je samostatná otázka a odpovedá na
                      ňu človek, nie appka. Neodvodzuje sa z úhrady ani z
                      ničoho iného a dá sa vziať späť — kto označuje, ten
                      sa aj pomýli. */}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={handleToggleAccounted}
                      disabled={accountingBusy}
                      aria-busy={accountingBusy}
                      className={docButtonSecondary}
                    >
                      {accountingStatus === "accounted"
                        ? t("invoices.detail.markUnaccountedButton")
                        : t("invoices.detail.markAccountedButton")}
                    </button>
                  )}

                  {/* Opravný doklad dedí smer opravovanej faktúry — krížiť ich
                      zakazuje ESBLU_CORRECTED_INVOICE_DIRECTION_MISMATCH. */}
                  {canEdit && !isReceived && (
                    <Link href={`/faktury/new?corrects=${invoice.id}`} className={docButtonSecondary}>
                      {t("invoices.detail.createCorrectionButton")}
                    </Link>
                  )}
                </div>
                <p className="mt-3 text-xs text-muted-esblu">
                  {t("invoices.detail.finalizedNotice")}
                </p>
              </DocumentSection>

              <DocumentSection title={t("invoices.detail.metadataTitle")}>
                <DocumentMetadataGrid
                  columns={2}
                  items={[
                    {
                      label: t("invoices.newInvoice.issueDateLabel"),
                      value: formatDate(invoice.issue_date, locale),
                    },
                    {
                      label: t("invoices.newInvoice.dueDateLabel"),
                      value: invoice.due_date ? formatDate(invoice.due_date, locale) : null,
                    },
                    {
                      label: t("invoices.pdf.deliveryDateLabel"),
                      value: invoice.delivery_date ? formatDate(invoice.delivery_date, locale) : null,
                    },
                    {
                      label: t("invoices.pdf.taxPointDateLabel"),
                      value: invoice.tax_point_date
                        ? formatDate(invoice.tax_point_date, locale)
                        : null,
                    },
                    { label: t("invoices.pdf.currencyLabel"), value: invoice.currency },
                    {
                      label: t("invoices.pdf.variableSymbolLabel"),
                      value: invoice.variable_symbol,
                    },
                    { label: t("invoices.detail.ibanLabel"), value: invoice.iban, full: true },
                  ]}
                />
              </DocumentSection>
            </aside>
          </div>

          <h2 className="mt-8 text-lg font-semibold text-primary">{t("invoices.detail.paymentsTitle")}</h2>

          {/* Platobný model je pre oba smery ten istý (RPC, payment_status).
              Mení sa len formulácia: vydaná faktúra je pohľadávka voči
              zákazníkovi, prijatá je záväzok voči dodávateľovi. */}
          <p className="mt-1 text-xs text-secondary">
            {isReceived
              ? t("invoices.detail.paymentsReceivedHint")
              : t("invoices.detail.paymentsIssuedHint")}
          </p>

          <p className="mt-2 text-sm text-secondary">
            {(isReceived
              ? t("invoices.detail.totalPaidToSupplierLabel")
              : t("invoices.detail.totalPaidLabel"))}
            : {formatMoney(totalPaid, invoice.currency)}
          </p>

          {payments.length === 0 ? (
            <p className="mt-2 text-sm text-secondary">{t("invoices.detail.noPayments")}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex items-center justify-between gap-3 rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2.5 text-sm"
                >
                  <div>
                    <p className="font-semibold text-primary">
                      {formatMoney(payment.paid_amount, invoice.currency)}
                    </p>
                    <p className="text-xs text-secondary">
                      {formatDate(payment.paid_at, locale)}
                      {payment.payment_method ? ` · ${payment.payment_method}` : ""}
                      {payment.note ? ` · ${payment.note}` : ""}
                    </p>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => handleRemovePayment(payment)}
                      className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-red-600"
                    >
                      {t("invoices.detail.removePaymentButton")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canEdit && (
            <div className="mt-4 rounded-doc border border-doc-border bg-surface-2 p-4">
              <h3 className="text-sm font-bold text-primary">{t("invoices.detail.addPaymentButton")}</h3>

              {paymentError && (
                <p className="mt-2 text-sm font-semibold text-red-600">{paymentError}</p>
              )}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <input
                  type="number"
                  step="0.01"
                  className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan"
                  placeholder={t("invoices.detail.paymentAmountLabel")}
                  value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)}
                />
                <input
                  type="date"
                  className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                />
                <input
                  className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan"
                  placeholder={t("invoices.detail.paymentMethodLabel")}
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                />
                <input
                  className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan"
                  placeholder={t("invoices.detail.paymentNoteLabel")}
                  value={paymentNote}
                  onChange={(event) => setPaymentNote(event.target.value)}
                />
              </div>

              <button
                type="button"
                onClick={handleAddPayment}
                disabled={savingPayment}
                className={docButtonPrimary}
              >
                {savingPayment ? t("invoices.detail.savingPayment") : t("invoices.detail.addPaymentButton")}
              </button>
            </div>
          )}
        </>
      )}
    </DocumentPageShell>
  );
}

/**
 * Malý izolovaný loader pre riadkové položky finalizovanej faktúry (iba
 * zobrazenie — invoice_items je po finalizácii immutable, žiadna editácia).
 * Oddelené od hlavného komponentu, aby hlavný loadAll() nemusel držať ešte
 * jeden zoznam v stave, ktorý sa mimo tohto miesta nikde nepoužíva.
 */
function ItemsTableLoader({
  invoiceId,
  currency,
  locale,
}: {
  invoiceId: string;
  currency: string;
  locale: Locale;
}) {
  const { t } = useLocale();
  const [items, setItems] = useState<Awaited<ReturnType<typeof listInvoiceItems>>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    listInvoiceItems(invoiceId)
      .then(setItems)
      .catch((error) => console.error("Načítanie riadkov faktúry zlyhalo:", error))
      .finally(() => setLoaded(true));
  }, [invoiceId]);

  if (!loaded) return <p className="text-sm text-secondary">{t("invoices.loading")}</p>;

  return (
    <>
      {/* Desktop/tablet — klasická tabuľka, nezmenené. */}
      <table className="hidden w-full text-sm sm:table">
        <thead>
          <tr className="text-left text-secondary">
            <th className="pb-2">{t("invoices.newInvoice.itemDescriptionLabel")}</th>
            <th className="pb-2 text-right">{t("invoices.newInvoice.itemQuantityLabel")}</th>
            <th className="pb-2 text-right">{t("invoices.newInvoice.itemUnitPriceLabel")}</th>
            <th className="pb-2 text-right">{t("invoices.newInvoice.totalLabel")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-doc-border">
              <td className="py-2">{item.description}</td>
              <td className="py-2 text-right">
                {formatNumber(item.quantity, locale)} {item.unit}
              </td>
              <td className="py-2 text-right">
                {formatNumber(item.unit_price, locale, { style: "currency", currency })}
              </td>
              <td className="py-2 text-right">
                {formatNumber(item.line_gross_amount, locale, {
                  style: "currency",
                  currency,
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile (< sm) — card/stack layout namiesto 4 stĺpcov vedľa seba,
          ktoré sa na cca 360–430 px zobrazovali prekryté/zlepené. */}
      <div className="space-y-3 sm:hidden">
        {items.map((item) => (
          <div key={item.id} className="rounded-doc border border-doc-border bg-surface-2 p-4">
            <p className="text-xs font-semibold text-secondary">
              {t("invoices.newInvoice.itemDescriptionLabel")}
            </p>
            <p className="text-sm font-semibold text-primary">{item.description}</p>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-semibold text-secondary">
                  {t("invoices.newInvoice.itemQuantityLabel")}
                </p>
                <p className="text-sm text-primary">
                  {formatNumber(item.quantity, locale)} {item.unit}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold text-secondary">
                  {t("invoices.newInvoice.itemUnitPriceLabel")}
                </p>
                <p className="text-sm text-primary">
                  {formatNumber(item.unit_price, locale, { style: "currency", currency })}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold text-secondary">
                  {t("invoices.detail.taxBreakdownVat")}
                </p>
                <p className="text-sm text-primary">
                  {item.vat_category_code} ({formatNumber(item.vat_rate, locale)}%)
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold text-secondary">
                  {t("invoices.newInvoice.totalLabel")}
                </p>
                <p className="text-sm font-semibold text-primary">
                  {formatNumber(item.line_gross_amount, locale, {
                    style: "currency",
                    currency,
                  })}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
