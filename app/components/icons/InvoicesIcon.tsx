// Zdieľaná ikona pre modul "Faktúry" (Fáza 2) — rovnaký princíp ako
// BusinessPartnersIcon.tsx (stroke-based, currentColor, žiadny nový binárny
// PNG asset). Použitá v Dashboard.tsx (module card dlaždica + sidebar/
// mobilné menu) aj v app/faktury/page.tsx (vlastný header stránky).
export default function InvoicesIcon({
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
      <path d="M6 2.5h9l3.5 3.5V21a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
      <path d="M15 2.5V6a.5.5 0 0 0 .5.5H19" />
      <path d="M8.5 12h7" />
      <path d="M8.5 15.5h7" />
      <path d="M8.5 8.5h3" />
    </svg>
  );
}
