"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import InvoicesIcon from "@/app/components/icons/InvoicesIcon";
import { invoiceDetailHref } from "@/lib/entity-links";
import { isInvoiceOverdue, listInvoices, type Invoice } from "@/lib/invoices";
import { listBusinessPartners, type BusinessPartner } from "@/lib/business-partners";
import {
  DocumentPageShell,
  DocumentHeader,
  DocumentNotice,
  docButtonPrimary,
} from "@/app/components/document/DocumentLayout";
import {
  DocumentStatusBadge,
  DocumentSourceBadge,
} from "@/app/components/document/DocumentStatusBadge";

// Smer je samostatná dimenzia od sekcií. Sekcia "issued" totiž NIKDY
// neznamenala direction='issued' — znamená "finalizovaná riadna faktúra".
// Bez tohto oddelenia by prijaté faktúry ticho padali do sekcií vydaných.
type DirectionFilter = "all" | "issued" | "received";

const DIRECTION_ORDER: DirectionFilter[] = ["all", "issued", "received"];

type SectionKey = "issued" | "drafts" | "unpaid" | "overdue" | "paid" | "corrections";

const SECTION_ORDER: SectionKey[] = ["issued", "drafts", "unpaid", "overdue", "paid", "corrections"];

function matchesDirection(invoice: Invoice, filter: DirectionFilter): boolean {
  if (filter === "all") return true;
  return invoice.direction === filter;
}

function matchesSection(invoice: Invoice, section: SectionKey): boolean {
  switch (section) {
    case "issued":
      return (
        invoice.document_status === "finalized" &&
        (invoice.kind === "regular_invoice" || invoice.kind === "payment_received_invoice")
      );
    case "drafts":
      return invoice.document_status === "draft";
    case "unpaid":
      return invoice.document_status === "finalized" && invoice.payment_status === "unpaid";
    case "overdue":
      return (
        invoice.document_status === "finalized" &&
        isInvoiceOverdue(invoice.due_date, invoice.payment_status)
      );
    case "paid":
      return invoice.document_status === "finalized" && invoice.payment_status === "paid";
    case "corrections":
      return invoice.kind === "credit_note" || invoice.kind === "debit_note";
    default:
      return false;
  }
}

export default function FakturyPage() {
  const { t, locale } = useLocale();
  const { legalHold } = useCompanyDpaLegalHold();

  const [membership, setMembership] = useState<MyActiveMembership | null>(null);
  const [membershipLoaded, setMembershipLoaded] = useState(false);
  const canView = hasFinanceView(membership);
  const canEdit = hasFinanceManage(membership);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [partnersById, setPartnersById] = useState<Record<string, BusinessPartner>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [section, setSection] = useState<SectionKey>("issued");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");

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

    const activeMembership = await getMyActiveMembership();
    setMembership(activeMembership);
    setMembershipLoaded(true);

    if (!activeMembership) {
      setLoading(false);
      return;
    }

    if (!hasFinanceView(activeMembership)) {
      // Bez finance view sú RLS na invoices aj tak 0 riadkov — vynechávame
      // zbytočný fetch a rovno zobrazíme "Nemáte oprávnenie".
      setLoading(false);
      return;
    }

    await loadInvoices(activeMembership.company_id);
  }

  async function loadInvoices(activeCompanyId: string) {
    setLoading(true);
    setLoadError("");

    try {
      const [invoiceRows, partnerRows] = await Promise.all([
        listInvoices(activeCompanyId),
        listBusinessPartners(activeCompanyId),
      ]);
      setInvoices(invoiceRows);
      setPartnersById(Object.fromEntries(partnerRows.map((partner) => [partner.id, partner])));
    } catch (error) {
      console.error("Načítanie faktúr zlyhalo:", error);
      setLoadError(t("invoices.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  // Smerový filter sa aplikuje PRED počítaním sekcií, aby počty v záložkách
  // zodpovedali tomu, čo sa po kliknutí naozaj zobrazí.
  const directionScopedInvoices = useMemo(
    () => invoices.filter((invoice) => matchesDirection(invoice, directionFilter)),
    [invoices, directionFilter]
  );

  const directionCounts = useMemo(() => {
    const counts: Record<DirectionFilter, number> = { all: 0, issued: 0, received: 0 };
    for (const invoice of invoices) {
      counts.all += 1;
      if (invoice.direction === "issued") counts.issued += 1;
      if (invoice.direction === "received") counts.received += 1;
    }
    return counts;
  }, [invoices]);

  const sectionCounts = useMemo(() => {
    const counts: Record<SectionKey, number> = {
      issued: 0,
      drafts: 0,
      unpaid: 0,
      overdue: 0,
      paid: 0,
      corrections: 0,
    };
    for (const invoice of directionScopedInvoices) {
      for (const key of SECTION_ORDER) {
        if (matchesSection(invoice, key)) counts[key] += 1;
      }
    }
    return counts;
  }, [directionScopedInvoices]);

  const filteredInvoices = useMemo(
    () => directionScopedInvoices.filter((invoice) => matchesSection(invoice, section)),
    [directionScopedInvoices, section]
  );

  /**
   * Protistrana podľa smeru: pri vydanej faktúre odberateľ, pri prijatej
   * dodávateľ. Bez tohto rozlíšenia by prijaté faktúry v zozname nemali
   * uvedenú žiadnu firmu (customer_business_partner_id je pri nich vždy NULL).
   */
  function counterpartyName(invoice: Invoice): string {
    const partnerId =
      invoice.direction === "received"
        ? invoice.supplier_business_partner_id
        : invoice.customer_business_partner_id;
    if (!partnerId) return "";
    return partnersById[partnerId]?.legal_name ?? "";
  }

  /**
   * Číslo dokladu podľa smeru. Vydaná faktúra má interné číslo Esblu,
   * prijatá má číslo dodávateľa — fallback "bez čísla (koncept)" by pri
   * finalizovanej prijatej faktúre klamal.
   */
  function invoiceNumberLabel(invoice: Invoice): string {
    if (invoice.direction === "received") {
      return invoice.supplier_invoice_number ?? t("invoices.numberFallback");
    }
    return invoice.invoice_number ?? t("invoices.numberFallback");
  }

  function formatMoney(amount: number, currency: string): string {
    return formatNumber(amount, locale, { style: "currency", currency });
  }

  const createDisabled = !canEdit || legalHold;

  return (
    <DocumentPageShell wide>
      <BackLink href="/" label={t("nav.dashboard")} className="mb-6" />

      <DocumentHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <InvoicesIcon size={18} />
            {t("invoices.title")}
          </span>
        }
        title={t("invoices.register.title")}
        meta={t("invoices.subtitle")}
        aside={
          canView && canEdit ? (
            <Link
              href="/faktury/new"
              aria-disabled={createDisabled}
              onClick={(event) => {
                if (createDisabled) event.preventDefault();
              }}
              className={`${docButtonPrimary} aria-disabled:pointer-events-none aria-disabled:opacity-40`}
            >
              {t("invoices.addButton")}
            </Link>
          ) : undefined
        }
      />

      {!canView && membershipLoaded && (
        <div className="mt-6">
          <DocumentNotice>{t("invoices.noFinanceAccess")}</DocumentNotice>
        </div>
      )}

      {canView && !canEdit && (
        <p className="mt-4 text-sm text-muted-esblu">{t("invoices.readOnlyNotice")}</p>
      )}

      {canView && legalHold && canEdit && (
        <div className="mt-4">
          <DocumentNotice tone="warning">{t("invoices.legalHoldNotice")}</DocumentNotice>
        </div>
      )}

      {canView && (
        <div className="mt-6 space-y-3 rounded-doc border border-doc-border bg-doc-surface p-3 sm:p-4">
          {/* Smer je primárna os registra — dostáva segmented control,
              nie ďalší rad rovnakých piluliek. */}
          <div
            role="tablist"
            aria-label={t("invoices.register.directionFilterLabel")}
            className="inline-flex w-full gap-1 rounded-doc-sm border border-doc-border bg-surface-2 p-1 sm:w-auto"
          >
            {DIRECTION_ORDER.map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={directionFilter === key}
                type="button"
                onClick={() => setDirectionFilter(key)}
                className={`flex-1 whitespace-nowrap rounded-doc-sm px-3 py-1.5 text-sm font-medium transition sm:flex-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan ${
                  directionFilter === key
                    ? "bg-accent-esblu text-on-accent"
                    : "text-secondary hover:text-primary"
                }`}
              >
                {t(`invoices.direction.${key}`)}
                <span className="ml-1.5 tabular-nums opacity-70">{directionCounts[key]}</span>
              </button>
            ))}
          </div>

          {/* Stav je sekundárna os — tichšie, s vodorovným scrollom na mobile. */}
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {SECTION_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={section === key}
                onClick={() => setSection(key)}
                className={`whitespace-nowrap rounded-doc-sm border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan ${
                  section === key
                    ? "border-border-strong bg-surface-hover text-primary"
                    : "border-doc-border text-secondary hover:text-primary"
                }`}
              >
                {t(`invoices.sections.${key}`)}
                <span className="ml-1.5 tabular-nums opacity-70">{sectionCounts[key]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {canView && (
        <div className="mt-4">
          {loading ? (
            <p className="text-sm text-secondary">{t("invoices.loading")}</p>
          ) : loadError ? (
            <DocumentNotice tone="critical">{loadError}</DocumentNotice>
          ) : filteredInvoices.length === 0 ? (
            <div className="rounded-doc border border-dashed border-doc-border px-6 py-12 text-center text-sm text-muted-esblu">
              {t("invoices.empty")}
            </div>
          ) : (
            <>
              {/* Desktop: hlavička registra. Na mobile sa skrýva — riadok
                  je tam čitateľný sám osebe. */}
              <div className="hidden border-b border-doc-border px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-esblu sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4">
                <span>{t("invoices.register.colDocument")}</span>
                <span>{t("invoices.register.colCounterparty")}</span>
                <span className="text-right">{t("invoices.register.colTotal")}</span>
                <span className="text-right">{t("invoices.register.colStatus")}</span>
              </div>

              <ul className="mt-2 space-y-1.5">
                {filteredInvoices.map((invoice) => {
                  const overdue = isInvoiceOverdue(invoice.due_date, invoice.payment_status);
                  return (
                    <li key={invoice.id}>
                      <Link
                        href={invoiceDetailHref(invoice.id)}
                        className="block rounded-doc border border-doc-border bg-doc-surface px-4 py-3 transition hover:border-border-strong hover:bg-doc-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-medium text-primary">
                              {invoiceNumberLabel(invoice)}
                            </span>
                            <DocumentStatusBadge
                              kind={invoice.direction === "received" ? "received" : "issued"}
                            />
                          </div>
                          <p className="mt-0.5 truncate text-xs text-muted-esblu">
                            {t(`invoices.kind.${invoice.kind}`)} ·{" "}
                            {formatDate(invoice.issue_date, locale)}
                            {invoice.due_date
                              ? ` · ${t("invoices.register.dueShort")} ${formatDate(invoice.due_date, locale)}`
                              : ""}
                          </p>
                        </div>

                        <div className="mt-1.5 min-w-0 sm:mt-0">
                          <p className="truncate text-sm text-secondary">
                            {counterpartyName(invoice) || "—"}
                          </p>
                          {invoice.source !== "manual" && (
                            <div className="mt-0.5">
                              <DocumentSourceBadge source={invoice.source} />
                            </div>
                          )}
                        </div>

                        <p className="mt-1.5 text-sm font-semibold tabular-nums text-primary sm:mt-0 sm:text-right">
                          {formatMoney(invoice.total_amount, invoice.currency)}
                        </p>

                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 sm:mt-0 sm:justify-end">
                          {invoice.document_status === "draft" ? (
                            <DocumentStatusBadge kind="draft" />
                          ) : (
                            <DocumentStatusBadge kind={invoice.payment_status} />
                          )}
                          {overdue && <DocumentStatusBadge kind="overdue" />}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </DocumentPageShell>
  );
}
