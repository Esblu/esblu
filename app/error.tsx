"use client";

// =============================================================================
// Route error boundary (RC 2026-10-12). Bez neho nezachytená chyba renderu
// v statickom mobile exporte = prázdny WebView bez cesty späť.
// Zámerne NEZOBRAZUJE error.message (môže obsahovať dáta) — iba digest,
// ktorý Next.js generuje bez PII.
// =============================================================================

import { useEffect } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useLocale();

  useEffect(() => {
    // Iba typ chyby + digest; žiadna správa ani stack s dátami používateľa.
    console.error("[route-error]", error?.name ?? "Error", error?.digest ?? "");
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div className="max-w-sm space-y-4" role="alert">
        <h1 className="text-base font-semibold text-primary">{t("common.misc.renderErrorTitle")}</h1>
        <p className="text-sm text-muted-esblu">{t("common.misc.renderErrorBody")}</p>
        {error?.digest && <p className="font-mono text-xs text-muted-esblu">{error.digest}</p>}
        <div className="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="min-h-11 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            {t("common.misc.startupRetry")}
          </button>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-lg border border-subtle px-4 py-2 text-sm font-semibold text-primary">
            {t("common.misc.renderErrorHome")}
          </Link>
        </div>
      </div>
    </main>
  );
}
