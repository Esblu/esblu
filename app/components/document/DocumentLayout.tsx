"use client";

import type { ReactNode } from "react";

// =============================================================================
// Kancelárske primitívy pre dokumentové plochy.
//
// Audit našiel v /ai-evidencia štyri kópie tej istej karty, tri kópie dlaždice
// priečinka a tri rôzne modálne schránky; /faktury a /obchodni-partneri si
// ručne písali `rounded-3xl border border-subtle bg-surface-1 p-6 shadow-lg`.
// Tieto komponenty sú jediná definícia toho, ako dokumentová plocha vyzerá.
//
// Držia sa existujúcej TMAVEJ palety — nie je to druhá téma. Rozdiel oproti
// zvyšku appky je zámerne tichý: menší rádius (0.75rem namiesto 1.5rem),
// tlmenejší povrch, žiadne tiene, viac whitespace.
// =============================================================================

/** Stránková schránka dokumentovej plochy. Jedna šírka, jeden rytmus. */
export function DocumentPageShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /** Register/zoznam potrebuje viac šírky než detail jedného dokladu. */
  wide?: boolean;
}) {
  return (
    <div className={`mx-auto ${wide ? "max-w-6xl" : "max-w-5xl"} px-4 pb-28 pt-6 sm:px-6`}>
      {children}
    </div>
  );
}

/**
 * Hlavička dokumentu: typ (eyebrow), hlavné číslo, stav a pôvod, vpravo suma
 * alebo primárna akcia.
 *
 * `title` je zámerne `ReactNode` — prijatá faktúra tu ukazuje číslo dodávateľa,
 * vydaná interné číslo, a volajúci si to rozhoduje sám.
 */
export function DocumentHeader({
  eyebrow,
  title,
  badges,
  meta,
  aside,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-doc-border pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-esblu">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 break-words text-2xl font-semibold text-primary">{title}</h1>
        {badges && <div className="mt-2 flex flex-wrap items-center gap-2">{badges}</div>}
        {meta && <div className="mt-2 text-sm text-secondary">{meta}</div>}
      </div>
      {aside && <div className="shrink-0 sm:text-right">{aside}</div>}
    </header>
  );
}

/** Sekcia dokumentu. Nadpis je skutočný <h2> kvôli čítačkám obrazovky. */
export function DocumentSection({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5 ${className}`}
    >
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-primary">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-esblu">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Metadáta dokladu ako definičný zoznam. `<dl>` je tu sémanticky správne —
 * ide o dvojice pojem/hodnota, nie o tabuľku.
 */
export function DocumentMetadataGrid({
  items,
  columns = 2,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; full?: boolean }>;
  columns?: 2 | 3;
}) {
  const visible = items.filter((item) => item.value !== null && item.value !== undefined && item.value !== "");
  if (visible.length === 0) return null;

  return (
    <dl
      className={`grid grid-cols-1 gap-x-6 gap-y-3 ${
        columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"
      }`}
    >
      {visible.map((item, index) => (
        <div key={index} className={item.full ? "sm:col-span-full" : undefined}>
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-esblu">
            {item.label}
          </dt>
          <dd className="mt-0.5 break-words text-sm text-primary">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Blok strany dokladu (dodávateľ/odberateľ) — rovnaký tvar pre oba smery. */
export function DocumentPartyBlock({
  role,
  note,
  name,
  lines,
}: {
  role: ReactNode;
  note?: ReactNode;
  name: ReactNode;
  lines: Array<ReactNode | null | undefined>;
}) {
  return (
    <div className="rounded-doc border border-doc-border bg-surface-2 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-esblu">
        {role}
        {note ? <span className="ml-1 font-normal normal-case">· {note}</span> : null}
      </p>
      <p className="mt-1 font-semibold text-primary">{name}</p>
      <div className="mt-1 space-y-0.5 text-sm text-secondary">
        {lines.filter(Boolean).map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </div>
  );
}

/** Súčty. Posledný riadok je zvýraznený a oddelený linkou. */
export function DocumentTotalsBlock({
  rows,
  total,
}: {
  rows: Array<{ label: ReactNode; value: ReactNode }>;
  total: { label: ReactNode; value: ReactNode };
}) {
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map((row, index) => (
        <div key={index} className="flex items-baseline justify-between gap-4">
          <dt className="text-secondary">{row.label}</dt>
          <dd className="tabular-nums text-primary">{row.value}</dd>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-4 border-t border-doc-border pt-2">
        <dt className="font-semibold text-primary">{total.label}</dt>
        <dd className="text-base font-semibold tabular-nums text-primary">{total.value}</dd>
      </div>
    </dl>
  );
}

/**
 * Akčná lišta. Jedna dominantná primárna akcia, sekundárne tlmené,
 * deštruktívne vizuálne oddelené vpravo (§3E).
 *
 * Na mobile je lepkavá pri spodnej hrane — na doklade je potvrdenie tou
 * akciou, kvôli ktorej používateľ na obrazovku prišiel.
 */
export function DocumentActionBar({
  primary,
  secondary,
  destructive,
  sticky = false,
}: {
  primary?: ReactNode;
  secondary?: ReactNode;
  destructive?: ReactNode;
  sticky?: boolean;
}) {
  return (
    <div
      className={
        sticky
          ? "sticky bottom-0 z-10 -mx-4 border-t border-doc-border bg-page-bg/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-doc sm:border sm:px-4"
          : ""
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {primary}
        {secondary}
        {destructive && <div className="ml-auto">{destructive}</div>}
      </div>
    </div>
  );
}

/** Riadok registra — nahrádza štyri kópie „document card" v Inboxe. */
export function DocumentRow({
  href,
  onClick,
  leading,
  title,
  subtitle,
  badges,
  trailing,
}: {
  href?: string;
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  trailing?: ReactNode;
}) {
  const body = (
    <>
      {leading && <div className="shrink-0 text-muted-esblu">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium text-primary">{title}</span>
          {badges}
        </div>
        {subtitle && <p className="mt-0.5 truncate text-xs text-muted-esblu">{subtitle}</p>}
      </div>
      {trailing && <div className="shrink-0 text-right">{trailing}</div>}
    </>
  );

  const shared =
    "flex w-full items-center gap-3 rounded-doc border border-doc-border bg-doc-surface px-4 py-3 text-left transition hover:border-border-strong hover:bg-doc-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

  if (href) {
    return (
      <a href={href} className={shared}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={shared}>
      {body}
    </button>
  );
}

/**
 * Jedna modálna schránka pre všetky dokumentové modály — Inbox mal tri
 * navzájom odlišné a review štvrtú v cudzej palete.
 */
export function DocumentModal({
  title,
  eyebrow,
  onClose,
  closeLabel,
  size = "lg",
  children,
  footer,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  closeLabel: string;
  size?: "md" | "lg" | "xl";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const width = size === "md" ? "max-w-md" : size === "xl" ? "max-w-3xl" : "max-w-2xl";

  return (
    <div
      role="dialog"
      aria-modal="true"
      /* z-80: plávajúce tlačidlo chatu je fixed na z-70 a pri otvorenom
         modáli prekrývalo jeho akcie v pravom dolnom rohu. Modál preto
         musí byť nad ním — samotný chat sa nemení, len sa počas modálu
         nedostane pred obsah, ktorý má používateľ potvrdiť. */
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:items-center sm:p-6"
    >
      <div
        className={`max-h-[92vh] w-full ${width} overflow-y-auto rounded-doc border border-doc-border bg-surface-1`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-doc-border bg-surface-1/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-esblu">
                {eyebrow}
              </p>
            )}
            <h2 className="mt-0.5 break-words text-lg font-semibold text-primary">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="shrink-0 rounded-doc-sm border border-doc-border px-2.5 py-1.5 text-sm text-secondary transition hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            ✕
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">{children}</div>
        {footer && (
          <div className="sticky bottom-0 border-t border-doc-border bg-surface-1/95 px-5 py-4 backdrop-blur">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Upozornenie v dokumentovom kontexte. Tón nesie aj text, nie len farba. */
export function DocumentNotice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "critical";
  title?: ReactNode;
  children: ReactNode;
}) {
  const toneClass =
    tone === "critical"
      ? "border-danger/30 bg-danger-soft text-danger"
      : tone === "warning"
        ? "border-warning/30 bg-warning-soft text-warning"
        : "border-doc-border bg-surface-2 text-secondary";

  return (
    <div className={`rounded-doc border px-4 py-3 text-sm ${toneClass}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-1" : undefined}>{children}</div>
    </div>
  );
}

/** Zoznam príloh / pripojených súborov — tri rôzne varianty zjednotené. */
export function DocumentAttachmentList({
  items,
  emptyLabel,
}: {
  items: Array<{ id: string; label: ReactNode; meta?: ReactNode; actions?: ReactNode }>;
  emptyLabel?: ReactNode;
}) {
  if (items.length === 0) {
    return emptyLabel ? <p className="text-sm text-muted-esblu">{emptyLabel}</p> : null;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2.5"
        >
          <div className="min-w-0">
            <p className="truncate text-sm text-primary">{item.label}</p>
            {item.meta && <p className="text-xs text-muted-esblu">{item.meta}</p>}
          </div>
          {item.actions && <div className="flex shrink-0 gap-2">{item.actions}</div>}
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// Zdieľané triedy tlačidiel a polí — aby sa reťazce neopisovali po súboroch.
// -----------------------------------------------------------------------------

export const docButtonPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-doc-sm bg-accent-esblu px-4 py-2 text-sm font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const docButtonSecondary =
  "inline-flex min-h-11 items-center justify-center rounded-doc-sm border border-doc-border px-4 py-2 text-sm font-medium text-secondary transition hover:bg-surface-hover hover:text-primary disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const docButtonDanger =
  "inline-flex min-h-11 items-center justify-center rounded-doc-sm border border-danger/30 px-4 py-2 text-sm font-medium text-danger transition hover:bg-danger-soft disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const docField =
  "w-full rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2.5 text-sm text-primary outline-none transition focus:border-accent-cyan focus:ring-2 focus:ring-accent-cyan/20";

export const docLabel = "mb-1.5 block text-xs font-medium text-secondary";
