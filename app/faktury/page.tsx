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
import { formatDate, formatNumber, formatMoney as formatMoneyIntl } from "@/lib/i18n/format";
import InvoicesIcon from "@/app/components/icons/InvoicesIcon";
import { invoiceDetailHref } from "@/lib/entity-links";
import { isInvoiceOverdue, listInvoices, listInvoiceItems, type Invoice } from "@/lib/invoices";
import {
  listAccountingStates,
  listHandoffStatuses,
  recordMetadataExport,
  type InvoiceAccountingState,
} from "@/lib/invoicing/accounting-state";
import {
  exportAccountingHandoff,
  type HandoffInvoice,
} from "@/lib/invoicing/export-accounting-handoff";
import {
  retentionStatus,
  type AccountingStatus,
  type HandoffStatus,
} from "@/lib/invoicing/accounting-lifecycle";
import { todayLocalDate } from "@/lib/local-date";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { downloadBlob } from "@/lib/file-actions";
import {
  matchesDirection,
  matchesSection,
  DIRECTION_ORDER,
  SECTION_ORDER,
  type DirectionFilter,
  type SectionKey,
} from "@/lib/invoicing/invoice-register-filters";
import { listBusinessPartners, type BusinessPartner } from "@/lib/business-partners";
import {
  RegisterToolbar,
  RegisterHeader,
  FilterChips,
  DataRow,
  EmptyState,
  LoadingRows,
} from "@/app/components/ui/Primitives";
import {
  DocumentPageShell,
  DocumentHeader,
  DocumentNotice,
  docButtonPrimary,
  docButtonSecondary,
} from "@/app/components/document/DocumentLayout";
import {
  DocumentStatusBadge,
  DocumentSourceBadge,
} from "@/app/components/document/DocumentStatusBadge";

// Smer je samostatná dimenzia od sekcií. Sekcia "issued" totiž NIKDY
// neznamenala direction='issued' — znamená "finalizovaná riadna faktúra".
// Bez tohto oddelenia by prijaté faktúry ticho padali do sekcií vydaných.
//
// Samotné pravidlá zaradenia žijú v lib/invoicing/invoice-register-filters.ts,
// aby ich používali počty aj zoznam a dali sa odskúšať bez prehliadača.

/** "Po splatnosti" je odvodený stav — pozri lib/invoicing/vat-engine.ts. */
const isOverdueInvoice = (invoice: Invoice) =>
  isInvoiceOverdue(invoice.due_date, invoice.payment_status);

/** Jedna šablóna stĺpcov pre hlavičku aj riadky — nesmú sa rozísť. */
const INVOICE_COLUMNS =
  "sm:grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]";

/** Veľkosť balíka v tvare, ktorý človek prečíta na prvý pohľad. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [section, setSection] = useState<SectionKey>("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");

  // Účtovný lifecycle. Stav spracovania a stav odovzdania sú dve rôzne
  // veci a držia sa oddelene od samotného dokladu — pozri
  // supabase/migrations/20260923100000_add_accounting_handoff_lifecycle.sql.
  const [accountingStates, setAccountingStates] = useState<
    Record<string, InvoiceAccountingState>
  >({});
  // Stav odovzdania podľa DRUHU exportu. Stiahnutý zošit s údajmi nie je
  // odovzdanie dokladov, takže sa ani nesmie takto volať.
  const [handoffStatuses, setHandoffStatuses] = useState<Record<string, HandoffStatus>>({});
  const [exportBusy, setExportBusy] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<
    { type: "success" | "error"; text: string } | null
  >(null);

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
      const [invoiceRows, partnerRows, states, exported] = await Promise.all([
        listInvoices(activeCompanyId),
        listBusinessPartners(activeCompanyId),
        listAccountingStates(),
        listHandoffStatuses(),
      ]);
      setInvoices(invoiceRows);
      setPartnersById(Object.fromEntries(partnerRows.map((partner) => [partner.id, partner])));
      setAccountingStates(states);
      setHandoffStatuses(exported);
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


  // JEDNA DEFINÍCIA PRE POČET AJ ZOZNAM.
  //
  // Číslo pri záložke musí hovoriť o tom, čo používateľ po kliknutí uvidí.
  // Predtým sa počítalo cez všetky doklady, kým zoznam navyše filtroval
  // podľa stavu — register tak tvrdil „Všetky 3" a vykreslil dva riadky.
  // Počty sa preto počítajú nad TOU ISTOU množinou, z ktorej vzniká zoznam.
  const sectionScopedInvoices = useMemo(
    () => invoices.filter((invoice) => matchesSection(invoice, section, isOverdueInvoice)),
    [invoices, section]
  );

  const directionCounts = useMemo(() => {
    const counts: Record<DirectionFilter, number> = { all: 0, issued: 0, received: 0 };
    for (const invoice of sectionScopedInvoices) {
      counts.all += 1;
      if (invoice.direction === "issued") counts.issued += 1;
      if (invoice.direction === "received") counts.received += 1;
    }
    return counts;
  }, [sectionScopedInvoices]);

  const sectionCounts = useMemo(() => {
    const counts: Record<SectionKey, number> = {
      all: 0,
      issued: 0,
      drafts: 0,
      unpaid: 0,
      overdue: 0,
      paid: 0,
      corrections: 0,
    };
    for (const invoice of directionScopedInvoices) {
      for (const key of SECTION_ORDER) {
        if (matchesSection(invoice, key, isOverdueInvoice)) counts[key] += 1;
      }
    }
    return counts;
  }, [directionScopedInvoices]);

  const filteredInvoices = useMemo(
    () => directionScopedInvoices.filter((invoice) => matchesSection(invoice, section, isOverdueInvoice)),
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

  // Jedna spoločná, nepadajúca implementácia pre celý projekt — pozri
  // lib/i18n/format.ts. Lokálna kópia tu kedysi volala Intl priamo a pri
  // mene „EUR " (s medzerou) zhodila celý register faktúr.
  function formatMoney(amount: number, currency: string | null): string {
    return formatMoneyIntl(amount, currency, locale);
  }

  function accountingStatusOf(invoice: Invoice): AccountingStatus {
    return accountingStates[invoice.id]?.accounting_status ?? "unprocessed";
  }

  /**
   * Export ÚDAJOV pre účtovníka.
   *
   * Vzniká zošit s údajmi o dokladoch — nie balík s originálmi. Esblu
   * preto nikde netvrdí, že doklady niekto prevzal alebo archivoval;
   * tvrdí iba to, čo vie: že sa vytvoril súbor a s akým odtlačkom.
   *
   * Exportuje sa presne to, čo je práve v zozname — teda to, čo má
   * používateľ pred očami. Udalosť sa zapisuje AŽ po vytvorení súboru.
   */
  async function handleMetadataExport() {
    if (exportBusy || filteredInvoices.length === 0) return;

    setExportBusy(true);
    setExportFeedback(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("no session");

      const withItems: HandoffInvoice[] = [];
      for (const invoice of filteredInvoices) {
        const items = await listInvoiceItems(invoice.id);
        const partnerId =
          invoice.direction === "received"
            ? invoice.supplier_business_partner_id
            : invoice.customer_business_partner_id;
        const partner = partnerId ? partnersById[partnerId] : undefined;

        withItems.push({
          ...invoice,
          counterpartyName: partner?.legal_name ?? "",
          counterpartyIco: partner?.ico ?? null,
          counterpartyIcDph: partner?.ic_dph ?? null,
          accountingStatus: accountingStatusOf(invoice),
          items: items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_price,
            vat_category_code: item.vat_category_code,
            vat_rate: item.vat_rate,
            line_net_amount: item.line_net_amount,
            line_vat_amount: item.line_vat_amount,
            line_gross_amount: item.line_gross_amount,
          })),
        });
      }

      const result = await exportAccountingHandoff(withItems, t);

      await recordMetadataExport({
        invoiceIds: withItems.map((invoice) => invoice.id),
        periodFrom: null,
        periodTo: null,
        direction: directionFilter === "all" ? null : directionFilter,
        manifestSha256: result.manifestSha256,
        userId: session.user.id,
      });

      // Označí sa iba to, čo sa naozaj stalo: export údajov.
      const next = { ...handoffStatuses };
      for (const invoice of withItems) {
        if (next[invoice.id] !== "complete_handoff") next[invoice.id] = "metadata_exported";
      }
      setHandoffStatuses(next);

      setExportFeedback({
        type: "success",
        text: t("handoff.exported", { count: result.exportedCount, file: result.fileName }),
      });
    } catch (error) {
      console.error("Export údajov pre účtovníka zlyhal:", error);
      setExportFeedback({ type: "error", text: t("handoff.errors.failed") });
    } finally {
      setExportBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // ÚPLNÝ BALÍK — iná vec než export údajov vyššie.
  //
  // Zošit s údajmi je prehľad. Balík je odovzdanie: originály prijatých
  // dokladov, PDF vydaných faktúr, prílohy, manifest s odtlačkami. Preto sú
  // to dve tlačidlá a dva stavy, nie jedno tlačidlo s prepínačom — z prvého
  // nikdy nesmie vyplynúť, že doklad môže z Esblu zmiznúť.
  //
  // Balík skladá server (app/api/accounting-handoff/package/route.ts).
  // Prehliadač by na originály v súkromných bucketoch aj tak nedosiahol
  // jedným autorizovaným krokom a PDF sa generuje v Node runtime.
  // ---------------------------------------------------------------------------
  async function handleCompletePackage() {
    if (packageBusy || filteredInvoices.length === 0) return;

    setPackageBusy(true);
    setExportFeedback(null);

    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) throw new Error("no-session");

      const response = await fetch(apiUrl("/api/accounting-handoff/package"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
        body: JSON.stringify({ invoiceIds: filteredInvoices.map((invoice) => invoice.id) }),
      });

      if (!response.ok) {
        // Server posiela dôvod, nie len „nepodarilo sa". Keď sa doklad do
        // balíka nedá zaradiť, používateľ musí vedieť ktorý a prečo —
        // inak nemá čo opraviť.
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; rejected?: { label: string; problems: string[] }[] }
          | null;

        const detail = payload?.rejected?.length
          ? ` (${payload.rejected
              .slice(0, 5)
              .map((item) => `${item.label}: ${item.problems.join(", ")}`)
              .join("; ")})`
          : "";

        setExportFeedback({
          type: "error",
          text: (payload?.error ?? t("handoff.errors.failed")) + detail,
        });
        return;
      }

      const blob = await response.blob();
      const fileName =
        response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        "esblu-accounting-handoff.zip";

      await downloadBlob(blob, fileName);

      // Stav sa mení iba tým dokladom, ktoré v balíku naozaj boli. Koncepty
      // server vynechal, takže si svoj doterajší stav ponechajú.
      //
      // Aj tak je to len „balík vytvorený". Že sa súbor stiahol a že ho
      // niekto poslal účtovníkovi, Esblu nevie a netvrdí.
      const next = { ...handoffStatuses };
      for (const invoice of filteredInvoices) {
        if (invoice.document_status === "finalized") next[invoice.id] = "complete_handoff";
      }
      setHandoffStatuses(next);

      // Koľko dokladov v balíku NAOZAJ je, hovorí server — nie dĺžka filtra
      // v prehliadači. Koncepty sa vynechávajú a vynechanie, o ktorom sa
      // mlčí, je to isté ako strata.
      const packagedCount = Number(response.headers.get("x-esblu-invoice-count") ?? 0);
      const excludedDrafts = Number(response.headers.get("x-esblu-excluded-drafts") ?? 0);

      setExportFeedback({
        type: "success",
        text:
          t("handoff.packageDone", {
            file: fileName,
            invoices: packagedCount,
            files: response.headers.get("x-esblu-file-count") ?? "?",
            size: formatBytes(blob.size),
          }) + (excludedDrafts > 0 ? t("handoff.packageDrafts", { count: excludedDrafts }) : ""),
      });
    } catch (error) {
      console.error("Vytvorenie balíka pre účtovníka zlyhalo:", error);
      setExportFeedback({ type: "error", text: t("handoff.errors.failed") });
    } finally {
      setPackageBusy(false);
    }
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
            <div className="flex flex-wrap gap-2">
              {/* Export ÚDAJOV, nie odovzdanie dokladov. Tlačidlo sa volá
                  tak, ako sa volá to, čo naozaj urobí — sľubovať prevzatie,
                  ktoré Esblu nevie overiť, by znamenalo neskôr z toho
                  odvodiť, že doklad smie zmiznúť. */}
              <button
                type="button"
                onClick={handleMetadataExport}
                disabled={exportBusy || filteredInvoices.length === 0}
                aria-busy={exportBusy}
                className={`${docButtonPrimary} disabled:pointer-events-none disabled:opacity-40`}
              >
                {exportBusy ? t("handoff.exporting") : t("handoff.exportButton")}
              </button>
              {/* Odovzdanie dokladov. Iné tlačidlo, iný stav, iná veta —
                  zámerne sa nedá zameniť s exportom údajov vedľa. */}
              <button
                type="button"
                onClick={handleCompletePackage}
                disabled={packageBusy || exportBusy || filteredInvoices.length === 0}
                aria-busy={packageBusy}
                title={t("handoff.packageWarningBody")}
                className={`${docButtonSecondary} disabled:pointer-events-none disabled:opacity-40`}
              >
                {packageBusy ? t("handoff.packageBusy") : t("handoff.packageButton")}
              </button>
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
            </div>
          ) : undefined
        }
      />

      {exportFeedback && (
        <div className="mt-4">
          <DocumentNotice tone={exportFeedback.type === "error" ? "critical" : undefined}>
            {exportFeedback.text}
          </DocumentNotice>
        </div>
      )}

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
        <div className="mt-6">
          <RegisterToolbar
            filtersLabel={t("common.register.filters")}
            filtersCloseLabel={t("common.register.filtersClose")}
            activeSummary={t(`invoices.sections.${section}`)}
            primary={
              /* Smer je primárna os registra — segmented control, ktorý
                 zostáva viditeľný aj na mobile. */
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
                    className={`flex-1 whitespace-nowrap rounded-doc-sm px-3 py-2 text-sm font-medium transition sm:flex-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
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
            }
            filters={
              /* Stav je sekundárna os. Na mobile žije za tlačidlom
                 "Filtre" (§A1) — šesť piluliek nad zoznamom zabralo
                 polovicu obrazovky telefónu. */
              <FilterChips
                label={t("invoices.register.statusFilterLabel")}
                active={section}
                onSelect={(key) => setSection(key as SectionKey)}
                options={SECTION_ORDER.map((key) => ({
                  key,
                  label: t(`invoices.sections.${key}`),
                  count: sectionCounts[key],
                }))}
              />
            }
          />
        </div>
      )}

      {canView && (
        <div className="mt-4">
          {loading ? (
            <LoadingRows label={t("invoices.loading")} />
          ) : loadError ? (
            <DocumentNotice tone="critical">{loadError}</DocumentNotice>
          ) : filteredInvoices.length === 0 ? (
            <EmptyState title={t("invoices.empty")} />
          ) : (
            <>
              <RegisterHeader columns={INVOICE_COLUMNS}>
                <span>{t("invoices.register.colDocument")}</span>
                <span>{t("invoices.register.colCounterparty")}</span>
                <span className="text-right">{t("invoices.register.colTotal")}</span>
                <span className="text-right">{t("invoices.register.colStatus")}</span>
              </RegisterHeader>

              <ul className="mt-2 space-y-1.5">
                {filteredInvoices.map((invoice) => {
                  const overdue = isInvoiceOverdue(invoice.due_date, invoice.payment_status);
                  // Prevádzková lehota v Esblu. Nie je to zákonná lehota
                  // uchovávania — tú plní zákazník mimo Esblu.
                  const handoffStatus = handoffStatuses[invoice.id] ?? "none";
                  const retention = retentionStatus({
                    issueDate: invoice.issue_date,
                    today: todayLocalDate(),
                    handoffStatus,
                  });
                  return (
                    <DataRow
                      key={invoice.id}
                      href={invoiceDetailHref(invoice.id)}
                      columns={INVOICE_COLUMNS}
                      ariaLabel={`${invoiceNumberLabel(invoice)} · ${counterpartyName(invoice) || "—"}`}
                    >
                      {/* 1 číslo + smer */}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium text-primary">
                            {invoiceNumberLabel(invoice)}
                          </span>
                          <DocumentStatusBadge
                            kind={invoice.direction === "received" ? "received" : "issued"}
                          />
                        </div>
                        {/* 4 dátum / splatnosť — na mobile čitateľných 14px,
                            na desktope tichšie, lebo tam je viac kontextu. */}
                        <p className="mt-0.5 truncate text-sm text-muted-esblu sm:text-xs">
                          {t(`invoices.kind.${invoice.kind}`)} ·{" "}
                          {formatDate(invoice.issue_date, locale)}
                          {invoice.due_date
                            ? ` · ${t("invoices.register.dueShort")} ${formatDate(invoice.due_date, locale)}`
                            : ""}
                        </p>
                      </div>

                      {/* 2 protistrana + 6 pôvod */}
                      <div className="mt-1 min-w-0 sm:mt-0">
                        <p className="truncate text-sm text-secondary">
                          {counterpartyName(invoice) || "—"}
                        </p>
                        {invoice.source !== "manual" && (
                          <div className="mt-0.5">
                            <DocumentSourceBadge source={invoice.source} />
                          </div>
                        )}
                      </div>

                      {/* 3 suma + 5 stav — na mobile v jednom riadku vedľa
                          seba, aby doklad zabral tri riadky, nie šesť. */}
                      <div className="mt-2 flex items-center justify-between gap-3 sm:contents">
                        <p className="text-base font-semibold tabular-nums text-primary sm:text-sm sm:text-right">
                          {formatMoney(invoice.total_amount, invoice.currency)}
                        </p>

                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {invoice.document_status === "draft" ? (
                            <DocumentStatusBadge kind="draft" />
                          ) : (
                            <DocumentStatusBadge kind={invoice.payment_status} />
                          )}
                          {overdue && <DocumentStatusBadge kind="overdue" />}

                          {/* Uhradené, zaúčtované a odovzdané sú TRI rôzne
                              veci. Preto tri samostatné označenia a žiadne
                              sa neodvodzuje z iného. */}
                          {accountingStatusOf(invoice) === "accounted" && (
                            <span className="rounded-doc-sm bg-surface-2 px-2 py-0.5 text-xs font-medium text-secondary">
                              {t("handoff.accountingStatus.accounted")}
                            </span>
                          )}
                          {handoffStatus !== "none" && (
                            <span className="rounded-doc-sm bg-surface-2 px-2 py-0.5 text-xs font-medium text-secondary">
                              {t(`handoff.handoffStatus.${handoffStatus}`)}
                            </span>
                          )}
                          {retention.state !== "active" && (
                            <span
                              className={`rounded-doc-sm px-2 py-0.5 text-xs font-medium ${
                                retention.state === "retention_exceeded"
                                  ? "badge-danger"
                                  : "bg-warning-soft text-warning"
                              }`}
                            >
                              {t(`handoff.retention.${retention.state}`)}
                            </span>
                          )}
                        </div>
                      </div>
                    </DataRow>
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
