import { sendWebPush, type VapidKeys } from "@/lib/push/web-push-crypto";
import { pushTargetData } from "@/lib/push/deep-link";
import type { PushMessage } from "@/lib/push/routing";
import type { DeliveryTarget, PushProvider, SendOutcome } from "@/lib/push/providers/types";

// Web Push (prehliadač / PWA). JSON obsahuje iba titulok, text, tag a cieľ
// z allowlistu — public/sw.js si z cieľa zloží cestu sám (žiadna URL).
export function readVapidKeys(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:info@esblu.com";
  if (!publicKey || !privateKey || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export function webPushBody(message: PushMessage): Record<string, unknown> {
  return { title: message.title, body: message.body, tag: message.tag, ...pushTargetData(message.target) };
}

export function createWebPushProvider(vapid: VapidKeys, fetchImpl: typeof fetch = fetch): PushProvider {
  return {
    kind: "webpush",
    async send(target: DeliveryTarget, message: PushMessage): Promise<SendOutcome> {
      if (target.kind !== "webpush") return "error";
      const outcome = await sendWebPush({ endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth }, webPushBody(message), vapid, fetchImpl);
      return outcome === "sent" ? "sent" : outcome === "gone" ? "invalid" : "retry";
    },
  };
}
