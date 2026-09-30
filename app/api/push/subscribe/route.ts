import { normalizeLocale } from "@/lib/i18n/locales";
import { readVapidKeys } from "@/lib/push/server";
import { authorizePushCaller, rpcErrorResponse } from "@/lib/push/request";

// -----------------------------------------------------------------------------
// POST   /api/push/subscribe  — zaregistruje TOTO zariadenie (prehliadač/PWA).
// DELETE /api/push/subscribe  — odhlási toto zariadenie (odhlásenie, vypnutie).
//
// Zápis robí RPC esblu_push_register_web / esblu_push_unregister_web AKO
// prihlásený používateľ (user-scoped klient): používateľ = auth.uid(), firma
// = aktívne členstvo, session = session_id z JWT (bez nej sa neregistruje).
// Z tela sa berie iba endpoint, kľúče prehliadača a jazyk zariadenia.
// AKTÍVNY endpoint iného používateľa sa neprevezme (409 bez prezradenia
// vlastníka); zrušený (po odhlásení) alebo vlastný áno.
// -----------------------------------------------------------------------------

type Body = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; locale?: unknown };

function readSubscription(body: Body | null): { endpoint: string; p256dh: string; auth: string } | null {
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 2048) return null;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,100}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

export async function POST(req: Request) {
  const who = await authorizePushCaller(req);
  if ("response" in who) return who.response;
  if (!readVapidKeys()) return Response.json({ success: false, error: "PUSH_NOT_CONFIGURED" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Body | null;
  const subscription = readSubscription(body);
  if (!subscription) return Response.json({ success: false }, { status: 400 });

  const { data, error } = await who.db.rpc("esblu_push_register_web", {
    p_endpoint: subscription.endpoint,
    p_p256dh: subscription.p256dh,
    p_auth: subscription.auth,
    p_locale: normalizeLocale(body?.locale),
    p_user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
  });
  if (error) return rpcErrorResponse(error);
  if (data === "conflict") return Response.json({ success: false }, { status: 409 });
  return Response.json({ success: true });
}

export async function DELETE(req: Request) {
  const who = await authorizePushCaller(req);
  if ("response" in who) return who.response;
  const body = (await req.json().catch(() => null)) as Body | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint || endpoint.length > 2048) return Response.json({ success: false }, { status: 400 });
  // Iba vlastné zariadenie volajúceho (RPC filtruje auth.uid()).
  const { error } = await who.db.rpc("esblu_push_unregister_web", { p_endpoint: endpoint });
  if (error) return rpcErrorResponse(error);
  return Response.json({ success: true });
}
