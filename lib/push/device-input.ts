import { normalizeLocale } from "@/lib/i18n/locales";

// Validácia tela /api/push/devices (čistá funkcia, testovaná v Node). Tvar
// zodpovedá CHECK obmedzeniam push_devices; DB ho overí ešte raz.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9:_.-]{32,4096}$/;

export type NativeDeviceBody = { provider?: unknown; platform?: unknown; token?: unknown; installationId?: unknown; locale?: unknown; appVersion?: unknown };

export type NativeDeviceInput = { provider: "fcm" | "apns"; platform: "android" | "ios"; token: string; installationId: string; locale: string; appVersion: string | null };

export function readNativeDevice(body: NativeDeviceBody | null): NativeDeviceInput | null {
  const provider = body?.provider;
  const platform = body?.platform;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const installationId = typeof body?.installationId === "string" ? body.installationId : "";
  if (provider !== "fcm" && provider !== "apns") return null;
  if (platform !== "android" && platform !== "ios") return null;
  if (provider === "apns" && platform !== "ios") return null;
  if (!TOKEN.test(token)) return null;
  if (!UUID.test(installationId)) return null;
  const appVersion = typeof body?.appVersion === "string" && /^[A-Za-z0-9._+-]{1,40}$/.test(body.appVersion) ? body.appVersion : null;
  return { provider, platform, token, installationId: installationId.toLowerCase(), locale: normalizeLocale(body?.locale), appVersion };
}

export function readUnregisterInput(body: NativeDeviceBody | null): { installationId: string | null; token: string | null } | null {
  const installationId = typeof body?.installationId === "string" && UUID.test(body.installationId) ? body.installationId.toLowerCase() : null;
  const token = typeof body?.token === "string" && TOKEN.test(body.token) ? body.token : null;
  if (!installationId && !token) return null;
  return { installationId, token };
}
