import { authorizePushCaller, rpcErrorResponse } from "@/lib/push/request";

// -----------------------------------------------------------------------------
// GET /api/push/preferences   — vlastné predvoľby upozornení (aktívna firma).
// PUT /api/push/preferences   — { chatEnabled, deadlinesEnabled,
//                                 showMessagePreview, deadlineDays[] }.
// Zápis iba cez RPC ako prihlásený používateľ (vlastný riadok aktívnej
// firmy); DB CHECK odmietne prázdne alebo mimo 0–365 okná.
// -----------------------------------------------------------------------------

export async function GET(req: Request) {
  const who = await authorizePushCaller(req);
  if ("response" in who) return who.response;
  const { data, error } = await who.db.rpc("esblu_push_get_my_preferences");
  if (error) return rpcErrorResponse(error);
  if (!data) return Response.json({ success: false }, { status: 403 });
  return Response.json({ success: true, preferences: data });
}

export async function PUT(req: Request) {
  const who = await authorizePushCaller(req);
  if ("response" in who) return who.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
  const days = Array.isArray(body?.deadlineDays) ? body.deadlineDays : null;
  if (!body || days === null || days.length === 0 || days.length > 6 || !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 365)) {
    return Response.json({ success: false }, { status: 400 });
  }
  const { error } = await who.db.rpc("esblu_push_set_my_preferences", {
    p_chat_enabled: flag(body.chatEnabled),
    p_deadlines_enabled: flag(body.deadlinesEnabled),
    p_show_message_preview: flag(body.showMessagePreview),
    p_deadline_days: days,
  });
  if (error) return rpcErrorResponse(error);
  return Response.json({ success: true });
}
