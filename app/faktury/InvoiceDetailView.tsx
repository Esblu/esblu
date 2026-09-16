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
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import {
  addInvoicePayment,
  deleteDraftInvoice,
  finalizeInvoice,
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

const VAT_CATEGORIES: VatCategoryCode[] = ["S", "Z", "E", "AE"];
const TODAY = new Date().toISOString().slice(0, 10);

function emptyItem(): DraftInvoiceItemInput {
  return {
    description: "",
    quantity: 1,
    unit: "ks",
    unit_price: 0,
    vat_category_code: "S",
    vat_rate: 20,
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

  const [parties, setParties] = useState<InvoiceParty[]>([]);
  const [taxBreakdowns, setTaxBreakdowns] = useState<InvoiceTaxBreakdown[]>([]);
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [partners, setPartners] = useState<BusinessPartner[]>([]);

  // Draft edit state (iba kým document_status='draft').
  const [customerId, setCustomerId] = useState("");
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

      if (inv.document_status === "draft") {
        const [items, partnerRows] = await Promise.all([
          listInvoiceItems(inv.id),
          listBusinessPartners(inv.company_id),
        ]);
        setCustomerId(inv.customer_business_partner_id ?? "");
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
            : [emptyItem()]
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

  function addDraftItem() {
    setDraftItems((previous) => [...previous, emptyItem()]);
  }

  function removeDraftItem(index: number) {
    setDraftItems((previous) => previous.filter((_, i) => i !== index));
  }

  async function handleSaveDraft() {
    if (!invoice) return;
    setSaveNotice("");
    setSavingDraft(true);

    try {
      const parsedTerms = Number(paymentTermsDays);
      const updated = await updateDraftInvoiceHeader(invoice.id, userId, {
        customer_business_partner_id: customerId || null,
        issue_date: issueDate,
        due_date: dueDate || null,
        variable_symbol: variableSymbol.trim() || null,
        payment_terms_days: Number.isFinite(parsedTerms) && paymentTermsDays !== "" ? parsedTerms : null,
        currency,
      });

      const cleanedItems = draftItems.filter((item) => item.description.trim().length > 0);
      await replaceDraftInvoiceItems(invoice.id, cleanedItems);

      setInvoice(updated);
      setDraftItems(cleanedItems.length > 0 ? cleanedItems : [emptyItem()]);
      setSaveNotice(t("invoices.detail.draftSavedNotice"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveNotice(t("invoices.errors.saveFailedPrefix", { message }));
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleFinalize() {
    if (!invoice) return;

    const relevantItems = draftItems.filter((item) => item.description.trim().length > 0);
    const errors = validateDraftBeforeFinalize(
      {
        issue_date: issueDate,
        customer_business_partner_id: customerId || null,
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
        customer_business_partner_id: customerId || null,
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
      <div className="mx-auto max-w-3xl px-4 pb-24 pt-6 sm:px-6">
        <BackLink href="/faktury" label={t("invoices.backToList")} className="mb-6" />
        <p className="mt-3 rounded-2xl border border-subtle bg-surface-1 p-6 text-center text-secondary">
          {!canView ? t("invoices.noFinanceAccess") : t("invoices.errors.notFound")}
        </p>
      </div>
    );
  }

  const totalPaid = payments.reduce((sum, payment) => sum + payment.paid_amount, 0);
  const overdue = isInvoiceOverdue(invoice.due_date, invoice.payment_status);
  const seller = parties.find((party) => party.role === "seller");
  const buyer = parties.find((party) => party.role === "buyer");
  const preview = previewDraftTotals(draftItems.filter((item) => item.description.trim()));

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-6 sm:px-6">
      <BackLink href="/faktury" label={t("invoices.backToList")} className="mb-6" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-primary">
            {invoice.invoice_number ?? t("invoices.numberFallback")}
            {overdue && (
              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                {t("invoices.overdueBadge")}
              </span>
            )}
          </h1>
          <p className="text-sm text-secondary">
            {t(`invoices.kind.${invoice.kind}`)} ·{" "}
            {invoice.document_status === "draft"
              ? t("invoices.documentStatus.draft")
              : t(`invoices.paymentStatus.${invoice.payment_status}`)}
          </p>
        </div>
        <p className="text-2xl font-bold text-primary">
          {formatMoney(invoice.total_amount, invoice.currency)}
        </p>
      </div>

      {invoice.document_status === "draft" ? (
        <>
          {canEdit && legalHold && (
            <p className="mt-3 text-sm font-semibold text-amber-600">
              {t("invoices.legalHoldNotice")}
            </p>
          )}

          {!canEdit && (
            <p className="mt-3 text-sm text-secondary">{t("invoices.readOnlyNotice")}</p>
          )}

          {draftErrors.length > 0 && (
            <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              {draftErrors.map((error, i) => (
                <p key={i}>{error}</p>
              ))}
            </div>
          )}

          {finalizeError && (
            <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              {finalizeError}
            </p>
          )}

          <div className="mt-6 rounded-3xl border border-subtle bg-surface-1 p-6 shadow-lg">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-semibold">
                  {t("invoices.newInvoice.businessPartnerLabel")}
                </label>
                <select
                  className="w-full rounded-xl border p-3"
                  value={customerId}
                  disabled={!canEdit}
                  onChange={(event) => setCustomerId(event.target.value)}
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
                <label className="mb-2 block text-sm font-semibold">
                  {t("invoices.newInvoice.issueDateLabel")}
                </label>
                <input
                  type="date"
                  className="w-full rounded-xl border p-3"
                  value={issueDate}
                  disabled={!canEdit}
                  onChange={(event) => setIssueDate(event.target.value)}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold">
                  {t("invoices.newInvoice.dueDateLabel")}
                </label>
                <input
                  type="date"
                  className="w-full rounded-xl border p-3"
                  value={dueDate}
                  disabled={!canEdit}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold">
                  {t("invoices.newInvoice.paymentTermsDaysLabel")}
                </label>
                <input
                  className="w-full rounded-xl border p-3"
                  value={paymentTermsDays}
                  disabled={!canEdit}
                  onChange={(event) => setPaymentTermsDays(event.target.value)}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold">
                  {t("invoices.newInvoice.currencyLabel")}
                </label>
                <input
                  className="w-full rounded-xl border p-3"
                  value={currency}
                  disabled={!canEdit}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold">
                  {t("invoices.newInvoice.variableSymbolLabel")}
                </label>
                <input
                  className="w-full rounded-xl border p-3"
                  value={variableSymbol}
                  disabled={!canEdit}
                  onChange={(event) => setVariableSymbol(event.target.value)}
                />
              </div>
            </div>

            <h2 className="mt-8 text-lg font-bold text-primary">
              {t("invoices.newInvoice.itemsTitle")}
            </h2>

            <div className="mt-4 space-y-3">
              {draftItems.map((item, index) => (
                <div
                  key={index}
                  className="grid gap-2 rounded-xl border border-subtle p-3 sm:grid-cols-12"
                >
                  <input
                    className="rounded-lg border p-2 sm:col-span-4"
                    placeholder={t("invoices.newInvoice.itemDescriptionLabel")}
                    value={item.description}
                    disabled={!canEdit}
                    onChange={(event) => updateDraftItem(index, { description: event.target.value })}
                  />
                  <input
                    type="number"
                    step="any"
                    className="rounded-lg border p-2 sm:col-span-1"
                    placeholder={t("invoices.newInvoice.itemQuantityLabel")}
                    value={item.quantity}
                    disabled={!canEdit}
                    onChange={(event) =>
                      updateDraftItem(index, { quantity: Number(event.target.value) })
                    }
                  />
                  <input
                    className="rounded-lg border p-2 sm:col-span-1"
                    placeholder={t("invoices.newInvoice.itemUnitLabel")}
                    value={item.unit}
                    disabled={!canEdit}
                    onChange={(event) => updateDraftItem(index, { unit: event.target.value })}
                  />
                  <input
                    type="number"
                    step="any"
                    className="rounded-lg border p-2 sm:col-span-2"
                    placeholder={t("invoices.newInvoice.itemUnitPriceLabel")}
                    value={item.unit_price}
                    disabled={!canEdit}
                    onChange={(event) =>
                      updateDraftItem(index, { unit_price: Number(event.target.value) })
                    }
                  />
                  <select
                    className="rounded-lg border p-2 sm:col-span-2"
                    value={item.vat_category_code}
                    disabled={!canEdit}
                    onChange={(event) =>
                      updateDraftItem(index, {
                        vat_category_code: event.target.value as VatCategoryCode,
                      })
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
                    className="rounded-lg border p-2 sm:col-span-1"
                    placeholder={t("invoices.newInvoice.itemVatRateLabel")}
                    value={item.vat_rate}
                    disabled={!canEdit}
                    onChange={(event) =>
                      updateDraftItem(index, { vat_rate: Number(event.target.value) })
                    }
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

            <div className="mt-6 space-y-1 rounded-xl bg-surface-2 p-4 text-sm">
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
                  className="rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
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
          <p className="mt-3 text-sm text-secondary">{t("invoices.detail.finalizedNotice")}</p>

          {canEdit && (
            <div className="mt-4">
              <Link
                href={`/faktury/new?corrects=${invoice.id}`}
                className="inline-block rounded-xl border px-4 py-2 text-sm font-semibold"
              >
                {t("invoices.detail.createCorrectionButton")}
              </Link>
            </div>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {seller && (
              <div className="rounded-2xl border border-subtle bg-surface-1 p-4">
                <h2 className="text-sm font-bold text-secondary">{t("invoices.detail.sellerTitle")}</h2>
                <p className="mt-1 font-semibold text-primary">{seller.legal_name}</p>
                {seller.ico && <p className="text-sm text-secondary">IČO: {seller.ico}</p>}
                {seller.address_line1 && (
                  <p className="text-sm text-secondary">
                    {seller.address_line1}, {seller.city}
                  </p>
                )}
                {seller.iban && <p className="text-sm text-secondary">IBAN: {seller.iban}</p>}
              </div>
            )}

            {buyer && (
              <div className="rounded-2xl border border-subtle bg-surface-1 p-4">
                <h2 className="text-sm font-bold text-secondary">{t("invoices.detail.buyerTitle")}</h2>
                <p className="mt-1 font-semibold text-primary">{buyer.legal_name}</p>
                {buyer.ico && <p className="text-sm text-secondary">IČO: {buyer.ico}</p>}
                {buyer.address_line1 && (
                  <p className="text-sm text-secondary">
                    {buyer.address_line1}, {buyer.city}
                  </p>
                )}
              </div>
            )}
          </div>

          <h2 className="mt-8 text-lg font-bold text-primary">{t("invoices.detail.itemsTitle")}</h2>
          <div className="mt-3 space-y-2">
            <ItemsTableLoader invoiceId={invoice.id} currency={invoice.currency} locale={locale} />
          </div>

          <h2 className="mt-8 text-lg font-bold text-primary">{t("invoices.detail.taxBreakdownTitle")}</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-secondary">
                <th className="pb-2">{t("invoices.newInvoice.itemVatCategoryLabel")}</th>
                <th className="pb-2 text-right">{t("invoices.detail.taxBreakdownTaxable")}</th>
                <th className="pb-2 text-right">{t("invoices.detail.taxBreakdownVat")}</th>
              </tr>
            </thead>
            <tbody>
              {taxBreakdowns.map((row) => (
                <tr key={row.id} className="border-t border-subtle">
                  <td className="py-2">
                    {row.vat_category_code} ({formatNumber(row.vat_rate, locale)}%)
                  </td>
                  <td className="py-2 text-right">{formatMoney(row.taxable_amount, invoice.currency)}</td>
                  <td className="py-2 text-right">{formatMoney(row.vat_amount, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className="mt-8 text-lg font-bold text-primary">{t("invoices.detail.paymentsTitle")}</h2>

          <p className="mt-2 text-sm text-secondary">
            {t("invoices.detail.totalPaidLabel")}: {formatMoney(totalPaid, invoice.currency)}
          </p>

          {payments.length === 0 ? (
            <p className="mt-2 text-sm text-secondary">{t("invoices.detail.noPayments")}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex items-center justify-between rounded-xl border border-subtle bg-surface-1 p-3 text-sm"
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
            <div className="mt-4 rounded-2xl border border-subtle bg-surface-1 p-4">
              <h3 className="text-sm font-bold text-primary">{t("invoices.detail.addPaymentButton")}</h3>

              {paymentError && (
                <p className="mt-2 text-sm font-semibold text-red-600">{paymentError}</p>
              )}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <input
                  type="number"
                  step="0.01"
                  className="rounded-lg border p-2"
                  placeholder={t("invoices.detail.paymentAmountLabel")}
                  value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)}
                />
                <input
                  type="date"
                  className="rounded-lg border p-2"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                />
                <input
                  className="rounded-lg border p-2"
                  placeholder={t("invoices.detail.paymentMethodLabel")}
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                />
                <input
                  className="rounded-lg border p-2"
                  placeholder={t("invoices.detail.paymentNoteLabel")}
                  value={paymentNote}
                  onChange={(event) => setPaymentNote(event.target.value)}
                />
              </div>

              <button
                type="button"
                onClick={handleAddPayment}
                disabled={savingPayment}
                className="mt-3 rounded-xl bg-blue-600 px-6 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
              >
                {savingPayment ? t("invoices.detail.savingPayment") : t("invoices.detail.addPaymentButton")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
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
    <table className="w-full text-sm">
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
          <tr key={item.id} className="border-t border-subtle">
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
  );
}
