"use client";

import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";

export type ModuleAccent = "cyan" | "blue" | "orange" | "teal";

const ACCENT_STYLES: Record<
  ModuleAccent,
  { icon: string; iconGlow: string; ring: string; bar: string; stat: string }
> = {
  cyan: {
    icon: "bg-accent-cyan/14 text-accent-cyan",
    iconGlow: "icon-glow-cyan",
    ring: "group-hover:shadow-[0_0_0_1px_rgba(34,211,238,0.3)]",
    bar: "bg-gradient-to-r from-accent-cyan to-transparent",
    stat: "text-accent-cyan",
  },
  blue: {
    icon: "bg-accent-blue/14 text-accent-blue",
    iconGlow: "icon-glow-blue",
    ring: "group-hover:shadow-[0_0_0_1px_rgba(59,130,246,0.3)]",
    bar: "bg-gradient-to-r from-accent-blue to-transparent",
    stat: "text-accent-blue",
  },
  orange: {
    icon: "bg-accent-orange/14 text-accent-orange",
    iconGlow: "icon-glow-orange",
    ring: "group-hover:shadow-[0_0_0_1px_rgba(245,158,11,0.3)]",
    bar: "bg-gradient-to-r from-accent-orange to-transparent",
    stat: "text-accent-orange",
  },
  teal: {
    icon: "bg-accent-teal/14 text-accent-teal",
    iconGlow: "icon-glow-teal",
    ring: "group-hover:shadow-[0_0_0_1px_rgba(45,212,191,0.3)]",
    bar: "bg-gradient-to-r from-accent-teal to-transparent",
    stat: "text-accent-teal",
  },
};

/**
 * ModuleCard — zdieľaná dlaždica pre hlavné moduly appky (Dashboard grid).
 * Čisto vizuálna vrstva (redesign): nemení href/routy/logiku, iba
 * prezentáciu. Accent farba je iba vizuálne rozlíšenie modulu (cyan/blue/
 * orange/teal), nemá vplyv na dáta.
 *
 * KOREKCIA v3 (podľa spätnej väzby, že 4 karty vyzerali "skoro identicky
 * modré"): glow je teraz VÝHRADNE lokálny za ikonovým chipom (.icon-glow-*),
 * nie na celej karte — karta samotná zostáva tmavá/neutrálna a farebný
 * charakter modulu nesie ikona + veľké farebné číslo. Hierarchia
 * title > číslo/stav > sekundárny text je zvýraznená: menší/tlmenejší
 * label, väčšie a tučnejšie číslo, drobný muted subtitle.
 *
 * KOREKCIA v4 (čisto vizuálna, podľa mobilného screenshotu): ikona bola
 * malá a naľavo hore, s veľkým voľným priestorom napravo. Layout je teraz
 * horná "hlavička" (krátky title + VÝRAZNE väčšia ikona zarovnaná vpravo)
 * a pod ňou zvyšný obsah (veľké číslo/subtitle, resp. subtitle + CTA) na
 * celú šírku karty. Vďaka tomu je ikona nápadne väčšia bez toho, aby
 * zovierala číslo/subtitle do úzkeho stĺpca na malých mobilných šírkach
 * (2-column grid) — číslo aj popis zostávajú čitateľné naľavo cez celú
 * šírku karty, presne ako v pôvodnom layoute, iba pod hlavičkou namiesto
 * pod ikonou. Href/props/dáta nezmenené.
 *
 * KOREKCIA v5 (zväčšenie ikon Vozidlá/Stroje/Sklad, aby vizuálne
 * zodpovedali novej Inbox ikone): raster produktové fotky (van/excavator/
 * warehouse .png) majú v samotnom súbore výrazný priehľadný okraj okolo
 * objektu (zmeraných ~44-72 % šírky rámu podľa assetu), zatiaľ čo nová
 * InboxDocumentIcon SVG kreslí takmer na celú plochu svojho viewBoxu
 * (~85 %). Pri rovnakom CSS rozmere boxu preto rastrové ikony vizuálne
 * pôsobia menšie, hoci box má identické px rozmery. `imageZoom` (voliteľný,
 * default 1 = beze zmeny) škáluje IBA vykreslený <Image> transformom
 * (CSS scale, stred zachovaný — centrovanie nedotknuté), zvyšok presahu je
 * orezaný pomocou `overflow-hidden` na chipe. `overflow-hidden` nemá vplyv
 * na `.icon-glow-*` (box-shadow sa kreslí mimo clip regiónu vlastného
 * obsahu elementu), takže glow/pozadie chipu zostáva nezmenené. Hodnoty
 * imageZoom sú kalibrované per-asset podľa zmeraného bezpečného orezu
 * (pozri Dashboard.tsx modules[]), Inbox (icon prop) a Nastavenia
 * (bez imageZoom) nie sú touto zmenou dotknuté.
 */
export default function ModuleCard({
  href,
  title,
  subtitle,
  stat,
  image,
  imageZoom = 1,
  icon,
  accent = "blue",
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
  const { t } = useLocale();
  const styles = ACCENT_STYLES[accent];

  return (
    <Link
      href={href}
      className={`surface-card surface-card-hover group relative flex min-w-0 flex-col overflow-hidden p-3 transition sm:p-3.5 ${styles.ring} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-[2px] ${styles.bar} opacity-80`}
      />

      <div className="flex items-center justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          {stat ? (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-esblu">
              {title}
            </p>
          ) : (
            <h3 className="text-sm font-semibold text-primary sm:text-[15px]">
              {title}
            </h3>
          )}
        </div>

        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl sm:h-12 sm:w-12 ${styles.icon} ${styles.iconGlow}`}
        >
          {icon ??
            (image ? (
              <Image
                src={image}
                width={40}
                height={40}
                alt=""
                aria-hidden="true"
                className="h-8 w-8 object-contain sm:h-9 sm:w-9"
                style={imageZoom !== 1 ? { transform: `scale(${imageZoom})` } : undefined}
              />
            ) : null)}
        </div>
      </div>

      {stat ? (
        <>
          <p className={`mt-2 text-2xl font-bold leading-none tracking-tight tabular-nums sm:text-[1.75rem] ${styles.stat}`}>
            {stat}
          </p>
          <p className="mt-1 text-xs leading-snug text-muted-esblu">{subtitle}</p>
        </>
      ) : (
        <>
          <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-esblu">{subtitle}</p>
          <span className="mt-1.5 hidden items-center gap-1 text-xs font-semibold text-brand-300 opacity-0 transition group-hover:opacity-100 sm:inline-flex">
            {t("inbox.open")}
            <span aria-hidden="true">→</span>
          </span>
        </>
      )}
    </Link>
  );
}
