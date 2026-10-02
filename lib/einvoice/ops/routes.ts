import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getEinvoiceProvider } from "../provider/index.ts";
import { createSupabaseOutboundStore } from "../outbound/supabase-store.ts";
import { createSupabaseInboundStore } from "../inbound/supabase-store.ts";
import { runOperatorAction } from "./actions.ts";
import { downloadStoredDocument, type StoredDocumentKind } from "./download.ts";
import { isUuid, parseOperatorBody } from "./request-body.ts";
import { createSupabaseOpsStore } from "./supabase-store.ts";
import type { OperatorAction, OperatorKind } from "./store.ts";

// =============================================================================
// Spoločná obsluha operátorských a download routes E-Faktúry. SERVER-ONLY.
// Identita z overeného Bearer JWT; všetko ostatné rozhoduje DB (RPC / RLS).
// =============================================================================

type RouteContext = { params: Promise<{ id: string }> };

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function bearerToken(req: Request): string {
  const authorization = req.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

async function authenticate(req: Request): Promise<{ userId: string; token: string } | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
  if (error || !user) return null;
  return { userId: user.id, token };
}

export async function handleOperatorPost(req: Request, context: RouteContext, kind: OperatorKind, action: OperatorAction): Promise<Response> {
  let id: string;
  try {
    ({ id } = await context.params);
  } catch {
    return json(404, { code: "NOT_FOUND" });
  }
  if (!isUuid(id)) return json(404, { code: "NOT_FOUND" });

  const auth = await authenticate(req);
  if (!auth) return json(401, { code: "UNAUTHENTICATED" });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { code: "INVALID_BODY" });
  }
  const body = parseOperatorBody(raw);
  if (!body.ok) return json(400, { code: body.code });

  let runtime = null;
  try {
    runtime = getEinvoiceProvider();
  } catch {
    runtime = null;
  }

  const result = await runOperatorAction(
    {
      ops: createSupabaseOpsStore(),
      outbound: createSupabaseOutboundStore(),
      inbound: createSupabaseInboundStore(),
      runtime,
      userDb: getUserScopedSupabaseClient(auth.token),
    },
    { userId: auth.userId, kind, id: id.toLowerCase(), action, reasonCode: body.reasonCode }
  );
  return json(result.status, result.body as unknown as Record<string, unknown>);
}

export async function handleStoredDocumentGet(req: Request, context: RouteContext, kind: StoredDocumentKind): Promise<Response> {
  let id: string;
  try {
    ({ id } = await context.params);
  } catch {
    return json(404, { code: "NOT_FOUND" });
  }
  if (!isUuid(id)) return json(404, { code: "NOT_FOUND" });
  const auth = await authenticate(req);
  if (!auth) return json(401, { code: "UNAUTHENTICATED" });

  const storage = createSupabaseOutboundStore();
  const result = await downloadStoredDocument({ userDb: getUserScopedSupabaseClient(auth.token), getObject: (p) => storage.getUbl(p) }, kind, id.toLowerCase());
  if (!result.ok) return json(result.status, { code: result.code });
  return new Response(result.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Content-Length": String(result.bytes.byteLength),
      "X-Esblu-Sha256": result.sha256,
      "Cache-Control": "private, no-store",
    },
  });
}
