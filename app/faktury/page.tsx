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
  confirmPackageDownload,
  downloadDocumentPackage,
  loadDownloadStates,
  receiveVerifiedPackage,
  PackageDownloadError,
} from "@/lib/document-package-client";
import {
  downloadStateOf,
  matchesDownloadFilter,
  DOWNLOAD_FILTERS,
  type DownloadFilter,
  type DownloadState,
} from "@/lib/invoicing/document-package";
import { DownloadStateBadge } from "@/app/components/folders/DownloadStateBadge";
import { FolderPickerModal } from "@/app/components/folders/FolderPickerModal";
import { describePackageError, describePackageOutcome } from "@/app/components/folders/package-messages";
import { CheckIcon, FolderIcon } from "@/app/components/icons/AppIcons";
import {
  handoffErrorKey,
  isHandoffErrorCode,
  HANDOFF_GENERIC_ERROR_KEY,
} from "@/lib/invoicing/handoff-errors";
import { hasTranslation, translate } from "@/lib/i18n/translate";
import { PACKAGE_LIMITS } from "@/lib/invoicing/handoff-package";
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

  /**
   * Preklad s poistkou. Keď kľúč chýba, nastúpi náhradná veta — používateľ
   * nikdy neuvidí názov premennej. Konkrétna hláška má prednosť vždy, keď
   * existuje.
   */
  function tFallback(
    key: string,
    fallbackKey: string,
    vars?: Record<string, string | number>
  ): string {
    if (hasTranslation(locale, key)) return translate(locale, key, vars);
    return translate(locale, fallbackKey, vars);
  }

  /** Preklad, ktorý sa smie vynechať — vráti `null`, ak kľúč neexistuje. */
  function tOptional(key: string): string | null {
    return hasTranslation(locale, key) ? translate(locale, key) : null;
  }
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
    { type: "success" | "error" | "warning"; text: string } | null
  >(null);

  // Stav stiahnutia — nemenná história udalostí, nie zámok. Pozri
  // lib/invoicing/document-package.ts, čo presne znamená „Stiahnuté".
  const [downloadStates, setDownloadStates] = useState<Map<string, DownloadState>>(new Map());
  const [downloadFilter, setDownloadFilter] = useState<DownloadFilter>("all");
  // Výber dokladov pre „Pridať do priečinka" / „Stiahnuť vybrané".
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [userId, setUserId] = useState("");

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
      const [invoiceRows, partnerRows, states, exported, downloads] = await Promise.all([
        listInvoices(activeCompanyId),
        listBusinessPartners(activeCompanyId),
        listAccountingStates(),
        listHandoffStatuses(),
        loadDownloadStates(),
      ]);
      setDownloadStates(downloads);
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

  const sectionAndDirectionInvoices = useMemo(
    () => directionScopedInvoices.filter((invoice) => matchesSection(invoice, section, isOverdueInvoice)),
    [directionScopedInvoices, section]
  );

  // Filter stiahnutia sa počíta nad tým istým zoznamom, aký používateľ vidí.
  const downloadCounts = useMemo(() => {
    const counts: Record<DownloadFilter, number> = { all: 0, not_downloaded: 0, downloaded: 0 };
    for (const invoice of sectionAndDirectionInvoices) {
      const state = downloadStateOf(downloadStates, "invoice", invoice.id);
      for (const key of DOWNLOAD_FILTERS) if (matchesDownloadFilter(state, key)) counts[key] += 1;
    }
    return counts;
  }, [sectionAndDirectionInvoices, downloadStates]);

  const filteredInvoices = useMemo(
    () =>
      sectionAndDirectionInvoices.filter((invoice) =>
        matchesDownloadFilter(downloadStateOf(downloadStates, "invoice", invoice.id), downloadFilter)
      ),
    [sectionAndDirectionInvoices, downloadStates, downloadFilter]
  );

  function toggleSelected(invoiceId: string) {
    setSelectedIds((current) =>
      current.includes(invoiceId) ? current.filter((id) => id !== invoiceId) : [...current, invoiceId]
    );
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelectedIds([]);
  }

  /** ZIP s originálmi iba pre vybrané doklady (priečinková cesta, nie odovzdanie). */
  async function handleDownloadSelected() {
    if (packageBusy || selectedIds.length === 0) return;
    setPackageBusy(true);
    setExportFeedback(null);
    try {
      const outcome = await downloadDocumentPackage(
        { kind: "selection", items: selectedIds.map((id) => ({ type: "invoice" as const, id })) },
        locale
      );
      const message = describePackageOutcome(t, outcome);
      setExportFeedback({ type: message.tone === "warning" ? "warning" : "success", text: message.text });
      setDownloadStates(await loadDownloadStates());
    } catch (error) {
      setExportFeedback({
        type: "error",
        text: describePackageError(t, error instanceof PackageDownloadError ? error : null),
      });
    } finally {
      setPackageBusy(false);
    }
  }

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
        // Server posiela STROJOVÝ KÓD, nie vetu, podľa ktorej by sa tu
        // rozhodovalo. Text sa skladá tu, v jazyku používateľa.
        //
        // Rozhodovať sa podľa anglickej vety by znamenalo, že preklep v
        // preklade rozbije logiku — a to je presne ten druh závislosti,
        // ktorý sa nedá otestovať a pri ktorom nikto netuší, prečo padla.
        const payload = (await response.json().catch(() => null)) as
          | {
              code?: string;
              error?: string;
              rejected?: { label: string; problems: string[] }[];
            }
          | null;

        // Kód z odpovede sa overuje voči známemu zoznamu. Bez toho by sa z
        // odpovede servera dal vyrobiť ľubovoľný prekladový kľúč.
        const message = isHandoffErrorCode(payload?.code)
          ? tFallback(handoffErrorKey(payload.code), HANDOFF_GENERIC_ERROR_KEY, {
              max: PACKAGE_LIMITS.maxInvoices,
            })
          : tFallback(HANDOFF_GENERIC_ERROR_KEY, HANDOFF_GENERIC_ERROR_KEY);

        // Ktorý doklad a prečo. Bez toho používateľ nemá čo opraviť.
        // `problems` sú vnútorné kódy oprávnenosti — prekladajú sa, a keď
        // preklad chýba, radšej sa vynechajú, než by sa zobrazil názov
        // premennej.
        const detail = payload?.rejected?.length
          ? ` (${payload.rejected
              .slice(0, 5)
              .map((item) => {
                const reasons = item.problems
                  .map((problem) => tOptional(`handoff.errors.eligibility.${problem}`))
                  .filter((text): text is string => Boolean(text));
                return reasons.length ? `${item.label}: ${reasons.join(", ")}` : item.label;
              })
              .join("; ")})`
          : "";

        setExportFeedback({ type: "error", text: message + detail });
        return;
      }

      // Celá odpoveď musí prísť a sedieť s odtlačkom zo servera — až potom
      // sa súbor uloží a doklady sa označia ako stiahnuté.
      const { bytes, sha256 } = await receiveVerifiedPackage(response);
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
      const fileName =
        response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        "esblu-accounting-handoff.zip";

      await downloadBlob(blob, fileName);
      const recorded = await confirmPackageDownload(response.headers.get("x-esblu-package-id"), sha256);
      setDownloadStates(await loadDownloadStates());

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
          }) +
          (excludedDrafts > 0 ? t("handoff.packageDrafts", { count: excludedDrafts }) : "") +
          (recorded === null ? t("folders.downloadRecordFailed") : ""),
      });
    } catch (error) {
      console.error("Vytvorenie balíka pre účtovníka zlyhalo:", error);
      setExportFeedback({
        type: "error",
        text:
          error instanceof PackageDownloadError
            ? describePackageError(t, error)
            : t("handoff.errors.failed"),
      });
    } finally {
      setPackageBusy(false);
    }
  }

  const createDisabled = !canEdit || legalHold;

  return (
    <DocumentPageShell
      wide
      voiceSelection={
        selectionMode && selectedIds.length > 0
          ? { items: selectedIds.map((id) => ({ type: "invoice" as const, id })) }
          : null
      }
    >
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
              <Link href="/priecinky" className={`${docButtonSecondary} gap-2`}>
                <FolderIcon size={16} />
                {t("folders.navLabel")}
              </Link>
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
          <DocumentNotice
            tone={
              exportFeedback.type === "error"
                ? "critical"
                : exportFeedback.type === "warning"
                  ? "warning"
                  : undefined
            }
          >
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
              <div className="space-y-3">
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
                <FilterChips
                  label={t("folders.filter.label")}
                  active={downloadFilter}
                  onSelect={(key) => setDownloadFilter(key as DownloadFilter)}
                  options={DOWNLOAD_FILTERS.map((key) => ({
                    key,
                    label: t(`folders.filter.${key}`),
                    count: downloadCounts[key],
                  }))}
                />
              </div>
            }
          />
        </div>
      )}

      {canView && canEdit && filteredInvoices.length > 0 && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
            className={docButtonSecondary}
          >
            {selectionMode ? t("folders.selectionCancel") : t("folders.select")}
          </button>
        </div>
      )}

      {selectionMode && (
        <div className="sticky bottom-4 z-10 mt-3 rounded-doc border border-doc-border bg-surface-1/95 p-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-medium text-primary">
                {t("folders.selectedCount", { count: selectedIds.length })}
              </p>
              <button
                type="button"
                onClick={() => setSelectedIds(filteredInvoices.map((invoice) => invoice.id))}
                className="min-h-11 text-sm font-medium text-accent-cyan"
              >
                {t("folders.selectAll")}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={selectedIds.length === 0}
                onClick={() => setFolderPickerOpen(true)}
                className={docButtonPrimary}
              >
                {t("folders.addToFolder")}
              </button>
              <button
                type="button"
                disabled={selectedIds.length === 0 || packageBusy}
                onClick={() => void handleDownloadSelected()}
                className={docButtonSecondary}
              >
                {packageBusy ? t("folders.downloading") : t("folders.downloadSelected")}
              </button>
            </div>
          </div>
        </div>
      )}

      {folderPickerOpen && membership && (
        <FolderPickerModal
          companyId={membership.company_id}
          userId={userId}
          refs={selectedIds.map((id) => ({ type: "invoice" as const, id }))}
          onClose={() => setFolderPickerOpen(false)}
          onDone={(result) => {
            setFolderPickerOpen(false);
            setExportFeedback({
              type: "success",
              text:
                t("folders.addedToFolder", { name: result.folderName, count: result.affected }) +
                (result.skipped > 0 ? t("folders.addedSkipped", { count: result.skipped }) : ""),
            });
            exitSelection();
          }}
        />
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
                      href={selectionMode ? undefined : invoiceDetailHref(invoice.id)}
                      onClick={selectionMode ? () => toggleSelected(invoice.id) : undefined}
                      columns={INVOICE_COLUMNS}
                      ariaLabel={`${invoiceNumberLabel(invoice)} · ${counterpartyName(invoice) || "—"}`}
                    >
                      {/* 1 číslo + smer */}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {selectionMode && (
                            <span
                              aria-hidden="true"
                              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border ${
                                selectedIds.includes(invoice.id)
                                  ? "border-transparent bg-accent-esblu text-on-accent"
                                  : "border-doc-border"
                              }`}
                            >
                              {selectedIds.includes(invoice.id) && <CheckIcon size={12} />}
                            </span>
                          )}
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
                          <DownloadStateBadge
                            state={downloadStateOf(downloadStates, "invoice", invoice.id)}
                          />
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
