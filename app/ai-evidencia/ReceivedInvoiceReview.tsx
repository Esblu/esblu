"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatNumber } from "@/lib/i18n/format";
import { invoiceDetailHref } from "@/lib/entity-links";
import {
  createSupplierFromReview,
  listBusinessPartners,
  BUSINESS_PARTNER_DUPLICATE_ICO_ERROR,
  type BusinessPartner,
} from "@/lib/business-partners";
import {
  createReceivedInvoiceDraft,
  listInvoices,
  parseFinalizeErrorCode,
  type Invoice,
} from "@/lib/invoices";
import {
  computeInvoiceTotals,
  VAT_CATEGORY_CODES,
  type VatCategoryCode,
} from "@/lib/invoicing/vat-engine";
import {
  compareCandidateTotals,
  type ReceivedInvoiceCandidate,
} from "@/lib/invoicing/received-candidate";
import {
  buildDedupeVerdict,
  computeDedupeFingerprint,
  type DedupeVerdict,
} from "@/lib/invoicing/received-dedupe";
import {
  findDeterministicDuplicate,
  matchSupplier,
  type SupplierMatchResult,
} from "@/lib/invoicing/supplier-matching";
import {
  DocumentModal,
  DocumentSection,
  DocumentNotice,
  DocumentTotalsBlock,
  docButtonPrimary,
  docButtonSecondary,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";

// =============================================================================
// Review obrazovka prijatej faktúry.
//
// Toto je miesto, kde sa z KANDIDÁTA stáva canonical faktúra — a jediné
// miesto, kde do toho vstupuje človek. Preto:
//
//   • Nič sa neodosiela bez explicitného potvrdenia. Žiadny auto-finalize,
//     žiadne auto-vytvorenie dodávateľa.
//   • VAT kategória, ktorú AI nevedela určiť, ostáva prázdna a BLOKUJE
//     odoslanie. Predvyplniť ju čímkoľvek by znamenalo, že používateľ
//     potvrdí daňovú kvalifikáciu, ktorú nikdy nevidel.
//   • Sumy z dokumentu sa NIKDY nezapisujú. Zobrazujú sa vedľa canonical
//     prepočtu z riadkov ako porovnanie; rozdiel je varovanie, nie oprava.
//   • Exact duplicate blokuje, near duplicate varuje.
//
// Komponent je zámerne samostatný súbor, nie ďalších 700 riadkov v už
// 3800-riadkovej Inbox stránke.
// =============================================================================

type EditableItem = {
  key: string;
  description: string;
  quantity: string;
  unit: string;
  unitCode: string;
  unitPrice: string;
  /** "" = AI kategóriu neurčila a používateľ ju ešte nepotvrdil. */
  vatCategory: VatCategoryCode | "";
  vatRate: string;
};

type Props = {
  candidate: ReceivedInvoiceCandidate;
  companyId: string;
  userId: string;
  onCancel: () => void;
  onCreated: (invoiceId: string) => void;
};

let itemKeySeq = 0;
function nextItemKey(): string {
  itemKeySeq += 1;
  return `item-${itemKeySeq}`;
}

function toEditableItems(candidate: ReceivedInvoiceCandidate): EditableItem[] {
  if (candidate.items.length === 0) {
    return [
      {
        key: nextItemKey(),
        description: "",
        quantity: "1",
        unit: "ks",
        unitCode: "",
        unitPrice: "",
        vatCategory: "",
        vatRate: "",
      },
    ];
  }

  return candidate.items.map((item) => ({
    key: nextItemKey(),
    description: item.description ?? "",
    quantity: item.quantity === null ? "" : String(item.quantity),
    unit: item.unit ?? "ks",
    // unit_code_suggested sa zámerne NEPREDVYPLŇUJE do canonical poľa —
    // zobrazuje sa len ako návrh a používateľ ho musí prepísať do unitCode,
    // ak ho chce použiť. Voľný text jednotky nikdy nie je kanonický kód.
    unitCode: "",
    unitPrice: item.unit_price === null ? "" : String(item.unit_price),
    vatCategory: item.vat_category_suggested ?? "",
    vatRate: item.vat_rate_suggested === null ? "" : String(item.vat_rate_suggested),
  }));
}

function parseDecimal(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function ReceivedInvoiceReview({
  candidate,
  companyId,
  userId,
  onCancel,
  onCreated,
}: Props) {
  const { t, locale } = useLocale();

  const [partners, setPartners] = useState<BusinessPartner[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [supplierMatch, setSupplierMatch] = useState<SupplierMatchResult | null>(null);
  const [supplierId, setSupplierId] = useState<string>("");

  const [showCreateSupplier, setShowCreateSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState(candidate.supplier.legal_name ?? "");
  const [newSupplierIco, setNewSupplierIco] = useState(candidate.supplier.ico ?? "");
  const [newSupplierDic, setNewSupplierDic] = useState(candidate.supplier.dic ?? "");
  const [newSupplierVatId, setNewSupplierVatId] = useState(
    candidate.supplier.vat_identifier ?? candidate.supplier.ic_dph ?? ""
  );
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [supplierError, setSupplierError] = useState<string | null>(null);

  const [invoiceNumber, setInvoiceNumber] = useState(candidate.supplier_invoice_number ?? "");
  const [issueDate, setIssueDate] = useState(candidate.issue_date ?? "");
  const [dueDate, setDueDate] = useState(candidate.due_date ?? "");
  const [deliveryDate, setDeliveryDate] = useState(candidate.delivery_date ?? "");
  const [taxPointDate, setTaxPointDate] = useState(candidate.tax_point_date ?? "");
  const [currency, setCurrency] = useState(candidate.currency ?? "EUR");
  const [iban, setIban] = useState(candidate.iban ?? "");
  const [bic, setBic] = useState(candidate.bic ?? "");
  const [variableSymbol, setVariableSymbol] = useState(candidate.variable_symbol ?? "");
  const [paymentReference, setPaymentReference] = useState(candidate.payment_reference ?? "");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));

  const [items, setItems] = useState<EditableItem[]>(() => toEditableItems(candidate));

  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicateInvoiceId, setDuplicateInvoiceId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Načítanie master data + spustenie supplier matchingu
  // ---------------------------------------------------------------------------
  // Zámerne BEZ synchrónneho setLoading(true) na začiatku: efekt nižšie ho
  // volá priamo pri mounte a synchrónny setState v efekte spúšťa kaskádový
  // render (react-hooks/set-state-in-effect). Počiatočný stav už je
  // loading=true, takže indikátor sa zobrazí správne aj bez toho.
  const loadContext = useCallback(async () => {
    try {
      const [partnerRows, invoiceRows] = await Promise.all([
        listBusinessPartners(companyId),
        listInvoices(companyId),
      ]);
      setPartners(partnerRows);
      setInvoices(invoiceRows);

      const match = matchSupplier(candidate.supplier, partnerRows);
      setSupplierMatch(match);
      // Predvyplní sa VÝHRADNE deterministická zhoda. "probable" (zhoda len
      // podľa mena) a "ambiguous" nechávajú výber na používateľa.
      setSupplierId(match.autoSelected?.id ?? "");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [candidate.supplier, companyId]);

  useEffect(() => {
    // setTimeout(…, 0) je zavedený vzor tohto repa pre efekty, ktoré musia
    // zapisovať stav (react-hooks/set-state-in-effect) — rovnako ako
    // ?openDocument / ?openEvidence handlery v app/ai-evidencia/page.tsx.
    // Odloží prvý setState mimo render commit, takže nevzniká kaskádový render.
    const handle = setTimeout(() => {
      void loadContext();
    }, 0);
    return () => clearTimeout(handle);
  }, [loadContext]);

  // ---------------------------------------------------------------------------
  // Canonical prepočet z riadkov (nikdy nie zo súm v dokumente)
  // ---------------------------------------------------------------------------
  const resolvedItems = useMemo(
    () =>
      items
        .map((item) => {
          const quantity = parseDecimal(item.quantity);
          const unitPrice = parseDecimal(item.unitPrice);
          if (!item.description.trim() || quantity === null || unitPrice === null) return null;
          if (item.vatCategory === "") return null;
          const rate = item.vatCategory === "S" ? parseDecimal(item.vatRate) : 0;
          if (rate === null) return null;
          return {
            item,
            quantity,
            unitPrice,
            vatCategoryCode: item.vatCategory,
            vatRate: rate,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
    [items]
  );

  const totals = useMemo(
    () =>
      computeInvoiceTotals(
        resolvedItems.map((row) => ({
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          vatCategoryCode: row.vatCategoryCode,
          vatRate: row.vatRate,
        }))
      ),
    [resolvedItems]
  );

  const canonicalTotal = Number(totals.totalAmount);

  const totalsComparison = useMemo(
    () => compareCandidateTotals(candidate.document_totals?.total ?? null, canonicalTotal),
    [candidate.document_totals, canonicalTotal]
  );

  // ---------------------------------------------------------------------------
  // Dedupe — fingerprint sa prepočítava pri každej zmene identity dokladu
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const selected = partners.find((partner) => partner.id === supplierId) ?? null;

    void computeDedupeFingerprint({
      supplier: selected
        ? {
            ...candidate.supplier,
            ico: selected.ico ?? null,
            ic_dph: selected.ic_dph ?? null,
            vat_identifier: selected.vat_identifier ?? selected.ic_dph ?? null,
            legal_registration_id: selected.legal_registration_id ?? null,
            legal_registration_scheme_id: selected.legal_registration_scheme_id ?? null,
          }
        : candidate.supplier,
      supplierInvoiceNumber: invoiceNumber,
      issueDate: issueDate || null,
      canonicalTotal: resolvedItems.length > 0 ? canonicalTotal : null,
      currency,
      kind: "regular_invoice",
    }).then((value) => {
      if (!cancelled) setFingerprint(value);
    });

    return () => {
      cancelled = true;
    };
  }, [
    candidate.supplier,
    partners,
    supplierId,
    invoiceNumber,
    issueDate,
    canonicalTotal,
    currency,
    resolvedItems.length,
  ]);

  const dedupe: DedupeVerdict = useMemo(
    () =>
      buildDedupeVerdict({
        invoices,
        candidate: {
          supplier_invoice_number: invoiceNumber,
          issue_date: issueDate || null,
          currency,
        },
        supplierBusinessPartnerId: supplierId || null,
        dedupeFingerprint: fingerprint,
        sourceDocumentId: candidate.source_document_id,
        canonicalTotal: resolvedItems.length > 0 ? canonicalTotal : null,
      }),
    [
      invoices,
      invoiceNumber,
      issueDate,
      currency,
      supplierId,
      fingerprint,
      candidate.source_document_id,
      canonicalTotal,
      resolvedItems.length,
    ]
  );

  // ---------------------------------------------------------------------------
  // Validácia pred odoslaním
  // ---------------------------------------------------------------------------
  const unresolvedVatRows = items.filter((item) => {
    if (!item.description.trim()) return false;
    if (item.vatCategory === "") return true;
    if (item.vatCategory === "S" && parseDecimal(item.vatRate) === null) return true;
    return false;
  });

  const blockingReasons = useMemo(() => {
    const reasons: string[] = [];
    if (!supplierId) reasons.push(t("inbox.receivedInvoice.validation.supplierRequired"));
    if (!invoiceNumber.trim()) reasons.push(t("inbox.receivedInvoice.validation.numberRequired"));
    if (!issueDate) reasons.push(t("inbox.receivedInvoice.validation.issueDateRequired"));
    if (resolvedItems.length === 0) {
      reasons.push(t("inbox.receivedInvoice.validation.itemsRequired"));
    }
    if (unresolvedVatRows.length > 0) {
      reasons.push(t("inbox.receivedInvoice.validation.vatUnresolved"));
    }
    if (dedupe.exact) reasons.push(t("inbox.receivedInvoice.validation.exactDuplicate"));
    return reasons;
  }, [
    supplierId,
    invoiceNumber,
    issueDate,
    resolvedItems.length,
    unresolvedVatRows.length,
    dedupe.exact,
    t,
  ]);

  const canSubmit = blockingReasons.length === 0 && !submitting && !loading;

  // ---------------------------------------------------------------------------
  // Vytvorenie nového dodávateľa
  // ---------------------------------------------------------------------------
  async function handleCreateSupplier() {
    const name = newSupplierName.trim();
    if (!name) {
      setSupplierError(t("inbox.receivedInvoice.supplier.nameRequired"));
      return;
    }

    setCreatingSupplier(true);
    setSupplierError(null);
    try {
      // Medzi otvorením review a týmto kliknutím mohol partnera založiť
      // niekto iný. Čerstvý zoznam + deterministický re-check je jediná
      // obrana proti tichému duplikátu v master data.
      const freshPartners = await listBusinessPartners(companyId);
      setPartners(freshPartners);

      const existing = findDeterministicDuplicate(
        {
          ...candidate.supplier,
          legal_name: name,
          ico: newSupplierIco.trim() || null,
          ic_dph: newSupplierVatId.trim() || null,
          vat_identifier: newSupplierVatId.trim() || null,
        },
        freshPartners
      );

      if (existing) {
        setSupplierId(existing.id);
        setShowCreateSupplier(false);
        setSupplierError(
          t("inbox.receivedInvoice.supplier.alreadyExists", { name: existing.legal_name })
        );
        return;
      }

      const created = await createSupplierFromReview(companyId, userId, {
        legal_name: name,
        ico: newSupplierIco.trim() || null,
        dic: newSupplierDic.trim() || null,
        ic_dph: newSupplierVatId.trim() || null,
        vat_identifier: newSupplierVatId.trim() || null,
        address_line1: candidate.supplier.address_line1,
        city: candidate.supplier.city,
        postal_code: candidate.supplier.postal_code,
        country_code: candidate.supplier.country_code,
        email: candidate.supplier.email,
      });

      setPartners((current) => [...current, created]);
      setSupplierId(created.id);
      setShowCreateSupplier(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSupplierError(
        message === BUSINESS_PARTNER_DUPLICATE_ICO_ERROR
          ? t("inbox.receivedInvoice.supplier.duplicateIco")
          : message
      );
    } finally {
      setCreatingSupplier(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Odoslanie — vytvorí DRAFT, nikdy nefinalizuje
  // ---------------------------------------------------------------------------
  async function handleSubmit() {
    if (!canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);
    setDuplicateInvoiceId(null);

    try {
      const result = await createReceivedInvoiceDraft({
        supplier_business_partner_id: supplierId,
        supplier_invoice_number: invoiceNumber.trim(),
        issue_date: issueDate,
        due_date: dueDate || null,
        delivery_date: deliveryDate || null,
        tax_point_date: taxPointDate || null,
        currency: currency.trim().toUpperCase() || "EUR",
        iban: iban.trim() || null,
        bic: bic.trim() || null,
        variable_symbol: variableSymbol.trim() || null,
        payment_reference: paymentReference.trim() || null,
        buyer_reference: candidate.buyer_reference,
        purchase_order_reference: candidate.purchase_order_reference,
        received_at: receivedAt || null,
        source_document_id: candidate.source_document_id,
        dedupe_fingerprint: fingerprint,
        items: resolvedItems.map((row) => ({
          description: row.item.description.trim(),
          quantity: row.quantity,
          unit: row.item.unit.trim() || "ks",
          unit_code: row.item.unitCode.trim() || null,
          unit_price: row.unitPrice,
          vat_category_code: row.vatCategoryCode,
          vat_rate: row.vatRate,
        })),
      });

      if (result.status === "duplicate") {
        // Server dedupe zachytil to, čo klientský pre-check nemohol (súbežné
        // potvrdenie v inej karte). Druhá faktúra nevznikla.
        setDuplicateInvoiceId(result.existing_invoice_id);
        setSubmitError(t("inbox.receivedInvoice.duplicate.serverBlocked"));
        return;
      }

      onCreated(result.invoice_id);
    } catch (error) {
      const code = parseFinalizeErrorCode(error);
      setSubmitError(
        code
          ? t(`invoices.errors.${code}`)
          : error instanceof Error
            ? error.message
            : String(error)
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const selectedPartner = partners.find((partner) => partner.id === supplierId) ?? null;

  function updateItem(key: string, patch: Partial<EditableItem>) {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item))
    );
  }

  const money = (value: string | number) =>
    `${formatNumber(Number(value), locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currency || "EUR"}`;

  // Zdieľané s ostatnými dokumentovými plochami — tento komponent bol jediný
  // v appke, ktorý používal cudziu slate/dark paletu namiesto design systému.
  const fieldClass = docField;
  const labelClass = docLabel;

  // Akcie žijú v pätičke modálu, aby ostali dosiahnuteľné aj pri dlhom
  // formulári bez skrolovania na koniec.
  const actionFooter =
    loading || loadError ? null : (
      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} className={docButtonSecondary}>
            {t("common.buttons.cancel")}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            className={docButtonPrimary}
          >
            {submitting
              ? t("inbox.receivedInvoice.submitting")
              : t("inbox.receivedInvoice.submit")}
          </button>
        </div>
        <p className="text-center text-xs text-muted-esblu">
          {t("inbox.receivedInvoice.draftOnlyNote")}
        </p>
      </div>
    );

  return (
    <DocumentModal
      title={t("inbox.receivedInvoice.title")}
      onClose={onCancel}
      closeLabel={t("common.buttons.close")}
      size="xl"
      footer={actionFooter}
    >
      <p className="text-sm text-muted-esblu">
        {t("inbox.receivedInvoice.subtitle")}
      </p>

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-esblu">
          {t("inbox.receivedInvoice.loading")}
        </p>
      ) : loadError ? (
        <DocumentNotice tone="critical">{loadError}</DocumentNotice>
      ) : (
        <div className="space-y-5">
          {/* ---------------- DUPLICITA ---------------- */}
          {dedupe.exact && (
            <DocumentNotice
              tone="critical"
              title={t("inbox.receivedInvoice.duplicate.exactTitle")}
            >
              <p>{t(`inbox.receivedInvoice.duplicate.reason.${dedupe.exact.reason}`)}</p>
              <Link
                href={invoiceDetailHref(dedupe.exact.invoice.id)}
                className="mt-2 inline-block font-medium underline"
              >
                {t("inbox.receivedInvoice.duplicate.openExisting")}
              </Link>
            </DocumentNotice>
          )}

          {!dedupe.exact && dedupe.near.length > 0 && (
            <DocumentNotice
              tone="warning"
              title={t("inbox.receivedInvoice.duplicate.nearTitle")}
            >
              <ul className="space-y-1">
                {dedupe.near.slice(0, 3).map((near) => (
                  <li key={near.invoice.id} className="text-sm text-warning">
                    <Link
                      href={invoiceDetailHref(near.invoice.id)}
                      className="underline"
                    >
                      {near.invoice.supplier_invoice_number ??
                        near.invoice.invoice_number ??
                        near.invoice.id.slice(0, 8)}
                    </Link>{" "}
                    · {near.invoice.issue_date} · {money(near.invoice.total_amount)}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">
                {t("inbox.receivedInvoice.duplicate.nearHint")}
              </p>
            </DocumentNotice>
          )}

          {dedupe.fingerprintUnavailable && (
            <p className="rounded-doc border border-doc-border bg-surface-2 p-3 text-xs text-muted-esblu">
              {t("inbox.receivedInvoice.duplicate.fingerprintUnavailable")}
            </p>
          )}

          {/* ---------------- DODÁVATEĽ ---------------- */}
          <DocumentSection title={t("inbox.receivedInvoice.supplier.title")}>

            {supplierMatch && (
              <p
                className={`mb-3 rounded-doc-sm px-3 py-2 text-xs ${
                  supplierMatch.status === "exact"
                    ? "bg-success-soft text-success"
                    : "bg-warning-soft text-warning"
                }`}
              >
                {t(`inbox.receivedInvoice.supplier.match.${supplierMatch.status}`, {
                  name: candidate.supplier.legal_name ?? "—",
                  count: String(supplierMatch.matches.length),
                })}
              </p>
            )}

            <label className={labelClass} htmlFor="received-supplier">
              {t("inbox.receivedInvoice.supplier.selectLabel")}
            </label>
            <select
              id="received-supplier"
              className={fieldClass}
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">{t("inbox.receivedInvoice.supplier.selectPlaceholder")}</option>
              {partners.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {partner.legal_name}
                  {partner.ico ? ` · ${partner.ico}` : ""}
                </option>
              ))}
            </select>

            {candidate.supplier.legal_name && (
              <p className="mt-2 text-xs text-muted-esblu">
                {t("inbox.receivedInvoice.supplier.fromDocument", {
                  name: candidate.supplier.legal_name,
                  ico: candidate.supplier.ico ?? "—",
                  vat: candidate.supplier.vat_identifier ?? candidate.supplier.ic_dph ?? "—",
                })}
              </p>
            )}

            {!showCreateSupplier ? (
              <button
                type="button"
                onClick={() => setShowCreateSupplier(true)}
                className={`mt-3 ${docButtonSecondary}`}
              >
                {t("inbox.receivedInvoice.supplier.createButton")}
              </button>
            ) : (
              <div className="mt-3 space-y-3 rounded-doc-sm border border-doc-border bg-surface-2 p-3">
                <p className="text-xs text-secondary">
                  {t("inbox.receivedInvoice.supplier.createHint")}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="new-supplier-name">
                      {t("inbox.receivedInvoice.supplier.nameLabel")}
                    </label>
                    <input
                      id="new-supplier-name"
                      className={fieldClass}
                      value={newSupplierName}
                      onChange={(event) => setNewSupplierName(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="new-supplier-ico">
                      {t("inbox.receivedInvoice.supplier.icoLabel")}
                    </label>
                    <input
                      id="new-supplier-ico"
                      className={fieldClass}
                      value={newSupplierIco}
                      onChange={(event) => setNewSupplierIco(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="new-supplier-dic">
                      {t("inbox.receivedInvoice.supplier.dicLabel")}
                    </label>
                    <input
                      id="new-supplier-dic"
                      className={fieldClass}
                      value={newSupplierDic}
                      onChange={(event) => setNewSupplierDic(event.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="new-supplier-vat">
                      {t("inbox.receivedInvoice.supplier.vatLabel")}
                    </label>
                    <input
                      id="new-supplier-vat"
                      className={fieldClass}
                      value={newSupplierVatId}
                      onChange={(event) => setNewSupplierVatId(event.target.value)}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    disabled={creatingSupplier}
                    onClick={() => void handleCreateSupplier()}
                    className={docButtonPrimary}
                  >
                    {creatingSupplier
                      ? t("inbox.receivedInvoice.supplier.creating")
                      : t("inbox.receivedInvoice.supplier.confirmCreate")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateSupplier(false);
                      setSupplierError(null);
                    }}
                    className={docButtonSecondary}
                  >
                    {t("common.buttons.cancel")}
                  </button>
                </div>
              </div>
            )}

            {supplierError && (
              <p className="mt-2 text-sm text-warning">{supplierError}</p>
            )}
          </DocumentSection>

          {/* ---------------- HLAVIČKA ---------------- */}
          <DocumentSection title={t("inbox.receivedInvoice.header.title")}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor="received-number">
                  {t("inbox.receivedInvoice.header.numberLabel")}
                </label>
                <input
                  id="received-number"
                  className={fieldClass}
                  value={invoiceNumber}
                  onChange={(event) => setInvoiceNumber(event.target.value)}
                />
                <p className="mt-1 text-xs text-muted-esblu">
                  {t("inbox.receivedInvoice.header.numberHint")}
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="received-issue">
                  {t("inbox.receivedInvoice.header.issueDateLabel")}
                </label>
                <input
                  id="received-issue"
                  type="date"
                  className={fieldClass}
                  value={issueDate}
                  onChange={(event) => setIssueDate(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-due">
                  {t("inbox.receivedInvoice.header.dueDateLabel")}
                </label>
                <input
                  id="received-due"
                  type="date"
                  className={fieldClass}
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-delivery">
                  {t("inbox.receivedInvoice.header.deliveryDateLabel")}
                </label>
                <input
                  id="received-delivery"
                  type="date"
                  className={fieldClass}
                  value={deliveryDate}
                  onChange={(event) => setDeliveryDate(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-taxpoint">
                  {t("inbox.receivedInvoice.header.taxPointDateLabel")}
                </label>
                <input
                  id="received-taxpoint"
                  type="date"
                  className={fieldClass}
                  value={taxPointDate}
                  onChange={(event) => setTaxPointDate(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-received-at">
                  {t("inbox.receivedInvoice.header.receivedAtLabel")}
                </label>
                <input
                  id="received-received-at"
                  type="date"
                  className={fieldClass}
                  value={receivedAt}
                  onChange={(event) => setReceivedAt(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-currency">
                  {t("inbox.receivedInvoice.header.currencyLabel")}
                </label>
                <input
                  id="received-currency"
                  className={fieldClass}
                  value={currency}
                  maxLength={3}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-iban">
                  {t("inbox.receivedInvoice.header.ibanLabel")}
                </label>
                <input
                  id="received-iban"
                  className={fieldClass}
                  value={iban}
                  onChange={(event) => setIban(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-bic">
                  {t("inbox.receivedInvoice.header.bicLabel")}
                </label>
                <input
                  id="received-bic"
                  className={fieldClass}
                  value={bic}
                  onChange={(event) => setBic(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-vs">
                  {t("inbox.receivedInvoice.header.variableSymbolLabel")}
                </label>
                <input
                  id="received-vs"
                  className={fieldClass}
                  value={variableSymbol}
                  onChange={(event) => setVariableSymbol(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="received-payref">
                  {t("inbox.receivedInvoice.header.paymentReferenceLabel")}
                </label>
                <input
                  id="received-payref"
                  className={fieldClass}
                  value={paymentReference}
                  onChange={(event) => setPaymentReference(event.target.value)}
                />
              </div>
            </div>
          </DocumentSection>

          {/* ---------------- POLOŽKY ---------------- */}
          <DocumentSection
            title={t("inbox.receivedInvoice.items.title")}
            actions={
              <button
                type="button"
                onClick={() =>
                  setItems((current) => [
                    ...current,
                    {
                      key: nextItemKey(),
                      description: "",
                      quantity: "1",
                      unit: "ks",
                      unitCode: "",
                      unitPrice: "",
                      vatCategory: "",
                      vatRate: "",
                    },
                  ])
                }
                className={docButtonSecondary}
              >
                {t("inbox.receivedInvoice.items.addRow")}
              </button>
            }
          >

            {unresolvedVatRows.length > 0 && (
              <p className="mb-3 rounded-doc-sm bg-warning-soft px-3 py-2 text-xs text-warning">
                {t("inbox.receivedInvoice.items.vatUnresolvedHint")}
              </p>
            )}

            <div className="space-y-3">
              {items.map((item, index) => (
                <div
                  key={item.key}
                  className="rounded-doc-sm border border-doc-border bg-surface-2 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-esblu">
                      {index + 1}.
                    </span>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setItems((current) => current.filter((row) => row.key !== item.key))
                        }
                        className="text-xs text-danger hover:underline"
                      >
                        {t("inbox.receivedInvoice.items.removeRow")}
                      </button>
                    )}
                  </div>

                  <label className={labelClass} htmlFor={`${item.key}-desc`}>
                    {t("inbox.receivedInvoice.items.descriptionLabel")}
                  </label>
                  <input
                    id={`${item.key}-desc`}
                    className={fieldClass}
                    value={item.description}
                    onChange={(event) =>
                      updateItem(item.key, { description: event.target.value })
                    }
                  />

                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div>
                      <label className={labelClass} htmlFor={`${item.key}-qty`}>
                        {t("inbox.receivedInvoice.items.quantityLabel")}
                      </label>
                      <input
                        id={`${item.key}-qty`}
                        inputMode="decimal"
                        className={fieldClass}
                        value={item.quantity}
                        onChange={(event) =>
                          updateItem(item.key, { quantity: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor={`${item.key}-unit`}>
                        {t("inbox.receivedInvoice.items.unitLabel")}
                      </label>
                      <input
                        id={`${item.key}-unit`}
                        className={fieldClass}
                        value={item.unit}
                        onChange={(event) => updateItem(item.key, { unit: event.target.value })}
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor={`${item.key}-price`}>
                        {t("inbox.receivedInvoice.items.unitPriceLabel")}
                      </label>
                      <input
                        id={`${item.key}-price`}
                        inputMode="decimal"
                        className={fieldClass}
                        value={item.unitPrice}
                        onChange={(event) =>
                          updateItem(item.key, { unitPrice: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor={`${item.key}-vatcat`}>
                        {t("inbox.receivedInvoice.items.vatCategoryLabel")}
                      </label>
                      <select
                        id={`${item.key}-vatcat`}
                        className={fieldClass}
                        value={item.vatCategory}
                        onChange={(event) => {
                          const value = event.target.value as VatCategoryCode | "";
                          updateItem(item.key, {
                            vatCategory: value,
                            // Pre Z/E/AE je sadzba technicky 0 — kategória
                            // sama určuje, že DPH je nulová.
                            vatRate: value === "S" ? item.vatRate : "0",
                          });
                        }}
                      >
                        <option value="">
                          {t("inbox.receivedInvoice.items.vatCategoryPlaceholder")}
                        </option>
                        {VAT_CATEGORY_CODES.map((code) => (
                          <option key={code} value={code}>
                            {t(`invoices.newInvoice.vatCategory.${code}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {item.vatCategory === "S" && (
                    <div className="mt-2 max-w-[10rem]">
                      <label className={labelClass} htmlFor={`${item.key}-vatrate`}>
                        {t("inbox.receivedInvoice.items.vatRateLabel")}
                      </label>
                      <input
                        id={`${item.key}-vatrate`}
                        inputMode="decimal"
                        className={fieldClass}
                        value={item.vatRate}
                        onChange={(event) =>
                          updateItem(item.key, { vatRate: event.target.value })
                        }
                      />
                    </div>
                  )}

                  {item.unitCode === "" &&
                    candidate.items[index]?.unit_code_suggested && (
                      <p className="mt-2 text-xs text-muted-esblu">
                        {t("inbox.receivedInvoice.items.unitCodeSuggestion", {
                          code: candidate.items[index]?.unit_code_suggested ?? "",
                        })}{" "}
                        <button
                          type="button"
                          className="underline"
                          onClick={() =>
                            updateItem(item.key, {
                              unitCode: candidate.items[index]?.unit_code_suggested ?? "",
                            })
                          }
                        >
                          {t("inbox.receivedInvoice.items.unitCodeAccept")}
                        </button>
                      </p>
                    )}
                </div>
              ))}
            </div>
          </DocumentSection>

          {/* ---------------- SÚČTY ---------------- */}
          <DocumentSection title={t("inbox.receivedInvoice.totals.title")}>
            {/* Canonical prepočet z riadkov. Suma z dokumentu sa NIKDY
                nezapisuje — nižšie sa len porovnáva. */}
            <DocumentTotalsBlock
              rows={[
                {
                  label: t("invoices.newInvoice.subtotalLabel"),
                  value: money(totals.subtotalAmount),
                },
                {
                  label: t("invoices.newInvoice.vatTotalLabel"),
                  value: money(totals.vatTotalAmount),
                },
              ]}
              total={{
                label: t("inbox.receivedInvoice.totals.computed"),
                value: money(totals.totalAmount),
              }}
            />

            {totalsComparison.documentTotal !== null && (
              <p
                className={`mt-3 rounded-doc-sm px-3 py-2 text-xs ${
                  totalsComparison.mismatch
                    ? "bg-warning-soft text-warning"
                    : "bg-success-soft text-success"
                }`}
              >
                {t(
                  totalsComparison.mismatch
                    ? "inbox.receivedInvoice.totals.mismatch"
                    : "inbox.receivedInvoice.totals.match",
                  {
                    document: money(totalsComparison.documentTotal),
                    computed: money(totalsComparison.computedTotal),
                  }
                )}
              </p>
            )}
          </DocumentSection>

          {/* ---------------- CHYBY + AKCIE ---------------- */}
          {blockingReasons.length > 0 && (
            <ul className="space-y-1 rounded-doc border border-doc-border bg-surface-2 p-3 text-xs text-secondary">
              {blockingReasons.map((reason) => (
                <li key={reason}>• {reason}</li>
              ))}
            </ul>
          )}

          {submitError && (
            <DocumentNotice tone="critical">
              <p>{submitError}</p>
              {duplicateInvoiceId && (
                <Link
                  href={invoiceDetailHref(duplicateInvoiceId)}
                  className="mt-1 inline-block font-medium underline"
                >
                  {t("inbox.receivedInvoice.duplicate.openExisting")}
                </Link>
              )}
            </DocumentNotice>
          )}

          {selectedPartner && <p className="sr-only">{selectedPartner.legal_name}</p>}
        </div>
      )}
    </DocumentModal>
  );
}
