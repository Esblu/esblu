import Link from "next/link";

// UI refresh 2026-10-11: kompaktný „späť" odkaz (ako v natívnych appkách) —
// predtým veľká pilulka s tieňom (44 px, tučné písmo), ktorá vizuálne
// súperila s nadpisom stránky. Dotyková plocha ostáva ≥ 40 px (padding).
export default function BackLink({
  href,
  label,
  className = "",
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={className} style={{ paddingTop: "var(--esblu-safe-top, env(safe-area-inset-top, 0px))" }}>
      <Link
        href={href}
        className="-ml-2 inline-flex min-h-10 items-center gap-1 rounded-doc-sm px-2 text-[13px] font-medium text-secondary transition hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring active:opacity-70"
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {label}
      </Link>
    </div>
  );
}
