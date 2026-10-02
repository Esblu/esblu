import type { EinvoiceTimelineItem } from "@/lib/einvoice/ui/types";
import { timelineLabelKey, timelineSourceKey, type HasKey, type Translate } from "@/lib/einvoice/ui/view-model";

/** Časová os udalostí E-Faktúry (chronologicky). Bez UUID, bez technických detailov. */
export function EinvoiceTimeline({
  items,
  t,
  has,
  formatDateTime,
}: {
  items: EinvoiceTimelineItem[];
  t: Translate;
  has: HasKey;
  formatDateTime: (iso: string) => string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-secondary">{t("invoices.einvoice.panel.timelineEmpty")}</p>;
  }
  return (
    <ol className="min-w-0 space-y-3 border-l border-doc-border pl-4" aria-label={t("invoices.einvoice.panel.timelineTitle")}>
      {items.map((item, index) => (
        <li key={`${item.at}-${index}`} className="relative min-w-0">
          <span aria-hidden="true" className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-accent-cyan" />
          <p className="break-words text-sm font-medium text-primary">{t(timelineLabelKey(item, has))}</p>
          <p className="text-xs text-secondary">
            <time dateTime={item.at}>{formatDateTime(item.at)}</time>
            {" · "}
            {t(timelineSourceKey(item))}
          </p>
        </li>
      ))}
    </ol>
  );
}
