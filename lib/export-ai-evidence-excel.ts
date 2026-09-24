import type { Workbook, Worksheet } from "exceljs";
import { downloadBlob } from "@/lib/file-actions";
import { normalizeSpz } from "@/lib/normalize-spz";
import {
  convertWeightToTons,
  getEffectiveNetto,
  parseWeightValue,
} from "@/lib/weight-utils";
import type { Locale } from "@/lib/i18n/locales";
import { toIntlLocale } from "@/lib/i18n/format";

type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>
) => string;

export { normalizeWeightUnit } from "@/lib/normalize-weight-unit";

export type AiEvidenceExcelRecord = {
  id: string;
  spz: string | null;
  document_type: string | null;
  movement_type: string | null;
  supplier: string | null;
  customer: string | null;
  document_number: string | null;
  material: string | null;
  material_original: string | null;
  material_category: string | null;
  document_date: string | null;
  brutto: number | string | null;
  tara: number | string | null;
  netto: number | string | null;
  unit: string | null;
  construction_site: string | null;
  source_location: string | null;
  destination_location: string | null;
  photo_url: string | null;
  raw_text: string | null;
  created_at: string | null;
  quantity: number | string | null;
};

type ExportResult = {
  exportedCount: number;
  fileName: string;
  /** Iba pri `deliver: false` — zošit na zabalenie do ZIP-u s fotkami. */
  blob?: Blob;
};

type UnknownUnitSummary = {
  label: string;
  count: number;
  netto: number;
};

type VehicleNettoSummary = {
  totalImportTons: number;
  totalExportTons: number;
  totalTons: number;
  unknownUnits: Map<string, UnknownUnitSummary>;
};

function getDetailHeaders(t: TranslateFn): string[] {
  const h = "xlsxExport.evidence.detailHeaders";
  return [
    t(`${h}.documentType`),
    t(`${h}.documentDate`),
    t(`${h}.documentNumber`),
    t(`${h}.spz`),
    t(`${h}.supplier`),
    t(`${h}.customer`),
    t(`${h}.material`),
    t(`${h}.materialOriginal`),
    t(`${h}.materialCategory`),
    t(`${h}.brutto`),
    t(`${h}.tara`),
    t(`${h}.netto`),
    t(`${h}.unit`),
    t(`${h}.movementDirection`),
    t(`${h}.constructionSite`),
    t(`${h}.sourceLocation`),
    t(`${h}.destinationLocation`),
    t(`${h}.documentPath`),
    t(`${h}.rawText`),
    t(`${h}.recordCreatedAt`),
  ];
}

const HEADER_FILL = "1D4ED8";
const HEADER_TEXT = "FFFFFF";
const SECTION_FILL = "DBEAFE";
const BORDER_COLOR = "CBD5E1";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export { getEffectiveNetto } from "@/lib/weight-utils";

export function normalizeMovementType(
  value: string | null | undefined
): "import" | "export" | null {
  const normalizedMovement = normalizeText(value).replace(/\s/g, "");

  if (["dovoz", "import", "prijem", "inbound"].includes(normalizedMovement)) {
    return "import";
  }

  if (["vyvoz", "export", "odvoz", "outbound"].includes(normalizedMovement)) {
    return "export";
  }

  return null;
}

function parseDateOnly(value: string | null): Date | null {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function parseDateTime(value: string | null): Date | null {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLocalDateFilePart(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
}

function addToGroup(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function styleHeaderRow(worksheet: Worksheet, rowNumber: number) {
  const row = worksheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: HEADER_TEXT } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: HEADER_FILL },
  };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height = 24;
}

function styleSectionTitle(worksheet: Worksheet, rowNumber: number) {
  const row = worksheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: "1E3A8A" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: SECTION_FILL },
  };
  row.height = 22;
}

function setAutomaticColumnWidths(
  worksheet: Worksheet,
  maximumWidths: readonly number[]
) {
  worksheet.columns.forEach((_column, index) => {
    const column = worksheet.getColumn(index + 1);
    let width = 10;

    column.eachCell({ includeEmpty: false }, (cell) => {
      const textLength = cell.text.length;
      width = Math.max(width, textLength + 2);
    });

    column.width = Math.min(width, maximumWidths[index] ?? 35);
  });
}

function addSummaryTable(
  worksheet: Worksheet,
  startRow: number,
  title: string,
  firstHeader: string,
  values: ReadonlyMap<string, number>,
  t: TranslateFn,
  intlLocale: string
): number {
  worksheet.getCell(startRow, 1).value = title;
  worksheet.mergeCells(startRow, 1, startRow, 3);
  styleSectionTitle(worksheet, startRow);

  const headerRow = startRow + 1;
  worksheet.getRow(headerRow).values = [
    firstHeader,
    t("xlsxExport.evidence.detailHeaders.netto"),
    t("xlsxExport.evidence.detailHeaders.unit"),
  ];
  styleHeaderRow(worksheet, headerRow);

  const sortedValues = [...values.entries()].sort(([left], [right]) =>
    left.localeCompare(right, intlLocale)
  );

  sortedValues.forEach(([label, netto], index) => {
    const row = worksheet.getRow(headerRow + index + 1);
    row.values = [label, netto, "t"];
    row.getCell(2).numFmt = "#,##0.000";
  });

  if (sortedValues.length === 0) {
    worksheet.getCell(headerRow + 1, 1).value = t(
      "xlsxExport.evidence.noValidNetto"
    );
  }

  return headerRow + Math.max(sortedValues.length, 1) + 2;
}

function addUnknownUnitsTable(
  worksheet: Worksheet,
  startRow: number,
  values: ReadonlyMap<string, UnknownUnitSummary>,
  t: TranslateFn,
  intlLocale: string
) {
  worksheet.getCell(startRow, 1).value = t(
    "xlsxExport.evidence.unknownUnitsTitle"
  );
  worksheet.mergeCells(startRow, 1, startRow, 3);
  styleSectionTitle(worksheet, startRow);

  const headerRow = startRow + 1;
  worksheet.getRow(headerRow).values = [
    t("xlsxExport.evidence.unknownUnitsHeaders.originalUnit"),
    t("xlsxExport.evidence.unknownUnitsHeaders.recordCount"),
    t("xlsxExport.evidence.unknownUnitsHeaders.nettoSumOriginalUnit"),
  ];
  styleHeaderRow(worksheet, headerRow);

  const sortedValues = [...values.values()].sort((left, right) =>
    left.label.localeCompare(right.label, intlLocale)
  );

  sortedValues.forEach((summary, index) => {
    const row = worksheet.getRow(headerRow + index + 1);
    row.values = [summary.label, summary.count, summary.netto];
    row.getCell(2).numFmt = "#,##0";
    row.getCell(3).numFmt = "#,##0.000";
  });

  if (sortedValues.length === 0) {
    worksheet.getCell(headerRow + 1, 1).value = t(
      "xlsxExport.evidence.noUnknownUnits"
    );
  }
}

function calculateVehicleNettoSummary(
  records: readonly AiEvidenceExcelRecord[],
  t: TranslateFn
): VehicleNettoSummary {
  const summary: VehicleNettoSummary = {
    totalImportTons: 0,
    totalExportTons: 0,
    totalTons: 0,
    unknownUnits: new Map<string, UnknownUnitSummary>(),
  };

  records.forEach((record) => {
    const effectiveNetto = getEffectiveNetto(record);
    if (effectiveNetto === null) return;

    const tons = convertWeightToTons(effectiveNetto, record.unit);
    if (tons === null) {
      const unitLabel =
        record.unit?.trim() || t("xlsxExport.evidence.withoutUnit");
      const unitKey = normalizeText(unitLabel) || "bez jednotky";
      const current = summary.unknownUnits.get(unitKey) ?? {
        label: unitLabel,
        count: 0,
        netto: 0,
      };

      current.count += 1;
      current.netto += effectiveNetto;
      summary.unknownUnits.set(unitKey, current);
      return;
    }

    const direction = normalizeMovementType(record.movement_type);
    if (direction === "import") {
      summary.totalImportTons += tons;
    } else if (direction === "export") {
      summary.totalExportTons += tons;
    }
  });

  summary.totalTons = summary.totalImportTons + summary.totalExportTons;

  return summary;
}

function addVehicleSummary(
  worksheet: Worksheet,
  startRow: number,
  records: readonly AiEvidenceExcelRecord[],
  t: TranslateFn,
  intlLocale: string
) {
  const summary = calculateVehicleNettoSummary(records, t);

  worksheet.getCell(startRow, 1).value = t(
    "xlsxExport.evidence.vehicleSummaryTitle"
  );
  worksheet.mergeCells(startRow, 1, startRow, 3);
  styleSectionTitle(worksheet, startRow);

  const summaryRows = [
    [t("xlsxExport.evidence.totalImportNetto"), summary.totalImportTons, "t"],
    [t("xlsxExport.evidence.totalExportNetto"), summary.totalExportTons, "t"],
    [t("xlsxExport.evidence.totalNettoCombined"), summary.totalTons, "t"],
  ] as const;

  summaryRows.forEach((values, index) => {
    const row = worksheet.getRow(startRow + index + 1);
    row.values = [...values];
    row.getCell(1).font = { bold: true };
    row.getCell(2).numFmt = "#,##0.000";
  });

  addUnknownUnitsTable(worksheet, startRow + 5, summary.unknownUnits, t, intlLocale);
}

function getSpzGroupName(record: AiEvidenceExcelRecord, t: TranslateFn): string {
  return normalizeSpz(record.spz) || t("xlsxExport.evidence.withoutSpz");
}

function sanitizeWorksheetName(name: string, t: TranslateFn): string {
  const sanitized = name
    .replace(/[\\/*?:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (sanitized || t("xlsxExport.evidence.withoutSpz")).slice(0, 31);
}

function getUniqueWorksheetName(
  baseName: string,
  usedNames: Set<string>,
  t: TranslateFn,
  intlLocale: string
) {
  const sanitizedBase = sanitizeWorksheetName(baseName, t);
  let candidate = sanitizedBase;
  let suffixNumber = 2;

  while (usedNames.has(candidate.toLocaleLowerCase(intlLocale))) {
    const suffix = ` (${suffixNumber})`;
    candidate = `${sanitizedBase.slice(0, 31 - suffix.length)}${suffix}`;
    suffixNumber += 1;
  }

  usedNames.add(candidate.toLocaleLowerCase(intlLocale));
  return candidate;
}

function addDocumentSheet(
  workbook: Workbook,
  sheetName: string,
  records: readonly AiEvidenceExcelRecord[],
  t: TranslateFn,
  intlLocale: string
) {
  const detailSheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  detailSheet.addRow(getDetailHeaders(t));
  styleHeaderRow(detailSheet, 1);
  detailSheet.autoFilter = "A1:T1";

  records.forEach((record) => {
    const row = detailSheet.addRow([
      record.document_type,
      parseDateOnly(record.document_date),
      record.document_number,
      record.spz,
      record.supplier,
      record.customer,
      record.material,
      record.material_original,
      record.material_category,
      parseWeightValue(record.brutto),
      parseWeightValue(record.tara),
      getEffectiveNetto(record),
      record.unit,
      record.movement_type,
      record.construction_site,
      record.source_location,
      record.destination_location,
      record.photo_url,
      record.raw_text,
      parseDateTime(record.created_at),
    ]);

    row.alignment = { vertical: "top" };
    row.getCell(2).numFmt = "dd.mm.yyyy";
    row.getCell(10).numFmt = "#,##0.000";
    row.getCell(11).numFmt = "#,##0.000";
    row.getCell(12).numFmt = "#,##0.000";
    row.getCell(19).alignment = { vertical: "top", wrapText: true };
    row.getCell(20).numFmt = "dd.mm.yyyy hh:mm";
  });

  detailSheet.getColumn(2).numFmt = "dd.mm.yyyy";
  detailSheet.getColumn(19).alignment = { vertical: "top", wrapText: true };
  detailSheet.getColumn(20).numFmt = "dd.mm.yyyy hh:mm";
  addVehicleSummary(detailSheet, detailSheet.rowCount + 2, records, t, intlLocale);
  setAutomaticColumnWidths(detailSheet, [
    30, 16, 20, 14, 30, 30, 30, 34, 24, 16, 16, 16, 14, 18, 30, 30, 30,
    45, 60, 24,
  ]);

  detailSheet.getRow(1).eachCell((cell) => {
    cell.border = {
      bottom: { style: "thin", color: { argb: BORDER_COLOR } },
    };
  });
}

export async function exportAiEvidenceToExcel(
  records: readonly AiEvidenceExcelRecord[],
  locale: Locale,
  t: TranslateFn,
  options: { deliver?: boolean } = {}
): Promise<ExportResult> {
  const intlLocale = toIntlLocale(locale);

  if (records.length === 0) {
    throw new Error(t("xlsxExport.noDocumentsToExport"));
  }

  const excelJsModule = await import("exceljs");
  const ExcelJS = excelJsModule.default ?? excelJsModule;
  const workbook = new ExcelJS.Workbook();
  const generatedAt = new Date();

  workbook.creator = "Esblu";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;

  const nettoByMaterial = new Map<string, number>();
  const nettoBySpz = new Map<string, number>();
  const unknownUnits = new Map<string, UnknownUnitSummary>();
  let totalNettoTons = 0;

  records.forEach((record) => {
    const effectiveNetto = getEffectiveNetto(record);
    if (effectiveNetto === null) return;

    const tons = convertWeightToTons(effectiveNetto, record.unit);
    if (tons !== null) {
      const material =
        record.material?.trim() ||
        record.material_original?.trim() ||
        t("xlsxExport.evidence.withoutMaterial");
      const spz = getSpzGroupName(record, t);

      totalNettoTons += tons;
      addToGroup(nettoByMaterial, material, tons);
      addToGroup(nettoBySpz, spz, tons);
      return;
    }

    const unitLabel =
      record.unit?.trim() || t("xlsxExport.evidence.withoutUnit");
    const unitKey = normalizeText(unitLabel) || "bez jednotky";
    const current = unknownUnits.get(unitKey) ?? {
      label: unitLabel,
      count: 0,
      netto: 0,
    };

    current.count += 1;
    current.netto += effectiveNetto;
    unknownUnits.set(unitKey, current);
  });

  const summarySheet = workbook.addWorksheet(
    t("xlsxExport.evidence.summarySheetName"),
    {
      views: [{ state: "frozen", ySplit: 1 }],
    }
  );

  summarySheet.mergeCells("A1:C1");
  summarySheet.getCell("A1").value = t("xlsxExport.evidence.summaryTitle");
  styleHeaderRow(summarySheet, 1);
  summarySheet.getCell("A3").value = t(
    "xlsxExport.evidence.exportedDocumentCount"
  );
  summarySheet.getCell("B3").value = records.length;
  summarySheet.getCell("B3").numFmt = "#,##0";
  summarySheet.getCell("A4").value = t("xlsxExport.evidence.totalNetto");
  summarySheet.getCell("B4").value = totalNettoTons;
  summarySheet.getCell("B4").numFmt = "#,##0.000";
  summarySheet.getCell("C4").value = "t";
  summarySheet.getCell("A5").value = t("xlsxExport.evidence.nettoNote");
  summarySheet.mergeCells("A5:C5");
  summarySheet.getCell("A5").font = { italic: true, color: { argb: "475569" } };
  summarySheet.getCell("A5").alignment = { wrapText: true };

  let nextRow = addSummaryTable(
    summarySheet,
    7,
    t("xlsxExport.evidence.nettoByMaterial"),
    t("xlsxExport.evidence.detailHeaders.material"),
    nettoByMaterial,
    t,
    intlLocale
  );
  nextRow = addSummaryTable(
    summarySheet,
    nextRow,
    t("xlsxExport.evidence.nettoBySpz"),
    t("xlsxExport.evidence.detailHeaders.spz"),
    nettoBySpz,
    t,
    intlLocale
  );
  addUnknownUnitsTable(summarySheet, nextRow, unknownUnits, t, intlLocale);

  summarySheet.getColumn(1).alignment = { vertical: "top", wrapText: true };
  summarySheet.getColumn(2).alignment = {
    vertical: "top",
    horizontal: "right",
  };
  summarySheet.getColumn(3).alignment = { vertical: "top" };
  setAutomaticColumnWidths(summarySheet, [48, 24, 34]);

  const recordsBySpz = new Map<string, AiEvidenceExcelRecord[]>();
  records.forEach((record) => {
    const spz = getSpzGroupName(record, t);
    const group = recordsBySpz.get(spz) ?? [];
    group.push(record);
    recordsBySpz.set(spz, group);
  });

  const usedSheetNames = new Set([
    t("xlsxExport.evidence.summarySheetName").toLocaleLowerCase(intlLocale),
  ]);
  [...recordsBySpz.entries()]
    .sort(([left], [right]) => left.localeCompare(right, intlLocale))
    .forEach(([spz, group]) => {
      const sheetName = getUniqueWorksheetName(
        spz,
        usedSheetNames,
        t,
        intlLocale
      );
      addDocumentSheet(workbook, sheetName, group, t, intlLocale);
    });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const fileName = `ai-evidencia_${getLocalDateFilePart(generatedAt)}.xlsx`;
  if (options.deliver === false) {
    return { exportedCount: records.length, fileName, blob };
  }
  await downloadBlob(blob, fileName);

  return { exportedCount: records.length, fileName };
}
