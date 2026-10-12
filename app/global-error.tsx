"use client";

// =============================================================================
// Global error boundary (RC 2026-10-12) — nahrádza root layout, takže tu nie
// sú providery (jazyk, téma). Krátky dvojjazyčný text, žiadne error.message.
// =============================================================================

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="sk">
      <body style={{ margin: 0, background: "#020617", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
          <div role="alert" style={{ maxWidth: 360 }}>
            <h1 style={{ fontSize: 16, fontWeight: 600 }}>Esblu: niečo sa pokazilo / Something went wrong</h1>
            {error?.digest && <p style={{ fontFamily: "monospace", fontSize: 12, color: "#94a3b8" }}>{error.digest}</p>}
            <button
              type="button"
              onClick={() => reset()}
              style={{ minHeight: 44, marginTop: 16, padding: "8px 16px", borderRadius: 8, border: 0, background: "#2563eb", color: "#fff", fontWeight: 600 }}
            >
              Skúsiť znova / Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
