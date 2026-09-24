"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate } from "@/lib/i18n/format";
import type { DownloadState } from "@/lib/invoicing/document-package";

/**
 * Kompaktné označenie „Stiahnuté 2×". Nič nezamyká — je to história, nie
 * stav, ktorý by bránil ďalšiemu stiahnutiu. Pri nestiahnutom doklade sa
 * štandardne nekreslí nič, aby register nebol preplnený.
 */
export function DownloadStateBadge({
  state,
  showNever = false,
}: {
  state: DownloadState;
  showNever?: boolean;
}) {
  const { t, locale } = useLocale();

  if (!state.downloaded) {
    if (!showNever) return null;
    return (
      <span className="rounded-doc-sm border border-doc-border px-2 py-0.5 text-xs font-medium text-muted-esblu">
        {t("folders.downloadState.never")}
      </span>
    );
  }

  const label =
    state.count > 1
      ? t("folders.downloadState.downloadedTimes", { count: state.count })
      : t("folders.downloadState.downloaded");
  const last = state.lastDownloadedAt
    ? t("folders.downloadState.last", { date: formatDate(state.lastDownloadedAt, locale) })
    : "";

  return (
    <span
      title={last || undefined}
      className="rounded-doc-sm bg-success-soft px-2 py-0.5 text-xs font-medium text-success"
    >
      {label}
    </span>
  );
}
