// Zdieľaná ikona pre modul Inbox ("AI Evidencia") — používa sa v
// Dashboard.tsx (module card dlaždica + sidebar/mobilné menu) aj v
// app/ai-evidencia/page.tsx (vlastný header stránky), aby všetky tri
// miesta ukazovali rovnakú, konzistentnú vizuálnu identitu.
//
// Nahrádza pôvodný /images/ai-evidencia.png, ktorý bol v skutočnosti celý
// mini "app-icon" mockup (biely rámik, glow, vypálený text "AI EVIDENCIA"
// a vypálené tlačidlo šípky) — v malej ikonovej dlaždici (44-64px) to
// pôsobilo rozmazane/neprofesionálne a nekonzistentne oproti ostatným
// modulom (van.png/excavator.png/... sú čisté product-cutout fotky bez
// vypáleného textu). Táto ikona ide cestou existujúceho SVG/ikon systému
// appky (rovnaký stroke-based vzor ako IconBase v Dashboard.tsx) —
// dokument (doklady/dokumenty) + malá "sparkle" značka (AI), škáluje
// ostro na akejkoľvek veľkosti a farbu preberá cez currentColor.
export default function InboxDocumentIcon({
  size = 22,
  className,
}: {
  size?: number;
  /** Ak je zadané, Tailwind h-/w- trieda (napr. responzívna h-11 w-11
   * sm:h-14 sm:w-14) prebije width/height atribúty nižšie. */
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 2H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7l-5-5z" />
      <path d="M12 2v5h5" />
      <path d="M7 11.5h5" />
      <path d="M7 14.5h5" />
      <path d="M7 17.5h3" />
      <g transform="translate(14,12) scale(0.38)" stroke="none" fill="currentColor">
        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      </g>
    </svg>
  );
}
