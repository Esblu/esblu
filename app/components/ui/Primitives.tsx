"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  CameraIcon,
  ChevronRightIcon,
  FilterIcon,
  ImageIcon,
  SearchIcon,
  TrashIcon,
} from "@/app/components/icons/AppIcons";

// =============================================================================
// Zdieľané B2B primitívy Esblu.
//
// PREČO TENTO SÚBOR
// -----------------
// Dokumentová vrstva (faktúry, Inbox, partneri) už má svoje primitívy v
// app/components/document/DocumentLayout.tsx a fungujú. Stroje a Sklad
// potrebujú presne ten istý vizuálny jazyk, ale nie sú to dokumenty —
// importovať v module Sklad niečo, čo sa volá "Document…", by bolo
// mätúce a viedlo by k tomu, že si tam niekto časom vyrobí vlastnú verziu.
//
// Preto tento súbor NEDUPLIKUJE nič: dokumentové primitívy iba
// re-exportuje pod neutrálnymi menami a dopĺňa tie, ktoré register
// (zoznam s vyhľadávaním a filtrami) potrebuje navyše.
//
// Jeden zdroj právd pre tokeny, tlačidlá, rádiusy a odstupy zostáva
// DocumentLayout.tsx. Toto je jeho rozšírenie, nie druhý design systém.
// =============================================================================

export {
  DocumentPageShell as PageShell,
  DocumentHeader as PageHeader,
  DocumentSection as SectionPanel,
  DocumentMetadataGrid as MetadataGrid,
  DocumentNotice as Notice,
  DocumentModal as Modal,
  DocumentActionBar as ActionBar,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";

export { DocumentStatusBadge as StatusBadge } from "@/app/components/document/DocumentStatusBadge";

import {
  docButtonSecondary,
  docField,
} from "@/app/components/document/DocumentLayout";

// -----------------------------------------------------------------------------
// Register — hlavička stĺpcov a riadok
// -----------------------------------------------------------------------------

/**
 * Hlavička stĺpcov registra. Na mobile sa zámerne nezobrazuje — tam je
 * riadok čitateľný sám osebe a hlavička by len zabrala výšku.
 *
 * `columns` je raw Tailwind grid-template (napr.
 * "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"), aby si každý register
 * mohol určiť vlastné pomery bez ďalšej abstrakcie.
 */
export function RegisterHeader({
  columns,
  children,
}: {
  columns: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`hidden border-b border-doc-border px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-esblu sm:grid sm:gap-4 ${columns}`}
    >
      {children}
    </div>
  );
}

/**
 * Riadok registra. Celý riadok je klikateľný (§A4 zadania), takže
 * nepotrebuje veľké tlačidlo "Otvoriť detail".
 *
 * Accessibility: keď je `href`, je to skutočný odkaz — funguje Cmd+klik,
 * prostredný klik aj klávesnica. Keď je `onClick`, je to skutočné
 * `<button>`. Nikdy nie `<div onClick>`.
 *
 * `trailing` je oddelený od klikateľnej plochy, pretože akcie vnorené do
 * odkazu sú neprístupné (odkaz vnútri odkazu je neplatné HTML).
 */
export function DataRow({
  href,
  onClick,
  columns,
  children,
  trailing,
  ariaLabel,
}: {
  href?: string;
  onClick?: () => void;
  columns: string;
  children: ReactNode;
  trailing?: ReactNode;
  ariaLabel?: string;
}) {
  // Rám a povrch nesie <li>, nie odkaz — akcie riadku tak môžu bývať v tej
  // istej karte, ale MIMO odkazu (odkaz v odkaze je neplatné HTML a
  // klávesnicou sa nedá ovládať).
  const shared = `relative block w-full px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring sm:grid sm:items-center sm:gap-4 ${
    trailing ? "sm:pr-32" : "sm:pr-9"
  } ${columns}`;

  const body = (
    <>
      {children}
      {/* Šípka je jediný vizuálny náznak "toto sa dá otvoriť" — nahrádza
          celé tlačidlo "Otvoriť detail" (§A4). Keď má riadok vlastné
          akcie vpravo, šípka sa nekreslí, aby s nimi nekolidovala. */}
      {!trailing && (
        <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 text-muted-esblu sm:block">
          <ChevronRightIcon size={16} />
        </span>
      )}
    </>
  );

  return (
    <li className="relative rounded-doc border border-doc-border bg-doc-surface transition hover:border-border-strong hover:bg-doc-surface-hover">
      {href ? (
        <Link href={href} aria-label={ariaLabel} className={shared}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} aria-label={ariaLabel} className={shared}>
          {body}
        </button>
      )}

      {trailing && (
        /* Na mobile pás akcií pod obsahom (absolútne umiestnené tlačidlá
           by na 360 px preliezli cez text), na desktope vpravo v riadku. */
        <div className="flex justify-end gap-1.5 border-t border-doc-border px-3 py-2 sm:absolute sm:right-3 sm:top-1/2 sm:border-t-0 sm:-translate-y-1/2 sm:px-0 sm:py-0">
          {trailing}
        </div>
      )}
    </li>
  );
}

// -----------------------------------------------------------------------------
// Toolbar registra — vyhľadávanie + filtre
// -----------------------------------------------------------------------------

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Prístupný názov poľa. Lupa je dekorácia, nie label. */
  label: string;
}) {
  const id = useId();
  return (
    <div className="relative min-w-0 flex-1">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-esblu">
        <SearchIcon size={16} />
      </span>
      <input
        id={id}
        type="search"
        className={`${docField} pl-9`}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export type FilterOption = { key: string; label: string; count?: number };

/** Rad piluliek jedného filtra. Na desktope inline, na mobile vnútri panelu. */
export function FilterChips({
  options,
  active,
  onSelect,
  label,
}: {
  options: FilterOption[];
  active: string;
  onSelect: (key: string) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={active === option.key}
          onClick={() => onSelect(option.key)}
          className={`whitespace-nowrap rounded-doc-sm border px-3 py-1.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
            active === option.key
              ? "border-border-strong bg-surface-hover text-primary"
              : "border-doc-border text-secondary hover:text-primary"
          }`}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-1.5 tabular-nums opacity-70">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Toolbar registra.
 *
 * Kľúčové rozhodnutie (§A1 zadania): sekundárne filtre sú na mobile
 * SCHOVANÉ za tlačidlo "Filtre" a na desktope inline. Na telefóne bol
 * problém presne toto — dva rady rovnako vyzerajúcich piluliek nad
 * zoznamom, ktoré zabrali polovicu obrazovky.
 *
 * Tlačidlo nesie počet AKTÍVNYCH filtrov, aby používateľ po zavretí panelu
 * vedel, že zoznam je stále filtrovaný. Skrytý filter bez tejto značky je
 * horší než žiadny filter.
 */
export function RegisterToolbar({
  search,
  primary,
  filters,
  activeFilterCount = 0,
  activeSummary,
  filtersLabel,
  filtersCloseLabel,
}: {
  search?: ReactNode;
  /** Primárna os registra — vždy viditeľná, aj na mobile. */
  primary?: ReactNode;
  /** Sekundárne filtre — na mobile za tlačidlom. */
  filters?: ReactNode;
  activeFilterCount?: number;
  /**
   * Text aktívneho výberu na tlačidle (napr. "Vystavené"). Skrytý filter
   * bez tejto informácie je horší než žiadny — používateľ by nevedel,
   * prečo zoznam niečo nezobrazuje.
   */
  activeSummary?: string;
  filtersLabel: string;
  filtersCloseLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="space-y-3 rounded-doc border border-doc-border bg-doc-surface p-3 sm:p-4">
      {(search || (filters && true)) && (
        <div className="flex gap-2">
          {search}
          {filters && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-controls={panelId}
              className={`${docButtonSecondary} shrink-0 gap-2 sm:hidden`}
            >
              <FilterIcon size={16} />
              {open ? filtersCloseLabel : (activeSummary ?? filtersLabel)}
              {!open && activeFilterCount > 0 && (
                <span className="rounded-full bg-accent-esblu px-1.5 text-xs font-semibold text-on-accent tabular-nums">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}
        </div>
      )}

      {primary}

      {filters && (
        <div id={panelId} className={`${open ? "block" : "hidden"} sm:block`}>
          {filters}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Metriky
// -----------------------------------------------------------------------------

/**
 * Jedna kľúčová hodnota. Číslo je dominantné, popis tichý — na detaile
 * stroja a skladovej položky je to hlavná informácia, nie metadáta.
 */
export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "warning" | "critical";
}) {
  const valueTone =
    tone === "critical" ? "text-danger" : tone === "warning" ? "text-warning" : "text-primary";

  return (
    <div className="rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2.5">
      <p className="text-xs font-medium uppercase tracking-wide text-secondary sm:text-[11px] sm:text-muted-esblu">
        {label}
      </p>
      <p className={`mt-1 break-words text-lg font-semibold tabular-nums ${valueTone}`}>{value}</p>
      {hint && <p className="mt-0.5 text-sm text-muted-esblu sm:text-xs">{hint}</p>}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

// -----------------------------------------------------------------------------
// Stavy zoznamu
// -----------------------------------------------------------------------------

/**
 * Prázdny stav. Zámerne malý (§F zadania) — jedna veta a jedna akcia.
 * Veľký marketingový blok v registri, ktorý používateľ uvidí päťkrát denne,
 * je otrava, nie onboarding.
 */
export function EmptyState({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-doc border border-dashed border-doc-border px-6 py-10 text-center">
      <p className="text-sm text-muted-esblu">{title}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Skeleton riadkov registra — tvar výsledku, nie točiace sa koliesko. */
export function LoadingRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-1.5">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="h-16 animate-pulse rounded-doc border border-doc-border bg-doc-surface"
        />
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Časová os (servisná história)
// -----------------------------------------------------------------------------

/**
 * Položka časovej osi. Bod a linka nesú chronológiu, takže záznam nemusí
 * byť karta — desiatky servisov ako desiatky kariet sa nedajú prečítať.
 */
export function TimelineItem({
  marker,
  title,
  meta,
  children,
  actions,
  last,
}: {
  marker?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  last?: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && (
        <span
          aria-hidden="true"
          className="absolute left-[11px] top-7 bottom-0 w-px bg-doc-border"
        />
      )}
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-doc-border bg-surface-2 text-muted-esblu"
      >
        {marker}
      </span>
      <div className="min-w-0 flex-1 rounded-doc border border-doc-border bg-doc-surface px-3 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words text-base font-semibold text-primary sm:text-sm">{title}</p>
            {meta && <div className="mt-0.5 text-sm text-secondary">{meta}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

// -----------------------------------------------------------------------------
// Nahrávanie fotografií
// -----------------------------------------------------------------------------

/**
 * Dvojica "Odfotiť / Galéria".
 *
 * Tento blok bol v appke napísaný SEDEMKRÁT (Inbox, TP sken predná aj zadná
 * strana, fotky vozidla v zozname, galéria vozidla, galéria stroja, sklad) a
 * zakaždým inak: raz modré tlačidlo a biele, raz dve tiché, raz `bg-blue-600`
 * s `text-blue-700`. Jedna implementácia znamená, že "pridať fotku" vyzerá
 * a správa sa všade rovnako.
 *
 * `capture="environment"` je len NÁVRH pre prehliadač — na desktope otvorí
 * bežný výber súboru. Preto sú obe tlačidlá vždy k dispozícii.
 */
export function UploadActions({
  onSelect,
  disabled,
  multiple,
  cameraLabel,
  galleryLabel,
  className = "",
}: {
  onSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  multiple?: boolean;
  cameraLabel: string;
  galleryLabel: string;
  className?: string;
}) {
  const state = disabled ? "pointer-events-none opacity-40" : "cursor-pointer";

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <label className={`${docButtonSecondary} gap-2 ${state}`}>
        <CameraIcon size={16} />
        {cameraLabel}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple={multiple}
          className="sr-only"
          disabled={disabled}
          onChange={onSelect}
        />
      </label>

      <label className={`${docButtonSecondary} gap-2 ${state}`}>
        <ImageIcon size={16} />
        {galleryLabel}
        <input
          type="file"
          accept="image/*"
          multiple={multiple}
          className="sr-only"
          disabled={disabled}
          onChange={onSelect}
        />
      </label>
    </div>
  );
}

export type PhotoTile = { id: string; url: string; alt: string };

/**
 * Mriežka fotografií s JEDNOTNÝM pomerom strán 4:3.
 *
 * Náhodne vysoké dlaždice pôsobia ako nástenka, nie ako evidencia majetku —
 * preto `object-cover` a pevný pomer, nech sú fotky nafotené akokoľvek.
 */
export function PhotoGrid({
  photos,
  onOpen,
  onDelete,
  deleteLabel,
  deletingId,
}: {
  photos: PhotoTile[];
  /** Bez neho je dlaždica statická (napr. keď používateľ nemá čo otvárať). */
  onOpen?: (photo: PhotoTile) => void;
  /** Bez neho sa tlačidlo mazania vôbec nevykreslí — gating rieši volajúci. */
  onDelete?: (photo: PhotoTile) => void;
  deleteLabel?: string;
  deletingId?: string | null;
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {photos.map((photo) => (
        <li key={photo.id} className="relative">
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen(photo)}
              className="block w-full overflow-hidden rounded-doc border border-doc-border transition hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.url} alt={photo.alt} className="aspect-[4/3] w-full object-cover" />
            </button>
          ) : (
            <div className="overflow-hidden rounded-doc border border-doc-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.url} alt={photo.alt} className="aspect-[4/3] w-full object-cover" />
            </div>
          )}

          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(photo)}
              disabled={deletingId === photo.id}
              aria-label={deleteLabel}
              className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-doc-sm border border-danger/30 bg-page-bg/80 text-danger backdrop-blur transition hover:bg-danger-soft disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <TrashIcon size={16} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Evidenčné číslo vozidla.
 *
 * Biela tabuľka s čiernym písmom je zámerná aj v tmavej téme — ŠPZ je
 * fyzický objekt a používateľ ju hľadá presne týmto tvarom. Je to jediné
 * miesto v appke, kde sa vedome nedržíme tmavej palety.
 */
export function PlateBadge({
  plate,
  size = "md",
}: {
  plate: string;
  size?: "sm" | "md";
}) {
  // Mobil: ŠPZ musí byť čitateľná bez priblíženia aj v menšej variante.
  const scale = size === "sm" ? "px-2 py-0.5 text-[15px] sm:text-sm" : "px-3 py-1 text-base";
  return (
    <span
      className={`inline-block rounded-[0.25rem] border border-slate-900 bg-white font-semibold tracking-widest text-slate-900 ${scale}`}
    >
      {plate}
    </span>
  );
}
