import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getEinvoiceProvider } from "../provider/index.ts";
import { EfakturaSkProvider } from "../provider/efaktura-sk.ts";
import { createSupabaseOnboardingStore } from "../onboarding-supabase-store.ts";
import { loadAccess } from "./summary-server.ts";
import { enrollReception, loadReception } from "./reception-server.ts";

// =============================================================================
// E-Faktúra UI — route handlery stavu príjmu a aktivácie (FS kód). SERVER-ONLY.
// Identita z Bearer JWT, oprávnenia cez user-scoped klienta (RLS / RPC),
// privilegovaná vrstva (service_role) sa vytvorí až po overení oprávnení.
// =============================================================================

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function authToken(req: Request): Promise<string | null> {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token) return null;
  const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
  return error || !user ? null : token;
}

function serverEnvironment(): "sandbox" | "live" | null {
  try {
    return getEinvoiceProvider()?.environment ?? null;
  } catch {
    return null;
  }
}

export async function handleReceptionGet(req: Request): Promise<Response> {
  const token = await authToken(req);
  if (!token) return json(401, { code: "UNAUTHENTICATED" });
  const r = await loadReception({ db: getUserScopedSupabaseClient(token), access: (db) => loadAccess(db, process.env), environment: serverEnvironment() });
  return json(r.status, r.body);
}

export async function handleReceptionEnroll(req: Request): Promise<Response> {
  const token = await authToken(req);
  if (!token) return json(401, { code: "UNAUTHENTICATED" });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { code: "INVALID_BODY" });
  }
  const r = await enrollReception(
    {
      db: getUserScopedSupabaseClient(token),
      access: (db) => loadAccess(db, process.env),
      environment: serverEnvironment(),
      onboarding: () => {
        let rt = null;
        try {
          rt = getEinvoiceProvider();
        } catch {
          rt = null;
        }
        if (!rt || !(rt.provider instanceof EfakturaSkProvider)) return null;
        return { store: createSupabaseOnboardingStore(), provider: rt.provider, environment: rt.environment };
      },
    },
    raw
  );
  return json(r.status, r.body);
}
