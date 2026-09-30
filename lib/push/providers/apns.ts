import { signJwt, normalizePem } from "@/lib/push/providers/jwt";
import { pushTargetData } from "@/lib/push/deep-link";
import type { PushMessage } from "@/lib/push/routing";
import type { DeliveryTarget, PushProvider, SendOutcome } from "@/lib/push/providers/types";

// =============================================================================
// Apple Push Notification service — token-based auth (.p8), HTTP/2.
//
// Konfigurácia (IBA server, Vercel env):
//   APNS_KEY_ID        Key ID kľúča (Apple Developer → Keys, APNs)
//   APNS_TEAM_ID       Team ID
//   APNS_PRIVATE_KEY   obsah .p8 (PEM, "\n" povolené)
//   APNS_BUNDLE_ID     apns-topic (predvolene com.esblu.app)
//   APNS_ENVIRONMENT   production (predvolené) | development (Xcode debug build)
// Mapovanie: 410 Unregistered, 400 BadDeviceToken / DeviceTokenNotForTopic → invalid;
//   429 / 5xx → retry; 403 (kľúč/tím) a ostatné → error.
// =============================================================================

export type ApnsConfig = { keyId: string; teamId: string; privateKey: string; bundleId: string; host: string };

export function readApnsConfig(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const privateKey = normalizePem(env.APNS_PRIVATE_KEY);
  const bundleId = env.APNS_BUNDLE_ID?.trim() || "com.esblu.app";
  const environment = env.APNS_ENVIRONMENT?.trim() || "production";
  if (!keyId || !/^[A-Z0-9]{10}$/.test(keyId) || !teamId || !/^[A-Z0-9]{10}$/.test(teamId) || !privateKey) return null;
  if (!/^[A-Za-z0-9.-]{3,155}$/.test(bundleId) || !["production", "development"].includes(environment)) return null;
  return { keyId, teamId, privateKey, bundleId, host: environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com" };
}

export type ApnsRequest = { host: string; path: string; headers: Record<string, string>; body: string };
export type ApnsResponse = { status: number; body: string };
export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>;

/** Predvolený transport: node:http2 (APNs vyžaduje HTTP/2). */
export const http2Transport: ApnsTransport = async (request) => {
  const http2 = await import("node:http2");
  return new Promise<ApnsResponse>((resolve, reject) => {
    const client = http2.connect(`https://${request.host}`);
    client.on("error", reject);
    const stream = client.request({ ":method": "POST", ":path": request.path, ...request.headers });
    let status = 0;
    let data = "";
    stream.setEncoding("utf8");
    stream.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => {
      client.close();
      resolve({ status, body: data });
    });
    stream.on("error", (error) => {
      client.close();
      reject(error);
    });
    stream.setTimeout(10_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
    stream.end(request.body);
  });
};

export function apnsPayload(message: PushMessage): Record<string, unknown> {
  return {
    aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": message.tag },
    ...pushTargetData(message.target),
  };
}

export function classifyApnsError(status: number, body: string): SendOutcome {
  let reason = "";
  try {
    reason = (JSON.parse(body) as { reason?: string }).reason ?? "";
  } catch {
    reason = "";
  }
  if (status === 410 || reason === "Unregistered" || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") return "invalid";
  if (status === 429 || status >= 500) return "retry";
  return "error";
}

export function createApnsProvider(config: ApnsConfig, transport: ApnsTransport = http2Transport, now: () => number = Date.now): PushProvider {
  let cache: { jwt: string; issuedAt: number } | null = null;
  function providerToken(): string {
    // Apple: token obnoviť najskôr po 20 min, najneskôr po 60 min.
    if (cache && now() - cache.issuedAt < 40 * 60 * 1000) return cache.jwt;
    const iat = Math.floor(now() / 1000);
    cache = { jwt: signJwt("ES256", { kid: config.keyId }, { iss: config.teamId, iat }, config.privateKey), issuedAt: now() };
    return cache.jwt;
  }
  return {
    kind: "apns",
    async send(target: DeliveryTarget, message: PushMessage): Promise<SendOutcome> {
      if (target.kind !== "apns" || !/^[0-9a-fA-F]{64,200}$/.test(target.token)) return target.kind === "apns" ? "invalid" : "error";
      try {
        const response = await transport({
          host: config.host,
          path: `/3/device/${target.token}`,
          headers: {
            authorization: `bearer ${providerToken()}`,
            "apns-topic": config.bundleId,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-collapse-id": message.tag.slice(0, 64),
          },
          body: JSON.stringify(apnsPayload(message)),
        });
        if (response.status === 200) return "sent";
        if (response.status === 403) cache = null;
        return classifyApnsError(response.status, response.body);
      } catch {
        return "retry";
      }
    },
  };
}
