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
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-6 sm:px-6">
      <BackLink href="/" label={t("nav.dashboard")} className="mb-6" />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <InvoicesIcon size={32} />
          <div>
            <h1 className="text-2xl font-bold text-primary">{t("invoices.title")}</h1>
            <p className="text-sm text-secondary">{t("invoices.subtitle")}</p>
          </div>
        </div>

        {canView && canEdit && (
          <Link
            href="/faktury/new"
            aria-disabled={createDisabled}
            onClick={(event) => {
              if (createDisabled) event.preventDefault();
            }}
            className="rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 aria-disabled:pointer-events-none aria-disabled:bg-gray-400"
          >
            {t("invoices.addButton")}
          </Link>
        )}
      </div>

      {!canView && membershipLoaded && (
        <p className="mt-3 rounded-2xl border border-subtle bg-surface-1 p-6 text-center text-secondary">
          {t("invoices.noFinanceAccess")}
        </p>
      )}

      {canView && !canEdit && (
        <p className="mt-3 text-sm text-secondary">{t("invoices.readOnlyNotice")}</p>
      )}

      {canView && legalHold && canEdit && (
        <p className="mt-3 text-sm font-semibold text-amber-600">
          {t("invoices.legalHoldNotice")}
        </p>
      )}

      {canView && (
        <div className="mt-6 flex flex-wrap gap-2">
          {DIRECTION_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setDirectionFilter(key)}
              className={`rounded-full border px-4 py-2 text-sm font-bold transition ${
                directionFilter === key
                  ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                  : "border-subtle bg-surface-1 text-secondary hover:text-primary"
              }`}
            >
              {t(`invoices.direction.${key}`)} ({directionCounts[key]})
            </button>
          ))}
        </div>
      )}

      {canView && (
        <div className="mt-3 flex flex-wrap gap-2">
          {SECTION_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                section === key
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-subtle bg-surface-1 text-secondary hover:text-primary"
              }`}
            >
              {t(`invoices.sections.${key}`)} ({sectionCounts[key]})
            </button>
          ))}
        </div>
      )}

      {canView && (
        <div className="mt-6">
          {loading ? (
            <p className="text-sm text-secondary">{t("invoices.loading")}</p>
          ) : loadError ? (
            <p className="text-sm font-semibold text-red-600">{loadError}</p>
          ) : filteredInvoices.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-400 bg-surface-1 p-6 text-center text-secondary">
              {t("invoices.empty")}
            </p>
          ) : (
            <ul className="space-y-3">
              {filteredInvoices.map((invoice) => {
                const overdue = isInvoiceOverdue(invoice.due_date, invoice.payment_status);
                return (
                  <li key={invoice.id}>
                    <Link
                      href={invoiceDetailHref(invoice.id)}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-subtle bg-surface-1 p-4 hover:border-blue-400"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-primary">
                          {invoiceNumberLabel(invoice)}
                          {invoice.direction === "received" && (
                            <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                              {t("invoices.direction.receivedBadge")}
                            </span>
                          )}
                          {overdue && (
                            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                              {t("invoices.overdueBadge")}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-secondary">
                          {t(`invoices.kind.${invoice.kind}`)}
                          {counterpartyName(invoice) ? ` · ${counterpartyName(invoice)}` : ""}
                          {" · "}
                          {formatDate(invoice.issue_date, locale)}
                          {invoice.direction === "received" && invoice.source === "ai_inbox"
                            ? ` · ${t("invoices.source.ai_inbox")}`
                            : ""}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="font-semibold text-primary">
                          {formatMoney(invoice.total_amount, invoice.currency)}
                        </p>
                        <p className="text-xs text-secondary">
                          {invoice.document_status === "draft"
                            ? t("invoices.documentStatus.draft")
                            : t(`invoices.paymentStatus.${invoice.payment_status}`)}
                        </p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
