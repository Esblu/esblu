import type { Workbook, Worksheet } from "exceljs";
import { downloadBlob } from "@/lib/file-actions";
import { computeFileSha256 } from "@/lib/invoicing/received-dedupe";

// =============================================================================
// Odovzdanie dokladov účtovníkovi (handoff).
//
// ČO TO JE
// --------
// Jeden zošit za zvolené obdobie a smer: hlavičky dokladov, riadkové
// položky a rozpis DPH — teda to, z čoho účtovník doklad zaúčtuje. Súčasťou
// je aj odkaz na zdrojový dokument, aby sa originál dal dohľadať.
//
// ČO TO NIE JE
// ------------
// Nie je to zákonný archív ani štandardizovaný výmenný formát. Esblu
// nevymýšľa formát pre finančnú správu a netvári sa, že ho spĺňa — je to
// prehľadný podklad na odovzdanie. Skutočné dlhodobé uchovávanie prebieha
// mimo Esblu.
//
// ODTLAČOK
// --------
// Zo súboru sa počíta SHA-256 a ukladá sa k udalosti odovzdania. Vďaka
// tomu sa dá neskôr overiť, že súbor u účtovníka je naozaj ten, o ktorom
// hovorí záznam v Esblu — aj keď prevádzková kópia dokladov už v Esblu
// nebude.
// =============================================================================

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

const HEADER_FILL = "1D4ED8";
const HEADER_TEXT = "FFFFFF";

export type HandoffInvoice = {
  id: string;
  direction: string;
  kind: string;
  document_status: string;
  payment_status: string;
  invoice_number: string | null;
  supplier_invoice_number: string | null;
  issue_date: string;
  due_date: string | null;
  currency: string;
  subtotal_amount: number;
  vat_total_amount: number;
  total_amount: number;
  variable_symbol: string | null;
  source_document_id: string | null;
  counterpartyName: string;
  counterpartyIco: string | null;
  counterpartyIcDph: string | null;
  accountingStatus: string;
  items: {
    description: string;
    quantity: number;
    unit: string | null;
    unit_price: number;
    vat_category_code: string;
    vat_rate: number;
    line_net_amount: number;
    line_vat_amount: number;
    line_gross_amount: number;
  }[];
};

export type HandoffExportResult = {
  exportedCount: number;
  fileName: string;
  manifestSha256: string;
};

function styleHeaderRow(worksheet: Worksheet, rowNumber: number): void {
  const row = worksheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: HEADER_TEXT } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height = 24;
}

function autoWidths(worksheet: Worksheet, maximums: readonly number[]): void {
  worksheet.columns.forEach((_column, index) => {
    const column = worksheet.getColumn(index + 1);
    let width = 10;
    column.eachCell({ includeEmpty: false }, (cell) => {
      width = Math.max(width, cell.text.length + 2);
    });
    column.width = Math.min(width, maximums[index] ?? 30);
  });
}

function localDatePart(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Vytvorí zošit, stiahne ho a vráti jeho odtlačok.
 *
 * Udalosť odovzdania zapisuje AŽ volajúci, a to po návrate tejto funkcie —
 * záznam o odovzdaní nemá vzniknúť skôr než samotný súbor.
 */
export async function exportAccountingHandoff(
  invoices: readonly HandoffInvoice[],
  t: TranslateFn
): Promise<HandoffExportResult> {
  if (invoices.length === 0) {
    throw new Error(t("xlsxExport.noDocumentsToExport"));
  }

  const excelJsModule = await import("exceljs");
  const ExcelJS = excelJsModule.default ?? excelJsModule;
  const workbook: Workbook = new ExcelJS.Workbook();
  const generatedAt = new Date();

  workbook.creator = "Esblu";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;

  // --------------------------------------------------------------------
  // Hárok 1 — doklady
  // --------------------------------------------------------------------
  const headerSheet = workbook.addWorksheet(t("handoff.sheet.invoices"), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const invoiceHeaders = [
    t("handoff.col.number"),
    t("handoff.col.direction"),
    t("handoff.col.issueDate"),
    t("handoff.col.dueDate"),
    t("handoff.col.counterparty"),
    t("handoff.col.ico"),
    t("handoff.col.icDph"),
    t("handoff.col.subtotal"),
    t("handoff.col.vat"),
    t("handoff.col.total"),
    t("handoff.col.currency"),
    t("handoff.col.paymentStatus"),
    t("handoff.col.accountingStatus"),
    t("handoff.col.variableSymbol"),
    t("handoff.col.sourceDocument"),
  ];
  headerSheet.addRow(invoiceHeaders);
  styleHeaderRow(headerSheet, 1);
  headerSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: invoiceHeaders.length } };

  for (const invoice of invoices) {
    headerSheet.addRow([
      invoice.direction === "received"
        ? invoice.supplier_invoice_number ?? ""
        : invoice.invoice_number ?? "",
      t(`invoices.direction.${invoice.direction}`),
      invoice.issue_date,
      invoice.due_date ?? "",
      invoice.counterpartyName,
      invoice.counterpartyIco ?? "",
      invoice.counterpartyIcDph ?? "",
      invoice.subtotal_amount,
      invoice.vat_total_amount,
      invoice.total_amount,
      invoice.currency,
      t(`invoices.paymentStatus.${invoice.payment_status}`),
      t(`handoff.accountingStatus.${invoice.accountingStatus}`),
      invoice.variable_symbol ?? "",
      invoice.source_document_id ?? "",
    ]);
  }

  autoWidths(headerSheet, [18, 12, 12, 12, 32, 14, 16, 14, 14, 14, 10, 14, 16, 16, 38]);

  // --------------------------------------------------------------------
  // Hárok 2 — riadkové položky
  //
  // Samostatný hárok, nie zlúčené bunky. Účtovník s ním vie pracovať ako s
  // tabuľkou a doklad s desiatimi riadkami nerozbije zoradenie hlavičiek.
  // --------------------------------------------------------------------
  const itemSheet = workbook.addWorksheet(t("handoff.sheet.items"), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const itemHeaders = [
    t("handoff.col.number"),
    t("handoff.col.description"),
    t("handoff.col.quantity"),
    t("handoff.col.unit"),
    t("handoff.col.unitPrice"),
    t("handoff.col.vatCategory"),
    t("handoff.col.vatRate"),
    t("handoff.col.lineNet"),
    t("handoff.col.lineVat"),
    t("handoff.col.lineGross"),
  ];
  itemSheet.addRow(itemHeaders);
  styleHeaderRow(itemSheet, 1);

  for (const invoice of invoices) {
    const label =
      invoice.direction === "received"
        ? invoice.supplier_invoice_number ?? invoice.id
        : invoice.invoice_number ?? invoice.id;

    for (const item of invoice.items) {
      itemSheet.addRow([
        label,
        item.description,
        item.quantity,
        item.unit ?? "",
        item.unit_price,
        item.vat_category_code,
        item.vat_rate,
        item.line_net_amount,
        item.line_vat_amount,
        item.line_gross_amount,
      ]);
    }
  }

  autoWidths(itemSheet, [18, 40, 10, 10, 14, 12, 10, 14, 14, 14]);

  // --------------------------------------------------------------------
  // Hárok 3 — rozpis DPH
  // --------------------------------------------------------------------
  const vatSheet = workbook.addWorksheet(t("handoff.sheet.vat"), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  vatSheet.addRow([
    t("handoff.col.vatCategory"),
    t("handoff.col.vatRate"),
    t("handoff.col.taxableAmount"),
    t("handoff.col.vatAmount"),
  ]);
  styleHeaderRow(vatSheet, 1);

  // Zoskupenie podľa kategórie a sadzby — presne to, čo ide do priznania.
  const breakdown = new Map<string, { category: string; rate: number; net: number; vat: number }>();
  for (const invoice of invoices) {
    for (const item of invoice.items) {
      const key = `${item.vat_category_code}|${item.vat_rate}`;
      const entry =
        breakdown.get(key) ?? { category: item.vat_category_code, rate: item.vat_rate, net: 0, vat: 0 };
      entry.net += item.line_net_amount;
      entry.vat += item.line_vat_amount;
      breakdown.set(key, entry);
    }
  }

  for (const entry of breakdown.values()) {
    vatSheet.addRow([entry.category, entry.rate, Number(entry.net.toFixed(2)), Number(entry.vat.toFixed(2))]);
  }

  autoWidths(vatSheet, [14, 10, 16, 16]);

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const manifestSha256 = await computeFileSha256(blob);
  if (!manifestSha256) {
    // Bez odtlačku by záznam o odovzdaní nič nedokazoval. Radšej sa export
    // nedokončí, než aby vznikla evidencia, ktorá sa nedá overiť.
    throw new Error(t("handoff.errors.hashUnavailable"));
  }

  const fileName = `odovzdanie_uctovnictvo_${localDatePart(generatedAt)}.xlsx`;
  await downloadBlob(blob, fileName);

  return { exportedCount: invoices.length, fileName, manifestSha256 };
}
