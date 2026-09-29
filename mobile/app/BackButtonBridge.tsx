"use client";

import { useEffect } from "react";
import { App } from "@capacitor/app";
import { closeTopLayer } from "@/lib/back-stack";

// -----------------------------------------------------------------------------
// Android systémové „späť" (Mobile M1, 2026-09-28) — iba mobilný build.
//
// Poradie: 1) zavrieť otvorenú vrstvu (panel „Viac", potvrdzovací dialóg),
// 2) krok späť v histórii WebView, 3) na koreni appku minimalizovať (nie
// zabiť — návrat do nej je okamžitý a zachová session).
// Registrácia listenera vypína predvolené správanie Capacitoru, preto sú
// kroky 2 a 3 implementované tu explicitne (rovnaké ako predvolené).
// -----------------------------------------------------------------------------
export default function BackButtonBridge() {
  useEffect(() => {
    const handle = App.addListener("backButton", ({ canGoBack }) => {
      if (closeTopLayer()) return;
      if (canGoBack) {
        window.history.back();
        return;
      }
      void App.minimizeApp();
    });
    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, []);

  return null;
}
