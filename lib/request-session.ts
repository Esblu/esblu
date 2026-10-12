// =============================================================================
// session_id z Bearer access tokenu (SERVER ONLY) — 20261012150000.
//
// Aktívna firma je per auth session (zariadenie / prihlásenie), nie globálne
// na používateľa. User-scoped klient (RLS / RPC) ju rieši sám z JWT claimu
// session_id. Service-role volania (account preflight / delete) musia DB
// povedať, KTORÁ session sa pýta — preto tento helper.
//
// BEZPEČNOSŤ: volať IBA PO verifyRequestUser(req) nad tým istým tokenom
// (podpis + platnosť overil Supabase Auth). Tu sa payload už iba číta; sub
// sa porovná s overeným user.id, inak null. session_id je iba KONTEXT —
// autorizáciu robí členstvo v DB.
// =============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function bearerToken(req: Request): string {
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

/** session_id overeného tokenu (alebo null — starý token / iný používateľ / zlý formát). */
export function sessionIdFromAccessToken(token: string, verifiedUserId: string): string | null {
  const payload = decodePayload(token);
  if (!payload || payload.sub !== verifiedUserId) return null;
  const sid = payload.session_id;
  return typeof sid === "string" && UUID.test(sid) ? sid.toLowerCase() : null;
}

export function requestSessionId(req: Request, verifiedUserId: string): string | null {
  return sessionIdFromAccessToken(bearerToken(req), verifiedUserId);
}
