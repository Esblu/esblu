"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import { SUPPORTED_LOCALES, LOCALE_SHORT_LABELS, LOCALE_LABELS } from "@/lib/i18n/locales";

// Jazykový prepínač (SK/DE/EN) — jedna zdieľaná implementácia použitá na
// všetkých miestach, kde ho zadanie vyžaduje (landing, login/registrácia,
// invite flow, právny gate, aj vo vnútri appky). Žiadna zmena URL/routingu
// — iba LocaleProvider.setLocale() (cookie + best-effort settings.locale).
//
// UI refresh 2026-10-11: kompaktný segmented control (.ui-segmented z
// app/globals.css) v brand farbe; `variant` ostáva kvôli spätnej
// kompatibilite volaní (oba varianty dnes vyzerajú rovnako — appka aj web
// sú tmavé).
export default function LanguageSwitcher({
  variant = "light",
  className = "",
}: {
  variant?: "light" | "dark";
  className?: string;
}) {
  const { locale, setLocale } = useLocale();
  void variant;

  return (
    <div role="group" aria-label={LOCALE_LABELS[locale]} className={`ui-segmented ${className}`}>
      {SUPPORTED_LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLocale(code)}
          aria-pressed={locale === code}
          aria-label={LOCALE_LABELS[code]}
        >
          {LOCALE_SHORT_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
