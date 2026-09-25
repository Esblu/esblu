import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWebPush, type VapidKeys } from "@/lib/push/web-push-crypto";
import { isSafeNotificationUrl, type PushPayload } from "@/lib/push/routing";

// =============================================================================
// Doručenie push notifikácií — iba server (service role), iba jedna firma.
//
// Každé odoslanie je viazané na KONKRÉTNU firmu: zariadenia sa čítajú s
// filtrom company_id + user_id, takže notifikácia firmy A nikdy neodíde na
// zariadenie registrované pod firmou B (ani toho istého človeka).
// Deduplikácia: notification_deliveries (unique user_id + dedupe_key) —
// ten istý termín ani tá istá správa neodíde dvakrát.
// Zariadenie, ktoré push služba označí za zaniknuté (404/410), sa zruší.
//
// RETENCIA: notification_deliveries rastie s každým odoslaním (iba kľúče,
// žiadny obsah). Pred dlhodobou produkčnou prevádzkou treba schváliť a zaviesť
// čistenie starých riadkov — tu zámerne nie je žiadne automatické mazanie.
// =============================================================================

export function readVapidKeys(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:info@esblu.com";
  if (!publicKey || !privateKey || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
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

/**
 * Pošle notifikáciu používateľom JEDNEJ firmy. Vráti počet odoslaných.
 * `dedupeKey` zabráni opakovaniu (null = bez deduplikácie).
 */
export async function deliverToUsers(
  admin: SupabaseClient,
  vapid: VapidKeys,
  input: { companyId: string; userIds: string[]; kind: "chat" | "deadline"; dedupeKey: string | null; payloadFor: (userId: string) => PushPayload }
): Promise<number> {
  let sent = 0;
  for (const userId of Array.from(new Set(input.userIds))) {
    const payload = input.payloadFor(userId);
    if (!isSafeNotificationUrl(payload.url)) continue;

    if (input.dedupeKey) {
      const { error } = await admin
        .from("notification_deliveries")
        .insert({ user_id: userId, company_id: input.companyId, kind: input.kind, dedupe_key: input.dedupeKey });
      if (error) continue; // už odoslané (unique) alebo chyba → radšej nič
    }

    const { data: subscriptions } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_secret")
      .eq("company_id", input.companyId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .limit(10);

    for (const row of (subscriptions as { id: string; endpoint: string; p256dh: string; auth_secret: string }[] | null) ?? []) {
      const outcome = await sendWebPush({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth_secret }, payload, vapid);
      if (outcome === "sent") {
        sent++;
        await admin.from("push_subscriptions").update({ last_success_at: new Date().toISOString() }).eq("id", row.id);
      } else if (outcome === "gone") {
        await admin.from("push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("id", row.id);
      }
    }
  }
  return sent;
}
