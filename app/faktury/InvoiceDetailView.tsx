"use client";

import { useEffect, useRef, useState } from "react";
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
  listAccountingStateLog,
  setAccountingStatus as saveAccountingStatus,
  type AccountingStateLogEntry,
} from "@/lib/invoicing/accounting-state";
import type { AccountingStatus } from "@/lib/invoicing/accounting-lifecycle";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate, formatNumber, formatMoney as formatMoneyIntl } from "@/lib/i18n/format";
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
  saveInvoiceDraft,
  setInvoiceComplianceFields,
  listFinalizedCreditNotesFor,
  getInvoiceNumberLabel,
  validateDraftBeforeFinalize,
  type DraftInvoiceItemInput,
  type Invoice,
  type InvoiceParty,
  type InvoicePayment,
  type InvoiceTaxBreakdown,
  type VatCategoryCode,
} from "@/lib/invoices";
import {
  DEFAULT_PRICE_MODE,
  invoicePriceMode,
  unitPriceLabelKey,
  type PriceMode,
} from "@/lib/invoicing/price-mode";
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
import { hasTranslation, translate } from "@/lib/i18n/translate";
import { downloadBlob } from "@/lib/file-actions";
import { invoiceDetailHref } from "@/lib/entity-links";
import { creditedTotals, isFullyCredited, remainingAfterCredits, signedAmount } from "@/lib/invoicing/credit-note-semantics";
import { navigateHard } from "@/lib/app-navigation";
import { issueDeadline, isIssuedAfterDeadline } from "@/lib/invoicing/sk-deadlines";
import { confirmAction, notify } from "@/app/components/ui/AppDialog";
import EinvoiceInvoicePanel from "@/app/components/einvoice/EinvoiceInvoicePanel";
import InvoiceFlowPanel from "@/app/components/invoicing/InvoiceFlowPanel";

// K/G/O (EN16931 / Peppol) pribudli v 20261002110000 — finalizácia ich počíta ako 0 %.
const VAT_CATEGORIES: VatCategoryCode[] = ["S", "Z", "E", "AE", "K", "G", "O"];
// UNTDID 4461 — spôsob úhrady (BT-81). Esblu kód nikdy nedopĺňa samo.
const PAYMENT_MEANS_CODES = ["30", "58", "10", "48", "49", "59"] as const;
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
function emptyItem(
  defaultVatRate: number | null,
  // Nový riadok dedí režim ceny dokladu. Keby dostal predvolený "net" na
  // doklade so sumami s daňou, vznikol by doklad, kde dva riadky s rovnakým
  // číslom znamenajú dve rôzne sumy — a nikto by si to nevšimol.
  priceMode: PriceMode = DEFAULT_PRICE_MODE
): DraftInvoiceItemInput {
  return {
    description: "",
    quantity: 1,
    unit: "ks",
    unit_code: null,
    unit_price: 0,
    price_mode: priceMode,
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
  // História označení. Odvolanie „zaúčtované" prepíše aktuálny stav, ale
  // stopu po ňom nezmaže — denník píše trigger v databáze.
  const [accountingLog, setAccountingLog] = useState<AccountingStateLogEntry[]>([]);

  async function handleToggleAccounted() {
    if (!invoice || accountingBusy || !userId) return;

    const next: AccountingStatus =
      accountingStatus === "accounted" ? "unprocessed" : "accounted";

    setAccountingBusy(true);
    try {
      await saveAccountingStatus(invoice.id, next, userId);
      setAccountingStatus(next);
      setAccountingLog(await listAccountingStateLog(invoice.id));
    } catch (error) {
      console.error("Zmena účtovného stavu zlyhala:", error);
    } finally {
      setAccountingBusy(false);
    }
  }

  const [parties, setParties] = useState<InvoiceParty[]>([]);
  const [taxBreakdowns, setTaxBreakdowns] = useState<InvoiceTaxBreakdown[]>([]);
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  // Dobropisy (finalizované) k tejto faktúre a číslo opravovanej faktúry pri
  // dobropise — lib/invoicing/credit-note-semantics.ts.
  const [creditNotes, setCreditNotes] = useState<{ id: string; invoice_number: string | null; total_amount: number; kind: string; document_status: string; corrects_invoice_id: string | null }[]>([]);
  const [correctedInvoiceNumber, setCorrectedInvoiceNumber] = useState<string | null>(null);
  const [partners, setPartners] = useState<BusinessPartner[]>([]);
  // Firemný VAT default (company_billing_profile.default_vat_rate) — iba
  // prefill zdroj pre NOVÉ S-kategórie položky, nikdy hardcoded universal
  // fallback. null = firma default nemá nastavený (žiadny 20/23/19/5 % odhad).
  const [companyDefaultVatRate, setCompanyDefaultVatRate] = useState<number | null>(null);
  // § 73: platiteľ DPH / IČ DPH dodávateľa (null = neznáme → lehota sa neurčí).
  const [sellerVat, setSellerVat] = useState<{ vatPayer: boolean | null; hasIcDph: boolean }>({ vatPayer: null, hasIcDph: false });
  // § 26: oficiálny kurz ECB z DB (žiadne sieťové volanie na ECB z klienta).
  const [officialFx, setOfficialFx] = useState<{ status: string; rate_date: string | null; rate: number | null } | null>(null);

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
  // EN16931 / Peppol polia vydanej faktúry (BT-72, BT-10, BT-13, BT-81, BT-83).
  const [deliveryDate, setDeliveryDate] = useState("");
  // 20261008100000: dátum prijatia platby / DUZP, dôvod opravy, kurz cudzej meny (§ 19 ods. 4, § 26, § 74).
  const [taxPointDate, setTaxPointDate] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxRateDate, setFxRateDate] = useState("");
  const [fxRateSource, setFxRateSource] = useState<"" | "ECB" | "NBS" | "CUSTOMS">("");
  const [buyerReference, setBuyerReference] = useState("");
  const [purchaseOrderReference, setPurchaseOrderReference] = useState("");
  const [paymentMeansCode, setPaymentMeansCode] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [draftItems, setDraftItems] = useState<DraftInvoiceItemInput[]>([]);
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");

  const [finalizing, setFinalizing] = useState(false);
  // Uloženie a finalizácia draftu sa nikdy nesmú prekrývať (dve súbežné
  // transakcie nad tým istým draftom). Ref platí okamžite, stav až po rendri.
  const draftBusyRef = useRef(false);
  const [finalizeError, setFinalizeError] = useState("");

  // PDF (iba finalized) — pozri handleDownloadPdf, FÁZA 3A.
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");
  // XML (UBL / Peppol BIS 3.0) export — iba finalizovaná vydaná faktúra.
  const [downloadingUbl, setDownloadingUbl] = useState(false);
  const [ublError, setUblError] = useState("");
  const [ublIssues, setUblIssues] = useState<string[]>([]);

  // Payment form state (iba finalized).
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(TODAY);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState("");

  async function init() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      navigateHard("/login");
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

  // Efekt až za deklaráciou init (react-hooks/immutability: prístup pred deklaráciou).
  // init() zapisuje stav až po await (session, členstvo) — rovnaký vzor ako ChatConversationList.tsx.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

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
        const [states, log] = await Promise.all([
          listAccountingStates(),
          listAccountingStateLog(inv.id),
        ]);
        setAccountingStatus(states[inv.id]?.accounting_status ?? "unprocessed");
        setAccountingLog(log);
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
        setSellerVat({
          vatPayer: billingProfile?.vat_payer_status === "vat_payer" ? true : billingProfile?.vat_payer_status === "non_vat_payer" ? false : null,
          hasIcDph: Boolean(billingProfile?.ic_dph && billingProfile.ic_dph.trim()),
        });
        setCustomerId(inv.customer_business_partner_id ?? "");
        setSupplierId(inv.supplier_business_partner_id ?? "");
        setSupplierInvoiceNumber(inv.supplier_invoice_number ?? "");
        setIssueDate(inv.issue_date);
        setDueDate(inv.due_date ?? "");
        setVariableSymbol(inv.variable_symbol ?? "");
        setDeliveryDate(inv.delivery_date ?? "");
        setTaxPointDate(inv.tax_point_date ?? "");
        setCorrectionReason(inv.correction_reason ?? "");
        setFxRate(inv.fx_rate != null ? String(inv.fx_rate) : "");
        setFxRateDate(inv.fx_rate_date ?? "");
        setFxRateSource(inv.fx_rate_source ?? "");
        setBuyerReference(inv.buyer_reference ?? "");
        setPurchaseOrderReference(inv.purchase_order_reference ?? "");
        setPaymentMeansCode(inv.payment_means_code ?? "");
        setPaymentReference(inv.payment_reference ?? "");
        setPaymentTermsDays(inv.payment_terms_days != null ? String(inv.payment_terms_days) : "");
        setCurrency(inv.currency);
        setDraftItems(
          items.length > 0
            ? items.map((item) => ({
                description: item.description,
                quantity: item.quantity,
                unit: item.unit,
                unit_code: item.unit_code,
                unit_price: item.unit_price,
                // Režim ceny MUSÍ prejsť editorom nedotknutý. Keby sa tu
                // stratil, uloženie bez jedinej zmeny by z dokladu so sumami
                // s daňou spravilo doklad bez dane — tá istá čísla, o celú
                // daň iný doklad.
                price_mode: item.price_mode,
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
        // Väzby opravných dokladov (pod RLS; zlyhanie nezhodí detail).
        try {
          setCreditNotes(await listFinalizedCreditNotesFor(inv.id));
          setCorrectedInvoiceNumber(inv.corrects_invoice_id ? await getInvoiceNumberLabel(inv.corrects_invoice_id) : null);
        } catch (error) {
          console.error("Načítanie dobropisov zlyhalo:", error);
        }
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
    setDraftItems((previous) => [...previous, emptyItem(companyDefaultVatRate, draftPriceMode ?? DEFAULT_PRICE_MODE)]);
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
    if (!invoice || draftBusyRef.current) return;
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
    draftBusyRef.current = true;
    setSavingDraft(true);

    try {
      const parsedTerms = Number(paymentTermsDays);
      // JEDNA atomická operácia (hlavička + riadky) — zlyhanie nič nezmaže.
      const updated = await saveInvoiceDraft(
        invoice.id,
        {
          ...directionHeaderPatch(),
          ...einvoiceHeaderPatch(),
          issue_date: issueDate,
          due_date: dueDate || null,
          variable_symbol: variableSymbol.trim() || null,
          payment_terms_days: Number.isFinite(parsedTerms) && paymentTermsDays !== "" ? parsedTerms : null,
          currency,
        },
        cleanedItems,
        invoice.updated_at
      );

      setInvoice(updated);
      setDraftItems(cleanedItems.length > 0 ? cleanedItems : [emptyItem(companyDefaultVatRate, draftPriceMode ?? DEFAULT_PRICE_MODE)]);
      setSaveNotice(t("invoices.detail.draftSavedNotice"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveNotice(
        message.includes("ESBLU_DRAFT_STALE") ? t("invoices.errors.draftStale") : t("invoices.errors.saveFailedPrefix", { message })
      );
    } finally {
      draftBusyRef.current = false;
      setSavingDraft(false);
    }
  }

  const isReceived = invoice?.direction === "received";
  // § 73 lehota (iba upozornenie; neurčená = REVIEW) a § 26 oficiálny kurz ECB (z DB; autoritatívna je finalizácia).
  const deadlinePartner = partners.find((p) => p.id === customerId);
  const skIssueDeadline = invoice
    ? issueDeadline({
        direction: invoice.direction === "received" ? "received" : "issued",
        kind: invoice.kind,
        deliveryDate: deliveryDate || null,
        taxPointDate: taxPointDate || null,
        vatCategories: draftItems.map((i) => i.vat_category_code),
        buyerCountry: deadlinePartner?.country_code ? deadlinePartner.country_code : null,
        sellerVatPayer: sellerVat.vatPayer,
        sellerHasIcDph: sellerVat.hasIcDph,
      })
    : null;
  const issuedLate = skIssueDeadline ? isIssuedAfterDeadline(issueDate, skIssueDeadline) : false;
  const isCorrection = invoice?.kind === "credit_note" || invoice?.kind === "debit_note";
  const fxTaxPoint = taxPointDate || deliveryDate || issueDate || "";
  const fxCurrency = currency.trim().toUpperCase();
  const wantsOfficialFx = !isReceived && !isCorrection && (fxRateSource === "ECB" || fxRateSource === "NBS") && fxCurrency !== "EUR" && /^[A-Z]{3}$/.test(fxCurrency) && Boolean(fxTaxPoint);
  useEffect(() => {
    if (!wantsOfficialFx) return;
    let cancelled = false;
    void Promise.resolve(supabase.rpc("esblu_fx_official_rate", { p_currency: fxCurrency, p_tax_point: fxTaxPoint })).then(({ data, error }) => {
      if (cancelled) return;
      const row = !error && Array.isArray(data) ? (data[0] as { status: string; rate_date: string | null; rate: number | null } | undefined) : undefined;
      setOfficialFx(row ?? { status: "data_missing", rate_date: null, rate: null });
    });
    return () => {
      cancelled = true;
    };
  }, [wantsOfficialFx, fxCurrency, fxTaxPoint]);
  const officialFxShown = wantsOfficialFx ? officialFx : null;

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

  /** Draft-only daňové polia (whitelist v DB). Kurz iba pri cudzej mene. */
  function complianceFieldsPatch() {
    const foreign = currency.trim().toUpperCase() !== "EUR";
    return {
      ...(isReceived ? {} : { tax_point_date: taxPointDate || null }),
      ...(invoice && (invoice.kind === "credit_note" || invoice.kind === "debit_note") ? { correction_reason: correctionReason.trim() || null } : {}),
      fx_rate: foreign && fxRate.trim() ? Number(fxRate.replace(",", ".")) : null,
      fx_rate_date: foreign ? fxRateDate || null : null,
      fx_rate_source: foreign ? fxRateSource || null : null,
    };
  }

  /** EN16931 polia — iba pre vydanú faktúru; prijatú faktúru nemeníme. */
  function einvoiceHeaderPatch() {
    if (isReceived) return {};
    return {
      delivery_date: deliveryDate || null,
      buyer_reference: buyerReference.trim() || null,
      purchase_order_reference: purchaseOrderReference.trim() || null,
      payment_means_code: paymentMeansCode || null,
      payment_reference: paymentReference.trim() || null,
    };
  }

  async function handleFinalize() {
    if (!invoice || draftBusyRef.current) return;

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

    const confirmed = (await confirmAction({ message: t("invoices.detail.finalizeConfirmBody") }));
    if (!confirmed) return;

    draftBusyRef.current = true;
    setFinalizing(true);
    setFinalizeError("");

    try {
      // Najprv ulož posledné zmeny hlavičky/riadkov (finalize prepočíta
      // autoritatívne v DB, ale drafte musia byť uložené, aby ich RPC videla).
      await saveInvoiceDraft(
        invoice.id,
        {
          ...directionHeaderPatch(),
          ...einvoiceHeaderPatch(),
          issue_date: issueDate,
          due_date: dueDate || null,
          variable_symbol: variableSymbol.trim() || null,
          payment_terms_days: paymentTermsDays !== "" ? Number(paymentTermsDays) : null,
          currency,
        },
        relevantItems,
        invoice.updated_at
      );
      await setInvoiceComplianceFields(invoice.id, complianceFieldsPatch());
      await finalizeInvoice(invoice.id);
      await loadAll();
    } catch (error) {
      const code = parseFinalizeErrorCode(error);
      const stale = String(error instanceof Error ? error.message : error).includes("ESBLU_DRAFT_STALE");
      setFinalizeError(
        stale ? t("invoices.errors.draftStale") : code ? t(`invoices.errors.${code}`) : t("invoices.errors.finalizeFailedGeneric")
      );
    } finally {
      draftBusyRef.current = false;
      setFinalizing(false);
    }
  }

  async function handleDeleteDraft() {
    if (!invoice) return;
    const confirmed = (await confirmAction({ message: t("invoices.errors.deleteConfirmPrefix"), destructive: true }));
    if (!confirmed) return;

    try {
      await deleteDraftInvoice(invoice.id);
      router.push("/faktury");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void notify({ message: t("invoices.errors.deleteFailedPrefix", { message }) });
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

  /**
   * Export XML (UBL) — GET /api/invoices/[id]/ubl. Server načíta nemenný
   * snapshot, overí finance.view a pri chýbajúcich údajoch vráti zoznam
   * problémov (nič neopravuje). XML je prevádzková kópia na export —
   * archiváciu si zákazník zabezpečuje sám.
   */
  async function handleDownloadUbl() {
    if (!invoice) return;
    setUblError("");
    setUblIssues([]);
    setDownloadingUbl(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error(t("invoices.errors.pdfNotAuthenticated"));

      const response = await fetch(apiUrl(`/api/invoices/${invoice.id}/ubl`), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
      });

      if (!response.ok) {
        let message = t("invoices.errors.ublGenerationFailed");
        try {
          const data = await response.json();
          if (data?.error) message = data.error;
          if (Array.isArray(data?.issues)) {
            // Server posiela iba kódy (code / rule / params) — preklad tu.
            setUblIssues(
              (data.issues as { code?: string; rule?: string; params?: Record<string, string | number> }[]).map((issue) => {
                const key = `invoices.einvoice.issues.${issue.code ?? ""}`;
                const text =
                  issue.code && hasTranslation(locale, key)
                    ? translate(locale, key, issue.params)
                    : t("invoices.einvoice.issueUnknown", { code: issue.code ?? "?" });
                return issue.rule ? `${text} (${issue.rule})` : text;
              })
            );
          }
        } catch {
          // odpoveď bez JSON tela — ponechaj generickú hlášku.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      await downloadBlob(blob, `${invoice.invoice_number ?? invoice.id}.xml`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUblError(t("invoices.errors.ublDownloadFailedPrefix", { message }));
    } finally {
      setDownloadingUbl(false);
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
    const confirmed = (await confirmAction({ message: t("invoices.detail.removePaymentConfirmPrefix"), destructive: true }));
    if (!confirmed) return;

    try {
      await removeInvoicePayment(payment.id);
      await loadAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void notify({ message: t("invoices.errors.removePaymentFailedPrefix", { message }) });
    }
  }

  // Pozri lib/i18n/format.ts — neplatná mena sa zobrazí, nespôsobí pád.
  function formatMoney(amount: number, curr: string | null): string {
    return formatMoneyIntl(amount, curr, locale);
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
        <BackLink href="/faktury" label={t("invoices.backToList")} className="mb-3 sm:mb-6" />
        <DocumentNotice>
          {!canView ? t("invoices.noFinanceAccess") : t("invoices.errors.notFound")}
        </DocumentNotice>
      </DocumentPageShell>
    );
  }

  const totalPaid = payments.reduce((sum, payment) => sum + payment.paid_amount, 0);
  const creditNote = invoice.kind === "credit_note";
  const credited = creditedTotals(creditNotes);
  const creditedAmount = credited.get(invoice.id) ?? 0;
  const fullyCredited = isFullyCredited(invoice, credited);
  // Dobropis nie je pohľadávka; faktúra úplne pokrytá dobropismi nie je po splatnosti.
  const overdue = !creditNote && !fullyCredited && isInvoiceOverdue(invoice.due_date, invoice.payment_status);
  const seller = parties.find((party) => party.role === "seller");
  const buyer = parties.find((party) => party.role === "buyer");
  const preview = previewDraftTotals(draftItems.filter((item) => item.description.trim()));
  // Režim ceny dokladu sa ODVODZUJE z riadkov, neukladá sa druhýkrát. `null`
  // = riadky sa nezhodujú; Esblu taký doklad nevytvára, ale ak by vznikol,
  // popis stĺpca radšej nebude tvrdiť nič.
  const draftPriceMode = invoicePriceMode(draftItems);

  return (
    <DocumentPageShell uiContext={{ module: "invoice", entityType: "invoice", entityId: entityId }}>
      <BackLink href="/faktury" label={t("invoices.backToList")} className="mb-3 sm:mb-6" />

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
            ) : creditNote ? null : fullyCredited ? (
              <span className="rounded-doc-sm bg-surface-2 px-2 py-0.5 text-xs font-medium text-secondary">
                {t("invoices.creditNote.fullyCredited")}
              </span>
            ) : (
              <DocumentStatusBadge kind={invoice.payment_status} />
            )}
            {overdue && <DocumentStatusBadge kind="overdue" />}
            {invoice.source !== "manual" && <DocumentSourceBadge source={invoice.source} />}
          </>
        }
        aside={
          <p className="text-2xl font-semibold tabular-nums text-primary">
            {/* Dobropis znižuje sumu — zobrazí sa so znamienkom mínus
                (uložené hodnoty ostávajú kladné, znamienko dáva druh dokladu). */}
            {invoice.document_status === "draft"
              ? formatMoney(signedAmount(invoice.kind, Number(preview.totalAmount)), invoice.currency)
              : formatMoney(signedAmount(invoice.kind, invoice.total_amount), invoice.currency)}
          </p>
        }
      />

      {/* Väzba opravného dokladu a zostatok po dobropisoch. */}
      {creditNote && invoice.corrects_invoice_id && (
        <p className="mt-3 text-sm text-secondary">
          {t("invoices.creditNote.correctsLabel", { number: correctedInvoiceNumber ?? t("invoices.numberFallback") })}{" "}
          <Link href={invoiceDetailHref(invoice.corrects_invoice_id)} className="underline">
            {t("invoices.creditNote.openCorrected")}
          </Link>
        </p>
      )}
      {!creditNote && creditedAmount > 0 && (
        <div className="mt-3 rounded-doc border border-doc-border bg-surface-2 p-3 text-sm text-secondary">
          <p>
            {t("invoices.creditNote.creditedLabel")}: {formatMoney(-creditedAmount, invoice.currency)}
          </p>
          <p className="font-semibold text-primary">
            {t("invoices.creditNote.remainingLabel")}: {formatMoney(remainingAfterCredits(invoice, credited), invoice.currency)}
          </p>
          <ul className="mt-1 list-disc pl-4">
            {creditNotes.map((note) => (
              <li key={note.id}>
                <Link href={invoiceDetailHref(note.id)} className="underline">
                  {note.invoice_number ?? t("invoices.numberFallback")}
                </Link>{" "}
                ({formatMoney(-note.total_amount, invoice.currency)})
              </li>
            ))}
          </ul>
        </div>
      )}

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
                {skIssueDeadline && skIssueDeadline.status === "determined" && (
                  <p className={`mt-1 text-xs ${issuedLate ? "text-amber-700" : "text-slate-500"}`} role={issuedLate ? "status" : undefined}>
                    {skIssueDeadline.alternativeDeadline
                      ? t("invoices.detail.issueDeadlineEither", { date: formatDate(skIssueDeadline.alternativeDeadline, locale), date2: formatDate(skIssueDeadline.deadline, locale) })
                      : t(issuedLate ? "invoices.detail.issueDeadlineLate" : "invoices.detail.issueDeadlineInfo", { date: formatDate(skIssueDeadline.deadline, locale) })}
                  </p>
                )}
                {skIssueDeadline && skIssueDeadline.status === "review" && (
                  <p className="mt-1 text-xs text-slate-500">{t("invoices.detail.issueDeadlineReview")}</p>
                )}
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

              {!isReceived && (
                <div>
                  <label className={docLabel}>
                    {t(invoice.kind === "payment_received_invoice" ? "invoices.pdf.paymentReceivedDateLabel" : "invoices.pdf.taxPointDateLabel")}
                  </label>
                  <input type="date" className={docField} value={taxPointDate} disabled={!canEdit}
                    onChange={(event) => setTaxPointDate(event.target.value)} />
                </div>
              )}
              {(invoice.kind === "credit_note" || invoice.kind === "debit_note") && (
                <div className="sm:col-span-2">
                  <label className={docLabel}>{t("invoices.pdf.correctionReasonLabel")}</label>
                  <input className={docField} value={correctionReason} disabled={!canEdit} maxLength={500}
                    onChange={(event) => setCorrectionReason(event.target.value)} />
                </div>
              )}
              {currency.trim().toUpperCase() !== "EUR" && (
                <>
                  <div>
                    <label className={docLabel}>{t("invoices.pdf.fxLabel")} (1 EUR = ? {currency.trim().toUpperCase()})</label>
                    <input inputMode="decimal" className={docField} value={fxRate} disabled={!canEdit}
                      onChange={(event) => setFxRate(event.target.value)} />
                  </div>
                  <div>
                    <label className={docLabel}>{t("invoices.detail.fxRateDateLabel")}</label>
                    <input type="date" className={docField} value={fxRateDate} disabled={!canEdit}
                      onChange={(event) => setFxRateDate(event.target.value)} />
                    {officialFxShown && officialFxShown.status === "ok" && officialFxShown.rate_date && (
                      <p className={`mt-1 text-xs ${fxRateDate !== officialFxShown.rate_date || Number(fxRate.replace(",", ".")) !== Number(officialFxShown.rate) ? "text-amber-700" : "text-slate-500"}`}>
                        {t("invoices.detail.fxOfficialRate", { date: formatDate(officialFxShown.rate_date, locale), rate: String(officialFxShown.rate) })}
                      </p>
                    )}
                    {officialFxShown && officialFxShown.status !== "ok" && (
                      <p className="mt-1 text-xs text-amber-700">
                        {t(officialFxShown.status === "not_published" ? "invoices.detail.fxOfficialNotPublished" : "invoices.detail.fxOfficialMissing")}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className={docLabel}>{t("invoices.pdf.fxSourceLabel")}</label>
                    <select className={docField} value={fxRateSource} disabled={!canEdit}
                      onChange={(event) => setFxRateSource(event.target.value as "" | "ECB" | "NBS" | "CUSTOMS")}>
                      <option value="">—</option>
                      <option value="ECB">ECB</option>
                      <option value="NBS">NBS</option>
                      <option value="CUSTOMS">{t("invoices.detail.fxCustomsOption")}</option>
                    </select>
                  </div>
                </>
              )}

              {!isReceived && (
                <>
                  <div>
                    <label className={docLabel}>{t("invoices.einvoice.deliveryDateLabel")}</label>
                    <input
                      type="date"
                      className={docField}
                      value={deliveryDate}
                      disabled={!canEdit}
                      onChange={(event) => setDeliveryDate(event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel}>{t("invoices.einvoice.buyerReferenceLabel")}</label>
                    <input
                      className={docField}
                      value={buyerReference}
                      disabled={!canEdit}
                      onChange={(event) => setBuyerReference(event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel}>{t("invoices.einvoice.purchaseOrderReferenceLabel")}</label>
                    <input
                      className={docField}
                      value={purchaseOrderReference}
                      disabled={!canEdit}
                      onChange={(event) => setPurchaseOrderReference(event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel}>{t("invoices.einvoice.paymentMeansCodeLabel")}</label>
                    <select
                      className={docField}
                      value={paymentMeansCode}
                      disabled={!canEdit}
                      onChange={(event) => setPaymentMeansCode(event.target.value)}
                    >
                      <option value="">{t("invoices.einvoice.paymentMeansNone")}</option>
                      {PAYMENT_MEANS_CODES.map((code) => (
                        <option key={code} value={code}>
                          {t(`invoices.einvoice.paymentMeans.${code}`)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className={docLabel}>{t("invoices.einvoice.paymentReferenceLabel")}</label>
                    <input
                      className={docField}
                      value={paymentReference}
                      disabled={!canEdit}
                      onChange={(event) => setPaymentReference(event.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
            {!isReceived && (
              <p className="mt-2 text-xs text-secondary">{t("invoices.einvoice.draftFieldsHint")}</p>
            )}

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
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-3"
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
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm uppercase text-primary outline-none focus:border-accent-cyan sm:col-span-1"
                    placeholder={t("invoices.einvoice.unitCodePlaceholder")}
                    title={t("invoices.einvoice.unitCodeHint")}
                    aria-label={t("invoices.einvoice.unitCodeLabel")}
                    maxLength={3}
                    value={item.unit_code ?? ""}
                    disabled={!canEdit}
                    onChange={(event) =>
                      updateDraftItem(index, { unit_code: event.target.value.toUpperCase() || null })
                    }
                  />
                  <input
                    type="number"
                    step="any"
                    className="rounded-doc-sm border border-doc-border bg-surface-2 p-2 text-sm text-primary outline-none focus:border-accent-cyan sm:col-span-2"
                    placeholder={t(unitPriceLabelKey(item.price_mode ?? DEFAULT_PRICE_MODE))}
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
                  disabled={savingDraft || finalizing}
                  className="rounded-xl border px-6 py-3 font-semibold"
                >
                  {savingDraft ? t("invoices.newInvoice.saving") : t("common.buttons.save")}
                </button>

                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={finalizing || savingDraft || legalHold}
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
          {ublError && (
            <div className="mt-4">
              <DocumentNotice tone="critical">
                {ublError}
                {ublIssues.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {ublIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </DocumentNotice>
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
                    <>
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
                      <button
                        type="button"
                        onClick={handleDownloadUbl}
                        disabled={downloadingUbl}
                        className={docButtonSecondary}
                      >
                        {downloadingUbl
                          ? t("invoices.einvoice.downloadingUbl")
                          : t("invoices.einvoice.downloadUblButton")}
                      </button>
                      <p className="text-xs text-muted-esblu">{t("invoices.einvoice.exportNotice")}</p>
                    </>
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
                  {canEdit && !isReceived && !creditNote && invoice.kind !== "proforma" && (
                    <>
                      <Link href={`/faktury/new?corrects=${invoice.id}`} className={docButtonSecondary}>
                        {t("invoices.detail.createCorrectionButton")}
                      </Link>
                      <Link href={`/faktury/new?corrects=${invoice.id}&kind=debit_note`} className={docButtonSecondary}>
                        {t("invoices.detail.createDebitNoteButton")}
                      </Link>
                    </>
                  )}
                </div>

                {/* HISTÓRIA OZNAČENÍ.
                    Označenie „zaúčtované" sa dá odvolať a odvolanie
                    prepíše aktuálny stav — ale nezmaže stopu. Denník píše
                    trigger v databáze a používateľ doň nemá zápis, takže
                    dôkaz o zmene nevyrába ten, koho sa týka. */}
                {accountingLog.length > 0 && (
                  <div className="mt-4 rounded-doc border border-doc-border bg-surface-2 p-4">
                    <p className="text-sm font-medium text-secondary">
                      {t("invoices.detail.accountingHistoryTitle")}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {accountingLog.map((entry) => (
                        <li key={entry.id} className="text-sm text-muted-esblu">
                          {formatDate(entry.changed_at, locale)} ·{" "}
                          {t(`handoff.accountingStatus.${entry.accounting_status}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

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

          {/* Phase 5: panel E-Faktúra (odoslanie / stav / prijatá e-faktúra).
              Oprávnenia a povolené akcie rozhoduje server; bez finančného
              prístupu sa panel nezobrazí vôbec. */}
          {canView && <EinvoiceInvoicePanel invoiceId={invoice.id} />}
          {/* 20261008100005: typ dokladu, review prijatej opravy, zálohy a saldo. */}
          {canView && <InvoiceFlowPanel invoice={invoice} canManage={canEdit} onChanged={() => void loadAll()} />}

          {creditNote ? (
            <p className="mt-8 text-sm text-secondary">{t("invoices.creditNote.noPaymentsNotice")}</p>
          ) : (
          <>
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
            <th className="pb-2 text-right">{t(unitPriceLabelKey(invoicePriceMode(items)))}</th>
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
                {formatMoneyIntl(item.unit_price, currency, locale)}
              </td>
              <td className="py-2 text-right">
                {formatMoneyIntl(item.line_gross_amount, currency, locale)}
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
                  {t(unitPriceLabelKey(invoicePriceMode(items)))}
                </p>
                <p className="text-sm text-primary">
                  {formatMoneyIntl(item.unit_price, currency, locale)}
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
                  {formatMoneyIntl(item.line_gross_amount, currency, locale)}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
