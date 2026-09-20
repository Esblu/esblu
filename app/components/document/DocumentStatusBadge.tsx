"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";

// =============================================================================
// Jednotný status/source badge pre všetky dokumentové plochy.
//
// PREČO EXISTUJE
// --------------
// Audit našiel v appke najmenej osem navzájom nekompatibilných receptov na
// badge — `.badge-*` utility, `bg-*-soft` + `text-amber-400`, surové
// `bg-amber-100/text-amber-900`, `bg-slate-200/dark:`, `bg-accent-cyan/12`,
// `bg-amber-400/12` — a samotný `needs_review` badge bol skopírovaný na troch
// miestach v jednom súbore. Toto je jediné miesto, kde sa o farbe stavu
// rozhoduje.
//
// PRÍSTUPNOSŤ (§25)
// -----------------
// Stav NIKDY nie je odlíšený len farbou: každý badge nesie text a bodku s
// vlastným tvarom kontrastu. Používateľ s poruchou farbocitu prečíta stav z
// textu, nie z odtieňa.
//
// TONALITA
// --------
// Zámerne iba ŠTYRI tóny, nie desať farieb. Dokumentový register má byť
// pokojný — farba sa používa na upozornenie, nie na dekoráciu.
//   neutral  bežný, nič sa nedeje (koncept, vydaná, prijatá, zdroj)
//   positive dokončené/uhradené
//   warning  vyžaduje pozornosť používateľa
//   critical chyba alebo blokujúci duplikát
// =============================================================================

export type DocumentStatusTone = "neutral" | "positive" | "warning" | "critical";

export type DocumentStatusKind =
  | "draft"
  | "finalized"
  | "paid"
  | "partially_paid"
  | "unpaid"
  | "overdue"
  | "received"
  | "issued"
  | "processing"
  | "needs_review"
  | "duplicate"
  | "error";

const TONE_BY_KIND: Record<DocumentStatusKind, DocumentStatusTone> = {
  draft: "neutral",
  finalized: "neutral",
  paid: "positive",
  partially_paid: "warning",
  unpaid: "neutral",
  overdue: "critical",
  received: "neutral",
  issued: "neutral",
  processing: "neutral",
  needs_review: "warning",
  duplicate: "critical",
  error: "critical",
};

const TONE_CLASS: Record<DocumentStatusTone, string> = {
  neutral: "border-doc-border bg-surface-2 text-secondary",
  positive: "border-transparent badge-success",
  warning: "border-transparent badge-warning",
  critical: "border-transparent badge-danger",
};

const DOT_CLASS: Record<DocumentStatusTone, string> = {
  neutral: "bg-text-muted",
  positive: "bg-success",
  warning: "bg-warning",
  critical: "bg-danger",
};

export function DocumentStatusBadge({
  kind,
  label,
  className = "",
}: {
  kind: DocumentStatusKind;
  /** Vlastný text. Bez neho sa použije invoices.statusBadge.<kind>. */
  label?: string;
  className?: string;
}) {
  const { t } = useLocale();
  const tone = TONE_BY_KIND[kind];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-doc-sm border px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]} ${className}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[tone]}`} />
      {label ?? t(`invoices.statusBadge.${kind}`)}
    </span>
  );
}

/**
 * Pôvod dokladu. Zámerne tichší než status (§20): je to metadáta, nie stav.
 * Žiadna farebná výplň, iba jemný rám — aby v registri nikdy nepreválcoval
 * informáciu o tom, či je faktúra uhradená.
 */
export function DocumentSourceBadge({
  source,
  className = "",
}: {
  source: string;
  className?: string;
}) {
  const { t } = useLocale();
  return (
    <span
      className={`inline-flex items-center rounded-doc-sm border border-doc-border px-2 py-0.5 text-[11px] font-medium text-muted-esblu ${className}`}
    >
      {t(`invoices.source.${source}`)}
    </span>
  );
}
