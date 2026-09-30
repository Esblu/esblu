// =============================================================================
// Push — abstrakcia nezávislá od poskytovateľa.
//
// Server pozná iba PushMessage (titulok, text, tag, cieľ z allowlistu) a
// DeliveryTarget (jedno zariadenie). Konkrétny poskytovateľ (Web Push,
// Firebase Cloud Messaging, Apple Push Notification service) ich preloží
// do svojho formátu. Výsledok je vždy jeden z:
//   sent     doručené poskytovateľovi,
//   invalid  token/endpoint je neplatný alebo zaniknutý → zariadenie zrušiť,
//   retry    dočasná chyba (429/5xx/sieť) → nič nemeniť,
//   error    chyba konfigurácie/požiadavky → nič nemeniť, zalogovať.
// Tajomstvá (VAPID, FCM service account, APNs .p8) sa čítajú IBA na serveri
// z env premenných; bez nich poskytovateľ nie je nakonfigurovaný.
// =============================================================================

import type { PushMessage } from "@/lib/push/routing";

export type ProviderKind = "webpush" | "fcm" | "apns";

export type DeliveryTarget =
  | { kind: "webpush"; id: string; userId: string; locale: string; endpoint: string; p256dh: string; auth: string }
  | { kind: "fcm" | "apns"; id: string; userId: string; locale: string; platform: "android" | "ios"; token: string };

export type SendOutcome = "sent" | "invalid" | "retry" | "error";

export interface PushProvider {
  readonly kind: ProviderKind;
  send(target: DeliveryTarget, message: PushMessage): Promise<SendOutcome>;
}

export type PushProviders = Partial<Record<ProviderKind, PushProvider>>;
