import { signJwt, normalizePem } from "@/lib/push/providers/jwt";
import { pushTargetData } from "@/lib/push/deep-link";
import type { PushMessage } from "@/lib/push/routing";
import type { DeliveryTarget, PushProvider, SendOutcome } from "@/lib/push/providers/types";

// =============================================================================
// Firebase Cloud Messaging — HTTP v1 API (Android; voliteľne iOS cez FCM).
//
// Konfigurácia (IBA server, Vercel env — nikdy NEXT_PUBLIC_):
//   FCM_PROJECT_ID     ID Firebase projektu
//   FCM_CLIENT_EMAIL   e-mail service accountu (firebase-adminsdk-…)
//   FCM_PRIVATE_KEY    privátny kľúč service accountu (PEM, "\n" povolené)
// OAuth prístupový token (scope firebase.messaging) sa získa podpísaným JWT
// a drží sa v pamäti inštancie do vypršania.
// Mapovanie chýb: https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode
//   404 / UNREGISTERED, SENDER_ID_MISMATCH, neplatný registration token → invalid
//   429 / 5xx / sieť → retry;  401/403 (kľúč, oprávnenie) → error
// =============================================================================

export type FcmConfig = { projectId: string; clientEmail: string; privateKey: string };

export function readFcmConfig(env: Record<string, string | undefined> = process.env): FcmConfig | null {
  const projectId = env.FCM_PROJECT_ID?.trim();
  const clientEmail = env.FCM_CLIENT_EMAIL?.trim();
  const privateKey = normalizePem(env.FCM_PRIVATE_KEY);
  if (!projectId || !/^[a-z0-9-]{4,64}$/.test(projectId) || !clientEmail || !/^[^@\s]+@[^@\s]+$/.test(clientEmail) || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

/** Kanál Android notifikácií (vytvára ho appka, lib/push/native.ts). */
export const ANDROID_CHANNEL_ID = "esblu_default";

export function fcmMessageBody(token: string, message: PushMessage): Record<string, unknown> {
  const data: Record<string, string> = { ...pushTargetData(message.target), tag: message.tag };
  return {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      data,
      android: {
        priority: "HIGH",
        collapse_key: message.tag.slice(0, 64),
        notification: { tag: message.tag, channel_id: ANDROID_CHANNEL_ID },
      },
      apns: { headers: { "apns-collapse-id": message.tag.slice(0, 64) }, payload: { aps: { sound: "default", "thread-id": message.tag } } },
    },
  };
}

export function classifyFcmError(status: number, body: unknown): SendOutcome {
  const error = (body as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } } | null)?.error;
  const codes = [error?.status, ...(error?.details ?? []).map((detail) => detail?.errorCode)].filter(Boolean) as string[];
  if (status === 404 || codes.includes("UNREGISTERED") || codes.includes("SENDER_ID_MISMATCH")) return "invalid";
  if (status === 400 && /registration token/i.test(error?.message ?? "")) return "invalid";
  if (status === 429 || status >= 500 || codes.includes("UNAVAILABLE") || codes.includes("INTERNAL") || codes.includes("QUOTA_EXCEEDED")) return "retry";
  return "error";
}

type TokenCache = { token: string; expiresAt: number } | null;

export function createFcmProvider(config: FcmConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): PushProvider {
  let cache: TokenCache = null;

  async function accessToken(): Promise<string | null> {
    if (cache && cache.expiresAt - 60_000 > now()) return cache.token;
    const iat = Math.floor(now() / 1000);
    const assertion = signJwt(
      "RS256",
      {},
      { iss: config.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 },
      config.privateKey
    );
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!response.ok) return null;
    const json = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!json?.access_token) return null;
    cache = { token: json.access_token, expiresAt: now() + Math.max(60, json.expires_in ?? 3600) * 1000 };
    return cache.token;
  }

  return {
    kind: "fcm",
    async send(target: DeliveryTarget, message: PushMessage): Promise<SendOutcome> {
      if (target.kind !== "fcm") return "error";
      try {
        const bearer = await accessToken();
        if (!bearer) return "error";
        const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify(fcmMessageBody(target.token, message)),
        });
        if (response.ok) return "sent";
        if (response.status === 401) cache = null;
        return classifyFcmError(response.status, await response.json().catch(() => null));
      } catch {
        return "retry";
      }
    },
  };
}
