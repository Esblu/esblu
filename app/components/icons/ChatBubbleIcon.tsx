// Zdieľaná ikona rečovej bubliny pre Firemný chat — pôvodne lokálna
// funkcia vnútri FloatingChatWidget.tsx (trigger tlačidlo appky), teraz
// extrahovaná sem, aby ju mohol reuse-núť aj PublicLandingPage.tsx
// (ÚPRAVA VEREJNÉHO WEBU: sekcia Firemný chat) bez vytvorenia druhej,
// vizuálne odlišnej ikony. Rovnaký prop pattern ako
// app/components/icons/InboxDocumentIcon.tsx (size/className, default
// hodnoty zodpovedajú pôvodnému natvrdo zapísanému `width="24" height="24"`
// vo FloatingChatWidget.tsx, takže appka vyzerá presne rovnako ako predtým).
export default function ChatBubbleIcon({
  size = 24,
  className,
}: {
  size?: number;
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
      aria-hidden="true"
    >
      <path d="M4 4h16v11H8l-4 4V4z" />
    </svg>
  );
}
