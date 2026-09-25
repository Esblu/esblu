"use client";

import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";

// =============================================================================
// Push notifikácie v prehliadači / PWA — iba na výslovný pokyn používateľa.
//
// Povolenie sa NIKDY nežiada pri načítaní stránky: iba po ťuknutí na
// „Zapnúť upozornenia" v Nastaveniach. Bez VAPID kľúča (nenastavené) alebo
// bez podpory prehliadača sa funkcia neponúkne.
// =============================================================================

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export type PushSupport = "supported" | "unsupported" | "not_configured" | "ios_needs_install";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!VAPID_PUBLIC_KEY) return "not_configured";
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (hasApis) return "supported";
  // iPhone/iPad: Web Push iba z appky pridanej na plochu (iOS 16.4+).
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  return ios ? "ios_needs_install" : "unsupported";
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : null;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Je toto zariadenie prihlásené na odber? */
export async function isThisDeviceSubscribed(): Promise<boolean> {
  if (pushSupport() !== "supported") return false;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return Boolean(await reg?.pushManager.getSubscription());
}

/** Zapne push pre toto zariadenie (vyžiada povolenie — iba z kliknutia). */
export async function enablePushOnThisDevice(): Promise<"enabled" | "denied" | "failed"> {
  if (pushSupport() !== "supported") return "failed";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  try {
    const reg = await registration();
    const subscribe = () =>
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource });
    let subscription = (await reg.pushManager.getSubscription()) ?? (await subscribe());
    const headers = await authHeaders();
    if (!headers) return "failed";
    const register = () => fetch(apiUrl("/api/push/subscribe"), { method: "POST", headers, body: JSON.stringify(subscription.toJSON()) });
    let response = await register();
    // 409: toto zariadenie je ešte zaregistrované pod iným (neodhláseným)
    // používateľom. Jeho endpoint sa neprevezme — vytvorí sa NOVÝ odber.
    if (response.status === 409) {
      await subscription.unsubscribe().catch(() => undefined);
      subscription = await subscribe();
      response = await register();
    }
    return response.ok ? "enabled" : "failed";
  } catch {
    return "failed";
  }
}

/** Vypne push pre toto zariadenie (aj pri odhlásení). Nikdy nevyhodí chybu. */
export async function disablePushOnThisDevice(): Promise<void> {
  try {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    const subscription = await reg?.pushManager.getSubscription();
    if (!subscription) return;
    const headers = await authHeaders();
    if (headers) {
      await fetch(apiUrl("/api/push/subscribe"), { method: "DELETE", headers, body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => undefined);
    }
    await subscription.unsubscribe();
  } catch {
    // Odhlásenie nesmie zlyhať kvôli push.
  }
}

/** Po odoslaní správy: server overí autora a pošle upozornenie príjemcom. */
export async function notifyChatMessage(messageId: string): Promise<void> {
  try {
    const headers = await authHeaders();
    if (!headers) return;
    await fetch(apiUrl("/api/push/chat-message"), { method: "POST", headers, body: JSON.stringify({ messageId }), keepalive: true });
  } catch {
    // Upozornenie je doplnok — správa je odoslaná aj bez neho.
  }
}
