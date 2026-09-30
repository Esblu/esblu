import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";

// Overenie volajúceho pre push routes: platný Bearer token (Supabase
// auth.getUser — odmietne aj token zrušenej session) a user-scoped klient,
// cez ktorý RPC čítajú auth.uid() + session_id priamo z JWT. Používateľ,
// firma ani session sa NIKDY neberú z tela požiadavky.
export async function authorizePushCaller(req: Request): Promise<{ userId: string; db: SupabaseClient } | { response: Response }> {
  const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
  if (error || !user) return { response: Response.json({ success: false }, { status: 401 }) };
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return { userId: user.id, db: getUserScopedSupabaseClient(token) };
}

/** Chyba RPC → HTTP odpoveď bez prezradenia detailov. */
export function rpcErrorResponse(error: { message?: string; code?: string } | null): Response {
  const message = error?.message ?? "";
  if (message.includes("ESBLU_NO_ACTIVE_COMPANY")) return Response.json({ success: false }, { status: 403 });
  if (message.includes("ESBLU_PUSH_SESSION_REQUIRED") || message.includes("NOT_AUTHENTICATED")) return Response.json({ success: false }, { status: 401 });
  if (message.includes("ESBLU_PUSH_INVALID_DEVICE")) return Response.json({ success: false }, { status: 400 });
  return Response.json({ success: false }, { status: 500 });
}
