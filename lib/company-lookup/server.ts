import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import type { CompanyLookupGuardDeps } from "./guard.ts";
import { createCompanyLookupHandlers } from "./handlers.ts";
import { createRpoProvider } from "./providers/rpo.ts";
import { createRuzProvider } from "./providers/ruz.ts";
import { createCompanyLookupService } from "./service.ts";

// =============================================================================
// Produkčné zapojenie company lookupu. Žiadny service_role: identita aj
// oprávnenie idú cez anon key + JWT volajúceho (RLS/SECURITY DEFINER
// helpery vyhodnotia auth.uid() v DB).
// =============================================================================

function bearerToken(req: Request): string {
  const authorization = req.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

export function requestGuardDeps(req: Request): CompanyLookupGuardDeps {
  const token = bearerToken(req);
  const db = token ? getUserScopedSupabaseClient(token) : null;
  return {
    getUser: async () => {
      const { user } = await verifyRequestUser(req, getRequestLocale(req));
      return user ? { id: user.id } : null;
    },
    canManageFinance: async () => {
      if (!db) return false;
      const { data, error } = await db.rpc("esblu_my_finance_manage");
      return !error && data === true;
    },
    getActiveCompanyId: async () => {
      if (!db) return null;
      const { data, error } = await db.rpc("esblu_my_active_company_id");
      return !error && typeof data === "string" && data ? data : null;
    },
  };
}

// Jedna inštancia na serverový proces (cache, limity a circuit breaker sú
// zdieľané medzi požiadavkami tej istej inštancie).
const service = createCompanyLookupService({ rpo: createRpoProvider(), ruz: createRuzProvider() });

export const companyLookupHandlers = createCompanyLookupHandlers({ guardDeps: requestGuardDeps, service });
