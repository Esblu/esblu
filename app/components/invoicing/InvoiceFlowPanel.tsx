"use client";

// =============================================================================
// Účtovný tok dokladu (20261008100005): typ dokladu, review prijatej opravy, odpočet záloh,
// saldo (platby, vrátenia, dobropisy, ťarchopisy, zálohy). Všetko cez RPC pod JWT používateľa;
// chyby sa zobrazujú preložené podľa kódu ESBLU_*, nikdy ako surový JSON/DB text.
// =============================================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate, formatMoney } from "@/lib/i18n/format";
import { invoiceDetailHref } from "@/lib/entity-links";
import { finalizeInvoice, type Invoice } from "@/lib/invoices";
import {
  addInvoiceRefund,
  esbluErrorCode,
  getInvoiceSettlement,
  linkReceivedCorrection,
  listAdvanceDeductions,
  listAvailableAdvances,
  listCorrectionCandidates,
  proportionalVat,
  rejectReceivedCorrection,
  setAdvanceDeductions,
  type AdvanceDeduction,
  type AvailableAdvance,
  type CorrectionCandidate,
  type InvoiceSettlement,
} from "@/lib/invoicing/settlement";
import { todayLocalDate } from "@/lib/local-date";

type Props = {
  invoice: Invoice;
  canManage: boolean;
  /** Po zmene (prijatie opravy, odpočet, vrátenie) — rodič znovu načíta doklad. */
  onChanged: () => void;
};

const box = "mt-6 rounded-doc border border-doc-border bg-surface-1 p-4 text-sm";

export default function InvoiceFlowPanel({ invoice, canManage, onChanged }: Props) {
  const { t, locale } = useLocale();
  const money = (v: number) => formatMoney(v, invoice.currency, locale);
  const [settlement, setSettlement] = useState<InvoiceSettlement | null>(null);
  const [deductions, setDeductions] = useState<AdvanceDeduction[]>([]);
  const [available, setAvailable] = useState<AvailableAdvance[]>([]);
  const [candidates, setCandidates] = useState<CorrectionCandidate[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [linkTarget, setLinkTarget] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const isDraft = invoice.document_status === "draft";
  const isFinal = invoice.direction === "issued" && invoice.kind === "regular_invoice";
  const isReceivedCorrection = invoice.direction === "received" && (invoice.kind === "credit_note" || invoice.kind === "debit_note") && Boolean(invoice.correction_review_status);
  const showSettlement = invoice.document_status === "finalized" && invoice.kind !== "proforma";

  useEffect(() => {
    let cancelled = false;
    const tasks: Promise<void>[] = [];
    if (showSettlement) tasks.push(getInvoiceSettlement(invoice.id).then((s) => { if (!cancelled) setSettlement(s); }));
    if (isFinal) {
      tasks.push(listAdvanceDeductions(invoice.id).then((d) => { if (!cancelled) setDeductions(d); }));
      if (isDraft && canManage) tasks.push(listAvailableAdvances(invoice.id).then((a) => { if (!cancelled) setAvailable(a); }));
    }
    if (isReceivedCorrection && isDraft && !invoice.corrects_invoice_id && invoice.supplier_business_partner_id) {
      tasks.push(listCorrectionCandidates(invoice.supplier_business_partner_id).then((c) => { if (!cancelled) setCandidates(c); }));
    }
    void Promise.all(tasks).catch((e) => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id, invoice.document_status, invoice.corrects_invoice_id, reloadKey]);

  function errorText(e: unknown): string {
    const code = esbluErrorCode(e);
    const key = code ? `invoices.errors.${code}` : null;
    const text = key ? t(key) : "";
    return text && text !== key ? text : t("invoices.flow.genericError");
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const docTypeKey =
    invoice.kind === "proforma" ? "invoices.flow.type.proforma"
    : invoice.kind === "payment_received_invoice" ? "invoices.flow.type.paymentReceived"
    : invoice.kind === "credit_note" || invoice.kind === "debit_note" ? "invoices.flow.type.correction"
    : isFinal && deductions.length > 0 ? "invoices.flow.type.final"
    : "invoices.flow.type.regular";

  const advanceKey = (a: AvailableAdvance) => `${a.advance_invoice_id}|${a.vat_category_code}|${a.vat_rate}`;
  const selectedRows = (): AdvanceDeduction[] =>
    available.flatMap((a) => {
      const raw = selection[advanceKey(a)];
      if (raw === undefined || raw.trim() === "") return [];
      const taxable = Math.min(Number(raw.replace(",", ".")), a.taxable_remaining);
      if (!(taxable > 0)) return [];
      return [{ advance_invoice_id: a.advance_invoice_id, vat_category_code: a.vat_category_code, vat_rate: a.vat_rate, taxable_amount: Math.round(taxable * 100) / 100, vat_amount: proportionalVat(a, taxable) }];
    });
  const deductedTotal = deductions.reduce((s, d) => s + d.taxable_amount + d.vat_amount, 0);
  const netPaid = settlement ? settlement.paid - settlement.refunded : 0;

  return (
    <section className={box} aria-labelledby="invoice-flow-title" data-testid="invoice-flow-panel">
      <h2 id="invoice-flow-title" className="text-base font-semibold text-primary">{t("invoices.flow.title")}</h2>
      <p className="mt-1 text-secondary" data-doc-type={docTypeKey}>{t(docTypeKey)}</p>

      {/* Prijatá oprava — review */}
      {isReceivedCorrection && (
        <div className="mt-4 space-y-2" data-review-status={invoice.correction_review_status ?? ""}>
          <p className="font-medium text-primary">
            {t(`invoices.flow.review.status.${invoice.correction_review_status}`)}
          </p>
          {invoice.corrected_document_reference && (
            <p className="text-secondary">{t("invoices.flow.review.reference", { number: invoice.corrected_document_reference })}</p>
          )}
          {invoice.corrects_invoice_id ? (
            <p>
              <Link href={invoiceDetailHref(invoice.corrects_invoice_id)} className="underline">{t("invoices.flow.review.openOriginal")}</Link>
            </p>
          ) : null}
          {(invoice.correction_review_reasons ?? []).length > 0 && (
            <ul className="list-disc pl-5 text-secondary">
              {(invoice.correction_review_reasons ?? []).map((r) => (
                <li key={r}>{t(`invoices.flow.review.reason.${r}`)}</li>
              ))}
            </ul>
          )}
          {invoice.correction_review_status === "rejected" && invoice.correction_review_note && (
            <p className="text-secondary">{t("invoices.flow.review.rejectedNote", { note: invoice.correction_review_note })}</p>
          )}
          {canManage && isDraft && invoice.correction_review_status === "review" && (
            <div className="space-y-3">
              {!invoice.corrects_invoice_id && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col text-xs text-secondary">
                    {t("invoices.flow.review.pickOriginal")}
                    <select className="mt-1 rounded-doc-sm border border-doc-border bg-surface-1 px-2 py-1 text-sm" value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}>
                      <option value="">—</option>
                      {candidates.map((c) => (
                        <option key={c.id} value={c.id}>{`${c.supplier_invoice_number ?? "?"} · ${formatDate(c.issue_date, locale)} · ${formatMoney(c.total_amount, c.currency, locale)}`}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" disabled={busy || !linkTarget} className="rounded-doc-sm border border-doc-border px-3 py-1"
                    onClick={() => run(() => linkReceivedCorrection(invoice.id, linkTarget))}>
                    {t("invoices.flow.review.link")}
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || !invoice.corrects_invoice_id} className="rounded-doc-sm bg-primary px-3 py-1 text-on-primary"
                  onClick={() => run(async () => { await finalizeInvoice(invoice.id); })}>
                  {t("invoices.flow.review.accept")}
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-xs text-secondary">
                  {t("invoices.flow.review.rejectNoteLabel")}
                  <input className="mt-1 rounded-doc-sm border border-doc-border bg-surface-1 px-2 py-1 text-sm" value={rejectNote} maxLength={500} onChange={(e) => setRejectNote(e.target.value)} />
                </label>
                <button type="button" disabled={busy || rejectNote.trim().length < 3} className="rounded-doc-sm border border-doc-border px-3 py-1"
                  onClick={() => run(() => rejectReceivedCorrection(invoice.id, rejectNote.trim()))}>
                  {t("invoices.flow.review.reject")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Konečná faktúra — odpočet záloh */}
      {isFinal && (deductions.length > 0 || (isDraft && canManage && available.length > 0)) && (
        <div className="mt-4">
          <h3 className="font-medium text-primary">{t("invoices.flow.advances.title")}</h3>
          {deductions.length > 0 && (
            <ul className="mt-1 space-y-1">
              {deductions.map((d) => (
                <li key={`${d.advance_invoice_id}|${d.vat_category_code}|${d.vat_rate}`} className="flex justify-between gap-2">
                  <Link href={invoiceDetailHref(d.advance_invoice_id)} className="underline">{t("invoices.flow.advances.advanceLink")}</Link>
                  <span className="tabular-nums">{`${d.vat_category_code} ${d.vat_rate} %: ${money(d.taxable_amount)} + ${money(d.vat_amount)}`}</span>
                </li>
              ))}
              <li className="flex justify-between gap-2 font-medium"><span>{t("invoices.flow.advances.deductedTotal")}</span><span className="tabular-nums">{money(deductedTotal)}</span></li>
              {!isDraft && (
                <li className="flex justify-between gap-2"><span>{t("invoices.flow.advances.remaining")}</span><span className="tabular-nums">{money(invoice.total_amount - deductedTotal)}</span></li>
              )}
            </ul>
          )}
          {isDraft && canManage && available.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-secondary">{t("invoices.flow.advances.pickHint")}</p>
              {available.map((a) => (
                <label key={advanceKey(a)} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{`${a.invoice_number ?? "?"} · ${a.vat_category_code} ${a.vat_rate} % · ${t("invoices.flow.advances.availableLabel")} ${money(a.taxable_remaining)} + ${money(a.vat_remaining)}`}</span>
                  <input inputMode="decimal" className="w-32 rounded-doc-sm border border-doc-border bg-surface-1 px-2 py-1 text-right text-sm tabular-nums"
                    placeholder={String(a.taxable_remaining)} value={selection[advanceKey(a)] ?? ""}
                    onChange={(e) => setSelection((s) => ({ ...s, [advanceKey(a)]: e.target.value }))} />
                </label>
              ))}
              <button type="button" disabled={busy} className="rounded-doc-sm border border-doc-border px-3 py-1"
                onClick={() => run(() => setAdvanceDeductions(invoice.id, selectedRows()))}>
                {t("invoices.flow.advances.save")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Saldo */}
      {showSettlement && settlement && (
        <div className="mt-4" data-payment-status={settlement.payment_status}>
          <h3 className="font-medium text-primary">{t("invoices.flow.settlement.title")}</h3>
          <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
            <dt>{t("invoices.flow.settlement.original")}</dt><dd>{money(settlement.original_total)}</dd>
            {settlement.advances_deducted > 0 && (<><dt>{t("invoices.flow.settlement.advances")}</dt><dd>{money(-settlement.advances_deducted)}</dd></>)}
            {settlement.credit_notes_total > 0 && (<><dt>{t("invoices.flow.settlement.credits")}</dt><dd>{money(-settlement.credit_notes_total)}</dd></>)}
            {settlement.debit_notes_total > 0 && (<><dt>{t("invoices.flow.settlement.debits")}</dt><dd>{money(settlement.debit_notes_total)}</dd></>)}
            <dt className="font-medium">{t("invoices.flow.settlement.due")}</dt><dd className="font-medium">{money(settlement.amount_due)}</dd>
            <dt>{t("invoices.flow.settlement.paid")}</dt><dd>{money(settlement.paid)}</dd>
            {settlement.refunded > 0 && (<><dt>{t("invoices.flow.settlement.refunded")}</dt><dd>{money(-settlement.refunded)}</dd></>)}
            <dt className="font-semibold">{t(settlement.balance < 0 ? "invoices.flow.settlement.overpaidBy" : "invoices.flow.settlement.balance")}</dt>
            <dd className="font-semibold">{money(Math.abs(settlement.balance))}</dd>
          </dl>
          <p className="mt-1 text-secondary">{t(`invoices.paymentStatus.${settlement.payment_status}`)}</p>
          {canManage && invoice.kind !== "credit_note" && netPaid > 0 && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-xs text-secondary">
                {t("invoices.flow.settlement.refundLabel")}
                <input inputMode="decimal" className="mt-1 w-32 rounded-doc-sm border border-doc-border bg-surface-1 px-2 py-1 text-right text-sm tabular-nums"
                  value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
              </label>
              <button type="button" disabled={busy || !(Number(refundAmount.replace(",", ".")) > 0)} className="rounded-doc-sm border border-doc-border px-3 py-1"
                onClick={() => run(() => addInvoiceRefund(invoice.id, Number(refundAmount.replace(",", ".")), todayLocalDate(), "bank_transfer", null))}>
                {t("invoices.flow.settlement.refund")}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
