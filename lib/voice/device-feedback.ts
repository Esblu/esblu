"use client";

import { IS_MOBILE_BUILD } from "@/lib/build-target";

// =============================================================================
// Haptická odozva a „Otvoriť nastavenia" pre hlasový režim (2026-10-11).
//
// Bezpečné na webe aj v appke: všetko je best-effort a nikdy nevyhodí chybu.
//   - natívna appka (Android): EsbluAppConfig.haptic — bez povolenia VIBRATE
//   - web (Android Chrome): navigator.vibrate, ak existuje
//   - iOS Safari / WKWebView: bez haptiky (API neexistuje)
// Rešpektuje prefers-reduced-motion.
// =============================================================================

export type HapticKind = "start" | "stop" | "error";

const WEB_PATTERN: Record<HapticKind, number | number[]> = {
  start: 12,
  stop: [8, 40, 8],
  error: [30, 60, 30],
};

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

export function haptic(kind: HapticKind): void {
  if (typeof window === "undefined" || reducedMotion()) return;
  if (IS_MOBILE_BUILD) {
    void import("@/lib/voice/native-device").then((m) => m.nativeHaptic(kind)).catch(() => undefined);
    return;
  }
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(WEB_PATTERN[kind]);
  } catch {
    // ignorované
  }
}

/** Dá sa v tomto prostredí otvoriť systémové nastavenie povolení appky? */
export async function canOpenMicSettings(): Promise<boolean> {
  if (!IS_MOBILE_BUILD) return false;
  try {
    return (await import("@/lib/voice/native-device")).canOpenNativeSettings();
  } catch {
    return false;
  }
}

export async function openMicSettings(): Promise<boolean> {
  if (!IS_MOBILE_BUILD) return false;
  try {
    return await (await import("@/lib/voice/native-device")).openNativeAppSettings();
  } catch {
    return false;
  }
}
