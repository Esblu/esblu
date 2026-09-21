"use client";

import type { ReactNode } from "react";

// =============================================================================
// Hero blok "Pridať dokument".
//
// PREČO VLASTNÝ KOMPONENT A NIE OBRÁZOK
// -------------------------------------
// Blok potreboval vizuálne odlíšenie od zvyšku registra — je to jediná
// akcia, ktorou sa do Inboxu čokoľvek dostane. Stocková ilustrácia by
// znamenala ďalších 200 kB, nesprávnu farebnosť v tmavej téme a pri 360 px
// orezaný motív. Vrstvy papierov sa dajú nakresliť troma obdĺžnikmi v SVG,
// ktoré dedia farbu z tokenov a škálujú sa samy.
//
// Motív: tri listy dokumentu za sebou, mierne pootočené, s naznačenými
// riadkami textu a preloženým rohom na vrchnom liste. Žiadne emoji, žiadna
// kresba, žiadna tvár — je to archív, nie ilustrácia do detskej knižky.
//
// DEKORÁCIA JE ARIA-HIDDEN
// ------------------------
// Celý vizuál je `aria-hidden`. Pre čítačku obrazovky je tento blok
// nadpis + popis + dve tlačidlá, presne ako predtým.
// =============================================================================

export function UploadHero({
  title,
  description,
  actions,
  note,
}: {
  title: ReactNode;
  description: ReactNode;
  actions: ReactNode;
  note?: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-doc border border-doc-border bg-doc-surface">
      {/* Jemný cyan nádych z webu Esblu. Radial-gradient namiesto tieňa —
          žiara na tmavom povrchu vyzerá ako svetlo, tieň ako špina. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 140% at 88% 0%, color-mix(in oklab, var(--color-accent-cyan) 16%, transparent) 0%, transparent 60%)",
        }}
      />

      <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
        <PaperStack />

        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-primary">{title}</h2>
          <p className="mt-1 text-sm text-secondary">{description}</p>
          {note && <p className="mt-2 text-xs text-muted-esblu">{note}</p>}
          <div className="mt-4">{actions}</div>
        </div>
      </div>
    </section>
  );
}

/**
 * Vrstvy papierov. Fixný pomer strán a `shrink-0`, aby sa na úzkej
 * obrazovke nedeformovali — na mobile sedia nad textom, na desktope vľavo.
 */
function PaperStack() {
  return (
    <div aria-hidden="true" className="mx-auto shrink-0 sm:mx-0">
      <svg
        width="96"
        height="96"
        viewBox="0 0 96 96"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-20 w-20 sm:h-24 sm:w-24"
      >
        <defs>
          <linearGradient id="esblu-sheet-front" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent-cyan)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-accent-blue)" stopOpacity="0.10" />
          </linearGradient>
        </defs>

        {/* Dva listy vzadu — iba obrys, aby vytvorili hĺbku a nesúťažili
            s predným listom o pozornosť. */}
        <rect
          x="14" y="22" width="52" height="64" rx="5"
          transform="rotate(-9 40 54)"
          fill="var(--color-surface-2)"
          stroke="var(--color-doc-border)"
          strokeWidth="1.5"
        />
        <rect
          x="20" y="18" width="52" height="64" rx="5"
          transform="rotate(-4 46 50)"
          fill="var(--color-surface-2)"
          stroke="var(--color-doc-border)"
          strokeWidth="1.5"
        />

        {/* Predný list s preloženým rohom. */}
        <path
          d="M28 14h28l14 14v50a5 5 0 0 1-5 5H28a5 5 0 0 1-5-5V19a5 5 0 0 1 5-5z"
          fill="url(#esblu-sheet-front)"
          stroke="var(--color-accent-cyan)"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
        <path
          d="M56 14v9a5 5 0 0 0 5 5h9"
          fill="none"
          stroke="var(--color-accent-cyan)"
          strokeOpacity="0.55"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Naznačené riadky textu — posledný kratší, ako skutočný odsek. */}
        <g stroke="var(--color-accent-cyan)" strokeOpacity="0.42" strokeWidth="2.5" strokeLinecap="round">
          <path d="M32 44h30" />
          <path d="M32 53h30" />
          <path d="M32 62h18" />
        </g>
      </svg>
    </div>
  );
}
