// =============================================================================
// Usage enforcement (pricing + entitlements, 2026-10-26) — serverové brány.
// Fail closed: chyba / nečitateľný stav = odmietnutie (nikdy tichý prechod).
// Firma = AKTÍVNA firma session (DB, nikdy z tela požiadavky).
// =============================================================================
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { parseEntitlementDenial, type EntitlementDenial } from "@/lib/entitlements";

export type VoiceCapacity =
  | { ok: true; companyId: string; usedSeconds: number; limitMinutes: number | null }
  | { ok: false; denial: EntitlementDenial | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(req: Request): string {
  const authorization = req.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

/** Brána pred prepisom reči: aktívny hlas + nevyčerpané minúty aktívnej firmy. */
export async function requireVoiceCapacity(req: Request): Promise<VoiceCapacity> {
  const token = bearer(req);
  if (!token) return { ok: false, denial: null };
  try {
    const { data, error } = await getUserScopedSupabaseClient(token).rpc("esblu_require_my_voice_capacity");
    if (error) return { ok: false, denial: parseEntitlementDenial(error) };
    const value = data as { company_id?: unknown; used_seconds?: unknown; limit_minutes?: unknown } | null;
    if (!value || typeof value.company_id !== "string" || !UUID.test(value.company_id)) return { ok: false, denial: null };
    return {
      ok: true,
      companyId: value.company_id,
      usedSeconds: typeof value.used_seconds === "number" ? value.used_seconds : Number(value.used_seconds ?? 0) || 0,
      limitMinutes: typeof value.limit_minutes === "number" ? value.limit_minutes : null,
    };
  } catch {
    return { ok: false, denial: null };
  }
}

/** Po úspešnom prepise: započítanie sekúnd (service role). Best-effort, nikdy nehádže. */
export async function recordVoiceUsage(companyId: string, userId: string, seconds: number): Promise<boolean> {
  if (!UUID.test(companyId) || !UUID.test(userId) || !(seconds > 0)) return false;
  try {
    const { data, error } = await getSupabaseAdmin().rpc("esblu_record_voice_usage", {
      p_company_id: companyId,
      p_user_id: userId,
      p_seconds: seconds,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}
