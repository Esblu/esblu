import path from "node:path";
import {
  Document,
  Page,
  Text,
  View,
  Font,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { Invoice, InvoiceItem, InvoiceParty, InvoiceTaxBreakdown } from "@/lib/invoices";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import { translate } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locales";

// =============================================================================
// FÁZA 3A — deterministic PDF renderer finalizovanej faktúry.
//
// KRITICKÉ ARCHITEKTONICKÉ PRAVIDLO (pozri zadanie): PDF NIE JE
// source-of-truth. Táto vrstva iba FORMÁTUJE už persistované, finalizované
// canonical hodnoty (invoice/invoice_parties/invoice_items/
// invoice_tax_breakdowns riadky presne tak, ako ich vrátil user-scoped
// Supabase klient v app/api/invoices/[id]/pdf/route.ts). Nikdy tu nesmie
// vzniknúť žiadny nový výpočet DPH/súm — iba Intl formátovanie čísel/dátumov
// z už uložených hodnôt. Nikdy tu nesmie byť použitý live business_partner
// ani company_billing_profile riadok — iba invoice_parties SNAPSHOT.
//
// FONT: Noto Sans (SIL OFL 1.1, The Noto Project Authors) — lokálne .ttf
// súbory v assets/fonts/, zlúčené z oficiálnych @fontsource/noto-sans
// "latin" + "latin-ext" subsetov (fonttools/pyftmerge), aby JEDEN font
// súbor pokrýval ASCII + Latin-1 (Ä/Ö/Ü/ß) + Latin Extended-A (slovenské
// ľ/ĺ/ŕ/ď/ť/ň/š/č/ž) v jednom text rune — pozri assets/fonts/OFL.txt pre
// licenciu a pôvod. next.config.ts obsahuje outputFileTracingIncludes pre
// túto API route, aby Vercel serverless bundle tieto .ttf súbory obsahoval.
// =============================================================================

let fontsRegistered = false;

function ensureFontsRegistered() {
  if (fontsRegistered) return;

  const fontsDir = path.join(process.cwd(), "assets", "fonts");

  Font.register({
    family: "NotoSans",
    fonts: [
      { src: path.join(fontsDir, "NotoSans-Regular.ttf"), fontWeight: "normal" },
      { src: path.join(fontsDir, "NotoSans-Bold.ttf"), fontWeight: "bold" },
    ],
  });

  // react-pdf/yoga bez tohto vie v niektorých prostrediach rozdeľovať slová
  // uprostred namiesto na medzerách pri dlhších popisoch položiek.
  Font.registerHyphenationCallback((word) => [word]);

  fontsRegistered = true;
}

export type InvoicePdfBundle = {
  invoice: Invoice;
  seller: InvoiceParty | null;
  buyer: InvoiceParty | null;
  items: InvoiceItem[];
  taxBreakdowns: InvoiceTaxBreakdown[];
  locale: Locale;
};

const styles = StyleSheet.create({
  page: {
    fontFamily: "NotoSans",
    fontSize: 9,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
    color: "#0f172a",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
  },
  docTitle: {
    fontSize: 18,
    fontWeight: "bold",
  },
  docNumber: {
    fontSize: 12,
    marginTop: 2,
    color: "#334155",
  },
  metaBlock: {
    textAlign: "right",
  },
  metaLine: {
    fontSize: 9,
    color: "#334155",
  },
  partiesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 18,
    gap: 16,
  },
  partyBox: {
    flexGrow: 1,
    flexBasis: 0,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 10,
  },
  partyLabel: {
    fontSize: 8,
    fontWeight: "bold",
    color: "#64748b",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  partyName: {
    fontSize: 11,
    fontWeight: "bold",
    marginBottom: 2,
  },
  partyLine: {
    fontSize: 9,
    color: "#334155",
    marginBottom: 1,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: "bold",
    marginTop: 14,
    marginBottom: 6,
  },
  table: {
    width: "100%",
  },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
    paddingBottom: 4,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e2e8f0",
    paddingVertical: 4,
  },
  th: {
    fontSize: 8,
    fontWeight: "bold",
    color: "#64748b",
    textTransform: "uppercase",
  },
  td: {
    fontSize: 9,
  },
  colDescription: { width: "36%" },
  colQuantity: { width: "12%", textAlign: "right" },
  colUnitPrice: { width: "16%", textAlign: "right" },
  colVat: { width: "16%", textAlign: "right" },
  colTotal: { width: "20%", textAlign: "right" },
  vatColCategory: { width: "50%" },
  vatColTaxable: { width: "25%", textAlign: "right" },
  vatColAmount: { width: "25%", textAlign: "right" },
  totalsBlock: {
    marginTop: 12,
    alignItems: "flex-end",
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: 220,
    paddingVertical: 2,
  },
  totalsLabel: {
    fontSize: 9,
    color: "#334155",
  },
  totalsValue: {
    fontSize: 9,
  },
  grandTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: 220,
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
  },
  grandTotalLabel: {
    fontSize: 11,
    fontWeight: "bold",
  },
  grandTotalValue: {
    fontSize: 13,
    fontWeight: "bold",
  },
  paymentBox: {
    marginTop: 18,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 10,
    width: "55%",
  },
  paymentLine: {
    fontSize: 9,
    marginBottom: 2,
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: "#94a3b8",
  },
});

function formatMoney(amount: number, currency: string, locale: Locale): string {
  return formatNumber(amount, locale, { style: "currency", currency });
}

/**
 * Kategória DPH sa VŽDY renderuje plným popisným textom (napr. "AE —
 * prenesenie daňovej povinnosti"), nikdy iba ako kód s technickou
 * percentuálnou sadzbou — presne tie isté i18n kľúče ako v UI
 * (invoices.newInvoice.vatCategory.*), aby sa AE/Z/E nikdy nezobrazilo ako
 * keby išlo o obyčajnú "0 % sadzbu" (bod 5 zadania). Sadzba v % sa dopĺňa
 * iba pre kategóriu S, kde má reálny percentuálny význam.
 */
function vatCategoryLabel(code: string, rate: number, locale: Locale): string {
  const categoryText = translate(locale, `invoices.newInvoice.vatCategory.${code}`);

  if (code === "S") {
    return `${categoryText} (${formatNumber(rate, locale)}%)`;
  }

  return categoryText;
}

function PartyBox({
  labelKey,
  party,
  locale,
}: {
  labelKey: string;
  party: InvoiceParty | null;
  locale: Locale;
}) {
  return (
    <View style={styles.partyBox}>
      <Text style={styles.partyLabel}>{translate(locale, labelKey)}</Text>
      {party ? (
        <>
          <Text style={styles.partyName}>{party.legal_name}</Text>
          {(party.address_line1 || party.city) && (
            <Text style={styles.partyLine}>
              {[party.address_line1, party.address_line2].filter(Boolean).join(", ")}
            </Text>
          )}
          {(party.postal_code || party.city || party.country_code) && (
            <Text style={styles.partyLine}>
              {[party.postal_code, party.city, party.country_code].filter(Boolean).join(" ")}
            </Text>
          )}
          {party.ico && (
            <Text style={styles.partyLine}>
              {translate(locale, "invoices.pdf.icoLabel")}: {party.ico}
            </Text>
          )}
          {party.dic && (
            <Text style={styles.partyLine}>
              {translate(locale, "invoices.pdf.dicLabel")}: {party.dic}
            </Text>
          )}
          {party.ic_dph && (
            <Text style={styles.partyLine}>
              {translate(locale, "invoices.pdf.icDphLabel")}: {party.ic_dph}
            </Text>
          )}
          {party.email && <Text style={styles.partyLine}>{party.email}</Text>}
          {party.iban && (
            <Text style={styles.partyLine}>
              {translate(locale, "invoices.pdf.ibanLabel")}: {party.iban}
            </Text>
          )}
          {party.bic && (
            <Text style={styles.partyLine}>
              {translate(locale, "invoices.pdf.bicLabel")}: {party.bic}
            </Text>
          )}
        </>
      ) : (
        <Text style={styles.partyLine}>—</Text>
      )}
    </View>
  );
}

/**
 * Číslo dokladu podľa smeru.
 *
 * Endpoint dnes prijaté faktúry odmieta (fail-closed, viď route.ts §5b), takže
 * táto vetva je defense-in-depth: keby sa received PDF niekedy povolilo,
 * renderer nesmie vytlačiť prázdne číslo. Prijatá faktúra nemá a nikdy
 * nedostane invoice_number — jej identitou je číslo dodávateľa.
 */
function documentNumberFor(invoice: InvoicePdfBundle["invoice"]): string | null {
  return invoice.direction === "received"
    ? (invoice.supplier_invoice_number ?? null)
    : (invoice.invoice_number ?? null);
}

function InvoicePdfDocument({ invoice, seller, buyer, items, taxBreakdowns, locale }: InvoicePdfBundle) {
  const documentLabel = translate(locale, `invoices.kind.${invoice.kind}`);
  const rounding = Number(invoice.rounding_amount) || 0;
  const documentNumber = documentNumberFor(invoice);

  return (
    <Document
      title={documentNumber ?? documentLabel}
      author="Esblu"
      creator="Esblu"
      producer="Esblu"
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.docTitle}>{documentLabel}</Text>
            <Text style={styles.docNumber}>
              {translate(locale, "invoices.pdf.documentNumberLabel")}: {documentNumber ?? "—"}
            </Text>
          </View>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLine}>
              {translate(locale, "invoices.newInvoice.issueDateLabel")}: {formatDate(invoice.issue_date, locale)}
            </Text>
            {invoice.due_date && (
              <Text style={styles.metaLine}>
                {translate(locale, "invoices.newInvoice.dueDateLabel")}: {formatDate(invoice.due_date, locale)}
              </Text>
            )}
            {invoice.delivery_date && (
              <Text style={styles.metaLine}>
                {translate(locale, "invoices.pdf.deliveryDateLabel")}: {formatDate(invoice.delivery_date, locale)}
              </Text>
            )}
            {invoice.tax_point_date && invoice.tax_point_date !== invoice.delivery_date && (
              <Text style={styles.metaLine}>
                {translate(locale, "invoices.pdf.taxPointDateLabel")}: {formatDate(invoice.tax_point_date, locale)}
              </Text>
            )}
            {invoice.variable_symbol && (
              <Text style={styles.metaLine}>
                {translate(locale, "invoices.pdf.variableSymbolLabel")}: {invoice.variable_symbol}
              </Text>
            )}
            <Text style={styles.metaLine}>
              {translate(locale, "invoices.pdf.currencyLabel")}: {invoice.currency}
            </Text>
          </View>
        </View>

        <View style={styles.partiesRow}>
          <PartyBox labelKey="invoices.detail.sellerTitle" party={seller} locale={locale} />
          <PartyBox labelKey="invoices.detail.buyerTitle" party={buyer} locale={locale} />
        </View>

        <Text style={styles.sectionTitle}>{translate(locale, "invoices.detail.itemsTitle")}</Text>
        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.th, styles.colDescription]}>
              {translate(locale, "invoices.newInvoice.itemDescriptionLabel")}
            </Text>
            <Text style={[styles.th, styles.colQuantity]}>
              {translate(locale, "invoices.newInvoice.itemQuantityLabel")}
            </Text>
            <Text style={[styles.th, styles.colUnitPrice]}>
              {translate(locale, "invoices.newInvoice.itemUnitPriceLabel")}
            </Text>
            <Text style={[styles.th, styles.colVat]}>
              {translate(locale, "invoices.newInvoice.itemVatCategoryLabel")}
            </Text>
            <Text style={[styles.th, styles.colTotal]}>
              {translate(locale, "invoices.newInvoice.totalLabel")}
            </Text>
          </View>
          {items.map((item) => (
            <View key={item.id} style={styles.tableRow} wrap={false}>
              <Text style={[styles.td, styles.colDescription]}>{item.description}</Text>
              <Text style={[styles.td, styles.colQuantity]}>
                {formatNumber(item.quantity, locale)} {item.unit}
              </Text>
              <Text style={[styles.td, styles.colUnitPrice]}>
                {formatMoney(item.unit_price, invoice.currency, locale)}
              </Text>
              <Text style={[styles.td, styles.colVat]}>
                {vatCategoryLabel(item.vat_category_code, item.vat_rate, locale)}
              </Text>
              <Text style={[styles.td, styles.colTotal]}>
                {formatMoney(item.line_gross_amount, invoice.currency, locale)}
              </Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>{translate(locale, "invoices.detail.taxBreakdownTitle")}</Text>
        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.th, styles.vatColCategory]}>
              {translate(locale, "invoices.newInvoice.itemVatCategoryLabel")}
            </Text>
            <Text style={[styles.th, styles.vatColTaxable]}>
              {translate(locale, "invoices.detail.taxBreakdownTaxable")}
            </Text>
            <Text style={[styles.th, styles.vatColAmount]}>
              {translate(locale, "invoices.detail.taxBreakdownVat")}
            </Text>
          </View>
          {taxBreakdowns.map((row) => (
            <View key={row.id} style={styles.tableRow} wrap={false}>
              <Text style={[styles.td, styles.vatColCategory]}>
                {vatCategoryLabel(row.vat_category_code, row.vat_rate, locale)}
              </Text>
              <Text style={[styles.td, styles.vatColTaxable]}>
                {formatMoney(row.taxable_amount, invoice.currency, locale)}
              </Text>
              <Text style={[styles.td, styles.vatColAmount]}>
                {formatMoney(row.vat_amount, invoice.currency, locale)}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.totalsBlock}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>{translate(locale, "invoices.newInvoice.subtotalLabel")}</Text>
            <Text style={styles.totalsValue}>
              {formatMoney(invoice.subtotal_amount, invoice.currency, locale)}
            </Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>{translate(locale, "invoices.newInvoice.vatTotalLabel")}</Text>
            <Text style={styles.totalsValue}>
              {formatMoney(invoice.vat_total_amount, invoice.currency, locale)}
            </Text>
          </View>
          {rounding !== 0 && (
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>{translate(locale, "invoices.pdf.roundingLabel")}</Text>
              <Text style={styles.totalsValue}>{formatMoney(rounding, invoice.currency, locale)}</Text>
            </View>
          )}
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>{translate(locale, "invoices.pdf.totalDueLabel")}</Text>
            <Text style={styles.grandTotalValue}>
              {formatMoney(invoice.total_amount, invoice.currency, locale)}
            </Text>
          </View>
        </View>

        {(seller?.iban || invoice.variable_symbol || invoice.due_date) && (
          <View style={styles.paymentBox}>
            <Text style={styles.partyLabel}>{translate(locale, "invoices.pdf.paymentDetailsTitle")}</Text>
            {seller?.iban && (
              <Text style={styles.paymentLine}>
                {translate(locale, "invoices.pdf.ibanLabel")}: {seller.iban}
              </Text>
            )}
            {seller?.bic && (
              <Text style={styles.paymentLine}>
                {translate(locale, "invoices.pdf.bicLabel")}: {seller.bic}
              </Text>
            )}
            {invoice.variable_symbol && (
              <Text style={styles.paymentLine}>
                {translate(locale, "invoices.pdf.variableSymbolLabel")}: {invoice.variable_symbol}
              </Text>
            )}
            {invoice.due_date && (
              <Text style={styles.paymentLine}>
                {translate(locale, "invoices.newInvoice.dueDateLabel")}: {formatDate(invoice.due_date, locale)}
              </Text>
            )}
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>{translate(locale, "invoices.pdf.footerNote")}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/**
 * Vyrenderuje finalizovanú faktúru do PDF Buffer. Volajúci (API route) je
 * zodpovedný za to, že `bundle` obsahuje VÝHRADNE už načítané, RLS-scoped,
 * finalizované canonical dáta — táto funkcia samotná nič nedotazuje ani
 * neautorizuje.
 */
export async function renderInvoicePdfBuffer(bundle: InvoicePdfBundle): Promise<Buffer> {
  ensureFontsRegistered();
  return renderToBuffer(<InvoicePdfDocument {...bundle} />);
}
