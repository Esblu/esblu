"use client";

import { Capacitor } from "@capacitor/core";
import { PushNotifications, type ActionPerformed, type Token } from "@capacitor/push-notifications";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { normalizeLocale, LOCALE_STORAGE_KEY } from "@/lib/i18n/locales";
import { pushHrefFromData } from "@/lib/push/deep-link";

// =============================================================================
// Natívne push notifikácie (Capacitor 8, @capacitor/push-notifications) —
// IBA mobilný build. Web ho nikdy neimportuje staticky (lib/push/client.ts
// ho načíta dynamicky iba v IS_MOBILE_BUILD vetve; mobile/app/PushBridge.tsx
// je iba v mobilnom layoute).
//
//   Android → FCM registration token (vyžaduje google-services.json),
//   iOS     → APNs device token (vyžaduje Push capability v Xcode).
//
// Model: jedna inštalácia appky = jedno náhodné installationId (lokálne
// úložisko) = najviac jeden aktívny token na serveri. Token refresh (FCM
// onNewToken, reinštalácia, nová session po prihlásení) → ten istý POST
// /api/push/devices (idempotentný). Povolenie sa žiada IBA z kliknutia
// v Nastaveniach; pri štarte appky sa token iba obnoví, ak ho používateľ
// predtým zapol a systémové povolenie je udelené.
// =============================================================================

const ENABLED_KEY = "esblu.push.native.enabled";
const INSTALLATION_KEY = "esblu.push.installationId";
export const ANDROID_CHANNEL_ID = "esblu_default";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // úložisko nedostupné — push ostane iba pre túto reláciu
  }
}

export function nativePlatform(): "android" | "ios" | null {
  if (!Capacitor.isNativePlatform()) return null;
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios" ? platform : null;
}

export function installationId(): string {
  const existing = storageGet(INSTALLATION_KEY);
  if (existing && UUID.test(existing)) return existing;
  const created = crypto.randomUUID();
  storageSet(INSTALLATION_KEY, created);
  return created;
}

function currentLocale(): string {
  return normalizeLocale(storageGet(LOCALE_STORAGE_KEY));
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : null;
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

// Zapnutie platí pre KONKRÉTNEHO používateľa na tejto inštalácii — iný
// používateľ, ktorý sa prihlási na tom istom zariadení, ho nezdedí.
async function enabledForCurrentUser(): Promise<boolean> {
  const stored = storageGet(ENABLED_KEY);
  const userId = await currentUserId();
  return Boolean(stored && userId && stored === userId);
}

async function appVersion(): Promise<string | undefined> {
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    return /^[A-Za-z0-9._+-]{1,40}$/.test(info.version) ? info.version : undefined;
  } catch {
    return undefined;
  }
}

/** Pošle token na server. 409 = token patrí inému aktívnemu používateľovi. */
async function sendToken(token: string): Promise<"ok" | "conflict" | "failed"> {
  const platform = nativePlatform();
  const headers = await authHeaders();
  if (!platform || !headers) return "failed";
  try {
    const response = await fetch(apiUrl("/api/push/devices"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: platform === "ios" ? "apns" : "fcm",
        platform,
        token,
        installationId: installationId(),
        locale: currentLocale(),
        appVersion: await appVersion(),
      }),
    });
    if (response.status === 409) return "conflict";
    return response.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

// Jeden spoločný listener na token (obnova aj prvé zapnutie).
let listenersReady: Promise<void> | null = null;
let waiter: ((token: string | null) => void) | null = null;
let navigateHandler: ((href: string) => void) | null = null;

function ensureListeners(): Promise<void> {
  if (listenersReady) return listenersReady;
  listenersReady = (async () => {
    await PushNotifications.addListener("registration", (token: Token) => {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(token.value);
        return;
      }
      // Token refresh na pozadí (FCM onNewToken): iba ak ho TENTO používateľ zapol.
      void enabledForCurrentUser().then((enabled) => {
        if (enabled) void sendToken(token.value);
      });
    });
    await PushNotifications.addListener("registrationError", () => {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(null);
      }
    });
    await PushNotifications.addListener("pushNotificationActionPerformed", (action: ActionPerformed) => {
      // Cieľ IBA z allowlistu (screen + id), nikdy URL z payloadu.
      const href = pushHrefFromData(action?.notification?.data);
      navigateHandler?.(href);
    });
  })();
  return listenersReady;
}

async function requestToken(): Promise<string | null> {
  await ensureListeners();
  const token = new Promise<string | null>((resolve) => {
    waiter = resolve;
    setTimeout(() => {
      if (waiter === resolve) {
        waiter = null;
        resolve(null);
      }
    }, 15_000);
  });
  await PushNotifications.register();
  return token;
}

async function ensureChannel() {
  if (nativePlatform() !== "android") return;
  try {
    await PushNotifications.createChannel({ id: ANDROID_CHANNEL_ID, name: "Esblu", importance: 4, visibility: 0 });
  } catch {
    // kanál existuje / staršie Android
  }
}

export async function nativePushEnabled(): Promise<boolean> {
  if (!nativePlatform() || !(await enabledForCurrentUser())) return false;
  try {
    return (await PushNotifications.checkPermissions()).receive === "granted";
  } catch {
    return false;
  }
}

/** Zapne push (vyžiada povolenie — iba z kliknutia). */
export async function enableNativePush(): Promise<"enabled" | "denied" | "failed"> {
  if (!nativePlatform()) return "failed";
  try {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive !== "granted") permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") return "denied";
    await ensureChannel();
    let token = await requestToken();
    if (!token) return "failed";
    let outcome = await sendToken(token);
    if (outcome === "conflict") {
      // Token drží iný (neodhlásený) používateľ z inej inštalácie → nový token.
      await PushNotifications.unregister().catch(() => undefined);
      token = await requestToken();
      outcome = token ? await sendToken(token) : "failed";
    }
    const userId = await currentUserId();
    if (outcome !== "ok" || !userId) return "failed";
    storageSet(ENABLED_KEY, userId);
    return "enabled";
  } catch {
    return "failed";
  }
}

/** Vypne push na tejto inštalácii (aj pri odhlásení). Nikdy nevyhodí chybu. */
export async function disableNativePush(): Promise<void> {
  const wasEnabled = storageGet(ENABLED_KEY) !== null;
  storageSet(ENABLED_KEY, null);
  if (!nativePlatform()) return;
  try {
    const headers = await authHeaders();
    if (headers) {
      await fetch(apiUrl("/api/push/devices"), { method: "DELETE", headers, body: JSON.stringify({ installationId: installationId() }) }).catch(() => undefined);
    }
    if (wasEnabled) await PushNotifications.unregister();
  } catch {
    // Odhlásenie nesmie zlyhať kvôli push.
  }
}

/**
 * Štart appky / nové prihlásenie: ak bol push zapnutý a povolenie trvá,
 * obnoví token a jeho väzbu na aktuálnu session (bez dialógu).
 */
export async function refreshNativePush(): Promise<void> {
  if (!(await nativePushEnabled())) return;
  try {
    await ensureListeners();
    await ensureChannel();
    await PushNotifications.register(); // → "registration" listener → sendToken
  } catch {
    // ďalší pokus pri ďalšom štarte
  }
}

/** Kliknutie na notifikáciu → navigácia (nastaví PushBridge). */
export async function startNativePushBridge(navigate: (href: string) => void): Promise<() => void> {
  navigateHandler = navigate;
  if (nativePlatform()) await ensureListeners();
  return () => {
    if (navigateHandler === navigate) navigateHandler = null;
  };
}
