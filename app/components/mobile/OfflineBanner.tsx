"use client";

import { useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { connectivityFrom } from "@/lib/mobile/lifecycle";

// -----------------------------------------------------------------------------
// Offline stav (Mobile Platform 2026-10-08). Esblu nie je offline-first:
// banner iba jasne povie, že bez siete sa nič neuloží. Obrazovky naďalej
// ukazujú uloženie IBA po potvrdení servera (žiadne „optimistické" uloženie).
// -----------------------------------------------------------------------------

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export default function OfflineBanner() {
  const { t } = useLocale();
  const state = useSyncExternalStore(
    subscribe,
    () => connectivityFrom(navigator.onLine),
    () => "online" as const,
  );
  if (state === "online") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[100] bg-amber-500 px-4 pb-2 text-center text-sm font-semibold text-black"
      style={{ paddingTop: "calc(var(--esblu-safe-top) + 0.5rem)" }}
    >
      {t("common.offline")}
    </div>
  );
}
