import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getEinvoiceProvider } from "../provider/index.ts";
import { createSupabaseMandateStore } from "../mandate-supabase-store.ts";
import { mandateStatement, requestEvidence } from "../mandate.ts";
import { loadAccessResult } from "./summary-server.ts";
import { changeMandate, loadMandate } from "./mandate-server.ts";

// =============================================================================
// E-Faktúra UI — route handlery mandátu (poverenia). SERVER-ONLY.
// =============================================================================

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function authUser(req: Request): Promise<{ token: string; userId: string } | null> {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token) return null;
  const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
  return error || !user ? null : { token, userId: user.id };
}

function runtime() {
  try {
    return getEinvoiceProvider();
  } catch {
    return null;
  }
}

export async function handleMandateGet(req: Request): Promise<Response> {
  const auth = await authUser(req);
  if (!auth) return json(401, { code: "UNAUTHENTICATED" });
  const r = await loadMandate({ db: getUserScopedSupabaseClient(auth.token), access: (db) => loadAccessResult(db, process.env), runtime: runtime() });
  return json(r.status, r.body);
}

export async function handleMandatePost(req: Request): Promise<Response> {
  const auth = await authUser(req);
  if (!auth) return json(401, { code: "UNAUTHENTICATED" });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { code: "INVALID_BODY" });
  }
  const r = await changeMandate(
    {
      db: getUserScopedSupabaseClient(auth.token),
      access: (db) => loadAccessResult(db, process.env),
      userId: auth.userId,
      runtime: runtime(),
      store: () => createSupabaseMandateStore(),
      statement: mandateStatement(getRequestLocale(req)),
      evidence: (companyId) => requestEvidence(req.headers, companyId),
    },
    raw
  );
  return json(r.status, r.body);
}
