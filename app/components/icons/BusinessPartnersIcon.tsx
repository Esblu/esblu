// Zdieľaná ikona pre modul "Obchodní partneri" (Fáza 1B) — používa sa v
// Dashboard.tsx (module card dlaždica + sidebar/mobilné menu) aj v
// app/obchodni-partneri/page.tsx (vlastný header stránky), rovnaký princíp
// ako InboxDocumentIcon.tsx (stroke-based, currentColor, žiadny nový binárny
// PNG asset).
export default function BusinessPartnersIcon({
  size = 22,
  className,
}: {
  size?: number;
  /** Ak je zadané, Tailwind h-/w- trieda prebije width/height atribúty nižšie. */
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20v-1a5.5 5.5 0 0 1 11 0v1" />
      <path d="M16.5 5.5a3 3 0 0 1 0 5.8" />
      <path d="M20.5 20v-1a5 5 0 0 0 -3.2-4.67" />
    </svg>
  );
}
