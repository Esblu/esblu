"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { resolveAppHref } from "@/lib/app-routes";
import { startNativePushBridge } from "@/lib/push/native";

// -----------------------------------------------------------------------------
// Kliknutie na natívnu push notifikáciu (Android/iOS) — iba mobilný build.
//
// Plugin doručí `pushNotificationActionPerformed` aj pri studenom štarte
// (udalosť je zadržaná, kým sa listener nezaregistruje). Cieľ sa skladá
// VÝHRADNE z allowlistu obrazoviek (lib/push/deep-link.ts: screen + UUID)
// a prekladá cez resolveAppHref na statickú mobilnú routu; čokoľvek iné
// (URL, link, neznáma obrazovka) → domov. Prihlásenie vyžiada appka ako vždy.
// -----------------------------------------------------------------------------
export default function PushBridge() {
  const router = useRouter();
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startNativePushBridge((href) => {
      router.push(resolveAppHref(href, true) ?? "/");
    }).then((dispose) => {
      if (cancelled) dispose();
      else stop = dispose;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [router]);
  return null;
}
