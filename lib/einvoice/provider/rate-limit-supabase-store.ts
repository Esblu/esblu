import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ProviderRateDecision, ProviderRateLimiter } from "./rate-limit.ts";

const DECISIONS = new Set<ProviderRateDecision>(["ok", "class_limit", "total_limit", "cooldown", "unconfigured"]);

/**
 * Spoločný limit partnerského kľúča nad DB (20261126100000). Klient sa vytvorí až pri prvom volaní.
 * Chyba (aj chýbajúca migrácia) → výnimka; withProviderRateLimit je fail-open.
 */
export function createSupabaseProviderRateLimiter(adminFactory: () => SupabaseClient = getSupabaseAdmin): ProviderRateLimiter {
  let admin: SupabaseClient | null = null;
  const client = () => (admin ??= adminFactory());
  return {
    async acquire(provider, environment, cls, cost) {
      const { data, error } = await client().rpc("esblu_einvoice_rate_acquire_class", { p_provider: provider, p_environment: environment, p_class: cls, p_cost: cost });
      if (error) throw new Error("EINVOICE_RATE_LIMITER_UNAVAILABLE");
      return typeof data === "string" && DECISIONS.has(data as ProviderRateDecision) ? (data as ProviderRateDecision) : "unconfigured";
    },
    async cooldown(provider, environment, seconds) {
      const { error } = await client().rpc("esblu_einvoice_rate_cooldown", { p_provider: provider, p_environment: environment, p_seconds: seconds });
      if (error) throw new Error("EINVOICE_RATE_LIMITER_UNAVAILABLE");
    },
  };
}
