import Link from "next/link";

export default function Sidebar() {
  return (
    <aside className="w-60 border-r border-subtle bg-surface-1 p-4 text-primary">
      <h1 className="text-lg font-semibold tracking-tight text-brand-300">Esblu</h1>

      <p className="mt-0.5 text-xs text-muted-esblu">
        Firemný majetok pod kontrolou
      </p>

      <nav className="mt-6 space-y-0.5">
        <Link href="/" className="flex min-h-9 items-center rounded-doc-sm px-3 py-1.5 text-sm text-secondary hover:bg-surface-hover hover:text-primary">
          📊 Dashboard
        </Link>

        <Link
          href="/vozidla"
          className="flex min-h-9 items-center rounded-doc-sm px-3 py-1.5 text-sm text-secondary hover:bg-surface-hover hover:text-primary"
        >
          🚗 Vozidlá
        </Link>

        <Link
          href="/stroje"
          className="flex min-h-9 items-center rounded-doc-sm px-3 py-1.5 text-sm text-secondary hover:bg-surface-hover hover:text-primary"
        >
          🚜 Stroje
        </Link>

        <div className="flex min-h-9 items-center rounded-doc-sm px-3 py-1.5 text-sm text-muted-esblu">📦 Sklad</div>
        <div className="flex min-h-9 items-center rounded-doc-sm px-3 py-1.5 text-sm text-muted-esblu">🔧 Servisy</div>
        <div className="flex min-h-9 items-center rounded-doc-sm px-3 py-1.5 text-sm text-muted-esblu">📅 STK / EK</div>
      </nav>
    </aside>
  );
}