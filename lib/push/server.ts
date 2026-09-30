import type { SupabaseClient } from "@supabase/supabase-js";
import { createWebPushProvider, readVapidKeys } from "@/lib/push/providers/webpush";
import { createFcmProvider, readFcmConfig } from "@/lib/push/providers/fcm";
import { createApnsProvider, readApnsConfig } from "@/lib/push/providers/apns";
import type { DeliveryTarget, PushProviders } from "@/lib/push/providers/types";
import { deliver, type DeliveryInput, type DeliveryResult, type DeliveryStore } from "@/lib/push/dispatch";

// =============================================================================
// Doručenie push notifikácií — iba server (service role), iba jedna firma.
//
// Ciele sa čítajú RPC esblu_push_delivery_targets(firma, používatelia): iba
// nezrušené zariadenia (web push, FCM, APNs) so ŽIVOU auth session a
// AKTÍVNYM členstvom v TEJ ISTEJ firme — notifikácia firmy A nikdy neodíde
// na zariadenie registrované pod firmou B (ani toho istého človeka), ani na
// zariadenie po odhlásení / revokácii session / odobratí z firmy.
// Deduplikácia: notification_deliveries (unique user_id + dedupe_key).
// Neplatný token (404/410, UNREGISTERED, BadDeviceToken) sa zruší.
//
// RETENCIA: notification_deliveries rastie s každým odoslaním (iba kľúče,
// žiadny obsah). Pred dlhodobou produkčnou prevádzkou treba schváliť a zaviesť
// čistenie starých riadkov — tu zámerne nie je žiadne automatické mazanie.
// =============================================================================

export { readVapidKeys };

/** Nakonfigurovaní poskytovatelia (bez env premenných → prázdne). */
export function configuredProviders(env: Record<string, string | undefined> = process.env): PushProviders {
  const providers: PushProviders = {};
  const vapid = readVapidKeys(env);
  if (vapid) providers.webpush = createWebPushProvider(vapid);
  const fcm = readFcmConfig(env);
  if (fcm) providers.fcm = createFcmProvider(fcm);
  const apns = readApnsConfig(env);
  if (apns) providers.apns = createApnsProvider(apns);
  return providers;
}

export function hasAnyProvider(providers: PushProviders): boolean {
  return Boolean(providers.webpush || providers.fcm || providers.apns);
}

type Preferences = { user_id: string; chat_enabled: boolean; deadlines_enabled: boolean; show_message_preview: boolean; deadline_days: number[] };

export async function loadPreferences(admin: SupabaseClient, companyId: string, userIds: string[]): Promise<Map<string, Preferences>> {
  const map = new Map<string, Preferences>();
  if (userIds.length === 0) return map;
  const { data } = await admin
    .from("notification_preferences")
    .select("user_id, chat_enabled, deadlines_enabled, show_message_preview, deadline_days")
    .eq("company_id", companyId)
    .in("user_id", userIds);
  for (const row of (data as Preferences[] | null) ?? []) map.set(row.user_id, row);
  return map;
}

export const DEFAULT_PREFERENCES = { chat_enabled: true, deadlines_enabled: true, show_message_preview: false, deadline_days: [30, 7, 1, 0] };

type TargetRow = {
  target_kind: string;
  target_id: string;
  user_id: string;
  platform: string;
  locale: string;
  endpoint: string | null;
  p256dh: string | null;
  auth_secret: string | null;
  token: string | null;
};

export function toDeliveryTarget(row: TargetRow): DeliveryTarget | null {
  if (row.target_kind === "webpush" && row.endpoint && row.p256dh && row.auth_secret) {
    return { kind: "webpush", id: row.target_id, userId: row.user_id, locale: row.locale, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth_secret };
  }
  if ((row.target_kind === "fcm" || row.target_kind === "apns") && row.token && (row.platform === "android" || row.platform === "ios")) {
    return { kind: row.target_kind, id: row.target_id, userId: row.user_id, locale: row.locale, platform: row.platform, token: row.token };
  }
  return null;
}

/** DeliveryStore nad Supabase (service role). */
export function supabaseDeliveryStore(admin: SupabaseClient): DeliveryStore {
  return {
    async targets(companyId, userIds) {
      const { data, error } = await admin.rpc("esblu_push_delivery_targets", { p_company_id: companyId, p_user_ids: userIds });
      if (error) return [];
      return ((data as TargetRow[] | null) ?? []).map(toDeliveryTarget).filter((target): target is DeliveryTarget => target !== null);
    },
    async claim({ companyId, userId, kind, dedupeKey }) {
      const { error } = await admin.from("notification_deliveries").insert({ user_id: userId, company_id: companyId, kind, dedupe_key: dedupeKey });
      return !error; // už odoslané (unique) alebo chyba → radšej nič
    },
    async record(target, outcome) {
      await admin.rpc("esblu_push_record_outcome", { p_kind: target.kind, p_target_id: target.id, p_outcome: outcome });
    },
  };
}

/** Pošle notifikáciu používateľom JEDNEJ firmy na všetky ich platné zariadenia. */
export async function deliverToUsers(admin: SupabaseClient, providers: PushProviders, input: DeliveryInput): Promise<DeliveryResult> {
  return deliver(supabaseDeliveryStore(admin), providers, input);
}
