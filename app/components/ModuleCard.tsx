"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Zachované kvôli spätnej kompatibilite volaní. UI polish pass 2
 * (2026-10-11): moduly už NEMAJÚ vlastnú dominantnú farbu — dashboard má
 * pôsobiť ako jeden produkt. Všetky moduly používajú brand modrú; farba
 * nesie význam iba pri stavoch (upozornenia STK/EK, chyby).
 */
export type ModuleAccent = "cyan" | "blue" | "orange" | "teal";

/**
 * ModuleCard — kompaktná dlaždica modulu na nástenke.
 *
 * Rozloženie (≈ 80 px na výšku namiesto ≈ 150 px):
 *   [ikona 32 px]  Názov modulu ............ počet
 *   jednoriadkový popis (sekundárny)
 *
 * - jedna sada line ikon (app/components/icons), jeden kontajner, jedna
 *   farba (brand) — žiadne fotorealistické obrázky ani emoji,
 * - názov v sentence case (žiadne VEĽKÉ PÍSMENÁ pre časť modulov),
 * - celá dlaždica je jeden odkaz (dotyková plocha = celá karta).
 *
 * `image`, `imageZoom` a `accent` sa ignorujú (staré volania nespadnú).
 */
export default function ModuleCard({
  href,
  title,
  subtitle,
  stat,
  icon,
  className = "",
}: {
  href: string;
  title: string;
  subtitle: string;
  stat?: string;
  image?: string;
  imageZoom?: number;
  icon?: ReactNode;
  accent?: ModuleAccent;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`group flex min-w-0 flex-col gap-1.5 rounded-doc border border-subtle bg-surface-1 px-3 py-2.5 transition hover:border-border-strong hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring active:bg-surface-hover ${className}`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/12 text-brand-300"
        >
          {icon}
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold leading-5 text-primary">{title}</span>
        {stat !== undefined && (
          <span className="shrink-0 text-base font-semibold tabular-nums text-primary">{stat}</span>
        )}
      </span>
      <span className="line-clamp-1 text-xs leading-snug text-muted-esblu">{subtitle}</span>
    </Link>
  );
}
