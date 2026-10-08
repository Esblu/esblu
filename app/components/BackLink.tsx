import Link from "next/link";

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
        className="surface-card-hover inline-flex min-h-[44px] items-center gap-2 rounded-full border border-subtle bg-surface-1/90 px-4 py-2.5 text-sm font-bold text-primary shadow-lg backdrop-blur-sm transition active:scale-95"
      >
        <span aria-hidden="true" className="text-base leading-none text-secondary">
          ←
        </span>
        {label}
      </Link>
    </div>
  );
}
