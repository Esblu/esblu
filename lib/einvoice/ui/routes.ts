import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { loadInboundDetail, loadInboundList, loadInvoiceEinvoiceSummary, type SummaryResult } from "./summary-server.ts";

// =============================================================================
// E-Faktúra UI — obsluha read-only summary routes. SERVER-ONLY.
// Identita z overeného Bearer JWT, dáta výhradne cez user-scoped klienta (RLS).
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteContext = { params: Promise<{ id: string }> };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function authenticate(req: Request): Promise<{ userId: string; token: string } | null> {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token) return null;
  const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
  if (error || !user) return null;
  return { userId: user.id, token };
}

function respond<T>(result: SummaryResult<T>): Response {
  return result.ok ? json(200, result.data) : json(result.status, { code: result.code });
}

async function idFrom(context: RouteContext): Promise<string | null> {
  try {
    const { id } = await context.params;
    return UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function handleInvoiceEinvoiceSummary(req: Request, context: RouteContext): Promise<Response> {
  const id = await idFrom(context);
  if (!id) return json(404, { code: "NOT_FOUND" });
  const auth = await authenticate(req);
  if (!auth) return json(401, { code: "UNAUTHENTICATED" });
  return respond(await loadInvoiceEinvoiceSummary(getUserScopedSupabaseClient(auth.token), id, auth.userId));
}

export async function handleInboundList(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth) return json(401, { code: "UNAUTHENTICATED" });
  return respond(await loadInboundList(getUserScopedSupabaseClient(auth.token)));
}

export async function handleInboundDetail(req: Request, context: RouteContext): Promise<Response> {
  const id = await idFrom(context);
  if (!id) return json(404, { code: "NOT_FOUND" });
  const auth = await authenticate(req);
  if (!auth) return json(401, { code: "UNAUTHENTICATED" });
  return respond(await loadInboundDetail(getUserScopedSupabaseClient(auth.token), id, auth.userId));
}
