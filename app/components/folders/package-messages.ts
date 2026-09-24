import type { PackageDownloadError, PackageDownloadOutcome } from "@/lib/document-package-client";

type T = (key: string, vars?: Record<string, string | number>) => string;

const KNOWN_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NO_ACTIVE_COMPANY",
  "NO_DOCUMENTS_SELECTED",
  "TOO_MANY_DOCUMENTS",
  "FOLDER_NOT_FOUND",
  "NOTHING_TO_PACKAGE",
  "PACKAGE_TOO_LARGE",
  "INTEGRITY_FAILED",
  "PDF_FAILED",
  "RECORD_FAILED",
  "INTERNAL_ERROR",
  "INCOMPLETE_TRANSFER",
]);

/**
 * Veta o výsledku stiahnutia. Hovorí, koľko dokladov v balíku NAOZAJ bolo,
 * čo sa vynechalo a prečo, a či sa podarilo zapísať „Stiahnuté".
 */
export function describePackageOutcome(
  t: T,
  outcome: PackageDownloadOutcome
): { tone: "info" | "warning"; text: string } {
  let text = t("folders.downloadDone", {
    file: outcome.fileName,
    count: outcome.itemCount,
    files: outcome.fileCount,
  });
  if (outcome.excluded.length > 0) {
    const list = outcome.excluded
      .slice(0, 5)
      .map((item) => `${item.label} (${t(`folders.excludedReason.${item.reason}`)})`)
      .join("; ");
    text += t("folders.downloadExcluded", { count: outcome.excluded.length, list });
  }
  if (outcome.recorded === null) text += t("folders.downloadRecordFailed");
  return { tone: outcome.excluded.length > 0 || outcome.recorded === null ? "warning" : "info", text };
}

/** Chyba v jazyku používateľa. Kód sa overuje voči známemu zoznamu. */
export function describePackageError(t: T, error: PackageDownloadError | null): string {
  if (!error) return t("folders.package.errors.INTERNAL_ERROR");
  const code = KNOWN_CODES.has(error.code) ? error.code : "INTERNAL_ERROR";
  let text = t(`folders.package.errors.${code}`, { max: 500 });
  if (error.excluded.length > 0) {
    text +=
      " " +
      error.excluded
        .slice(0, 5)
        .map((item) => `${item.label} (${t(`folders.excludedReason.${item.reason}`)})`)
        .join("; ");
  }
  return text;
}
