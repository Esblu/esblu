"use client";

import { useEffect } from "react";
import { App } from "@capacitor/app";
import { supabase } from "@/lib/supabase";
import { navigateHard } from "@/lib/app-navigation";
import { shouldRedirectToLoginAfterSignOut } from "@/lib/mobile/lifecycle";

// -----------------------------------------------------------------------------
// Životný cyklus natívnej appky (Mobile Platform 2026-10-08) — iba mobilný build.
//
// - Na pozadí sa automatický refresh tokenu ZASTAVÍ (WebView časovače sú
//   uspané a bežiaci refresh by mohol zlyhať uprostred), po návrate do
//   popredia sa znova spustí a session sa hneď overí/obnoví (getSession
//   obnoví vypršaný access token cez refresh token).
// - Odvolaná/vypršaná session (refresh zlyhá → SIGNED_OUT) presmeruje
//   z chránenej obrazovky na prihlásenie. Server/RLS je aj tak autorita —
//   toto iba zabráni „prázdnej" obrazovke s chybami.
// -----------------------------------------------------------------------------
export default function AppLifecycleBridge() {
  useEffect(() => {
    void supabase.auth.startAutoRefresh();

    const stateHandle = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        void supabase.auth.startAutoRefresh();
        void supabase.auth.getSession();
      } else {
        void supabase.auth.stopAutoRefresh();
      }
    });

    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (shouldRedirectToLoginAfterSignOut(event, window.location.pathname)) {
        navigateHard("/login");
      }
    });

    return () => {
      void stateHandle.then((listener) => listener.remove());
      data.subscription.unsubscribe();
    };
  }, []);

  return null;
}
