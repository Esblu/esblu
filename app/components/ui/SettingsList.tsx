"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { ChevronRightIcon } from "@/app/components/icons/AppIcons";

// =============================================================================
// Zoskupený zoznam nastavení (UI refresh 2026-10-11).
//
// Vzor zo systémových nastavení iOS/Android: malý nadpis skupiny nad kartou,
// v karte riadky oddelené tenkou čiarou, dlhé formuláre schované za
// rozbaľovacím riadkom. Triedy `.ui-*` sú v app/globals.css — tu je iba
// sémantika (nadpis skupiny = <h2>, rozbaľovanie = natívne <details>).
// =============================================================================

export function SettingsSection({
  title,
  footer,
  children,
  id,
}: {
  title: ReactNode;
  /** Sekundárny vysvetľujúci text pod skupinou (nie v nej). */
  footer?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const generated = useId();
  const headingId = id ?? `settings-${generated}`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="ui-group-label">
        {title}
      </h2>
      <div className="ui-group">{children}</div>
      {footer && <div className="ui-help mt-1.5 px-1">{footer}</div>}
    </section>
  );
}

type RowBase = {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Červený text — deštruktívna akcia. */
  danger?: boolean;
};

function RowBody({ title, subtitle, leading, trailing, danger, chevron }: RowBase & { chevron?: boolean }) {
  return (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className={`ui-row-title block break-words ${danger ? "!text-danger" : ""}`}>{title}</span>
        {subtitle && <span className="ui-row-sub mt-0.5 block break-words">{subtitle}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2">{trailing}</span>}
      {chevron && <ChevronRightIcon size={16} className="ui-chevron" aria-hidden="true" />}
    </>
  );
}

/** Statický riadok (hodnota, prepínač, tlačidlá vpravo). */
export function SettingsRow(props: RowBase & { className?: string }) {
  return (
    <div className={`ui-row ${props.className ?? ""}`}>
      <RowBody {...props} />
    </div>
  );
}

/** Riadok-odkaz (interná stránka alebo mailto:/externý). */
export function SettingsLinkRow({ href, external, ...props }: RowBase & { href: string; external?: boolean }) {
  if (external || href.startsWith("mailto:") || href.startsWith("http")) {
    return (
      <a href={href} className="ui-row" {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>
        <RowBody {...props} chevron />
      </a>
    );
  }
  return (
    <Link href={href} className="ui-row">
      <RowBody {...props} chevron />
    </Link>
  );
}

/**
 * Rozbaľovací riadok s formulárom (heslo, firemné údaje, pozvánka).
 * Kontrolovaný stav (`open`/`onOpenChange`) — formulár s chybou sa musí dať
 * otvoriť programovo.
 */
export function SettingsDisclosure({
  title,
  subtitle,
  open,
  onOpenChange,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        if (next !== open) onOpenChange(next);
      }}
    >
      <summary className="ui-row">
        <span className="min-w-0 flex-1">
          <span className="ui-row-title block">{title}</span>
          {subtitle && <span className="ui-row-sub mt-0.5 block">{subtitle}</span>}
        </span>
        <ChevronRightIcon size={16} className="ui-chevron" aria-hidden="true" />
      </summary>
      <div className="ui-group-body border-t border-divider">{children}</div>
    </details>
  );
}

/** Pole formulára: štítok, vstup, chyba/pomoc. Prepojené cez aria. */
export function FormField({
  label,
  error,
  hint,
  className = "",
  children,
}: {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  className?: string;
  /** Render-prop dostane id a aria atribúty pre <input>. */
  children: (field: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="ui-label">
        {label}
      </label>
      {children({ id, ...(error ? { "aria-invalid": true as const } : {}), ...(describedBy ? { "aria-describedby": describedBy } : {}) })}
      {error ? (
        <p id={`${id}-error`} className="ui-error-text mt-1">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="ui-help mt-1">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Inline stavová správa sekcie namiesto window.alert(). */
export function InlineNotice({ notice }: { notice: { tone: "success" | "error"; text: string } | null }) {
  if (!notice) return null;
  return (
    <p className="ui-notice mt-2" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
      {notice.text}
    </p>
  );
}
