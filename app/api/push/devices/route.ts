import { readNativeDevice, readUnregisterInput, type NativeDeviceBody } from "@/lib/push/device-input";
import { authorizePushCaller, rpcErrorResponse } from "@/lib/push/request";

// -----------------------------------------------------------------------------
// POST   /api/push/devices  — registrácia / obnova natívneho push tokenu
//                             (Android FCM, iOS APNs) pre TÚTO inštaláciu appky.
// DELETE /api/push/devices  — odhlásenie tejto inštalácie (vypnutie, odhlásenie).
//
// Telo: { provider: "fcm"|"apns", platform: "android"|"ios", token,
//         installationId (UUID inštalácie), locale, appVersion? }.
// Používateľ, firma a session sa berú v DB z JWT (esblu_push_register_device),
// nikdy z tela. Idempotentné: opakovaná registrácia = "refreshed"; nový token
// tej istej inštalácie nahradí starý. 409 = token patrí inému aktívnemu
// používateľovi z inej inštalácie (appka si vyžiada nový token).
// Registrácia funguje aj bez FCM/APNs kľúčov na serveri (odosielanie sa
// zapne, keď budú nakonfigurované).
// -----------------------------------------------------------------------------

export async function POST(req: Request) {
  const who = await authorizePushCaller(req);
  if ("response" in who) return who.response;
  const device = readNativeDevice((await req.json().catch(() => null)) as NativeDeviceBody | null);
  if (!device) return Response.json({ success: false }, { status: 400 });
  const { data, error } = await who.db.rpc("esblu_push_register_device", {
    p_provider: device.provider,
    p_platform: device.platform,
    p_token: device.token,
    p_installation_id: device.installationId,
    p_locale: device.locale,
    p_app_version: device.appVersion,
  });
  if (error) return rpcErrorResponse(error);
  if (data === "conflict") return Response.json({ success: false }, { status: 409 });
  return Response.json({ success: true, status: data === "registered" ? "registered" : "refreshed" });
}

export async function DELETE(req: Request) {
  const who = await authorizePushCaller(req);
  if ("response" in who) return who.response;
  const input = readUnregisterInput((await req.json().catch(() => null)) as NativeDeviceBody | null);
  if (!input) return Response.json({ success: false }, { status: 400 });
  const { error } = await who.db.rpc("esblu_push_unregister_device", { p_installation_id: input.installationId, p_token: input.token });
  if (error) return rpcErrorResponse(error);
  return Response.json({ success: true });
}
