// Zdieľaná ikona modulu „Nastavenia" — rovnaký princíp ako InvoicesIcon /
// BusinessPartnersIcon / InboxDocumentIcon: stroke-based SVG, currentColor,
// žiadny rastrový asset ani externý obrázok.
//
// Nahrádza /images/settings.png na nástenke. Motív je „konfigurácia firmy":
// tri posuvníky (nastavenia a oprávnenia) a ozubené koliesko (správa
// systému). Ostro škáluje v dlaždici aj v navigácii a preberá farbu akcentu
// modulu, takže sedí vedľa ostatných ikon v tmavej téme.
export default function SettingsIcon({
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
      aria-hidden="true"
    >
      {/* posuvníky */}
      <path d="M3 5.5h5" />
      <path d="M12 5.5h9" />
      <circle cx="10" cy="5.5" r="2" />
      <path d="M3 12h2" />
      <path d="M9 12h3.5" />
      <circle cx="7" cy="12" r="2" />
      <path d="M3 18.5h7" />
      {/* ozubené koliesko */}
      <circle cx="17.5" cy="16" r="2" />
      <path d="M17.5 11.2v1.6" />
      <path d="M17.5 19.2v1.6" />
      <path d="M12.7 16h1.6" />
      <path d="M20.7 16h1.6" />
      <path d="m14.1 12.6 1.1 1.1" />
      <path d="m19.8 18.3 1.1 1.1" />
      <path d="m14.1 19.4 1.1-1.1" />
      <path d="m19.8 13.7 1.1-1.1" />
    </svg>
  );
}
