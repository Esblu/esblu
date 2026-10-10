"use client";

import { Capacitor, registerPlugin } from "@capacitor/core";

// =============================================================================
// Natívne doplnky hlasového režimu — IBA mobilný build (načítava sa
// dynamicky z lib/voice/device-feedback.ts, web ho nikdy neimportuje).
//
// Android: EsbluAppConfig plugin (mobile/android/.../EsbluAppConfigPlugin.java)
//   - haptic(kind)       View.performHapticFeedback — bez VIBRATE povolenia
//   - openAppSettings()  systémové nastavenia appky (povolenie mikrofónu)
// iOS: „app-settings:" (UIApplication.openSettingsURLString) cez navigáciu
//   WebView — Capacitor externé schémy otvára cez UIApplication.open.
//   Haptika na iOS zatiaľ nie je (vyžaduje natívny plugin v Xcode projekte).
// =============================================================================

type EsbluAppConfigPlugin = {
  haptic(options: { kind: "start" | "stop" | "error" }): Promise<void>;
  openAppSettings(): Promise<void>;
};

function plugin(): EsbluAppConfigPlugin | null {
  try {
    if (Capacitor.getPlatform() !== "android" || !Capacitor.isPluginAvailable("EsbluAppConfig")) return null;
    return registerPlugin<EsbluAppConfigPlugin>("EsbluAppConfig");
  } catch {
    return null;
  }
}

export async function nativeHaptic(kind: "start" | "stop" | "error"): Promise<boolean> {
  const native = plugin();
  if (!native) return false;
  try {
    await native.haptic({ kind });
    return true;
  } catch {
    // Starší natívny build bez metódy → ticho, nič sa nerozbije.
    return false;
  }
}

export function canOpenNativeSettings(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return platform === "ios" || (platform === "android" && Capacitor.isPluginAvailable("EsbluAppConfig"));
  } catch {
    return false;
  }
}

export async function openNativeAppSettings(): Promise<boolean> {
  try {
    const platform = Capacitor.getPlatform();
    if (platform === "ios") {
      window.location.href = "app-settings:";
      return true;
    }
    const native = plugin();
    if (!native) return false;
    await native.openAppSettings();
    return true;
  } catch {
    return false;
  }
}
